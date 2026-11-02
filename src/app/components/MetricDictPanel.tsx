/**
 * 口径字典：可编辑 + 版本历史（P2）。
 *
 * ## 为什么这块要「重」成这样
 *
 * 旗舰平台（Eppo 的语义层、GrowthBook 的 metric SQL）都把「指标定义」当成**受版本控制的一等对象**，
 * 因为口径是结论的前提：改了方向、改了分子分母，历史结论就不再可比。
 * 而多数 demo 的做法是给一张只读的表——那连「口径字典」都算不上，只是文档。
 *
 * 所以这里的取舍是：
 *   - **编辑不即时生效**，必须先「保存为新版本」：即时生效会让「刚才那个结论」无法复现；
 *   - 保存前把**变更摘要**实时算给你看（改了谁的哪个字段、从什么改成什么），
 *     不让用户手写提交信息（十次有九次是空的）；
 *   - 历史版本只读、可回滚，回滚**也是新增一版**，旧版本永不被改写；
 *   - **内置指标的 label 不可改**（实验的 primaryMetric 存的是中文名，改了就对不上号），
 *     方向/单位/计算式/说明可改——方向和单位是真会影响展示与净价值口径的。
 *
 * ## 自定义指标只支持「比值」形态
 *
 * `Σ分子 / Σ分母`。这不是限制能力，是**只承诺能被检验的东西**：
 * 「先按行算再取平均」会引入权重问题（一行代表 100 人还是 1 个人），引擎里没有对应的方差模型，
 * 硬做出来会得到一个看着像结论、其实没有方差依据的数字。
 */

