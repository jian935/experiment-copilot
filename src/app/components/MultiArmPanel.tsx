/**
 * 多臂（A/B/n）对比面板。
 *
 * 为什么值得单独一块面板，而不是「把三个臂当成三次两两比较」：
 * 1. 同一份数据被比 3 次，每次 α=0.05，全零族下「至少误报一次」的概率会到 ~12%（k=3 处理臂）；
 * 2. 所有臂共享**同一个对照组**，所以各臂的差值彼此**正相关**（等样本时 ρ≈0.5）——
 *    Bonferroni 完全忽略这点，会过度保守，白白多要样本；
 * 3. 「挑点估计最大的那个上」在零效应下也会挑出一个看起来有 2 个标准误的赢家。
 *
 * 所以这里三件事一起给：Dunnett 同时区间/校正 p（控 FWER 且利用相关）、
 * P(best)（后验概率，回答「最可能是它吗」）、全局检验（这个实验到底测出东西没有）。
 */
import { ArrowUpRight, Crown, FlaskConical, Info, ShieldAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { armLabel } from '../../lib/arms.ts';
import { fmtCI, fmtDiff, fmtNum, fmtP, fmtPct, liftClass } from '../lib/format';
import { Panel, PanelHead } from './ui';

export function MultiArmPanel({ analysis }: { analysis: Analysis }) {
  const ma = analysis.multiArm;
  const P = analysis.primary;
  if (!ma) return null;

  const control = analysis.arms.find((a) => a.isControl);
  const treatments = analysis.arms.filter((a) => !a.isControl);
  const focus = analysis.arms.find((a) => a.id === ma.focus);
  const byBest = [...analysis.arms].sort((a, b) => b.pBest - a.pBest);
  const bfGap = ma.bonferroniCritZ - ma.crit;

  return (
    <Panel className="mt-4">
      <PanelHead
        title={`多臂对比（${ma.k} 个臂 · ${ma.comparisons} 次比较）`}
        hint="每个臂都与对照组比。p 值已按 Dunnett 校正（控制「至少误报一次」的概率 ≤ α），同时区间跨 0 ⟺ 校正后不显著"
        right={
          <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
            Dunnett · α = {ma.alpha} · 临界 z = {ma.crit.toFixed(3)}
          </span>
        }
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-[10.5px] text-dim">
              <th className="px-4 py-2 text-left font-medium">臂</th>
              <th className="px-2 py-2 text-right font-medium">样本</th>
              <th className="px-2 py-2 text-right font-medium">主指标</th>
              <th className="px-2 py-2 text-right font-medium">差值（同时 95% 区间）</th>
              <th className="px-2 py-2 text-right font-medium">相对提升</th>
              <th className="px-2 py-2 text-right font-medium" title="单次比较的 p，仅供参考；决策看校正后的">
                边际 p
              </th>
              <th className="px-2 py-2 text-right font-medium" title="Dunnett 校正后 p：这是决策该看的那个">
                校正 p
              </th>
              <th className="px-2 py-2 text-right font-medium" title="这个臂是最优臂的后验概率">
                P(best)
              </th>
              <th className="px-4 py-2 text-left font-medium">护栏</th>
            </tr>
          </thead>
          <tbody>
            {analysis.arms.map((arm) => {
              const isFocus = arm.id === ma.focus;
              const worse = arm.guardrails.filter((g) => g.worse);
              return (
                <tr
                  key={arm.id}
                  className={`border-b border-line/60 last:border-0 ${
                    isFocus ? 'bg-brand/[0.055]' : arm.isControl ? 'bg-panel2/40' : ''
                  }`}
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-medium ${arm.isControl ? 'text-muted' : 'text-ink'}`}>
                        {armLabel(arm.id)}
                      </span>
                      {arm.isControl && (
                        <span className="rounded bg-panel2 px-1 py-0.5 text-[9.5px] text-dim">对照</span>
                      )}
                      {isFocus && !arm.isControl && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-brand/15 px-1 py-0.5 text-[9.5px] text-brand2">
                          <Crown size={9} /> 决策依据
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[9.5px] text-dim">{arm.id}</div>
                  </td>
                  <td className="num px-2 py-2 text-right text-muted">{fmtNum(arm.n)}</td>
                  <td className="num px-2 py-2 text-right text-ink">
                    {P.kind === 'continuous' ? fmtDiff(arm.value, P.unit) : fmtPct(arm.value)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {arm.isControl ? (
                      <span className="text-dim">—</span>
                    ) : (
                      <div className="flex flex-col items-end">
                        <span className={`num ${liftClass(arm.diff)}`}>{fmtDiff(arm.diff, P.unit)}</span>
                        <span className="num text-[10px] text-dim">
                          [{fmtDiff(arm.ci[0], P.unit)}, {fmtDiff(arm.ci[1], P.unit)}]
                        </span>
                      </div>
                    )}
                  </td>
                  <td className={`num px-2 py-2 text-right ${arm.isControl ? 'text-dim' : liftClass(arm.diff)}`}>
                    {arm.isControl ? '—' : fmtPct(arm.relativeLift)}
                  </td>
                  <td className="num px-2 py-2 text-right text-dim">{arm.isControl ? '—' : fmtP(arm.pRaw)}</td>
                  <td className="num px-2 py-2 text-right">
                    {arm.isControl ? (
                      '—'
                    ) : (
                      <span className={arm.pAdj < ma.alpha ? 'font-medium text-ship' : 'text-muted'}>
                        {fmtP(arm.pAdj)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="num text-muted">{(arm.pBest * 100).toFixed(1)}%</span>
                      <span className="h-1 w-10 overflow-hidden rounded-full bg-panel2">
                        <span
                          className="block h-full rounded-full bg-brand/70"
                          style={{ width: `${Math.max(1, arm.pBest * 100)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {arm.guardrails.length === 0 ? (
                      <span className="text-[10px] text-dim">无数据</span>
                    ) : worse.length === 0 ? (
                      <span className="text-[10px] text-ship">未触发</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-noship">
                        <ShieldAlert size={10} /> {worse.map((g) => g.label).join('、')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 三条解读：全局检验 / 赢家 / 校正代价 */}
      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
        <Cell
          icon={<FlaskConical size={12} />}
          label="全局检验（这个实验测出东西没有）"
          value={`χ² = ${ma.global.chi2.toFixed(2)}，df = ${ma.global.df}，p = ${fmtP(ma.global.p)}`}
          tone={ma.global.p < ma.alpha ? 'ship' : 'mute'}
          note={
            ma.global.p < ma.alpha
              ? '整体存在差异：可以继续看是哪个臂'
              : '整体没测出差异：此时任何单臂「显著」都更可能是噪声'
          }
        />
        <Cell
          icon={<Crown size={12} />}
          label="最可能最优的臂"
          value={`${armLabel(byBest[0].id)} · P(best) = ${(byBest[0].pBest * 100).toFixed(1)}%`}
          tone={byBest[0].pBest > 0.5 ? 'ship' : 'mute'}
          note={
            focus && focus.id !== byBest[0].id
              ? `决策没有跟着 P(best) 走：它选的是「校正后显著且点估计最大」的 ${armLabel(focus.id)}`
              : ma.focusReason === 'best-significant'
                ? '决策依据 = 校正后显著里点估计最大的那个'
                : ma.focusReason === 'best-point'
                  ? '没有臂通过校正：焦点退回点估计最大，但结论不据此判上线'
                  : '组别是对照组以外的唯一处理臂'
          }
        />
        <Cell
          icon={<Info size={12} />}
          label="赢家诅咒与校正代价"
          value={`全零时「挑最大」也会虚高 ≈ ${fmtDiff(ma.winnerCurse, P.unit)}`}
          tone="mute"
          note={`Dunnett 临界值 ${ma.crit.toFixed(3)} vs Bonferroni ${ma.bonferroniCritZ.toFixed(3)}（差 ${bfGap.toFixed(3)} 个 SE）——共享对照组让各臂相关，Bonferroni 白付了这部分代价`}
        />
      </div>

      <p className="px-4 py-2.5 text-[11px] leading-5 text-dim">
        {control && treatments.length > 0 && (
          <>
            对照组 <b className="text-ink">{armLabel(control.id)}</b>（n={fmtNum(control.n)}，
            {P.kind === 'continuous' ? fmtDiff(control.value, P.unit) : fmtPct(control.value)}）与{' '}
            {treatments.length} 个处理臂比较。
          </>
        )}
        SRM 期望按
        {ma.srmSource === 'declared'
          ? '实验元信息声明的分流比例'
          : ma.srmSource === 'trafficSplit'
            ? 'trafficSplit 字段'
            : '等分（数据里没有分流声明，比例可能不对）'}
        计算：{ma.srmRatios.map((r) => `${(r * 100).toFixed(0)}%`).join(' / ')}。
        单臂的同时区间比两臂口径更宽，这不是保守设定，而是「同时看 k−1 个区间」的必要代价。
        {P.kind === 'continuous' && analysis.cuped && (
          <>
            {' '}注：两臂的 ARPU 区间用 t（df 由格子数估，本实验 df={analysis.cuped.df}），
            而多臂的同时区间按 z 计算——每臂格子少时它会比两臂口径<b className="text-ink">略窄</b>。
            这是已知偏差，写在面板上而不是藏起来。
          </>
        )}
      </p>
    </Panel>
  );
}

function Cell({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  tone: 'ship' | 'mute';
}) {
  return (
    <div className="bg-panel px-4 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-dim">
        {icon}
        {label}
      </div>
      <div className={`mt-1 num text-[12.5px] font-medium ${tone === 'ship' ? 'text-ship' : 'text-ink'}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] leading-4 text-dim">{note}</div>
    </div>
  );
}

/** 让「多臂实验」在列表页也能一眼看出来 */
export function ArmBadge({ arms }: { arms: string[] }) {
  if (arms.length <= 2) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-brand/12 px-1.5 py-0.5 text-[10px] text-brand2"
      title={`${arms.length} 个臂：${arms.map(armLabel).join(' / ')}`}
    >
      <ArrowUpRight size={9} />
      {arms.length} 臂
    </span>
  );
}

/** 给趋势图用的多序列标签（单臂实验只有两条线，不用这个） */
export function armSeriesLabel(id: string): string {
  return armLabel(id);
}
