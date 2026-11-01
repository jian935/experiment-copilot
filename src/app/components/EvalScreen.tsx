import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { DECISIONS, evaluate } from '../../lib/evaluate.ts';
import type { Dataset } from '../../lib/types.ts';
import type { DecisionConfig } from '../../lib/config.ts';
import { ARCHETYPE_LABEL, DECISION_META, fmtDiff, fmtP, liftClass } from '../lib/format';
import { DecisionBadge, Panel, PanelHead, cx } from './ui';
import { C } from '../lib/palette';

interface AaReport {
  generatedAt: string;
  seedBase: number;
  trials: number;
  days: number;
  config: { alpha: number; srmAlpha: number; guardrailAlpha: number; guardrailMode: string };
  decisions: Record<string, number>;
  falsePositiveRate: number;
  shipRate: number;
  noShipRate: number;
  iterateRate: number;
  srmFlagRate: number;
  guardrailFlagRate: number;
  bayesMeanProb: number;
  bayesProbAbove095: number;
  pValueHistogram: number[];
  meanSamplePerArm: number;
}

interface Ablation {
  generatedAt: string;
  questions: number;
  experiments: string[];
  rules: { n: number; citationRate: number; suspiciousRate: number; violationRate: number; avgTools: number; avgChars: number; noDataRate: number };
  llm: Ablation['rules'] | null;
  rows: { exp: string; q: string; intent: string; cited: boolean; numbers: number; suspicious: number }[];
}

/** `data/agent_eval.json` 的形状（`npm run eval` 产出）。看板只读汇总，不读 1720 条回答全文 */
interface AgentEvalFile {
  generatedAt: string;
  seedBase: number;
  config: { alpha: number; interactionAlpha: number; segmentFdr: number; seMode?: string; useCuped?: boolean };
  summary: {
    n: number;
    numbers: number;
    suspicious: number;
    hallucinationRate: number;
    dirtyAnswerRate: number;
    citationRate: number;
    citableN: number;
    violationRate: number;
    scopeRate: number;
    trapN: number;
    routeAccuracy: number;
    routeN: number;
  };
  byGroup: { group: string; n: number; numbers: number; suspicious: number; citationRate: number; routeAccuracy: number }[];
  byIntent: { intent: string; n: number }[];
  byQa: { qaId: string; group: string; q: string; n: number; numbers: number; suspicious: number; citationRate: number; routeAccuracy: number }[];
  toolCalls: { tool: string; calls: number }[];
  uncoveredTools: string[];
  problems: { expId: string; qaId: string; q: string; suspicious: string[]; violations: string[]; answer: string }[];
}

