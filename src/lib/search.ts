import type { Analysis } from './decide.ts';
import type { Dataset, Experiment } from './types.ts';

/**
 * ⌘K 全局搜索（F4）：**检索与排序必须是纯函数**，UI 只负责画。
 *
 * 三条刻意的设计取舍：
 *
 * ① **多词是 AND，不是 OR**。输入「支付 退款」应该越搜越少，而不是越搜越多；
 *    每个词都必须命中某一个字段（可以是不同字段）。
 * ② **匹配质量有顺序**：完全相同 > 前缀 > 包含。搜 `E001` 要第一个蹦出 E001，
 *    而不是「第 100 个含有 `E001` 子串的实验」。
 * ③ **不用正则**。查询里出现 `(`、`*`、`\` 是常态（用户想查 `p<0.05`），
 *    正则要么抛错要么静默错配——一律 `indexOf` 子串匹配。
 */
export type SearchKind = 'experiment' | 'action';

export interface SearchDoc {
  kind: SearchKind;
  /** 稳定 key：实验用 id，操作用动作名 */
  id: string;
  /** 命中后要执行的东西：实验是 id，操作是 `location.hash` 或回调 key */
  target: string;
  title: string;
  subtitle?: string;
  /** 额外可搜文本（不展示） */
  extra?: string;
  group: string;
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  /** 命中的字符片段（标题内），用于 UI 高亮 */
  marks: [number, number][];
  /** 标题没命中时，从正文里截的一小段上下文——否则用户看不出「为什么这条会出来」 */
  snippet?: string;
}

/** 字段权重：命中 id 远比命中正文重要 */
const W_TITLE = 6;
const W_SUB = 3;
const W_EXTRA = 1;
/** 匹配类型乘子 */
const M_EXACT = 3;
const M_PREFIX = 2;
const M_INCLUDE = 1;

function scoreField(hay: string, needle: string): { score: number; marks: [number, number][] } | null {
  if (!hay) return null;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const i = h.indexOf(n);
  if (i < 0) return null;
  const m = h.length === n.length ? M_EXACT : i === 0 ? M_PREFIX : M_INCLUDE;
  return { score: m, marks: [[i, i + n.length]] };
}

function scoreDoc(
  doc: SearchDoc,
  term: string,
): { score: number; marks: [number, number][]; snippet?: string } | null {
  const t = scoreField(doc.title, term);
  // 副标题只让**实验**参与检索（实验的副标题是主指标，是实体属性）；
  // 功能的副标题是解说文字（「α、护栏 margin、SRM 阈值」），
  // 把它当可搜内容的结果是搜「护栏」第一条蹦出设置页——那是注释，不是名字。
  const s = doc.subtitle && doc.kind === 'experiment' ? scoreField(doc.subtitle, term) : null;
  const e = doc.extra ? scoreField(doc.extra, term) : null;
  if (!t && !s && !e) return null;
  const score = (t?.score ?? 0) * W_TITLE + (s?.score ?? 0) * W_SUB + (e?.score ?? 0) * W_EXTRA;
  // 标题命中的片段是要标出来的那一段；标题没命中时给一小段正文上下文
  const src = t ? doc.title : s ? doc.subtitle! : doc.extra!;
  const at = t ? t.marks[0] : s ? s.marks[0] : e!.marks[0];
  const snippet = t ? undefined : around(src, at[0], at[1]);
  return { score, marks: t?.marks ?? [], snippet };
}

/**
 * 截取命中处的上下文。
 * 先按**空格/分隔符切到词边界**：extra 是「假设 + 规则码 + 中文标签 + 日期」拼起来的，
 * 按字符截会得到「09-01 护栏不通过/不建…」这种半截噪音；按词截出来是干净的「护栏不通过」。
 * 词太长（中文长句没有空格）才退化成前后各 6 个字符。
 */
