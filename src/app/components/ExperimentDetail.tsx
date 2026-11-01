import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  CircleHelp,
  Download,
  FlaskConical,
  ListTree,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { analyze } from '../../lib/decide.ts';
import type { DailyRow, Dataset, Experiment } from '../../lib/types.ts';
import {
  ARCHETYPE_LABEL,
  DECISION_META,
  REASON_META,
  fmtNum,
  fmtP,
  fmtPP,
  fmtPct,
  liftClass,
  toneBg,
  toneStroke,
  type Tone,
} from '../lib/format';
import { Forest, type ForestRow } from './Forest';
import { Trend } from './Trend';
import { EvidenceDrawer } from './EvidenceDrawer';
import { exportConclusionCard } from '../lib/exportCard';
import { AgentPanel } from './AgentPanel';
import type { AgentCtx } from '../../lib/agent/types.ts';
import type { Analysis as AnalysisT } from '../../lib/decide.ts';
import { Button, DecisionBadge, InlineCode, Panel, PanelHead, cx } from './ui';

type Tab = 'segments' | 'guardrails' | 'calc';

export function ExperimentDetail({
  exp,
  analysis,
  rows,
  dataset,
  analyses,
  initialEv,
  onBack,
}: {
  exp: Experiment;
  analysis: Analysis;
  rows: DailyRow[];
  dataset: Dataset;
  analyses: Map<string, AnalysisT>;
  initialEv?: string | null;
  onBack: () => void;
}) {
  const [drawer, setDrawer] = useState(!!initialEv);
  const [focusEv, setFocusEv] = useState<string | null>(initialEv ?? null);
  const [tab, setTab] = useState<Tab>('segments');
  const [showTruth, setShowTruth] = useState(false);
  const [recalc, setRecalc] = useState<{ ok: boolean; ms: number; n: number } | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'ok' | 'err'>('idle');
  const [agentOpen, setAgentOpen] = useState(false);

  function closeDrawer() {
    setDrawer(false);
    setFocusEv(null);
    if (initialEv) window.history.replaceState(null, '', `#/e/${exp.id}`);
  }

  async function onExport() {
    try {
      await exportConclusionCard(exp, analysis, {
        datasetVersion: datasetVersion(dataset.generatedAt),
        seed: String(dataset.seedBase),
      });
      setExportState('ok');
    } catch (e) {
      console.error(e);
      setExportState('err');
    } finally {
      setTimeout(() => setExportState('idle'), 2600);
    }
  }

  const meta = DECISION_META[analysis.decision];
  const tone = meta.tone as Tone;

  const forestRows = useMemo<ForestRow[]>(() => {
    const rowsOut: ForestRow[] = [
      {
        label: '整体',
        sublabel: `n=${fmtNum(analysis.overall.n1 + analysis.overall.n2)}`,
        diff: analysis.overall.diff,
        ci: analysis.overall.ci95,
        p: analysis.overall.p,
        emphasized: true,
      },
      ...analysis.segments.tenure.map((s) => ({
        label: `分层 · ${s.label}`,
        sublabel: `q=${s.q.toFixed(2)}`,
        diff: s.test.diff,
        ci: s.test.ci95,
        p: s.test.p,
      })),
      ...analysis.segments.device.map((s) => ({
        label: `分层 · ${s.label}`,
        sublabel: `q=${s.q.toFixed(2)}`,
        diff: s.test.diff,
        ci: s.test.ci95,
        p: s.test.p,
      })),
    ];
    return rowsOut;
  }, [analysis]);

  function runRecalc() {
    const t0 = performance.now();
    const again = analyze(exp, rows);
    const ms = performance.now() - t0;
    const same =
      again.decision === analysis.decision &&
      Math.abs(again.overall.diff - analysis.overall.diff) < 1e-12 &&
      Math.abs(again.overall.p - analysis.overall.p) < 1e-12 &&
      again.evidence.length === analysis.evidence.length;
    setRecalc({ ok: same, ms, n: again.evidence.length });
  }

  const truthMatch = exp.trueDecision === analysis.decision;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-6">
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} /> 返回实验列表
      </button>

      <div className="anim-up flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-line bg-panel2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
              {exp.id}
            </span>
            <h1 className="text-[24px] font-semibold tracking-tight text-ink">{exp.name}</h1>
          </div>
          <p className="mt-1.5 max-w-[680px] text-[13px] leading-6 text-muted">{exp.hypothesis}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
            <span>
              {exp.startDate} → {exp.endDate}
            </span>
            <span>分流 {exp.trafficSplit}</span>
            <span>主指标 {exp.primaryMetric}（二值）</span>
            <span>护栏 {exp.guardrailMetrics.join(' / ')}</span>
            <span className="font-mono">seed {exp.seed}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={runRecalc}>
            <RefreshCw size={13} /> 一键复算
          </Button>
          <Button variant="outline" size="sm" onClick={onExport} title="把结论卡导出为 PNG，可直接贴到文档或简历">
            {exportState === 'ok' ? <BadgeCheck size={13} className="text-ship" /> : <Download size={13} />}
            {exportState === 'ok' ? '已导出' : exportState === 'err' ? '导出失败' : '导出结论卡'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAgentOpen(true)}>
            <MessageSquare size={13} /> 问这个实验
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setFocusEv(null);
              setDrawer(true);
            }}
          >
            <ListTree size={13} /> 证据链（{analysis.evidence.length}）
          </Button>
        </div>
      </div>

      {recalc && (
        <div
          className={cx(
            'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11.5px]',
            recalc.ok
              ? 'border-ship/30 bg-ship/10 text-ship'
              : 'border-noship/40 bg-noship/10 text-noship',
          )}
        >
          <BadgeCheck size={13} />
          {recalc.ok
            ? `复算一致：重新计算 ${recalc.n} 条证据，决策与全部关键数值逐位相同（${recalc.ms.toFixed(1)}ms）`
            : '复算不一致——数据与引擎版本可能已变化，请检查'}
        </div>
      )}

      {/* 结论卡 */}
      <Panel
        className="mt-4 overflow-hidden"
        style={{ borderColor: `${toneStroke(tone)}55` }}
      >
        <div
          className="flex flex-wrap items-start gap-5 px-5 py-4"
          style={{
            background: `linear-gradient(100deg, ${toneStroke(tone)}0f, transparent 58%)`,
          }}
        >
          <div className="min-w-[190px]">
            <div className="flex items-center gap-2 text-[11px] text-dim">
              <Sparkles size={12} /> 引擎结论
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-[28px] font-semibold tracking-tight" style={{ color: toneStroke(tone) }}>
                {meta.label}
              </span>
            </div>
            <span
              className={cx(
                'mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] ring-1 ring-inset',
                toneBg(tone),
              )}
            >
              规则 {analysis.reasonCode} · {REASON_META[analysis.reasonCode]}
            </span>
          </div>

          <p className="min-w-[260px] flex-1 text-[13px] leading-6 text-ink/90">{analysis.reason}</p>

          <div className="grid grid-cols-3 gap-4 border-l border-line pl-5">
            <Metric label="绝对差值" value={fmtPP(analysis.overall.diff)} cls={liftClass(analysis.overall.diff)} />
            <Metric label="p 值" value={fmtP(analysis.overall.p)} />
            <Metric
              label="总样本"
              value={fmtNum(analysis.overall.n1 + analysis.overall.n2)}
              sub={`${fmtNum(analysis.overall.n1)} / ${fmtNum(analysis.overall.n2)}`}
            />
          </div>
        </div>

        {/* 三条硬前置检查 */}
        <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
          <Check
            ok={!analysis.srm.flagged}
            icon={<FlaskConical size={13} />}
            title="SRM 分流检查"
            detail={`相对偏差 ${(analysis.srm.relImb * 100).toFixed(2)}%，p=${fmtP(analysis.srm.p)}`}
          />
          <Check
            ok={analysis.overall.p < 0.05}
            icon={<Sparkles size={13} />}
            title="主指标显著性"
            detail={`95% CI [${(analysis.overall.ci95[0] * 100).toFixed(2)}, ${(analysis.overall.ci95[1] * 100).toFixed(2)}]pp`}
          />
          <Check
            ok={!analysis.guardrails.some((g) => g.gating && g.worse)}
            icon={<ShieldAlert size={13} />}
            title="护栏"
            detail={
              analysis.guardrails.find((g) => g.gating && g.worse)
                ? `${analysis.guardrails.find((g) => g.gating && g.worse)!.label}显著恶化`
                : '硬护栏未触发'
            }
          />
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Panel>
          <PanelHead
            title="差值 95% 置信区间"
            hint="点 = 差值，横线 = Newcombe 95% CI；线跨过 0 即为不显著"
            right={<span className="text-[10px] text-dim">n = {fmtNum(analysis.overall.n1 + analysis.overall.n2)}</span>}
          />
          <div className="px-3 py-2">
            <Forest rows={forestRows} />
          </div>
        </Panel>

        <Panel>
          <PanelHead title="分日趋势" hint="按曝光加权的日转化率（control vs treatment）" />
          <div className="px-2 py-2">
            <Trend rows={rows} />
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHead
          title="指标明细"
          hint="所有数值由统计引擎计算；点击右上角「证据链」可查看每条结论的公式与来源"
          right={
            <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
              α = 0.05 · q = 0.10
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[11px] text-dim">
                <th className="px-4 py-2 font-medium">变体</th>
                <th className="px-3 py-2 text-right font-medium">样本</th>
                <th className="px-3 py-2 text-right font-medium">转化</th>
                <th className="px-3 py-2 text-right font-medium">转化率</th>
                <th className="px-3 py-2 text-right font-medium">绝对差值</th>
                <th className="px-3 py-2 text-right font-medium">95% CI</th>
                <th className="px-3 py-2 text-right font-medium">相对提升</th>
                <th className="px-4 py-2 text-right font-medium">p</th>
              </tr>
            </thead>
            <tbody className="num">
              <tr className="border-b border-line/60">
                <td className="px-4 py-2 text-muted">control</td>
                <td className="px-3 py-2 text-right text-muted">{fmtNum(analysis.overall.n1)}</td>
                <td className="px-3 py-2 text-right text-muted">{fmtNum(analysis.overall.c1)}</td>
                <td className="px-3 py-2 text-right text-ink">{fmtPct(analysis.overall.controlRate, 3)}</td>
                <td className="px-3 py-2 text-right text-dim">—</td>
                <td className="px-3 py-2 text-right text-dim">—</td>
                <td className="px-3 py-2 text-right text-dim">—</td>
                <td className="px-4 py-2 text-right text-dim">—</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-brand2">treatment</td>
                <td className="px-3 py-2 text-right text-muted">{fmtNum(analysis.overall.n2)}</td>
                <td className="px-3 py-2 text-right text-muted">{fmtNum(analysis.overall.c2)}</td>
                <td className="px-3 py-2 text-right text-ink">{fmtPct(analysis.overall.treatmentRate, 3)}</td>
                <td className={cx('px-3 py-2 text-right font-medium', liftClass(analysis.overall.diff))}>
                  {fmtPP(analysis.overall.diff)}
                </td>
                <td className="px-3 py-2 text-right text-muted">
                  [{(analysis.overall.ci95[0] * 100).toFixed(2)}, {(analysis.overall.ci95[1] * 100).toFixed(2)}]pp
                </td>
                <td className={cx('px-3 py-2 text-right', liftClass(analysis.overall.diff))}>
                  {(analysis.overall.relativeLift * 100).toFixed(2)}%
                </td>
                <td className="px-4 py-2 text-right text-ink">{fmtP(analysis.overall.p)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Tabs：分层 / 护栏 / 计算过程 */}
      <Panel className="mt-4 overflow-hidden">
        <div className="flex items-center gap-1 border-b border-line px-3 py-2">
          {(
            [
              ['segments', '分层明细', ListTree],
              ['guardrails', '护栏指标', ShieldAlert],
              ['calc', '计算过程', CircleHelp],
            ] as [Tab, string, typeof ListTree][]
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                tab === k ? 'bg-brand/15 text-brand2' : 'text-muted hover:bg-panel2 hover:text-ink',
              )}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        {tab === 'segments' && (
          <div className="grid gap-px bg-line md:grid-cols-2">
            <SegmentBlock title="按新老用户" rows={analysis.segments.tenure} />
            <SegmentBlock title="按设备" rows={analysis.segments.device} />
          </div>
        )}

        {tab === 'guardrails' && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line text-[11px] text-dim">
                  <th className="px-4 py-2 font-medium">指标</th>
                  <th className="px-3 py-2 text-right font-medium">control</th>
                  <th className="px-3 py-2 text-right font-medium">treatment</th>
                  <th className="px-3 py-2 text-right font-medium">差值</th>
                  <th className="px-3 py-2 text-right font-medium">p</th>
                  <th className="px-3 py-2 text-center font-medium">参与决策</th>
                  <th className="px-4 py-2 text-right font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="num">
                {analysis.guardrails.map((g) => {
                  const isMs = g.key === 'latency_p95';
                  const f = (v: number) => (isMs ? `${v.toFixed(0)}ms` : `${(v * 100).toFixed(2)}%`);
                  const fd = (v: number) =>
                    isMs ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}ms` : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`;
                  return (
                    <tr key={g.key} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-2 text-ink">{g.label}</td>
                      <td className="px-3 py-2 text-right text-muted">{f(g.controlRate)}</td>
                      <td className="px-3 py-2 text-right text-muted">{f(g.treatmentRate)}</td>
                      <td className={cx('px-3 py-2 text-right', g.diff > 0 && isMs ? 'text-iterate' : liftClass(-g.diff))}>
                        {fd(g.diff)}
                      </td>
                      <td className="px-3 py-2 text-right text-muted">{fmtP(g.p)}</td>
                      <td className="px-3 py-2 text-center">
                        {g.gating ? (
                          <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] text-brand2">硬门槛</span>
                        ) : (
                          <span className="text-[10px] text-dim">仅展示</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {g.worse ? (
                          <span className="text-[11px] font-medium text-noship">显著恶化</span>
                        ) : (
                          <span className="text-[11px] text-dim">未恶化</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
              只有「退款率」是硬门槛：α=0.01 且绝对恶化 &gt; 0.4pp（相对 +33%）才判恶化。投诉率基线仅 0.12%，
              随机波动就会误报，v1 只展示不拦截；P95 延迟同理。
            </p>
          </div>
        )}

        {tab === 'calc' && <CalcSteps analysis={analysis} />}
      </Panel>

      {/* 真值对照（合成数据才有） */}
      <Panel className="mt-4">
        <button
          onClick={() => setShowTruth((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <div className="text-[13px] font-medium text-ink">真值对照（仅合成数据可见）</div>
            <div className="mt-0.5 text-[11px] text-dim">
              数据由生成器注入真实效应，因此可以检验引擎结论对不对；真实业务数据没有这一列
            </div>
          </div>
          <ChevronDown
            size={16}
            className={cx('shrink-0 text-dim transition-transform', showTruth && 'rotate-180')}
          />
        </button>
        {showTruth && (
          <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            <TruthCell label="注入的真实效应" value={fmtPP(exp.trueLiftOverall)} cls={liftClass(exp.trueLiftOverall)} />
            <TruthCell
              label="效应范围"
              value={exp.trueLiftScope === 'overall' ? '整体' : `仅新用户（${fmtPP(exp.trueLift)}）`}
            />
            <TruthCell label="真实决策" value={DECISION_META[exp.trueDecision].label} />
            <TruthCell
              label="引擎判定"
              value={truthMatch ? '一致 ✓' : '不一致 ✗'}
              cls={truthMatch ? 'text-ship' : 'text-noship'}
              sub={truthMatch ? undefined : '属于已知误差，见评测看板'}
            />
            <div className="sm:col-span-2 lg:col-span-4 px-4 py-2.5 text-[11px] text-dim">
              实验类型：<span className="text-muted">{ARCHETYPE_LABEL[exp.archetype]}</span> · 数据版本{' '}
              <InlineCode>{datasetVersion(dataset.generatedAt)}</InlineCode> · 生成种子{' '}
              <InlineCode>{String(dataset.seedBase)}</InlineCode>
            </div>
          </div>
        )}
      </Panel>

      <AgentPanel
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        ctx={{ dataset, analyses, exp, analysis } as AgentCtx}
        onCite={(ev) => {
          setAgentOpen(false);
          setFocusEv(ev);
          setDrawer(true);
        }}
      />

      <EvidenceDrawer
        open={drawer}
        onClose={closeDrawer}
        exp={exp}
        analysis={analysis}
        onRecalc={runRecalc}
        recalc={recalc}
        focusId={focusEv}
      />
    </div>
  );
}

/** 2026-10-31T14:43:34.299Z → 2026-10-31 22:43 */
function datasetVersion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Metric({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="min-w-[76px]">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-[15px] font-semibold', cls ?? 'text-ink')}>{value}</div>
      {sub && <div className="num text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

function Check({
  ok,
  icon,
  title,
  detail,
}: {
  ok: boolean;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2.5 bg-panel px-4 py-3">
      <span className={cx('mt-0.5', ok ? 'text-ship' : 'text-noship')}>{icon}</span>
      <div>
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
          {title}
          <span className={cx('text-[10px]', ok ? 'text-ship' : 'text-noship')}>{ok ? '通过' : '未通过'}</span>
        </div>
        <div className="num mt-0.5 text-[10.5px] text-dim">{detail}</div>
      </div>
    </div>
  );
}

function SegmentBlock({
  title,
  rows,
}: {
  title: string;
  rows: Analysis['segments']['tenure'];
}) {
  return (
    <div className="min-w-0 bg-panel">
      <div className="border-b border-line px-4 py-2 text-[11px] font-medium text-muted">{title}</div>
      {/* 两表并排时宽度不够就让表自己横向滚，不要把最后一列切掉 */}
      <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-[10.5px] text-dim">
            <th className="px-4 py-1.5 text-left font-medium">分层</th>
            <th className="px-2 py-1.5 text-right font-medium">control</th>
            <th className="px-2 py-1.5 text-right font-medium">treatment</th>
            <th className="px-2 py-1.5 text-right font-medium">差值</th>
            <th className="px-2 py-1.5 text-right font-medium">p</th>
            <th className="px-4 py-1.5 text-right font-medium">BH q</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((s) => (
            <tr key={s.key} className="border-t border-line/50">
              <td className="px-4 py-1.5 text-muted">{s.label}</td>
              <td className="px-2 py-1.5 text-right text-muted">{fmtPct(s.test.controlRate)}</td>
              <td className="px-2 py-1.5 text-right text-muted">{fmtPct(s.test.treatmentRate)}</td>
              <td className={cx('px-2 py-1.5 text-right font-medium', liftClass(s.test.diff))}>{fmtPP(s.test.diff)}</td>
              <td className="px-2 py-1.5 text-right text-dim">{fmtP(s.test.p)}</td>
              <td className={cx('px-4 py-1.5 text-right', s.q <= 0.1 ? 'text-brand2' : 'text-dim')}>
                {s.q.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function TruthCell({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="bg-panel px-4 py-2.5">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-[13px] font-medium', cls ?? 'text-ink')}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

/** 计算过程：把公式和代入的数字摊开，任何一条都能手算核对 */
function CalcSteps({ analysis }: { analysis: Analysis }) {
  const o = analysis.overall;
  const p1 = o.controlRate;
  const p2 = o.treatmentRate;
  const pooled = (o.c1 + o.c2) / (o.n1 + o.n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / o.n1 + 1 / o.n2));

  const steps: { title: string; formula: string; value: string }[] = [
    {
      title: '1. 各变体转化率',
      formula: 'p̂ = conversions / exposures',
      value: `p̂₁ = ${o.c1} / ${o.n1} = ${fmtPct(p1, 4)} ｜ p̂₂ = ${o.c2} / ${o.n2} = ${fmtPct(p2, 4)}`,
    },
    {
      title: '2. 合并比例与标准误',
      formula: 'p̄ = (c₁+c₂)/(n₁+n₂)，SE = √(p̄(1−p̄)(1/n₁+1/n₂))',
      value: `p̄ = ${pooled.toFixed(6)}，SE = ${se.toFixed(6)}`,
    },
    {
      title: '3. z 统计量与 p 值',
      formula: 'z = (p̂₂ − p̂₁) / SE，p = erfc(|z|/√2)',
      value: `z = ${o.z.toFixed(4)}，p = ${fmtP(o.p)}`,
    },
    {
      title: '4. 差值置信区间（Newcombe）',
      formula: '先行 Wilson 区间，再合成差值区间',
      value: `[${(o.ci95[0] * 100).toFixed(3)}, ${(o.ci95[1] * 100).toFixed(3)}]pp ${
        o.ci95[0] > 0 || o.ci95[1] < 0 ? '（不跨 0 → 显著）' : '（跨 0 → 不显著）'
      }`,
    },
    {
      title: '5. SRM 卡方',
      formula: 'χ² = Σ(obs − exp)² / exp，阈值 p<0.001 且相对偏差 >2%',
      value: `χ² = ${analysis.srm.chi2.toFixed(3)}，p = ${fmtP(analysis.srm.p)}，相对偏差 ${(
        analysis.srm.relImb * 100
      ).toFixed(3)}%`,
    },
  ];

  return (
    <div className="divide-y divide-line/60">
      {steps.map((s) => (
        <div key={s.title} className="px-4 py-2.5">
          <div className="text-[11.5px] font-medium text-ink">{s.title}</div>
          <div className="mt-1 font-mono text-[10.5px] text-dim">{s.formula}</div>
          <div className="num mt-0.5 text-[11px] text-muted">{s.value}</div>
        </div>
      ))}
      <div className="flex items-start gap-2 bg-panel2/40 px-4 py-2.5 text-[11px] leading-5 text-dim">
        <Sparkles size={12} className="mt-1 shrink-0 text-brand2" />
        这些数字全部由浏览器里的引擎实时计算（没有任何模型参与），所以刷新、复算、换机器都得到同一结果。
      </div>
    </div>
  );
}
