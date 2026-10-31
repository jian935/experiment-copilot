import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { DECISIONS, evaluate } from '../../lib/evaluate.ts';
import type { Dataset } from '../../lib/types.ts';
import { ARCHETYPE_LABEL, DECISION_META, fmtP, fmtPP, liftClass } from '../lib/format';
import { DecisionBadge, Panel, PanelHead, cx } from './ui';

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

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}data/ablation.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => alive && setAblation(d as Ablation))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const maxCell = Math.max(1, ...r.confusion.flat());

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
                            ? `rgba(52, 211, 153, ${alpha})`
                            : v > 0
                              ? `rgba(251, 113, 133, ${alpha})`
                              : 'rgba(255,255,255,0.02)',
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
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cx('h-full rounded-full', b.accuracy < 0.9 ? 'bg-noship' : 'bg-ship')}
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
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cx('h-full rounded-full', a.accuracy < 0.9 ? 'bg-noship' : 'bg-brand2')}
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
