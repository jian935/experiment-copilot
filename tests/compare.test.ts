import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { compareExperiments, observedDays } from '../src/lib/compare.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import type { Archetype } from '../src/lib/types.ts';

/**
 * F3 · 对比视图的可比较性判定。
 *
 * 这一屏唯一一个「会改变画法」的判断是：同单位才共用横轴。
 * 所以测试的重点不是文案，而是：
 * ① 单位不同 **一定** 判成 block（不许有一对漏掉）；
 * ② 其余的差异只 warn，不许升级成 block（否则什么都不能比，视图就废了）；
 * ③ 「没有天数」不等于「天数不同」——数据不足时不能凭空造出一条差异。
 */
const ds = generateDataset(20261031);
const cache = new Map<string, ReturnType<typeof analyze>>();
const an = (id: string) => {
  const hit = cache.get(id);
  if (hit) return hit;
  const a = analyze(ds.experiments.find((e) => e.id === id)!, ds.daily.filter((r) => r.expId === id));
  cache.set(id, a);
  return a;
};
const exp = (id: string) => ds.experiments.find((e) => e.id === id)!;

describe('F3 · 可比性判定', () => {
  it('120 个实验两两组合：单位不同的对无一例外判成 block，且必带 UNIT', () => {
    // 121 次分析只在外面算一遍：放进双重循环会变成 14400 次
    const cache = new Map(ds.experiments.map((e) => [e.id, an(e.id)]));
    let pairs = 0;
    let blocked = 0;
    for (const a of ds.experiments) {
      for (const b of ds.experiments) {
        if (a.id >= b.id) continue;
        pairs++;
        const ca = cache.get(a.id)!;
        const cb = cache.get(b.id)!;
        const r = compareExperiments(a, ca, b, cb);
        // 判定必须与单位是否一致严格等价——这是画法的唯一开关
        expect(r.sharedAxis).toBe(ca.primary.unit === cb.primary.unit);
        if (!r.sharedAxis) {
          blocked++;
          expect(r.incompatible).toBe(true);
          expect(r.issues.some((i) => i.code === 'UNIT' && i.level === 'block')).toBe(true);
        }
      }
    }
    // 数据集里 pp 与元 两类都有，否则这条断言是空转
    expect(pairs).toBe(120 * 119 / 2);
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThan(pairs);
  });

  it('同单位不同指标 → 只 warn，仍可同轴', () => {
    const r = compareExperiments(
      exp('E001'),
      an('E001'),
      exp('E002'),
      an('E002'),
    );
    // 这两个都是二值实验；指标名不同时必须只出 METRIC 级别
    const metric = r.issues.find((i) => i.code === 'METRIC');
    if (metric) {
      expect(metric.level).toBe('warn');
      expect(r.incompatible).toBe(false);
    }
    expect(r.sharedAxis).toBe(true);
  });

  it('pp 与元 混比：拒绝同轴，且理由里说清是量纲不是大小', () => {
    const r = compareExperiments(exp('E001'), an('E001'), exp('E029'), an('E029'));
    const u = r.issues.find((i) => i.code === 'UNIT')!;
    expect(u.level).toBe('block');
    expect(r.sharedAxis).toBe(false);
    expect(r.incompatible).toBe(true);
    expect(u.text).toContain('不能画在同一条轴上');
    // 单位不同时不再重复报 METRIC：量纲已经挡在前面，多一条只会稀释重点
    expect(r.issues.some((i) => i.code === 'METRIC')).toBe(false);
  });

  it('观察期天数相同 → 不出 DAYS；截断一侧后出 DAYS 且仍是 warn', () => {
    const a1 = an('E001');
    const a2 = an('E002');
    const base = compareExperiments(exp('E001'), a1, exp('E002'), a2);
    expect(base.issues.some((i) => i.code === 'DAYS')).toBe(false);

    // 手工截断一侧的序列，模拟「一个只跑了 7 天、一个跑了 3 天」
    const cut = { ...a2, novelty: { ...a2.novelty, points: a2.novelty.points.slice(0, 3) } };
    const r = compareExperiments(exp('E001'), a1, exp('E002'), cut);
    const d = r.issues.find((i) => i.code === 'DAYS')!;
    expect(d.level).toBe('warn');
    expect(d.text).toContain(`${observedDays(a1)} 天`);
    expect(r.incompatible).toBe(false);
  });

  it('数据不足（0 天）不能造出「天数不同」', () => {
    const a1 = an('E001');
    const skipped = { ...a1, novelty: { ...a1.novelty, skipped: '数据不足', points: [] } };
    const r = compareExperiments(exp('E001'), skipped, exp('E002'), an('E002'));
    expect(observedDays(skipped)).toBe(0);
    expect(r.issues.some((i) => i.code === 'DAYS')).toBe(false);
  });

  it('分流比例不同 → 一条 warn，且不改画法', () => {
    const a = { ...exp('E001'), trafficSplit: '50/50' };
    const b = { ...exp('E002'), trafficSplit: '90/10' };
    const r = compareExperiments(a, an('E001'), b, an('E002'));
    expect(r.issues.some((i) => i.code === 'SPLIT' && i.level === 'warn')).toBe(true);
    expect(r.sharedAxis).toBe(true);
    expect(r.incompatible).toBe(false);
  });

  it('不拿注入场景（archetype）当不可比的理由：那是真值标签，不是实验设计', () => {
    const a = { ...exp('E001'), archetype: 'guardrail' as Archetype };
    const b = { ...exp('E002'), archetype: 'heterogeneous' as Archetype };
    const r = compareExperiments(a, an('E001'), b, an('E002'));
    // 任何一条 issue 都不该提到「类型/场景」——这类差异只该出现在卡片上做信息展示
    for (const i of r.issues) {
      expect(i.text).not.toContain('类型');
      expect(i.text).not.toContain('场景');
    }
  });

  it('自己和自己比：零差异，四条全不触发', () => {
    const r = compareExperiments(exp('E001'), an('E001'), exp('E001'), an('E001'));
    expect(r.issues).toEqual([]);
    expect(r.sharedAxis).toBe(true);
    expect(r.incompatible).toBe(false);
  });
});
