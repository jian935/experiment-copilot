/**
 * Agent 问答的自动评测（审计项 D6：幻觉数字率接进 evaluate）
 *
 * 为什么放在 src/lib 而不是 scripts/：
 *   口径必须只有一份。命令行（`npm run eval`）、看板（评测页）、CI 基线比对
 *   都调这一个函数，避免出现「脚本说 0%、看板说 1.8%」这种两套数字。
 *
 * 为什么只用规则模式做基线：
 *   规则模式完全确定性（同输入同输出）、不需要 API Key，所以能进 CI 并做基线比对。
 *   智能模式有随机性（temperature>0 时同文不同答，实测 ±2 条），仍放在 ablation 里人工看，
 *   这两件事不能混成一句「我们测了幻觉率」。
 *
 * 「幻觉数字率」的定义（这个定义本身要写清楚，否则数字没意义）：
 *   回答里出现、但**引擎从未返回过**的数字个数 ÷ 回答里数字总数。
 *   判定由 agent/audit.ts 做：把 analysis 与全部工具返回值摊平成白名单，
 *   再按回答里写的小数位数四舍五入核对。所以它抓的是「编数字」，
 *   抓不到「数字对但解读错」——后者只能人工看，不假装能自动测。
 */
import { answerQuestion } from './agent/answer.ts';
import { TOOL_NAMES } from './agent/tools.ts';
import type { Analysis } from './decide.ts';
import type { Dataset } from './types.ts';

export interface QaItem {
  id: string;
  q: string;
  /** 分组：看板上按组展示，便于定位是「结论类」还是「口径类」出的问题 */
  group: '结论' | '统计' | '分层' | '护栏' | '预测' | '检索' | '口径';
  /** 只在这些实验上问。题目与该实验能力不匹配时（比如没有分层），问出来没有意义 */
  applies?: (a: Analysis) => boolean;
  /** 期望命中的意图；用于锁住「路由不许退化」（可选） */
  expectIntent?: string;
}

const isContinuous = (a: Analysis) => a.metricKind === 'continuous';
const hasSegments = (a: Analysis) => a.segments.tenure.length > 1;

/**
 * 题库。设计原则：
 *  1. **覆盖 14 个工具**——单测会检查每题的工具覆盖率，缺一个就说明有工具「写了但没人能用上」；
 *  2. 每题只在「该实验上答得出来」时才问，否则引用覆盖率会被无证据的题稀释成假低分；
 *  3. 口径陷阱题（ARPU / GMV / 留存）必留，它们是「敢说不知道」的唯一自动化证据。
 */
export const QA_BANK: QaItem[] = [
  { id: 'why', q: '为什么是这个结论？', group: '结论', expectIntent: 'rules' },
  { id: 'test', q: '主指标显著吗？', group: '统计', expectIntent: 'test' },
  { id: 'guard', q: '护栏有没有恶化？', group: '护栏', expectIntent: 'guardrail' },
  { id: 'seg', q: '新老用户有差异吗？', group: '分层', applies: hasSegments, expectIntent: 'segment' },
  { id: 'mde', q: '样本够不够？', group: '统计', expectIntent: 'mde' },
  { id: 'days', q: '还要跑几天？', group: '预测', expectIntent: 'forecast' },
  { id: 'peek', q: '我每天都在看这个看板，现在能下结论吗？', group: '统计', expectIntent: 'peek' },
  { id: 'novelty', q: '这个效果会不会随着时间衰减？', group: '统计', expectIntent: 'novelty' },
  { id: 'similar', q: '有类似实验吗？', group: '检索', expectIntent: 'similar' },
  { id: 'list', q: '有哪些实验被拦截了？', group: '检索', expectIntent: 'list' },
  { id: 'bayes', q: '贝叶斯怎么看这个结果？', group: '统计' },
  { id: 'used', q: '这个实验踩了哪条规则？', group: '结论', expectIntent: 'rules' },
  // 口径：连续口径实验上这是正经问题；率口径实验上它是一道「陷阱题」
  { id: 'arpu', q: 'ARPU 提升了多少？', group: '口径' },
  { id: 'decomp', q: '收入变化里转化率和客单价各占多少？', group: '口径', applies: isContinuous },
  { id: 'dict', q: 'ARPU 是怎么算的？', group: '口径' },
  { id: 'out_gmv', q: 'GMV 提升了多少？', group: '口径' },
  { id: 'out_ret', q: '留存率有变化吗？', group: '口径' },
];

