import { useMemo, useState } from 'react';
import { Scale } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { LOSS_GATES, applyGates, defaultLoss, expectedLoss, netValueAt } from '../../lib/loss.ts';
import { fmtDiff } from '../lib/format';
import { C } from '../lib/palette';
import { Panel, PanelHead, cx } from './ui';

/**
 * 期望损失面板：把「该不该上」翻译成两笔账。
 *
 * 频率派回答的是「显不显著」，业务要的是「值不值得上」。区别在两处：
 *   · p=0.19、点估计 +0.4pp —— 「不显著」和「上了没用」不是一个意思；
 *   · p<0.001、点估计 +0.05pp —— 「显著」也可能「上了不划算」。
 *
 * 面板把两个参数（风险厌恶 k、最小值得上线的提升 MMP）摆出来让人自己调，
 * 因为它们是**产品判断，不是统计结论**。改一个数就换一个结论，这件事必须被看见。
 */
export function LossPanel({ analysis }: { analysis: Analysis }) {
  const unit = analysis.primary.unit;
  const base = defaultLoss(unit);
  const [k, setK] = useState(base.riskAversion);
  const [mmp, setMmp] = useState(base.mmp);

  const d = useMemo(
    () => expectedLoss(analysis.primary.diff, analysis.primary.se, unit, { riskAversion: k, mmp }),
    [analysis.primary.diff, analysis.primary.se, unit, k, mmp],
  );
  const gate = useMemo(() => applyGates(d.action, analysis.reasonCode), [d.action, analysis.reasonCode]);

  const actionMeta =
    gate.action === 'ship'
      ? { label: '建议上线', cls: 'border-ship/30 bg-ship/5 text-ship' }
      : gate.action === 'no-ship'
        ? { label: '不值得上线', cls: 'border-noship/30 bg-noship/5 text-noship' }
        : { label: '分不出高下', cls: 'border-line bg-panel2/60 text-muted' };

  return (
    <Panel className="mt-4">
      <PanelHead
        title={
          <>
            <Scale size={13} className="text-brand" />
            期望损失决策（该不该上）
          </>
        }
        hint="把差值的后验当作 Normal(Δ̂, SE²)，算「上线」相对「不上线」的期望净价值"
        right={
          <span className={cx('rounded-md border px-2 py-0.5 text-[10.5px] font-medium', actionMeta.cls)}>
            {actionMeta.label}
          </span>
        }
      />

      <div className="grid gap-px bg-line sm:grid-cols-4">
        <Cell
          label="E[收益] · 上线能拿到"
          value={fmtDiff(d.eGain, unit)}
          sub="max(0, Δ) 的期望，不折风险"
          cls="text-ink"
        />
        <Cell
          label={`E[损失] × ${k}`}
          value={fmtDiff(-k * d.eHarm, unit)}
          sub={`未折风险的部分 ${fmtDiff(-d.eHarm, unit)}`}
          cls="text-noship"
        />
        <Cell
          label="净价值（已扣 MMP）"
          value={fmtDiff(d.netAfterMmp, unit)}
          sub={`MMP = ${fmtDiff(mmp, unit).replace('+', '')}；> 0 才建议上线`}
          cls={d.netAfterMmp > 0 ? 'text-ship' : 'text-noship'}
        />
        <Cell
          label="等价点"
          value={fmtDiff(d.breakEvenDiff, unit)}
          sub={`真实效应高于它才划算（点估计离它 ${d.breakEvenGapSe.toFixed(2)} 个 SE）`}
          cls="text-muted"
        />
      </div>

      {/* 门禁 / 建议 */}
      {gate.vetoed && (
        <div className="mx-4 mt-3 rounded-md border border-noship/25 bg-noship/5 px-3 py-2 text-[11px] leading-5 text-noship">
          <b>{gate.vetoCode}</b> 否决了净价值的结论：{gate.vetoReason}。
          这一层不看净价值多大——护栏是约束，不是可以被主指标收益抵掉的目标。
        </div>
      )}
      {gate.caution && (
        <div className="mx-4 mt-3 rounded-md border border-iterate/25 bg-iterate/5 px-3 py-2 text-[11px] leading-5 text-iterate">
          {gate.caution}。异质只给建议、不否决：整体效应是真的正的，判成「不上」等于白扔那部分收益。
        </div>
      )}

      <div className="px-3 pb-1 pt-3">
        <ValueCurve diff={analysis.primary.diff} se={analysis.primary.se} k={k} mmp={mmp} unit={unit} />
      </div>

      {/* 参数：必须显式摆出来，且标明「这是判断不是结论」 */}
      <div className="mx-4 mt-1 grid gap-3 rounded-md border border-line bg-panel2/40 px-3 py-2.5 sm:grid-cols-2">
        <Slider
          label="风险厌恶 k"
          hint="1 单位负向效应按 k 单位代价计"
          value={k}
          min={1}
          max={5}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={setK}
        />
        <Slider
          label="MMP（最小值得上线的提升）"
          hint={unit === '元' ? '发布/返工/维护折算成元' : '发布/返工/维护折算成 pp'}
          value={mmp}
          min={unit === '元' ? 0 : 0}
          max={unit === '元' ? 0.2 : 0.01}
          step={unit === '元' ? 0.005 : 0.0005}
          format={(v) => fmtDiff(v, unit).replace('+', '')}
          onChange={setMmp}
        />
      </div>

      <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
        净价值 = E[max(0,Δ)] − {k.toFixed(1)}·E[max(0,−Δ)] − MMP。两个参数是<b className="text-ink">产品判断</b>
        而非统计结论，所以它们可调、结论必须连带参数一起看。
        <b className="text-ink">k = 1 时这条规则会退化成「点估计 &gt; MMP 就上线」</b>
        ——E[max(0,Δ)] − E[max(0,−Δ)] 恒等于 Δ̂，把 k 拖到 1 能看到等价点直接掉到 MMP；
        也就是说这个工具的价值全在 k &gt; 1 与 MMP &gt; 0，不在数学花哨。
        {analysis.reasonCode === 'GUARDRAIL' && ' 这个实验的护栏已恶化，所以把 k 调到多小都不会变成「建议上线」。'}
        {' '}这块<b className="text-ink">不参与 decision</b>：决策口径由历史 120 条真值标注对账，改口径就得重标。
      </p>
    </Panel>
  );
}

