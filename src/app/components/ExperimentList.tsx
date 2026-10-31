import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Link2, Search } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { Dataset, Experiment } from '../../lib/types.ts';
import {
  ARCHETYPE_LABEL,
  DECISION_META,
  REASON_META,
  fmtNum,
  fmtP,
  fmtPP,
  fmtPct,
  liftClass,
  type Tone,
} from '../lib/format';
import { copyText, readFilters, writeFilters } from '../lib/share';
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
  const color = !sig ? '#64748b' : diff > 0 ? '#34d399' : '#fb7185';
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden>
      <line x1={x(0)} x2={x(0)} y1={1} y2={H - 1} stroke="#3d4b63" strokeWidth={1} strokeDasharray="2 2" />
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
  const [linkCopied, setLinkCopied] = useState(false);

  // 筛选状态写回 URL，方便把当前视图直接发给别人
  useEffect(() => {
    writeFilters({ d: decision ?? undefined, a: archetype === 'all' ? undefined : archetype, q: q.trim() || undefined, s: sort === 'id' ? undefined : sort });
  }, [q, decision, archetype, sort]);

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
      if (sort === 'p') return key(x).overall.p - key(y).overall.p;
      if (sort === 'diff') return Math.abs(key(y).overall.diff) - Math.abs(key(x).overall.diff);
      return x.id.localeCompare(y.id);
    });
  }, [dataset.experiments, analyses, q, decision, archetype, sort]);

  const total = dataset.experiments.length;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-8">
      <div className="anim-up flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">实验列表</h1>
          <p className="mt-1 text-[13px] text-muted">
            {total} 个实验 · 主指标为二值转化 · 结论由确定性引擎计算，非模型生成
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
            <Button variant="ghost" size="sm" onClick={copyViewLink} className="ml-1" title="复制带筛选状态的链接">
              {linkCopied ? <Check size={12} className="text-ship" /> : <Link2 size={12} />}
              {linkCopied ? '已复制' : '复制视图'}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
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
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">{e.primaryMetric}</td>
                    <td className="num px-3 py-2.5 text-right text-xs text-muted">
                      {fmtPct(a.overall.controlRate)}
                      <span className="mx-1 text-dim">→</span>
                      {fmtPct(a.overall.treatmentRate)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <MiniCI ci={a.overall.ci95} diff={a.overall.diff} />
                        <span className={cx('num w-[62px] text-right text-xs font-medium', liftClass(a.overall.diff))}>
                          {fmtPP(a.overall.diff)}
                        </span>
                      </div>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-xs text-muted">{fmtP(a.overall.p)}</td>
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
