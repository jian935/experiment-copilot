/**
 * 云端（可选后端）页面：`#/cloud`。
 *
 * 这一页的存在本身就是那个产品判断：**「不做权限」不是立场，是当时没有后端**。
 * 现在有了后端，四件事就得真的做到：真密码、真角色、真审批、真审计。
 * 反过来，没有后端时这一页不假装——它只告诉你「怎么把后端起来」，
 * 因为一个灰色的权限页会让人误以为「数据受控」（假权限比没有权限更危险）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Activity, Cloud, Database, Download, KeyRound, LogOut, RefreshCw, ShieldCheck,
  TriangleAlert, UserPlus, Users,
} from 'lucide-react';
import type { Dataset } from '../../lib/types.ts';
import {
  api, probe, shortTime, type CloudAlert, type CloudAudit, type CloudDataset,
  type CloudDecision, type CloudHealth, type CloudToken, type CloudUser, type Role,
} from '../lib/cloud';
import { Button, cx, Panel, PanelHead } from './ui.tsx';

type Tab = 'datasets' | 'alerts' | 'decisions' | 'users' | 'tokens' | 'audit';

const TABS: Array<{ k: Tab; label: string; need?: string; icon: typeof Database }> = [
  { k: 'datasets', label: '数据集', icon: Database },
  { k: 'alerts', label: '告警', icon: TriangleAlert },
  { k: 'decisions', label: '决策审批', icon: ShieldCheck },
  { k: 'users', label: '用户', need: 'user:manage', icon: Users },
  { k: 'tokens', label: 'API Token', need: 'token:manage', icon: KeyRound },
  { k: 'audit', label: '审计日志', need: 'audit:read', icon: Activity },
];

export function CloudScreen({ dataset, onBack }: { dataset: Dataset | null; onBack: () => void }) {
  const [health, setHealth] = useState<CloudHealth | null | 'probing'>('probing');
  const [me, setMe] = useState<CloudUser | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('datasets');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const h = await probe();
    setHealth(h);
    if (!h) return;
    try {
      const r = await api<{ user: CloudUser; actions: string[] }>('/auth/me');
      setMe(r.user);
      setActions(r.actions);
    } catch {
      // 401 = 没登录，这是正常状态
      setMe(null);
      setActions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showFlash = (s: string) => {
    setFlash(s);
    setTimeout(() => setFlash(null), 4000);
  };

  if (health === 'probing') {
    return (
      <Shell onBack={onBack} right={<Chip>探测中…</Chip>}>
        <Panel>
          <p className="px-4 py-6 text-center text-[12px] text-muted">正在探测后端…</p>
        </Panel>
      </Shell>
    );
  }

  if (!health) {
    return (
      <Shell onBack={onBack} right={<Chip tone="local">本地模式</Chip>}>
        <Panel>
          <PanelHead title="当前没有后端：这是本地模式" hint="纯前端形态下，所有结论都在你的浏览器里算，不联网" />
          <div className="px-4 py-3 text-[11.5px] leading-6 text-muted">
            <p>
              现在这一页是空的，<b className="text-ink">而且这是设计</b>：没有后端就不显示权限、审批、审计、告警
              ——灰掉的权限页会让人以为数据受控，而实际上任何人在浏览器控制台里都能把它打开。
            </p>
            <p className="mt-2">要拿到这些能力，起一个零依赖的后端（不需要数据库、不需要 Docker）：</p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-panel2/60 p-3 font-mono text-[11px] text-ink">{`npm run build      # 产出 dist/
npm run server     # http://127.0.0.1:8787

# 首次打开 http://127.0.0.1:8787/#/cloud 注册第一个账号（自动成为管理员）
# 可选：EC_SCAN_MINUTES=30 开启定时重算 + 结论变化告警`}</pre>
            <p className="mt-2 text-dim">
              开发模式：`npm run dev` + `npm run server` 两条命令并行，vite 会把 <code>/v1</code> 代理到后端。
            </p>
          </div>
        </Panel>
        <Panel className="mt-4">
          <PanelHead title="后端提供什么（以及为什么必须是真的）" />
          <div className="grid gap-px bg-line sm:grid-cols-2">
            {[
              ['真密码 + 会话', 'scrypt 独立盐、httpOnly Cookie、令牌只存哈希——不是前端藏按钮'],
              ['RBAC', 'viewer 只能读；analyst 能传数据、记决策；admin 才能审批、改口径、管人'],
              ['审批流', '分析师的决策进入待审批，不能自审自批；驳回必须写原因'],
              ['审计日志', '只追加的 JSONL，谁在什么时候动了哪条记录都可查'],
              ['API + Token', '按角色发放的 token，CI 里一条 curl 就能拿结论'],
              ['定时告警', '定时重算，结论从 ship 变 no-ship 立刻报——那是你不在看的时候发生的'],
            ].map(([t, d]) => (
              <div key={t} className="bg-panel px-4 py-2.5">
                <div className="text-[11.5px] font-medium text-ink">{t}</div>
                <div className="mt-0.5 text-[10.5px] leading-4 text-dim">{d}</div>
              </div>
            ))}
          </div>
        </Panel>
      </Shell>
    );
  }

  if (!me) {
    return (
      <Shell onBack={onBack} right={<Chip tone="cloud">后端在线 · {health.users} 个账号</Chip>}>
        <AuthForm
          initialized={health.initialized}
          onDone={async (msg) => {
            showFlash(msg);
            await refresh();
          }}
        />
      </Shell>
    );
  }

  const can = (a: string) => actions.includes(a);
  const visible = TABS.filter((t) => !t.need || can(t.need));

  return (
    <Shell
      onBack={onBack}
      right={
        <div className="flex items-center gap-1.5">
          <Chip tone="cloud">
            <Cloud size={10} /> {me.name} · {me.role}
          </Chip>
          <button
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' });
              await refresh();
            }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-dim hover:bg-panel2 hover:text-ink"
            title="退出登录"
          >
            <LogOut size={10} /> 退出
          </button>
        </div>
      }
    >
      {flash && (
        <div className="mb-3 rounded-lg border border-ship/30 bg-ship/10 px-3 py-1.5 text-[11px] text-ship">{flash}</div>
      )}
      {err && (
        <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-noship/30 bg-noship/10 px-3 py-1.5 text-[11px] text-noship">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{err}</span>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1">
        {visible.map((t) => (
          <button
            key={t.k}
            onClick={() => {
              setTab(t.k);
              setErr(null);
            }}
            aria-pressed={tab === t.k}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
              tab === t.k ? 'bg-brand/15 text-brand2' : 'text-muted hover:bg-panel2 hover:text-ink',
            )}
          >
            <t.icon size={12} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'datasets' && (
        <DatasetsTab dataset={dataset} canWrite={can('dataset:write')} onMsg={showFlash} onErr={setErr} />
      )}
      {tab === 'alerts' && <AlertsTab onMsg={showFlash} onErr={setErr} />}
      {tab === 'decisions' && (
        <DecisionsTab canApprove={can('decision:approve')} me={me.email} onMsg={showFlash} onErr={setErr} />
      )}
      {tab === 'users' && <UsersTab me={me.email} onMsg={showFlash} onErr={setErr} />}
      {tab === 'tokens' && <TokensTab onMsg={showFlash} onErr={setErr} />}
      {tab === 'audit' && <AuditTab onErr={setErr} />}
    </Shell>
  );
}

/* ───────────── 外壳 ───────────── */

