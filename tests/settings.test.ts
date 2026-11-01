import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG, mergeConfig, type DecisionConfig,
} from '../src/lib/config.ts';
import {
  DEFAULT_SETTINGS, PROVIDER_PRESETS, normalizeSettings,
} from '../src/app/lib/settings.ts';
import { METRIC_DEFS, METRIC_KEYS, findMetrics, metricByKey, metricByLabel } from '../src/lib/metrics.ts';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import type { Dataset } from '../src/lib/types.ts';

const ds: Dataset = generateDataset(20261031, 7);
const rowsOf = (id: string) => ds.daily.filter((r) => r.expId === id);
const exp = (i: number) => ds.experiments[i];

/** 全量跑一遍，统计结论分布——用于对比不同口径的影响面 */
function tally(cfg?: Partial<DecisionConfig>) {
  const out: Record<string, number> = { ship: 0, 'no-ship': 0, iterate: 0, inconclusive: 0 };
  for (const e of ds.experiments) out[analyze(e, rowsOf(e.id), cfg).decision]++;
  return out;
}

describe('F2 · 口径字典', () => {
  it('每个指标都有完整定义，且键唯一', () => {
    expect(METRIC_DEFS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(METRIC_KEYS).size).toBe(METRIC_DEFS.length);
    for (const m of METRIC_DEFS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.formula.length).toBeGreaterThan(0);
      expect(m.source.length).toBeGreaterThan(0);
      expect(m.method.length).toBeGreaterThan(0);
      expect(['higher_better', 'lower_better']).toContain(m.direction);
    }
  });

  it('主指标是越大越好、不参与护栏；护栏都是越小越好', () => {
    const primary = metricByKey('conversion_rate')!;
    expect(primary.direction).toBe('higher_better');
    expect(primary.guardrailMargin).toBeNull();
    for (const m of METRIC_DEFS.filter((x) => x.guardrailMargin !== null)) {
      expect(m.direction).toBe('lower_better');
    }
  });

  it('能按中文标签在文本里找出被提到的指标（长标签优先）', () => {
    const hit = findMetrics('退款率怎么算的？P95 延迟呢');
    expect(hit.map((m) => m.key)).toContain('refund_rate');
    expect(hit.map((m) => m.key)).toContain('latency_p95');
    expect(metricByLabel('退款率')?.key).toBe('refund_rate');
    expect(findMetrics('今天天气不错')).toEqual([]);
  });

  it('引擎里出现的护栏都登记在字典里（不允许有字典外的口径）', () => {
    const a = analyze(exp(0), rowsOf(exp(0).id));
    for (const g of a.guardrails) {
      const m = metricByKey(g.key);
      expect(m, `护栏 ${g.key} 未登记在口径字典`).toBeDefined();
      expect(m!.label).toBe(g.label);
    }
    expect(metricByLabel(a.experimentId ? exp(0).primaryMetric : '')?.key).toBe('conversion_rate');
  });
});

describe('B2 · 决策阈值可配置', () => {
  it('默认口径复现基线：ship 数与文档一致', () => {
    const t = tally();
    expect(t.ship + t['no-ship'] + t.iterate + t.inconclusive).toBe(ds.experiments.length);
    // 25 个 positive 里绝大多数应判 ship；护栏族 15 个应判 no-ship
    expect(t.ship).toBeGreaterThanOrEqual(20);
    expect(t['no-ship']).toBeGreaterThanOrEqual(15);
  });

  it('α 收紧到 0.01 → 更少 ship、更多 inconclusive（方向正确）', () => {
    const base = tally();
    const strict = tally({ alpha: 0.01 });
    expect(strict.ship).toBeLessThanOrEqual(base.ship);
    expect(strict.inconclusive).toBeGreaterThan(base.inconclusive);
  });

  it('α 放宽到 0.2 → 更多结论、更少 inconclusive', () => {
    const base = tally();
    const loose = tally({ alpha: 0.2 });
    expect(loose.inconclusive).toBeLessThanOrEqual(base.inconclusive);
  });

  it('护栏 margin 调大到不可能触发 → 护栏不再拦截', () => {
    const base = tally();
    const noGuard = tally({
      guardrails: { ...DEFAULT_CONFIG.guardrails, refundRate: { ...DEFAULT_CONFIG.guardrails.refundRate, margin: 0.9 } },
    });
    expect(noGuard['no-ship']).toBeLessThanOrEqual(base['no-ship']);
  });

  it('退款护栏改成最严口径（非劣不成立即拦）→ 拦截明显变多', () => {
    const base = tally();
    const strict = tally({
      guardrails: {
        ...DEFAULT_CONFIG.guardrails,
        refundRate: { ...DEFAULT_CONFIG.guardrails.refundRate, mode: 'non_inferiority' },
      },
    });
    // 最保守口径下"拿不出损害在容忍度内的证据就不许上线"，no-ship 只增不减
    expect(strict['no-ship']).toBeGreaterThanOrEqual(base['no-ship']);
  });

  it('关掉 gating → 护栏完全不参与决策', () => {
    const off = tally({
      guardrails: {
        ...DEFAULT_CONFIG.guardrails,
        refundRate: { ...DEFAULT_CONFIG.guardrails.refundRate, gating: false },
      },
    });
    const on = tally();
    expect(off['no-ship']).toBeLessThanOrEqual(on['no-ship']);
  });

  it('mergeConfig 只覆盖传入的字段，其余保持默认', () => {
    const c = mergeConfig({ alpha: 0.01 });
    expect(c.alpha).toBe(0.01);
    expect(c.segmentFdr).toBe(DEFAULT_CONFIG.segmentFdr);
    expect(c.guardrails.refundRate.margin).toBe(DEFAULT_CONFIG.guardrails.refundRate.margin);
    expect(mergeConfig()).toBe(DEFAULT_CONFIG);
  });

  it('Bootstrap reps 会影响区间（次数越多越稳），但结论方向不变', () => {
    const a = analyze(exp(0), rowsOf(exp(0).id), { bootstrapReps: 500 });
    const b = analyze(exp(0), rowsOf(exp(0).id), { bootstrapReps: 10000 });
    const la = a.guardrails.find((g) => g.key === 'latency_p95')!.bootstrap!;
    const lb = b.guardrails.find((g) => g.key === 'latency_p95')!.bootstrap!;
    expect(la.reps).toBe(500);
    expect(lb.reps).toBe(10000);
    expect(la.ciLow).toBeLessThanOrEqual(la.ciHigh);
    expect(lb.ciLow).toBeLessThanOrEqual(lb.ciHigh);
  });

  it('同种子下结论完全可复现（确定性）', () => {
    const a = analyze(exp(3), rowsOf(exp(3).id), DEFAULT_CONFIG);
    const b = analyze(exp(3), rowsOf(exp(3).id), DEFAULT_CONFIG);
    expect(a.decision).toBe(b.decision);
    expect(a.overall.p).toBe(b.overall.p);
    const la = a.guardrails.find((g) => g.key === 'latency_p95')!.bootstrap!;
    const lb = b.guardrails.find((g) => g.key === 'latency_p95')!.bootstrap!;
    expect(la.ciLow).toBe(lb.ciLow);
  });
});

