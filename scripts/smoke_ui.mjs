/**
 * UI 冒烟：把构建产物真的用浏览器打开，逐屏点一遍，抓「白屏 / undefined / NaN / 运行时异常」。
 *
 * 为什么需要它：`tsc --noEmit` 只能证明类型对，`vitest` 只测纯函数。
 * 而 ARPU 这条路上真正会出事的地方都在渲染层——某个字段在连续口径下是 undefined、
 * 某个组件拿到了 `元` 却按 `pp` 格式化、某个面板假设一定有 `arpu`。
 * 这些错误只在运行时出现，而且往往是白屏。
 *
 * 用法：
 *   npm run build && npx vite preview --port 4321 &
 *   node scripts/smoke_ui.mjs                       # 默认 http://127.0.0.1:4321/
 *   BASE=http://127.0.0.1:5173 node scripts/smoke_ui.mjs
 *
 * 判据（任一不满足即退出码 1）：
 *   ① 每屏渲染后正文长度 > 200 字（白屏 = 长度极短）
 *   ② 正文里不出现 undefined / NaN / [object Object]
 *   ③ 全程没有未捕获异常、没有 console.error
 */
import { spawn } from 'node:child_process';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = (process.env.BASE || 'http://127.0.0.1:4321/').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT || 9433);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每条路由都要覆盖到不同的代码路径：列表（混排两种口径）、
// 率口径详情、连续口径详情（ARPU 面板 + 因子分解）、异质、护栏拦截、评测、设置
const ROUTES = [
  { hash: '#/', name: '实验列表（120 个，两种口径混排）', must: ['决策', '实验', '全局校正'] },
  { hash: '#/e/E001', name: '详情 · 率口径 + 护栏拦截', must: ['退款率', '转化率', '序贯监控', '新颖效应', '期望损失决策'] },
  { hash: '#/e/E029', name: '详情 · 连续口径（ARPU + 因子分解）', must: ['ARPU', '因子分解', '客单价', '序贯监控', '新颖效应', '期望损失决策'] },
  { hash: '#/e/E002', name: '详情 · 分层异质', must: ['分层'] },
  { hash: '#/eval', name: '评测看板', must: ['准确率', '分层检测', '幻觉数字率', 'F1'] },
  { hash: '#/settings', name: '设置 · 口径字典', must: ['口径'] },
];

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const page = j.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('连不上 CDP');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push(`${d.text} ${d.exception?.description ?? ''}`.trim().slice(0, 300));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(
      msg.params.args
        .map((a) => a.value ?? a.description ?? '')
        .join(' ')
        .slice(0, 300),
    );
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

const rows = [];
let failed = 0;

for (const route of ROUTES) {
  const before = exceptions.length + consoleErrors.length;
  await send('Page.navigate', { url: `${BASE}/${route.hash}` });
  // 等渲染：轮询正文长度，避免用固定 sleep（渲染比脚本慢，sleep 会假通过）
  let text = '';
  for (let i = 0; i < 60; i++) {
    await sleep(120);
    text = (await evaluate('document.querySelector("#root")?.innerText ?? ""')) || '';
    if (text.length > 200) break;
  }
  await sleep(250);

  const problems = [];
  if (text.length <= 200) problems.push(`正文只有 ${text.length} 字（疑似白屏）`);
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    if (text.includes(bad)) {
      const at = text.indexOf(bad);
      problems.push(`正文出现「${bad}」：…${text.slice(Math.max(0, at - 40), at + 20).replace(/\n/g, ' ')}…`);
    }
  }
  for (const k of route.must) {
    if (!text.includes(k)) problems.push(`缺少关键字「${k}」`);
  }
  const newErrors = exceptions.length + consoleErrors.length - before;
  if (newErrors > 0) {
    problems.push(`新增异常/console.error ${newErrors} 条：${[...exceptions, ...consoleErrors].slice(-newErrors).join(' | ')}`);
  }

  rows.push({ route, len: text.length, problems });
  if (problems.length) failed++;
}

console.log(`\nUI 冒烟：${ROUTES.length} 条路由 @ ${BASE}\n${'─'.repeat(70)}`);
for (const r of rows) {
  const mark = r.problems.length ? '✗' : '✓';
  console.log(`${mark} ${r.route.name.padEnd(30)} 正文 ${String(r.len).padStart(5)} 字`);
  for (const p of r.problems) console.log(`    · ${p}`);
}
console.log('');

ws.close();
edge.kill();
process.exit(failed ? 1 : 0);