export function EvalScreen({
  dataset,
  analyses,
  config,
  onOpen,
  onBack,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  config: DecisionConfig;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const r = useMemo(() => evaluate(dataset, analyses), [dataset, analyses]);
  const [ablation, setAblation] = useState<Ablation | null>(null);
  const [aa, setAa] = useState<AaReport | null>(null);
  const [agent, setAgent] = useState<AgentEvalFile | null>(null);
  const noTruth = dataset.groundTruth === false;

  useEffect(() => {
    let alive = true;
    const load = (name: string) =>
      fetch(`${import.meta.env.BASE_URL}data/${name}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    load('ablation.json').then((d) => alive && setAblation(d as Ablation | null));
    load('aa_report.json').then((d) => alive && setAa(d as AaReport | null));
    load('agent_eval.json').then((d) => alive && setAgent(d as AgentEvalFile | null));
    return () => {
      alive = false;
    };
  }, []);

  // 这份 Agent 评测是脚本在某个阈值下生成的；设置页改过口径后它就不再代表当前结论。
  // 不静默：显式比对五项会改变决策的阈值，不一致就提示重跑。
  const agentStale = useMemo(() => {
    if (!agent) return false;
    const c = agent.config;
    return (
      agent.seedBase !== dataset.seedBase ||
      Math.abs(c.alpha - config.alpha) > 1e-12 ||
      Math.abs(c.interactionAlpha - config.interactionAlpha) > 1e-12 ||
      Math.abs(c.segmentFdr - config.segmentFdr) > 1e-12 ||
      c.seMode !== (config.seMode ?? 'robust') ||
      c.useCuped !== (config.useCuped ?? true)
    );
  }, [agent, config, dataset.seedBase]);

  const maxCell = Math.max(1, ...r.confusion.flat());

  // 导入的真实数据通常没有已知真值：评测指标（准确率/混淆/校准）依赖真值，整体隐藏并给出说明。
  if (noTruth) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-6">
        <button
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={14} /> 返回实验列表
        </button>
        <div className="anim-up">
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">评测看板</h1>
          <p className="mt-1 text-[13px] text-muted">
            {r.n} 个导入实验 · <b className="text-ink">不含已知真值</b> · 评测指标不适用
          </p>
        </div>
        <Panel className="mt-5">
          <div className="flex items-start gap-2.5 px-4 py-4">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-iterate" />
            <div className="text-[12px] leading-5 text-muted">
              <b className="text-ink">评测看板依赖已知真值</b>（合成数据有，导入的真实数据没有），因此准确率、混淆矩阵、
              置信度校准等需要「真值对照」的指标暂不展示——展示它们会给出无意义的数字。
              <br />
              请改用 <span className="text-ink">实验列表 / 实验详情</span> 查看每个实验的分析结论、证据链与贝叶斯视角。
              若你导入的 JSON 中每个实验都带有 <code className="rounded bg-white/[0.06] px-1">trueDecision</code> 与{' '}
              <code className="rounded bg-white/[0.06] px-1">trueLiftOverall</code> 真值字段，评测看板会自动恢复。
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-6">
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} /> 返回实验列表
      </button>

      <div className="anim-up flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">评测看板</h1>
          <p className="mt-1 text-[13px] text-muted">
            {r.n} 个合成实验 · 已知真值 · 口径：引擎决策与真实决策<b className="text-ink">完全一致</b>才算对
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-dim">
          <span className="rounded-md border border-line bg-panel2/70 px-2 py-1 font-mono">seed {dataset.seedBase}</span>
          <span className="rounded-md border border-line bg-panel2/70 px-2 py-1">可复现：npm run calibrate</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="决策准确率" value={`${(r.accuracy * 100).toFixed(1)}%`} sub={`${r.correct} / ${r.n}`} tone="text-ship" />
        <Kpi label="null 误报率 (FPR)" value={`${(r.fpr.rate * 100).toFixed(1)}%`} sub={`${r.fpr.hit} / ${r.fpr.n}`} tone="text-noship" />
        <Kpi
          label="分层检测 F1"
          value={r.hetero.f1.toFixed(2)}
          sub={`95% CI ${r.hetero.f1Ci[0].toFixed(2)}–${r.hetero.f1Ci[1].toFixed(2)}`}
          tone={r.hetero.f1 >= 0.8 ? 'text-ship' : 'text-iterate'}
        />
        <Kpi
          label="幻觉数字率"
          value={agent ? `${(agent.summary.hallucinationRate * 100).toFixed(2)}%` : '—'}
          sub={agent ? `${agent.summary.suspicious} / ${agent.summary.numbers} 个数字` : '未运行 npm run eval'}
          tone={agent && agent.summary.suspicious === 0 ? 'text-ship' : 'text-ink'}
        />
        <Kpi
          label="Agent 引用覆盖"
          value={agent ? `${(agent.summary.citationRate * 100).toFixed(1)}%` : ablation ? `${(ablation.rules.citationRate * 100).toFixed(0)}%` : '—'}
          sub={agent ? `${agent.summary.n} 条问答` : ablation ? `${ablation.rules.n} 条问答` : '未运行'}
          tone="text-brand2"
        />
        <Kpi label="负效应漏判" value={`${(r.fnrNegative.rate * 100).toFixed(1)}%`} sub={`${r.fnrNegative.miss} / ${r.fnrNegative.n}`} tone="text-ink" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.05fr_1fr]">
        <Panel>
          <PanelHead title="混淆矩阵" hint="行 = 真实决策，列 = 引擎决策；对角线是判对的" />
          <div className="px-4 py-3">
            <div className="grid" style={{ gridTemplateColumns: '72px repeat(4, minmax(0, 1fr))' }}>
              <div />
              {DECISIONS.map((d) => (
                <div key={d} className="px-1 pb-1.5 text-center text-[9.5px] text-dim">
                  {DECISION_META[d].short}
                </div>
              ))}
              {DECISIONS.map((td, i) => (
                <div key={td} className="contents">
                  <div className="flex items-center pr-1.5 text-[10px] text-muted">{DECISION_META[td].short}</div>
                  {DECISIONS.map((pd, j) => {
                    const v = r.confusion[i][j];
                    const diag = i === j;
                    const alpha = v === 0 ? 0 : 0.12 + 0.5 * (v / maxCell);
                    return (
                      <div
                        key={pd}
                        className={cx(
                          'm-[2px] flex h-9 items-center justify-center rounded text-[11.5px]',
                          diag ? 'text-ship' : v > 0 ? 'text-noship' : 'text-dim',
                        )}
                        style={{
                          background: diag
                            ? `rgba(21, 128, 61, ${alpha})`
                            : v > 0
                              ? `rgba(190, 18, 60, ${alpha})`
                              : 'rgba(180, 130, 80, 0.05)',
                        }}
                        title={`真实 ${DECISION_META[td].label} → 引擎 ${DECISION_META[pd].label}：${v}`}
                      >
                        {v || ''}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-4 text-dim">
              {mismatchSummary(r.mismatches)}
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="按证据强度" hint="p 值分桶后的判定准确率——越靠近阈值越容易判错" />
          <div className="space-y-3 px-4 py-4">
            {r.byPValue.map((b) => (
              <div key={b.label}>
                <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
                  <span className="font-mono text-muted">{b.label}</span>
                  <span className={cx('num', b.accuracy < 0.9 && b.n > 0 ? 'text-noship' : 'text-muted')}>
                    {(b.accuracy * 100).toFixed(1)}% · {b.correct}/{b.n}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className={cx('h-full rounded-full', b.accuracy < 0.9 ? 'bg-noship/85' : 'bg-ship/85')}
                    style={{ width: `${Math.max(2, b.accuracy * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="flex items-start gap-1.5 rounded-lg border border-iterate/25 bg-iterate/[0.07] px-2.5 py-2 text-[10.5px] leading-4 text-iterate">
              <Info size={11} className="mt-0.5 shrink-0" />
              {pBucketNote(r.byPValue)}
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHead
          title="分层检测（效应异质）F1"
          hint="评的是检测器本身，不是决策：真值 = 生成器注入的「新老效应不同」，预测 = 交互显著 ∧ 一个分层为正 ∧ 另一个无效"
          right={<span className="font-mono text-[10px] text-dim">{r.hetero.positives} 个真异质</span>}
        />
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <div className="grid grid-cols-2 gap-2">
              <ConfCell label="TP 真异质·检出" value={r.hetero.tp} tone="ship" />
              <ConfCell label="FP 同质·误报" value={r.hetero.fp} tone="noship" />
              <ConfCell label="FN 真异质·漏检" value={r.hetero.fn} tone="iterate" />
              <ConfCell label="TN 同质·正确排除" value={r.hetero.tn} tone="muted" />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <MetricCell label="precision" value={r.hetero.precision.toFixed(3)} />
              <MetricCell label="recall" value={r.hetero.recall.toFixed(3)} />
              <MetricCell
                label="F1"
                value={r.hetero.f1.toFixed(3)}
                sub={`CI ${r.hetero.f1Ci[0].toFixed(2)}–${r.hetero.f1Ci[1].toFixed(2)}`}
                good={r.hetero.f1 >= 0.8}
              />
            </div>
          </div>
          <div className="space-y-2.5 text-[10.5px] leading-[1.75] text-muted">
            <p>
              正例只有 <b className="text-ink">{r.hetero.positives}</b> 个，动一条实验 F1 就跳几个点，
              所以区间必须一起看：点估计 {r.hetero.f1.toFixed(2)} 落在{" "}
              {r.hetero.f1Ci[0].toFixed(2)}–{r.hetero.f1Ci[1].toFixed(2)} 之间，<b className="text-ink">下界离 0.8 有距离</b>。
              说「F1 达到 0.8」只在点估计意义上成立，不当作稳定能力。
            </p>
            <div className="rounded-lg border border-line bg-panel2/50 px-2.5 py-2">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-dim">放宽口径对照（只要求交互显著）</span>
                <span className="num text-ink">F1 {r.hetero.interactionOnly.f1.toFixed(2)}</span>
              </div>
              <div className="text-[10px] leading-4 text-dim">
                P {r.hetero.interactionOnly.precision.toFixed(2)} / R {r.hetero.interactionOnly.recall.toFixed(2)}；
                假阳性 {r.hetero.interactionOnly.fp} 个（严格口径 {r.hetero.fp} 个）。
                召回只多 {r.hetero.interactionOnly.tp - r.hetero.tp} 条，假阳性多 {r.hetero.interactionOnly.fp - r.hetero.fp} 个——
                <b className="text-ink">「一个分层显著为正、另一个无效」这层合取是净收益</b>，不是多余条件。
              </div>
            </div>
            <p className="text-[10px] leading-4 text-dim">
              为什么不用 <code className="rounded bg-white/[0.06] px-1">decision === 'iterate'</code> 当预测：
              决策是 SRM → 护栏 → 负向 → 异质 → 不显著 → 正向的合取链，用它的输出反推检测能力，
              会把别的规则的锅算到分层头上。这里直接读 <code className="rounded bg-white/[0.06] px-1">analysis.heterogeneity</code>。
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4">
        <PanelHead title="按实验类型" hint="六类原型的准确率；guardrail / srm / heterogeneous 是关键能力" />
        <div className="grid gap-x-8 gap-y-3 px-4 py-4 md:grid-cols-2">
          {r.byArchetype.map((a) => (
            <div key={a.archetype}>
              <div className="mb-1 flex items-baseline justify-between text-[11px]">
                <span className="text-muted">{ARCHETYPE_LABEL[a.archetype] ?? a.archetype}</span>
                <span className={cx('num', a.accuracy < 0.9 ? 'text-noship' : 'text-ship')}>
                  {(a.accuracy * 100).toFixed(0)}% · {a.correct}/{a.n}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className={cx('h-full rounded-full', a.accuracy < 0.9 ? 'bg-noship/85' : 'bg-brand')}
                  style={{ width: `${Math.max(2, a.accuracy * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="mt-4 overflow-hidden">
        <PanelHead
          title="失败案例"
          hint={`全部 ${r.mismatches.length} 条不一致，逐条可点开看证据链——不修是刻意的，改了反而说明在挑数据`}
          right={<span className="text-[10px] text-dim">{r.mismatches.length} 条</span>}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[10.5px] text-dim">
                <th className="px-4 py-2 font-medium">实验</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">真值</th>
                <th className="px-3 py-2 font-medium">引擎</th>
                <th className="px-3 py-2 font-medium">命中规则</th>
                <th className="px-3 py-2 text-right font-medium">差值</th>
                <th className="px-3 py-2 text-right font-medium">p</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {r.mismatches.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => onOpen(m.id)}
                  className="group cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel2/60"
                >
                  <td className="px-4 py-2">
                    <span className="font-mono text-[10.5px] text-dim">{m.id}</span>{' '}
                    <span className="text-ink">{m.name}</span>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted">{ARCHETYPE_LABEL[m.archetype]}</td>
                  <td className="px-3 py-2">
                    <DecisionBadge decision={m.trueDecision} size="sm" showDot={false} />
                  </td>
                  <td className="px-3 py-2">
                    <DecisionBadge decision={m.predDecision} size="sm" showDot={false} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[10.5px] text-muted">{m.reasonCode}</td>
                  {/* 单位必须跟着主指标走：ARPU 口径的 +1.22 元写成 +121.60pp 是实打实的口径错误 */}
                  <td className={cx('num px-3 py-2 text-right', liftClass(m.diff))}>
                    {fmtDiff(m.diff, m.metricKind === 'continuous' ? '元' : 'pp')}
                  </td>
                  <td className="num px-3 py-2 text-right text-muted">{fmtP(m.p)}</td>
                  <td className="pr-3">
                    <ArrowRight size={13} className="text-dim opacity-0 group-hover:opacity-100" />
                  </td>
                </tr>
              ))}
              {r.mismatches.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-xs text-dim">
                    全部判对
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mt-4">
        <PanelHead
          title="置信度校准（贝叶斯 P(B>A)）"
          hint="把预测「treatment 更优的概率」分桶，看每桶里真实整体效应确实 >0 的比例；越贴近对角线越准"
          right={
            <span className="font-mono text-[10px] text-dim">
              ECE {(r.ece * 100).toFixed(1)}%（全量） · {(r.eceEffects.ece * 100).toFixed(1)}%（真值非零 {r.eceEffects.n} 个）
            </span>
          }
        />
        <div className="px-4 py-4">
          <CalibrationChart calibration={r.calibration} />
          <p className="mt-3 text-[10.5px] leading-4 text-dim">
            ECE（期望校准误差）= 各桶 |预测 − 观测| 按样本量加权平均。贝叶斯概率天然是自校准口径：若说「90% 的实验 treatment 更优」，实际就应有约 90% 真的更优。
          </p>
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-line bg-panel2/50 px-2.5 py-2 text-[10.5px] leading-4 text-muted">
            <Info size={11} className="mt-0.5 shrink-0 text-dim" />
            <span>
              <b className="text-ink">为什么有两个 ECE：</b>
              图里 0.95 以下那些点全部贴在地板上，不是后验算错了——它们对应的 {r.eceEffects.n === r.n ? 0 : r.n - r.eceEffects.n} 个实验
              真值是<b className="text-ink">精确的 0</b>（null / 分流异常），而观测目标被二值化成「真实效应 &gt; 0」，
              精确 0 只能记成负类，于是任何中间置信度都必然算错。只看真值非零的 {r.eceEffects.n} 个实验，
              ECE 是 <b className="text-ink">{(r.eceEffects.ece * 100).toFixed(1)}%</b> —— 那才是在问「说 90% 更优时是不是真的 90%」。
              两个口径都留着，因为差异本身就是「别把精确为 0 的实验当反面教材」这条结论。
            </span>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4">
        <PanelHead
          title="A/A 自校准：零效应时会不会乱报"
          hint="用同一套生成器造 N 个「两臂同分布」的实验跑引擎；真值就是 0，报了多少次显著一目了然"
          right={
            aa ? (
              <span className="font-mono text-[10px] text-dim">
                {aa.trials} 次 · seed {aa.seedBase}
              </span>
            ) : (
              <span className="text-[10px] text-dim">未运行</span>
            )
          }
        />
        {aa ? (
          <>
            <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
              <AaCell
                label="总误报率"
                value={`${(aa.falsePositiveRate * 100).toFixed(2)}%`}
                nominal={`名义 α = ${(aa.config.alpha * 100).toFixed(0)}%`}
                good={aa.falsePositiveRate <= aa.config.alpha * 1.4}
              />
              <AaCell
                label="正向误报 ship"
                value={`${(aa.shipRate * 100).toFixed(2)}%`}
                nominal={`名义 α/2 = 2.5%`}
                good={aa.shipRate <= 0.04}
              />
              <AaCell
                label="SRM 误报"
                value={`${(aa.srmFlagRate * 100).toFixed(2)}%`}
                nominal={`名义 ${(aa.config.srmAlpha * 100).toFixed(1)}%`}
                good={aa.srmFlagRate <= 0.01}
              />
              <AaCell
                label="硬护栏误报"
                value={`${(aa.guardrailFlagRate * 100).toFixed(2)}%`}
                nominal={`名义 ${(aa.config.guardrailAlpha * 100).toFixed(1)}%（单侧）`}
                good={aa.guardrailFlagRate <= 0.02}
              />
            </div>
            <div className="border-t border-line px-4 py-3.5">
              <div className="mb-2 text-[10.5px] text-muted">
                主指标 p 值分布（A/A 下应近似均匀；左偏说明检验保守，右偏说明漏判）
              </div>
              <AaPHist hist={aa.pValueHistogram} trials={aa.trials} />
              <p className="mt-3 text-[10.5px] leading-4 text-dim">
                贝叶斯视角：A/A 下 P(B&gt;A) 均值 {aa.bayesMeanProb.toFixed(4)}（理论 0.5），
                其中 &gt;0.95 的占 {(aa.bayesProbAbove095 * 100).toFixed(1)}%（理论约 5%）——
                说明后验概率没有被系统性推向某一侧。
                每臂平均 {Math.round(aa.meanSamplePerArm).toLocaleString('en-US')} 样本、{aa.days} 天。
                复现：<code className="rounded bg-white/10 px-1">npm run aa</code>。
              </p>
            </div>
          </>
        ) : (
          <div className="px-4 py-6 text-center text-[11px] text-dim">
            运行 <code className="rounded bg-white/10 px-1">npm run aa</code> 生成 A/A 自校准报告（2000 次零效应实验，按主指标口径分开报）
          </div>
        )}
      </Panel>

      <Panel className="mt-4">
        <PanelHead
          title="Agent 问答自动评测（幻觉数字率）"
          hint="规则模式、完全确定性、无需 Key，所以能进 CI 与基线比对；题库覆盖全部工具，每题只在该实验答得出来时才问"
          right={
            agent ? (
              <span className="font-mono text-[10px] text-dim">
                {agent.summary.n} 条 · {agent.summary.numbers} 个数字
              </span>
            ) : (
              <span className="text-[10px] text-dim">未运行</span>
            )
          }
        />
        {agent ? (
          <>
            {agentStale && (
              <div className="flex items-start gap-2 border-b border-iterate/25 bg-iterate/[0.07] px-4 py-2.5 text-[10.5px] leading-4 text-iterate">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                <span>
                  这份评测是在 α={agent.config.alpha}、交互阈值 {agent.config.interactionAlpha}、FDR {agent.config.segmentFdr} 下生成的，
                  与当前设置不一致 —— 数字可能已过期。重跑 <code className="rounded bg-white/10 px-1">npm run eval</code> 再引用它。
                </span>
              </div>
            )}
            <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
              <AaCell
                label="幻觉数字率"
                value={`${(agent.summary.hallucinationRate * 100).toFixed(2)}%`}
                nominal={`${agent.summary.suspicious} / ${agent.summary.numbers} 个数字无法溯源`}
                good={agent.summary.suspicious === 0}
              />
              <AaCell
                label="引用覆盖率"
                value={`${(agent.summary.citationRate * 100).toFixed(1)}%`}
                nominal={`分母 ${agent.summary.citableN}（无证据可引的不计入）`}
                good={agent.summary.citationRate >= 0.99}
              />
              <AaCell
                label="违规率"
                value={`${(agent.summary.violationRate * 100).toFixed(2)}%`}
                nominal="缺引用或出现幻觉数字"
                good={agent.summary.violationRate === 0}
              />
              <AaCell
                label="口径陷阱识别"
                value={`${(agent.summary.scopeRate * 100).toFixed(1)}%`}
                nominal={`分母 ${agent.summary.trapN}（主指标是转化率却被问 ARPU）`}
                good={agent.summary.scopeRate >= 0.95}
              />
              <AaCell
                label="意图路由准确"
                value={`${(agent.summary.routeAccuracy * 100).toFixed(1)}%`}
                nominal={`分母 ${agent.summary.routeN}（有期望意图的题）`}
                good={agent.summary.routeAccuracy >= 0.99}
              />
              <AaCell
                label="工具覆盖"
                value={`${agent.toolCalls.filter((t) => t.calls > 0).length} / ${agent.toolCalls.length}`}
                nominal={agent.uncoveredTools.length ? `未覆盖：${agent.uncoveredTools.join("、")}` : "12 个工具全部被题库触达"}
                good={agent.uncoveredTools.length === 0}
              />
            </div>
            <div className="border-t border-line px-4 py-3.5">
              <div className="mb-2 text-[10.5px] text-muted">按题目分组（同一批实验，分组看才知道是哪类问题在拉低覆盖）</div>
              <table className="w-full border-collapse text-left text-[10.5px]">
                <thead>
                  <tr className="border-b border-line text-[10px] text-dim">
                    <th className="py-1.5 pr-3 font-medium">组</th>
                    <th className="py-1.5 pr-3 text-right font-medium">问答</th>
                    <th className="py-1.5 pr-3 text-right font-medium">数字</th>
                    <th className="py-1.5 pr-3 text-right font-medium">可疑</th>
                    <th className="py-1.5 pr-3 text-right font-medium">引用</th>
                    <th className="py-1.5 text-right font-medium">路由</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.byGroup.map((g) => (
                    <tr key={g.group} className="border-b border-line/50 last:border-0">
                      <td className="py-1.5 pr-3 text-muted">{g.group}</td>
                      <td className="num py-1.5 pr-3 text-right text-muted">{g.n}</td>
                      <td className="num py-1.5 pr-3 text-right text-muted">{g.numbers}</td>
                      <td className={cx("num py-1.5 pr-3 text-right", g.suspicious > 0 ? "text-noship" : "text-muted")}>{g.suspicious}</td>
                      <td className="num py-1.5 pr-3 text-right text-muted">{(g.citationRate * 100).toFixed(0)}%</td>
                      <td className="num py-1.5 text-right text-muted">{(g.routeAccuracy * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {agent.problems.length > 0 && (
                <div className="mt-3 rounded-lg border border-noship/25 bg-noship/[0.06] px-2.5 py-2">
                  <div className="mb-1 text-[10.5px] font-medium text-noship">{agent.problems.length} 条回答有问题</div>
                  <ul className="space-y-1 text-[10px] leading-4 text-muted">
                    {agent.problems.slice(0, 4).map((p) => (
                      <li key={`${p.expId}-${p.qaId}`}>
                        <span className="font-mono text-dim">{p.expId}</span> · {p.q} ——
                        {p.suspicious.length > 0 ? ` 无法溯源的数字 ${p.suspicious.join("、")}` : ` ${p.violations.join("；")}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-3 text-[10.5px] leading-4 text-dim">
                「幻觉数字率」= 回答里出现、但引擎与工具从未返回过的数字 ÷ 回答里数字总数；判定按回答写的小数位数四舍五入核对。
                它抓的是<b className="text-ink">编数字</b>，抓不到「数字对但解读错」——后者只能人工看，不假装能自动测。
                智能模式（DeepSeek）有随机性，仍放下面 ablation 里人工核对。
              </p>
            </div>
          </>
        ) : (
          <div className="px-4 py-6 text-center text-[11px] text-dim">
            运行 <code className="rounded bg-white/10 px-1">npm run eval</code> 生成 Agent 问答评测（1720 条，规则模式，无需 Key）
          </div>
        )}
      </Panel>

      <Panel className="mt-4">
        <PanelHead
          title="Agent ablation：规则模板 vs 大模型"
          hint="同一批问题跑两种回答方式，比引用覆盖率、可疑数字率、口径识别"
          right={
            ablation ? (
              <span className="font-mono text-[10px] text-dim">{ablation.questions} 题 × {ablation.experiments.length} 个实验</span>
            ) : (
              <span className="text-[10px] text-dim">未运行</span>
            )
          }
        />
        {ablation ? (
          <div className="grid gap-px bg-line sm:grid-cols-2">
            <AblationCol title="规则模式（免密钥）" data={ablation.rules} />
            <AblationCol
              title="智能模式（DeepSeek）"
              data={ablation.llm}
              hint={ablation.llm ? undefined : '尚未运行：需要 DEEPSEEK_API_KEY。未跑之前不写任何数字。'}
            />
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-[11px] text-dim">
            运行 <code className="rounded bg-white/10 px-1">npm run ablation</code> 生成对比数据
          </div>
        )}
      </Panel>

      <Panel className="mt-4">
        <div className="flex items-start gap-2.5 px-4 py-3.5">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-iterate" />
          <div className="text-[11px] leading-5 text-muted">
            <b className="text-ink">口径与边界：</b>
            这里比的是「引擎决策 vs 生成器注入的真值」，不是线上业务效果；数据是合成的（固定种子可复现），
            真值来自生成参数而不是人工标注。<b className="text-ink">不要</b>把这个准确率当成"能替代分析师"的证据——
            它只说明规则在已知真值下的一致性。真实业务数据没有真值，只能做事后 holdout 校验。
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** 混淆矩阵下方的一句话总结：按不一致的来源动态聚合，避免写死数字 */
function mismatchSummary(rows: { archetype: string; predDecision: string }[]): string {
  if (!rows.length) return '全部判对：每个实验的决策都与真值完全一致。';
  // ship 与 iterate 必须分开念：iterate 是「定向上线」（只对某个分层放开），
  // 与「整体上线」是两种结论。混成一句「判成可上线」会把 E029 那类误判说得比实际轻。
  const LABEL: Record<string, string> = {
    ship: '可上线',
    'no-ship': '负向',
    iterate: '定向上线',
    inconclusive: '证据不足',
  };
  const byArch = new Map<string, Map<string, number>>();
  for (const m of rows) {
    const bucket = byArch.get(m.archetype) ?? new Map<string, number>();
    bucket.set(m.predDecision, (bucket.get(m.predDecision) ?? 0) + 1);
    byArch.set(m.archetype, bucket);
  }
  const parts = [...byArch.entries()].map(([arch, bucket]) => {
    const bits = ['ship', 'iterate', 'no-ship', 'inconclusive']
      .filter((d) => bucket.has(d))
      .map((d) => `${bucket.get(d)} 个判成${LABEL[d]}`);
    return `「${ARCHETYPE_LABEL[arch] ?? arch}」${bits.join('、')}`;
  });
  return `${rows.length} 条不一致：${parts.join('；')}。`;
}

/** p 值分桶提示：数字来自当前评测，不写死 */
function pBucketNote(buckets: { label: string; n: number; correct: number }[]): string {
  const mid = buckets.find((b) => b.label === '0.01 ≤ p < 0.05');
  if (!mid || mid.n === 0) return '当前没有落在 0.01–0.05 的实验。';
  const tail = mid.correct === mid.n ? '全部判对' : `判对 ${mid.correct} 个`;
  return `落在 0.01–0.05 的 ${mid.n} 个实验${tail}——p 恰好跨过 0.05 的实验在统计上与「有微效」无法区分。这不是 bug，是 α=0.05 的代价。`;
}

/** 四格小方块 */
function ConfCell({ label, value, tone }: { label: string; value: number; tone: 'ship' | 'noship' | 'iterate' | 'muted' }) {
  const color =
    tone === 'ship' ? 'text-ship' : tone === 'noship' ? 'text-noship' : tone === 'iterate' ? 'text-iterate' : 'text-muted';
  return (
    <div className="rounded-lg border border-line bg-panel2/40 px-2.5 py-2">
      <div className="text-[10px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-lg', color)}>{value}</div>
    </div>
  );
}

/** precision / recall / F1 小格 */
function MetricCell({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2.5 py-2">
      <div className="text-[10px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-base', good === undefined ? 'text-ink' : good ? 'text-ship' : 'text-iterate')}>{value}</div>
      {sub && <div className="num mt-0.5 text-[9.5px] text-dim">{sub}</div>}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/70 px-4 py-3">
      <div className="text-[11px] text-dim">{label}</div>
      <div className={cx('num mt-1 text-xl font-semibold tracking-tight', tone)}>{value}</div>
      <div className="num mt-0.5 text-[10.5px] text-dim">{sub}</div>
    </div>
  );
}

function AblationCol({ title, data, hint }: { title: string; data: Ablation['rules'] | null; hint?: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
        <FlaskConical size={12} className="text-brand2" /> {title}
      </div>
      {data ? (
        <dl className="mt-2 space-y-1.5 text-[10.5px]">
          <Row k="问答数" v={String(data.n)} />
          <Row k="引用覆盖率" v={`${(data.citationRate * 100).toFixed(1)}%`} good={data.citationRate >= 0.95} />
          <Row k="可疑数字率" v={`${(data.suspiciousRate * 100).toFixed(1)}%`} good={data.suspiciousRate === 0} />
          <Row k="违规率" v={`${(data.violationRate * 100).toFixed(1)}%`} good={data.violationRate === 0} />
          <Row k="口径陷阱识别" v={`${(data.noDataRate * 100).toFixed(1)}%`} good={data.noDataRate >= 0.9} />
          <Row k="平均字数" v={String(data.avgChars)} />
        </dl>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-dim">
          <Info size={11} className="mt-0.5 shrink-0" />
          {hint ?? '暂无数据'}
        </p>
      )}
    </div>
  );
}

function Row({ k, v, good }: { k: string; v: string; good?: boolean }) {
  return (
    <div className="flex items-baseline justify-between border-b border-line/40 pb-1">
      <dt className="text-dim">{k}</dt>
      <dd className={cx('num flex items-center gap-1', good === undefined ? 'text-muted' : good ? 'text-ship' : 'text-noship')}>
        {good !== undefined && <BadgeCheck size={10} className={good ? 'text-ship' : 'text-noship opacity-40'} />}
        {v}
      </dd>
    </div>
  );
}

/** 校准曲线：预测 P(B>A) 分桶 vs 实际 treatment 更优比例，对角虚线 = 完美校准 */
function CalibrationChart({ calibration }: { calibration: { probMid: number; n: number; observed: number }[] }) {
  const W = 320;
  const H = 230;
  const mL = 42;
  const mR = 12;
  const mT = 14;
  const mB = 34;
  const pw = W - mL - mR;
  const ph = H - mT - mB;
  const px = (v: number) => mL + v * pw;
  const py = (v: number) => mT + (1 - v) * ph;
  const maxN = Math.max(1, ...calibration.map((b) => b.n));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label="置信度校准曲线">
      {/* 网格 */}
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <g key={g}>
          <line x1={mL} y1={py(g)} x2={W - mR} y2={py(g)} stroke={C.line} strokeWidth={1} />
          <line x1={px(g)} y1={mT} x2={px(g)} y2={mT + ph} stroke={C.line} strokeWidth={1} />
          <text x={mL - 5} y={py(g) + 3} textAnchor="end" fontSize={9} fill={C.dim}>
            {Math.round(g * 100)}
          </text>
          <text x={px(g)} y={H - mB + 14} textAnchor="middle" fontSize={9} fill={C.dim}>
            {Math.round(g * 100)}
          </text>
        </g>
      ))}
      {/* 对角线 */}
      <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} stroke={C.muted} strokeWidth={1.2} strokeDasharray="4 3" />
      {/* 数据点，半径随样本量 */}
      {calibration.map((b) => {
        const r = 3 + 6 * Math.sqrt(b.n / maxN);
        return (
          <circle key={b.probMid} cx={px(b.probMid)} cy={py(b.observed)} r={r} fill={C.brand} fillOpacity={0.7} stroke={C.brand2} strokeWidth={1}>
            <title>{`预测 ${Math.round(b.probMid * 100)}% · 实际 ${(b.observed * 100).toFixed(0)}% · n=${b.n}`}</title>
          </circle>
        );
      })}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill={C.muted}>
        预测 P(B&gt;A)（%）
      </text>
      <text x={12} y={H / 2} textAnchor="middle" fontSize={10} fill={C.muted} transform={`rotate(-90 12 ${H / 2})`}>
        实际 treatment 更优（%）
      </text>
    </svg>
  );
}

/** A/A 单元格：实测值 + 名义值 + 是否受控 */
function AaCell({
  label,
  value,
  nominal,
  good,
}: {
  label: string;
  value: string;
  nominal: string;
  good: boolean;
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div className={cx('num mt-1 text-[17px]', good ? 'text-ship' : 'text-noship')}>{value}</div>
      <div className="mt-0.5 text-[10px] text-dim">{nominal}</div>
    </div>
  );
}

/** p 值直方图：A/A 下应近似均匀，横轴 0→1 分 10 桶，虚线 = 均匀期望 */
function AaPHist({ hist, trials }: { hist: number[]; trials: number }) {
  const W = 640;
  const H = 120;
  const mL = 34;
  const mB = 22;
  const pw = W - mL - 12;
  const bw = pw / hist.length;
  const expect = trials / hist.length;
  const maxV = Math.max(expect * 1.6, ...hist);
  const y = (v: number) => H - mB - (v / maxV) * (H - mB - 10);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="A/A 下主指标 p 值分布">
      <line x1={mL} y1={y(expect)} x2={W - 12} y2={y(expect)} stroke={C.muted} strokeWidth={1} strokeDasharray="4 3" />
      <text x={mL - 4} y={y(expect) + 3} textAnchor="end" fontSize={9} fill={C.dim}>
        {Math.round(expect)}
      </text>
      {hist.map((v, i) => (
        <g key={i}>
          <rect
            x={mL + i * bw + 1}
            y={y(v)}
            width={bw - 2}
            height={Math.max(1, H - mB - y(v))}
            fill={C.brand}
            fillOpacity={0.65}
          >
            <title>{`p ∈ [${(i / 10).toFixed(1)}, ${((i + 1) / 10).toFixed(1)}) · ${v} 次（期望 ${Math.round(expect)}）`}</title>
          </rect>
          <text x={mL + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize={8.5} fill={C.dim}>
            {(i / 10).toFixed(1)}
          </text>
        </g>
      ))}
      <line x1={mL} y1={H - mB} x2={W - 12} y2={H - mB} stroke={C.line2} strokeWidth={1} />
    </svg>
  );
}
