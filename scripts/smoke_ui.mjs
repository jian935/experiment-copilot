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
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = (process.env.BASE || 'http://127.0.0.1:4321/').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT || 9433);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次跑用一个全新的浏览器 profile。
// 为什么必须：这一版开始脚本要写/读 IndexedDB（导入持久化），
// 复用默认 profile 会让上一次运行的存档漏进这一次，测试就变成"看运气"。
const PROFILE = join(tmpdir(), `expcopilot-smoke-${process.pid}`);

// 每条路由都要覆盖到不同的代码路径：列表（混排两种口径）、
// 率口径详情、连续口径详情（ARPU 面板 + 因子分解）、异质、护栏拦截、评测、设置
const ROUTES = [
  { hash: '#/', name: '实验列表（120 个，两种口径混排）', must: ['决策', '实验', '全局校正'] },
  { hash: '#/e/E001', name: '详情 · 率口径 + 护栏拦截', must: ['退款率', '转化率', '序贯监控', '新颖效应', '期望损失决策'] },
  { hash: '#/e/E029', name: '详情 · 连续口径（ARPU + 因子分解）', must: ['ARPU', '因子分解', '客单价', '序贯监控', '新颖效应', '期望损失决策'] },
  { hash: '#/e/E002', name: '详情 · 分层异质', must: ['分层'] },
  { hash: '#/compare', name: '对比 · 选择器', must: ['选择要对比的实验'] },
  { hash: '#/compare?a=E001&b=E002', name: '对比 · 同单位（共用一条横轴）', must: ['实验对比', '逐项对照', '共用同一条横轴'] },
  { hash: '#/compare?a=E001&b=E029', name: '对比 · 单位不同（必须拒绝同轴）', must: ['实验对比', '逐项对照', '不能画在同一条轴上'] },
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
    `--user-data-dir=${PROFILE}`,
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
  // 求值失败（语法错误 / 抛异常）时 CDP 只回 exceptionDetails、没有 result。
  // 以前这里静默返回 undefined，于是「表达式报错」和「页面没渲染」在调用侧长得一模一样
  // ——排查时只能靠猜。这里直接抛，顺带把页面里的第一行错误带出来。
  if (!r.result) {
    throw new Error(
      `Runtime.evaluate 没有返回值（表达式大概率写错了）：${JSON.stringify(r.exceptionDetails ?? r).slice(0, 220)}`,
    );
  }
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
      problems.push(`正文出现「${bad}」：…${text.slice(Math.max(0, at - 40), at + 20).replace(/\\n/g, ' ')}…`);
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

/* ─────────── 第二阶段：导入持久化往返（C3） ───────────
 * 这一段的判据只有一条，但它是 C3 的全部意义：**导入后刷新，数据还在**。
 * 做法是真的走 UI：点「导入数据」→ 往 textarea 里填一份 1 个实验的数据 →
 * 点「载入并分析」→ 等芯片变成「导入 · 1 例」→ 硬刷新 → 再验一遍。
 * 顺带验「切回内置」可用，且切回后存档入口不该被禁用（否则就切不回来了）。
 */
async function waitText(pred, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(120);
    const t = (await evaluate('document.querySelector("#root")?.innerText ?? ""')) || '';
    if (pred(t)) return t;
  }
  throw new Error(`等待超时：${label}`);
}

/** 点一个「文字包含」的按钮（对话框与芯片都走真实点击，不调内部 API） */
async function clickText(selector, text) {
  const ok = await evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => (e.innerText || '').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`点不到「${text}」`);
}

