/**
 * 可选后端：鉴权 / RBAC / 审批 / 审计 / API / 定时告警。
 *
 * 零依赖（只用 `node:http` + `node:crypto` + `node:fs`），因为它必须**能起来**：
 * 一个装不上、编不过的后端等于没有后端。业务逻辑全在 `core.ts`（纯函数、有单测），
 * 这一层只做 HTTP 的事：解析、鉴权、限流、写审计、返错。
 *
 * 跑：
 *   npm run server                 # http://127.0.0.1:8787
 *   EC_PORT=9000 EC_DATA_DIR=/tmp/ec npm run server
 *
 * 前端：同源部署时直接 fetch('/v1/...')；`vite dev` 下由 vite 代理 /v1。
 * 没有后端时前端自动退回本地模式（权限/审批/审计这些入口根本不出现）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  actionsOf, alertId, appendAudit, can, checkPassword, dataDir, diffScan, hashPassword,
  newToken, readAudit, readJson, sha256, verifyPassword, writeJson,
  type Action, type Alert, type ApiToken, type AuditEntry, type DatasetRecord,
  type DecisionRecordSrv, type Role, type ScanPoint, type Session, type User,
} from './core.ts';
import { analyze } from '../src/lib/decide.ts';
import type { DailyRow, Dataset } from '../src/lib/types.ts';

const PORT = Number(process.env.EC_PORT || 8787);
const DIR = dataDir();
const F = {
  users: join(DIR, 'users.json'),
  sessions: join(DIR, 'sessions.json'),
  tokens: join(DIR, 'tokens.json'),
  datasets: join(DIR, 'datasets.json'),
  decisions: join(DIR, 'decisions.json'),
  alerts: join(DIR, 'alerts.json'),
  audit: join(DIR, 'audit.jsonl'),
  metricDict: join(DIR, 'metric-dict.json'),
};

const SESSION_DAYS = 7;
const MAX_BODY = 48 * 1024 * 1024; // 48MB：内置数据集约 3MB，用户上传的通常更小，留足余量

/* ============================ 存储访问 ============================ */

const users = () => readJson<User[]>(F.users, []);
const saveUsers = (v: User[]) => writeJson(F.users, v);
const sessions = () => readJson<Session[]>(F.sessions, []);
const saveSessions = (v: Session[]) => writeJson(F.sessions, v);
const tokens = () => readJson<ApiToken[]>(F.tokens, []);
const saveTokens = (v: ApiToken[]) => writeJson(F.tokens, v);
const datasets = () => readJson<DatasetRecord[]>(F.datasets, []);
const saveDatasets = (v: DatasetRecord[]) => writeJson(F.datasets, v);
const decisions = () => readJson<DecisionRecordSrv[]>(F.decisions, []);
const saveDecisions = (v: DecisionRecordSrv[]) => writeJson(F.decisions, v);
const alerts = () => readJson<Alert[]>(F.alerts, []);
const saveAlerts = (v: Alert[]) => writeJson(F.alerts, v);

