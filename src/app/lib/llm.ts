import { replyFromLlm, systemPrompt } from '../../lib/agent/answer.ts';
import { TOOL_NAMES, TOOL_SCHEMA, runTool } from '../../lib/agent/tools.ts';
import type { AgentCtx, AgentReply, ToolCall, ToolName } from '../../lib/agent/types.ts';

const DEFAULT_BASE = 'https://api.deepseek.com/v1';

/**
 * 允许本地覆盖接口地址：只用于「没有 Key 时验证工具循环」——
 * 起 scripts/mock_llm.mjs 后设置 localStorage.ec_llm_base 即可。
 * 正常使用不设这个键，就走 DeepSeek 官方地址。
 */
function baseOverride(): string | null {
  try {
    return globalThis.localStorage?.getItem('ec_llm_base') || null;
  } catch {
    return null;
  }
}
const DEFAULT_MODEL = 'deepseek-chat';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface LlmOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  signal?: AbortSignal;
  onTool?: (call: ToolCall) => void;
}

/**
 * 智能模式：让模型「只调用工具、不自己算数」。
 * 浏览器直连 DeepSeek（OpenAI 兼容接口 + function calling），Key 只存 sessionStorage。
 */
export async function askWithLlm(
  question: string,
  ctx: AgentCtx,
  opts: LlmOptions,
): Promise<AgentReply> {
  const base = (opts.baseUrl || baseOverride() || DEFAULT_BASE).replace(/\/$/, '');
  const model = opts.model || DEFAULT_MODEL;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(ctx) },
    { role: 'user', content: question },
  ];
  const calls: ToolCall[] = [];

  for (let round = 0; round < 3; round++) {
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOL_SCHEMA,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      throw new Error(`无法连接模型服务：${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new Error(`模型返回 ${res.status}：${raw.slice(0, 300) || res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('模型返回为空（choices 缺失）');

    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? '';
        if (!TOOL_NAMES.includes(name as ToolName)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `不存在工具 ${name}` }),
          });
          continue;
        }
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        const call = runTool(name as ToolName, ctx, args);
        calls.push(call);
        opts.onTool?.(call);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ summary: call.summary, data: call.data, cites: call.cites }),
        });
      }
      continue;
    }

    const text = (msg.content ?? '').trim();
    return replyFromLlm(text || '（模型没有返回内容）', calls, ctx);
  }

  return replyFromLlm('（工具调用超过 3 轮，已停止）', calls, ctx, '超过最大工具轮次');
}