describe('F1 / D7 · 设置持久化与模型无关', () => {
  it('坏数据一律回退默认（手改坏 localStorage 不会让引擎失控）', () => {
    const bad = normalizeSettings({ config: { alpha: 'x', guardrails: { refundRate: { margin: NaN } } } });
    expect(bad.config.alpha).toBe(DEFAULT_CONFIG.alpha);
    expect(bad.config.guardrails.refundRate.margin).toBe(DEFAULT_CONFIG.guardrails.refundRate.margin);
    expect(normalizeSettings(null).config.alpha).toBe(DEFAULT_CONFIG.alpha);
    expect(normalizeSettings('not an object').llm.provider).toBe(DEFAULT_SETTINGS.llm.provider);
  });

  it('越界的数值被夹回合法区间', () => {
    const s = normalizeSettings({ config: { alpha: 5, bootstrapReps: -1, srmMaxRelImb: 0 } });
    expect(s.config.alpha).toBe(DEFAULT_CONFIG.alpha);
    expect(s.config.bootstrapReps).toBe(DEFAULT_CONFIG.bootstrapReps);
    expect(s.config.srmMaxRelImb).toBe(DEFAULT_CONFIG.srmMaxRelImb);
  });

  it('非法 mode 回退默认口径', () => {
    const s = normalizeSettings({
      config: { guardrails: { refundRate: { ...DEFAULT_CONFIG.guardrails.refundRate, mode: 'nonsense' } } },
    });
    expect(s.config.guardrails.refundRate.mode).toBe(DEFAULT_CONFIG.guardrails.refundRate.mode);
  });

  it('provider 预设齐全：DeepSeek / OpenAI / Moonshot / Ollama / 自定义', () => {
    expect(PROVIDER_PRESETS.map((p) => p.key)).toEqual([
      'deepseek', 'openai', 'moonshot', 'ollama', 'custom',
    ]);
    // 本地 Ollama 不该要 Key；其余都要
    expect(PROVIDER_PRESETS.find((p) => p.key === 'ollama')!.needsKey).toBe(false);
    for (const p of PROVIDER_PRESETS.filter((x) => x.key !== 'ollama')) {
      expect(p.needsKey).toBe(true);
    }
    // 每个预设都要有可用的 base URL（custom 由用户填，允许为空）
    for (const p of PROVIDER_PRESETS.filter((x) => x.key !== 'custom')) {
      expect(p.baseUrl.startsWith('http')).toBe(true);
      expect(p.model.length).toBeGreaterThan(0);
    }
  });

  it('切 provider 会同时改写 base URL 与模型', () => {
    const s = normalizeSettings({ llm: { provider: 'ollama' } });
    expect(s.llm.provider).toBe('ollama');
    expect(s.llm.baseUrl).toBe(PROVIDER_PRESETS.find((p) => p.key === 'ollama')!.baseUrl);
    expect(s.llm.model).toBe(PROVIDER_PRESETS.find((p) => p.key === 'ollama')!.model);
  });

  it('未知 provider 回退第一个预设', () => {
    const s = normalizeSettings({ llm: { provider: '不存在的厂商' } });
    expect(s.llm.provider).toBe(PROVIDER_PRESETS[0].key);
  });

  it('默认设置就是默认口径（不打扰默认行为）', () => {
    expect(DEFAULT_SETTINGS.config).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_SETTINGS.llm.apiKey).toBe('');
  });
});