function Shell({ onBack, right, children }: { onBack: () => void; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={onBack} className="text-[11.5px] text-dim hover:text-ink">
          ← 返回实验列表
        </button>
        <h1 className="text-[15px] font-semibold text-ink">云端协作</h1>
        <div className="ml-auto flex items-center gap-1.5">{right}</div>
      </div>
      {children}
    </div>
  );
}

function Chip({ children, tone = 'mute' }: { children: React.ReactNode; tone?: 'mute' | 'cloud' | 'local' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] ring-1',
        tone === 'cloud'
          ? 'bg-brand/12 text-brand2 ring-brand/25'
          : tone === 'local'
            ? 'bg-panel2 text-muted ring-line2'
            : 'bg-panel2 text-dim ring-line',
      )}
    >
      {children}
    </span>
  );
}

/* ───────────── 登录 / 注册 ───────────── */

function AuthForm({ initialized, onDone }: { initialized: boolean; onDone: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (initialized) {
        await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        onDone('已登录');
      } else {
        await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password }) });
        onDone('已创建第一个账号（管理员）');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="max-w-[460px]">
      <PanelHead
        title={initialized ? '登录' : '创建第一个账号'}
        hint={initialized ? '账号由管理员创建；忘记密码请让管理员重置' : '第一个账号自动成为管理员——否则没人能建第二个账号'}
      />
      <div className="space-y-2 px-4 py-3">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] text-dim">邮箱</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
          />
        </label>
        {!initialized && (
          <label className="block">
            <span className="mb-0.5 block text-[10.5px] text-dim">显示名（可空）</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
            />
          </label>
        )}
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] text-dim">密码（至少 8 位，含字母和数字）</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={initialized ? 'current-password' : 'new-password'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
          />
        </label>
        {err && <p className="text-[11px] text-noship">{err}</p>}
        <Button onClick={submit} disabled={busy || !email || !password}>
          {initialized ? '登录' : <><UserPlus size={12} /> 创建账号</>}
        </Button>
      </div>
    </Panel>
  );
}

