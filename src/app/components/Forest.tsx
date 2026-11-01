import { fmtDiff, fmtP, type MetricUnit } from '../lib/format';
import { C } from '../lib/palette';

export interface ForestRow {
  label: string;
  sublabel?: string;
  diff: number;
  ci: [number, number];
  p: number;
  emphasized?: boolean;
}

/** 取「好看」的刻度步长：1 / 2 / 5 × 10^k */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * 手写 SVG 森林图：比图表库更可控，且刻度/零点/CI 端点都能精确对齐。
 * 语义：点 = 差值（treatment − control），横线 = 95% CI；竖虚线 = 0。
 *
 * unit 必须显式传：ARPU 的差值以元为单位、转化率以 pp 为单位，
 * 刻度步长与小数位都由单位决定，混用会出现「0.42 元画在 +42pp 的轴上」这种错。
 */
export function Forest({ rows, height, unit = 'pp' }: { rows: ForestRow[]; height?: number; unit?: MetricUnit }) {
  const W = 680;
  const labelW = 92;
  const valueW = 146;
  const rowH = 36;
  const padTop = 12;
  const padBottom = 30;
  const H = height ?? padTop + rows.length * rowH + padBottom;

  const lo = Math.min(0, ...rows.map((r) => r.ci[0]));
  const hi = Math.max(0, ...rows.map((r) => r.ci[1]));
  const span = Math.max(hi - lo, unit === '元' ? 0.02 : 0.004);
  const pad = span * 0.14;
  const x0 = lo - pad;
  const x1 = hi + pad;
  const plotW = W - labelW - valueW;
  const x = (v: number) => labelW + ((v - x0) / (x1 - x0)) * plotW;
  const zero = x(0);

  const step = niceStep((x1 - x0) / 5);
  const decimals =
    unit === 'pp' ? (step >= 0.01 ? 0 : 1) : step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const tickText = (v: number) => {
    const scaled = unit === 'pp' ? v * 100 : v;
    return `${v > 0 ? '+' : ''}${scaled.toFixed(decimals)}`;
  };
  const ticks: number[] = [];
  const decUnit = unit === 'pp' ? 100 : 1;
  const start = Math.ceil((x0 * decUnit) / step) * step;
  for (let t = start; t <= x1 * decUnit + 1e-9; t += step) ticks.push(t / decUnit);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="差值 95% 置信区间">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={padTop - 4} y2={H - padBottom + 2} stroke={C.grid} strokeWidth={1} />
          <text x={x(t)} y={H - padBottom + 16} textAnchor="middle" className="num" fontSize={10} fill={C.dim}>
            {tickText(t)}
          </text>
        </g>
      ))}
      {/* 单位标注：不写单位，读者无法区分 pp 与元 */}
      <text x={W - valueW - 6} y={H - padBottom + 16} textAnchor="end" fontSize={9} fill={C.dim}>
        {unit}
      </text>
      {/* 零点参考线 */}
      <line x1={zero} x2={zero} y1={padTop - 6} y2={H - padBottom + 2} stroke={C.zero} strokeWidth={1} strokeDasharray="3 3" />

      {rows.map((r, i) => {
        const cy = padTop + i * rowH + rowH / 2;
        const sig = r.p < 0.05;
        const color = r.diff > 0 ? C.ship : r.diff < 0 ? C.noship : C.incon;
        const dotColor = sig ? color : C.neutral;
        const radius = r.emphasized ? 5 : 4;
        const lx = x(Math.max(x0, r.ci[0]));
        const hx = x(Math.min(x1, r.ci[1]));
        return (
          <g key={r.label + i}>
            <text x={0} y={cy + 1} fontSize={11.5} fill={r.emphasized ? C.ink : C.muted} fontWeight={r.emphasized ? 600 : 400}>
              {r.label}
            </text>
            {r.sublabel && (
              <text x={0} y={cy + 14} fontSize={9.5} fill={C.dim}>
                {r.sublabel}
              </text>
            )}
            <line x1={lx} x2={hx} y1={cy} y2={cy} stroke={dotColor} strokeWidth={r.emphasized ? 2.4 : 1.6} opacity={0.85} strokeLinecap="round" />
            <line x1={lx} x2={lx} y1={cy - 4} y2={cy + 4} stroke={dotColor} strokeWidth={1.4} opacity={0.85} />
            <line x1={hx} x2={hx} y1={cy - 4} y2={cy + 4} stroke={dotColor} strokeWidth={1.4} opacity={0.85} />
            <circle cx={x(r.diff)} cy={cy} r={radius} fill={dotColor} stroke="#ffffff" strokeWidth={1.5} />
            <text x={W - valueW + 4} y={cy + 1} fontSize={11} fill={sig ? color : C.dim} className="num">
              {fmtDiff(r.diff, unit)}
            </text>
            <text x={W - 2} y={cy + 1} fontSize={10} fill={C.dim} className="num" textAnchor="end">
              {sig ? fmtP(r.p) : `p=${fmtP(r.p)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
