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
  fmtCI,
  fmtDiff,
  fmtLevel,
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
import { ForecastPanel } from './Forecast';
import { SequentialPanel } from './SequentialPanel';
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
  const P = analysis.primary;

  const forestRows = useMemo<ForestRow[]>(() => {
    const seg = (s: Analysis['segments']['tenure'][number]) => ({
      label: `分层 · ${s.label}`,
      sublabel: `q=${s.q.toFixed(2)}`,
      diff: s.diff,
      ci: s.ci95,
      p: s.p,
    });
    return [
      {
        label: '整体',
        sublabel: `n=${fmtNum(analysis.overall.n1 + analysis.overall.n2)}`,
        diff: analysis.primary.diff,
        ci: analysis.primary.ci95,
        p: analysis.primary.p,
        emphasized: true,
      },
      ...analysis.segments.tenure.map(seg),
      ...analysis.segments.device.map(seg),
    ];
  }, [analysis]);

  function runRecalc() {
    const t0 = performance.now();
    const again = analyze(exp, rows);
    const ms = performance.now() - t0;
    const same =
      again.decision === analysis.decision &&
      Math.abs(again.primary.diff - analysis.primary.diff) < 1e-12 &&
      Math.abs(again.primary.p - analysis.primary.p) < 1e-12 &&
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
            <span>
              主指标 {P.label}（{P.kind === 'continuous' ? '连续 / 元' : '二值'}）
            </span>
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

      {analysis.metricFallback && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-iterate/40 bg-iterate/10 px-3 py-2 text-[11.5px] leading-5 text-iterate">
          <CircleHelp size={13} className="mt-0.5 shrink-0" />
          <span>{analysis.metricFallback}</span>
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
            <Metric label="绝对差值" value={fmtDiff(P.diff, P.unit)} cls={liftClass(P.diff)} />
            <Metric label="p 值" value={fmtP(P.p)} />
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
            ok={P.p < 0.05}
            icon={<Sparkles size={13} />}
            title="主指标显著性"
            detail={`${P.label} 95% CI ${fmtCI(P.ci95, P.unit)}`}
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

      {/* 贝叶斯视角 */}
      <Panel className="mt-4">
        <PanelHead
          title="贝叶斯视角"
          hint={
            P.kind === 'continuous'
              ? '连续指标没有「计数/样本量」结构，共轭先验是正态而不是 Beta；公式与 Beta 版逐字对应，两种口径的概率可以直接横向比'
              : '在频率派结论之外，把两变体当作 Beta 后验，给出「treatment 真比 control 好」的概率与可信区间'
          }
          right={
            <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
              {P.kind === 'continuous' ? '正态后验 N(Δ, SE²)' : 'Beta-Binomial 后验'}
            </span>
          }
        />
        <div className="grid gap-px bg-line sm:grid-cols-4">
          <BayesCell
            label="treatment 更优概率"
            value={fmtProb(analysis.bayes.probTreatBetter)}
            cls={analysis.bayes.probTreatBetter > 0.95 ? 'text-ship' : analysis.bayes.probTreatBetter < 0.5 ? 'text-noship' : 'text-ink'}
          />
          <BayesCell label="95% 可信区间" value={fmtCI([analysis.bayes.credLow, analysis.bayes.credHigh], P.unit)} />
          <BayesCell label="后验均值差" value={fmtDiff(analysis.bayes.meanDiff, P.unit)} cls={liftClass(analysis.bayes.meanDiff)} />
          <BayesCell
            label="期望损失（误上）"
            value={fmtDiff(analysis.bayes.expectedLoss, P.unit)}
            cls={analysis.bayes.expectedLoss > (P.unit === '元' ? 0.05 : 0.002) ? 'text-iterate' : 'text-muted'}
          />
        </div>
        <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
          P(B&gt;A) 是「treatment 真的比 control 好」的<b className="text-ink">后验概率</b>，与频率派的 p 值口径不同但结论互补；
          期望损失 = 若误判上线、treatment 实际更差时，平均会损失多少{P.unit === '元' ? '元（每曝光）' : '个百分点'}。
          {analysis.cuped && analysis.cuped.dispersion > 1.1 && (
            <>
              {' '}本实验过离散因子 φ = {analysis.cuped.dispersion.toFixed(2)}，后验已按有效样本量 n/φ 折算——
              不折算的话后验会过度自信（A/A 下 P(B&gt;A)&gt;95% 的比例实测会到 9.5%，理论应为 5%）。
            </>
          )}
        </p>
      </Panel>

      {/* CUPED 方差缩减 */}
      {analysis.cuped && (
        <Panel className="mt-4">
          <PanelHead
            title="CUPED 方差缩减"
            hint="用同一批人在实验前的同口径表现做协变量，把「这批人本来就活跃/不活跃」的方差扣掉"
            right={
              <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
                {analysis.cuped.nCells} 个格子 · ρ = {analysis.cuped.rho.toFixed(3)}
              </span>
            }
          />
          <div className="grid gap-px bg-line sm:grid-cols-4">
            <BayesCell
              label="方差缩减"
              value={`${(analysis.cuped.varReduction * 100).toFixed(1)}%`}
              cls={analysis.cuped.varReduction > 0.05 ? 'text-ship' : 'text-muted'}
            />
            <BayesCell
              label="SE 变化"
              value={`${fmtDiff(analysis.cuped.seRaw, P.unit)} → ${fmtDiff(analysis.cuped.seAdj, P.unit)}`}
            />
            <BayesCell
              label="差值变化"
              value={`${fmtDiff(analysis.cuped.diffRaw, P.unit)} → ${fmtDiff(analysis.cuped.diffAdj, P.unit)}`}
              cls={liftClass(analysis.cuped.diffAdj)}
            />
            <BayesCell
              label="过离散因子 φ"
              value={P.kind === 'continuous' ? '不适用' : analysis.cuped.dispersion.toFixed(2)}
              cls={analysis.cuped.dispersion > 1.2 ? 'text-iterate' : 'text-muted'}
            />
          </div>
          <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
            θ = {analysis.cuped.theta.toFixed(4)}；
            未调整 p = {analysis.cuped.pRaw < 0.001 ? '<0.001' : analysis.cuped.pRaw.toFixed(3)}，
            CUPED p = {analysis.cuped.pAdj < 0.001 ? '<0.001' : analysis.cuped.pAdj.toFixed(3)}
            （t 分布，df = {analysis.cuped.df}）。
            {analysis.primary.via === 'cuped' ? (
              <>
                {' '}当前决策<b className="text-ink">采用 CUPED 口径</b>。
                {P.kind === 'continuous' ? (
                  <>
                    {' '}ARPU 的协变量是<b className="text-ink">同一批人在实验前的收入</b>（preRevenue），
                    连续指标没有二项过离散，所以 φ 固定为 1。
                  </>
                ) : (
                  <>
                    {' '}注意：φ = {analysis.cuped.dispersion.toFixed(2)} &gt; 1 说明格子级基线存在漂移，
                    标准误是<b className="text-ink">从格子间离散程度直接估的</b>，不是 p(1−p)/n——
                    修好误报率的是这一步，CUPED 的功劳是把它收窄的区间又赚回来一点。
                  </>
                )}
              </>
            ) : (
              ' 当前决策未采用 CUPED 口径（可在设置页开启）。'
            )}
          </p>
        </Panel>
      )}

      {/* 序贯监控：偷看校正 */}
      <SequentialPanel analysis={analysis} />

      {/* 还要跑几天 */}
      <ForecastPanel
        rows={rows}
        diff={P.diff}
        se={P.se}
        kind={P.kind}
        baselineValue={P.controlValue}
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Panel>
          <PanelHead
            title="差值 95% 置信区间"
            hint={
              P.kind === 'continuous'
                ? '点 = ARPU 差值，横线 = delta method 的 t 区间；线跨过 0 即为不显著'
                : '点 = 差值，横线 = Newcombe 95% CI；线跨过 0 即为不显著'
            }
            right={<span className="text-[10px] text-dim">n = {fmtNum(analysis.overall.n1 + analysis.overall.n2)}</span>}
          />
          <div className="px-3 py-2">
            <Forest rows={forestRows} unit={P.unit} />
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="分日趋势"
            hint={P.kind === 'continuous' ? '按曝光加权的日 ARPU（control vs treatment）' : '按曝光加权的日转化率（control vs treatment）'}
          />
          <div className="px-2 py-2">
            <Trend rows={rows} kind={P.kind} />
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHead
          title="指标明细"
          hint="所有数值由统计引擎计算；点击右上角「证据链」可查看每条结论的公式与来源"
          right={
            <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
              α = 0.05 · q = 0.10 · 口径 {P.via}
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[11px] text-dim">
                <th className="px-4 py-2 font-medium">指标 / 变体</th>
                <th className="px-3 py-2 text-right font-medium">样本</th>
                <th className="px-3 py-2 text-right font-medium">分子</th>
                <th className="px-3 py-2 text-right font-medium">水平</th>
                <th className="px-3 py-2 text-right font-medium">绝对差值</th>
                <th className="px-3 py-2 text-right font-medium">95% CI</th>
                <th className="px-3 py-2 text-right font-medium">相对提升</th>
                <th className="px-4 py-2 text-right font-medium">p</th>
              </tr>
            </thead>
            <tbody className="num">
              <MetricRows
                title={`主指标 · ${P.label}`}
                unit={P.unit}
                rows={[
                  { v: 'control', n: analysis.overall.n1, num: analysis.overall.c1, level: P.controlValue },
                  { v: 'treatment', n: analysis.overall.n2, num: analysis.overall.c2, level: P.treatmentValue },
                ]}
                diff={P.diff}
                ci={P.ci95}
                rel={P.relativeLift}
                p={P.p}
                numLabel={P.kind === 'continuous' ? '收入(元)' : '转化'}
                numFmt={(v) => (P.kind === 'continuous' ? v.toFixed(0) : fmtNum(v))}
              />
              {analysis.arpu && P.kind === 'rate' && (
                <MetricRows
                  title="副指标 · ARPU（不参与决策）"
                  unit="元"
                  rows={[
                    { v: 'control', n: analysis.arpu.n1, num: analysis.arpu.sum1, level: analysis.arpu.controlValue },
                    { v: 'treatment', n: analysis.arpu.n2, num: analysis.arpu.sum2, level: analysis.arpu.treatmentValue },
                  ]}
                  diff={analysis.arpu.diff}
                  ci={analysis.arpu.ci95}
                  rel={analysis.arpu.relativeLift}
                  p={analysis.arpu.p}
                  numLabel="收入(元)"
                  numFmt={(v) => v.toFixed(0)}
                />
              )}
              {analysis.arpu && P.kind === 'continuous' && (
                <MetricRows
                  title="副指标 · 支付转化率"
                  unit="pp"
                  rows={[
                    { v: 'control', n: analysis.overall.n1, num: analysis.overall.c1, level: analysis.overall.controlRate },
                    { v: 'treatment', n: analysis.overall.n2, num: analysis.overall.c2, level: analysis.overall.treatmentRate },
                  ]}
                  diff={analysis.overall.diff}
                  ci={analysis.overall.ci95}
                  rel={analysis.overall.relativeLift}
                  p={analysis.overall.p}
                  numLabel="转化"
                  numFmt={(v) => fmtNum(v)}
                />
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ARPU 因子分解：ARPU 变了，是「更多人买」还是「单笔更贵」 */}
      {analysis.arpuBreakdown && (
        <ArpuPanel analysis={analysis} />
      )}

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
            <SegmentBlock title="按新老用户" rows={analysis.segments.tenure} unit={P.unit} />
            <SegmentBlock title="按设备" rows={analysis.segments.device} unit={P.unit} />
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
          dataset.groundTruth === false ? (
            <div className="border-t border-line px-4 py-3 text-[11px] leading-5 text-dim">
              该数据为<b className="text-ink"> 导入数据，不含已知真值</b>，真值对比不可用。引擎判定仅基于数据本身（见上方证据链）。
              <div className="mt-1.5">
                数据类型：<span className="text-muted">{ARCHETYPE_LABEL[exp.archetype] ?? '未知'}</span> · 导入时间{' '}
                <InlineCode>{datasetVersion(dataset.generatedAt)}</InlineCode>
              </div>
            </div>
          ) : (
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
          )
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

/** 概率格式：99.9% 以上显示「>99.9%」，避免「100.0%」过度承诺 */
function fmtProb(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 0.999) return '>99.9%';
  return `${(v * 100).toFixed(1)}%`;
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
  unit,
}: {
  title: string;
  rows: Analysis['segments']['tenure'];
  unit: 'pp' | '元';
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
              <td className="px-2 py-1.5 text-right text-muted">{fmtLevel(s.controlValue, unit)}</td>
              <td className="px-2 py-1.5 text-right text-muted">{fmtLevel(s.treatmentValue, unit)}</td>
              <td className={cx('px-2 py-1.5 text-right font-medium', liftClass(s.diff))}>{fmtDiff(s.diff, unit)}</td>
              <td className="px-2 py-1.5 text-right text-dim">{fmtP(s.p)}</td>
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

/** 指标明细里的一个指标组（主指标 / 副指标共用同一套列） */
function MetricRows({
  title,
  unit,
  rows,
  diff,
  ci,
  rel,
  p,
  numLabel,
  numFmt,
}: {
  title: string;
  unit: 'pp' | '元';
  rows: { v: string; n: number; num: number; level: number }[];
  diff: number;
  ci: [number, number];
  rel: number;
  p: number;
  numLabel: string;
  numFmt: (v: number) => string;
}) {
  return (
    <>
      <tr className="border-b border-line/60 bg-panel2/40">
        <td colSpan={8} className="px-4 py-1.5 text-[10.5px] font-medium text-muted">
          {title} · 分子列 = {numLabel}
        </td>
      </tr>
      <tr className="border-b border-line/60">
        <td className="px-4 py-2 pl-7 text-muted">control</td>
        <td className="px-3 py-2 text-right text-muted">{fmtNum(rows[0].n)}</td>
        <td className="px-3 py-2 text-right text-muted">{numFmt(rows[0].num)}</td>
        <td className="px-3 py-2 text-right text-ink">{fmtLevel(rows[0].level, unit, 3)}</td>
        <td className="px-3 py-2 text-right text-dim">—</td>
        <td className="px-3 py-2 text-right text-dim">—</td>
        <td className="px-3 py-2 text-right text-dim">—</td>
        <td className="px-4 py-2 text-right text-dim">—</td>
      </tr>
      <tr className="border-b border-line/60">
        <td className="px-4 py-2 pl-7 text-brand2">treatment</td>
        <td className="px-3 py-2 text-right text-muted">{fmtNum(rows[1].n)}</td>
        <td className="px-3 py-2 text-right text-muted">{numFmt(rows[1].num)}</td>
        <td className="px-3 py-2 text-right text-ink">{fmtLevel(rows[1].level, unit, 3)}</td>
        <td className={cx('px-3 py-2 text-right font-medium', liftClass(diff))}>{fmtDiff(diff, unit)}</td>
        <td className="px-3 py-2 text-right text-muted">{fmtCI(ci, unit)}</td>
        <td className={cx('px-3 py-2 text-right', liftClass(diff))}>{(rel * 100).toFixed(2)}%</td>
        <td className="px-4 py-2 text-right text-ink">{fmtP(p)}</td>
      </tr>
    </>
  );
}

/**
 * ARPU 因子分解面板。
 *
 * 这是 ARPU 作为主指标时最值钱的一块：ARPU 涨了不等于「用户更愿意买」，
 * 打折拉量会让转化率↑、客单价↓，两者相抵后 ARPU 可能纹丝不动。
 * 三条贡献是恒等式（严格相加等于总差值），不是事后解释。
 */
function ArpuPanel({ analysis }: { analysis: Analysis }) {
  const b = analysis.arpuBreakdown!;
  const total = b.total;
  const parts = [
    { k: '转化率', v: b.fromCvr, why: `AOV_c·ΔCVR` },
    { k: '客单价', v: b.fromAov, why: `CVR_c·ΔAOV` },
    { k: '交叉项', v: b.fromInteraction, why: `ΔCVR·ΔAOV` },
  ];
  const scale = Math.max(...parts.map((x) => Math.abs(x.v)), Math.abs(total), 1e-9);
  return (
    <Panel className="mt-4">
      <PanelHead
        title="ARPU 因子分解"
        hint="ARPU = 转化率 × 客单价。两条路径可以反向抵消，只看 ARPU 总量会看不出到底发生了什么"
        right={
          <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
            Δ = AOV·ΔCVR + CVR·ΔAOV + ΔCVR·ΔAOV
          </span>
        }
      />
      <div className="grid gap-px bg-line sm:grid-cols-2">
        <div className="bg-panel px-4 py-2.5">
          <div className="text-[10.5px] text-dim">两个因子各自的变化</div>
          <div className="num mt-1 space-y-1 text-[12px]">
            <div className="flex justify-between gap-3">
              <span className="text-muted">转化率</span>
              <span className="text-ink">
                {fmtPct(b.controlCvr, 3)} → {fmtPct(b.treatmentCvr, 3)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">客单价</span>
              <span className="text-ink">
                {b.controlAov.toFixed(2)}元 → {b.treatmentAov.toFixed(2)}元
              </span>
            </div>
            <div className="flex justify-between gap-3 border-t border-line/60 pt-1">
              <span className="text-muted">ARPU 合计</span>
              <span className={cx('font-medium', liftClass(total))}>
                {total >= 0 ? '+' : ''}
                {total.toFixed(3)}元
              </span>
            </div>
          </div>
        </div>
        <div className="bg-panel px-4 py-2.5">
          <div className="text-[10.5px] text-dim">各自贡献（元 / 曝光）</div>
          <div className="mt-1.5 space-y-1.5">
            {parts.map((x) => (
              <div key={x.k}>
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-muted">
                    {x.k} <span className="font-mono text-[9.5px] text-dim">{x.why}</span>
                  </span>
                  <span className={cx('num font-medium', liftClass(x.v))}>
                    {x.v >= 0 ? '+' : ''}
                    {x.v.toFixed(3)}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (Math.abs(x.v) / scale) * 100)}%`,
                      background: x.v >= 0 ? '#15803d' : '#be123c',
                      opacity: 0.75,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
        三项相加<b className="text-ink">严格等于</b> ARPU 总差值（恒等式，不是近似拟合）。
        {b.fromCvr * b.fromAov < 0
          ? ' 注意这里两块贡献方向相反——只看 ARPU 总量会误判成「没什么变化」，' +
            '实际是「更多人买」和「单笔更便宜」相互抵消，业务含义完全不同。'
          : ' 两块贡献同向，说明是「更多人买」与「单笔更贵」共同发力。'}
      </p>
    </Panel>
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

function BayesCell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-2.5">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-[14px] font-semibold', cls ?? 'text-ink')}>{value}</div>
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