function Cell({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div className={cx('num mt-1 text-[15px] font-semibold tracking-tight', cls)}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] text-muted">{label}</span>
        <span className="num text-[11px] font-semibold text-ink">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-line2 accent-brand"
        aria-label={label}
      />
      <div className="mt-0.5 text-[10px] text-dim">{hint}</div>
    </label>
  );
}

/**
 * 净价值曲线：横轴是「真实的 Δ」，纵轴是上线相对不上线的净价值。
 *
 * 为什么值得画：k > 1 时这条线在 0 附近**左右不对称**（负侧掉得更快），
 * 等价点因此被推到 0 右边。把当前点估计和等价点一起标出来，
 * 「为什么点估计明明是正的却还不建议上线」就变成一眼能看的事。
 */
function ValueCurve({
  diff,
  se,
  k,
  mmp,
  unit,
}: {
  diff: number;
  se: number;
  k: number;
  mmp: number;
  unit: 'pp' | '元';
}) {
  const W = 680;
  const H = 172;
  const padL = 46;
  const padR = 14;
  /** 顶部留 22px 给抬头（轴标题 + 「线在 0 上方」），否则会和最高刻度撞在一起 */
  const padT = 22;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const spread = Math.max(se * 2.5, Math.abs(diff) * 1.6, mmp * 2, 1e-9);
  const lo = diff - spread;
  const hi = diff + spread;
  const be = expectedLoss(diff, se, unit, { riskAversion: k, mmp }).breakEvenDiff;

  const f = (mu: number) => netValueAt(mu, se, k) - mmp;
  const N = 120;
  const mus = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const ys = mus.map(f);
  const yLo = Math.min(0, ...ys);
  const yHi = Math.max(0, ...ys);
  const ySpan = Math.max(yHi - yLo, 1e-12);
  const top = yHi + ySpan * 0.12;
  const bottom = yLo - ySpan * 0.12;

  const x = (mu: number) => padL + ((mu - lo) / (hi - lo)) * plotW;
  const y = (v: number) => padT + plotH - ((v - bottom) / (top - bottom)) * plotH;

  const path = mus.map((mu, i) => `${i ? 'L' : 'M'}${x(mu).toFixed(2)},${y(ys[i]).toFixed(2)}`).join(' ');
  const axis = (v: number) => (unit === '元' ? v.toFixed(2) : (v * 100).toFixed(1));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="净价值随真实效应的变化">
      {/* 横轴网格 */}
      {Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4).map((v, i) => (
        <g key={i}>
          <line x1={x(v)} x2={x(v)} y1={padT} y2={padT + plotH} stroke={C.grid} strokeWidth={1} />
          <text x={x(v)} y={H - 12} textAnchor="middle" fontSize={9} fill={C.dim} className="num">
            {axis(v)}
          </text>
        </g>
      ))}
      <text x={W - padR} y={H - 2} textAnchor="end" fontSize={9} fill={C.dim}>
        真实效应（{unit === '元' ? '元' : 'pp'}）
      </text>

      {/* 纵轴：只标 上界 / 0 / 下界 —— 净价值的绝对值不如"在 0 哪一侧"重要 */}
      {[...new Set([yHi, 0, yLo])].map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth={1} />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill={C.dim} className="num">
            {axis(v)}
          </text>
        </g>
      ))}

      {/* 零净价值线 */}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={C.zero} strokeWidth={1} strokeDasharray="2 3" />

      {/* Δ = 0 参考线 */}
      <line x1={x(0)} x2={x(0)} y1={padT} y2={padT + plotH} stroke={C.line2} strokeWidth={1} strokeDasharray="3 3" />

      <path d={path} fill="none" stroke={C.brand} strokeWidth={1.8} />

      {/* 等价点：标签放在零线**下方**，避免和「当前」挤在同一行（点估计接近等价点时会撞上） */}
      <circle cx={x(be)} cy={y(0)} r={3.5} fill={C.card} stroke={C.brand2} strokeWidth={1.8} />
      <text x={x(be)} y={y(0) + 13} textAnchor="middle" fontSize={9} fill={C.brand2} className="num">
        等价点 {fmtDiff(be, unit)}
      </text>

      {/* 当前点估计 */}
      <circle cx={x(diff)} cy={y(f(diff))} r={4} fill={C.brand} />
      <title>
        点估计 {fmtDiff(diff, unit)} → 净价值 {fmtDiff(f(diff), unit)}
      </title>
      {/* 当前点估计：标签跟着点走并夹在绘图区内，避免贴边时被裁掉 */}
      <text
        x={x(diff)}
        y={Math.min(Math.max(y(f(diff)) - 9, padT + 11), padT + plotH - 4)}
        textAnchor="middle"
        fontSize={9}
        fill={C.ink}
        className="num"
      >
        当前 {fmtDiff(diff, unit)}
      </text>

      {/* 抬头放在绘图区之上，和最高刻度错开一行 */}
      <text x={8} y={11} fontSize={9} fill={C.dim}>
        净价值（{unit === '元' ? '元' : 'pp'}）
      </text>
      <text x={W - 4} y={11} textAnchor="end" fontSize={9} fill={C.dim}>
        线在 0 上方 → 建议上线
      </text>
    </svg>
  );
}

/** 门禁措辞（导出给文档/图例复用，避免多处说法不一致） */
export const LOSS_GATE_LABEL = LOSS_GATES;
