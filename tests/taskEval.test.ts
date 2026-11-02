/**
 * 任务级评测的单测。
 *
 * 这里必须用**真实的 120 个实验**（而不是手工构造的几行），因为这一层要验的是
 * 「任务在一个有 6 种注入类型的堆里办不办得成」——用手工数据测出来的通过率
 * 不说明任何事。
 *
 * 同时要钉住几条**口径**，它们是这一层最容易被后来者改坏的地方：
 *  1. 相容率的分母是实验数，不是任务数（否则它就成了完成率）；
 *  2. 「零效应实验上出现方向」不算巡检的错——那是引擎的假阳性；
 *  3. 设计不足的实验不能被建议「补样本」。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { evaluateTasks, TASK_CASES } from '../src/lib/tasks/eval.ts';
import { runInspection } from '../src/lib/tasks/inspection.ts';
import type { Dataset } from '../src/lib/types.ts';

const ds = JSON.parse(readFileSync('public/data/dataset.json', 'utf8')) as Dataset;
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const ev = evaluateTasks(ds, analyses);

describe('任务级评测：办得成', () => {
  it('15 个任务在有 6 类注入实验的数据上全部通过', () => {
    const failed = ev.cases.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.id}: ${c.failures.join('; ')}`)).toEqual([]);
    expect(ev.cases).toHaveLength(15);
  });

  it('任务清单 id 唯一，且每条都写了用户会怎么问', () => {
    const ids = TASK_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of TASK_CASES) {
      expect(c.ask.length).toBeGreaterThan(3);
      // 问题必须是「人话」，不能是函数名
      expect(c.ask).not.toMatch(/^[a-z_]+$/);
    }
    // 五类都要有，否则「评估了什么」会说不清
    const groups = new Set(TASK_CASES.map((c) => c.group));
    expect([...groups].sort()).toEqual(['保真', '拒答', '编排', '真值', '解释'].sort());
  });
});

describe('任务级评测：口径', () => {
  it('相容率的分母是实验数，不是任务数', () => {
    // 100% 这个数字本身不重要，重要的是它的分母：120 个实验逐个比对出来的。
    // 如果哪天有人把它写成「通过的任务数 / 总任务数」，分母会变成 15，
    // 那时这条断言仍会过——所以下面同时钉住「相容条数 == 实验数」这个等式。
    const aligned = Math.round(ev.metrics.alignment * ev.scale.experiments);
    expect(ev.scale.experiments).toBe(120);
    expect(aligned).toBe(ev.scale.experiments);
    expect(ev.metrics.alignment).toBeLessThanOrEqual(1);
  });

  it('引擎判无结论时，巡检给方向的次数必须是 0', () => {
    expect(ev.metrics.inventedDirections).toBe(0);
  });

  it('引擎在零效应实验上的假阳性被单独报出，且不混进巡检的指标', () => {
    // 40 个注入零效应的实验里有 4 个被引擎判成了有方向 —— 这是引擎的错。
    // 如果把它算进「巡检拒答失败」，两个系统的错就分不开了。
    expect(ev.metrics.engineFalsePositive).toBeGreaterThan(0);
    expect(ev.metrics.engineFalsePositive).toBeLessThan(0.25);
    expect(ev.metrics.inventedDirections).toBe(0);
  });

  it('设计不足的实验一律不建议补样本（补 16 倍样本不是建议）', () => {
    const r = runInspection(ds, analyses);
    const bad = r.items
      .filter((x) => x.signals.some((s) => s.code === 'design_insufficient'))
      .filter((x) => x.next.kind === 'collect-more');
    expect(bad.map((x) => x.expId)).toEqual([]);
  });

  it('同一份数据跑两次，指标逐位相同（能进 CI 的前提）', () => {
    const again = evaluateTasks(ds, analyses);
    expect(JSON.stringify(again.metrics)).toBe(JSON.stringify(ev.metrics));
    expect(again.cases.map((c) => c.passed)).toEqual(ev.cases.map((c) => c.passed));
  });

  it('没有数据行时不崩，且不会把「没有数据」说成「没有效果」', () => {
    const empty: Dataset = { ...ds, daily: [] };
    const a2 = new Map(ds.experiments.map((e) => [e.id, analyze(e, [])]));
    const r = runInspection(empty, a2);
    expect(r.totals.withData).toBe(0);
    expect(r.items.every((x) => x.signals.some((s) => s.code === 'no_data'))).toBe(true);
    expect(r.items.some((x) => x.next.kind === 'ship')).toBe(false);
  });
});
