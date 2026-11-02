/**
 * 维度切片面板：把「按设备 / 按新老」推广成「按任何一列切」。
 *
 * 三个刻意的取舍：
 *
 * 1. **维度用 chip 而不是下拉**。维度最多十来个，chip 能让人一眼看到「这份数据可切哪几维」；
 *    下拉会把「还有别的维度」藏起来——那正是切片功能最容易被忽略的地方。
 * 2. **每组都给 q（BH 校正后）而不是只给 p**。切 5 个组就有 5 次比较，
 *    直接看 p 一定会「找到一个显著」。面板底部还写明这次一共扫了几组。
 * 3. **「最强 vs 最弱」必须带区间重叠提示**。人看到 +1.4pp 与 +2.5pp 会本能地认为
 *    「老用户更好」，但那两个区间大概率重叠——不说，就等于在鼓励过度解读。
 */
import { Info, Layers, TriangleAlert } from 'lucide-react';
import type { Analysis, DimensionScan, SegmentTest } from '../../lib/decide.ts';
import { fmtDiff, fmtNum, fmtP, fmtPct, liftClass } from '../lib/format';
import { cx } from './ui';

/** 一个取值这一行有多少样本（率口径与连续口径分别存在 rate / ratio 里） */
function sampleOf(s: SegmentTest): number {
  if (s.rate) return s.rate.n1 + s.rate.n2;
  if (s.ratio) return s.ratio.n1 + s.ratio.n2;
  return 0;
}

export function DimensionChips({
  dims,
  value,
  onChange,
}: {
  dims: DimensionScan[];
  value: string;
  onChange: (key: string) => void;
}) {
  if (!dims.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      <Layers size={12} className="mr-0.5 text-dim" />
      {dims.map((d) => (
        <button
          key={d.key}
          onClick={() => onChange(d.key)}
          aria-pressed={d.key === value}
          title={
            d.source === 'data'
              ? '来自你数据里的维度列'
              : d.key === 'weekend'
                ? '从日期推导，不需要数据里多一列'
                : '内置维度'
          }
          className={cx(
            'rounded-md px-2 py-1 text-[11px] transition-colors',
            d.key === value
              ? 'bg-brand/15 text-brand2 ring-1 ring-brand/25'
              : 'text-muted hover:bg-panel2 hover:text-ink',
          )}
        >
          {d.label}
          <span className="ml-1 text-[9.5px] text-dim">{d.scanned}</span>
        </button>
      ))}
    </div>
  );
}