export interface AgentQaRow {
  expId: string;
  qaId: string;
  group: QaItem['group'];
  q: string;
  intent: string;
  /** 期望意图，null 表示这题不校验路由 */
  expectIntent: string | null;
  /** 工具返回过可引用的证据（否则引用覆盖率不适用） */
  citable: boolean;
  cited: boolean;
  /** 回答里数值总数 / 其中引擎没给过的 */
  numbers: number;
  suspicious: number;
  suspiciousList: string[];
  violations: string[];
  chars: number;
  tools: string[];
  /** 口径陷阱题专用：是否说清主/副指标，或明确说没有这个口径 */
  statesScope: boolean;
  /** 这道题在这个实验上是不是「陷阱」：问 ARPU 但主指标是转化率 */
  trap: boolean;
  answer: string;
}

export interface AgentQaEval {
  /** 问答条数 */
  n: number;
  /** 回答里数值总数 */
  numbers: number;
  /** 其中引擎从未返回过的（幻觉数字） */
  suspicious: number;
  /** **幻觉数字率** = suspicious / numbers（D6 主指标） */
  hallucinationRate: number;
  /** 含至少一个幻觉数字的回答占比（换一个口径看：一条回答错一个数字就算脏） */
  dirtyAnswerRate: number;
  /** 引用覆盖率：工具返回了证据的那些回答里，带 [E#] 的比例 */
  citationRate: number;
  /** 不适用的引用分母（无证据可引的回答数）——说明覆盖率的分母是怎么来的 */
  citableN: number;
  /** 违规率：缺引用或出现幻觉数字的回答占比 */
  violationRate: number;
  /** 口径陷阱识别率：问 ARPU 而实验主指标是转化率时，说清主/副指标的比例 */
  scopeRate: number;
  /** 陷阱题条数（分母）。为 0 时 scopeRate 无意义，看板必须据此隐藏 */
  trapN: number;
  /** 路由准确率：期望意图已知的题里被正确路由的比例（锁住「改词表把路由改坏」） */
  routeAccuracy: number;
  routeN: number;
  byGroup: { group: string; n: number; numbers: number; suspicious: number; citationRate: number; routeAccuracy: number }[];
  byIntent: { intent: string; n: number }[];
  /** 工具覆盖：每个工具被调用了几次，以及**一次都没被用到的工具** */
  toolCalls: { tool: string; calls: number }[];
  uncoveredTools: string[];
  rows: AgentQaRow[];
}

/** 口径纪律：要么说清「主指标 vs 副指标」，要么明确说「没有这个口径」 */
export const SCOPE_ACK =
  /主指标|副指标|只能作为参考|不能当.*结论|数据里没有|未提供|不包含这个口径|不是这个口径|不在口径字典|没有登记/;

/**
 * 跑题库，返回可审计的明细 + 汇总。
 *
 * 注意 `analyses` 与 `dataset` 必须来自同一次分析（同一份 config）：
 * 界面改了阈值、这里读旧 analysis，就会测出「引擎说 A、Agent 说 B」的假故障。
 */