async function runPersistScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitText((t) => t.includes('内置'), '列表页加载');

    await clickText('button', '导入数据');
    await waitText((t) => t.includes('载入并分析'), '导入对话框打开');

    // 造一份「1 个实验」的合法数据：从内置数据里切一个出来，schema 必然正确
    const filled = await evaluate(`(async () => {
      const ds = await (await fetch('data/dataset.json')).json();
      const e = ds.experiments[0];
      const mini = { ...ds, experiments: [e], daily: ds.daily.filter((r) => r.expId === e.id) };
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, JSON.stringify(mini));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return e.id;
    })()`);
    if (!filled || filled === 'no-textarea') throw new Error('找不到 textarea');

    await clickText('button', '载入并分析');
    // 导入改成了两步：先给预检（列识别/丢弃行/推断），用户确认后才落库。
    // 冒烟必须走完这两步，否则测的是「预检面板能不能显示」，而不是「数据进没进来」。
    await waitText((t) => t.includes('进来的实验'), '预检面板');
    await clickText('button', '确认导入');
    await waitText((t) => t.includes('导入 · 1 例'), '导入后芯片切换');
    await sleep(1300); // 等 dialog 自动关闭（存成功时 900ms 后关）

    // 关键一步：硬刷新。这一行就是 C3 的验收条件。
    await send('Page.reload', { ignoreCache: true });
    const after = await waitText((t) => t.includes('导入 · 1 例'), '刷新后仍在');
    if (!after.includes(filled)) problems.push(`刷新后看不到导入的实验 ${filled}`);
    if (after.includes('内置 · 120 例')) problems.push('刷新后芯片退回了内置数据源');

    // 切回内置：导入的存档不能因此被删掉（还能切回来）
    await clickText('button', '导入 ·');
    await sleep(250);
    await clickText('button', '内置合成数据');
    await waitText((t) => t.includes('内置 · 120 例'), '切回内置');
    await clickText('button', '内置 ·');
    await sleep(250);
    const canSwitchBack = await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find((e) => (e.innerText || '').includes('导入：'));
      return !!el && !el.disabled;
    })()`);
    if (!canSwitchBack) problems.push('切回内置后，存档入口被禁用了（应该还能切回导入的数据）');
  } catch (e) {
    problems.push(String(e && e.message ? e.message : e));
  }
  return problems;
}

/* ─────────── 第七阶段：导入的数据缺列时，护栏必须说「不可用」 ───────────
 * 这一条防的不是崩溃，是**编数**：refunds 缺失会被归一化成 0，
 * 于是表格写成「0.00% → 0.00%，未恶化」，读起来像「查过了，没问题」。
 * 所以这里验的是文案：出现「不可用（缺列）」、且没有冒充的 0.00%。
 */
async function runMissingColumnScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitText((t) => t.includes('实验列表'), '列表页加载');

    await clickText('button', '导入数据');
    await waitText((t) => t.includes('载入并分析'), '导入对话框打开');

    const expId = await evaluate(`(async () => {
      const ds = await (await fetch('data/dataset.json')).json();
      const e = ds.experiments[0];
      const daily = ds.daily
        .filter((r) => r.expId === e.id)
        .map((r) => {
          const { refunds, complaints, latencyP95, ...rest } = r;
          return rest; // 三列护栏全缺
        });
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, JSON.stringify({ ...ds, experiments: [e], daily }));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return e.id;
    })()`);
    if (!expId || expId === 'no-textarea') throw new Error('找不到 textarea');

    await clickText('button', '载入并分析');
    await waitText((t) => t.includes('进来的实验'), '预检面板');
    await clickText('button', '确认导入');
    await waitText((t) => t.includes('导入 · 1 例'), '缺列数据导入完成');
    await sleep(1300);

    await send('Page.navigate', { url: `${BASE}/#/e/${expId}` });
    await waitText((t) => t.includes('证据链'), '详情页加载');
    await clickText('button', '护栏指标');
    await sleep(300);

    const text = await evaluate('document.body.innerText');
    if (!text.includes('不可用（缺列）')) problems.push('缺 refunds 列时护栏没标「不可用（缺列）」');
    if (!text.includes('未评估')) problems.push('缺列时没有出现「未评估」字样');
    // 三检查里那一格必须是「不适用」，不是「通过」
    if (!text.includes('不适用')) problems.push('硬护栏未评估时，三检查没有显示「不适用」');
    // 「不适用」与「硬护栏未触发」同时出现是自相矛盾的（一个是没查、一个是查了没问题）
    if (text.includes('不适用') && text.includes('硬护栏未触发')) problems.push('三检查同时写了「不适用」和「硬护栏未触发」');
    // 不能出现冒充的 0.00%（表格里应全是「—」）
    const fake = /退款率[\s\S]{0,40}0\.00%/.test(text);
    if (fake) problems.push('缺列时护栏仍显示了 0.00%（把「没数据」当成了「是 0」）');

    // 收尾：切回内置，别把后面的场景（与人工看页面）留在导入态
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitText((t) => t.includes('导入 · 1 例'), '回到列表页');
    await clickText('button', '导入 ·');
    await sleep(250);
    await clickText('button', '内置合成数据');
    await waitText((t) => t.includes('内置 · 120 例'), '切回内置');
  } catch (e) {
    problems.push(String(e && e.message ? e.message : e));
  }
  return problems;
}

