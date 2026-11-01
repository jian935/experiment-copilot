import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { DECISIONS, evaluate } from '../../lib/evaluate.ts';
import type { Dataset } from '../../lib/types.ts';
import { ARCHETYPE_LABEL, DECISION_META, fmtP, fmtPP, liftClass } from '../lib/format';
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

export function EvalScreen({
  dataset,
  analyses,
  onOpen,
  onBack,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const r = useMemo(() => evaluate(dataset, analyses), [dataset, analyses]);
  const [ablation, setAblation] = useState<Ablation | null>(null);
  const [aa, setAa] = useState<AaReport | null>(null);
  const noTruth = dataset.groundTruth === false;

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}data/ablation.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => alive && setAblation(d as Ablation))
      .catch(() => {});
    fetch(`${import.meta.env.BASE_URL}data/aa_report.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => alive && setAa(d as AaReport))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="决策准确率" value={`${(r.accuracy * 100).toFixed(1)}%`} sub={`${r.correct} / ${r.n}`} tone="text-ship" />
        <Kpi label="null 误报率 (FPR)" value={`${(r.fpr.rate * 100).toFixed(1)}%`} sub={`${r.fpr.hit} / ${r.fpr.n}`} tone="text-noship" />
        <Kpi label="正效应漏判" value={`${(r.fnrPositive.rate * 100).toFixed(1)}%`} sub={`${r.fnrPositive.miss} / ${r.fnrPositive.n}`} tone="text-ink" />
        <Kpi label="负效应漏判" value={`${(r.fnrNegative.rate * 100).toFixed(1)}%`} sub={`${r.fnrNegative.miss} / ${r.fnrNegative.n}`} tone="text-ink" />
        <Kpi
          label="Agent 引用覆盖"
          value={ablation ? `${(ablation.rules.citationRate * 100).toFixed(0)}%` : '—'}
          sub={ablation ? `${ablation.rules.n} 条问答` : '未运行 ablation'}
          tone="text-brand2"
        />
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
              4 个不一致全部来自「真实无效应」的 null 实验：3 个被判成可上线、1 个被判成负向。
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
              落在 0.01–0.05 的 3 个实验全部判错——它们本来就是 null 的尾部假阳性，p 恰好跨过 0.05
              的实验在统计上与"有微效"无法区分。这不是 bug，是 α=0.05 的代价。
            </div>
          </div>
        </Panel>
      </div>

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
          hint="全部 4 条不一致，逐条可点开看证据链——不修是刻意的，改了反而说明在挑数据"
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
                  <td className={cx('num px-3 py-2 text-right', liftClass(m.diff))}>{fmtPP(m.diff)}</td>
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
              ECE {r.ece <= 0 ? '0' : (r.ece * 100).toFixed(1)}%
            </span>
          }
        />
        <div className="px-4 py-4">
          <CalibrationChart calibration={r.calibration} />
          <p className="mt-3 text-[10.5px] leading-4 text-dim">
            ECE（期望校准误差）= 各桶 |预测 − 观测| 按样本量加权平均。贝叶斯概率天然是自校准口径：若说「90% 的实验 treatment 更优」，实际就应有约 90% 真的更优。
          </p>
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
