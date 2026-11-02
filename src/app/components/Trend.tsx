import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DailyRow } from '../../lib/types.ts';
import { nearestIndex, scaleY, xAt, yDomain, yTicks } from '../../lib/trendGeom.ts';
import { armLabel } from '../../lib/arms.ts';
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
 *
 * 多臂：`arms` 给了几条就画几条。两臂时颜色/线宽与历史版本逐像素一致
 * （对照 = neutral 1.8px，处理臂 = brand 2px），所以老截图不会变。
 */
const H = 176;
const PAD_T = 10;
const PAD_B = 20;
const PAD_L = 44;
const PAD_R = 12;

/** 第 3 条线起用的颜色：不新造色板变量，直接复用主题里已有的语义色 */
const EXTRA = [C.iterate, C.incon, C.brand2, C.ship, C.noship];

export function Trend({
  rows,
  kind = 'rate',
  arms = ['control', 'treatment'],
}: {
  rows: DailyRow[];
  kind?: 'rate' | 'continuous';
  /** 要画的臂（对照在前）。缺省是两臂，保持老行为 */
  arms?: string[];
}) {
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

  /**
   * 序列定义：颜色 / 线宽按「顺序」而不是「臂名」定，
   * 这样自定义臂名（"方案C"）也能拿到颜色，不必再维护一张臂名→颜色表。
   */
  const series = useMemo(
    () =>
      arms.map((id, i) => ({
        id,
        color: i === 0 ? C.neutral : i === 1 ? C.brand : EXTRA[(i - 2) % EXTRA.length],
        width: i === 0 ? 1.8 : 2,
      })),
    [arms.join('|')], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const data = useMemo(() => {
    const byDate = new Map<string, { c: number[]; n: number[]; rev: number[] }>();
    const idx = new Map(arms.map((a, i) => [a, i]));
    for (const r of rows) {
      const k = idx.get(r.variant);
      if (k === undefined) continue; // 不属于要画的臂（例如被过滤掉的空臂）
      let cur = byDate.get(r.date);
      if (!cur) {
        cur = { c: arms.map(() => 0), n: arms.map(() => 0), rev: arms.map(() => 0) };
        byDate.set(r.date, cur);
      }
      cur.c[k] += r.conversions;
      cur.n[k] += r.exposures;
      cur.rev[k] += r.revenue ?? 0;
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date: date.slice(5),
        vals: arms.map((_, i) =>
          v.n[i] ? (continuous ? v.rev[i] / v.n[i] : v.c[i] / v.n[i]) : null,
        ) as Array<number | null>,
        ns: v.n,
      }));
  }, [rows, continuous, arms.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (v: number) => (continuous ? `${v.toFixed(2)}元` : fmtPct(v));
  const vals = data.flatMap((d) => d.vals).filter((v): v is number => v !== null && Number.isFinite(v));
  // 这几个数组最多几十个元素，不值得 useMemo（依赖是每次新建的数组，写了也是每次重算）
  const [lo, hi] = yDomain(vals, continuous);
  const ticks = yTicks(lo, hi, continuous);

  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const y = (v: number) => scaleY(v, lo, hi, PAD_T, H - PAD_B);
  const xs = data.map((_, i) => xAt(i, data.length, plotW));

  const path = (k: number) => {
    const pts: string[] = [];
    data.forEach((d, i) => {
      const v = d.vals[k];
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
  const multi = arms.length > 2;

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      <svg
        width={w}
        height={H}
        role="img"
        aria-label={`分日趋势：${arms.map(armLabel).join(' / ')} 逐日对比`}
      >
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

        {series.map((s, k) => (
          <path key={s.id} d={path(k)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinejoin="round" />
        ))}

        {data.map((d, i) => {
          const x = PAD_L + xs[i];
          return (
            <g key={d.date}>
              {series.map((s, k) => {
                const v = d.vals[k];
                return v !== null && Number.isFinite(v) ? (
                  <circle key={s.id} cx={x} cy={y(v)} r={2.2} fill={s.color} />
                ) : null;
              })}
            </g>
          );
        })}

        {/* 悬停：竖线 + 各条线的点放大 */}
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
            {series.map((s, k) => {
              const v = active.vals[k];
              return v !== null && Number.isFinite(v) ? (
                <circle
                  key={s.id}
                  cx={PAD_L + xs[hover]}
                  cy={y(v)}
                  r={3.5}
                  fill={s.color}
                  stroke={C.card}
                  strokeWidth={1.5}
                />
              ) : null;
            })}
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

      {/* 多臂时必须有图例：三条线靠颜色区分，没图例等于没画 */}
      {multi && (
        <div className="pointer-events-none absolute right-2 top-0 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[9.5px] text-dim">
          {series.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1">
              <i className="h-1 w-3.5 rounded-full" style={{ background: s.color }} />
              {armLabel(s.id)}
            </span>
          ))}
        </div>
      )}

      {active && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line2 bg-panel px-3 py-2 text-[11px] shadow-lift"
          style={{
            // 靠左半边就往右放、靠右半边就往左放，别让提示框被面板裁掉
            left: PAD_L + xs[hover] + (xs[hover] > plotW * 0.6 ? -150 : 14),
            top: PAD_T + 6,
            width: multi ? 152 : 136,
          }}
        >
          <div className="mb-1 text-dim">{active.date}</div>
          {series.map((s, k) => {
            const v = active.vals[k];
            return (
              <div key={s.id} className="num mt-0.5 flex items-center gap-2" style={{ color: s.color }}>
                <i className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                {s.id === 'control' ? 'control' : s.id === 'treatment' ? 'treatment' : armLabel(s.id)}
                {v === null ? '—' : fmt(v)}
              </div>
            );
          })}
          <div className="num mt-1 text-[10px] text-dim">
            n = {active.ns.map((n) => fmtNum(n)).join(' / ')}
          </div>
        </div>
      )}
    </div>
  );
}
