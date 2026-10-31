/**
 * 本地 mock 模型服务：在与 DeepSeek 相同的接口上模拟「先调工具、再作答」。
 *
 * 用途：没有 API Key 时也能验证「智能模式」的工具循环、引用回填与数字审计。
 * 它不产生任何新数字——回答完全由工具返回的 summary/cites 拼成，因此**不能**用来
 * 评测模型质量；只用于验证链路（见 docs/UI.md 的说明）。
 *
 *   node scripts/mock_llm.mjs                # 监听 8787
 *   前端：设置 localStorage.ec_llm_base = http://127.0.0.1:8787/v1，Key 随便填 mock
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);

const ROUTES = [
  [/为什么|规则|判定|结论|凭什么|依据/, 'explain_rules', {}],
  [/护栏|退款|投诉|延迟|风险/, 'check_guardrails', {}],
  [/分层|新老|人群|设备|ios|安卓/i, 'segment_breakdown', { dimension: 'tenure' }],
  [/样本|mde|功效|够不够|需要多少/i, 'compute_mde', {}],
  [/类似|相似|对比|历史/, 'find_similar', { limit: 5 }],
  [/哪些|列出|有多少/, 'list_experiments', {}],
  [/显著|效果|提升|转化|p ?值|区间/i, 'run_test', {}],
];

const pick = (text) => ROUTES.find(([re]) => re.test(text)) ?? [null, 'get_overview', {}];

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || '{}');
  const messages = payload.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

  // 已有工具结果 → 用工具内容拼最终回答（不编任何数字）
  if (lastTool) {
    let parsed = {};
    try {
      parsed = JSON.parse(lastTool.content);
    } catch {
      parsed = { summary: String(lastTool.content) };
    }
    const cites = (parsed.cites ?? []).map((c) => `[${c}]`).join('');
    const text = `根据工具返回：${parsed.summary ?? ''}${cites ? ` ${cites}` : ''}。`;
    reply(res, { role: 'assistant', content: text });
    return;
  }

  // 首轮 → 按问题选一个工具
  const [, name, args] = pick(lastUser?.content ?? '');
  reply(res, {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_mock_1',
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
});

function reply(res, message) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message }] }));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock 模型服务：http://127.0.0.1:${PORT}/v1  （仅用于验证工具循环，不代表模型能力）`);
});
