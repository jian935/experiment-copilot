import { fmtP, fmtPP } from '../lib/format';

export interface ForestRow {
  label: string;
  sublabel?: string;
  diff: number;
  ci: [number, number];
  p: number;
  emphasized?: boolean;
}

/**
 * 手写 SVG 森林图：比图表库更可控，且刻度/零点/CI 端点都能精确对齐。
 * 语义：点 = 差值（treatment − control），横线 = 95% CI（Newcombe）；竖虚线 = 0。
 */
export function Forest({ rows, height }: { rows: ForestRow[]; height?: number }) {
  const W = 680;
  const labelW = 92;
  const valueW = 146;
  const rowH = 30;
  const padTop = 12;
  const padBottom = 30;
  const H = height ?? padTop + rows.length * rowH + padBottom;

  const lo = Math.min(0, ...rows.map((r) => r.ci[0]));
  const hi = Math.max(0, ...rows.map((r) => r.ci[1]));
  const span = Math.max(hi - lo, 0.004);
  const pad = span * 0.14;
  const x0 = lo - pad;
  const x1 = hi + pad;
  const plotW = W - labelW - valueW;
  const x = (v: number) => labelW + ((v - x0) / (x1 - x0)) * plotW;
  const zero = x(0);

  // 刻度：整数 pp 步长
  const spanPP = (x1 - x0) * 100;
  const step = spanPP > 12 ? 5 : spanPP > 6 ? 2 : 1;
  const ticks: number[] = [];
  const start = Math.ceil((x0 * 100) / step) * step;
  for (let t = start; t <= x1 * 100 + 1e-9; t += step) ticks.push(t / 100);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="差值 95% 置信区间">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={padTop - 4} y2={H - padBottom + 2} stroke="#1a2436" strokeWidth={1} />
          <text
            x={x(t)}
            y={H - padBottom + 16}
            textAnchor="middle"
            className="num"
            fontSize={10}
            fill="#6b7c96"
          >
            {t > 0 ? '+' : ''}
            {(t * 100).toFixed(0)}
          </text>
        </g>
      ))}
      {/* 零点参考线 */}
      <line x1={zero} x2={zero} y1={padTop - 6} y2={H - padBottom + 2} stroke="#5b6b85" strokeWidth={1} strokeDasharray="3 3" />

      {rows.map((r, i) => {
        const cy = padTop + i * rowH + rowH / 2;
        const sig = r.p < 0.05;
        const color = r.diff > 0 ? '#34d399' : r.diff < 0 ? '#fb7185' : '#94a3b8';
        const dotColor = sig ? color : '#64748b';
        const radius = r.emphasized ? 5 : 4;
        const lx = x(Math.max(x0, r.ci[0]));
        const hx = x(Math.min(x1, r.ci[1]));
        return (
          <g key={r.label + i}>
            <text x={0} y={cy + 1} fontSize={11.5} fill={r.emphasized ? '#e9eef8' : '#93a3bb'} fontWeight={r.emphasized ? 600 : 400}>
              {r.label}
            </text>
            {r.sublabel && (
              <text x={0} y={cy + 13} fontSize={9.5} fill="#5f6f88">
                {r.sublabel}
              </text>
            )}
            <line x1={lx} x2={hx} y1={cy} y2={cy} stroke={dotColor} strokeWidth={r.emphasized ? 2.4 : 1.6} opacity={0.85} strokeLinecap="round" />
            <line x1={lx} x2={lx} y1={cy - 4} y2={cy + 4} stroke={dotColor} strokeWidth={1.4} opacity={0.85} />
            <line x1={hx} x2={hx} y1={cy - 4} y2={cy + 4} stroke={dotColor} strokeWidth={1.4} opacity={0.85} />
            <circle cx={x(r.diff)} cy={cy} r={radius} fill={dotColor} stroke="#0d1320" strokeWidth={1.5} />
            <text x={W - valueW + 4} y={cy + 1} fontSize={11} fill={sig ? color : '#7c8ba3'} className="num">
              {fmtPP(r.diff)}
            </text>
            <text x={W - 2} y={cy + 1} fontSize={10} fill="#5f6f88" className="num" textAnchor="end">
              {sig ? fmtP(r.p) : `p=${fmtP(r.p)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
