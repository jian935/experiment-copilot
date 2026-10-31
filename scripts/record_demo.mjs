/**
 * 录制 Experiment Copilot 的真实操作画面（CDP screencast）。
 * 路径按「先展示会拒绝，再展示会解释」的顺序走，和演讲动线一致。
 *
 *   node scripts/record_demo.mjs            # 默认录到 deliverables/video/frames
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.DEMO_URL || 'http://127.0.0.1:4321/';
const PORT = Number(process.env.CDP_PORT || 9333);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const OUT = process.env.OUT || 'deliverables/video/frames';
const EVERY = Number(process.env.EVERY_NTH || 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--use-angle=d3d11',
    '--use-angle=d3d11',
    '--disable-features=CalculateNativeWinOcclusion',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const page = j.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await getWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
let frameNo = 0;
const marks = [];
/** 每帧的真实时间戳（秒）：screencast 只在画面变化时出帧，静止段要按时间戳拉长 */
const frames = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === 'Page.screencastFrame') {
    const { data, sessionId, metadata } = m.params;
    writeFileSync(join(OUT, `f${String(frameNo).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
    frames.push(Number(metadata?.timestamp ?? 0));
    frameNo += 1;
    send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }
});

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result?.value;
};

/** 按文字点按钮/行，返回是否点到 */
const clickText = (text, tag = 'button') =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('${tag}')].find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

const clickRow = (id) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(id)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);

/** 轮询等待某段文字出现（页面渲染比脚本慢时，sleep 拍不准） */
async function waitText(text, timeout = 6000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const ok = await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
    if (ok) return true;
    await sleep(120);
  }
  return false;
}

let t0 = 0;
const now = () => (Date.now() - t0) / 1000;

async function seg(name, fn) {
  marks.push({ name, start: Number(now().toFixed(2)) });
  await fn();
  marks[marks.length - 1].end = Number(now().toFixed(2));
  console.log(`  ${name}: ${marks[marks.length - 1].start}s → ${marks[marks.length - 1].end}s`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(2600);

t0 = Date.now();
await send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: EVERY });
console.log('开始录制…');

// S1 列表：滚动展示 120 个实验 + 点一个"分流异常"的
await seg('s1_list', async () => {
  await sleep(1200);
  await evaluate(`window.scrollTo({ top: 260, behavior: 'smooth' })`);
  await sleep(1600);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`);
  await sleep(1200);
});

// S2 SRM 异常：先展示"会拒绝下结论"
await seg('s2_srm', async () => {
  await clickRow('E006');
  await waitText('SRM 分流异常');
  await sleep(2000);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(1800);
});

// S3 护栏拦截：主指标正向但退款率恶化
await seg('s3_guardrail', async () => {
  await clickText('返回实验列表');
  await sleep(1400);
  await clickRow('E001');
  await waitText('引擎结论');
  await sleep(2200);
});

// S4 证据链：展开护栏那一条，看逐步代入
await seg('s4_evidence', async () => {
  await clickText('证据链');
  await waitText('数据与口径');
  await sleep(700);
  await evaluate(`(() => {
    const li = [...document.querySelectorAll('[role=dialog] li')].find((n) => n.textContent.includes('护栏：退款率'));
    if (!li) return false;
    const btn = [...li.querySelectorAll('button')].find((b) => b.textContent.includes('护栏：退款率'));
    (btn || li.querySelector('button'))?.click();
    return true;
  })()`);
  await sleep(2600);
});

// S5 计算过程 + 真值对照
await seg('s5_audit', async () => {
  await evaluate(`document.querySelector('[role=dialog] button[aria-label=关闭]')?.click()`);
  await sleep(700);
  await clickText('计算过程');
  await sleep(1500);
  await evaluate(`window.scrollTo({ top: 1250, behavior: 'smooth' })`);
  await sleep(1500);
  await clickText('真值对照');
  await sleep(1600);
});

// S6 Agent：问一句"为什么是这个结论"
await seg('s6_agent', async () => {
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(400);
  await clickText('问这个实验');
  await waitText('试试这样问');
  await sleep(500);
  await clickText('为什么是这个结论');
  await waitText('引擎按固定优先级');
  await sleep(1800);
});

// S7 评测看板
await seg('s7_eval', async () => {
  await evaluate(`document.querySelector('[role=dialog] button[aria-label=关闭]')?.click()`);
  await sleep(500);
  await evaluate(`location.hash = '#/eval'`);
  await waitText('混淆矩阵');
  await sleep(1200);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(3200);
});

// S8 收尾：回到列表
await seg('s8_close', async () => {
  await evaluate(`location.hash = '#/'`);
  await sleep(1400);
});

await send('Page.stopScreencast');
const total = Number(((Date.now() - t0) / 1000).toFixed(2));
const fps = frameNo / total;

// 相对首帧的时间戳，供合成脚本按真实时序重采样
const t00 = frames.length ? frames[0] : 0;
const rel = frames.map((t) => Number((t - t00).toFixed(4)));
const dense = rel.filter((v, i) => i > 0 && v - rel[i - 1] < 0.1).length;
writeFileSync(join(OUT, '..', 'frames.json'), JSON.stringify({ count: rel.length, timestamps: rel }));

writeFileSync(
  join(OUT, '..', 'marks.json'),
  JSON.stringify({ url: URL, width: W, height: H, everyNthFrame: EVERY, duration: total, frames: frameNo, fps: Number(fps.toFixed(2)), marks }, null, 2),
);
console.log(
  `
帧数 ${frameNo}｜时长 ${total}s｜平均 ${fps.toFixed(1)}fps｜其中连续段 ${dense} 帧｜时间线 deliverables/video/marks.json`,
);

ws.close();
edge.kill();
