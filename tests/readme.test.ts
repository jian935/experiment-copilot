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
 * 从真实产物读出的数字（M20 修）。
 *
 * 以前 `FIGURES` 是一张写死的字符串清单，断言是 `README.includes(数字)`。
 * 那只能证明「这个字符串在文档里出现过」，**证明不了它等于实测值**：
 * 2026-11-04 全量巡检发现工具数 16→17、题库 18→20、问答 2200→2320 之后，
 * 595 个单测依然全绿，就是因为旧字符串还留在文档里。
 * 所以现在这些值一律当场从产物 / 源码算，不再有第二份需要人工同步的清单。
 */
const agentEval = JSON.parse(readFileSync(resolve(root, 'data/agent_eval.json'), 'utf8')) as {
  summary: { n: number; numbers: number; citableN: number };
  byQa: unknown[];
  toolCalls: unknown[];
  uncoveredTools: string[];
};
const baseline = JSON.parse(readFileSync(resolve(root, 'eval/baseline.json'), 'utf8')) as {
  metrics: Record<string, unknown>;
};
const toolsSrc = readFileSync(resolve(root, 'src/lib/agent/tools.ts'), 'utf8');
const schemaAt = toolsSrc.indexOf('export const TOOL_SCHEMA');
if (schemaAt < 0) throw new Error('找不到 TOOL_SCHEMA：工具数无法从源码复算，请同步 readme.test.ts');
const toolCount = (toolsSrc.slice(schemaAt).match(/^\s+name: '/gm) ?? []).length;

const REAL = {
  answers: agentEval.summary.n,
  numbers: agentEval.summary.numbers,
  citable: agentEval.summary.citableN,
  questions: agentEval.byQa.length,
  tools: toolCount,
  covered: agentEval.toolCalls.length,
  metrics: Object.keys(baseline.metrics).length,
};

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
  // ↓ 这四项由真实产物当场算出，不再手写（写死就会漂）
  String(REAL.answers), // Agent 问答条数 ← data/agent_eval.json
  String(REAL.numbers), // 可溯源数字个数 ← 同上
  String(REAL.citable), // 引用覆盖率分母 ← 同上
  String(REAL.metrics), // 回归基线指标数 ← eval/baseline.json
  // 单测条数故意不放进这张静态清单：它已经由下面那条断言**动态**对上实际用例数，
  // 放两份维护只会让「加一个测试要改两个地方」，而两处都可能忘记。
  '784KB', // 产物 JS
  '255KB', // 产物 gzip
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

  it('关键数字在两版里字面一致，且等于实测值', () => {
    const missZh = FIGURES.filter((f) => !zh.includes(f));
    const missEn = FIGURES.filter((f) => !en.includes(f));
    // 报出缺了哪几个，而不是只说「不相等」——否则改的人得自己 diff 一遍
    expect({ missZh, missEn }).toEqual({ missZh: [], missEn: [] });

    // 第二层：`includes` 只保证「这个字符串出现过」，挡不住文档里同时留着一个过时的旧数。
    // 所以把文档**实际声称**的值读回来，逐个和真值比。2026-11-04 那次全绿却漏掉
    // 4 处漂移，缺的就是这一层。
    const claimed = (md: string, re: RegExp): number | null => {
      const m = re.exec(md);
      return m ? Number(m[1]) : null;
    };
    type Claim = { name: string; got: number | null; want: number };
    const zhClaims: Claim[] = [
      { name: 'ZH 问答条数（命令清单）', got: claimed(zh, /(\d+) 条 Agent 问答/), want: REAL.answers },
      // 不能只写 /(\d+) 条问答/：会先撞上 ABLATION 那节的「24 条问答」
      { name: 'ZH 问答条数（评测表）', got: claimed(zh, /规则模式 \*\*(\d+) 条问答/), want: REAL.answers },
      { name: 'ZH 数字个数', got: claimed(zh, /(\d+) 个数字/), want: REAL.numbers },
      { name: 'ZH 题库数', got: claimed(zh, /(\d+) 道题覆盖全部/), want: REAL.questions },
      { name: 'ZH 工具数', got: claimed(zh, /^\| (\d+) 个工具/m), want: REAL.tools },
      { name: 'ZH 基线指标数', got: claimed(zh, /回归基线：(\d+) 个指标/), want: REAL.metrics },
    ];
    const enClaims: Claim[] = [
      { name: 'EN 问答条数（命令清单）', got: claimed(en, /over (\d+) Agent Q&A/), want: REAL.answers },
      { name: 'EN 问答条数（评测表）', got: claimed(en, /across (\d+) rule-mode answers/), want: REAL.answers },
      { name: 'EN 题库数', got: claimed(en, /a (\d+)-question bank/), want: REAL.questions },
      { name: 'EN 基线指标数', got: claimed(en, /Regression baseline: (\d+) metrics/), want: REAL.metrics },
    ];
    // markdown 里是 **17/17** tools，加粗闭合符夹在斜杠和 tools 之间
    const cover = /(\d+)\/(\d+)\*{0,2}\s+tools/.exec(en);
    enClaims.push({ name: 'EN 工具覆盖分子', got: cover ? Number(cover[1]) : null, want: REAL.covered });
    enClaims.push({ name: 'EN 工具覆盖分母', got: cover ? Number(cover[2]) : null, want: REAL.tools });

    // 失败时直接打印「哪一项、文档写了多少、实测是多少」，不用人再 diff 一遍 README
    expect([...zhClaims, ...enClaims].filter((c) => c.got !== c.want)).toEqual([]);

    // 第三层：产物内部自洽——schema 里的工具数必须等于评测覆盖数，且没有未覆盖工具
    expect(REAL.covered).toBe(REAL.tools);
    expect(agentEval.uncoveredTools).toEqual([]);
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

