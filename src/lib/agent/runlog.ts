/**
 * 运行日志（M19 · Agent 可观测性）。
 *
 * 为什么单独成一个纯函数模块：
 *   一条回答「是怎么来的」——走了哪些工具、每个花了多久、调了几个数字、审计结果如何、
 *   模型用掉多少 token——是排障与复现（以及「这数字到底哪来的」）时唯一能贴给别人的东西。
 *   把它做成纯函数，巡检/评测/CLI 都能复用，不依赖 DOM，也能单测。
 *
 * 边界（和 audit.ts 一致）：只**转述** reply 里已经存在的字段，不重算、不补造。
 * 时间字段（durationMs / elapsedMs）是墙钟时间，只用于可观测性，**绝不进评测与回归基线**。
 */

import type { AgentReply } from './types.ts';

export interface RunLogTool {
  tool: string;
  /** 墙钟耗时（毫秒）；缺失记为 null，不填 0 假装测到了 */
  durationMs: number | null;
  /** 带出的证据条数 */
  cites: number;
  args: Record<string, unknown>;
  summary: string;
}

export interface RunLog {
  by: 'rules' | 'llm';
  intent: string;
  /** 整轮耗时（毫秒）；缺失为 null */
  elapsedMs: number | null;
  /** 模型用量；规则模式或服务端未返回 usage 时为 null */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  audit: { total: number; suspicious: string[] };
  violations: string[];
  toolCount: number;
  tools: RunLogTool[];
}

/** 把一条回答折成可序列化、可复现的运行日志（纯函数，不改 reply） */
export function runLogOf(reply: AgentReply): RunLog {
  return {
    by: reply.by,
    intent: reply.intent,
    elapsedMs: reply.elapsedMs ?? null,
    usage: reply.usage ?? null,
    audit: { total: reply.audit.total, suspicious: [...reply.audit.suspicious] },
    violations: [...(reply.violations ?? [])],
    toolCount: reply.calls.length,
    tools: reply.calls.map((c) => ({
      tool: c.tool,
      durationMs: c.durationMs ?? null,
      cites: c.cites.length,
      args: c.args,
      summary: c.summary,
    })),
  };
}

/** 导出为 JSON 文本：贴进 issue / 周报 / 复现脚本都能直接读 */
export function runLogJson(reply: AgentReply): string {
  return JSON.stringify(runLogOf(reply), null, 2);
}
