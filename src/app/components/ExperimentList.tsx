import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Link2, Search } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { Dataset, Experiment } from '../../lib/types.ts';
import {
  ARCHETYPE_LABEL,
  DECISION_META,
  REASON_META,
  fmtDiff,
  fmtNum,
  fmtP,
  fmtPct,
  fmtLevel,
  liftClass,
  type Tone,
} from '../lib/format';
import { familyReport, type FamilyReport } from '../../lib/multiplicity.ts';
import { copyText, readFilters, writeFilters } from '../lib/share';
import { C } from '../lib/palette';
import { Button, Chip, DecisionBadge, Panel, Stat, cx } from './ui';

type SortKey = 'id' | 'p' | 'diff';

function MiniCI({ ci, diff }: { ci: [number, number]; diff: number }) {
  const W = 76;
  const H = 16;
  const lo = Math.min(0, ci[0]);
  const hi = Math.max(0, ci[1]);
  const span = hi - lo || 0.002;
  const x = (v: number) => 1 + ((v - lo) / span) * (W - 2);
  const sig = ci[0] > 0 || ci[1] < 0;
  const color = !sig ? C.neutral : diff > 0 ? C.ship : C.noship;
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden>
      <line x1={x(0)} x2={x(0)} y1={1} y2={H - 1} stroke={C.line2} strokeWidth={1} strokeDasharray="2 2" />
      <line x1={x(ci[0])} x2={x(ci[1])} y1={H / 2} y2={H / 2} stroke={color} strokeWidth={1.6} opacity={0.8} strokeLinecap="round" />
      <circle cx={x(diff)} cy={H / 2} r={2.4} fill={color} />
    </svg>
  );
}

