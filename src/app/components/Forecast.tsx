import { useMemo } from 'react';
import { Timer } from 'lucide-react';
import {
  FORECAST_ASSUMPTIONS,
  FORECAST_ASSUMPTION_CONTINUOUS,
  dailyRatePerArm,
  forecast,
  type ForecastResult,
} from '../../lib/forecast.ts';
import type { DailyRow } from '../../lib/types.ts';
import { fmtNum } from '../lib/format';
import { C } from '../lib/palette';
import { Panel, PanelHead, cx } from './ui';

/**
 * 「还要跑几天」面板。
 *
 * 这一块要回答的是产品经理每天真正在问的问题：不是「现在显不显著」，而是「我还要等多久」。
 * 两个口径都给（点估计外推 + 概率模拟），并且把「大概率等不到」单独说清楚 ——
 * 只给一个中位天数会把「其实永远等不到」伪装成「再等等就好」。
 */
export function ForecastPanel({
  rows,
  diff,
  se,
  kind = 'rate',
  baselineValue,
  horizonDays = 30,
  elapsedDays,
}: {
  rows: DailyRow[];
  /** 决策口径的差值 / 标准误（来自 analysis.primary） */
  diff: number;
  se: number;
  /** 主指标类型：率指标走二项功效，ARPU 走 SE ∝ 1/√n */
  kind?: 'rate' | 'continuous';
  /** control 的水平值（连续指标展示用） */
  baselineValue?: number;
  horizonDays?: number;
  elapsedDays?: number;
}) {
  const f = useMemo(() => {
    let n1 = 0, c1 = 0, n2 = 0, c2 = 0;
    for (const r of rows) {
      if (r.variant === 'control') {
        n1 += r.exposures;
        c1 += r.conversions;
      } else {
        n2 += r.exposures;
        c2 += r.conversions;
      }
    }
    const days = new Set(rows.map((r) => r.date)).size;
    return forecast({
      n1,
      c1,
      n2,
      c2,
      kind,
      baselineValue,
      diff,
      se,
      dailyRate: dailyRatePerArm(rows, 3),
      elapsedDays: elapsedDays ?? days,
      horizonDays,
      sims: 2000,
      seed: 20261101,
    });
  }, [rows, diff, se, kind, baselineValue, horizonDays, elapsedDays]);

  const tone =
    f.verdict.code === 'done' ? C.ship : f.verdict.code === 'unlikely' ? C.iterate : C.brand;

  return (
    <Panel className="mt-4">
      <PanelHead
        title="还要跑几天"
        hint="把当前流量与效应外推到未来：两种口径同时给——点估计外推（假设效应为真）与概率模拟（效应本身也不确定）"
        right={
          <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
            {f.sim.sims.toLocaleString('en-US')} 次模拟 · 种子 {f.sim.seed}
          </span>
        }
      />
      <div className="grid gap-px bg-line sm:grid-cols-4">
        <Cell
          label="预计还需"
          value={
            f.verdict.code === 'done'
              ? '已可结论'
              : f.sim.medianDays === null
                ? '无法预测'
                : `约 ${f.sim.medianDays} 天`
          }
          sub={f.verdict.code === 'done' ? '不必再等' : '跑到这天约 50% 把握'}
          cls={tone}
        />
        <Cell
          label="80% 把握"
          value={f.sim.p80Days === null ? '—' : `${f.sim.p80Days} 天`}
          sub={`20% 分位 ${f.sim.p20Days ?? '—'} 天`}
        />
        <Cell
          label={`跑满 ${f.sim.horizonDays} 天仍等不到`}
          value={`${(f.sim.stuck * 100).toFixed(0)}%`}
          sub={f.sim.stuck >= 0.5 ? '大概率等不到' : '大概率能等到'}
          cls={f.sim.stuck >= 0.5 ? 'text-iterate' : 'text-muted'}
        />
        <Cell
          label="按当前点估计需要"
          value={
            f.point.requiredNPerArm === Infinity
              ? '∞'
              : `${fmtNum(f.point.requiredNPerArm)}/组`
          }
          sub={
            f.point.unrealistic
              ? '这个效应小到不值得等'
              : `已达标 ${Math.min(100, Math.round((f.observed.nPerArm / f.point.requiredNPerArm) * 100))}%`
          }
        />
      </div>

      <div className="px-3 pt-3">
        <Curve f={f} />
      </div>

      <div className="flex items-start gap-2 border-t border-line px-4 py-2.5">
        <Timer size={12} className="mt-0.5 shrink-0" style={{ color: tone }} />
        <p className="text-[11.5px] leading-5 text-muted">{f.verdict.text}</p>
      </div>

      <details className="group border-t border-line px-4 py-2">
        <summary className="cursor-pointer list-none text-[10.5px] text-dim hover:text-muted">
          口径与假设（4 条，都是简化，不藏）· 每臂日均 {fmtNum(f.rate.perArmPerDay)} 曝光
        </summary>
        <ul className="mt-1.5 space-y-0.5 pl-3 text-[10.5px] leading-4 text-dim">
          {FORECAST_ASSUMPTIONS.map((a) => (
            <li key={a} className="list-disc">
              {a}
            </li>
          ))}
          {kind === 'continuous' && <li className="list-disc">{FORECAST_ASSUMPTION_CONTINUOUS}</li>}
          <li className="list-disc">
            曲线是「跑到第 d 天时 p &lt; α」的模拟比例（每天单独判一次），不是「天天盯盘、第一次显著就停」——
            后者会因为反复检验而虚高把握度（peeking bias），这一版故意不用那个口径。
          </li>
        </ul>
      </details>
    </Panel>
  );
}

