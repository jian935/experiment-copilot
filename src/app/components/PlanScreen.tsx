import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarClock, FlaskConical, Info, Users } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { Dataset } from '../../lib/types.ts';
import {
  daysNeeded,
  mdeForDays,
  sampleSizeContinuous,
  sampleSizeTwoProportion,
} from '../../lib/plan.ts';
import { mdeMultiArmRate, sampleSizeMultiArm, sampleSizeMultiArmContinuous } from '../../lib/multiarm.ts';
import { fmtNum } from '../lib/format';
import { Button, Panel, PanelHead, cx } from './ui';

/**
 * 实验设计：开实验之前要回答的两个问题。
 *
 * 1. 「想测出 10% 的提升，要多少样本、跑几天？」
 * 2. 「我只有 14 天，能测出多大的提升？」
 *
 * 这两个问题答不上来，实验就会在第 3 天被「看起来有效果」叫停——这是 peeking 与误判
 * 最常见的来源。所以这一屏刻意放在「列表」之前一级：**先算清楚，再去跑**。
 */
export function PlanScreen({
  dataset,
  analyses,
  onOpen,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  onOpen: (id: string) => void;
}) {
  const [mode, setMode] = useState<'size' | 'days'>('size');
  const [kind, setKind] = useState<'rate' | 'continuous'>('rate');

  // 率口径
  const [basePct, setBasePct] = useState(5);
  /** 基线是从哪个实验带进来的：空字符串 = 手填。做成受控值，选完能看见自己选了什么 */
  const [baselineFrom, setBaselineFrom] = useState('');
  const [liftPct, setLiftPct] = useState(10);
  // 连续口径
  const [sd, setSd] = useState(50);
  const [delta, setDelta] = useState(2);

  const [alphaPct, setAlphaPct] = useState(5);
  const [powerPct, setPowerPct] = useState(80);
  const [traffic, setTraffic] = useState(20_000);
  const [controlSharePct, setControlSharePct] = useState(50);
  const [daysBudget, setDaysBudget] = useState(14);
  /** 臂数（含对照组）。2 = 传统 A/B；3/4 = A/B/n，走 Dunnett 口径 */
  const [armCount, setArmCount] = useState(2);

  const alpha = alphaPct / 100;
  const power = powerPct / 100;
  const controlShare = controlSharePct / 100;
  const p1 = basePct / 100;
  const p2 = p1 * (1 + liftPct / 100);
  /** 多臂按等分流：每组每天拿到 1/k 的流量，天数要用这个份额算 */
  const effShare = armCount > 2 ? 1 / armCount : controlShare;

  /** 从已有实验带入基线：比让用户凭记忆填一个 5% 强得多 */
  const rateExperiments = useMemo(
    () =>
      dataset.experiments
        .map((e) => ({ e, an: analyses.get(e.id) }))
        .filter((x): x is { e: typeof dataset.experiments[number]; an: Analysis } => !!x.an && x.an.primary.unit === 'pp')
        .slice(0, 40),
    [dataset, analyses],
  );

  const result = useMemo(() => {
    try {
      // 多臂：每臂都要与对照比，α 要控 FWER，且各臂共享对照 → 用 Dunnett（不是 Bonferroni）
      if (armCount > 2) {
        if (kind === 'continuous') {
          const p = sampleSizeMultiArmContinuous({ sd, delta, arms: armCount, alpha, power });
          const d = daysNeeded({ nPerArm: p.nPerArm, dailyTraffic: traffic, controlShare: effShare });
          return {
            ok: true as const,
            shape: 'multi-size' as const,
            arms: armCount,
            kind: 'continuous' as const,
            nPerArm: p.nPerArm,
            total: p.total,
            days: d.days,
            perArmPerDay: d.perArmPerDay,
            crit: p.crit,
            nBonf: p.nPerArmBonferroni,
            bonferroniCritZ: p.bonferroniCrit,
          };
        }
        if (mode === 'days') {
          const nPerArm = Math.max(2, Math.round((traffic * daysBudget) / armCount));
          const m = mdeMultiArmRate({ p1, arms: armCount, nPerArm, alpha, power });
          return {
            ok: true as const,
            shape: 'multi-mde' as const,
            arms: armCount,
            nPerArm,
            /** 展示用的 MDE 文案（率用相对提升，连续用绝对差值） */
            mdeText: `${(m.mdeRel * 100).toFixed(1)}%`,
            mdeUnit: '相对提升',
            crit: m.crit,
          };
        }
        const p = sampleSizeMultiArm({ p1, p2, arms: armCount, alpha, power });
        const d = daysNeeded({ nPerArm: p.nPerArm, dailyTraffic: traffic, controlShare: effShare });
        return {
          ok: true as const,
          shape: 'multi-size' as const,
          arms: armCount,
          kind: 'rate' as const,
          nPerArm: p.nPerArm,
          total: p.total,
          days: d.days,
          perArmPerDay: d.perArmPerDay,
          crit: p.crit,
          nBonf: p.nPerArmBonferroni,
          bonferroniCritZ: p.bonferroniCrit,
          achievedPower: p.achievedPower,
          trafficMultiplier: p.trafficMultiplier,
          correlation: p.correlation,
          powerAnyArm: p.powerAnyArm,
        };
      }
      if (kind === 'continuous') {
        const n = sampleSizeContinuous({ sd, delta, alpha, power });
        const d = daysNeeded({ nPerArm: n.nPerArm, dailyTraffic: traffic, controlShare });
        return {
          ok: true as const,
          shape: 'continuous' as const,
          nPerArm: n.nPerArm,
          total: n.total,
          days: d.days,
          perArmPerDay: d.perArmPerDay,
        };
      }
      if (mode === 'size') {
        const s = sampleSizeTwoProportion({ p1, p2, alpha, power });
        const d = daysNeeded({ nPerArm: s.nPerArm, dailyTraffic: traffic, controlShare });
        return {
          ok: true as const,
          shape: 'rate-size' as const,
          nPerArm: s.nPerArm,
          total: s.total,
          days: d.days,
          perArmPerDay: d.perArmPerDay,
          achievedPower: s.achievedPower,
        };
      }
      const m = mdeForDays({ p1, days: daysBudget, dailyTraffic: traffic, controlShare, alpha, power });
      return { ok: true as const, shape: 'rate-days' as const, mdeAbs: m.mdeAbs, mdeRel: m.mdeRel, nPerArm: m.nPerArm };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [kind, mode, sd, delta, p1, p2, alpha, power, traffic, controlShare, daysBudget, armCount, effShare]);


  /**
   * 加臂的代价。
   * - 当前是 2 臂：预告「加第三个臂要多少样本」（很多人以为加一臂只是多分一股流量）
   * - 当前是 3/4 臂：直接读 `result` 里的 Dunnett vs Bonferroni 两组数
   */
  const armsCost = useMemo(() => {
    if (kind !== 'rate' || mode !== 'size' || armCount !== 2) return null;
    try {
      const two = sampleSizeTwoProportion({ p1, p2, alpha, power }).nPerArm;
      const p = sampleSizeMultiArm({ p1, p2, arms: 3, alpha, power });
      return {
        two,
        dunnett: p.nPerArm,
        bonferroni: p.nPerArmBonferroni,
        ratio: p.nPerArm / two,
        trafficMultiplier: p.trafficMultiplier,
        crit: p.crit,
        bonferroniCritZ: p.bonferroniCrit,
      };
    } catch {
      return null;
    }
  }, [kind, mode, p1, p2, alpha, power, armCount]);

  const curve = useMemo(() => {
    if (kind !== 'rate' || !(p1 > 0)) return [];
    const points: Array<{ lift: number; days: number }> = [];
    for (const l of [2, 3, 5, 8, 10, 15, 20, 30, 50]) {
      if (mode === 'days') break;
      try {
        const s = sampleSizeTwoProportion({ p1, p2: p1 * (1 + l / 100), alpha, power });
        const d = daysNeeded({ nPerArm: s.nPerArm, dailyTraffic: traffic, controlShare });
        points.push({ lift: l, days: d.days });
      } catch {
        // 某些输入下无解（比如流量太小），跳过即可——曲线少一个点比整屏崩掉好
      }
    }
    return points;
  }, [kind, mode, p1, alpha, power, traffic, controlShare]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
          <FlaskConical size={17} className="text-brand" />
          实验设计
        </h1>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          开实验之前先算两件事：<b className="text-ink">要多少样本</b>（以及按你的流量要跑几天）、
          <b className="text-ink">这几天最多能测出多大的提升</b>。答不上来，实验就会在第 3 天被「看起来有效果」叫停。
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* 输入 */}
        <Panel>
          <PanelHead title="参数" hint="全部按双侧检验计算" />
          <div className="space-y-3 px-4 py-3">
            <div className="flex gap-1 rounded-lg bg-panel2/60 p-1">
              <Seg active={kind === 'rate'} onClick={() => setKind('rate')} label="转化率" />
              <Seg active={kind === 'continuous'} onClick={() => setKind('continuous')} label="ARPU / 连续指标" />
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
                <span className="text-muted">臂数（含对照组）</span>
                <span className="text-dim">{armCount > 2 ? 'A/B/n' : 'A/B'}</span>
              </div>
              <div className="flex gap-1 rounded-lg bg-panel2/60 p-1">
                <Seg active={armCount === 2} onClick={() => setArmCount(2)} label="2 臂" />
                <Seg active={armCount === 3} onClick={() => setArmCount(3)} label="3 臂" />
                <Seg active={armCount === 4} onClick={() => setArmCount(4)} label="4 臂" />
              </div>
              {armCount > 2 && (
                <p className="mt-1 text-[10px] leading-4 text-dim">
                  {armCount - 1} 次「每臂 vs 对照」，用 Dunnett 控 FWER（比 Bonferroni 省样本）；流量按{armCount} 等分。
                </p>
              )}
            </div>

            {kind === 'rate' ? (
              <>
                <div className="flex gap-1 rounded-lg bg-panel2/60 p-1">
                  <Seg active={mode === 'size'} onClick={() => setMode('size')} label="我要测多大效应" />
                  <Seg active={mode === 'days'} onClick={() => setMode('days')} label="我只能跑 N 天" />
                </div>
                <Field
                  label="基线转化率"
                  unit="%"
                  value={basePct}
                  onChange={(v) => {
                    setBasePct(v);
                    // 手改之后就不再是「从某个实验带入的」了，把来源清掉
                    setBaselineFrom('');
                  }}
                  step={0.1}
                />
                {mode === 'size' ? (
                  <Field label="想检出的相对提升" unit="%" value={liftPct} onChange={setLiftPct} step={1} />
                ) : (
                  <Field label="能跑的天数" unit="天" value={daysBudget} onChange={setDaysBudget} step={1} />
                )}
                {rateExperiments.length > 0 && mode === 'size' && (
                  <div>
                    <div className="mb-1 text-[10.5px] text-dim">或者从已有实验带入基线：</div>
                    <select
                      value={baselineFrom}
                      onChange={(e) => {
                        const an = rateExperiments.find((x) => x.e.id === e.target.value)?.an;
                        // 用对照组的实际转化率，而不是 50% 这种默认值
                        if (an) setBasePct(Number((an.primary.controlValue * 100).toFixed(3)));
                        // 记住选的是哪一个：只「填进去」而不显示选中项，用户会怀疑没生效
                        setBaselineFrom(e.target.value);
                      }}
                      className="w-full rounded-lg border border-line bg-base px-2 py-1.5 text-[11.5px] text-ink outline-none focus:border-brand/60"
                    >
                      <option value="">选一个实验…</option>
                      {rateExperiments.map(({ e, an }) => (
                        <option key={e.id} value={e.id}>
                          {e.id} {e.name}（对照 {(an.primary.controlValue * 100).toFixed(2)}%）
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            ) : (
              <>
                <Field label="指标标准差 σ" unit="元/人" value={sd} onChange={setSd} step={1} />
                <Field label="想检出的绝对差值" unit="元" value={delta} onChange={setDelta} step={0.5} />
                <p className="text-[10.5px] leading-4 text-dim">
                  σ 必须来自你自己的数据（同期同人群的标准差）。用别人的方差算出来的 n，只是看起来专业。
                </p>
              </>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label="α" unit="%" value={alphaPct} onChange={setAlphaPct} step={0.5} />
              <Field label="功效" unit="%" value={powerPct} onChange={setPowerPct} step={5} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="日流量" unit="人/天" value={traffic} onChange={setTraffic} step={1000} />
              <Field label="对照组占比" unit="%" value={controlSharePct} onChange={setControlSharePct} step={5} />
            </div>
          </div>
        </Panel>

        {/* 结果 */}
        <div className="space-y-3">
          {!result.ok ? (
            <div className="flex items-start gap-2 rounded-xl border border-noship/35 bg-noship/10 px-4 py-3 text-[11.5px] leading-5 text-noship">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{result.error}</span>
            </div>
          ) : result.shape === 'multi-size' ? (
            <>
              <ResultGrid
                items={[
                  { label: '每组样本', value: fmtNum(result.nPerArm), unit: '人' },
                  { label: '总样本', value: fmtNum(result.total), unit: '人' },
                  { label: '需要天数', value: String(result.days), unit: '天', accent: result.days > 30 },
                  {
                    label: 'Dunnett 临界 z',
                    value: result.crit.toFixed(3),
                    unit: `比 Bonferroni 少 ${(result.nBonf - result.nPerArm).toLocaleString()} 人/组`,
                  },
                ]}
              />
              <p className="text-[11.5px] leading-5 text-muted">
                {result.arms} 个臂、{result.arms - 1} 次比较。
                {result.kind === 'rate' ? (
                  <>
                    要检出 <b className="text-ink">{(p1 * 100).toFixed(2)}% → {(p2 * 100).toFixed(2)}%</b>
                    （+{liftPct}% 相对），
                  </>
                ) : (
                  <>
                    要检出 <b className="text-ink">{delta} 元</b> 的 ARPU 差值，
                  </>
                )}
                每组需要 <b className="text-ink">{fmtNum(result.nPerArm)}</b> 人；按每天{' '}
                {fmtNum(result.perArmPerDay)} 人/组，需要{' '}
                <b className={cx('text-ink', result.days > 30 && 'text-iterate')}>{result.days} 天</b>。
              </p>
              <div className="flex items-start gap-2 rounded-xl border border-line bg-panel2/40 px-4 py-2.5 text-[10.5px] leading-4 text-muted">
                <Info size={12} className="mt-0.5 shrink-0 text-brand2" />
                <span>
                  同一设计改用 Bonferroni（忽略「各臂共享对照 ⇒ 差值正相关」）需要{' '}
                  <b className="text-ink">{fmtNum(result.nBonf)}</b> 人/组，即多付{' '}
                  <b className="text-ink">{fmtNum(result.nBonf - result.nPerArm)}</b> 人/组的流量；
                  临界值 {result.crit.toFixed(3)} vs {result.bonferroniCritZ.toFixed(3)} 的差就是「用不用相关性」的价格。
                  注意：{result.arms} 臂的每组样本<b className="text-ink">一定多于</b>两臂——多一个臂不是「多分一股流量」，
                  而是每次比较都要更保守。
                </span>
              </div>
            </>
          ) : result.shape === 'multi-mde' ? (
            <>
              <ResultGrid
                items={[
                  { label: '能检出的最小效应', value: result.mdeText, unit: result.mdeUnit },
                  { label: '每组样本', value: fmtNum(result.nPerArm), unit: '人' },
                  { label: '可用天数', value: String(daysBudget), unit: '天' },
                  { label: 'Dunnett 临界 z', value: result.crit.toFixed(3), unit: '' },
                ]}
              />
              <p className="text-[11.5px] leading-5 text-muted">
                {daysBudget} 天、每天 {traffic.toLocaleString()} 流量按 {result.arms} 等分，
                {result.arms} 个臂每个只有 <b className="text-ink">{fmtNum(result.nPerArm)}</b> 人，
                只能检出 <b className="text-ink">{result.mdeText}</b> 以上的效应。
                <b className="text-ink">臂越多，单臂样本越少，能检出的效应就越大</b>——这是多臂实验最容易被忽略的代价。
              </p>
            </>
          ) : result.shape === 'continuous' ? (
            <ResultGrid
              items={[
                { label: '每组样本', value: fmtNum(result.nPerArm), unit: '人' },
                { label: '总样本', value: fmtNum(result.total), unit: '人' },
                { label: '需要天数', value: String(result.days), unit: '天' },
                { label: '每组每天', value: fmtNum(result.perArmPerDay), unit: '人' },
              ]}
            />
          ) : result.shape === 'rate-size' ? (
            <>
              <ResultGrid
                items={[
                  { label: '每组样本', value: fmtNum(result.nPerArm), unit: '人' },
                  { label: '总样本', value: fmtNum(result.total), unit: '人' },
                  { label: '需要天数', value: String(result.days), unit: '天', accent: result.days > 30 },
                  { label: '实际功效', value: (result.achievedPower * 100).toFixed(1), unit: '%' },
                ]}
              />
              <p className="text-[11.5px] leading-5 text-muted">
                要检出 <b className="text-ink">{(p1 * 100).toFixed(2)}% → {(p2 * 100).toFixed(2)}%</b>
                （+{liftPct}% 相对），每组需要 <b className="text-ink">{fmtNum(result.nPerArm)}</b> 人。
                按每天 {fmtNum(result.perArmPerDay)} 人/组，需要{' '}
                <b className={cx('text-ink', result.days > 30 && 'text-iterate')}>{result.days} 天</b>。
                {result.days > 30 && '——超过 30 天通常说明这个实验不该做：要么把改动做大，要么换更大的流量池。'}
              </p>
            </>
          ) : (
            <>
              <ResultGrid
                items={[
                  { label: '能检出的最小效应', value: (result.mdeAbs * 100).toFixed(2), unit: 'pp' },
                  { label: '相对提升', value: (result.mdeRel * 100).toFixed(1), unit: '%' },
                  { label: '每组样本', value: fmtNum(result.nPerArm), unit: '人' },
                  { label: '可用天数', value: String(daysBudget), unit: '天' },
                ]}
              />
              <p className="text-[11.5px] leading-5 text-muted">
                {daysBudget} 天、每天 {traffic.toLocaleString()} 流量，只能检出{' '}
                <b className="text-ink">{(result.mdeRel * 100).toFixed(1)}%</b> 以上的相对提升。
                比这更小的真实效果，会被噪声盖住——<b className="text-ink">跑完看到「不显著」不等于没有效果</b>。
              </p>
            </>
          )}

          {armsCost && (
            <div className="flex items-start gap-2 rounded-xl border border-line bg-panel2/40 px-4 py-2.5 text-[10.5px] leading-4 text-muted">
              <Users size={12} className="mt-0.5 shrink-0 text-brand2" />
              <span>
                想加第三个臂（A/B/C）：每组样本要{' '}
                <b className="text-ink">×{armsCost.ratio.toFixed(2)}</b>（{fmtNum(armsCost.two)} →{' '}
                {fmtNum(armsCost.dunnett)} 人），总流量是两臂的{' '}
                <b className="text-ink">×{armsCost.trafficMultiplier.toFixed(2)}</b>。
                如果改用 Bonferroni 而不是 Dunnett，还要再多到 {fmtNum(armsCost.bonferroni)} 人/组
                （临界值 {armsCost.crit.toFixed(3)} vs {armsCost.bonferroniCritZ.toFixed(3)}）。
                点上面的「3 臂」可以直接按多臂重算。
              </span>
            </div>
          )}

          {curve.length >= 3 && (
            <Panel>
              <PanelHead title="想测的效应越小，要跑越久" hint="横轴：相对提升；纵轴：所需天数" />
              <div className="px-4 py-3">
                <DaysCurve points={curve} currentLift={liftPct} />
              </div>
            </Panel>
          )}

          <div className="flex items-center gap-2 text-[10.5px] text-dim">
            <CalendarClock size={12} />
            算完之后可以带着这个天数去开实验；跑起来后用详情的「还要跑几天」看进度，两者口径一致。
            <ArrowRight size={12} />
            <button onClick={() => onOpen(rateExperiments[0]?.e.id ?? dataset.experiments[0].id)} className="text-brand2 hover:underline">
              看一个正在跑的实验
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── 小组件 ───────── */

function ResultGrid({
  items,
}: {
  items: Array<{ label: string; value: string; unit: string; accent?: boolean }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="text-[10.5px] text-dim">{it.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className={cx('num text-[19px] font-semibold', it.accent ? 'text-iterate' : 'text-ink')}>
              {it.value}
            </span>
            <span className="text-[10px] text-dim">{it.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-[10.5px]">
        <span className="text-muted">{label}</span>
        <span className="text-dim">{unit}</span>
      </span>
      <input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="num w-full rounded-lg border border-line bg-base px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand/60"
      />
    </label>
  );
}

function Seg({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex-1 whitespace-nowrap rounded-md py-1.5 text-[11px] transition-colors',
        active ? 'bg-panel text-ink shadow-sm' : 'text-dim hover:text-muted',
      )}
    >
      {label}
    </button>
  );
}

/** 手写 SVG 折线：不需要图例、不需要 tooltip，只要让人一眼看到「越精确越贵」 */
function DaysCurve({ points, currentLift }: { points: Array<{ lift: number; days: number }>; currentLift: number }) {
  const W = 620;
  const H = 158;
  const padL = 40;   // 左边给 y 轴数字留位置
  const padR = 26;   // 右边留位置，否则最后一个「50%」会被裁掉
  const padB = 24;
  const padT = 12;
  const maxLift = Math.max(...points.map((p) => p.lift));
  const minLift = Math.min(...points.map((p) => p.lift));
  // 个别输入下天数会到几千天，直接画会把其余点压成一条直线，所以上限截到 120 天并在轴上注明
  const capped = points.map((p) => ({ ...p, days: Math.min(p.days, 120) }));
  const maxDays = Math.max(...capped.map((p) => p.days), 1);
  const x = (lift: number) => padL + ((lift - minLift) / Math.max(1e-9, maxLift - minLift)) * (W - padL - padR);
  const y = (days: number) => padT + (1 - days / maxDays) * (H - padT - padB);
  const path = capped.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.lift).toFixed(1)},${y(p.days).toFixed(1)}`).join(' ');
  const cur = points.find((p) => p.lift === currentLift);
  // 只标 4 个 x 标签：全标会挤成一排（2%/3%/5% …）
  const labelEvery = Math.max(1, Math.ceil(points.length / 4));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="所需天数随效应大小的变化">
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={padL}
          x2={W - padR}
          y1={padT + f * (H - padT - padB)}
          y2={padT + f * (H - padT - padB)}
          stroke="currentColor"
          className="text-line"
          strokeWidth={1}
        />
      ))}
      <text x={padL - 6} y={padT + 4} textAnchor="end" className="num" fontSize={9} fill="currentColor" opacity={0.55}>
        {maxDays >= 120 ? '120+' : Math.round(maxDays)}
      </text>
      <text x={padL - 6} y={H - padB + 3} textAnchor="end" className="num" fontSize={9} fill="currentColor" opacity={0.55}>
        0
      </text>
      <text x={padL - 6} y={(padT + H - padB) / 2} textAnchor="end" fontSize={8.5} fill="currentColor" opacity={0.4}>
        天
      </text>
      <path d={path} fill="none" stroke="currentColor" className="text-brand" strokeWidth={2} strokeLinejoin="round" />
      {capped.map((p, i) => (
        <g key={p.lift}>
          <circle cx={x(p.lift)} cy={y(p.days)} r={2.6} fill="currentColor" className="text-brand" />
          {(i % labelEvery === 0 || i === capped.length - 1) && (
            <text
              x={x(p.lift)}
              y={H - 8}
              textAnchor="middle"
              className="num"
              fontSize={9}
              fill="currentColor"
              opacity={0.55}
            >
              {p.lift}%
            </text>
          )}
        </g>
      ))}
      {cur && (
        <g>
          <line
            x1={x(cur.lift)}
            x2={x(cur.lift)}
            y1={padT}
            y2={H - padB}
            stroke="currentColor"
            className="text-ink"
            strokeDasharray="3 3"
            opacity={0.4}
          />
          {/* 标签放到点的右上方并夹在画布内：原来直接标在点上方，会和左上角的 y 轴最大值叠在一起 */}
          <text
            x={Math.min(W - padR - 18, x(cur.lift) + 7)}
            y={Math.max(padT + 9, y(Math.min(cur.days, 120)) - 7)}
            fontSize={9.5}
            fill="currentColor"
            className="text-ink"
          >
            {cur.days} 天
          </text>
        </g>
      )}
      <text x={W - padR} y={H - 8} textAnchor="end" fontSize={8.5} fill="currentColor" opacity={0.35}>
        越往右越好测
      </text>
    </svg>
  );
}