export function ExperimentList({
  dataset,
  analyses,
  onOpen,
  seedNote,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  onOpen: (id: string) => void;
  seedNote: string;
}) {
  const initial = useMemo(() => readFilters(), []);
  const [q, setQ] = useState(initial.q ?? '');
  const [decision, setDecision] = useState<string | null>(initial.d ?? null);
  const [archetype, setArchetype] = useState<string>(initial.a ?? 'all');
  const [sort, setSort] = useState<SortKey>((initial.s as SortKey) ?? 'id');
  /** 全局校正（Holm）：一起看 N 个实验时，「总有一个显著」是算术不是运气 */
  const [fwer, setFwer] = useState<boolean>(initial.fw === '1');
  const [linkCopied, setLinkCopied] = useState(false);

  // 筛选状态写回 URL，方便把当前视图直接发给别人
  useEffect(() => {
    writeFilters({
      d: decision ?? undefined,
      a: archetype === 'all' ? undefined : archetype,
      q: q.trim() || undefined,
      s: sort === 'id' ? undefined : sort,
      fw: fwer ? '1' : undefined,
    });
  }, [q, decision, archetype, sort, fwer]);

  async function copyViewLink() {
    const ok = await copyText(window.location.href);
    if (ok) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1800);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { ship: 0, 'no-ship': 0, iterate: 0, inconclusive: 0 };
    for (const a of analyses.values()) c[a.decision] = (c[a.decision] ?? 0) + 1;
    return c;
  }, [analyses]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = dataset.experiments.filter((e) => {
      const a = analyses.get(e.id);
      if (!a) return false;
      if (decision && a.decision !== decision) return false;
      if (archetype !== 'all' && e.archetype !== archetype) return false;
      if (!kw) return true;
      return (
        e.id.toLowerCase().includes(kw) ||
        e.name.toLowerCase().includes(kw) ||
        e.hypothesis.toLowerCase().includes(kw) ||
        e.primaryMetric.toLowerCase().includes(kw)
      );
    });
    const key = (e: Experiment) => analyses.get(e.id)!;
    return list.sort((x, y) => {
      if (sort === 'p') return key(x).primary.p - key(y).primary.p;
      // 按相对效应排序：pp 与 元 混在一起时，绝对值不可比，用相对提升才有意义
      if (sort === 'diff') return Math.abs(key(y).primary.relativeLift) - Math.abs(key(x).primary.relativeLift);
      return x.id.localeCompare(y.id);
    });
  }, [dataset.experiments, analyses, q, decision, archetype, sort]);

  // 家族 = **全部**实验，不是当前筛选后的子集：
  // 校正说的是「你扫了这一批、挑出显著的那些」这件事，中途筛掉一半不能免除这件事。
  const family: FamilyReport = useMemo(
    () =>
      familyReport(
        dataset.experiments.map((e) => {
          const a = analyses.get(e.id);
          return {
            id: e.id,
            name: e.name,
            p: a ? a.primary.p : 1,
            decision: a?.decision ?? 'inconclusive',
            archetype: e.archetype,
            trueEffect: e.trueLiftOverall,
            trueDecision: e.trueDecision,
          };
        }),
      ),
    [dataset.experiments, analyses],
  );
  const familyRow = useMemo(() => {
    const m = new Map(family.rows.map((r) => [r.id, r]));
    return (id: string) => m.get(id);
  }, [family]);

  const total = dataset.experiments.length;
  const continuousCount = useMemo(
    () => dataset.experiments.filter((e) => e.metricType === 'continuous').length,
    [dataset.experiments],
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-8">
      <div className="anim-up flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">实验列表</h1>
          <p className="mt-1 text-[13px] text-muted">
            {total} 个实验 · 主指标 {total ? continuousCount : 0} 个为 ARPU（连续）· 结论由确定性引擎计算，非模型生成
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-dim">
          <span className="rounded-md border border-line bg-panel2/70 px-2 py-1 font-mono">{seedNote}</span>
          <span className="rounded-md border border-line bg-panel2/70 px-2 py-1">合成数据</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="全部实验"
          value={total}
          sub="点击重置筛选"
          onClick={() => {
            setDecision(null);
            setArchetype('all');
            setQ('');
          }}
          active={!decision && archetype === 'all'}
        />
        {(Object.keys(DECISION_META) as string[]).map((d) => (
          <Stat
            key={d}
            label={DECISION_META[d].label}
            value={counts[d] ?? 0}
            sub={DECISION_META[d].desc}
            tone={DECISION_META[d].tone as Tone}
            active={decision === d}
            onClick={() => setDecision(decision === d ? null : d)}
          />
        ))}
      </div>

      <Panel className="mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索实验名 / ID / 假设"
              className="w-[248px] rounded-lg border border-line bg-panel2/70 py-1.5 pl-8 pr-2.5 text-xs text-ink outline-none placeholder:text-dim focus:border-brand/60"
            />
          </div>

          <select
            value={archetype}
            onChange={(e) => setArchetype(e.target.value)}
            className="rounded-lg border border-line bg-panel2/70 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/60"
          >
            <option value="all">全部类型</option>
            {Object.entries(ARCHETYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-dim">排序</span>
            {(
              [
                ['id', '编号'],
                ['diff', '效应大小'],
                ['p', 'p 值'],
              ] as [SortKey, string][]
            ).map(([k, label]) => (
              <Chip key={k} active={sort === k} onClick={() => setSort(k)}>
                {label}
              </Chip>
            ))}
            <Chip active={fwer} onClick={() => setFwer(!fwer)} title="把全部实验当一个家族做 Holm 校正（控 FWER）">
              全局校正
            </Chip>
            <Button variant="ghost" size="sm" onClick={copyViewLink} className="ml-1" title="复制带筛选状态的链接">
              {linkCopied ? <Check size={12} className="text-ship" /> : <Link2 size={12} />}
              {linkCopied ? '已复制' : '复制视图'}
            </Button>
          </div>
        </div>

        {fwer && (
          <div className="border-b border-line bg-brand/[0.04] px-4 py-2.5 text-[11.5px] leading-5 text-muted">
            把 <b className="text-ink">{family.n}</b> 个实验当成一个家族一起看：naive 口径有{' '}
            <b className="text-ink">{family.naiveSig}</b> 个显著，<b className="text-ink">Holm 校正后 {family.holmSig} 个</b>
            （Bonferroni 也是 {family.bonferroniSig} 个，BH q={family.fdr} 是 {family.bhSig} 个）。
            收回 <b className="text-ink">{family.rescinded}</b> 条
            {family.rescindedFalse !== null && <>，其中 {family.rescindedFalse} 条注入效应为 0（本就该收回）</>}。
            全零假设下「至少一个显著」的概率是{' '}
            <b className="text-ink">{(family.naiveAnySig * 100).toFixed(1)}%</b>
            （1−0.95^{family.n}）——「总有一个能上线」不是运气。校正只标在清单上，<b className="text-ink">不改单个实验的结论</b>。
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-medium text-dim">
                <th className="px-4 py-2.5">实验</th>
                <th className="px-3 py-2.5">结论</th>
                <th className="px-3 py-2.5">主指标</th>
                <th className="px-3 py-2.5 text-right">control → treatment</th>
                <th className="px-3 py-2.5 text-right">差值（95% CI）</th>
                <th className="px-3 py-2.5 text-right">p</th>
                <th className="px-4 py-2.5 text-right">样本</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const a = analyses.get(e.id)!;
                return (
                  <tr
                    key={e.id}
                    onClick={() => onOpen(e.id)}
                    className="group cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel2/60"
                  >
                    <td className="max-w-[280px] px-4 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[11px] text-dim">{e.id}</span>
                        <span className="truncate text-[13px] font-medium text-ink">{e.name}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dim">{e.hypothesis}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <DecisionBadge decision={a.decision} size="sm" />
                      <div className="mt-1 text-[10px] text-dim">{REASON_META[a.reasonCode]}</div>
                      {fwer && familyRow(e.id)?.rescinded && (
                        <div className="mt-1 inline-flex rounded border border-iterate/30 bg-iterate/5 px-1.5 py-0.5 text-[9.5px] text-iterate">
                          Holm 后不显著
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {a.primary.label}
                      <span className="ml-1 text-[10px] text-dim">{a.primary.unit === '元' ? '连续' : '二值'}</span>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-xs text-muted">
                      {fmtLevel(a.primary.controlValue, a.primary.unit)}
                      <span className="mx-1 text-dim">→</span>
                      {fmtLevel(a.primary.treatmentValue, a.primary.unit)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <MiniCI ci={a.primary.ci95} diff={a.primary.diff} />
                        <span className={cx('num w-[70px] text-right text-xs font-medium', liftClass(a.primary.diff))}>
                          {fmtDiff(a.primary.diff, a.primary.unit)}
                        </span>
                      </div>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-xs text-muted">
                      {fmtP(a.primary.p)}
                      {fwer && (
                        <div className={cx('text-[10px]', familyRow(e.id)?.holmSig ? 'text-ship' : 'text-dim')}>
                          Holm {fmtP(familyRow(e.id)?.pHolm ?? 1)}
                        </div>
                      )}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-xs text-muted">
                      {fmtNum(a.overall.n1 + a.overall.n2)}
                    </td>
                    <td className="pr-3">
                      <ArrowRight
                        size={14}
                        className="text-dim opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-xs text-dim">
                    没有符合条件的实验。
                    <button
                      className="ml-2 text-brand2 underline-offset-2 hover:underline"
                      onClick={() => {
                        setQ('');
                        setDecision(null);
                        setArchetype('all');
                      }}
                    >
                      清空筛选
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 text-[11px] leading-5 text-dim">
        差值 = treatment 转化率 − control 转化率（绝对值，pp）。CI 为 Newcombe 混合法 95% 区间；
        灰点表示 CI 跨 0（不显著）。点任意行进入详情，可查看证据链并一键复算。
      </p>
    </div>
  );
}