import { useMemo, useState } from 'react';
import { Check, History, Plus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { METRIC_DEFS, directionLabel } from '../../lib/metrics.ts';
import {
  CUSTOM_PREFIX, diffSnapshots, nextCustomKey, resolveDefs,
  type CustomMetric, type MetricSnapshot, type MetricPatch,
} from '../../lib/metricDict.ts';
import { compileMetricExpr, EXPR_FIELDS } from '../../lib/metricExpr.ts';
import type { MetricDictApi } from '../lib/useMetricDict';
import { Button, cx, Panel, PanelHead } from './ui.tsx';

const EMPTY_CUSTOM: Omit<CustomMetric, 'key'> = {
  label: '',
  numerator: 'revenue',
  denominator: 'conversions',
  unit: '元',
  direction: 'higher_better',
  formula: '',
  note: '',
};

export function MetricDictPanel({ dict }: { dict: MetricDictApi }) {
  const [draft, setDraft] = useState<MetricSnapshot>(dict.snapshot);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newMetric, setNewMetric] = useState(EMPTY_CUSTOM);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(dict.snapshot), [draft, dict.snapshot]);
  const preview = useMemo(() => diffSnapshots(dict.snapshot, draft), [dict.snapshot, draft]);
  const defs = useMemo(() => resolveDefs(editing ? draft : dict.snapshot), [editing, draft, dict.snapshot]);

  function patch(key: string, p: MetricPatch) {
    setDraft((d) => ({ ...d, patches: { ...d.patches, [key]: { ...d.patches[key], ...p } } }));
  }

  function save() {
    setErr(null);
    try {
      const r = dict.save(draft);
      setEditing(false);
      setFlash(`已保存为 v${r.version}：${r.summary.length} 项变更`);
      setTimeout(() => setFlash(null), 4000);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function cancel() {
    setDraft(dict.snapshot);
    setEditing(false);
    setErr(null);
  }

  // 新增自定义指标：先做语法校验，再落到 draft（不直接保存）
  const newExprErr = useMemo(() => {
    if (!newMetric.label.trim()) return '缺名称';
    for (const [role, src] of [['分子', newMetric.numerator], ['分母', newMetric.denominator]] as const) {
      try {
        compileMetricExpr(src);
      } catch (e) {
        return `${role}：${(e as Error).message}`;
      }
    }
    return null;
  }, [newMetric]);

  function commitNew() {
    if (newExprErr) return;
    const key = `${CUSTOM_PREFIX}${Date.now().toString(36)}`;
    setDraft((d) => ({ ...d, custom: [...d.custom, { ...newMetric, key }] }));
    setNewMetric(EMPTY_CUSTOM);
    setAdding(false);
    setEditing(true);
  }

  return (
    <Panel className="mt-4">
      <PanelHead
        title="口径字典"
        hint="所有指标的定义集中在这里；引擎与 Agent 只能引用字典里登记过的口径。改动必须存成新版本——即时生效会让「刚才那个结论」无法复现"
        right={
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border border-line bg-panel2/60 px-2 py-0.5 font-mono text-[10px] text-dim">
              v{dict.version}
            </span>
            <span className="font-mono text-[10px] text-dim">
              {dict.snapshot.custom.length ? `${METRIC_DEFS.length}+${dict.snapshot.custom.length}` : METRIC_DEFS.length} 个
            </span>
            <button
              onClick={() => setShowHistory((v) => !v)}
              aria-pressed={showHistory}
              className={cx(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                showHistory ? 'bg-brand/15 text-brand2' : 'text-dim hover:bg-panel2 hover:text-ink',
              )}
              title="版本历史：谁在什么时候改了什么"
            >
              <History size={10} /> 历史
            </button>
          </div>
        }
      />

      {flash && (
        <div className="flex items-center gap-1.5 border-b border-line bg-ship/10 px-4 py-2 text-[11px] text-ship">
          <Check size={11} /> {flash}
        </div>
      )}

      {showHistory && <HistoryList dict={dict} onRollback={() => setDraft(dict.snapshot)} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-[11px]">
          <thead>
            <tr className="border-b border-line text-[10.5px] text-dim">
              <th className="px-4 py-2 font-normal">指标</th>
              <th className="px-3 py-2 font-normal">方向</th>
              <th className="px-3 py-2 font-normal">类型</th>
              <th className="px-3 py-2 font-normal">计算式</th>
              <th className="px-3 py-2 font-normal">单位</th>
              <th className="px-3 py-2 font-normal">说明</th>
              <th className="px-4 py-2 font-normal">护栏容忍度</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50">
            {defs.map((m) => {
              const isCustom = m.key.startsWith(CUSTOM_PREFIX);
              const builtin = METRIC_DEFS.find((b) => b.key === m.key);
              return (
                <tr key={m.key} className="align-top">
                  <td className="px-4 py-2.5">
                    <div className="text-ink">{m.label}</div>
                    <div className="font-mono text-[9.5px] text-dim">{m.key}</div>
                    {isCustom && (
                      <span className="mt-1 inline-block rounded bg-violet-400/10 px-1 py-0.5 text-[9px] text-violet-700 dark:text-violet-300">
                        自定义
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {editing ? (
                      <select
                        value={m.direction}
                        onChange={(e) => patch(m.key, { direction: e.target.value as 'higher_better' | 'lower_better' })}
                        className="rounded border border-line bg-panel px-1 py-0.5 text-[10.5px] text-ink"
                      >
                        <option value="higher_better">越大越好</option>
                        <option value="lower_better">越小越好</option>
                      </select>
                    ) : (
                      <span
                        className={cx(
                          'rounded px-1.5 py-0.5 text-[10px]',
                          m.direction === 'higher_better' ? 'bg-ship/12 text-ship' : 'bg-noship/12 text-noship',
                        )}
                      >
                        {directionLabel(m)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {{ rate: '率', continuous: '连续值', quantile: '分位数' }[m.kind]}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10px] text-muted">
                    {editing && !isCustom ? (
                      <input
                        value={m.formula}
                        onChange={(e) => patch(m.key, { formula: e.target.value })}
                        className="w-52 rounded border border-line bg-panel px-1 py-0.5 text-[10px] text-ink"
                      />
                    ) : (
                      m.formula
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {editing && !isCustom ? (
                      <input
                        value={m.unit}
                        onChange={(e) => patch(m.key, { unit: e.target.value })}
                        className="w-12 rounded border border-line bg-panel px-1 py-0.5 text-[10px] text-ink"
                      />
                    ) : (
                      m.unit
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {editing && !isCustom ? (
                      <input
                        value={m.note ?? ''}
                        onChange={(e) => patch(m.key, { note: e.target.value })}
                        placeholder="（可空）"
                        className="w-56 rounded border border-line bg-panel px-1 py-0.5 text-[10px] text-ink"
                      />
                    ) : (
                      <span className="line-clamp-2">{m.note || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {builtin?.guardrailMargin === null || builtin === undefined ? (
                      <span className="text-dim">{isCustom ? '不作为护栏' : '不作为护栏'}</span>
                    ) : (
                      <span className="num text-muted">
                        {m.unit === 'ms'
                          ? `+${(builtin.guardrailMargin * 100).toFixed(0)}%`
                          : `${(builtin.guardrailMargin * 100).toFixed(2)}pp`}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 自定义指标的行内操作（编辑态才能删） */}
      {editing && draft.custom.length > 0 && (
        <div className="border-t border-line px-4 py-2">
          <div className="mb-1 text-[10px] text-dim">自定义指标（可删）：</div>
          <div className="flex flex-wrap gap-1.5">
            {draft.custom.map((c) => (
              <span
                key={c.key}
                className="inline-flex items-center gap-1 rounded border border-line bg-panel2/60 px-1.5 py-0.5 text-[10.5px] text-ink"
              >
                {c.label} = {c.numerator} / ({c.denominator})
                <button
                  onClick={() => setDraft((d) => ({ ...d, custom: d.custom.filter((x) => x.key !== c.key) }))}
                  className="text-noship hover:opacity-70"
                  title="删除这个自定义指标（保存后生效）"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <div className="border-t border-line bg-panel2/40 px-4 py-3">
          <div className="mb-2 text-[11px] font-medium text-ink">新增自定义指标（比值口径：Σ分子 / Σ分母）</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="名称">
              <input
                value={newMetric.label}
                onChange={(e) => setNewMetric({ ...newMetric, label: e.target.value })}
                placeholder="如：客单价"
                className="w-full rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
              />
            </Field>
            <Field label="分子表达式">
              <input
                value={newMetric.numerator}
                onChange={(e) => setNewMetric({ ...newMetric, numerator: e.target.value })}
                className="w-full rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
              />
            </Field>
            <Field label="分母表达式">
              <input
                value={newMetric.denominator}
                onChange={(e) => setNewMetric({ ...newMetric, denominator: e.target.value })}
                className="w-full rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
              />
            </Field>
            <Field label="单位">
              <input
                value={newMetric.unit}
                onChange={(e) => setNewMetric({ ...newMetric, unit: e.target.value })}
                className="w-full rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
              />
            </Field>
            <Field label="方向">
              <select
                value={newMetric.direction}
                onChange={(e) => setNewMetric({ ...newMetric, direction: e.target.value as 'higher_better' | 'lower_better' })}
                className="w-full rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
              >
                <option value="higher_better">越大越好</option>
                <option value="lower_better">越小越好</option>
              </select>
            </Field>
            <Field label="说明（可空）">
              <input
                value={newMetric.note}
                onChange={(e) => setNewMetric({ ...newMetric, note: e.target.value })}
                className="w-full rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
              />
            </Field>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-dim">
            可用字段：<code className="font-mono">{EXPR_FIELDS.join(' / ')}</code>；只支持 + - * / 和括号。
            除数为 0 的行会被跳过（算不出，不是 0）。
          </p>
          {newExprErr && (
            <p className="mt-1 flex items-center gap-1 text-[10.5px] text-noship">
              <TriangleAlert size={10} /> {newExprErr}
            </p>
          )}
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" onClick={commitNew} disabled={!!newExprErr}>
              加入待保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewMetric(EMPTY_CUSTOM); }}>
              取消
            </Button>
          </div>
        </div>
      )}

      {err && (
        <p className="flex items-center gap-1 border-t border-line px-4 py-2 text-[10.5px] text-noship">
          <TriangleAlert size={10} /> {err}
        </p>
      )}

      {/* 底部：编辑开关 + 变更摘要 */}
      <div className="border-t border-line px-4 py-3">
        {editing ? (
          <>
            <div className="mb-2 text-[10.5px] text-dim">
              将记录为 <b className="text-ink">v{dict.version + 1}</b>：
              {preview.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {preview.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : (
                <span className="ml-1">（还没有改动）</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={save} disabled={!dirty}>
                <Check size={11} /> 保存为新版本
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
                <Plus size={11} /> 新增自定义指标
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel}>
                放弃改动
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                编辑口径
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  try {
                    dict.reset();
                    setDraft({ patches: {}, custom: [] });
                    setFlash('已回到出厂口径（历史仍保留）');
                    setTimeout(() => setFlash(null), 4000);
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
                title="把本机所有口径改动清掉，回到内置定义（这是一次新版本，历史不丢）"
              >
                <RotateCcw size={11} /> 回到出厂口径
              </Button>
            </div>
            <p className="mt-2 text-[10.5px] leading-4 text-dim">
              字典之外就没有口径：Agent 被问到未登记的指标时只能回答「不在口径字典里，引擎没算过」，
              不允许自行定义或换算——这是「Agent 不能自创口径」这条铁律的落点。
              自定义指标会用<b className="text-ink">比值 delta method</b> 计算（与 ARPU 同源），
              与主指标的两比例 z 不是同一套，**两者的 p 不能直接比大小**。
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] text-dim">{label}</span>
      {children}
    </label>
  );
}

function HistoryList({ dict, onRollback }: { dict: MetricDictApi; onRollback: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="border-b border-line bg-panel2/30 px-4 py-2.5">
      <div className="mb-1.5 text-[10.5px] text-dim">版本历史（最新在最上；回滚本身也是一次新版本，旧版本不会被改写）</div>
      <ul className="space-y-1.5">
        {[...dict.doc.versions].reverse().map((v) => {
          const isCurrent = v.version === dict.version;
          return (
            <li key={v.version} className="flex items-start gap-2 text-[10.5px]">
              <span
                className={cx(
                  'mt-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px]',
                  isCurrent ? 'bg-brand/15 text-brand2' : 'bg-panel2 text-dim',
                )}
              >
                v{v.version}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-muted">
                  {v.changedAt.slice(0, 16).replace('T', ' ')} · {v.author}
                  {v.restoredFrom ? ` · 回滚自 v${v.restoredFrom}` : ''}
                </div>
                <ul className="list-disc pl-4 text-dim">
                  {v.summary.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              {!isCurrent && (
                <button
                  onClick={() => {
                    try {
                      const r = dict.rollback(v.version);
                      onRollback();
                      setErr(null);
                      setTimeout(() => setErr(null), 0);
                      void r;
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-brand2 hover:bg-brand/10"
                >
                  回滚到此版本
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {err && <p className="mt-1 text-[10px] text-noship">{err}</p>}
    </div>
  );
}
