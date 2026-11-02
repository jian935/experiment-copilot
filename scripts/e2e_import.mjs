/**
 * 导入链路的端到端验证：把仓库里那份**真实的 .xlsx** 拖进浏览器，看它能不能自己拼出数据。
 *
 * 为什么单独一个脚本：这条链路上每一步都可能静默出错——
 *   sheet 选错 → 实验数为 0；列映射错 → 结论全变；元信息没合并 → 实验名退化成编号、评测看板消失。
 * 这些都不会抛异常，只会在界面上「看起来对」。所以这里断言的是**具体数字与文案**：
 *   6 个实验、336 行、名称是「结算页改版」、出现「含真值」徽章。
 *
 * 用法：先 npm run build && npx vite preview --port 4321，再 node scripts/e2e_import.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const EDGE = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const XLSX = resolve('data/A_B实验数据-v2.xlsx');
const PORT = Number(process.env.PORT ?? 9488);
const PROFILE = mkdtempSync(join(tmpdir(), 'e2e-import-'));
const SHOTS = resolve('docs/screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  return ok;
};

if (!existsSync(XLSX)) {
  console.error(`找不到 ${XLSX}——这个脚本要拿真实工作簿验证，缺了就没意义`);
  process.exit(2);
}
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

// 与 smoke_ui 同一个坑：preview 没起时这里不会报错，只会「等不到内置 · 120 例」，
// 看上去像是导入逻辑坏了。先花 0.1 秒确认页面拿得到，省掉十几分钟的误判。
const preflight = await fetch(`${BASE}/`).then((r) => r.status).catch(() => 0);
if (preflight !== 200) {
  console.error(`\n✗ 拿不到 ${BASE}/ （HTTP ${preflight}）——不是导入坏了，是服务没起。`);
  console.error('  先起服务再跑：npm run build && npx vite preview --port 4321\n');
  process.exit(2);
}

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--window-size=1440,1250',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let url;
for (let i = 0; i < 120; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((x) => x.type === 'page');
    if (page) {
      url = page.webSocketDebuggerUrl;
      break;
    }
  } catch {}
  await sleep(150);
}
if (!url) {
  console.error('连不上浏览器的调试端口');
  edge.kill();
  process.exit(2);
}

ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

/** 求值。没有 result 时直接抛——否则「表达式写错」与「页面没渲染」在调用侧长得一样（踩过） */
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败');
  return r.result?.value;
}

async function waitText(text, tries = 100, label = '') {
  for (let i = 0; i < tries; i++) {
    const ok = await evaluate(
      `(() => !!document.body && document.body.innerText.includes(${JSON.stringify(text)}))()`,
    ).catch(() => false);
    if (ok) return true;
    await sleep(150);
  }
  throw new Error(`等不到「${text}」${label ? `（${label}）` : ''}`);
}

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(SHOTS, name), Buffer.from(s.data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1250, deviceScaleFactor: 1, mobile: false });

console.log(`导入 E2E：${XLSX}\n${'─'.repeat(70)}`);

try {
  await send('Page.navigate', { url: `${BASE}/#/` });
  await waitText('内置 · 120 例', 120, '列表页');

  // 打开导入对话框
  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('导入数据'))?.click()`,
  );
  await waitText('把 Excel / CSV / JSON 拖进来', 60, '导入对话框');

  // 直接给文件输入框塞本地路径（等于用户点「选文件」，但不用操作系统文件框）
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!check(input.nodeId > 0, '页面里找不到文件输入框')) throw new Error('no input');
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [XLSX] });

  // 预检面板
  await waitText('进来的实验', 200, '预检');
  const summary = await evaluate('document.body.innerText');
  check(/6\s*个实验/.test(summary), `摘要里没有「6 个实验」`);
  check(summary.includes('336'), '摘要里没有 336 行明细');
  check(summary.includes('含真值'), '没有显示「含真值」徽章（说明元信息表没合并进来）');
  check(summary.includes('结算页改版'), '实验名没有从元信息表合并进来（还是编号）');
  check(/明细表「daily_metrics」/.test(summary), '没有显示读了哪张工作表');

  // 列识别：device 这类是「猜的」，应该提示待确认
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-expanded') !== null)?.click()`);
  await sleep(400);
  const mapping = await evaluate('document.body.innerText');
  check(mapping.includes('列识别'), '列识别区没展开');

  await shot('24-导入预检.png');

  // 确认导入
  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('确认导入'))?.click()`,
  );
  await waitText('导入 · 6 例', 120, '导入完成');
  await sleep(600);

  const after = await evaluate('document.body.innerText');
  check(after.includes('6'), '导入后列表没有 6 个实验');
  check(!after.includes('120 个实验'), '导入后仍显示内置的 120 个实验');
  await shot('25-导入后的列表.png');

  // 详情页：名称、真值、护栏都要在
  await evaluate(`location.hash = '#/e/E003'`);
  await waitText('推荐算法迭代', 80, 'E003 详情');
  const detail = await evaluate('document.body.innerText');
  check(detail.includes('推荐算法迭代'), '详情页标题没用合并进来的实验名');
  check(/退款率|GUARDRAIL|护栏/.test(detail), '详情页没有护栏信息');

  console.log(problems.length ? `✗ ${problems.length} 处不符合预期` : '✓ 通过（6 个实验 / 336 行 / 名称与真值都合并进来了）');
  for (const p of problems) console.log(`    · ${p}`);
} catch (e) {
  console.log(`✗ 中断：${e.message}`);
  problems.push(e.message);
} finally {
  try {
    ws?.close();
  } catch {}
  edge.kill();
  await new Promise((r) => {
    const t = setTimeout(r, 2000);
    edge.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    // Windows 上 Chrome 退出后句柄可能还没释放，删不掉就算了（profile 在 tmp 里）
  }
}

process.exit(problems.length ? 1 : 0);
