/**
 * Agent 记忆层（M18）。
 *
 * 为什么单独成一个模块、且只用结构类型、不 import 任何 React / 浏览器存储：
 *   这份代码同时被「前端问答」「巡检」「CLI 评测（`evaluateAgent`）」三处调用，
 *   而决策记录的真实来源（IndexedDB / localStorage）只在浏览器里。
 *   所以本模块只认「结构」，调用方把已经读出来的记录（`DecisionRecord[]`）传进来，
 *   这里只做聚合与文本生成——保持纯函数、可单测、不耦合 UI。
 *
 * 记忆的本质：让 Agent 从「每次都从零读一个实验」变成「记得你这台机器上对这批实验做过什么判断」。
 * 它不替你算数（铁律），只把**你冻结过的决定**原样复述出来，并标出和引擎结论不一致的地方。
 * 和 `decisions.ts` 的边界：`decisions.ts` 负责「怎么存、怎么取、坏数据怎么兜底」，
 * 本模块负责「取到之后怎么聚合、怎么讲给 Agent / 巡检听」。
 */

export type MemoryDecisionKind = 'ship' | 'no-ship' | 'iterate' | 'hold';

/** 结构类型：调用方传已读出的记录即可，不必 import 浏览器存储 */
export interface MemoryDecision {
  expId: string;
  decision: MemoryDecisionKind;
  /** 为什么这么定（与引擎不一致时的必填理由） */
  note: string;
  /** ISO 时间字符串 */
  decidedAt: string;
  /** 当时冻结的引擎结论，用于矛盾检测，不依赖实时重算 */
  engineDecision?: string;
  /** 当时冻结的关键数字（仅用于将来可能的回显，不参与任何判断） */
  diff?: number;
  unit?: string;
  p?: number;
}

export const MEMORY_DECISION_LABEL: Record<MemoryDecisionKind, string> = {
  ship: '上线',
  'no-ship': '不上线',
  iterate: '迭代后再说',
  hold: '先搁置',
};

export interface AgentMemory {
  /** 已记录决定的实验数 */
  count: number;
  /** 按人类判决分类的计数 */
  byDecision: Record<string, number>;
  /** 最近的若干条，按时间倒序 */
  recent(limit?: number): MemoryDecision[];
  /** 某实验的人类判决（没有则返回 undefined） */
  decisionFor(expId: string): MemoryDecision | undefined;
  /** 人类判决与当时引擎结论是否矛盾（只在明确相反时判矛盾） */
  contradicts(expId: string): boolean;
  /** 给单实验的回忆文本：供 Agent 回答，也供巡检备注复用 */
  summaryFor(expId: string): string;
}

/**
 * 矛盾判定只取「明确相反」两种情形，不把人的犹豫（iterate / hold）算成矛盾：
 *   - 人判 ship 且引擎 no-ship → 矛盾（人比引擎乐观）
 *   - 人判 no-ship 且引擎 ship → 矛盾（人比引擎保守）
 *   - iterate / hold 是对结论的暂缓，引擎本身也没说死，不算矛盾
 *   - 引擎 inconclusive（引擎自己都没结论）时，人的任何判决都不算矛盾
 */
function isContradiction(decision: MemoryDecisionKind, engine?: string): boolean {
  if (!engine || engine === 'inconclusive') return false;
  if (decision === 'ship' && engine === 'no-ship') return true;
  if (decision === 'no-ship' && engine === 'ship') return true;
  return false;
}

export function buildMemory(decisions: MemoryDecision[]): AgentMemory {
  const list = [...decisions].sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));

  const byDecision: Record<string, number> = {};
  for (const d of list) byDecision[d.decision] = (byDecision[d.decision] ?? 0) + 1;

  const decisionFor = (expId: string): MemoryDecision | undefined =>
    list.find((d) => d.expId === expId);

  const contradicts = (expId: string): boolean => {
    const d = decisionFor(expId);
    return d ? isContradiction(d.decision, d.engineDecision) : false;
  };

  const summaryFor = (expId: string): string => {
    const d = decisionFor(expId);
    if (!d) {
      return '你尚未对该实验下过人工决定（决策留痕只存在你本机浏览器，不上传、不进评测、不进任何公开产物）。';
    }
    const label = MEMORY_DECISION_LABEL[d.decision];
    const date = d.decidedAt.slice(0, 10);
    const note = d.note ? `当时的理由是：${d.note}。` : '';
    const engine = d.engineDecision ? `引擎当时的结论是 ${d.engineDecision}。` : '';
    const contra = contradicts(expId)
      ? ' 注意：你的判决和引擎当时的结论不一致——这条留痕就是为了把「人做过判断」冻结下来，复盘看的是理由而不是 p 值。'
      : '';
    return `你于 ${date} 对该实验判了「${label}」。${engine}${note}${contra}`;
  };

  return {
    count: list.length,
    byDecision,
    recent: (limit = 10) => list.slice(0, limit),
    decisionFor,
    contradicts,
    summaryFor,
  };
}

/** 空记忆（评测 / 没记录时使用，保证调用方永远拿到一个非空对象） */
export const EMPTY_MEMORY: AgentMemory = buildMemory([]);
