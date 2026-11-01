import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DailyRow } from '../../lib/types.ts';
import { nearestIndex, scaleY, xAt, yDomain, yTicks, type TrendDatum } from '../../lib/trendGeom.ts';
import { fmtNum, fmtPct } from '../lib/format';
import { C } from '../lib/palette';

/**
 * 分日趋势（F9：去掉 Recharts，手写 SVG）。
 *
 * 为什么值得自己写：这一张图用到的只是「折线 + 虚线网格 + 两条轴的刻度 + 悬停取点」，
 * 而 Recharts 为此带进来 ~420KB（打包后的 JS 从 915KB 降到 490KB 左右）。
 * 更关键的是**颜色要跟主题走**：手写之后线色直接引用 CSS 变量，
 * 而图表库的内部样式要顺着它的 API 一个个塞进去，换主题时最容易漏。
 *
 * kind 决定纵轴是转化率还是 ARPU：ARPU 实验拿转化率画趋势会让人以为「没什么变化」，
 * 而实际收入可能已经明显上行——两个口径不能共用一张图。
 */
const H = 176;
const PAD_T = 10;
const PAD_B = 20;
const PAD_L = 44;
const PAD_R = 12;

export function Trend({ rows, kind = 'rate' }: { rows: DailyRow[]; kind?: 'rate' | 'continuous' }) {
  const continuous = kind === 'continuous';
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  // 按真实像素宽度画：viewBox 等比缩放会把 10px 的刻度文字压到 8px 以下
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(280, Math.round(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useMemo<TrendDatum[]>(() => {
    const byDate = new Map<string, { c: number; nc: number; t: number; nt: number; revC: number; revT: number }>();
    for (const r of rows) {
      const cur = byDate.get(r.date) ?? { c: 0, nc: 0, t: 0, nt: 0, revC: 0, revT: 0 };
      if (r.variant === 'control') {
        cur.c += r.conversions;
        cur.nc += r.exposures;
        cur.revC += r.revenue ?? 0;
      } else {
        cur.t += r.conversions;
        cur.nt += r.exposures;
        cur.revT += r.revenue ?? 0;
      }
      byDate.set(r.date, cur);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date: date.slice(5),
        control: continuous ? (v.nc ? v.revC / v.nc : null) : v.nc ? v.c / v.nc : null,
        treatment: continuous ? (v.nt ? v.revT / v.nt : null) : v.nt ? v.t / v.nt : null,
        nc: v.nc,
        nt: v.nt,
      }));
  }, [rows, continuous]);

  const fmt = (v: number) => (continuous ? `${v.toFixed(2)}元` : fmtPct(v));
  const vals = data.flatMap((d) => [d.control ?? NaN, d.treatment ?? NaN]).filter(Number.isFinite);
  // 这几个数组最多几十个元素，不值得 useMemo（依赖是每次新建的数组，写了也是每次重算）
  const [lo, hi] = yDomain(vals, continuous);
  const ticks = yTicks(lo, hi, continuous);

  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const y = (v: number) => scaleY(v, lo, hi, PAD_T, H - PAD_B);
  const xs = data.map((_, i) => xAt(i, data.length, plotW));

  const path = (key: 'control' | 'treatment') => {
    const pts: string[] = [];
    data.forEach((d, i) => {
      const v = d[key];
      if (v === null || !Number.isFinite(v)) return;
      pts.push(`${pts.length ? 'L' : 'M'}${PAD_L + xs[i]} ${y(v)}`);
    });
    return pts.join(' ');
  };

  const onMove = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
      setHover(nearestIndex(data.length, plotW, e.clientX - box.left));
    },
    [data.length, plotW],
  );

  const active = hover !== null ? data[hover] : undefined;

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      <svg width={w} height={H} role="img" aria-label="分日趋势：control 与 treatment 逐日对比">
        {/* 横向虚线网格 + 纵轴刻度 */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={w - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke={C.grid}
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text x={PAD_L - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={C.dim} className="num">
              {continuous ? t.toFixed(1) : `${(t * 100).toFixed(1)}%`}
            </text>
          </g>
        ))}

        {/* 日期：点多时隔一个画一个，挤在一起等于没画 */}
        {data.map((d, i) =>
          data.length <= 8 || i % 2 === 0 ? (
            <text key={d.date} x={PAD_L + xs[i]} y={H - 6} textAnchor="middle" fontSize={10} fill={C.dim} className="num">
              {d.date}
            </text>
          ) : null,
        )}

        <path d={path('control')} fill="none" stroke={C.neutral} strokeWidth={1.8} strokeLinejoin="round" />
        <path d={path('treatment')} fill="none" stroke={C.brand} strokeWidth={2} strokeLinejoin="round" />

        {data.map((d, i) => {
          const x = PAD_L + xs[i];
          return (
            <g key={d.date}>
              {d.control !== null && Number.isFinite(d.control) && (
                <circle cx={x} cy={y(d.control)} r={2.2} fill={C.neutral} />
              )}
              {d.treatment !== null && Number.isFinite(d.treatment) && (
                <circle cx={x} cy={y(d.treatment)} r={2.2} fill={C.brand} />
              )}
            </g>
          );
        })}

        {/* 悬停：竖线 + 两个点的放大 */}
        {active && hover !== null && (
          <g>
            <line
              x1={PAD_L + xs[hover]}
              x2={PAD_L + xs[hover]}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke={C.line2}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {active.control !== null && Number.isFinite(active.control) && (
              <circle cx={PAD_L + xs[hover]} cy={y(active.control)} r={3.5} fill={C.neutral} stroke={C.card} strokeWidth={1.5} />
            )}
            {active.treatment !== null && Number.isFinite(active.treatment) && (
              <circle cx={PAD_L + xs[hover]} cy={y(active.treatment)} r={3.5} fill={C.brand} stroke={C.card} strokeWidth={1.5} />
            )}
          </g>
        )}

        {/* 取点用的透明矩形（放在最后，才能盖住所有图形收到鼠标事件） */}
        <rect
          x={PAD_L}
          y={PAD_T}
          width={plotW}
          height={H - PAD_T - PAD_B}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {active && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line2 bg-panel px-3 py-2 text-[11px] shadow-lift"
          style={{
            // 靠左半边就往右放、靠右半边就往左放，别让提示框被面板裁掉
            left: PAD_L + xs[hover] + (xs[hover] > plotW * 0.6 ? -150 : 14),
            top: PAD_T + 6,
            width: 136,
          }}
        >
          <div className="mb-1 text-dim">{active.date}</div>
          <div className="num flex items-center gap-2 text-ink">
            <i className="h-1.5 w-1.5 rounded-full" style={{ background: C.neutral }} />
            {'control '}
            {fmt(active.control ?? 0)}
          </div>
          <div className="num mt-0.5 flex items-center gap-2 text-brand2">
            <i className="h-1.5 w-1.5 rounded-full bg-brand2" />
            {'treatment '}
            {fmt(active.treatment ?? 0)}
          </div>
          <div className="num mt-1 text-[10px] text-dim">
            n = {fmtNum(active.nc)} / {fmtNum(active.nt)}
          </div>
        </div>
      )}
    </div>
  );
}
