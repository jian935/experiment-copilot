/**
 * 后端的核心部分：与 HTTP 无关的纯逻辑（鉴权、RBAC、审计、告警判定）。
 *
 * ## 为什么后端是「可选」的
 *
 * 这个项目的形态是「导入一份数据，得出可复算的结论」。这件事**不需要服务器**，
 * 所以纯前端版本必须一直可用（GitHub Pages 上跑的就是它）。
 * 但「权限 / 审批 / 审计 / API / 定时告警」这四件事**必须**有服务器：
 * 前端的「权限」只是把按钮藏起来，而藏起来的按钮挡不住任何人 —— 假权限比没有权限更危险。
 *
 * 所以架构是：**同一份前端，两种运行形态**。
 *   - 没有后端 → 本地模式：结论全在本机算，权限/审批/审计/告警这些入口**根本不出现**；
 *   - 连上后端 → 云端模式：结论由服务端算并留痕，多人与机器通过 API 访问。
 * 前端靠 `/v1/health` 探测，探测不到就退回本地，绝不显示一个假的权限页。
 *
 * ## 为什么不用 SQLite / 任何依赖
 *
 * 这台机器上没有网络安装条件，而 SQLite 的 Node 绑定要编译原生模块——一旦编译失败，
 * 「可选后端」就变成「打不开的后端」。所以存储用**单文件 JSON + 原子写**
 * （写临时文件再 rename），审计日志用**追加式 JSONL**（只追加、不改写，天然可核查）。
 * 数据量（几十个数据集、几千条审计）下这完全够用；真到需要并发写百万条，
 * 该换的是架构（Postgres）而不是这个文件。
 *
 * ## 密码与令牌
 *
 * - 密码用 `scrypt`（Node 内置），每个用户独立盐；比对用 `timingSafeEqual`。
 * - 会话用 **httpOnly Cookie**（同源部署，没有 CORS 的必要），令牌只存哈希。
 * - API Token 只显示一次，库里存 sha256 —— 泄漏数据库不等于泄漏令牌。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ============================ 角色与权限 ============================ */

export type Role = 'viewer' | 'analyst' | 'admin';

/**
 * 动作清单。**只列真的会被某个接口执行的动作**——
 * 列一堆用不到的动作会让「权限表」变成装饰，而这些装饰没有人会去核对。
 */
export type Action =
  | 'analysis:read'
  | 'dataset:write'
  | 'decision:write'
  | 'decision:approve'
  | 'metric:write'
  | 'user:manage'
  | 'audit:read'
  | 'token:manage'
  | 'alert:read';

const ROLE_ACTIONS: Record<Role, Action[]> = {
  // 只能看：结论、告警
  viewer: ['analysis:read', 'alert:read'],
  // 分析师：能传数据、能记决策（但不能审批别人的、不能改口径、不能管人）
  analyst: ['analysis:read', 'alert:read', 'dataset:write', 'decision:write'],
  // 管理员：全部
  admin: [
    'analysis:read', 'alert:read', 'dataset:write', 'decision:write',
    'decision:approve', 'metric:write', 'user:manage', 'audit:read', 'token:manage',
  ],
};

export function can(role: Role, action: Action): boolean {
  return ROLE_ACTIONS[role]?.includes(action) ?? false;
}

export function actionsOf(role: Role): Action[] {
  return [...(ROLE_ACTIONS[role] ?? [])];
}

/* ============================ 密码 ============================ */

