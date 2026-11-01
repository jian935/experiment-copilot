/**
 * 整页截图（给 docs/screenshots 和人工核对版式用）。
 *
 * 为什么自己写而不用 Playwright：本机只装了 Edge，项目也不该为了截图多一个重依赖。
 * 用 CDP 直接抓 `captureBeyondViewport`，一张图就是整页，不需要滚动拼接。
 *
 * 用法：
 *   npm run build && npx vite preview --port 4321 &
 *   node scripts/screenshot.mjs '#/e/E001' docs/screenshots/02-详情-率口径.png
 *   node scripts/screenshot.mjs '#/eval' docs/screenshots/08-评测看板.png 1440
 *
 * 注意（Git Bash）：hash 里的 `#/e/...` 会被 MSYS 当成路径转换，
 * 一定要写成 `MSYS_NO_PATHCONV=1 node scripts/screenshot.mjs '#/e/E001' ...`，
 * 或者把 BASE 用 --base 显式给全（脚本会把两者拼起来，不做任何解析）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = (process.env.BASE || 'http://127.0.0.1:4321').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT || 9466);
// 独立 profile：截图跑完会留下 IndexedDB（导入过的数据源），
// 复用默认 profile 会让「数据源」这类状态在两次截图之间互相污染。
const PROFILE = join(tmpdir(), `expcopilot-shot-${process.pid}`);

const args = process.argv.slice(2);
const hash = args[0] || '#/';
const out = args[1] || 'shot.png';
const width = Number(args[2] || 1440);

/** 等页面真的渲染完：详情页等「返回实验列表」，其它页等正文超过 200 字 */
const READY = `(() => {
  const t = document.querySelector('#root')?.innerText ?? '';
  return t.length > 200 && (t.includes('返回实验列表') || !t.includes('加载 120 个实验'));
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--hide-scrollbars', `--window-size=${width},1200`,
    `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = j.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('连不上 CDP（Edge 没起来，或端口被占用）');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/${hash}` });

let ready = false;
for (let i = 0; i < 80; i++) {
  await sleep(150);
  const r = await send('Runtime.evaluate', { expression: READY, returnByValue: true });
  if (r.result?.value === true) {
    ready = true;
    break;
  }
}
if (!ready) console.warn('⚠ 12 秒内没等到渲染完成，可能是白屏；仍按当前状态截图');
await sleep(400);

// 可选：截图前先执行一段 JS（用来抓「点开下拉 / 切换 tab」这类默认不可见的状态）。
// 传 `@path` 表示从文件读——长脚本塞进命令行会被引号转义搞死。
const preArg = args[3];
if (preArg) {
  const pre = preArg.startsWith('@') ? readFileSync(preArg.slice(1), 'utf8') : preArg;
  await send('Runtime.evaluate', { expression: pre, returnByValue: true, awaitPromise: true });
  await sleep(450);
}

const m = await send('Page.getLayoutMetrics');
const h = Math.ceil(m.cssContentSize.height);
await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`${out}  ${width}×${h}`);

ws.close();
edge.kill();
await new Promise((resolve) => {
  const t = setTimeout(resolve, 1500);
  edge.once('exit', () => {
    clearTimeout(t);
    resolve();
  });
});
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* 删不掉不影响截图结果 */
}
process.exit(0);
