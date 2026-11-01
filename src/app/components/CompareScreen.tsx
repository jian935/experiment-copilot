import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, Check, Info, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { Dataset, Experiment } from '../../lib/types.ts';
import { compareExperiments } from '../../lib/compare.ts';
import { searchExperiments } from '../../lib/search.ts';
import { ARCHETYPE_LABEL, DECISION_META, fmtDiff, fmtNum, fmtP } from '../lib/format';
import { C } from '../lib/palette';
import { Forest, type ForestRow } from './Forest';
import { Button, DecisionBadge, Panel, PanelHead, cx } from './ui';

/**
 * 实验对比视图（F3）。
 *
 * 这个屏存在的理由不是「并排好看」，而是回答一个具体问题：
 * **同一个改动在两次实验里表现不一样，到底哪一次可信？**
 *
 * 因此有两件事必须做对：
 *
 * ① **两张森林图共用一条横轴**。各画一条轴会把「CI 一样长」画成两张图里不同的长度，
 *    眼睛读到的是「B 更不确定」而数据里根本没有这个差别。`Forest` 天然按所有行的
 *    min/max 定轴，所以只要两次实验**单位一致**就能直接同轴；单位不一致就拒绝同轴并说明。
 * ② **先说不可比的地方**。指标不同（转化率 vs ARPU）、观察天数不同、分流比例不同，
 *    任何一条成立时「谁的效应大」这句话就不成立。这些必须写在图上面，不能藏在脚注。
 */
export function CompareScreen({
  dataset,
  analyses,
  aId,
  bId,
  onBack,
  onOpen,
  go,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  aId: string | null;
  bId: string | null;
  onBack: () => void;
  onOpen: (id: string) => void;
  go: (hash: string) => void;
}) {
  const a = aId ? dataset.experiments.find((e) => e.id === aId) : undefined;
  const b = bId ? dataset.experiments.find((e) => e.id === bId) : undefined;

  if (!a || !b) {
    return (
      <Picker
        dataset={dataset}
        analyses={analyses}
        pinned={a}
        onBack={onBack}
        onPick={(id) => {
          if (!a) go(`#/compare?a=${id}`);
          else go(`#/compare?a=${a.id}&b=${id}`);
        }}
      />
    );
  }

  const aa = analyses.get(a.id);
  const ab = analyses.get(b.id);
  if (!aa || !ab) return <p className="p-10 text-sm text-muted">这两个实验的分析结果不可用。</p>;

  return <Comparison a={a} b={b} aa={aa} ab={ab} onBack={onBack} onOpen={onOpen} />;
}

