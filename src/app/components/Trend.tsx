import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyRow } from '../../lib/types';
import { fmtNum, fmtPct } from '../lib/format';
import { C } from '../lib/palette';

interface Point {
  date: string;
  control: number | null;
  treatment: number | null;
  nc: number;
  nt: number;
}

export function Trend({ rows }: { rows: DailyRow[] }) {
  const data = useMemo<Point[]>(() => {
    const byDate = new Map<string, { c: number; nc: number; t: number; nt: number }>();
    for (const r of rows) {
      const cur = byDate.get(r.date) ?? { c: 0, nc: 0, t: 0, nt: 0 };
      if (r.variant === 'control') {
        cur.c += r.conversions;
        cur.nc += r.exposures;
      } else {
        cur.t += r.conversions;
        cur.nt += r.exposures;
      }
      byDate.set(r.date, cur);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date: date.slice(5),
        control: v.nc ? v.c / v.nc : null,
        treatment: v.nt ? v.t / v.nt : null,
        nc: v.nc,
        nt: v.nt,
      }));
  }, [rows]);

  const lo = Math.min(...data.flatMap((d) => [d.control ?? 1, d.treatment ?? 1]));
  const hi = Math.max(...data.flatMap((d) => [d.control ?? 0, d.treatment ?? 0]));
  const pad = Math.max((hi - lo) * 0.25, 0.002);

  return (
    <div className="h-[176px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -14 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: C.dim, fontSize: 10 }}
            axisLine={{ stroke: C.line }}
            tickLine={false}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tick={{ fill: C.dim, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
            width={52}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-lg border border-line2 bg-panel px-3 py-2 text-[11px] shadow-xl">
                  <div className="mb-1 text-dim">{label}</div>
                  <div className="num flex items-center gap-2 text-ink">
                    <i className="h-1.5 w-1.5 rounded-full " />
                    control {fmtPct(p.control ?? 0)} · n={fmtNum(p.nc)}
                  </div>
                  <div className="num mt-0.5 flex items-center gap-2 text-brand2">
                    <i className="h-1.5 w-1.5 rounded-full bg-brand2" />
                    treatment {fmtPct(p.treatment ?? 0)} · n={fmtNum(p.nt)}
                  </div>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="control"
            stroke={C.neutral}
            strokeWidth={1.8}
            dot={{ r: 2.2, fill: C.neutral, strokeWidth: 0 }}
            activeDot={{ r: 3.5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="treatment"
            stroke={C.brand}
            strokeWidth={2}
            dot={{ r: 2.2, fill: C.brand, strokeWidth: 0 }}
            activeDot={{ r: 3.5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