export function DimensionTable({ analysis, dim }: { analysis: Analysis; dim: DimensionScan | undefined }) {
  const P = analysis.primary;
  if (!dim) {
    return (
      <p className="px-4 py-3 text-[11px] leading-5 text-dim">
        这份数据没有可切的维度。设备与新老用户两列缺失，日期也不足 5 天——
        所以既切不出周内/周末，也没有引擎能扫的分组。
      </p>
    );
  }
  const h = dim.heterogeneity;
  const sig = (s: SegmentTest) => s.q <= analysis.segmentFdr;
  const kindWarn = P.kind === 'continuous' && dim.values.some((v) => v.kind === 'rate');

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-[10.5px] text-dim">
              <th className="px-4 py-2 text-left font-medium">{dim.label}</th>
              <th className="px-2 py-2 text-right font-medium">样本</th>
              <th className="px-2 py-2 text-right font-medium">对照</th>
              <th className="px-2 py-2 text-right font-medium">实验组</th>
              <th className="px-2 py-2 text-right font-medium">差值（95% CI）</th>
              <th className="px-2 py-2 text-right font-medium">p</th>
              <th className="px-4 py-2 text-right font-medium" title={`BH 校正后的 q（FDR ${analysis.segmentFdr}）：切 k 组就有 k 次比较，看 p 一定「找到一个显著」`}>
                校正 q
              </th>
            </tr>
          </thead>
          <tbody>
            {dim.values.map((s) => (
              <tr key={s.key} className={cx('border-b border-line/60 last:border-0', sig(s) && 'bg-brand/[0.045]')}>
                <td className="px-4 py-2">
                  <span className="text-ink">{s.label}</span>
                  {sig(s) && (
                    <span className="ml-1.5 rounded bg-brand/12 px-1 py-0.5 text-[9.5px] text-brand2">
                      校正后显著
                    </span>
                  )}
                </td>
                <td className="num px-2 py-2 text-right text-muted">{fmtNum(sampleOf(s))}</td>
                <td className="num px-2 py-2 text-right text-muted">
                  {P.kind === 'continuous' && s.kind === 'continuous' ? fmtDiff(s.controlValue, P.unit) : fmtPct(s.controlValue)}
                </td>
                <td className="num px-2 py-2 text-right text-muted">
                  {P.kind === 'continuous' && s.kind === 'continuous' ? fmtDiff(s.treatmentValue, P.unit) : fmtPct(s.treatmentValue)}
                </td>
                <td className="px-2 py-2 text-right">
                  <div className="flex flex-col items-end">
                    <span className={`num ${liftClass(s.diff)}`}>
                      {P.kind === 'continuous' && s.kind === 'continuous' ? fmtDiff(s.diff, P.unit) : fmtDiff(s.diff, 'pp')}
                    </span>
                    <span className="num text-[10px] text-dim">
                      [{P.kind === 'continuous' && s.kind === 'continuous' ? fmtDiff(s.ci95[0], P.unit) : fmtDiff(s.ci95[0], 'pp')},{' '}
                      {P.kind === 'continuous' && s.kind === 'continuous' ? fmtDiff(s.ci95[1], P.unit) : fmtDiff(s.ci95[1], 'pp')}]
                    </span>
                  </div>
                </td>
                <td className="num px-2 py-2 text-right text-muted">{fmtP(s.p)}</td>
                <td className={cx('num px-4 py-2 text-right', sig(s) ? 'font-medium text-brand2' : 'text-dim')}>
                  {s.q.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-line px-4 py-2.5 text-[11px] leading-5 text-dim">
        {h ? (
          <>
            <b className="text-ink">效应是否随「{dim.label}」变化：</b>
            Cochran Q = {h.q.toFixed(2)}，df = {h.df}，p = {fmtP(h.p)} →{' '}
            {h.p < analysis.segmentFdr ? (
              <b className="text-iterate">各取值之间确有差异</b>
            ) : (
              <>不能认为各取值之间有效应差异（这个样本量下差异不显著，不等于「完全一样」）</>
            )}
            。用 Q 而不是两两比：{dim.scanned} 个取值两两比要做 {((dim.scanned * (dim.scanned - 1)) / 2) || 0} 次比较，
            而 Q 是一个统计量，零假设是「所有取值的真实效应相同」，不随组数膨胀。
          </>
        ) : (
          <>「{dim.label}」只有 {dim.scanned} 个取值，做不了异质性检验。</>
        )}
        {dim.spread && (
          <>
            {' '}
            <b className="text-ink">最强 vs 最弱：</b>
            {dim.spread.bestLabel} 比 {dim.spread.worstLabel} 高{' '}
            {P.kind === 'continuous'
              ? fmtDiff(dim.spread.gap, P.unit)
              : fmtDiff(dim.spread.gap, 'pp')}
            {dim.spread.ciOverlap ? (
              <span className="text-iterate">
                ，但两者 95% 区间重叠——还不足以说它们真的不同
              </span>
            ) : (
              '，两者区间不重叠'
            )}
            。
          </>
        )}
      </div>

      {kindWarn && (
        <div className="flex items-start gap-1.5 border-t border-line bg-panel2/50 px-4 py-2 text-[10.5px] leading-4 text-dim">
          <TriangleAlert size={11} className="mt-0.5 shrink-0 text-iterate" />
          <span>
            主指标是 ARPU，但这个维度里有取值**独立格子不足 2 个**（那一组只有一天数据或没有分层），
            所以它退回率口径（百分点）。两种单位不能直接比大小——看那一行时请只读 p 与 q。
          </span>
        </div>
      )}

      {dim.source === 'data' && (
        <div className="flex items-start gap-1.5 border-t border-line px-4 py-2 text-[10.5px] leading-4 text-dim">
          <Info size={11} className="mt-0.5 shrink-0" />
          <span>
            这一维来自你数据里的列。取值超过 12 个的列不会被扫描——那种列切出来每组只剩几个格子，
            p 值全是噪声；要切就先在 SQL 里把长尾归并成「其他」。
          </span>
        </div>
      )}
    </div>
  );
}
