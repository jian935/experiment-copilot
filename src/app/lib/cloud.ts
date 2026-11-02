/**
 * 云端（可选后端）的 API 客户端。
 *
 * 三条纪律：
 *
 * 1. **探测失败必须静默**。没起后端是正常状态（GitHub Pages 上永远没有后端），
 *    所以 `probe()` 吞掉所有异常、1.5 秒超时，绝不在控制台刷红字、也不阻塞首屏。
 * 2. **不在本地模式里假装有权限**。所有云端页面在 `mode==='local'` 时只显示「怎么启动后端」，
 *    不显示一个灰掉的用户表——灰掉的权限页会让人以为「这产品有权限，只是我没开」。
 * 3. **错误信息原样透出**。服务端的报错是写给人看的（「与引擎结论不一致时必须写一句理由」），
 *    前端再包一层「操作失败」会把唯一有用的信息盖掉。
 */

export type Role = 'viewer' | 'analyst' | 'admin';

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface CloudHealth {
  ok: true;
  mode: 'cloud';
  initialized: boolean;
  users: number;
  datasets: number;
  version: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 探测后端。没有后端返回 null（这是正常状态，不是错误） */
export async function probe(timeoutMs = 1500): Promise<CloudHealth | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('/v1/health', { signal: ctrl.signal, credentials: 'include' });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as CloudHealth;
    return j?.ok && j.mode === 'cloud' ? j : null;
  } catch {
    // 页面在 file:// / 静态托管 / 后端没起：都走这里，静默退回本地模式
    return null;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    // cookie 会话必须带 credentials；同源部署时这是默认值，跨端口预览时要显式写
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface CloudDataset {
  id: string;
  name: string;
  uploadedBy: string;
  uploadedAt: string;
  experiments: number;
  rows: number;
  lastScanAt: string | null;
}

export interface CloudAlert {
  id: string;
  datasetId: string;
  expId: string;
  expName: string;
  kind: 'decision_changed' | 'srm' | 'guardrail' | 'newly_significant';
  severity: 'info' | 'warn' | 'critical';
  message: string;
  createdAt: string;
  seenBy?: string[];
}

export interface CloudDecision {
  id: string;
  datasetId: string;
  expId: string;
  decision: 'ship' | 'no-ship' | 'iterate' | 'hold';
  note: string;
  engineDecision: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectReason?: string;
}

export interface CloudToken {
  id: string;
  name: string;
  tail: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CloudAudit {
  id: string;
  at: string;
  actor: string;
  actorRole: Role | 'token';
  action: string;
  target: string;
  detail?: string;
  ip?: string;
}

/** 时间戳只显示到分钟，列表里不需要秒 */
export const shortTime = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