/* ─────────── 第三阶段：从列表页勾两个进对比（F3 入口） ───────────
 * 对比页能按 URL 打开不代表用户找得到它。这一步只验一件事：
 * **在列表里勾两个、点一下，就能到共用横轴的对比页**。
 */
async function runCompareScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitText((t) => t.includes('实验列表'), '列表页加载');

    for (const id of ['E001', 'E002']) {
      const ok = await evaluate(`(() => {
        const el = document.querySelector('[aria-label="加入对比 ${id}"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`列表里找不到「加入对比 ${id}」的勾选框`);
      await sleep(150);
    }

    const picked = await waitText((t) => t.includes('已选 2 个'), '选择条出现');
    if (!picked.includes('对比这两个')) problems.push('勾满两个后没出现「对比这两个」按钮');

    await clickText('button', '对比这两个');
    const cmp = await waitText((t) => t.includes('实验对比'), '进入对比页');
    if (!cmp.includes('逐项对照')) problems.push('对比页缺少逐项对照表');
    // E001/E002 同为 pp 口径，必须共用一条横轴
    if (!cmp.includes('共用同一条横轴')) problems.push('同单位的两次实验没有共用横轴');
    const hash = await evaluate('location.hash');
    if (!/^#\/compare\?a=E00[12]&b=E00[12]$/.test(hash)) problems.push(`对比页地址不对：${hash}`);
  } catch (e) {
    problems.push(String(e && e.message ? e.message : e));
  }
  return problems;
}

/* ─────────── 第四阶段：⌘K 全局搜索（F4） ───────────
 * URL 能进的页面不代表找得到这一段验证三件事：
 * ① Ctrl+K 能唤出面板；② 输入后有命中，且编号精确匹配排第一；
 * ③ **回车直达**——键盘走完全程，而不是只能鼠标点。
 */
async function runPaletteScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitText((t) => t.includes('实验列表'), '列表页加载');

    const opened = await evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      return true;
    })()`);
    if (!opened) throw new Error('派发 Ctrl+K 失败');
    await waitText((t) => t.includes('输入关键词开始搜索'), '面板打开', 40);

    await send('Input.insertText', { text: 'E001' });
    await sleep(250);
    const hits = await waitText((t) => t.includes('结算页改版'), '搜到 E001', 40);
    if (!hits.includes('支付转化率')) problems.push('命中项缺少副标题（主指标）');

    // 居首断言：第一条必须就是 E001，而不是某个正文里含 e001 的实验
    const first = await evaluate(`(() => {
      const el = document.querySelector('[data-idx="0"]');
      return el ? el.innerText.replace(/\\n/g, ' ') : 'NO_ROW';
    })()`);
    if (!first.includes('E001')) problems.push(`编号精确搜索时第一条不是 E001：${first.slice(0, 40)}`);

    // 键盘走完全程：↓ 一次再 ↑ 回来，然后回车
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' });
    await sleep(120);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' });
    await sleep(120);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
    await sleep(400);
    const hash = await evaluate('location.hash');
    if (!hash.startsWith('#/e/E001')) problems.push(`回车没有直达 E001 详情：${hash}`);

    // 上一步回车已经跳到详情页，面板随之关闭 —— 重新唤开
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await waitText((t) => t.includes('输入关键词开始搜索'), '第二次打开面板', 40);

    // 面板里写着「试：护栏（按规则名找）」——这是**对外承诺**，必须真的能搜到
    const guardRows = await evaluate(`(() => {
      const el = document.querySelector('input[placeholder^="搜实验"]');
      if (!el) return 'no-input';
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '护栏');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    if (guardRows !== 'ok') throw new Error(`重设输入框失败：${guardRows}`);
    await sleep(350);
    const nGuard = await evaluate(`document.querySelectorAll('[data-idx]').length`);
    if (!(nGuard > 0)) problems.push('搜「护栏」没有结果：面板空状态里承诺过可以这样找');
    const guardFirst = await evaluate(`(() => { const el = document.querySelector('[data-idx="0"]'); return el ? el.innerText.replace(/\\n/g, ' ') : ''; })()`);
    if (!guardFirst.includes('E001')) problems.push(`搜「护栏」的第一条不是被护栏拦住的 E001：${guardFirst.slice(0, 40)}`);

    // Esc 能关
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await sleep(200);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
    await sleep(250);
    const closed = await evaluate(`!!document.querySelector('[data-idx="0"]')`);
    if (closed) problems.push('Esc 没有关闭面板');
  } catch (e) {
    problems.push(`${e && e.message ? e.message : e} @ ${String(e && e.stack ? e.stack : '').split('\n')[1] ?? ''}`);
  }
  return problems;
}

/* ─────────── 第五阶段：主题切换（F5） ───────────
 * 「切了主题」肉眼很好骗（换个按钮图标也算切了），所以这里验的是**真正被画出来的东西**：
 * body 背景变了、**森林图 CI 线的颜色也变了**（证明 var() 真的作用到了 SVG 表现属性）、刷新后不回退。
 * 只验 <html> 上有没有 dark 类是不够的——那正是「只改了卡片没改图表」会漏掉的检查。
 */
const PROBE = `(() => {
  const line = document.querySelector('svg line[stroke-width="2.4"]');
  return JSON.stringify({
    dark: document.documentElement.classList.contains('dark'),
    body: getComputedStyle(document.body).backgroundColor,
    ci: line ? getComputedStyle(line).stroke : 'no-line',
    stored: (() => { try { return localStorage.getItem('ec_theme_v1'); } catch { return 'denied'; } })(),
  });
})()`;

async function clickThemeBtn() {
  const ok = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.title || '').includes('主题') || (b.title || '').includes('跟随系统'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!ok) throw new Error('顶栏找不到主题切换按钮');
}

async function runThemeScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/compare?a=E001&b=E002` });
    await waitText((t) => t.includes('共用同一条横轴'), '对比页加载');
    const a = JSON.parse(await evaluate(PROBE));
    if (a.dark) problems.push('默认就带 dark 类：默认值应当是「跟随系统」，不是写死深色');

    await clickThemeBtn();
    await sleep(400);
    const b = JSON.parse(await evaluate(PROBE));
    if (!b.dark) problems.push('点一次没有切到深色');
    if (b.body === a.body) problems.push(`切主题后 body 背景没变（还是 ${a.body}）：CSS 变量没生效`);
    if (b.ci === a.ci) problems.push(`切主题后森林图 CI 线颜色没变（还是 ${a.ci}）：SVG 没跟着主题走`);
    if (b.stored !== 'dark') problems.push(`主题没有落盘（localStorage=${b.stored}）`);

    // 硬刷新：主题选择要留着（存的是「选择」，不是算出来的结果，所以刷新不会跳回）
    await send('Page.reload', { ignoreCache: true });
    await waitText((t) => t.includes('共用同一条横轴'), '刷新后对比页', 60);
    const c = JSON.parse(await evaluate(PROBE));
    if (!c.dark) problems.push('刷新后主题退回浅色（选择没被记住）');

    await clickThemeBtn();
    await sleep(400);
    const d = JSON.parse(await evaluate(PROBE));
    if (d.dark) problems.push('再点一次没有切回浅色');
    if (d.body !== a.body) problems.push(`切回浅色后背景与初始不一致：${d.body} vs ${a.body}`);
  } catch (e) {
    problems.push(String(e && e.message ? e.message : e));
  }
  return problems;
}

