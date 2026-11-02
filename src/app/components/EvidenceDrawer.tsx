import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  BarChart3,
  ChevronDown,
  Check,
  Copy,
  FlaskConical,
  Gavel,
  ListTree,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { Analysis, Evidence } from '../../lib/decide.ts';
import type { Experiment } from '../../lib/types.ts';
import { fmtP } from '../lib/format';
import { absoluteUrl, copyText } from '../lib/share';
import { Button, Drawer, cx } from './ui';

/**
 * 证据条目的颜色/图标。
 *
 * 颜色都写成「浅色主题的 700 / 深色主题的 300」双档：这两种主题同时存在（#/settings 可切），
 * 只写 `text-sky-300` 会在浅色主题的白底上低对比到几乎看不见 —— 类别标签看不见，
 * 读者就分不清哪一条是护栏、哪一条是稳健性。
 */
const KIND_META: Record<Evidence['kind'], { label: string; icon: typeof FlaskConical; cls: string }> = {
  srm: { label: 'SRM', icon: FlaskConical, cls: 'text-sky-700 dark:text-sky-300 bg-sky-400/10 ring-sky-400/25' },
  metric: { label: '主指标', icon: BarChart3, cls: 'text-brand2 bg-brand/10 ring-brand/25' },
  segment: { label: '分层', icon: ListTree, cls: 'text-violet-700 dark:text-violet-300 bg-violet-400/10 ring-violet-400/25' },
  guardrail: { label: '护栏', icon: ShieldAlert, cls: 'text-amber-700 dark:text-amber-300 bg-amber-400/10 ring-amber-400/25' },
  robustness: { label: '稳健性', icon: ShieldCheck, cls: 'text-teal-700 dark:text-teal-300 bg-teal-400/10 ring-teal-400/25' },
  decision: { label: '结论', icon: Gavel, cls: 'text-emerald-700 dark:text-emerald-300 bg-emerald-400/10 ring-emerald-400/25' },
};

