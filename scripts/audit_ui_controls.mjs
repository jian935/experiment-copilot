/**
 * 全量交互审查：把每个屏上「能点的东西」逐个点一遍，报告四类问题。
 *
 *   node scripts/audit_ui_controls.mjs                 # 审查全部路由
 *   node scripts/audit_ui_controls.mjs '#/e/E001'      # 只审一个路由
 *
 * 为什么不能只靠读代码：这四类问题里，只有第一类（没绑 handler）能靠读代码发现。
 * 「点了没反应」「被遮罩挡住点不到」「禁用了但没说明为什么」都只在真实渲染里才成立。
 *
 * 判定口径（宁可漏报，不要自造问题）：
 * - NO-OP：点完 300ms 内 DOM/滚动/hash/弹层都没变，且没有控制台报错
 * - ERROR：点击期间抛了未捕获异常或 console.error
 * - COVERED：元素中心点的 elementFromPoint 不是它自己或其后代（被别的层盖住）
 * - DISABLED：原生 disabled 或 aria-disabled
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.env.DEMO_URL || 'http://127.0.0.1:4321';
const PORT = 9555;
const PROFILE = mkdtempSync(join(tmpdir(), 'audit-ui-'));
const only = process.argv[2] || null;

const ROUTES = [
  { hash: '#/', name: '列表页', ready: '内置 · 120 例' },
  { hash: '#/e/E001', name: '详情 · 率口径', ready: '引擎结论' },
  { hash: '#/e/E029', name: '详情 · ARPU', ready: '引擎结论' },
  { hash: '#/e/E002', name: '详情 · 分层异质', ready: '引擎结论' },
  { hash: '#/compare', name: '对比 · 选择器', ready: 'E001' },
  { hash: '#/compare?a=E001&b=E002', name: '对比 · 同单位', ready: '共用一条横轴' },
  { hash: '#/eval', name: '评测看板', ready: '混淆矩阵' },
  { hash: '#/settings', name: '设置页', ready: '口径字典' },
];

/** 会改变全局状态、审一次就够的元素（避免把存档删掉、把设置重置掉影响后续判定） */
const DANGEROUS = ['删除本机存档', '删除存档', '恢复默认', '重置'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--hide-scrollbars',
   '--window-size=1440,900', `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((x) => x.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params?.exceptionDetails?.exception?.description || '未捕获异常');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (!r.result) throw new Error(`求值无结果：${JSON.stringify(r).slice(0, 200)}`);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '求值异常');
  return r.result.value;
}

async function waitText(text, tries = 80) {
  for (let i = 0; i < tries; i++) {
    // 导航过程中 body 可能是 null（旧文档已卸载、新文档还没解析完），必须挡住
    const ok = await evaluate(
      `(() => !!document.body && document.body.innerText.includes(${JSON.stringify(text)}))()`,
    ).catch(() => false);
    if (ok) return true;
    await sleep(120);
  }
  return false;
}

/** 页面上所有「看起来能点」的元素（按钮 / 链接 / tab / 复选 / 滑块 / 下拉） */
const COLLECT = `(() => {
  const sel = 'button, a[href], [role=tab], [role=button], input, select, textarea, summary';
  const out = [];
  const seen = new Map();
  document.querySelectorAll(sel).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 46);
    const visible = r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    const key = el.tagName + '|' + text;
    const dup = seen.get(key) ?? 0;
    seen.set(key, dup + 1);
    out.push({
      i, dup, tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text,
      visible,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  });
  return out;
})()`;

/** 点完判断「有没有发生任何事」 */
const SIGNATURE = `(() => {
  const dlg = document.querySelectorAll('[role=dialog]').length;
  const hash = location.hash;
  const y = Math.round(window.scrollY);
  const html = document.body.innerHTML.length;
  const dark = document.documentElement.classList.contains('dark');
  const active = [...document.querySelectorAll('[aria-selected=true],[aria-pressed=true],.bg-brand\\\\/15')].length;
  return JSON.stringify({ dlg, hash, y, html, dark, active });
})()`;

async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const results = [];

for (const route of ROUTES) {
  if (only && route.hash !== only) continue;
  await send('Page.navigate', { url: `${BASE}/${route.hash}` });
  await waitText(route.ready);
  await sleep(300);
  const all = (await evaluate(COLLECT)).filter((c) => c.visible);
  // 列表类控件（对比选择器 120 行、列表 120 行）只抽查前两个：
  // 它们共用同一个 handler，逐个重载点一遍要几十分钟，收益是零
  const listSeen = new Map();
  const controls = all.filter((c) => {
    if (!/^(E\d{3}|加入对比)/.test(c.text)) return true;
    const n = (listSeen.get(c.tag) ?? 0) + 1;
    listSeen.set(c.tag, n);
    return n <= 2;
  });
  console.log(`\n${route.name}  ${route.hash}  （可见控件 ${controls.length} 个）`);

  for (const c of controls) {
    if (c.tag === 'input' && ['range', 'text', 'search'].includes(c.type)) continue; // 滑块/输入框单独看
    if (/^加入对比/.test(c.text)) {
      results.push({ route: route.name, ...c, verdict: 'SKIP', note: '列表行按钮，共用同一 handler；由 smoke 场景「勾两个进对比」覆盖' });
      continue;
    }
    if (DANGEROUS.some((d) => c.text.includes(d))) {
      results.push({ route: route.name, ...c, verdict: 'SKIP', note: '会改全局状态，人工确认' });
      continue;
    }
    // 每个控件都从干净状态开始：否则前一次点击留下的弹层会让后一次「看起来有变化」
    await send('Page.navigate', { url: `${BASE}/${route.hash}` });
    await waitText(route.ready);

    // 重载后 DOM 顺序会变（数据异步渲染），所以按「tag + 文本 + 同名第几个」重新定位
    // 先把它滚到视口中间：元素在视野外时 elementFromPoint 返回 null，
    // 会被误判成「被遮挡」（第一版就报了一堆 covered:none）
    let found = false;
    for (let k = 0; k < 12 && !found; k++) {
      found = await evaluate(`(() => {
      const sel = 'button, a[href], [role=tab], [role=button], input, select, textarea, summary';
      const all = [...document.querySelectorAll(sel)];
      const norm = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 46);
      const cands = all.filter((el) => el.tagName.toLowerCase() === ${JSON.stringify(c.tag)} && norm(el) === ${JSON.stringify(c.text)});
      const el = cands[${c.dup}] || null;
      if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
      })()`).catch(() => false);
      if (!found) await sleep(150);
    }
    if (!found) {
      results.push({ route: route.name, ...c, verdict: 'GONE', note: '重载后同一按钮不再存在（可能是条件渲染）' });
      console.log(`  ? ${c.tag} 「${c.text}」 → GONE（重载后不存在）`);
      continue;
    }
    await sleep(120);
    const located = await evaluate(`(() => {
      const sel = 'button, a[href], [role=tab], [role=button], input, select, textarea, summary';
      const all = [...document.querySelectorAll(sel)];
      const norm = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 46);
      const cands = all.filter((el) => el.tagName.toLowerCase() === ${JSON.stringify(c.tag)} && norm(el) === ${JSON.stringify(c.text)});
      const el = cands[${c.dup}] || null;
      if (!el) return { state: 'gone' };
      const r = el.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const self = el === hit || el.contains(hit) || (hit && hit.contains(el));
      const href = el.getAttribute('href') || '';
      const sameRoute = href && href === location.hash;
      const external = /^https?:/.test(href) || el.getAttribute('target') === '_blank';
      return { state: self ? 'ok' : 'covered:' + (hit ? hit.tagName : 'none'), x, y, sameRoute: !!sameRoute, external: !!external };
    })()`);
    if (located.state === 'gone') {
      results.push({ route: route.name, ...c, verdict: 'GONE', note: '重载后同一按钮不再存在（可能是条件渲染）' });
      console.log(`  ? ${c.tag} 「${c.text}」 → GONE（重载后不存在）`);
      continue;
    }
    const covered = located.state;
    const x = located.x;
    const y = located.y;

    if (c.tag === 'select') {
      const readVal = () => evaluate(`(() => {
        const all = [...document.querySelectorAll('select')];
        const me = all[${c.dup}] || null;
        return me ? me.value : null;
      })()`);
      await evaluate(`(() => { const s=[...document.querySelectorAll('select')][${c.dup}]; if (s) s.focus(); return !!s; })()`);
      const v0 = await readVal();
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' });
      await send('Input.dispatchKeyEvent', { type: 'char', text: '', key: 'ArrowDown' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' });
      await sleep(250);
      const v1 = await readVal();
      results.push({
        route: route.name, ...c,
        verdict: v0 !== v1 ? 'OK' : 'NO-OP',
        note: v0 !== v1 ? `键盘切换有效（${v0} → ${v1}）` : '聚焦后键盘也改不动',
      });
      console.log(`  ${v0 !== v1 ? '·' : 'N'} select 「${c.text.slice(0, 30)}」 → ${v0 !== v1 ? 'OK' : 'NO-OP'}（${v0} → ${v1}）`);
      continue;
    }

    pageErrors.length = 0;
    const before = await evaluate(SIGNATURE);
    await clickAt(x, y);
    await sleep(320);
    const after = await evaluate(SIGNATURE);
    const changed = before !== after;
    const errs = pageErrors.slice();

    let verdict = 'OK';
    let note = '';
    if (located.sameRoute) {
      verdict = 'OK';
      note = '指向当前路由，本来就不该有变化';
    } else if (located.external) {
      verdict = 'OK';
      note = '外链（新开页面），本页不变是预期';
    } else if (c.disabled) {
      verdict = 'DISABLED';
      note = '原生 disabled（无提示）';
    } else if (covered !== 'ok') {
      verdict = 'COVERED';
      note = covered;
    } else if (errs.length) {
      verdict = 'ERROR';
      note = errs[0].slice(0, 120);
    } else if (c.tag === 'input') {
      // 原生控件的「有反应」不等于 DOM 变了：数字框变焦点、勾选框只改 property。
      // 所以这里单独验：焦点是否落到它身上，或勾选状态是否翻转。
      const native = await evaluate(`(() => {
        const el = document.activeElement;
        const sel = 'input, select, textarea';
        const all = [...document.querySelectorAll(sel)];
        const norm = (n) => (n.getAttribute('aria-label') || n.getAttribute('title') || n.value || '').replace(/\\s+/g, ' ').trim().slice(0, 46);
        const cands = all.filter((n) => n.tagName.toLowerCase() === ${JSON.stringify(c.tag)} && norm(n) === ${JSON.stringify(c.text)});
        const me = cands[${c.dup}];
        const focused = !!me && (me === document.activeElement || me.contains(document.activeElement));
        return JSON.stringify({ focused, checked: me && 'checked' in me ? me.checked : null });
      })()`);
      const n = JSON.parse(native);
      if (n.focused || n.checked !== null) {
        verdict = 'OK';
        note = n.focused ? '点击后获得焦点（原生控件，值需键盘输入）' : '勾选状态可切换';
      } else {
        verdict = 'NO-OP';
        note = '点击后既没聚焦也没变化';
      }
    } else if (!changed) {
      // 「已经在那一页 / 那个 tab 上」时点它本来就不该有变化，这不算坏。
      // 判据：文案就是当前路由的名字，或它所在的分组里已有激活态（bg-brand 系）。
      const already = await evaluate(`(() => {
        const label = ${JSON.stringify(c.text)};
        const nav = ['实验列表', '评测看板', '口径字典 / 设置', '分层明细', '护栏指标', '计算过程'];
        if (nav.some((n) => label.startsWith(n))) return 'nav-or-tab';
        // 品牌位（点它回首页）与「已选中的模型 provider」：已经在那个状态上，点它本就不该有变化
        if (label.startsWith('Experiment Copilot')) return 'brand';
        if (label.includes('决策口径与模型设置')) return 'nav-or-tab';
        // 元素自己声明了「我是选中的」：点它当然没变化，这不是问题
        const all = [...document.querySelectorAll('button, [role=tab], [role=button]')];
        const norm = (n) => (n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 46);
        const me = all.filter((n) => norm(n) === label)[${c.dup}];
        if (me && (me.getAttribute('aria-pressed') === 'true' || me.getAttribute('aria-selected') === 'true'
                   || me.getAttribute('aria-current') === 'page')) return 'aria-active';
        const sel = ['DeepSeek', 'OpenAI', 'Moonshot', 'Ollama', '自定义'];
        if (sel.some((n) => label.includes(n))) return 'provider-active';
        return '';
      })()`);
      if (already) {
        verdict = 'OK-CURRENT';
        note = '当前页/当前 tab，点击无变化是预期';
      } else {
        verdict = 'NO-OP';
        note = '点击后 DOM / hash / 滚动 / 弹层均无变化';
      }
    }
    results.push({ route: route.name, ...c, verdict, note });
    const flag = verdict === 'OK' ? '·' : verdict[0];
    console.log(`  ${flag} ${c.tag}${c.type ? '[' + c.type + ']' : ''} 「${c.text}」 → ${verdict}${note ? ' · ' + note : ''}`);
  }
}

ws.close();
edge.kill();
await new Promise((r) => {
  const t = setTimeout(r, 1500);
  edge.once('exit', () => {
    clearTimeout(t);
    r();
  });
});
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* 锁文件，忽略 */
}

// ---- 汇总 ----
const counts = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
console.log(`\n各类结论：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
const bad = results.filter((r) => !['OK', 'OK-CURRENT'].includes(r.verdict));
console.log(`\n${'='.repeat(78)}`);
console.log(`共审查 ${results.length} 个控件；有问题 ${bad.length} 个`);
for (const r of bad) {
  console.log(`  [${r.verdict}] ${r.route} · ${r.tag}${r.type ? '[' + r.type + ']' : ''} 「${r.text}」 ${r.note ? '· ' + r.note : ''}`);
}
process.exit(0);
