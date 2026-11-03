import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 中英双版 README 的对账锁（H6）。
 *
 * 双语 README 最常见的坏法不是翻译腔，而是**两边数字不一样**：
 * 改中文忘了改英文，英文读者看到的是一个已经不存在的结果。
 * 所以这里不查语法、不查措辞，只查三件事：
 *
 *   1. 两版互链（否则英文读者回不到中文版，反之亦然）；
 *   2. 关键数字在中英两版里**都出现且字面一致**（数字是语言无关的，可以做等式）；
 *   3. 两版里的相对链接都能真的打开（截图改名、文档挪位会立刻红）。
 *
 * 注意：这里锁的是「同一个数」而不是「同样的句子」。措辞可以不同，
 * 数字必须相同——这正是双语文档唯一不能漂的东西。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = readFileSync(resolve(root, 'README.md'), 'utf8');
const en = readFileSync(resolve(root, 'README.en.md'), 'utf8');

/**
 * 两版都必须出现的实测数字。
 *
 * 选的标准：能被 `npm run eval` / `npm run eval:check` / `npm test` 复算，
 * 且是「对外承诺」型的数字（准确率、误报率、样本量、体积）。
 * 不选那些只在某一版有意义的（比如只用于解释某个 bug 的中间量）。
 */
const FIGURES = [
  '120', // 实验数
  '6,720', // 日级明细行数
  '93.3%', // 决策准确率
  '5.0%', // null 误报率
  '6.35%', // A/A 自校准
  '9.70%', // 朴素标准误的误报率
  '7.24%', // CUPED 方差缩减
  '0.857', // 分层检测 F1
  '2200', // Agent 问答条数
  '13546', // 可溯源数字个数
  '1840', // 引用覆盖率分母
  // 单测条数故意不放进这张静态清单：它已经由下面那条断言**动态**对上实际用例数，
  // 放两份维护只会让「加一个测试要改两个地方」，而两处都可能忘记。
  '87', // 回归基线指标数
  '780KB', // 产物 JS
  '254KB', // 产物 gzip
  '99.79%', // 全零族至少一个显著
  '14.2%', // 巡检：这批数据能检出的最小相对效应中位数
  '22', // 巡检：要检出 3% 的相对效应，样本量需要放大的倍数（与 14.2% 同源）
  '33.67%', // 截尾口径的 95% 覆盖率（证明它不能当检验）
  '94.67%', // 同一档原始口径的覆盖率
  '20.182', // 门禁 + 净价值
  '15.696', // 频率派规则的事后净价值
  '1.19%', // 退款率基线
  '2.03%', // 恶化后的退款率
  '16.37%', // 逐日窥探的 naive 误报率
  '7140', // 对比视图的两两组合数
  '341', // 森林图画错的网格线条数
];

/** 抽出 markdown 里的相对链接目标（跳过外链与纯锚点） */
function relativeLinks(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) {
    const href = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const path = href.split('#')[0];
    if (path) out.push(path);
  }
  return out;
}

describe('中英双版 README', () => {
  it('两版互链（双语文档的基本礼貌）', () => {
    expect(zh.includes('](README.en.md)')).toBe(true);
    expect(en.includes('](README.md)')).toBe(true);
  });

  it('关键数字在两版里字面一致', () => {
    const missZh = FIGURES.filter((f) => !zh.includes(f));
    const missEn = FIGURES.filter((f) => !en.includes(f));
    // 报出缺了哪几个，而不是只说「不相等」——否则改的人得自己 diff 一遍
    expect({ missZh, missEn }).toEqual({ missZh: [], missEn: [] });
  });

  it('两版的相对链接都能打开（截图改名 / 文档挪位要立刻红）', () => {
    for (const [name, md] of [
      ['README.md', zh],
      ['README.en.md', en],
    ] as const) {
      const broken = relativeLinks(md).filter((p) => !existsSync(resolve(root, p)));
      expect({ name, broken }).toEqual({ name, broken: [] });
    }
  });

  it('两版都指向同一批截图（英文版不能自己造一套文件名）', () => {
    const shots = (md: string) => new Set([...md.matchAll(/docs\/screenshots\/([^)`\s]+\.png)/g)].map((m) => m[1]));
    const z = shots(zh);
    const e = shots(en);
    // 英文版引用的每一张图，中文版都必须也引用（允许中文版更多：它记录了更多细节）
    const onlyEn = [...e].filter((s) => !z.has(s));
    expect(onlyEn).toEqual([]);
    expect(e.size).toBeGreaterThanOrEqual(15);
  });
});
  it('README 里的单测条数 = 实际用例数（改完测试不改文档会红）', () => {
    // 这是唯一一个能自动核对的「承诺型数字」：测试文件就在仓库里，数得出来。
    // 注意：这个文件的标题与注释里都不能出现 `it` 加左括号，否则会把自己数进去（踩过）。
    // 其余数字（准确率、误报率）要靠 npm run eval:check 对账，这里不重复造第二套口径。
    const dir = resolve(root, 'tests');
    const actual = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .reduce((n, src) => n + (src.match(/\bit\(/g)?.length ?? 0), 0);
    // 2 是 .test.ts 自己这一层不数，assert 一下免得把空目录当 0 通过
    expect(actual).toBeGreaterThan(300);

    const zhCounts = [...zh.matchAll(/(\d{3})\s*个单测/g)].map((m) => Number(m[1]));
    const enCounts = [...en.matchAll(/(\d{3}) unit tests/g)].map((m) => Number(m[1]));
    expect(zhCounts.length).toBeGreaterThan(0);
    expect(enCounts.length).toBeGreaterThan(0);
    expect({ zh: zhCounts.filter((n) => n !== actual), en: enCounts.filter((n) => n !== actual) }).toEqual({
      zh: [],
      en: [],
    });
  });