export function EvidenceDrawer({
  open,
  onClose,
  exp,
  analysis,
  onRecalc,
  recalc,
  focusId,
}: {
  open: boolean;
  onClose: () => void;
  exp: Experiment;
  analysis: Analysis;
  onRecalc: () => void;
  recalc: { ok: boolean; ms: number; n: number } | null;
  focusId?: string | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  // 深链打开时自动展开目标条目
  useEffect(() => {
    if (open && focusId) {
      setExpanded((prev) => ({ ...prev, [focusId]: true }));
      setTimeout(() => {
        document.getElementById(`ev-${focusId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 220);
    }
  }, [open, focusId]);

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
    requestAnimationFrame(() => {
      document.getElementById(`ev-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  async function share(evId: string) {
    const ok = await copyText(absoluteUrl(`#/e/${exp.id}?ev=${evId}`));
    if (ok) {
      setCopied(evId);
      setTimeout(() => setCopied((c) => (c === evId ? null : c)), 1600);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`证据链 · ${exp.id} ${exp.name}`}
      subtitle="每条结论都对应一条可核对的证据；点开条目可看逐步代入。模型不参与任何计算。"
      width={620}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10.5px] leading-4 text-dim">
            {recalc ? (
              <span className={recalc.ok ? 'text-ship' : 'text-noship'}>
                {recalc.ok
                  ? `✓ 复算一致（${recalc.n} 条证据，${recalc.ms.toFixed(1)}ms）`
                  : '✗ 复算结果不一致'}
              </span>
            ) : (
              '复算 = 用同一份数据重跑引擎，逐项比对数值'
            )}
          </div>
          <Button variant="primary" size="sm" onClick={onRecalc}>
            <RefreshCw size={13} /> 一键复算
          </Button>
        </div>
      }
    >
      <ol className="relative space-y-2.5 border-l border-line pl-4">
        {analysis.evidence.map((e) => {
          const meta = KIND_META[e.kind];
          const Icon = meta.icon;
          const openItem = !!expanded[e.id];
          const hasBody = e.kind === 'decision' || (e.calc && e.calc.length > 0);
          return (
            <li key={e.id} id={`ev-${e.id}`} className="relative scroll-mt-4">
              <span
                className={cx(
                  'absolute -left-[23px] top-2 h-2 w-2 rounded-full ring-4 ring-panel',
                  openItem ? 'bg-brand2' : 'bg-line2',
                )}
              />
              <div
                className={cx(
                  'rounded-lg border bg-panel2/50 transition-colors',
                  openItem ? 'border-brand/40 bg-panel2/80' : 'border-line',
                  focusId === e.id && 'ring-1 ring-brand/40',
                )}
              >
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <span
                    className={cx(
                      'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset',
                      meta.cls,
                    )}
                  >
                    <Icon size={10} /> {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <button
                      className={cx('block text-left text-[12px] font-medium text-ink', hasBody && 'hover:text-brand2')}
                      onClick={hasBody ? () => toggle(e.id) : undefined}
                      disabled={!hasBody}
                    >
                      {e.label}
                    </button>
                    <p className="num mt-1 text-[11px] leading-5 text-muted">{e.detail}</p>
                    {e.kind === 'decision' && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-ship">
                        <BadgeCheck size={11} /> 由上面全部证据按固定优先级规则推出
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => share(e.id)}
                      className="rounded p-1 text-dim transition-colors hover:bg-panel hover:text-brand2"
                      title="复制这条证据的链接"
                    >
                      {copied === e.id ? <Check size={11} className="text-ship" /> : <Copy size={11} />}
                    </button>
                    {hasBody && (
                      <button
                        onClick={() => toggle(e.id)}
                        className="rounded p-1 text-dim transition-colors hover:bg-panel hover:text-ink"
                        title={openItem ? '收起' : '展开计算过程'}
                      >
                        <ChevronDown size={12} className={cx('transition-transform', openItem && 'rotate-180')} />
                      </button>
                    )}
                    <span className="ml-0.5 font-mono text-[9.5px] text-dim">{e.id}</span>
                  </div>
                </div>

                {openItem && e.kind === 'decision' && (
                  <div className="border-t border-line/70 px-3 py-2.5">
                    <div className="mb-1.5 text-[10.5px] text-dim">
                      6 条规则按固定优先级依次判断，遇到第一条命中即停（当前命中：{analysis.reasonCode}）
                    </div>
                    <table className="w-full border-collapse text-[10.5px]">
                      <tbody>
                        {analysis.rules.map((r, i) => {
                          const hit = r.code === analysis.reasonCode;
                          return (
                            <tr key={r.code} className={cx('border-b border-line/40 last:border-0', hit && 'bg-brand/5')}>
                              <td className="py-1 pr-2 align-top text-dim">{i + 1}</td>
                              <td className="py-1 pr-2 align-top">
                                <span className={cx('font-mono', hit ? 'text-brand2' : r.hit ? 'text-iterate' : 'text-muted')}>
                                  {r.code}
                                </span>
                                <div className="text-[9.5px] text-dim">{r.condition}</div>
                              </td>
                              <td className="py-1 pr-2 align-top text-[10px] text-muted">{r.detail}</td>
                              <td className="py-1 align-top text-right">
                                {hit ? (
                                  <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[9.5px] text-brand2">命中</span>
                                ) : r.hit ? (
                                  <span className="text-[9.5px] text-dim">被更高优先级覆盖</span>
                                ) : (
                                  <span className="text-[9.5px] text-dim">未触发</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {openItem && e.kind !== 'decision' && e.calc && (
                  <div className="space-y-2 border-t border-line/70 px-3 py-2.5">
                    {e.calc.map((s) => (
                      <div key={s.title}>
                        <div className="text-[10.5px] font-medium text-ink/90">{s.title}</div>
                        <div className="mt-0.5 font-mono text-[9.5px] leading-4 text-dim">{s.formula}</div>
                        <div className="num mt-0.5 text-[10.5px] leading-4 text-muted">{s.value}</div>
                      </div>
                    ))}
                    <div className="pt-0.5 text-[9.5px] text-dim">
                      以上数值可在「计算过程」页手算复核；同一份数据每次复算结果逐位相同。
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 rounded-lg border border-line bg-panel2/40 px-3 py-3">
        <div className="text-[11px] font-medium text-ink">数据与口径</div>
        <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10.5px]">
          <Row k="主指标" v={`${exp.primaryMetric}（二值）`} />
          <Row k="检验方法" v="两比例 z（合并方差）" />
          <Row k="区间方法" v="Newcombe 混合法 95%" />
          <Row k="多重比较" v="Benjamini–Hochberg q=0.10" />
          <Row k="显著性阈值" v="α = 0.05（双侧）" />
          <Row k="SRM 阈值" v="p<0.001 且偏差>2%" />
          <Row k="样本合计" v={`${(analysis.overall.n1 + analysis.overall.n2).toLocaleString('en-US')}`} />
          <Row k="最小 p 记录" v={fmtP(Math.min(...analysis.evidence.map((x) => x.value ?? 1)))} />
        </dl>
        <p className="mt-2 text-[10px] leading-4 text-dim">
          数据为固定种子生成的合成数据（seed {exp.seed}），用于已知真值评测；不是真实业务数据。
        </p>
      </div>
    </Drawer>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/40 pb-1">
      <dt className="text-dim">{k}</dt>
      <dd className="text-right text-muted">{v}</dd>
    </div>
  );
}