function Comparison({
  a,
  b,
  aa,
  ab,
  onBack,
  onOpen,
}: {
  a: Experiment;
  b: Experiment;
  aa: Analysis;
  ab: Analysis;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const unitA = aa.primary.unit;
  const unitB = ab.primary.unit;

  /** 可比较性：每一条都是「这句话不能说」的理由，不是警告框里的装饰 */
  const cmp = useMemo(() => compareExperiments(a, aa, b, ab), [a, b, aa, ab]);
  const sameUnit = cmp.sharedAxis;
  const blockers = cmp.issues;

  const rows: ForestRow[] = [
    {
      label: a.id,
      sublabel: `${a.name} · ${DECISION_META[aa.decision]?.label ?? aa.decision}`,
      diff: aa.primary.diff,
      ci: aa.primary.ci95,
      p: aa.primary.p,
      emphasized: true,
    },
    {
      label: b.id,
      sublabel: `${b.name} · ${DECISION_META[ab.decision]?.label ?? ab.decision}`,
      diff: ab.primary.diff,
      ci: ab.primary.ci95,
      p: ab.primary.p,
      emphasized: true,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft size={13} /> 返回列表
        </Button>
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ArrowLeftRight size={15} className="text-brand" /> 实验对比
        </div>
        <span className="ml-auto text-[11px] text-dim">共用一条横轴 —— 长度差就是不确定性的差</span>
      </div>

      {/* 两结论卡 */}
      <div className="grid gap-3 md:grid-cols-2">
        {[
          { e: a, an: aa },
          { e: b, an: ab },
        ].map(({ e, an }) => (
          <Panel key={e.id} className="cursor-pointer transition-colors hover:border-line2" >
            <button className="w-full px-4 py-3 text-left" onClick={() => onOpen(e.id)}>
              <div className="flex items-center gap-2">
                <span className="num text-[11px] text-dim">{e.id}</span>
                <span className="truncate text-[13px] font-semibold text-ink">{e.name}</span>
                <span className="ml-auto shrink-0">
                  <DecisionBadge decision={an.decision} />
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-4">
                <span className={cx('num text-[19px] font-semibold', an.primary.diff > 0 ? 'text-ship' : 'text-noship')}>
                  {fmtDiff(an.primary.diff, an.primary.unit)}
                </span>
                <span className="text-[11px] text-muted">
                  p = {fmtP(an.primary.p)} · n = {fmtNum(an.overall.n1 + an.overall.n2)}
                </span>
              </div>
              <div className="mt-1 text-[10.5px] text-dim">
                {an.primary.label} · {ARCHETYPE_LABEL[e.archetype] ?? e.archetype} · {e.startDate} → {e.endDate}
              </div>
            </button>
          </Panel>
        ))}
      </div>

      {/* 可比性 */}
      {blockers.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {blockers.map((x, i) => (
            <div
              key={i}
              className={cx(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-5',
                x.level === 'block' ? 'border-noship/30 bg-noship/5 text-noship' : 'border-iterate/30 bg-iterate/5 text-iterate',
              )}
            >
              {x.level === 'block' ? <TriangleAlert size={12} className="mt-0.5 shrink-0" /> : <Info size={12} className="mt-0.5 shrink-0" />}
              <span>{x.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* 同轴森林图 */}
      <Panel className="mt-4">
        <PanelHead
          title="主指标差值（95% CI）"
          hint={
            sameUnit
              ? '两张图共用同一条横轴：线的长短可以直接比，这就是「谁更不确定」'
              : '单位不同，这里只画各自的形状，不共用横轴'
          }
        />
        <div className="px-3 py-2">
          {sameUnit ? (
            <Forest rows={rows} unit={unitA} height={140} />
          ) : (
            /* 单位不同时**竖排**，不并排：并排只能靠把两张图缩到半宽，
               而 Forest 是 viewBox 等比缩放——半宽会把刻度文字压到 7px，等于没画。 */
            <div className="space-y-3">
              <div className="rounded-lg border border-line/70 bg-panel2/40 px-2 pb-1 pt-2">
                <div className="px-1 text-[10.5px] text-dim">
                  {a.id} · 单位 {unitA} · 只有这一张的横轴
                </div>
                <Forest rows={[rows[0]]} unit={unitA} height={86} />
              </div>
              <div className="rounded-lg border border-line/70 bg-panel2/40 px-2 pb-1 pt-2">
                <div className="px-1 text-[10.5px] text-dim">
                  {b.id} · 单位 {unitB} · 只有这一张的横轴
                </div>
                <Forest rows={[rows[1]]} unit={unitB} height={86} />
              </div>
            </div>
          )}
        </div>
        <p className="px-4 pb-3 text-[11px] leading-5 text-dim">
          {sameUnit ? (
            <>
              为什么强调「共用一条横轴」：如果各画一条轴，两个不同的区间会被各自拉伸到差不多的长度，
              眼睛读到的是「一样确定」，而数据里可能一个跨 0 一个不跨。同轴之后，
              <b className="text-ink">线的长短本身就是结论</b>。
            </>
          ) : (
            <>
              所以这里宁可<b className="text-ink">竖排两张、各给一条轴</b>，也不把 {unitA} 和 {unitB} 塞进同一个坐标系：
              那样画出来的「长度差」完全由两个纵轴的缩放比例决定，与数据无关。
            </>
          )}
        </p>
      </Panel>

      {/* 并排明细 */}
      <Panel className="mt-4">
        <PanelHead title="逐项对照" hint="同一行同一口径，缺数据的格写「—」而不是空着（空着会被当成 0）" />
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-line text-[10.5px] text-dim">
                <th className="px-4 py-2 text-left font-normal">项目</th>
                <th className="px-3 py-2 text-left font-normal">{a.id}</th>
                <th className="px-3 py-2 text-left font-normal">{b.id}</th>
              </tr>
            </thead>
            <tbody>
              <Row label="结论" a={DECISION_META[aa.decision]?.label ?? aa.decision} b={DECISION_META[ab.decision]?.label ?? ab.decision} />
              <Row label="命中规则" a={aa.reasonCode} b={ab.reasonCode} mono />
              <Row
                label="主指标差值"
                a={fmtDiff(aa.primary.diff, unitA)}
                b={fmtDiff(ab.primary.diff, unitB)}
                aCls={aa.primary.diff > 0 ? 'text-ship' : 'text-noship'}
                bCls={ab.primary.diff > 0 ? 'text-ship' : 'text-noship'}
              />
              <Row
                label="95% CI"
                a={`[${fmtDiff(aa.primary.ci95[0], unitA).replace('+', '')}, ${fmtDiff(aa.primary.ci95[1], unitA)}]`}
                b={`[${fmtDiff(ab.primary.ci95[0], unitB).replace('+', '')}, ${fmtDiff(ab.primary.ci95[1], unitB)}]`}
              />
              <Row label="p 值" a={fmtP(aa.primary.p)} b={fmtP(ab.primary.p)} mono />
              <Row label="相对提升" a={pct(aa.primary.relativeLift)} b={pct(ab.primary.relativeLift)} />
              <Row label="样本" a={fmtNum(aa.overall.n1 + aa.overall.n2)} b={fmtNum(ab.overall.n1 + ab.overall.n2)} />
              <Row
                label="检验口径"
                a={aa.primary.via}
                b={ab.primary.via}
                mono
              />
              <Row
                label="CUPED 方差缩减"
                a={aa.cuped ? `${(aa.cuped.varReduction * 100).toFixed(1)}%` : '—'}
                b={ab.cuped ? `${(ab.cuped.varReduction * 100).toFixed(1)}%` : '—'}
              />
              <Row
                label="护栏拦截"
                a={blockedGuardrails(aa)}
                b={blockedGuardrails(ab)}
                aCls={blockedGuardrails(aa) === '无' ? 'text-ship' : 'text-noship'}
                bCls={blockedGuardrails(ab) === '无' ? 'text-ship' : 'text-noship'}
              />
              <Row
                label="分层异质"
                a={aa.heterogeneity.detected ? `是（${aa.heterogeneity.bestSegment ?? '某层'}）` : '否'}
                b={ab.heterogeneity.detected ? `是（${ab.heterogeneity.bestSegment ?? '某层'}）` : '否'}
              />
              <Row
                label="序贯（OBF 后）"
                a={aa.sequential.obfSig ? '仍显著' : '未达边界'}
                b={ab.sequential.obfSig ? '仍显著' : '未达边界'}
              />
              <Row
                label="新颖效应"
                a={noveltyLabel(aa)}
                b={noveltyLabel(ab)}
              />
              <Row label="SRM" a={aa.srm.flagged ? '异常' : '正常'} b={ab.srm.flagged ? '异常' : '正常'} />
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 px-1 text-[11px] leading-5 text-dim">
        这一屏只做<b className="text-ink">对照</b>，不产生新结论：两边的决策仍由各自的引擎判定，
        对比视图不改任何一条。如果两次实验结论相反而指标口径又一致，先看观察期与分流比例
        ——绝大多数「同一改动两种结果」都能从这里解释掉，剩下的才值得怀疑效应本身。
      </p>
    </div>
  );
}

function Row({
  label,
  a,
  b,
  aCls,
  bCls,
  mono,
}: {
  label: string;
  a: string;
  b: string;
  aCls?: string;
  bCls?: string;
  mono?: boolean;
}) {
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="px-4 py-2 text-dim">{label}</td>
      <td className={cx('px-3 py-2 text-ink', mono && 'font-mono text-[11px]', aCls)}>{a}</td>
      <td className={cx('px-3 py-2 text-ink', mono && 'font-mono text-[11px]', bCls)}>{b}</td>
    </tr>
  );
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

function blockedGuardrails(an: Analysis): string {
  // 只有「参与决策 ∧ 判定变差」的护栏才是拦截；只看 worse 会把不 gating 的提示算成拦截
  const hit = an.guardrails.filter((g) => g.gating && g.worse);
  return hit.length ? hit.map((g) => g.label).join(' / ') : '无';
}

function noveltyLabel(an: Analysis): string {
  if (an.novelty.skipped) return '数据不足';
  return an.novelty.pattern === 'decay' ? '在衰减' : an.novelty.pattern === 'growth' ? '在增强' : '未见衰减';
}

/* ───────────────────────── 选择器 ───────────────────────── */

function Picker({
  dataset,
  analyses,
  pinned,
  onBack,
  onPick,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  pinned: Experiment | undefined;
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const [kw, setKw] = useState('');
  // 与 ⌘K 共用同一个检索函数（`lib/search.ts`）：
  // 两处各写一份 includes，迟早会出现「⌘K 搜得到、这里搜不到」这种说不清的差异。
  const matched = useMemo(() => {
    if (!kw.trim()) return null;
    return new Set(searchExperiments(dataset.experiments, analyses, kw));
  }, [dataset.experiments, analyses, kw]);
  const list = dataset.experiments.filter((e) => {
    if (pinned && e.id === pinned.id) return false;
    return matched ? matched.has(e.id) : true;
  });
  const pinnedAn = pinned ? analyses.get(pinned.id) : undefined;

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft size={13} /> 返回
        </Button>
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ArrowLeftRight size={15} className="text-brand" /> 选择要对比的实验
        </div>
      </div>

      {pinned && pinnedAn && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-[11.5px]">
          <Check size={12} className="text-brand2" />
          已选 <b className="num">{pinned.id}</b> {pinned.name}
          <span className="text-dim">（{fmtDiff(pinnedAn.primary.diff, pinnedAn.primary.unit)}）</span>
          <span className="ml-auto text-dim">再选一个就能对比</span>
        </div>
      )}

      <Panel>
        <div className="border-b border-line px-3 py-2">
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索实验名 / ID / 假设 / 指标"
            className="w-full rounded-lg border border-line bg-base px-3 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {list.slice(0, 60).map((e) => {
            const an = analyses.get(e.id);
            return (
              <button
                key={e.id}
                onClick={() => onPick(e.id)}
                className="flex w-full items-center gap-3 border-b border-line/60 px-3 py-2 text-left transition-colors last:border-0 hover:bg-panel2/60"
              >
                <span className="num w-11 shrink-0 text-[10.5px] text-dim">{e.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{e.name}</span>
                <span className="shrink-0 text-[10.5px] text-dim">{an?.primary.label ?? e.primaryMetric}</span>
                {an && (
                  <span className={cx('num w-16 shrink-0 text-right text-[11px]', an.primary.diff > 0 ? 'text-ship' : 'text-noship')}>
                    {fmtDiff(an.primary.diff, an.primary.unit)}
                  </span>
                )}
                {an && (
                  <span className="shrink-0">
                    <DecisionBadge decision={an.decision} size="sm" />
                  </span>
                )}
              </button>
            );
          })}
          {list.length === 0 && <p className="px-3 py-6 text-center text-[11.5px] text-dim">没有匹配的实验</p>}
        </div>
      </Panel>
    </div>
  );
}

/** 供列表页与详情页复用：拼对比链接 */
export function compareHref(a: string, b?: string): string {
  return b ? `#/compare?a=${a}&b=${b}` : `#/compare?a=${a}`;
}
