/**
 * 稳健性面板：极端值（长尾）有没有在替你做决定。
 *
 * 为什么 ARPU 实验必须看这一块，而转化率实验不用：
 * 转化率是比例，均值唯一决定方差；ARPU 是「收入 ÷ 人数」的比值，
 * 2% 的用户付了 190 元就能把均值抬起来。于是同一个 +8%，
 * 可能是「整体都变好了」，也可能是「三个代购账号恰好落在这组」。
 *
 * 这块面板只做三件互相独立的事，缺一件就会得出相反的错觉：
 *   1. 截尾扫描 —— 把最极端的 p% 行按分位线压平，看结论是否还站得住；
 *   2. 集中度  —— 极端值到底占多少收入（不依赖任何分位选择）；
 *   3. 单点杠杆 —— 精确删掉一行重算，看哪一行在决定结论。
 *
 * 面板底部固定展示两条边界：截尾单位 = 数据粒度；截尾 p 值不是显著性结论。
 * 这两句话不是免责声明，是这张表的读数前提 —— 不写，读者会把「截尾后 p=0.03」当成新结论。
 */
import { Info, Scaling, ShieldCheck, TrendingUp, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { RobustnessReport, SensitivityPoint } from '../../lib/robust.ts';
import { fmtDiff, fmtNum, fmtP } from '../lib/format';
import { C } from '../lib/palette';
import { Panel, PanelHead } from './ui';

const VERDICT_META = {
  stable: { label: '结论稳定', cls: 'bg-ship/12 text-ship ring-ship/25', Icon: ShieldCheck },
  sensitive: { label: '对极值敏感', cls: 'bg-iterate/12 text-iterate ring-iterate/25', Icon: TriangleAlert },
  flip: { label: '符号会翻转', cls: 'bg-noship/12 text-noship ring-noship/25', Icon: TriangleAlert },
  unavailable: { label: '不可用', cls: 'bg-panel2 text-dim ring-line2', Icon: Info },
} as const;

export function RobustnessPanel({ analysis }: { analysis: Analysis }) {
  const r = analysis.robustness;
  const P = analysis.primary;
  // 只有 ARPU 这类连续指标才有这块；率指标的极端值问题是另一个（不存在的）问题
  if (!r) return null;

  const meta = VERDICT_META[r.verdict];
  const base = r.grid[0];
  const last = r.grid[r.grid.length - 1];
  const perRowShare =
    r.concentration.totalExposures > 0
      ? r.medianExposuresPerRow / r.concentration.totalExposures
      : 0;

  return (
    <Panel className="mt-4">
      <PanelHead
        title="稳健性：极端值有没有替你做决定"
        hint="ARPU 是「收入 ÷ 人数」的比值，几个大客户就能把均值抬起来。这里把最极端的 p% 行按分位线压平，看结论是否还站得住"
        right={
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] ring-1 ${meta.cls}`}>
            <meta.Icon size={10} /> {meta.label}
          </span>
        }
      />

      <div className="flex items-start gap-2 border-b border-line bg-panel2/50 px-4 py-2.5">
        <meta.Icon size={13} className={`mt-0.5 shrink-0 ${r.verdict === 'stable' ? 'text-ship' : 'text-iterate'}`} />
        <p className="text-[11.5px] leading-5 text-muted">{r.reason}</p>
      </div>

      {r.verdict === 'unavailable' ? (
        <p className="px-4 py-3 text-[11px] leading-5 text-dim">
          这条诊断本次没有跑出来，原因如上。<b className="text-ink">不能把「不可用」当成「没问题」</b>——
          它意味着这份数据（或这个指标）根本没法回答「结论靠不靠极端值」。
        </p>
      ) : (
        <>
          <div className="grid gap-px bg-line lg:grid-cols-[1fr_330px]">
            <div className="bg-panel px-3 py-3">
              <SensitivityChart points={r.grid} unit={P.unit} alpha={P.p} />
            </div>
            <div className="overflow-x-auto bg-panel">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-line text-[10px] text-dim">
                    <th className="px-3 py-1.5 text-left font-medium">截尾档位</th>
                    <th className="px-2 py-1.5 text-right font-medium">差值</th>
                    <th className="px-2 py-1.5 text-right font-medium" title="只用来判断「结论翻不翻」，不是显著性结论：截尾分位是看着数据定的，p 没有名义 α 保证">
                      p*
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium" title="被压平的行数 / 占全部曝光的比例">
                      压平行数
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.grid.map((g) => (
                    <tr
                      key={g.p}
                      className={`border-b border-line/60 last:border-0 ${g.p === 0 ? 'bg-panel2/50' : ''}`}
                    >
                      <td className="px-3 py-1.5">
                        <span className="num text-ink">
                          {g.p === 0 ? '原始' : `${(g.p * 100).toFixed(1)}%`}
                        </span>
                      </td>
                      <td className={`num px-2 py-1.5 text-right ${g.diff >= 0 ? 'text-ship' : 'text-noship'}`}>
                        {fmtDiff(g.diff, P.unit)}
                      </td>
                      <td className={`num px-2 py-1.5 text-right ${g.sig ? 'text-ink' : 'text-dim'}`}>
                        {fmtP(g.pValue)}
                      </td>
                      <td className="num px-2 py-1.5 text-right text-dim">
                        {g.clippedHigh === 0 ? '—' : `${g.clippedHigh} 行 · ${(g.exposureTouchedShare * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[10px] leading-4 text-dim">
                <b className="text-muted">p*</b> 只用来判读「结论翻不翻」，不是显著性结论（理由见面板底部）。
                <br />
                名义上截 1%，实际会压平更多流量：一档最少也要吃下一整行。
                {perRowShare > 0 && (
                  <>
                    {' '}本数据每行中位占全部曝光 {(perRowShare * 100).toFixed(1)}%，
                    {base && last.clippedHigh > 0 ? '所以最小档位也只能从 1 行起跳。' : ''}
                  </>
                )}
              </p>
            </div>
          </div>

          {/* 集中度 + 杠杆 */}
          <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
            <div className="bg-panel px-4 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-dim">
                <Scaling size={11} /> 收入集中度（不依赖分位选择）
              </div>
              <div className="mt-1 space-y-1">
                {r.concentration.top.map((t) => (
                  <div key={t.pct} className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-muted">
                      最重的 {(t.pct * 100).toFixed(0)}% 曝光
                    </span>
                    <span className="num text-[11.5px] text-ink">
                      {(t.revenueShare * 100).toFixed(1)}% 收入
                      <span className="ml-1 text-[9.5px] text-dim">
                        （等额基准 {(t.pct * 100).toFixed(0)}%）
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] leading-4 text-dim">
                Gini {r.concentration.gini.toFixed(3)}（0 = 人人等额，1 = 全在一个人身上）。
                {r.concentration.payerShare < 1
                  ? `有收入的曝光占 ${(r.concentration.payerShare * 100).toFixed(1)}%——ARPU 的分子只来自这部分人。`
                  : '本数据每行都有收入（聚合格子），「付费率」这层信息在用户级明细下才有意义。'}
              </div>
            </div>
            <div className="bg-panel px-4 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-dim">
                <TrendingUp size={11} /> 单点杠杆：删掉这一行，结论会变成什么
              </div>
              {r.leverage.length ? (
                <div className="mt-1 space-y-1">
                  {r.leverage.map((l) => (
                    <div key={l.key} className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px] text-muted" title={`${l.label}（${l.arm}）`}>
                        {l.label}
                        <span className="ml-1 text-[9.5px] text-dim">
                          人均 {fmtDiff(l.arpu, '元')} · 占该臂 {(l.shareOfArmRevenue * 100).toFixed(1)}%
                        </span>
                      </span>
                      <span className={`num shrink-0 text-[11px] ${Math.abs(l.dP) > 0.1 ? 'text-iterate' : 'text-muted'}`}>
                        p {fmtP(base?.pValue ?? 1)} → {fmtP(l.pWithout)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[11px] leading-4 text-dim">两臂分布对称，没有任何一行能单独掀动结论。</p>
              )}
              <div className="mt-1.5 text-[10px] leading-4 text-dim">
                精确重算（leave-one-row-out），不是解析近似——ARPU 是比值估计量，一行同时经过分子和分母。
              </div>
            </div>
          </div>
        </>
      )}

      <p className="border-t border-line px-4 py-2.5 text-[11px] leading-5 text-dim">
        <b className="text-ink">截尾单位 = 你的数据粒度。</b>
        {r.granularity === 'user'
          ? '这份数据是用户级明细（每行约 1 人），所以截尾真正作用在用户身上。'
          : `这份数据是聚合格子（每行中位 ${fmtNum(r.medianExposuresPerRow)} 次曝光），截尾去掉的是「整格异常」（某一天被刷、某个人群灌量），` +
            '控制不了格子内部的长尾；要真正的用户级截尾，需要用户级明细表（一行一个用户，exposures=1）。'}{' '}
        <b className="text-ink">截尾 p 值不是显著性结论。</b>
        {r.caveat} 依据：
        <code className="mx-1 rounded bg-panel2 px-1 font-mono text-[10px]">npm run robust</code>
        每档 300 次模拟显示，重尾数据（κ=200）下截尾口径的 95% 区间只覆盖真值 33.67%，而原始口径仍有 94.67%
        —— 覆盖率塌掉说明它估的是「截尾后的 ARPU 差」，一个不同的量。
      </p>
    </Panel>
  );
}

/**
 * 敏感性曲线：横轴是截尾比例，纵轴是两臂差值，带 95% 区间。
 *
 * 为什么值得画而不是只给表格：表格里每档的差值只差 0.00X 元时，
 * 「稳不稳」是看不出来的；画成线之后「一条贴着 0 线的平线」和「一路向下穿过 0 的斜线」
 * 一眼就能分开 —— 后者正是「结论靠极端值」的样子。
 */
function SensitivityChart({
  points,
  unit,
  alpha,
}: {
  points: SensitivityPoint[];
  unit: 'pp' | '元';
  alpha: number;
}) {
  const W = 560;
  const H = 138;
  const L = 54;
  const R = 12;
  const T = 10;
  const B = 22;
  void alpha;

  const xs = points.map((p) => p.p);
  const maxX = Math.max(...xs, 1e-6);
  const vals = points.flatMap((p) => [p.diff, p.ci95[0], p.ci95[1], 0]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || Math.max(0.01, Math.abs(hi) * 0.2);
  const y0 = lo - pad;
  const y1 = hi + pad;
  const X = (p: number) => L + (p / maxX) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

  const band =
    points.map((p) => `${X(p.p).toFixed(1)},${Y(p.ci95[1]).toFixed(1)}`).join(' ') +
    ' ' +
    [...points].reverse().map((p) => `${X(p.p).toFixed(1)},${Y(p.ci95[0]).toFixed(1)}`).join(' ');
  const line = points.map((p) => `${X(p.p).toFixed(1)},${Y(p.diff).toFixed(1)}`).join(' ');
  const up = points.map((p) => `${X(p.p).toFixed(1)},${Y(p.ci95[1]).toFixed(1)}`).join(' ');
  const dn = points.map((p) => `${X(p.p).toFixed(1)},${Y(p.ci95[0]).toFixed(1)}`).join(' ');
  const zeroY = Y(0);
  const lastPt = points[points.length - 1];
  const ticks = [y1 - pad, (y0 + y1) / 2, y0 + pad];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="截尾敏感性曲线">
      {/* 0 线：差值在这里意味着「没有效应」 */}
      <line x1={L} x2={W - R} y1={zeroY} y2={zeroY} stroke={C.zero} strokeDasharray="3 3" strokeWidth={1} />
      {/* 纵轴刻度：三个档就够读数，再多会和区间带抢注意力 */}
      {ticks.map((v, i) => (
        <text key={i} x={L - 5} y={Y(v) + 3} textAnchor="end" fontSize={8.5} fill={C.dim}>
          {fmtDiff(v, unit)}
        </text>
      ))}

      <polygon points={band} fill={C.brand} opacity={0.14} />
      {/* 区间带的上下边界画出来，否则「一条粗带」会被当成折线本身 */}
      <polyline points={up} fill="none" stroke={C.brand} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.55} />
      <polyline points={dn} fill="none" stroke={C.brand} strokeWidth={0.8} strokeDasharray="2 2" opacity={0.55} />
      <polyline points={line} fill="none" stroke={C.brand} strokeWidth={1.8} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle
          key={p.p}
          cx={X(p.p)}
          cy={Y(p.diff)}
          r={i === 0 ? 3 : 2.2}
          fill={i === 0 ? C.brand2 : C.brand}
          stroke={C.card}
          strokeWidth={i === 0 ? 1 : 0.6}
        />
      ))}
      {lastPt && (
        <text x={X(lastPt.p) - 3} y={Y(lastPt.diff) - 6} textAnchor="end" fontSize={8.5} fill={C.muted}>
          最狠一档 {fmtDiff(lastPt.diff, unit)}
        </text>
      )}

      {/* 横轴刻度 */}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={C.line} strokeWidth={1} />
      {points.map((p) => (
        <text key={p.p} x={X(p.p)} y={H - B + 11} textAnchor="middle" fontSize={8.5} fill={C.dim}>
          {p.p === 0 ? '原始' : `${(p.p * 100).toFixed(1)}%`}
        </text>
      ))}
      <text x={L} y={H - 2} fontSize={8.5} fill={C.dim}>
        截尾比例 →（越往右越狠）
      </text>
    </svg>
  );
}