function around(text: string, s: number, e: number): string {
  const lo = text.lastIndexOf(' ', Math.max(0, s - 1)) + 1;
  const i = text.indexOf(' ', e);
  const hi = i < 0 ? text.length : i;
  const word = text.slice(lo, hi).trim();
  if (word.length <= 20) {
    return `${lo > 0 ? '…' : ''}${word}${hi < text.length ? '…' : ''}`;
  }
  const a = Math.max(0, s - 6);
  const b = Math.min(text.length, e + 6);
  return `${a > 0 ? '…' : ''}${text.slice(a, b).trim()}${b < text.length ? '…' : ''}`;
}

/** 空格分词；空串与纯空白返回空数组 */
export function tokenize(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

/**
 * 检索。
 * - 空查询 → 空结果（这里不返回「最近浏览」，那是有状态的东西，纯函数不该有）
 * - 任一 token 没命中 → 整条丢弃（AND 语义）
 * - 按分数降序；分数相同时按 id 升序，保证同 seed 下顺序可复现
 */export function searchDocs(docs: SearchDoc[], q: string, limit = 40): SearchHit[] {
  const terms = tokenize(q);
  if (terms.length === 0) return [];
  const out: SearchHit[] = [];
  for (const doc of docs) {
    let total = 0;
    let marks: [number, number][] = [];
    let snippet: string | undefined;
    let ok = true;
    for (const term of terms) {
      const r = scoreDoc(doc, term);
      if (!r) {
        ok = false;
        break;
      }
      total += r.score;
      if (marks.length === 0) marks = r.marks;
      // 只留第一个词给的上下文：多词查询时塞三行片段会把列表撑爆
      if (!snippet && r.snippet) snippet = r.snippet;
    }
    if (ok) out.push({ doc, score: total, marks, snippet });
  }
  out.sort((a, b) => (b.score - a.score) || a.doc.id.localeCompare(b.doc.id));
  return out.slice(0, limit);
}

/**
 * 分组展示：组的先后顺序 = 组内最高分的先后（hits 已按分数排序，取首次出现即可）。
 * 不做「每组固定显示几个」——那会让高分项被低分组挤掉。
 */
export function groupHits(hits: SearchHit[]): { group: string; hits: SearchHit[] }[] {
  const order: string[] = [];
  const m = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const g = h.doc.group;
    if (!m.has(g)) {
      m.set(g, []);
      order.push(g);
    }
    m.get(g)!.push(h);
  }
  return order.map((group) => ({ group, hits: m.get(group)! }));
}

/** 只搜实验：对比视图的选择器也用它，两处的匹配口径不可能漂移 */export function searchExperiments(list: Experiment[], analyses: Map<string, Analysis>, q: string, limit = 60): string[] {
  const docs: SearchDoc[] = list.map((e) => experimentDoc(e, analyses.get(e.id)));
  return searchDocs(docs, q, limit).map((h) => h.doc.id);
}

/**
 * 一个实验的可搜内容。刻意把**结论与规则名**也放进去：
 * 用户更常想起的是「那个被护栏拦住的」，而不是实验编号。
 *
 * `extraWords` 给调用方塞**本地化的规则名**（`护栏不通过` 这种中文）：
 * 引擎层只认英文规则码，而用户输入的肯定是中文，少了这一步，
 * 「能按规则名搜」这句承诺就是假的（面板里写着让用户试「护栏」）。
 */
export function experimentDoc(e: Experiment, an?: Analysis, extraWords: string[] = []): SearchDoc {
  return {
    kind: 'experiment',
    id: e.id,
    target: `#/e/${e.id}`,
    title: `${e.id} ${e.name}`,
    subtitle: e.primaryMetric,
    extra: [e.hypothesis, an?.reasonCode, an?.decision, e.archetype, e.startDate, ...extraWords]
      .filter(Boolean)
      .join(' '),
    group: '实验',
  };
}

/**
 * 全局可搜文档：操作 + 实验。
 * `localize` 只有当引擎产出结果后才被调用，用来补中文的规则名/结论名。
 */
export function buildDocs(
  dataset: Dataset,
  analyses: Map<string, Analysis>,
  actions: SearchDoc[] = [],
  localize?: (an: Analysis) => string[],
): SearchDoc[] {
  return [
    ...actions,
    ...dataset.experiments.map((e) => {
      const an = analyses.get(e.id);
      return experimentDoc(e, an, an && localize ? localize(an) : []);
    }),
  ];
}
