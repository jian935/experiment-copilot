import { ShieldQuestion } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { msprtBestCaseZ } from '../../lib/sequential.ts';
import { fmtDiff, fmtP } from '../lib/format';
import { C } from '../lib/palette';
import { Panel, PanelHead, cx } from './ui';

/**
 * 序贯监控面板：把「你已经在偷看了」这件事画出来。
 *
 * 为什么不只给一个校正后的 p：因为读者真正想知道的是**代价有多贵**。
 * 所以图上同时有两条线 —— 未校正的 |z| 轨迹，和按 OBF α 消耗解出的边界；
 * 两条线的相对位置一眼就能看出「这次显著是真显著，还是看出来的」。
 */
export function SequentialPanel({ analysis }: { analysis: Analysis }) {
  const s = analysis.sequential;
  const unit = analysis.primary.unit;

  if (s.skipped || s.looks.length < 2) {
    return (
      <Panel className="mt-4">
        <PanelHead
          title="序贯监控（窥探校正）"
          hint="每天刷新看板会反复检验同一份数据，naive 的 5% 不再成立"
        />
        <p className="px-4 py-3 text-[11.5px] leading-5 text-dim">
          无法给出序贯校正：{s.skipped ?? '观察次数不足'}。
        </p>
      </Panel>
    );
  }

  const last = s.looks[s.looks.length - 1];
  const bestZ = msprtBestCaseZ(s.alpha);

  return (
    <Panel className="mt-4">
      <PanelHead
        title="序贯监控（窥探校正）"
        hint="每天刷新看板 = 反复检验同一份数据。这里给你「每天看一次需要多严的阈值」，以及同一份数据在三套口径下的判定"
        right={
          <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
            OBF / mSPRT · 已观察 {s.k} 次
          </span>
        }
      />

      <div className="grid gap-px bg-line sm:grid-cols-4">
        <Cell
          label="最终名义门槛"
          value={`p < ${fmtP(s.finalPBoundary)}`}
          sub={`naive 是 ${(s.alpha * 100).toFixed(0)}% → 收紧 ${s.obfTightening.toFixed(2)}×`}
          cls="text-ink"
        />
        <Cell
          label="always-valid p"
          value={fmtP(s.finalPAlways)}
          sub={`mSPRT 口径，任意停时都有效`}
          cls={s.alwaysSig ? 'text-ship' : 'text-muted'}
        />
        <Cell
          label="当前 z"
          value={last.z.toFixed(2)}
          sub={`边界 ±${last.zBoundary.toFixed(2)}`}
          cls={Math.abs(last.z) >= last.zBoundary ? 'text-ship' : 'text-muted'}
        />
        <Cell
          label="三套口径（曾达到显著）"
          value={`${s.naiveSig ? 'naive ✓' : 'naive ✗'} / ${s.obfSig ? 'OBF ✓' : 'OBF ✗'}`}
          sub={
            s.obfCrossDay
              ? `OBF 在第 ${s.obfCrossDay} 次越过 · always-valid ${s.alwaysSig ? '✓' : '✗'}`
              : `always-valid ${s.alwaysSig ? '✓' : '✗'}`
          }
          cls={s.naiveSig && !s.obfSig ? 'text-iterate' : 'text-ink'}
        />
      </div>

      <div className="px-3 pb-1 pt-3">
        <BoundaryChart analysis={analysis} />
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[10px] text-dim">
          <Legend color={C.brand} label={SEQUENTIAL_LEGEND.observed} />
          <Legend color={C.neutral} label={SEQUENTIAL_LEGEND.boundary} dashed />
          <Legend color={C.zero} label={SEQUENTIAL_LEGEND.naive} dashed />
        </div>
      </div>

      <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
        你已经在 {s.k} 次观察里反复看了同一份数据。naive 的 p 只对「只看一次」成立——
        零效应下每天看一次、共看 7 次，实际误报率约 <b className="text-ink">17%</b>，不是 5%
        （A/A 模拟实测，见 <span className="font-mono">tests/sequential.test.ts</span>）。
        OBF α 消耗把总量守住：最后一天必须 p &lt; <b className="text-ink">{fmtP(s.finalPBoundary)}</b> 才算显著；
        想「随时都能看」就得用 mSPRT，代价是门槛进一步抬到约{' '}
        <b className="text-ink">{bestZ.toFixed(1)}σ</b>（先验尺度取 τ = {fmtDiff(s.priorScale, unit)}，
        即「刚好能检出的效应」，必须在看数据之前定好，否则不再 valid）。
        {s.naiveSig && !s.obfSig && (
          <> {' '}本实验正是<b className="text-ink">被偷看校正拦下</b>的那一类：naive 口径说显著，OBF 口径说还不到。</>
        )}
        {s.obfCrossDay && !s.obfSigNow && (
          <>
            {' '}第 {s.obfCrossDay} 次观察曾越过边界——序贯检验的规矩是<b className="text-ink">一停即结论</b>：
            当时就该停下并宣布。如果一路看到第 {s.k} 次，这次 |z| = {last.z.toFixed(2)} 已回落到边界{' '}
            {last.zBoundary.toFixed(2)} 之下，此刻再看就不能算数了（反复"等它涨回来"正是序贯校正要防的事）。
          </>
        )}
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

/**
 * |z| 轨迹 vs OBF 边界。
 *
 * x 轴用「观察序号」而不是日期：序贯检验的横轴是**信息量**，不是日历时间——
 * 把不等长的观察按日期等距画会让读者以为边界是按天算的。
 */
function BoundaryChart({ analysis }: { analysis: Analysis }) {
  const s = analysis.sequential;
  const W = 680;
  const H = 190;
  const padL = 34;
  const padR = 46;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxZ = Math.max(2.4, ...s.looks.map((l) => Math.max(Math.abs(l.z), l.zBoundary)));
  const yMax = Math.ceil(maxZ + 0.4);
  const x = (i: number) => padL + (s.looks.length === 1 ? plotW / 2 : (i / (s.looks.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;

  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const zs = s.looks.map((l) => Math.abs(l.z));
  const bd = s.looks.map((l) => l.zBoundary);
  const ticks = Array.from({ length: yMax + 1 }, (_, i) => i);
  const last = s.looks[s.looks.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="累计 z 与序贯边界">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9.5} fill={C.dim} className="num">
            {t}
          </text>
        </g>
      ))}

      {/* naive 阈值：不校正时大家用的那条线 */}
      <line x1={padL} x2={W - padR} y1={y(1.96)} y2={y(1.96)} stroke={C.zero} strokeWidth={1} strokeDasharray="2 3" />
      <text x={padL + 2} y={y(1.96) - 4} fontSize={9} fill={C.dim}>
        naive 1.96
      </text>

      {/* OBF 边界：早期极宽、末期收紧 */}
      <path d={path(bd)} fill="none" stroke={C.neutral} strokeWidth={1.6} />
      <path d={path(bd)} fill="none" stroke={C.neutral} strokeWidth={7} opacity={0.08} />

      {/* 累计 |z| 轨迹 */}
      <path d={path(zs)} fill="none" stroke={C.brand} strokeWidth={2} strokeLinejoin="round" />
      {zs.map((v, i) => {
        const out = v >= bd[i];
        return (
          <g key={i}>
            <circle cx={x(i)} cy={y(v)} r={out ? 4 : 3} fill={out ? C.ship : C.brand} stroke="#ffffff" strokeWidth={1.5} />
            <title>
              第 {s.looks[i].day} 天（{s.looks[i].date}）· 信息量 {(s.looks[i].infoFrac * 100).toFixed(0)}%
              {'\n'}|z| = {v.toFixed(2)} · 边界 {bd[i].toFixed(2)} · naive p = {s.looks[i].pNaive < 1e-4 ? '<0.0001' : s.looks[i].pNaive.toFixed(4)}
            </title>
          </g>
        );
      })}

      {/* 最后一次观察的竖线：这才是「要不要下结论」的位置 */}
      <line x1={x(s.looks.length - 1)} x2={x(s.looks.length - 1)} y1={padT} y2={padT + plotH} stroke={C.line2} strokeWidth={1} />

      <text x={padL} y={H - 8} fontSize={9.5} fill={C.dim}>
        第 1 次观察（信息量 {(s.looks[0].infoFrac * 100).toFixed(0)}%）
      </text>
      <text x={W - padR} y={H - 8} textAnchor="end" fontSize={9.5} fill={C.dim}>
        第 {s.k} 次（100%）· 门槛 p &lt; {fmtP(last.pBoundary)}
      </text>
      <text x={padL - 22} y={padT + 6} fontSize={9.5} fill={C.dim}>
        |z|
      </text>
    </svg>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={14} height={6} aria-hidden>
        <line x1={0} x2={14} y1={3} y2={3} stroke={color} strokeWidth={2} strokeDasharray={dashed ? '2 2' : undefined} />
      </svg>
      {label}
    </span>
  );
}

/** 序贯图表在图例里要说明的语义（导出/文档复用，避免两处措辞不一致） */
export const SEQUENTIAL_LEGEND = {
  observed: '累计 |z|（橙色实线，每天累计重估一次）',
  boundary: 'OBF α 消耗边界（灰色虚线，早期极宽、末期收紧）',
  naive: 'naive 阈值 1.96（点线，只在"只看一次"时成立）',
} as const;
