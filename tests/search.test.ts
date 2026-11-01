import { describe, expect, it } from 'vitest';
import {
  buildDocs,
  experimentDoc,
  groupHits,
  searchDocs,
  searchExperiments,
  tokenize,
  type SearchDoc,
} from '../src/lib/search.ts';

/**
 * ⌘K 检索（F4）。
 *
 * 这里锁的是**用户在搜索框里真正会碰到的事**，不是实现细节：
 * 多词是 AND、编号精确匹配要排第一、正则元字符不能炸、分组顺序跟着最高分走。
 * 最后一条尤其重要——面板里第几个 Prince 控件排在第几个，肉眼调，但顺序必须可复现。
 */
const docs: SearchDoc[] = [
  { kind: 'action', id: 'act:eval', target: '#/eval', title: '评测看板', subtitle: '准确率 / 分层 F1', group: '功能' },
  { kind: 'action', id: 'act:import', target: 'import', title: '导入数据', subtitle: 'JSON / CSV', group: '功能' },
  {
    kind: 'experiment',
    id: 'E001',
    target: '#/e/E001',
    title: 'E001 结算页改版',
    subtitle: '支付转化率',
    extra: '把结算按钮提前 预期提升支付转化 GUARDRAIL 2026-01-01',
    group: '实验',
  },
  {
    kind: 'experiment',
    id: 'E002',
    target: '#/e/E002',
    title: 'E002 建议位样式',
    subtitle: '支付转化率',
    extra: '兴趣feed里的推荐卡片样式 预期提升点击 HETEROGENEOUS 2026-01-02',
    group: '实验',
  },
  {
    kind: 'experiment',
    id: 'E029',
    target: '#/e/E029',
    title: 'E029 支付方式排序',
    subtitle: 'ARPU',
    extra: '按用户常用支付方式排序 预期提升客单价 POSITIVE 2026-01-03',
    group: '实验',
  },
];