/* ─────────── 第六阶段：趋势图（F9 去 Recharts） ───────────
 * 换掉图表库最大的风险不是体积，是**交互悄悄没了**：折线还在，但悬停取不到点、
 * 纵轴刻度没了——静态截图看不出来，只有真的把鼠标移上去才知道。
 * 所以这里用 CDP 真发一次 mousemove。
 */
async function runTrendScenario() {
  const problems = [];
  try {
    await send('Page.navigate', { url: `${BASE}/#/e/E001` });
    await waitText((t) => t.includes('分日趋势'), '详情页加载');

    // 先滚到视野里：趋势图在详情页偏下，视口外的坐标发鼠标事件等于没发
    await evaluate(`document.querySelector('svg[aria-label^="分日趋势"]')?.scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const box = await evaluate(`(() => {
      const r = document.querySelector('svg[aria-label^="分日趋势"] rect');
      if (!r) return 'no-rect';
      const b = r.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    })()`);
    if (box === 'no-rect') throw new Error('趋势图里找不到取点矩形');
    const { x, y } = JSON.parse(box);

    const ticks = await evaluate(`document.querySelectorAll('svg[aria-label^="分日趋势"] text').length`);
    if (!(ticks >= 4)) problems.push(`趋势图刻度文字只有 ${ticks} 个（纵轴 + 日期至少该有 4 个）`);
    const paths = await evaluate(`document.querySelectorAll('svg[aria-label^="分日趋势"] path').length`);
    if (paths !== 2) problems.push(`趋势图折线数是 ${paths}（应当是 control + treatment 两条）`);

    // 必须带 button:'none'，且发两次：只发一次时 Chrome 可能不产生 mousemove
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, button: 'none' });
    await sleep(150);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 4, y, buttons: 0, button: 'none' });
    await sleep(300);
    // 直接按提示框自己的类名找：祖先 div 的 innerText 里也有这两个词，find() 会先撞上祖先
    const tip = await evaluate(`(() => {
      const el = [...document.querySelectorAll('div.pointer-events-none.absolute')].find(
        (d) => (d.innerText || '').includes('control') && (d.innerText || '').includes('treatment'),
      );
      return el ? el.innerText.replace(String.fromCharCode(10), ' | ') : '';
    })()`);
    // 十字准星出现 = React 的 hover state 真的更新了（比找提示框更直接，失败时也更好定位）
    const cross = await evaluate(`document.querySelectorAll('svg[aria-label^="分日趋势"] line[stroke-dasharray="3 3"]').length`);
    if (!tip) problems.push(`没有出现提示框（坐标 ${x},${y}；准星 ${cross} 条）`);
    else if (!/n = /.test(tip)) problems.push('悬停提示里没有当日样本量 n');
  } catch (e) {
    problems.push(String(e && e.message ? e.message : e));
  }
  return problems;
}

console.log(`\nUI 冒烟：${ROUTES.length} 条路由 @ ${BASE}\n${'─'.repeat(70)}`);
for (const r of rows) {
  const mark = r.problems.length ? '✗' : '✓';
  console.log(`${mark} ${r.route.name.padEnd(30)} 正文 ${String(r.len).padStart(5)} 字`);
  for (const p of r.problems) console.log(`    · ${p}`);
}
console.log('');

const persistProblems = await runPersistScenario();
console.log(`\n导入持久化（C3）：导入 → 硬刷新 → 切回内置 → 切回导入`);
console.log('─'.repeat(70));
if (persistProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of persistProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（刷新后数据仍在，两种数据源可来回切）');
}
console.log('');

const missingProblems = await runMissingColumnScenario();
console.log(`\n缺列数据（护栏）：导入没有 refunds 列的数据 → 护栏标「不可用」而不是 0.00%`);
console.log('─'.repeat(70));
if (missingProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of missingProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（护栏写「不可用（缺列）」，三检查写「不适用」，没有冒充的 0.00%）');
}
console.log('');

const compareProblems = await runCompareScenario();
console.log(`\n对比入口（F3）：列表勾两个 → 对比这两个 → 共用横轴`);
console.log('─'.repeat(70));
if (compareProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of compareProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（选择条出现、跳转到 #/compare、同单位共用横轴）');
}
console.log('');

const paletteProblems = await runPaletteScenario();
console.log(`\n⌘K 全局搜索（F4）：Ctrl+K → 输入 E001 → ↑↓ → 回车直达 → Esc 关闭`);
console.log('─'.repeat(70));
if (paletteProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of paletteProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（键盘可用、编号精确匹配排第一、回车直达详情）');
}
console.log('');

const themeProblems = await runThemeScenario();
console.log(`\n主题切换（F5）：深色 ↔ 浅色（body 背景 + SVG 配色 + 刷新后不回退）`);
console.log('─'.repeat(70));
if (themeProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of themeProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（背景与图表配色都跟着变，且刷新后保留选择）');
}
console.log('');

const trendProblems = await runTrendScenario();
console.log(`\n趋势图（F9 去 Recharts）：悬停取点 + 纵轴刻度 + 两条线`);
console.log('─'.repeat(70));
if (trendProblems.length) {
  failed++;
  console.log('✗ 失败');
  for (const p of trendProblems) console.log(`    · ${p}`);
} else {
  console.log('✓ 通过（手写 SVG 有纵轴刻度、两条线，悬停能取到那一天的 control/treatment）');
}
console.log('');

ws.close();
edge.kill();
// 等浏览器真的退出再删 profile：kill 是异步的，立刻删会 EBUSY（临时目录删不掉不影响结论，别让清理反过来弄崩测试）
await new Promise((resolve) => {
  const t = setTimeout(resolve, 2000);
  edge.once('exit', () => {
    clearTimeout(t);
    resolve();
  });
});
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* 留给系统清理 */
}
process.exit(failed ? 1 : 0);