function Cell({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="bg-panel px-3.5 py-2.5">
      <div className="text-[10px] text-dim">{label}</div>
      <div className={cx('num mt-0.5 text-[15px] font-medium', cls ?? 'text-ink')}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

function Curve({ f }: { f: ForecastResult }) {
  const W = 680;
  const H = 136;
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const horizon = f.sim.horizonDays;
  const x = (d: number) => padL + (d / horizon) * plotW;
  const y = (p: number) => padT + (1 - p) * plotH;

  const pts = f.sim.curve.map((c) => `${x(c.day)},${y(c.p)}`).join(' ');
  const area = `${padL},${y(0)} ${pts} ${x(horizon)},${y(0)}`;
  const median = f.sim.medianDays;

  // x 轴刻度：0 / 1/4 / 1/2 / 3/4 / 满
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(r * horizon));
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="把握度随时间上升的曲线">
      <defs>
        <linearGradient id="fcFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.brand} stopOpacity={0.18} />
          <stop offset="100%" stopColor={C.brand} stopOpacity={0.02} />
        </linearGradient>
      </defs>

      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9.5} fill={C.dim} className="num">
            {(t * 100).toFixed(0)}%
          </text>
        </g>
      ))}

      {xTicks.map((d) => (
        <text key={`x${d}`} x={x(d)} y={H - padB + 15} textAnchor="middle" fontSize={9.5} fill={C.dim} className="num">
          {d === 0 ? '现在' : `+${d} 天`}
        </text>
      ))}

      {/* 50% 参考线 */}
      <line x1={padL} x2={W - padR} y1={y(0.5)} y2={y(0.5)} stroke={C.zero} strokeWidth={1} strokeDasharray="3 3" />

      <polygon points={area} fill="url(#fcFill)" />
      <polyline points={pts} fill="none" stroke={C.brand} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {median !== null && (
        <g>
          <line x1={x(median)} x2={x(median)} y1={padT} y2={y(0)} stroke={C.brand} strokeWidth={1} strokeDasharray="2 3" opacity={0.55} />
          <circle cx={x(median)} cy={y(0.5)} r={3} fill={C.brand} stroke="#ffffff" strokeWidth={1.4} />
        </g>
      )}

      {/* 曲线末端标注 */}
      <circle cx={x(horizon)} cy={y(f.sim.curve.at(-1)!.p)} r={3} fill="#ffffff" stroke={C.brand} strokeWidth={1.6} />
    </svg>
  );
}