/* ───────────── 数据集 ───────────── */

function DatasetsTab({
  dataset, canWrite, onMsg, onErr,
}: {
  dataset: Dataset | null;
  canWrite: boolean;
  onMsg: (s: string) => void;
  onErr: (s: string | null) => void;
}) {
  const [list, setList] = useState<CloudDataset[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ datasets: CloudDataset[] }>('/datasets');
      setList(r.datasets);
    } catch (e) {
      onErr((e as Error).message);
    }
  }, [onErr]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHead
        title={`数据集（${list.length}）`}
        hint="上传后由服务端重算并留痕；同一份数据的结论与本地完全一致（同一个引擎）"
        right={
          <div className="flex gap-1.5">
            {canWrite && dataset && (
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  onErr(null);
                  try {
                    const r = await api<{ id: string; experiments: number; rows: number }>('/datasets', {
                      method: 'POST',
                      body: JSON.stringify({ name: `本地数据源 ${new Date().toISOString().slice(0, 10)}`, dataset }),
                    });
                    onMsg(`已上传：${r.experiments} 个实验 / ${r.rows} 行`);
                    await load();
                  } catch (e) {
                    onErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Download size={11} /> 上传当前数据源
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              <RefreshCw size={11} /> 刷新
            </Button>
          </div>
        }
      />
      {list.length === 0 ? (
        <p className="px-4 py-4 text-[11.5px] text-dim">
          还没有数据集。{canWrite ? '点上方的「上传当前数据源」，把浏览器里正在看的那份数据交给服务端。' : '请让有 dataset:write 权限的同事上传。'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-[11.5px]">
            <thead>
              <tr className="border-b border-line text-[10.5px] text-dim">
                <th className="px-4 py-2 text-left font-medium">名称</th>
                <th className="px-2 py-2 text-right font-medium">实验</th>
                <th className="px-2 py-2 text-right font-medium">行数</th>
                <th className="px-2 py-2 text-left font-medium">上传者</th>
                <th className="px-2 py-2 text-left font-medium">上次扫描</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 text-ink">{d.name}</td>
                  <td className="num px-2 py-2 text-right text-muted">{d.experiments}</td>
                  <td className="num px-2 py-2 text-right text-muted">{d.rows}</td>
                  <td className="px-2 py-2 text-muted">{d.uploadedBy}</td>
                  <td className="px-2 py-2 text-dim">{shortTime(d.lastScanAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={async () => {
                        onErr(null);
                        try {
                          const r = await api<{ scanned: number; alerts: unknown[] }>(`/datasets/${d.id}/scan`, { method: 'POST' });
                          onMsg(`扫描 ${r.scanned} 个实验，新增 ${r.alerts.length} 条告警`);
                          await load();
                        } catch (e) {
                          onErr((e as Error).message);
                        }
                      }}
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-brand2 hover:bg-brand/10"
                    >
                      重算并比对
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 text-[10.5px] leading-4 text-dim">
        第一次扫描只建基线、不报警——否则一接上就是一屏「新实验」。
      </p>
    </Panel>
  );
}

/* ───────────── 告警 ───────────── */

const ALERT_LABEL: Record<CloudAlert['kind'], string> = {
  decision_changed: '结论变化',
  srm: 'SRM 异常',
  guardrail: '护栏恶化',
  newly_significant: '转为显著',
};

function AlertsTab({ onMsg, onErr }: { onMsg: (s: string) => void; onErr: (s: string | null) => void }) {
  const [list, setList] = useState<CloudAlert[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ alerts: CloudAlert[] }>('/alerts');
      setList(r.alerts);
    } catch (e) {
      onErr((e as Error).message);
    }
  }, [onErr]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHead
        title={`告警（${list.length}）`}
        hint="由定时扫描产出：结论变化、SRM 异常、护栏恶化、转为显著。这就是「你不在看的时候发生了什么」"
        right={<Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={11} /> 刷新</Button>}
      />
      {list.length === 0 ? (
        <p className="px-4 py-4 text-[11.5px] text-dim">没有告警。跑一次「重算并比对」之后，结论若发生变化就会出现在这里。</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {list.map((a) => (
            <li key={a.id} className="flex items-start gap-2 px-4 py-2">
              <span
                className={cx(
                  'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9.5px] ring-1',
                  a.severity === 'critical'
                    ? 'bg-noship/12 text-noship ring-noship/25'
                    : a.severity === 'warn'
                      ? 'bg-iterate/12 text-iterate ring-iterate/25'
                      : 'bg-panel2 text-muted ring-line2',
                )}
              >
                {ALERT_LABEL[a.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] text-ink">
                  {a.expName} <span className="font-mono text-[9.5px] text-dim">{a.expId}</span>
                </div>
                <div className="text-[10.5px] leading-4 text-muted">{a.message}</div>
                <div className="text-[9.5px] text-dim">{shortTime(a.createdAt)}</div>
              </div>
              <button
                onClick={async () => {
                  try {
                    await api(`/alerts/${a.id}/seen`, { method: 'POST' });
                    onMsg('已标记为已知');
                    await load();
                  } catch (e) {
                    onErr((e as Error).message);
                  }
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel2 hover:text-ink"
              >
                已知
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ───────────── 决策审批 ───────────── */

function DecisionsTab({
  canApprove, me, onMsg, onErr,
}: {
  canApprove: boolean;
  me: string;
  onMsg: (s: string) => void;
  onErr: (s: string | null) => void;
}) {
  const [list, setList] = useState<CloudDecision[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ decisions: CloudDecision[] }>('/decisions');
      setList([...r.decisions].reverse());
    } catch (e) {
      onErr((e as Error).message);
    }
  }, [onErr]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHead
        title={`决策与审批（${list.length}）`}
        hint="分析师的决策进入待审批；管理员审批时不能审自己提交的；驳回必须写原因"
        right={<Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={11} /> 刷新</Button>}
      />
      {list.length === 0 ? (
        <p className="px-4 py-4 text-[11.5px] text-dim">还没有服务端侧的决策记录。本地模式的决策记录仍存在你自己的浏览器里。</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {list.map((d) => (
            <li key={d.id} className="px-4 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] text-ink">{d.expId}</span>
                <span className="font-mono text-[10px] text-dim">{d.decision}</span>
                <span
                  className={cx(
                    'rounded px-1.5 py-0.5 text-[9.5px]',
                    d.status === 'approved'
                      ? 'bg-ship/12 text-ship'
                      : d.status === 'pending'
                        ? 'bg-iterate/12 text-iterate'
                        : d.status === 'rejected'
                          ? 'bg-noship/12 text-noship'
                          : 'bg-panel2 text-dim',
                  )}
                >
                  {{ approved: '已通过', pending: '待审批', rejected: '已驳回', draft: '草稿' }[d.status]}
                </span>
                <span className="text-[10px] text-dim">
                  {d.createdBy} · {shortTime(d.createdAt)}
                  {d.engineDecision !== d.decision ? ` · 引擎是 ${d.engineDecision}` : ''}
                </span>
              </div>
              {d.note && <div className="mt-0.5 text-[10.5px] leading-4 text-muted">理由：{d.note}</div>}
              {d.rejectReason && <div className="mt-0.5 text-[10.5px] text-noship">驳回原因：{d.rejectReason}</div>}
              {canApprove && d.status === 'pending' && (
                <div className="mt-1 flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={async () => {
                      onErr(null);
                      try {
                        await api(`/decisions/${d.id}/approve`, { method: 'POST' });
                        onMsg('已通过');
                        await load();
                      } catch (e) {
                        onErr((e as Error).message);
                      }
                    }}
                    disabled={d.createdBy === me}
                    title={d.createdBy === me ? '不能审批自己提交的记录' : '通过'}
                  >
                    通过
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const reason = window.prompt('驳回原因（必填）：');
                      if (!reason?.trim()) return;
                      onErr(null);
                      try {
                        await api(`/decisions/${d.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
                        onMsg('已驳回');
                        await load();
                      } catch (e) {
                        onErr((e as Error).message);
                      }
                    }}
                  >
                    驳回
                  </Button>
                </div>
              )}
              {d.status === 'pending' && d.createdBy === me && (
                <div className="mt-0.5 text-[10px] text-dim">这是你提交的，需要另一位管理员审批。</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ───────────── 用户 ───────────── */

const ROLE_HINT: Record<Role, string> = {
  viewer: '只读：结论与告警',
  analyst: '能传数据、记决策、改自定义指标',
  admin: '全部：审批、口径、用户、审计',
};

function UsersTab({ me, onMsg, onErr }: { me: string; onMsg: (s: string) => void; onErr: (s: string | null) => void }) {
  const [list, setList] = useState<Array<CloudUser & { createdAt: string; disabled?: boolean }>>([]);
  const [form, setForm] = useState({ email: '', name: '', role: 'viewer' as Role, password: '' });
  const load = useCallback(async () => {
    try {
      const r = await api<{ users: typeof list }>('/users');
      setList(r.users);
    } catch (e) {
      onErr((e as Error).message);
    }
  }, [onErr]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHead title={`用户（${list.length}）`} hint="viewer 只读 / analyst 能传数据与记决策 / admin 全部。第一个账号自动是 admin" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-[10.5px] text-dim">
              <th className="px-4 py-2 text-left font-medium">账号</th>
              <th className="px-2 py-2 text-left font-medium">角色</th>
              <th className="px-2 py-2 text-left font-medium">创建时间</th>
              <th className="px-4 py-2 text-right font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2">
                  <div className="text-ink">
                    {u.name} {u.email === me && <span className="text-[9.5px] text-dim">（你）</span>}
                  </div>
                  <div className="font-mono text-[9.5px] text-dim">{u.email}</div>
                </td>
                <td className="px-2 py-2">
                  <select
                    value={u.role}
                    onChange={async (e) => {
                      onErr(null);
                      try {
                        await api(`/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) });
                        onMsg('角色已更新');
                        await load();
                      } catch (err2) {
                        onErr((err2 as Error).message);
                      }
                    }}
                    className="rounded border border-line bg-panel px-1 py-0.5 text-[10.5px] text-ink"
                    title={ROLE_HINT[u.role]}
                  >
                    {(['viewer', 'analyst', 'admin'] as Role[]).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2 text-dim">{shortTime(u.createdAt)}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={async () => {
                      onErr(null);
                      try {
                        await api(`/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !u.disabled }) });
                        onMsg(u.disabled ? '已启用' : '已停用');
                        await load();
                      } catch (err2) {
                        onErr((err2 as Error).message);
                      }
                    }}
                    className={cx('rounded px-1.5 py-0.5 text-[10.5px]', u.disabled ? 'text-ship hover:bg-ship/10' : 'text-noship hover:bg-noship/10')}
                  >
                    {u.disabled ? '启用' : '停用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="mb-1.5 text-[10.5px] text-dim">新建账号</div>
        <div className="flex flex-wrap items-end gap-1.5">
          <input
            placeholder="邮箱"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-44 rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          />
          <input
            placeholder="显示名（可空）"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-32 rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            className="rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          >
            {(['viewer', 'analyst', 'admin'] as Role[]).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <input
            placeholder="初始密码"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-36 rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          />
          <Button
            size="sm"
            disabled={!form.email || !form.password}
            onClick={async () => {
              onErr(null);
              try {
                await api('/users', { method: 'POST', body: JSON.stringify(form) });
                onMsg(`已创建 ${form.email}`);
                setForm({ email: '', name: '', role: 'viewer', password: '' });
                await load();
              } catch (e) {
                onErr((e as Error).message);
              }
            }}
          >
            <UserPlus size={11} /> 创建
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* ───────────── API Token ───────────── */

function TokensTab({ onMsg, onErr }: { onMsg: (s: string) => void; onErr: (s: string | null) => void }) {
  const [list, setList] = useState<CloudToken[]>([]);
  const [form, setForm] = useState({ name: '', role: 'viewer' as Role });
  const [plain, setPlain] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ tokens: CloudToken[] }>('/tokens');
      setList(r.tokens);
    } catch (e) {
      onErr((e as Error).message);
    }
  }, [onErr]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHead
        title={`API Token（${list.length}）`}
        hint="按角色发放；明文只在创建时显示一次，库里只存 sha256。CI 里用它调 /v1 接口"
      />
      {plain && (
        <div className="border-b border-line bg-panel2/60 px-4 py-2">
          <div className="text-[10.5px] text-dim">这个 token 只会显示一次，现在复制走：</div>
          <code className="mt-1 block break-all rounded bg-panel px-2 py-1 font-mono text-[11px] text-ink">{plain}</code>
          <div className="mt-1.5 text-[10px] text-dim">
            用法：<code className="font-mono">curl -H "Authorization: Bearer $TOKEN" /v1/datasets/&lt;id&gt;/experiments/&lt;expId&gt;/analysis</code>
          </div>
        </div>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-line/60">
          {list.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-4 py-2 text-[11px]">
              <span className="text-ink">{t.name}</span>
              <span className="rounded bg-panel2 px-1 py-0.5 font-mono text-[9.5px] text-dim">…{t.tail}</span>
              <span className="text-[10px] text-muted">{t.role}</span>
              <span className="text-[10px] text-dim">
                {t.revokedAt ? '已吊销' : `上次使用 ${shortTime(t.lastUsedAt)}`}
              </span>
              {!t.revokedAt && (
                <button
                  onClick={async () => {
                    onErr(null);
                    try {
                      await api(`/tokens/${t.id}`, { method: 'DELETE' });
                      onMsg('已吊销');
                      await load();
                    } catch (e) {
                      onErr((e as Error).message);
                    }
                  }}
                  className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-noship hover:bg-noship/10"
                >
                  吊销
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line px-4 py-3">
        <div className="flex flex-wrap items-end gap-1.5">
          <input
            placeholder="token 名称（审计里靠它认人，如 ci-bot）"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-64 rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            className="rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
          >
            {(['viewer', 'analyst', 'admin'] as Role[]).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!form.name}
            onClick={async () => {
              onErr(null);
              try {
                const r = await api<{ token: string }>('/tokens', { method: 'POST', body: JSON.stringify(form) });
                setPlain(r.token);
                setForm({ name: '', role: 'viewer' });
                await load();
              } catch (e) {
                onErr((e as Error).message);
              }
            }}
          >
            <KeyRound size={11} /> 生成
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* ───────────── 审计 ───────────── */

function AuditTab({ onErr }: { onErr: (s: string | null) => void }) {
  const [list, setList] = useState<CloudAudit[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ entries: CloudAudit[] }>('/audit?limit=200');
        setList(r.entries);
      } catch (e) {
        onErr((e as Error).message);
      }
    })();
  }, [onErr]);

  return (
    <Panel>
      <PanelHead
        title={`审计日志（最近 ${list.length} 条）`}
        hint="只追加的 JSONL：谁在什么时候动了哪条记录。没有它，「三个月后为什么这么定」就只能靠记忆"
      />
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[680px] text-[11px]">
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-line text-[10px] text-dim">
              <th className="px-4 py-1.5 text-left font-medium">时间</th>
              <th className="px-2 py-1.5 text-left font-medium">谁</th>
              <th className="px-2 py-1.5 text-left font-medium">角色</th>
              <th className="px-2 py-1.5 text-left font-medium">动作</th>
              <th className="px-4 py-1.5 text-left font-medium">对象</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="border-b border-line/50">
                <td className="num px-4 py-1.5 text-dim">{shortTime(e.at)}</td>
                <td className="px-2 py-1.5 text-muted">{e.actor}</td>
                <td className="px-2 py-1.5 text-dim">{e.actorRole}</td>
                <td className="px-2 py-1.5 font-mono text-[10px] text-ink">{e.action}</td>
                <td className="px-4 py-1.5 text-dim" title={e.detail ?? ''}>
                  {e.target}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