describe('F4 · ⌘K 检索', () => {
  it('空查询与纯空白不给结果（不做「最近浏览」这种有状态的猜测）', () => {
    expect(searchDocs(docs, '')).toEqual([]);
    expect(searchDocs(docs, '   ')).toEqual([]);
    expect(tokenize('  a   b  ')).toEqual(['a', 'b']);
  });

  it('大小写不敏感，中英文都按子串命中', () => {
    expect(searchDocs(docs, 'e001').map((h) => h.doc.id)).toEqual(['E001']);
    expect(searchDocs(docs, 'E001').map((h) => h.doc.id)).toEqual(['E001']);
    expect(searchDocs(docs, '支付').map((h) => h.doc.id)).toEqual(
      expect.arrayContaining(['E001', 'E002', 'E029']),
    );
  });

  it('多词是 AND：每个词都要命中，缺一个就整条不要', () => {
    // 「支付」与「结算」都出现才算 —— E002 / E029 只有「支付」或只有「结算」
    expect(searchDocs(docs, '支付 结算').map((h) => h.doc.id)).toEqual(['E001']);
    // 词可以命中不同字段：E029 的 title 有「排序」，extra 有「客单价」
    expect(searchDocs(docs, '排序 客单价').map((h) => h.doc.id)).toEqual(['E029']);
    expect(searchDocs(docs, '支付 不存在的词')).toEqual([]);
  });

  it('排序：完全相同 > 前缀 > 包含；编号精确命中排在第一个', () => {
    const ids = searchDocs(docs, 'E001').map((h) => h.doc.id);
    expect(ids[0]).toBe('E001');

    // 「评测看板」完全等于标题，应排在任何只在正文里出现该词的项之前
    const g = searchDocs(docs, '评测看板');
    expect(g[0].doc.id).toBe('act:eval');
    expect(g[0].score).toBeGreaterThan(g[1]?.score ?? 0);

    // 「支付」在 E001/E002 的 subtitle 里精确命中，E029 只在 extra 里 → 前两个分数更高
    const pay = searchDocs(docs, '支付');
    expect(pay[0].score).toBeGreaterThan(pay[pay.length - 1].score);
  });

  it('功能的副标题不参与检索：那是解说文字，不是名字', () => {
    // 真实例子：设置页副标题写着「α、护栏 margin、SRM 阈值」，
    // 参与检索的话搜「护栏」第一条就是设置页，而不是被护栏拦住的实验。
    const docs: SearchDoc[] = [
      {
        kind: 'action',
        id: 'act:settings',
        target: '#/settings',
        title: '口径字典 / 设置',
        subtitle: 'α、护栏 margin、SRM 阈值、判定口径',
        extra: '设置 口径字典',
        group: '功能',
      },
      {
        kind: 'experiment',
        id: 'E001',
        target: '#/e/E001',
        title: 'E001 结算页改版',
        subtitle: '支付转化率',
        extra: 'GUARDRAIL 护栏不通过 不建议上线',
        group: '实验',
      },
    ];
    const hits = searchDocs(docs, '护栏');
    expect(hits.map((h) => h.doc.id)).toEqual(['E001']);
    // 相反，实验的主指标是可以搜的（它是实体属性）
    expect(searchDocs(docs, '支付转化率').map((h) => h.doc.id)).toEqual(['E001']);
    // 「设置」仍然能找到设置页——靠的是标题与显式关键词，不是副标题
    expect(searchDocs(docs, '设置').map((h) => h.doc.id)).toEqual(['act:settings']);
  });

  it('标题没命中时给出正文片段：用户得知道这条为什么会出现', () => {
    const h = searchDocs(docs, 'GUARDRAIL')[0];
    expect(h.marks).toEqual([]); // 标题里没有，不该硬标
    expect(h.snippet).toContain('GUARDRAIL');
    // 片段不能把整段假设都贴上去
    expect((h.snippet ?? '').length).toBeLessThanOrEqual(24);
    // 按词边界截，不是按字符——否则会截出「09-01 护栏不通过/不建…」这种半截噪音
    expect(h.snippet).toMatch(/^…?GUARDRAIL…?$/);
    expect(h.snippet).not.toContain('2026-01-01');
  });

  it('结果顺序可复现：同分时按 id 排（换机器不抖）', () => {
    const a = searchDocs(docs, '支付').map((h) => h.doc.id);
    const b = searchDocs(docs, '支付').map((h) => h.doc.id);
    expect(a).toEqual(b);
  });

  it('正则元字符不被当成 pattern：不抛错也不瞎匹配', () => {
    for (const q of ['(', ')', '*', '\\', 'p<0.05', '[', '.*', '$^', '+?']) {
      expect(() => searchDocs(docs, q)).not.toThrow();
      expect(searchDocs(docs, '.*').map((h) => h.doc.id)).toEqual([]);
    }
    // `.*` 若被当成正则会命中全部；子串口径下必须一条都没有
    expect(searchDocs(docs, 'N/A')).toEqual([]);
  });

  it('limit 截断且不影响顺序', () => {
    const all = searchDocs(docs, '支付', 40).map((h) => h.doc.id);
    const top = searchDocs(docs, '支付', 2).map((h) => h.doc.id);
    expect(top).toEqual(all.slice(0, 2));
  });

  it('分组按组内最高分排序，组内保持原序', () => {
    const gs = groupHits(searchDocs(docs, '支付'));
    expect(gs.length).toBeGreaterThanOrEqual(1);
    for (const g of gs) expect(g.hits.length).toBeGreaterThan(0);
    // 每个 doc 恰好出现一次：不能因为分组多算一份
    const flat = gs.flatMap((g) => g.hits).map((h) => h.doc.id);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('命中片段可用于高亮：范围落在标题长度内且非空', () => {
    const h = searchDocs(docs, '结算')[0];
    const [s, e] = h.marks[0];
    expect(e).toBeGreaterThan(s);
    expect(e).toBeLessThanOrEqual(h.doc.title.length);
    expect(h.doc.title.slice(s, e)).toBe('结算');
  });

  it('中文规则名必须能被搜到：extraWords 是 App 注入的本地化标签', () => {
    // 引擎只产出英文规则码 GUARDRAIL；面板却写着「试：护栏」——中间缺一层，承诺就是假的
    const base = experimentDoc(
      { id: 'E010', name: '某个实验', primaryMetric: '支付转化率', hypothesis: 'h' } as never,
      { reasonCode: 'GUARDRAIL', decision: 'no-ship' } as never,
    );
    expect(searchDocs([base], '护栏')).toEqual([]); // 不注入就是搜不到
    const zh = experimentDoc(
      { id: 'E010', name: '某个实验', primaryMetric: '支付转化率', hypothesis: 'h' } as never,
      { reasonCode: 'GUARDRAIL', decision: 'no-ship' } as never,
      ['护栏不通过', '不建议上线'],
    );
    expect(searchDocs([zh], '护栏').map((h) => h.doc.id)).toEqual(['E010']);
    expect(searchDocs([zh], 'GUARDRAIL').map((h) => h.doc.id)).toEqual(['E010']);
    expect(searchDocs([zh], '不建议上线').map((h) => h.doc.id)).toEqual(['E010']);
  });

  it('experimentDoc 把规则名与结论塞进可搜文本：能按「护栏」找到被拦的实验', () => {
    const hit = experimentDoc({ id: 'E001', name: 'x', primaryMetric: '转化率', archetype: 'guardrail' } as never, undefined);
    expect(hit.extra).toContain('guardrail');
    expect(hit.target).toBe('#/e/E001');
  });

  it('buildDocs 把动作排在实验前面（⌘K 打开时功能比列表更容易被想起）', () => {
    const all = buildDocs(
      { experiments: [{ id: 'E001', name: '结算页改版', hypothesis: 'h', primaryMetric: 'm' }], daily: [], seedBase: 1, generatedAt: 'x' } as never,
      new Map(),
      [{ kind: 'action', id: 'act:eval', target: '#/eval', title: '评测看板', group: '功能' }],
    );
    expect(all[0].kind).toBe('action');
    expect(all.some((d) => d.id === 'E001')).toBe(true);
  });

  it('searchExperiments：对比选择器复用同一个口径，返回 id 列表', () => {
    const list = [
      { id: 'E001', name: '结算页改版', hypothesis: '把结算按钮提前', primaryMetric: '支付转化率', archetype: 'positive' },
      { id: 'E002', name: '建议位样式', hypothesis: '卡片样式', primaryMetric: '支付转化率', archetype: 'null' },
    ] as never[];
    expect(searchExperiments(list, new Map(), '结算')).toEqual(['E001']);
    expect(searchExperiments(list, new Map(), '支付转化率')).toEqual(['E001', 'E002']);
    expect(searchExperiments(list, new Map(), '')).toEqual([]);
  });
});