/* ============================ HTTP 小工具 ============================ */

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  body: unknown;
  /** 已登录用户（cookie 或 token 解析出来） */
  me?: { id: string; email: string; name: string; role: Role };
  /** 若用 API token 认证，记下 token 本身（审计里写 token 名而不是用户名） */
  viaToken?: ApiToken;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const body = Buffer.from(`${JSON.stringify(data)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, `请求体超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB`);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function audit(c: Ctx, action: string, target: string, detail?: string) {
  const entry: AuditEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: c.me?.email ?? c.viaToken?.name ?? 'anonymous',
    actorRole: c.viaToken ? 'token' : (c.me?.role ?? 'viewer'),
    action,
    target,
    ...(detail ? { detail } : {}),
    ip: c.ip,
  };
  appendAudit(F.audit, entry);
}

function requireAction(c: Ctx, action: Action) {
  if (!c.me) throw new HttpError(401, '未登录（本地模式请直接在浏览器里用，不需要后端）');
  if (!can(c.me.role, action)) {
    throw new HttpError(403, `当前角色「${c.me.role}」没有 ${action} 权限（需要更高的角色，可由管理员在用户管理里调整）`);
  }
}

/** 会话与 token 的统一认证 */
function authenticate(req: IncomingMessage): { me?: Ctx['me']; viaToken?: ApiToken } {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    const h = sha256(bearer);
    const t = tokens().find((x) => x.hash === h && !x.revokedAt);
    if (t) {
      const all = tokens();
      const i = all.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        all[i] = { ...all[i], lastUsedAt: new Date().toISOString() };
        saveTokens(all);
      }
      // API token 以「它被授予的角色」为准，而不是创建者的当前角色
      return {
        me: { id: `token:${t.id}`, email: `${t.name} (API Token)`, name: t.name, role: t.role },
        viaToken: t,
      };
    }
  }
  const sid = parseCookies(req)['ec_session'];
  if (!sid) return {};
  const now = Date.now();
  const s = sessions().find((x) => x.id === sha256(sid));
  if (!s) return {};
  if (Date.parse(s.expiresAt) < now) return {};
  const u = users().find((x) => x.id === s.userId && !x.disabled);
  if (!u) return {};
  return { me: { id: u.id, email: u.email, name: u.name, role: u.role } };
}

function setSessionCookie(res: ServerResponse, sid: string) {
  const maxAge = SESSION_DAYS * 86400;
  res.setHeader(
    'set-cookie',
    `ec_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.EC_INSECURE === '1' ? '' : ''}`,
  );
}

function clearSessionCookie(res: ServerResponse) {
  res.setHeader('set-cookie', 'ec_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ============================ 分析：跑一次引擎 ============================ */

function analysesOf(ds: Dataset) {
  const rowsByExp = new Map<string, DailyRow[]>();
  for (const r of ds.daily) {
    const list = rowsByExp.get(r.expId);
    if (list) list.push(r);
    else rowsByExp.set(r.expId, [r]);
  }
  return { rowsByExp };
}

function scanDataset(rec: DatasetRecord): Record<string, ScanPoint> {
  const ds = rec.dataset as Dataset;
  const { rowsByExp } = analysesOf(ds);
  const out: Record<string, ScanPoint> = {};
  for (const e of ds.experiments) {
    const a = analyze(e, rowsByExp.get(e.id) ?? []);
    out[e.id] = {
      decision: a.decision,
      p: a.primary.p,
      diff: a.primary.diff,
      reasonCode: a.reasonCode,
      srmFlagged: a.srm.flagged,
      worseGuardrail: a.guardrails.find((g) => g.gating && g.worse)?.label ?? null,
    };
  }
  return out;
}

/* ============================ 路由 ============================ */

type Handler = (c: Ctx, params: Record<string, string>) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  /** 无需登录（health / 登录 / 注册） */
  open?: boolean;
}

const routes: Route[] = [];
const on = (method: string, path: string, handler: Handler, open = false) => {
  routes.push({ method, parts: path.split('/').filter(Boolean), handler, ...(open ? { open } : {}) });
};

/* ---- health：前端靠它判断「有没有后端」。必须 public ---- */
on('GET', '/v1/health', () => ({
  ok: true,
  mode: 'cloud',
  /** 有没有初始化过管理员（前端据此显示「注册第一个管理员」还是「登录」） */
  initialized: users().length > 0,
  users: users().length,
  datasets: datasets().length,
  version: 1,
}), true);

/* ---- 注册：只允许第一个用户自注册（成为 admin），之后由管理员建号 ---- */
on('POST', '/v1/auth/register', (c) => {
  const b = (c.body ?? {}) as { email?: string; name?: string; password?: string };
  const email = String(b.email ?? '').trim().toLowerCase();
  const name = String(b.name ?? '').trim();
  const password = String(b.password ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, '邮箱格式不对');
  const pwErr = checkPassword(password);
  if (pwErr) throw new HttpError(400, pwErr);
  const all = users();
  if (all.length > 0) {
    throw new HttpError(403, '已经有账号了：请让管理员在「用户管理」里给你建号，或者直接登录');
  }
  const u: User = {
    id: randomUUID(),
    email,
    name: name || email.split('@')[0],
    // 第一个账号自动是管理员——否则没人能建第二个账号（这是本地部署的常见死锁）
    role: 'admin',
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  saveUsers([u]);
  const sid = randomUUID();
  const now = Date.now();
  saveSessions([
    ...sessions(),
    { id: sha256(sid), userId: u.id, createdAt: new Date().toISOString(), expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString() },
  ]);
  setSessionCookie(c.res, sid);
  audit({ ...c, me: { id: u.id, email: u.email, name: u.name, role: u.role } }, 'auth.register', u.email, '第一个账号自动为管理员');
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, actions: actionsOf(u.role) };
}, true);

on('POST', '/v1/auth/login', (c) => {
  const b = (c.body ?? {}) as { email?: string; password?: string };
  const email = String(b.email ?? '').trim().toLowerCase();
  const u = users().find((x) => x.email === email);
  // 不区分「没这个邮箱」和「密码不对」——那是免费的用户枚举接口
  if (!u || u.disabled || !verifyPassword(String(b.password ?? ''), u.passwordHash)) {
    throw new HttpError(401, '邮箱或密码不对');
  }
  const sid = randomUUID();
  const now = Date.now();
  saveSessions([
    ...sessions().filter((s) => Date.parse(s.expiresAt) > now),
    { id: sha256(sid), userId: u.id, createdAt: new Date().toISOString(), expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString() },
  ]);
  setSessionCookie(c.res, sid);
  audit({ ...c, me: { id: u.id, email: u.email, name: u.name, role: u.role } }, 'auth.login', u.email);
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, actions: actionsOf(u.role) };
}, true);

on('POST', '/v1/auth/logout', (c) => {
  const sid = parseCookies(c.req)['ec_session'];
  if (sid) saveSessions(sessions().filter((s) => s.id !== sha256(sid)));
  clearSessionCookie(c.res);
  if (c.me) audit(c, 'auth.logout', c.me.email);
  return { ok: true };
});

on('GET', '/v1/auth/me', (c) => {
  if (!c.me) throw new HttpError(401, '未登录');
  return { user: c.me, actions: actionsOf(c.me.role) };
});

/* ---- 用户管理 ---- */
on('GET', '/v1/users', (c) => {
  requireAction(c, 'user:manage');
  return {
    users: users().map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, disabled: !!u.disabled })),
    roles: ['viewer', 'analyst', 'admin'] as Role[],
  };
});

on('POST', '/v1/users', (c) => {
  requireAction(c, 'user:manage');
  const b = (c.body ?? {}) as { email?: string; name?: string; role?: Role; password?: string };
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, '邮箱格式不对');
  if (users().some((u) => u.email === email)) throw new HttpError(409, '这个邮箱已经存在');
  const role: Role = b.role === 'admin' || b.role === 'analyst' ? b.role : 'viewer';
  const password = String(b.password ?? '');
  const pwErr = checkPassword(password);
  if (pwErr) throw new HttpError(400, pwErr);
  const u: User = {
    id: randomUUID(), email, name: String(b.name ?? '').trim() || email.split('@')[0],
    role, passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
  };
  saveUsers([...users(), u]);
  audit(c, 'user.create', email, `role=${role}`);
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role } };
});

on('PATCH', '/v1/users/:id', (c, p) => {
  requireAction(c, 'user:manage');
  const all = users();
  const i = all.findIndex((u) => u.id === p.id);
  if (i < 0) throw new HttpError(404, '没有这个用户');
  const b = (c.body ?? {}) as { role?: Role; disabled?: boolean };
  // 不允许把最后一个管理员降级或停用：那会把所有人锁在门外
  const admins = all.filter((u) => u.role === 'admin' && !u.disabled);
  if (all[i].role === 'admin' && (b.role && b.role !== 'admin' || b.disabled === true) && admins.length <= 1) {
    throw new HttpError(400, '这是最后一个管理员：先把别人提升为管理员，再改这个账号');
  }
  if (b.role === 'admin' || b.role === 'analyst' || b.role === 'viewer') all[i] = { ...all[i], role: b.role };
  if (typeof b.disabled === 'boolean') all[i] = { ...all[i], disabled: b.disabled };
  saveUsers(all);
  audit(c, 'user.update', all[i].email, JSON.stringify({ role: all[i].role, disabled: !!all[i].disabled }));
  return { user: { id: all[i].id, email: all[i].email, name: all[i].name, role: all[i].role, disabled: !!all[i].disabled } };
});

/* ---- 数据集 ---- */
on('GET', '/v1/datasets', (c) => {
  requireAction(c, 'analysis:read');
  return {
    datasets: datasets().map((d) => ({
      id: d.id, name: d.name, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt,
      experiments: (d.dataset as Dataset).experiments.length,
      rows: (d.dataset as Dataset).daily.length,
      lastScanAt: d.lastScanAt ?? null,
    })),
  };
});

on('POST', '/v1/datasets', (c) => {
  requireAction(c, 'dataset:write');
  const b = (c.body ?? {}) as { name?: string; dataset?: Dataset };
  const ds = b.dataset;
  if (!ds || !Array.isArray(ds.experiments) || !Array.isArray(ds.daily)) {
    throw new HttpError(400, 'dataset 必须是完整的数据集 JSON（含 experiments 与 daily 两个数组）');
  }
  if (ds.daily.length > 400000) throw new HttpError(400, '行数超过 40 万：请先在库里聚合到「日期 × 分组 × 维度」再上传');
  const rec: DatasetRecord = {
    id: randomUUID(),
    name: String(b.name ?? '').trim() || `数据集 ${datasets().length + 1}`,
    uploadedBy: c.me!.email,
    uploadedAt: new Date().toISOString(),
    dataset: ds,
  };
  saveDatasets([...datasets(), rec]);
  audit(c, 'dataset.upload', rec.id, `${rec.name} / ${ds.experiments.length} 实验 / ${ds.daily.length} 行`);
  return { id: rec.id, name: rec.name, experiments: ds.experiments.length, rows: ds.daily.length };
});

function datasetOf(id: string): DatasetRecord {
  const rec = datasets().find((d) => d.id === id);
  if (!rec) throw new HttpError(404, '没有这个数据集');
  return rec;
}

on('GET', '/v1/datasets/:id', (c, p) => {
  requireAction(c, 'analysis:read');
  const rec = datasetOf(p.id);
  const ds = rec.dataset as Dataset;
  return {
    id: rec.id, name: rec.name, uploadedAt: rec.uploadedAt, uploadedBy: rec.uploadedBy,
    experiments: ds.experiments.map((e) => ({
      id: e.id, name: e.name, primaryMetric: e.primaryMetric, metricType: e.metricType,
      variants: e.variants, startDate: e.startDate, endDate: e.endDate,
    })),
    rows: ds.daily.length,
    lastScanAt: rec.lastScanAt ?? null,
  };
});

on('DELETE', '/v1/datasets/:id', (c, p) => {
  const rec = datasetOf(p.id);
  if (!(c.me!.role === 'admin' || rec.uploadedBy === c.me!.email)) {
    throw new HttpError(403, '只有上传者或管理员能删这个数据集');
  }
  saveDatasets(datasets().filter((d) => d.id !== p.id));
  audit(c, 'dataset.delete', p.id, rec.name);
  return { ok: true };
});

on('GET', '/v1/datasets/:id/experiments/:expId/analysis', (c, p) => {
  requireAction(c, 'analysis:read');
  const rec = datasetOf(p.id);
  const ds = rec.dataset as Dataset;
  const exp = ds.experiments.find((e) => e.id === p.expId);
  if (!exp) throw new HttpError(404, `数据集里没有实验 ${p.expId}`);
  const { rowsByExp } = analysesOf(ds);
  const a = analyze(exp, rowsByExp.get(exp.id) ?? []);
  return {
    experiment: { id: exp.id, name: exp.name },
    analysis: a,
    /** 机器读的结论摘要（SDK / CI 用这个，不用解析整个 Analysis） */
    summary: {
      decision: a.decision,
      reasonCode: a.reasonCode,
      reason: a.reason,
      primary: { label: a.primary.label, unit: a.primary.unit, diff: a.primary.diff, p: a.primary.p, ci95: a.primary.ci95 },
      srmFlagged: a.srm.flagged,
      worseGuardrails: a.guardrails.filter((g) => g.gating && g.worse).map((g) => g.label),
    },
  };
});

on('POST', '/v1/datasets/:id/scan', (c, p) => {
  requireAction(c, 'dataset:write');
  const rec = datasetOf(p.id);
  const ds = rec.dataset as Dataset;
  const next = scanDataset(rec);
  const names = Object.fromEntries(ds.experiments.map((e) => [e.id, e.name]));
  const fresh = diffScan(rec.lastScan, next, names).map((a, i) => ({
    ...a,
    datasetId: rec.id,
    id: alertId(Date.now() % 1e6 + i),
    createdAt: new Date().toISOString(),
  }));
  const all = [...alerts(), ...fresh];
  saveAlerts(all);
  const updated: DatasetRecord = { ...rec, lastScan: next, lastScanAt: new Date().toISOString() };
  saveDatasets(datasets().map((d) => (d.id === rec.id ? updated : d)));
  audit(c, 'dataset.scan', rec.id, `experiments=${Object.keys(next).length} alerts=${fresh.length}`);
  return { scanned: Object.keys(next).length, alerts: fresh };
});

/* ---- 告警 ---- */
on('GET', '/v1/alerts', (c) => {
  requireAction(c, 'alert:read');
  const ds = c.url.searchParams.get('dataset');
  const list = alerts()
    .filter((a) => !ds || a.datasetId === ds)
    .slice(-200)
    .reverse();
  return { alerts: list };
});

on('POST', '/v1/alerts/:id/seen', (c, p) => {
  requireAction(c, 'alert:read');
  const all = alerts();
  const i = all.findIndex((a) => a.id === p.id);
  if (i < 0) throw new HttpError(404, '没有这条告警');
  const who = c.me!.email;
  const seen = new Set(all[i].seenBy ?? []);
  seen.add(who);
  all[i] = { ...all[i], seenBy: [...seen] };
  saveAlerts(all);
  return { ok: true, seenBy: all[i].seenBy };
});

/* ---- 决策 + 审批 ---- */
on('GET', '/v1/decisions', (c) => {
  requireAction(c, 'analysis:read');
  const ds = c.url.searchParams.get('dataset');
  return { decisions: decisions().filter((d) => !ds || d.datasetId === ds) };
});

on('POST', '/v1/decisions', (c) => {
  requireAction(c, 'decision:write');
  const b = (c.body ?? {}) as Partial<DecisionRecordSrv>;
  if (!b.datasetId || !b.expId) throw new HttpError(400, '缺 datasetId / expId');
  if (!['ship', 'no-ship', 'iterate', 'hold'].includes(String(b.decision))) throw new HttpError(400, 'decision 只能是 ship / no-ship / iterate / hold');
  const rec = datasetOf(String(b.datasetId));
  const ds = rec.dataset as Dataset;
  const exp = ds.experiments.find((e) => e.id === b.expId);
  if (!exp) throw new HttpError(404, `数据集里没有实验 ${b.expId}`);
  const { rowsByExp } = analysesOf(ds);
  // 引擎结论由**服务端自己算**，不接受客户端传进来的值——否则审计里记的是别人编的数字
  const a = analyze(exp, rowsByExp.get(exp.id) ?? []);
  const differs = b.decision !== a.decision && !(b.decision === 'hold' && a.decision === 'inconclusive');
  if (differs && !String(b.note ?? '').trim()) {
    throw new HttpError(400, '与引擎结论不一致时必须写一句理由——那句话是这条记录的全部价值');
  }
  // 有管理员在线时进入待审批；只有自己一个管理员时直接生效（自己审自己没有意义）
  const approvers = users().filter((u) => u.role === 'admin' && !u.disabled && u.email !== c.me!.email);
  const rec2: DecisionRecordSrv = {
    id: randomUUID(),
    datasetId: rec.id,
    expId: exp.id,
    decision: b.decision as DecisionRecordSrv['decision'],
    note: String(b.note ?? '').trim(),
    engineDecision: a.decision,
    status: approvers.length ? 'pending' : 'approved',
    createdBy: c.me!.email,
    createdAt: new Date().toISOString(),
    ...(approvers.length ? {} : { decidedBy: c.me!.email, decidedAt: new Date().toISOString() }),
  };
  saveDecisions([...decisions(), rec2]);
  audit(c, 'decision.create', `${rec.id}/${exp.id}`, `${rec2.decision} status=${rec2.status}`);
  return rec2;
});

on('POST', '/v1/decisions/:id/approve', (c, p) => {
  requireAction(c, 'decision:approve');
  const all = decisions();
  const i = all.findIndex((d) => d.id === p.id);
  if (i < 0) throw new HttpError(404, '没有这条决策记录');
  if (all[i].status !== 'pending') throw new HttpError(400, `当前状态是 ${all[i].status}，只能审批 pending 的记录`);
  if (all[i].createdBy === c.me!.email) throw new HttpError(403, '不能审批自己提交的记录');
  all[i] = { ...all[i], status: 'approved', decidedBy: c.me!.email, decidedAt: new Date().toISOString() };
  saveDecisions(all);
  audit(c, 'decision.approve', all[i].id, all[i].expId);
  return all[i];
});

on('POST', '/v1/decisions/:id/reject', (c, p) => {
  requireAction(c, 'decision:approve');
  const all = decisions();
  const i = all.findIndex((d) => d.id === p.id);
  if (i < 0) throw new HttpError(404, '没有这条决策记录');
  if (all[i].status !== 'pending') throw new HttpError(400, `当前状态是 ${all[i].status}，只能驳回 pending 的记录`);
  const reason = String(((c.body ?? {}) as { reason?: string }).reason ?? '').trim();
  if (!reason) throw new HttpError(400, '驳回要写原因——三个月后没人记得为什么被否');
  all[i] = { ...all[i], status: 'rejected', decidedBy: c.me!.email, decidedAt: new Date().toISOString(), rejectReason: reason };
  saveDecisions(all);
  audit(c, 'decision.reject', all[i].id, reason);
  return all[i];
});

/* ---- 审计 ---- */
on('GET', '/v1/audit', (c) => {
  requireAction(c, 'audit:read');
  const limit = Math.min(1000, Number(c.url.searchParams.get('limit') ?? 200));
  return { entries: readAudit(F.audit, limit) };
});

/* ---- API Token ---- */
on('GET', '/v1/tokens', (c) => {
  requireAction(c, 'token:manage');
  return { tokens: tokens().map((t) => ({ ...t, hash: '***' })) };
});

on('POST', '/v1/tokens', (c) => {
  requireAction(c, 'token:manage');
  const b = (c.body ?? {}) as { name?: string; role?: Role };
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, '给这个 token 起个名字（以后在审计里靠它认人）');
  const role: Role = b.role === 'admin' || b.role === 'analyst' ? b.role : 'viewer';
  const { plain, hash, tail } = newToken();
  const t: ApiToken = {
    id: randomUUID(), name, hash, tail, role, createdBy: c.me!.email, createdAt: new Date().toISOString(),
  };
  saveTokens([...tokens(), t]);
  audit(c, 'token.create', name, `role=${role}`);
  // 明文只在这里出现一次；库里只存哈希
  return { token: plain, meta: { id: t.id, name, role, tail } };
});

on('DELETE', '/v1/tokens/:id', (c, p) => {
  requireAction(c, 'token:manage');
  const all = tokens();
  const i = all.findIndex((t) => t.id === p.id);
  if (i < 0) throw new HttpError(404, '没有这个 token');
  all[i] = { ...all[i], revokedAt: new Date().toISOString() };
  saveTokens(all);
  audit(c, 'token.revoke', all[i].name);
  return { ok: true };
});

/* ============================ 静态文件（同源部署） ============================ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
};

function serveStatic(c: Ctx): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  const dist = join(process.cwd(), 'dist');
  if (!existsSync(dist)) return false;
  // 只允许 dist 内的路径：`..` 直接拒绝（否则是标准的目录穿越）
  const rel = normalize(decodeURIComponent(c.url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) {
    json(c.res, 400, { error: '路径不合法' });
    return true;
  }
  let file = join(dist, rel || 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  if (!existsSync(file)) return false;
  const buf = readFileSync(file);
  c.res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': String(buf.length),
    // 带 hash 的产物可以长缓存；index.html 必须不缓存，否则用户永远拿到旧版本
    'cache-control': /\.[0-9a-zA-Z_-]{8,}\.(js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  c.res.end(c.req.method === 'HEAD' ? undefined : buf);
  return true;
}

/* ============================ 服务器 ============================ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const c: Ctx = { req, res, url, ip, body: undefined, ...authenticate(req) };

  try {
    const path = url.pathname;
    if (!path.startsWith('/v1/')) {
      if (serveStatic(c)) return;
      json(res, 404, { error: '找不到这个路径（前端未构建？先 npm run build）' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') c.body = await readBody(req);

    const seg = path.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== req.method || r.parts.length !== seg.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(seg[i]);
        else if (p !== seg[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!r.open && !c.me) throw new HttpError(401, '未登录');
      const out = await r.handler(c, params);
      if (out !== undefined) json(res, 200, out);
      return;
    }
    throw new HttpError(404, `没有这个接口：${req.method} ${path}`);
  } catch (e) {
    const err = e as HttpError;
    const status = err.status && err.status >= 400 ? err.status : 500;
    if (status >= 500) console.error('[server] 未预期错误', e);
    json(res, status, { error: err.message || '服务器内部错误' });
  }
});

/* ---- 定时扫描：每 N 分钟重算一次，结论变了就产出告警 ---- */
const SCAN_MIN = Number(process.env.EC_SCAN_MINUTES || 0);
if (SCAN_MIN > 0) {
  setInterval(() => {
    for (const rec of datasets()) {
      try {
        const ds = rec.dataset as Dataset;
        const next = scanDataset(rec);
        const names = Object.fromEntries(ds.experiments.map((e) => [e.id, e.name]));
        const fresh = diffScan(rec.lastScan, next, names).map((a, i) => ({
          ...a, datasetId: rec.id, id: alertId(Date.now() % 1e6 + i), createdAt: new Date().toISOString(),
        }));
        if (fresh.length) saveAlerts([...alerts(), ...fresh]);
        saveDatasets(datasets().map((d) => (d.id === rec.id ? { ...d, lastScan: next, lastScanAt: new Date().toISOString() } : d)));
        if (fresh.length) console.log(`[scan] ${rec.name}: ${fresh.length} 条变化`);
      } catch (e) {
        console.error('[scan] 失败', rec.id, e);
      }
    }
  }, SCAN_MIN * 60000).unref?.();
}

server.listen(PORT, '127.0.0.1', () => {
  const n = users().length;
  console.log(`\nExperiment Copilot 后端已启动：http://127.0.0.1:${PORT}`);
  console.log(`  数据目录：${DIR}`);
  console.log(`  账号状态：${n === 0 ? '还没有账号 → 打开页面注册第一个（自动成为管理员）' : `${n} 个账号 → 直接登录`}`);
  console.log(`  定时扫描：${SCAN_MIN > 0 ? `每 ${SCAN_MIN} 分钟` : '关闭（EC_SCAN_MINUTES=30 可开）'}`);
  console.log('  前端：同源直接访问本端口；vite dev 下由 vite 代理 /v1\n');
});
