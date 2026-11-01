import { Clock } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { studentTInv } from '../../lib/stats.ts';
import { fmtDiff, fmtP } from '../lib/format';
import { C } from '../lib/palette';
import { Panel, PanelHead, cx } from './ui';

/**
 * 新颖效应面板：把「效应会不会随时间缩水」画出来。
 *
 * 为什么必须单独给一块：所有结论都看累计值，而累计值会把衰减平均掉——
 * 「前 3 天 +2pp、后 4 天归零」在累计曲线上永远是一条"稳定有效"的线。
 * 这块面板做的是把累计值拆回逐日，再按曝光量对半切，直接问"后半段还剩下多少"。
 */
export function NoveltyPanel({ analysis }: { analysis: Analysis }) {
  const n = analysis.novelty;
  const unit = analysis.primary.unit;

  if (n.skipped) {
    return (
      <Panel className="mt-4">
        <PanelHead
          title="新颖效应（时间维度）"
          hint="按曝光量把观察期对半切，看后半段的效应还剩多少"
        />
        <p className="px-4 py-3 text-[11.5px] leading-5 text-dim">无法给出衰减判定：{n.skipped}。</p>
      </Panel>
    );
  }

  const meta = PATTERN_META[n.pattern];
  const tcrit = n.df > 0 ? studentTInv(0.975, n.df) : 1.96;

  return (
    <Panel className="mt-4">
      <PanelHead
        title={
          <>
            <Clock size={13} className="text-brand" />
            新颖效应（时间维度）
          </>
        }
        hint="按曝光量对半切、两段各自估一次，再用日级聚类的 t 检验问「后半段是不是明显更低」"
        right={
          <span
            className={cx('rounded-md border px-2 py-0.5 text-[10.5px] font-medium', meta.cls)}
            title={meta.desc}
          >
            {meta.label}
          </span>
        }
      />

      <div className="grid gap-px bg-line sm:grid-cols-4">
        <Cell
          label={`前半段（${n.early.days} 天）`}
          value={fmtDiff(n.early.diff, unit)}
          sub={`日级聚类 SE ±${fmtDiff(n.early.se, unit).replace('+', '')}`}
          cls="text-ink"
        />
        <Cell
          label={`后半段（${n.late.days} 天）`}
          value={fmtDiff(n.late.diff, unit)}
          sub={`相对变化 ${n.relativeDelta === null ? '—（前半段≈0）' : `${(n.relativeDelta * 100).toFixed(1)}%`}`}
          cls={n.pattern === 'decay' ? 'text-noship' : 'text-ink'}
        />
        <Cell
          label="前后差 δ"
          value={fmtDiff(n.delta, unit)}
          sub={`p = ${fmtP(n.p)}（t = ${n.t.toFixed(2)}，ν = ${n.df.toFixed(1)}）`}
          cls={n.pattern === 'decay' ? 'text-noship' : n.pattern === 'growth' ? 'text-ship' : 'text-muted'}
        />
        <Cell
          label="可检出下限"
          value={`±${fmtDiff(n.detectableDelta, unit).replace('+', '')}`}
          sub="80% 功效；比这更小的衰减这个样本量看不出来"
          cls="text-muted"
        />
      </div>

      <div className="px-3 pb-1 pt-3">
        <DailyBars analysis={analysis} />
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[10px] text-dim">
          <Legend color={C.neutral} label={NOVELTY_LEGEND.early} />
          <Legend color={C.brand} label={NOVELTY_LEGEND.late} />
          <Legend color={C.brand2} label={NOVELTY_LEGEND.half} dashed />
          <Legend color={C.zero} label={NOVELTY_LEGEND.zero} dashed />
        </div>
      </div>

      <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
        按<b className="text-ink">曝光量</b>切分（累计曝光首次过半的那天，归前半段）而不是按日历天数等分——
        某天没跑量时按日历切会让两段样本严重失衡，δ 就被样本多的那段单方面主导。
        切点落在第 {n.points.filter((p) => p.half === 'early').length} 天，{n.early.days} 天 vs {n.late.days} 天。
        检验用日级聚类标准误 + Welch 自由度（ν = {n.df.toFixed(1)}，临界值 {tcrit.toFixed(2)} 而不是 1.96）：
        半段只有 3–4 天、十几个格子，任何"当天 SE"都会漏掉日间整体漂移——
        在 1000 个零效应 A/A 实验上，那样算的误报率是 12%（率）/ 15%（ARPU），换成现在这套是 4.8% / 6.4%。
        {n.pattern === 'stable' && (
          <>
            {' '}这里判「未见衰减」<b className="text-ink">不等于</b>没有衰减：小于 ±
            {fmtDiff(n.detectableDelta, unit).replace('+', '')} 的衰减这个样本量看不出来。
          </>
        )}
        {n.pattern === 'decay' && (
          <>
            {' '}后半段比前半段少了 <b className="text-ink">{fmtDiff(-n.delta, unit)}</b>
            {n.relativeDelta !== null && <>（相对衰减 {Math.abs(n.relativeDelta * 100).toFixed(1)}%）</>}
            ——累计曲线会把这件事平均掉，所以「整体有效」的结论未必在下一周还站得住。
          </>
        )}
        {n.pattern === 'growth' && <> 后半段明显强于前半段：可能是爬坡期（缓存预热、用户学习），也说明现在的累计值还偏低。</>}
        {' '}这块只做<b className="text-ink">检测</b>、不参与决策——真值标注按主指标 + 护栏口径，
        让衰减改变结论就等于改口径。
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
 * 逐日效应柱状图：每根柱子是一天的**独立**估计（不是累计），带 ±1 SE 误差棒；
 * 两条水平虚线是两段的日级均值，垂直虚线是切点。
 *
 * 为什么用柱状而不用累计折线：累计折线看起来永远“平滑有效”，
 * 而衰减恰恰是"每天单独看都在变弱"——只有逐日图能看出来。
 */
function DailyBars({ analysis }: { analysis: Analysis }) {
  const n = analysis.novelty;
  const pts = n.points;
  const W = 680;
  const H = 200;
  const padL = 46;
  const padR = 14;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const lo = Math.min(0, ...pts.map((p) => p.diff - 1.5 * p.se), n.early.diff, n.late.diff);
  const hi = Math.max(0, ...pts.map((p) => p.diff + 1.5 * p.se), n.early.diff, n.late.diff);
  const span = Math.max(hi - lo, 1e-9);
  const top = hi + span * 0.12;
  const bottom = lo - span * 0.12;
  const y = (v: number) => padT + plotH - ((v - bottom) / (top - bottom)) * plotH;
  const slot = plotW / pts.length;
  const barW = Math.min(38, slot * 0.56);
  const unit = analysis.primary.unit;

  const cutIdx = pts.filter((p) => p.half === 'early').length;

  /** 按单位格式化轴标签（率指标 ×100 成 pp，ARPU 直接是元） */
  const axis = (v: number) => (unit === '元' ? v.toFixed(1) : (v * 100).toFixed(1));
  const ticks = Array.from({ length: 5 }, (_, i) => bottom + ((top - bottom) * i) / 4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="逐日效应与前后半段对比">
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth={1} />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={9.5} fill={C.dim} className="num">
            {axis(v)}
          </text>
        </g>
      ))}
      <text x={padL - 34} y={padT + 4} fontSize={9} fill={C.dim}>
        {unit === '元' ? '元' : 'pp'}
      </text>

      {/* 零线 */}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={C.zero} strokeWidth={1} strokeDasharray="2 3" />

      {/* 切点竖线 */}
      <line
        x1={padL + cutIdx * slot}
        x2={padL + cutIdx * slot}
        y1={padT}
        y2={padT + plotH}
        stroke={C.neutral}
        strokeWidth={1}
        strokeDasharray="4 3"
      />

      {/* 两段的日级均值 */}
      {(['early', 'late'] as const).map((half) => {
        const est = half === 'early' ? n.early : n.late;
        const color = half === 'early' ? C.neutral : C.brand2;
        return (
          <g key={half}>
            <line
              x1={padL + (half === 'early' ? 1 : cutIdx + 1) * slot - slot * 0.42}
              x2={padL + (half === 'early' ? cutIdx : pts.length) * slot - slot * 0.42}
              y1={y(est.diff)}
              y2={y(est.diff)}
              stroke={color}
              strokeWidth={1.4}
              strokeDasharray="3 2"
            />
            <title>
              {half === 'early' ? '前半段' : '后半段'}日级均值 {fmtDiff(est.diff, unit)} · {est.days} 天
            </title>
          </g>
        );
      })}

      {pts.map((p, i) => {
        const cx0 = padL + i * slot + slot / 2;
        const color = p.half === 'early' ? C.neutral : C.brand;
        // 柱子从零线画到当日效应（不是从轴底），否则"零附近"和"很大"看起来一样高
        const yBase = y(0);
        const yVal = y(Math.min(Math.max(p.diff, bottom), top));
        const yTop = y(Math.min(p.diff + p.se, top));
        const yBot = y(Math.max(p.diff - p.se, bottom));
        return (
          <g key={p.day}>
            <rect
              x={cx0 - barW / 2}
              y={Math.min(yBase, yVal)}
              width={barW}
              height={Math.max(1.5, Math.abs(yBase - yVal))}
              rx={2}
              fill={color}
              opacity={p.half === 'early' ? 0.75 : 0.9}
            />
            <line x1={cx0} x2={cx0} y1={yTop} y2={yBot} stroke={color} strokeWidth={1.2} />
            <line x1={cx0 - 4} x2={cx0 + 4} y1={yTop} y2={yTop} stroke={color} strokeWidth={1.2} />
            <line x1={cx0 - 4} x2={cx0 + 4} y1={yBot} y2={yBot} stroke={color} strokeWidth={1.2} />
            <title>
              第 {p.day} 天（{p.date}）· 当日效应 {fmtDiff(p.diff, unit)} ± {fmtDiff(p.se, unit).replace('+', '')}
              {'\n'}样本 {Math.round(p.nPerArm)}/臂 · 占全期曝光 {(p.share * 100).toFixed(1)}%
              {p.sig ? ' · 当日显著' : ''}
            </title>
            <text x={cx0} y={H - 16} textAnchor="middle" fontSize={9} fill={C.dim} className="num">
              {p.day}
            </text>
          </g>
        );
      })}

      <text x={padL} y={H - 4} fontSize={9.5} fill={C.dim}>
        前半段（第 1–{cutIdx} 天）
      </text>
      <text x={W - padR} y={H - 4} textAnchor="end" fontSize={9.5} fill={C.dim}>
        后半段（第 {cutIdx + 1}–{pts.length} 天）· 切分按曝光量
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

const PATTERN_META: Record<string, { label: string; desc: string; cls: string }> = {
  stable: { label: '未见衰减', desc: '前后半段差异不显著（不等于没有衰减，见可检出下限）', cls: 'border-line bg-panel2/60 text-muted' },
  decay: { label: '效应在衰减', desc: '后半段显著低于前半段：累计值掩盖了这件事', cls: 'border-noship/30 bg-noship/5 text-noship' },
  growth: { label: '效应在增强', desc: '后半段显著高于前半段：可能是爬坡期，累计值偏低', cls: 'border-ship/30 bg-ship/5 text-ship' },
  insufficient: { label: '数据不足', desc: '日数或样本不够做前后半段对比', cls: 'border-line bg-panel2/60 text-dim' },
};

/** 图例措辞（导出与文档复用，避免两处说法不一致） */
export const NOVELTY_LEGEND = {
  early: '前半段逐日效应（灰柱，带 ±1 SE）',
  late: '后半段逐日效应（橙柱，带 ±1 SE）',
  half: '两段的日级均值（虚线）',
  zero: '零线',
} as const;