export function evaluateAgent(dataset: Dataset, analyses: Map<string, Analysis>, bank: QaItem[] = QA_BANK): AgentQaEval {
  const rows: AgentQaRow[] = [];
  const toolCounter = new Map<string, number>(TOOL_NAMES.map((t) => [t, 0]));

  for (const exp of dataset.experiments) {
    const analysis = analyses.get(exp.id);
    if (!analysis) continue;
    for (const item of bank) {
      if (item.applies && !item.applies(analysis)) continue;
      const reply = answerQuestion(item.q, { dataset, analyses, exp, analysis });
      const citable = reply.calls.some((c) => c.cites.length > 0);
      for (const c of reply.calls) toolCounter.set(c.tool, (toolCounter.get(c.tool) ?? 0) + 1);
      rows.push({
        expId: exp.id,
        qaId: item.id,
        group: item.group,
        q: item.q,
        intent: reply.intent,
        expectIntent: item.expectIntent ?? null,
        citable,
        cited: /\[E\d+\]/.test(reply.text),
        numbers: reply.audit.total,
        suspicious: reply.audit.suspicious.length,
        suspiciousList: reply.audit.suspicious,
        violations: reply.violations ?? [],
        chars: reply.text.length,
        tools: reply.calls.map((c) => c.tool),
        statesScope: SCOPE_ACK.test(reply.text),
        trap: item.id === 'arpu' && !isContinuous(analysis),
        answer: reply.text,
      });
    }
  }

  const n = rows.length;
  const numbers = rows.reduce((s, r) => s + r.numbers, 0);
  const suspicious = rows.reduce((s, r) => s + r.suspicious, 0);
  const citableRows = rows.filter((r) => r.citable);
  const routed = rows.filter((r) => r.expectIntent !== null);
  // 口径纪律的分母只取「陷阱题」：率口径实验被问 ARPU。连续口径实验上这是一道正经题，
  // 混进来会把分母稀释，让「敢说不知道」看起来比实际好。
  const trapRows = rows.filter((r) => r.trap);

  const groups = [...new Set(rows.map((r) => r.group))];
  const intents = [...new Set(rows.map((r) => r.intent))];

  const toolCalls = [...toolCounter.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls);

  return {
    n,
    numbers,
    suspicious,
    hallucinationRate: numbers ? suspicious / numbers : 0,
    dirtyAnswerRate: n ? rows.filter((r) => r.suspicious > 0).length / n : 0,
    citationRate: citableRows.length ? citableRows.filter((r) => r.cited).length / citableRows.length : 1,
    citableN: citableRows.length,
    violationRate: n ? rows.filter((r) => r.violations.length > 0 || r.suspicious > 0).length / n : 0,
    scopeRate: trapRows.length ? trapRows.filter((r) => r.statesScope).length / trapRows.length : 1,
    trapN: trapRows.length,
    routeAccuracy: routed.length ? routed.filter((r) => r.intent === r.expectIntent).length / routed.length : 1,
    routeN: routed.length,
    byGroup: groups.map((g) => {
      const sub = rows.filter((r) => r.group === g);
      const cr = sub.filter((r) => r.citable);
      const rt = sub.filter((r) => r.expectIntent !== null);
      return {
        group: g,
        n: sub.length,
        numbers: sub.reduce((s, r) => s + r.numbers, 0),
        suspicious: sub.reduce((s, r) => s + r.suspicious, 0),
        citationRate: cr.length ? cr.filter((r) => r.cited).length / cr.length : 1,
        routeAccuracy: rt.length ? rt.filter((r) => r.intent === r.expectIntent).length / rt.length : 1,
      };
    }),
    byIntent: intents.map((intent) => ({ intent, n: rows.filter((r) => r.intent === intent).length })).sort((a, b) => b.n - a.n),
    toolCalls,
    uncoveredTools: toolCalls.filter((t) => t.calls === 0).map((t) => t.tool),
    rows,
  };
}

/** 让看板能一眼看出「这道题在哪些实验上答得最差」：按题号聚合一版 */
export function byQa(ev: AgentQaEval): { qaId: string; group: string; q: string; n: number; numbers: number; suspicious: number; citationRate: number; routeAccuracy: number }[] {
  const ids = [...new Set(ev.rows.map((r) => r.qaId))];
  return ids.map((id) => {
    const sub = ev.rows.filter((r) => r.qaId === id);
    const cr = sub.filter((r) => r.citable);
    const rt = sub.filter((r) => r.expectIntent !== null);
    return {
      qaId: id,
      group: sub[0].group,
      q: sub[0].q,
      n: sub.length,
      numbers: sub.reduce((s, r) => s + r.numbers, 0),
      suspicious: sub.reduce((s, r) => s + r.suspicious, 0),
      citationRate: cr.length ? cr.filter((r) => r.cited).length / cr.length : 1,
      routeAccuracy: rt.length ? rt.filter((r) => r.intent === r.expectIntent).length / rt.length : 1,
    };
  });
}