const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const got = scryptSync(password, salt, SCRYPT_KEYLEN);
  const want = Buffer.from(key, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 密码强度：只查「是个人都能猜到的」那几种，不搞复杂度表演 */
export function checkPassword(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return '密码要同时含字母和数字';
  const weak = ['12345678', 'password', 'password1', 'abc12345', 'qwerty123', '11111111'];
  if (weak.includes(password.toLowerCase())) return '这个密码太常见了';
  return null;
}

export function newToken(prefix = 'ec'): { plain: string; hash: string; tail: string } {
  const plain = `${prefix}_${randomBytes(24).toString('hex')}`;
  return { plain, hash: sha256(plain), tail: plain.slice(-6) };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/* ============================ 存储 ============================ */

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  disabled?: boolean;
}

export interface Session {
  /** 会话 id（cookie 里存的就是它，用 sha256 后的值做 key） */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  hash: string;
  /** 最后 6 位，列表里用来区分「哪一个」 */
  tail: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  uploadedBy: string;
  uploadedAt: string;
  /** 存的是原始 Dataset JSON（前端导入用的同一份格式） */
  dataset: unknown;
  /** 上次扫描时的结论快照：experimentId → 决策/主指标 p */
  lastScan?: Record<string, { decision: string; p: number; diff: number }>;
  lastScanAt?: string;
}

export interface DecisionRecordSrv {
  id: string;
  datasetId: string;
  expId: string;
  decision: 'ship' | 'no-ship' | 'iterate' | 'hold';
  note: string;
  /** 人工决定与引擎结论是否一致（不一致时 note 必填，服务端也校验） */
  engineDecision: string;
  /** 审批状态：draft → pending → approved / rejected。没有审批人时直接 approved */
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectReason?: string;
}

export interface Alert {
  id: string;
  datasetId: string;
  expId: string;
  expName: string;
  kind: 'decision_changed' | 'srm' | 'guardrail' | 'newly_significant';
  severity: 'info' | 'warn' | 'critical';
  message: string;
  createdAt: string;
  /** 已读的人 */
  seenBy?: string[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  actorRole: Role | 'token';
  action: string;
  target: string;
  /** 只留摘要，不存敏感内容 */
  detail?: string;
  ip?: string;
}

/* ============================ 原子写 ============================ */

/**
 * 单文件 JSON 存储：写临时文件 → rename。
 *
 * 为什么不是「直接写」：服务被 Ctrl+C 打断时直接写会留下半个 JSON，
 * 下次启动整个库读不出来（这是最典型的自伤方式）。`rename` 在同一分区上是原子的，
 * 所以要么是旧的完整文件，要么是新的完整文件。
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // 坏文件不静默吞掉：复制一份 .bad 再回退，避免下一次写入把证据覆盖掉
    try {
      renameSync(file, `${file}.bad-${Date.now()}`);
    } catch {
      /* 复制不了就算了，至少别让启动失败 */
    }
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** 审计日志：只追加，永不改写（append-only 才谈得上「可核查」） */
export function appendAudit(file: string, entry: AuditEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readAudit(file: string, limit = 200): AuditEntry[] {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as AuditEntry).reverse();
  } catch {
    return [];
  }
}

export function dataDir(): string {
  return process.env.EC_DATA_DIR || join(process.cwd(), '.local', 'server');
}

/* ============================ 告警判定 ============================ */

export interface ScanPoint {
  decision: string;
  p: number;
  diff: number;
  reasonCode?: string;
  srmFlagged?: boolean;
  worseGuardrail?: string | null;
}

/**
 * 比较「上一次扫描」与「这一次扫描」，产出告警。
 *
 * 为什么这是后端最值得做的一件事：纯前端只能「你打开页面时算一次」，
 * 而结论会不会变，恰恰是在**你没打开的时候**发生的——数据回补、分流跑偏、
 * 护栏指标第二天才上来。定时重算 + 变化告警，是「从工具变成系统」的分界线。
 *
 * 判定口径刻意保守（宁可少报）：
 *   - 决策变化：只在四类之间真的变了才报，`inconclusive → ship` 也算（那是「有结论了」）；
 *   - SRM：只在由「通过」变「异常」时报，不报反向（恢复是好事，不该占告警位）；
 *   - 护栏：只在某个护栏从「没恶化」变「恶化」时报。
 */
export function diffScan(
  prev: Record<string, ScanPoint> | undefined,
  next: Record<string, ScanPoint>,
  names: Record<string, string>,
): Array<Omit<Alert, 'id' | 'createdAt' | 'seenBy'>> {
  const out: Array<Omit<Alert, 'id' | 'createdAt' | 'seenBy'>> = [];
  for (const [expId, cur] of Object.entries(next)) {
    const old = prev?.[expId];
    if (!old) continue; // 第一次扫描只建基线，不报警（否则一接上就一堆「新实验」）
    const base = { datasetId: '', expId, expName: names[expId] ?? expId };
    if (old.decision !== cur.decision) {
      out.push({
        ...base,
        kind: 'decision_changed',
        severity: cur.decision === 'no-ship' ? 'critical' : 'warn',
        message: `结论从「${old.decision}」变成「${cur.decision}」（主指标 p ${old.p.toFixed(3)} → ${cur.p.toFixed(3)}）`,
      });
    }
    if (cur.srmFlagged && !old.srmFlagged) {
      out.push({ ...base, kind: 'srm', severity: 'critical', message: '分流比例检测到异常（SRM）：这批数据不能用，先查分流' });
    }
    if (cur.worseGuardrail && cur.worseGuardrail !== old.worseGuardrail) {
      out.push({
        ...base,
        kind: 'guardrail',
        severity: 'critical',
        message: `护栏「${cur.worseGuardrail}」由未恶化变成恶化`,
      });
    }
    if (old.p >= 0.05 && cur.p < 0.05) {
      out.push({ ...base, kind: 'newly_significant', severity: 'info', message: `主指标转为显著（p ${old.p.toFixed(3)} → ${cur.p.toFixed(3)}）` });
    }
  }
  return out;
}

export function alertId(seq: number): string {
  return `al_${String(seq).padStart(6, '0')}`;
}
