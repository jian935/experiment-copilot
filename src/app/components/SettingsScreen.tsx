import { useMemo } from 'react';
import { Check, RotateCcw, ShieldAlert, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { analyze, type Analysis } from '../../lib/decide.ts';
import type { Dataset } from '../../lib/types.ts';
import { DEFAULT_CONFIG, type DecisionConfig } from '../../lib/config.ts';
import { METRIC_DEFS, directionLabel } from '../../lib/metrics.ts';
import {
  PROVIDER_PRESETS, type LlmSettings, type Settings,
} from '../lib/settings.ts';
import { Button, cx, Panel, PanelHead } from './ui.tsx';

/**
 * 设置页（蓝图第 6 屏）。
 *
 * 关键设计：**改完立刻告诉你影响面**——把当前数据集按新口径重算一遍，
 * 对比默认口径下有多少个实验的结论会变。这样"α 从 0.05 调到 0.01 意味着什么"
 * 不是一个抽象概念，而是「120 个实验里有 7 个会从建议上线变成证据不足」。
 */
export function SettingsScreen({
  settings,
  patchConfig,
  patchLlm,
  reset,
  dataset,
  analyses,
  onBack,
}: {
  settings: Settings;
  patchConfig: (p: Partial<DecisionConfig>) => void;
  patchLlm: (p: Partial<LlmSettings>) => void;
  reset: () => void;
  dataset: Dataset | null;
  analyses: Map<string, Analysis> | null;
  onBack: () => void;
}) {
  const cfg = settings.config;
  const isDefault = useMemo(() => JSON.stringify(cfg) === JSON.stringify(DEFAULT_CONFIG), [cfg]);

  const impact = useMemo(
    () => (analyses && dataset ? diffAgainstDefault(dataset, analyses) : null),
    [analyses, dataset],
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-24 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-brand" />
          <h1 className="text-[15px] font-semibold text-ink">设置 · 决策口径与模型</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={reset} disabled={isDefault}>
            <RotateCcw size={12} />
            恢复默认
          </Button>
          <Button size="sm" onClick={onBack}>
            <Check size={12} />
            完成
          </Button>
        </div>
      </div>

      {!isDefault && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-[11px] text-ink">
          <TriangleAlert size={13} className="mt-[1px] shrink-0 text-brand" />
          <span>
            当前口径与默认不同。列表、详情、证据链、Agent 回答与结论卡导出都会按这套口径重算；
            评测看板的真值对比也会随之变化——这是预期行为，不是 bug。
          </span>
        </div>
      )}

      {impact && (
        <Panel className="mt-4">
          <PanelHead
            title="影响面预览"
            hint="按当前口径重算后，与默认口径相比有多少实验的结论会变（在当前数据集上实测）"
            right={
              <span className={cx('num text-[11px]', impact.changed > 0 ? 'text-brand2' : 'text-dim')}>
                {impact.changed} / {impact.total} 条变化
              </span>
            }
          />
          <div className="grid gap-px bg-line sm:grid-cols-4">
            <ImpactCell label="结论变化" value={String(impact.changed)} sub={`共 ${impact.total} 个实验`} />
            <ImpactCell
              label="准确率变化"
              value={`${(impact.accuracy * 100).toFixed(1)}%`}
              sub={`默认 ${(impact.baseAccuracy * 100).toFixed(1)}%`}
              tone={impact.accuracy >= impact.baseAccuracy ? 'good' : 'bad'}
            />
            <ImpactCell label="建议上线" value={String(impact.ship)} sub={`默认 ${impact.baseShip}`} />
            <ImpactCell label="证据不足" value={String(impact.inconclusive)} sub={`默认 ${impact.baseInconclusive}`} />
          </div>
          {impact.changed > 0 && (
            <div className="border-t border-line px-4 py-3">
              <div className="mb-1.5 text-[10.5px] text-muted">结论发生变化的实验（前 8 条）</div>
              <div className="flex flex-wrap gap-1.5">
                {impact.samples.map((s) => (
                  <span
                    key={s.id}
                    className="rounded-md border border-line bg-panel2/60 px-2 py-1 text-[10.5px] text-muted"
                    title={s.name}
                  >
                    <span className="num text-dim">{s.id}</span> {s.from} → {s.to}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Panel>
      )}

      <Panel className="mt-4">
        <PanelHead
          title="口径字典"
          hint="所有指标的定义集中在这里；引擎与 Agent 只能引用字典里登记过的口径"
          right={<span className="font-mono text-[10px] text-dim">{METRIC_DEFS.length} 个已登记</span>}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[11px]">
            <thead>
              <tr className="border-b border-line text-[10.5px] text-dim">
                <th className="px-4 py-2 font-normal">指标</th>
                <th className="px-3 py-2 font-normal">方向</th>
                <th className="px-3 py-2 font-normal">类型</th>
                <th className="px-3 py-2 font-normal">计算式</th>
                <th className="px-3 py-2 font-normal">统计方法</th>
                <th className="px-3 py-2 font-normal">护栏容忍度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {METRIC_DEFS.map((m) => (
                <tr key={m.key} className="align-top">
                  <td className="px-4 py-2.5">
                    <div className="text-ink">{m.label}</div>
                    <div className="font-mono text-[9.5px] text-dim">{m.key}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cx(
                        'rounded px-1.5 py-0.5 text-[10px]',
                        m.direction === 'higher_better' ? 'bg-ship/12 text-ship' : 'bg-noship/12 text-noship',
                      )}
                    >
                      {directionLabel(m)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {{ rate: '率', continuous: '连续值', quantile: '分位数' }[m.kind]}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10px] text-muted">{m.formula}</td>
                  <td className="px-3 py-2.5 text-muted">{m.method}</td>
                  <td className="px-3 py-2.5">
                    {m.guardrailMargin === null ? (
                      <span className="text-dim">不作为护栏</span>
                    ) : (
                      <span className="num text-muted">
                        {m.unit === 'ms'
                          ? `+${(m.guardrailMargin * 100).toFixed(0)}%`
                          : `${(m.guardrailMargin * 100).toFixed(2)}pp`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-4 py-3">
          <p className="text-[10.5px] leading-4 text-dim">
            字典之外就没有口径：Agent 被问到 ARPU、留存这类未登记指标时，只能回答「不在口径字典里，引擎没算过」，
            不允许自行定义或换算——这是「Agent 不能自创口径」这条铁律的落点。
            要新增指标，得先在 <code className="rounded bg-white/10 px-1">DailyRow</code> 加字段、在
            <code className="rounded bg-white/10 px-1">metrics.ts</code> 登记、再接入决策。
          </p>
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHead title="显著性口径" hint="主指标、分层校正、交互判定与 SRM 的阈值" />
          <div className="space-y-3.5 px-4 py-4">
            <NumField
              label="主指标 α"
              value={cfg.alpha}
              step={0.005}
              min={0.001}
              max={0.2}
              onChange={(v) => patchConfig({ alpha: v })}
              hint="双侧；判定「显著」的 p 值门槛。调小 → 更保守、更难上线。"
            />
            <NumField
              label="分层 BH 的 FDR"
              value={cfg.segmentFdr}
              step={0.01}
              min={0.01}
              max={0.5}
              onChange={(v) => patchConfig({ segmentFdr: v })}
              hint="分层扫描的多重比较校正水平（q ≤ 该值判显著）。"
            />
            <NumField
              label="交互判定 α"
              value={cfg.interactionAlpha}
              step={0.005}
              min={0.001}
              max={0.2}
              onChange={(v) => patchConfig({ interactionAlpha: v })}
              hint="新老效应差（ΔΔ）的 p 值门槛，越小越不容易判「效应异质」。"
            />
            <NumField
              label="SRM 卡方 α"
              value={cfg.srmAlpha}
              step={0.0005}
              min={0.0001}
              max={0.05}
              onChange={(v) => patchConfig({ srmAlpha: v })}
              hint="分流异常的 p 值门槛。"
            />
            <NumField
              label="SRM 相对偏差阈值"
              value={cfg.srmMaxRelImb}
              step={0.005}
              min={0.001}
              max={0.2}
              percent
              onChange={(v) => patchConfig({ srmMaxRelImb: v })}
              hint="大样本下 p 值过度敏感，必须配一个实际偏差门槛才不会误报。"
            />
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="重抽样与随机种子"
            hint="Bootstrap 的分位数指标（P95 延迟）专用"
            right={
              <span className={cx('text-[10px]', cfg.bootstrapReps >= 10000 ? 'text-ship' : 'text-dim')}>
                {cfg.bootstrapReps >= 10000 ? '符合蓝图 10k' : '低于蓝图 10k'}
              </span>
            }
          />
          <div className="space-y-3.5 px-4 py-4">
            <NumField
              label="Bootstrap 次数"
              value={cfg.bootstrapReps}
              step={1000}
              min={500}
              max={50000}
              onChange={(v) => patchConfig({ bootstrapReps: Math.round(v) })}
              hint="越大越稳、越慢。蓝图 §8 要求 10000。"
            />
            <NumField
              label="模拟随机种子"
              value={cfg.simSeed}
              step={1}
              min={1}
              max={99999999}
              onChange={(v) => patchConfig({ simSeed: Math.round(v) })}
              hint="固定种子 ⇒ 同一份数据每次算出完全一样的区间。改它会让区间小幅抖动。"
            />
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHead
          title="护栏容忍度（margin）"
          hint="margin = 业务可接受的「最大恶化」。它是业务声明，不是统计默认值——改它前先想清楚代价"
        />
        <div className="divide-y divide-line/60">
          {METRIC_DEFS.filter((m) => m.guardrailMargin !== null).map((m) => {
            const key = m.key === 'refund_rate' ? 'refundRate' : m.key === 'complaint_rate' ? 'complaintRate' : 'latencyP95';
            const g = cfg.guardrails[key];
            const isRel = m.unit === 'ms';
            return (
              <div key={m.key} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-ink">{m.label}</span>
                    {m.key === 'refund_rate' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-noship/12 px-2 py-[1px] text-[10px] text-noship">
                        <ShieldAlert size={9} />
                        硬拦截
                      </span>
                    )}
                    <span className="text-[10px] text-dim">{directionLabel(m)}</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-[10.5px] text-muted">
                    <input
                      type="checkbox"
                      checked={g.gating}
                      onChange={(e) =>
                        patchConfig({ guardrails: { ...cfg.guardrails, [key]: { ...g, gating: e.target.checked } } })
                      }
                      className="h-3 w-3 accent-brand"
                    />
                    参与决策拦截
                  </label>
                </div>

                <div className="mt-2.5 grid gap-3 sm:grid-cols-3">
                  <NumField
                    label={isRel ? '相对容忍度' : 'margin'}
                    value={g.margin}
                    step={isRel ? 0.01 : 0.001}
                    min={0}
                    max={isRel ? 0.5 : 0.1}
                    percent
                    onChange={(v) =>
                      patchConfig({ guardrails: { ...cfg.guardrails, [key]: { ...g, margin: v } } })
                    }
                  />
                  <NumField
                    label="单侧 α"
                    value={g.alpha}
                    step={0.005}
                    min={0.001}
                    max={0.2}
                    onChange={(v) =>
                      patchConfig({ guardrails: { ...cfg.guardrails, [key]: { ...g, alpha: v } } })
                    }
                  />
                  <div>
                    <div className="text-[10.5px] text-dim">判定口径</div>
                    <select
                      value={g.mode}
                      onChange={(e) =>
                        patchConfig({
                          guardrails: {
                            ...cfg.guardrails,
                            [key]: { ...g, mode: e.target.value as typeof g.mode },
                          },
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-line bg-panel2/70 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
                    >
                      <option value="harm_and_practical">统计显著 ∧ 达阈值</option>
                      <option value="confirm_beyond_margin">确认恶化超 margin（最严）</option>
                      <option value="non_inferiority">非劣不成立即拦（最保守）</option>
                    </select>
                  </div>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-dim">{m.note}</p>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel className="mt-4">
        <PanelHead
          title="模型（OpenAI 兼容）"
          hint="引擎不依赖模型；这里只影响「智能模式」的自然语言回答，所有数字仍由本地引擎计算"
        />
        <div className="space-y-3.5 px-4 py-4">
          <div>
            <div className="text-[10.5px] text-dim">Provider</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {PROVIDER_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => patchLlm({ provider: p.key, baseUrl: p.baseUrl, model: p.model })}
                  className={cx(
                    'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                    settings.llm.provider === p.key
                      ? 'border-brand/60 bg-brand/15 text-brand2'
                      : 'border-line bg-panel2/60 text-muted hover:border-line2 hover:text-ink',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-dim">
              {PROVIDER_PRESETS.find((p) => p.key === settings.llm.provider)?.hint}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Base URL"
              value={settings.llm.baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(v) => patchLlm({ baseUrl: v })}
            />
            <TextField
              label="模型"
              value={settings.llm.model}
              placeholder="deepseek-flash"
              onChange={(v) => patchLlm({ model: v })}
            />
          </div>
          <TextField
            label="API Key"
            value={settings.llm.apiKey}
            placeholder="sk-..."
            password
            onChange={(v) => patchLlm({ apiKey: v })}
            hint="只存本机 localStorage，不随结论卡导出、不进任何公开产物。留空则只用规则模式（免密钥）。"
          />
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- 影响面对比 ---------------- */

interface Impact {
  changed: number;
  total: number;
  accuracy: number;
  baseAccuracy: number;
  ship: number;
  baseShip: number;
  inconclusive: number;
  baseInconclusive: number;
  samples: { id: string; name: string; from: string; to: string }[];
}

/**
 * 当前口径 vs 默认口径的差异。
 * 只在设置页算一次（120 个实验再跑一遍默认口径，约几十毫秒），不进主链路。
 * 结果按数据集缓存：拖滑块时不会每帧重算 120 × 2 次分析。
 */
function diffAgainstDefault(dataset: Dataset, analyses: Map<string, Analysis>): Impact {
  const rows = new Map<string, (typeof dataset.daily)[number][]>();
  for (const r of dataset.daily) {
    const l = rows.get(r.expId);
    if (l) l.push(r);
    else rows.set(r.expId, [r]);
  }

  const hasTruth = dataset.groundTruth !== false;
  let changed = 0;
  let correct = 0;
  let baseCorrect = 0;
  let ship = 0;
  let baseShip = 0;
  let inconclusive = 0;
  let baseInconclusive = 0;
  const samples: Impact['samples'] = [];

  for (const e of dataset.experiments) {
    const now = analyses.get(e.id);
    if (!now) continue;
    if (hasTruth && now.decision === e.trueDecision) correct++;
    if (now.decision === 'ship') ship++;
    if (now.decision === 'inconclusive') inconclusive++;

    const base = analyze(e, rows.get(e.id) ?? [], DEFAULT_CONFIG);
    if (hasTruth && base.decision === e.trueDecision) baseCorrect++;
    if (base.decision === 'ship') baseShip++;
    if (base.decision === 'inconclusive') baseInconclusive++;
    if (base.decision !== now.decision) {
      changed++;
      if (samples.length < 8) {
        samples.push({ id: e.id, name: e.name, from: label(base.decision), to: label(now.decision) });
      }
    }
  }

  const n = dataset.experiments.length || 1;
  return {
    changed,
    total: dataset.experiments.length,
    accuracy: correct / n,
    baseAccuracy: baseCorrect / n,
    ship,
    baseShip,
    inconclusive,
    baseInconclusive,
    samples,
  };
}

function label(d: string): string {
  return { ship: '建议上线', 'no-ship': '不建议上线', iterate: '定向上线', inconclusive: '证据不足' }[d] ?? d;
}

/* ---------------- 表单控件 ---------------- */

function NumField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  percent,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  min: number;
  max: number;
  percent?: boolean;
  hint?: string;
}) {
  const shown = percent ? (value * 100).toFixed(3).replace(/\.?0+$/, '') : String(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10.5px] text-dim">{label}</div>
        <div className="num text-[11px] text-muted">
          {shown}
          {percent ? 'pp' : ''}
        </div>
      </div>
      <input
        type="number"
        value={Number.isFinite(value) ? (percent ? Number((value * 100).toFixed(6)) : value) : 0}
        step={percent ? step * 100 : step}
        min={percent ? min * 100 : min}
        max={percent ? max * 100 : max}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (!Number.isFinite(raw)) return;
          onChange(percent ? raw / 100 : raw);
        }}
        className="mt-1 num w-full rounded-lg border border-line bg-panel2/70 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-brand/60"
      />
      <input
        type="range"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-brand"
        aria-label={label}
      />
      {hint && <p className="mt-1 text-[10px] leading-4 text-dim">{hint}</p>}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  password,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[10.5px] text-dim">{label}</div>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 w-full rounded-lg border border-line bg-panel2/70 px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-dim/70 focus:border-brand/60"
      />
      {hint && <p className="mt-1 text-[10px] leading-4 text-dim">{hint}</p>}
    </div>
  );
}

function ImpactCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[10.5px] text-dim">{label}</div>
      <div
        className={cx(
          'num mt-1 text-[17px]',
          tone === 'good' ? 'text-ship' : tone === 'bad' ? 'text-noship' : 'text-ink',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
    </div>
  );
}
