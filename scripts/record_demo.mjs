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
// 必须与成片同比例：录 1440×900、出 1280×720 会把画面横向拉伸 11%（文字变胖），
// 所以这里录 16:9 的 1440×810，scale 就是干净的等比缩放。
const H = Number(process.env.H || 810);
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

// 强制持续合成的「心跳」：一个 2px 的透明方块做 1px 位移动画（肉眼不可见）。
// 不加它的话，headless 下画面静止时 screencast 不出帧——实测 31.6s 只拿到 121 帧，
// 中间有 5 秒空档，成片会变成幻灯片。
await evaluate(`(() => {
  const st = document.createElement('style');
  st.textContent = '@keyframes __recpulse{0%{transform:translateY(0)}100%{transform:translateY(1px)}}';
  document.head.appendChild(st);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;background:#fff;opacity:.02;' +
    'pointer-events:none;z-index:99999;animation:__recpulse .05s steps(2,end) infinite';
  document.body.appendChild(d);
  return true;
})()`);

// 强制持续合成的「心跳」：一个 2px 的透明方块做 1px 位移动画（肉眼不可见）。
// 不加它的话，headless 下画面静止时 screencast 不出帧——实测 31.6s 只拿到 121 帧，
// 中间有 5 秒空档，成片会变成幻灯片。
await evaluate(`(() => {
  const st = document.createElement('style');
  st.textContent = '@keyframes __recpulse{0%{transform:translateY(0)}100%{transform:translateY(1px)}}';
  document.head.appendChild(st);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;background:#fff;opacity:.02;' +
    'pointer-events:none;z-index:99999;animation:__recpulse .05s steps(2,end) infinite';
  document.body.appendChild(d);
  return true;
})()`);

t0 = Date.now();
await send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: EVERY });
console.log('开始录制…');

/** 把含有某段文字的元素滚到视野中间（面板标题比固定偏移可靠：改版后不会滚过头） */
const scrollToText = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('h2, div, section')].find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  })()`);

/** 改滑块的值（React 受控组件要走原生 setter + input 事件） */
const setSlider = (idx, value) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=range]')][${idx}];
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '${value}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

/** 把某个 tab 顶到视口上部：直接对齐按钮，而不是猜一个像素偏移（改版后仍然准） */
const scrollTabToTop = (label) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    window.scrollTo({ top: btn.getBoundingClientRect().top + window.scrollY - 96, behavior: 'smooth' });
    return true;
  })()`);

const key = (code, keyName) =>
  send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, code: keyName, key: keyName });

// S1 列表：滚动展示 120 个实验
await seg('s1_list', async () => {
  await sleep(1000);
  await evaluate(`window.scrollTo({ top: 260, behavior: 'smooth' })`);
  await sleep(1500);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`);
  await sleep(2400);
});

// S2 SRM 异常：先展示「会拒绝下结论」
await seg('s2_srm', async () => {
  await clickRow('E006');
  await waitText('SRM 分流异常');
  await sleep(2200);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(1700);
});

// S3 护栏拦截：主指标正向但退款率恶化
await seg('s3_guardrail', async () => {
  await clickText('返回实验列表');
  await sleep(1100);
  await clickRow('E001');
  await waitText('引擎结论');
  await sleep(4000);
});

// S4 证据链：展开护栏那一条，看逐步代入
await seg('s4_evidence', async () => {
  await clickText('证据链');
  await waitText('数据与口径');
  await sleep(600);
  await evaluate(`(() => {
    const li = [...document.querySelectorAll('[role=dialog] li')].find((n) => n.textContent.includes('护栏：退款率'));
    if (!li) return false;
    const btn = [...li.querySelectorAll('button')].find((b) => b.textContent.includes('护栏：退款率'));
    (btn || li.querySelector('button'))?.click();
    return true;
  })()`);
  await sleep(4600);
});

// S5 计算过程：公式与代入的数字摊开
await seg('s5_calc', async () => {
  await evaluate(`document.querySelector('[role=dialog] button[aria-label=关闭]')?.click()`);
  await sleep(500);
  await clickText('计算过程');
  await sleep(900);
  await scrollTabToTop('计算过程');
  await sleep(2800);
});

// S6 期望损失：把「显不显著」翻译成「值不值得上」，拖动 k 看曲线
await seg('s6_loss', async () => {
  await scrollToText('期望损失决策');
  await sleep(1400);
  await setSlider(0, 4);
  await sleep(1300);
  await setSlider(0, 2);
  await sleep(2600);
});

// S7 实验对比：两次实验共用一条横轴
await seg('s7_compare', async () => {
  await evaluate(`location.hash = '#/compare?a=E001&b=E002'`);
  await waitText('共用同一条横轴');
  // hash 跳转会保留上一页的滚动位置，这里必须回顶：观众要看到的是两张卡 + 共轴森林图
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(600);
  await sleep(5400);
});

// S8 ⌘K：键盘直达某个实验
await seg('s8_palette', async () => {
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await waitText('输入关键词开始搜索');
  await sleep(500);
  await send('Input.insertText', { text: 'E029' });
  await sleep(1200);
  await key(13, 'Enter');
  // 等详情页独有的文案：'ARPU' 在对比页也出现，会误判成「已经跳过去了」
  await waitText('引擎结论');
  await sleep(1900);
});

// S9 评测看板：准确率与失败案例都在
await seg('s9_eval', async () => {
  await evaluate(`location.hash = '#/eval'`);
  await waitText('混淆矩阵');
  await sleep(1000);
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(4100);
});

// S10 收尾：回到列表
await seg('s10_close', async () => {
  await evaluate(`location.hash = '#/'`);
  await sleep(1500);
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
