import type { Analysis } from '../decide.ts';
import type { Dataset, Experiment } from '../types.ts';

export interface AgentCtx {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  exp: Experiment;
  analysis: Analysis;
  /** 当前提问原文（工具可按它选维度/筛选） */
  question?: string;
}

/** 一次工具调用的记录：UI 直接渲染这些，回答里的 [E1] 就是 cites */
export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
  /** 一句话结论（给 UI 的 chips 用） */
  summary: string;
  /** 结构化结果（展开可看） */
  data: unknown;
  /** 引用的证据编号（当前实验的 evidence id） */
  cites: string[];
}

export type ToolName =
  | 'get_overview'
  | 'run_test'
  | 'segment_breakdown'
  | 'check_guardrails'
  | 'compute_mde'
  | 'find_similar'
  | 'list_experiments'
  | 'explain_rules';

export interface AgentReply {
  /** 最终回答（含 [E1] 这类引用标记） */
  text: string;
  /** 意图，便于评测与调试 */
  intent: string;
  calls: ToolCall[];
  /** 数字保真度检查结果（规则模式下必然全过；LLM 模式用于抓幻觉） */
  audit: { total: number; suspicious: string[] };
  /** 生成方式：规则模板 / 大模型 */
  by: 'rules' | 'llm';
  /** LLM 失败时的降级说明 */
  note?: string;
  /** 违反铁律的地方（缺引用 / 出现无法溯源的数字），UI 直接展示 */
  violations?: string[];
}
