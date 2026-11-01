import { describe, expect, it } from 'vitest';
import { noveltyReport, planExposureSplit, segmentStats, type DayEffect } from '../src/lib/novelty.ts';
import { analyze, dailySegments } from '../src/lib/decide.ts';
import { generateAA, generateDataset } from '../src/lib/simulate.ts';
import { mulberry32, studentTInv } from '../src/lib/stats.ts';

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 造 n 天、每天等量的分段估计；diff 由外部给（用来注入衰减） */
function series(diffs: number[], se = 0.004): DayEffect[] {
  return diffs.map((diff, i) => ({
    day: i + 1,
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    nPerArm: 4000,
    diff,
    se,
  }));
}

describe('新颖效应：切分与判定（A7）', () => {
  it('按曝光量切，不按日历天数切：流量前重后轻时两段仍然平衡', () => {
    // 前 3 天每天 4000、后 4 天每天 1000。按日历等分是 3 天 vs 4 天 → 12000 vs 4000，
    // 两段根本不可比（前半段的 SE 只有后半段的一半，δ 会被前半段单方面主导）。
    // 按曝光量切应该落在第 2 天，得到 8000 vs 8000。
    const pts: DayEffect[] = series(new Array(7).fill(0.01)).map((p, i) => ({
      ...p,
      nPerArm: i < 3 ? 4000 : 1000,
    }));
    const s = planExposureSplit(pts)!;
    expect(s.earlyDays.length + s.lateDays.length).toBe(7);
    expect(s.cutDay).toBe(2);
    const nOf = (days: number[]) => pts.filter((p) => days.includes(p.day)).reduce((a, b) => a + b.nPerArm, 0);
    expect(nOf(s.earlyDays)).toBe(8000);
    expect(nOf(s.lateDays)).toBe(8000);
    expect(nOf(s.earlyDays) + nOf(s.lateDays)).toBe(s.totalN);
  });

  it('半段估计：精度加权点估计 + 日级聚类 SE（不是「半段重估的 SE」）', () => {
    // 两天样本量差 4 倍 → 精度加权后点估计贴近样本多那天，简单平均会被小样本拖走
    const pts: DayEffect[] = [
      { day: 1, date: '2026-11-01', nPerArm: 8000, diff: 0.02, se: 0.002 },
      { day: 2, date: '2026-11-02', nPerArm: 2000, diff: -0.02, se: 0.004 },
    ];
    const h = segmentStats(pts, [1, 2])!;
    expect(h.days).toBe(2);
    // 权重 1/0.002² : 1/0.004² = 250000 : 62500 → 点估计 = (0.02·250000 − 0.02·62500)/312500 = 0.012
    expect(h.diff).toBeCloseTo(0.012, 10);
    // 日效应样本方差（无偏）：两点均值 0，方差 = (0.02² + 0.02²)/1 = 0.0008
    expect(h.dayVar).toBeCloseTo(0.0008, 12);
    // 聚类 SE = √(0.0008 / 2) ≈ 0.02 —— 比任何一天的 SE 都大得多，
    // 这正是「日间差异远大于单日精度」时该有的反应
    expect(h.se).toBeCloseTo(Math.sqrt(0.0004), 12);
    expect(h.se).toBeGreaterThan(0.004);
  });

  it('拒答：不足 3 天、或有一半不足 2 天', () => {
    expect(noveltyReport({ points: series([0.01]) }).skipped).toBeTruthy();
    expect(noveltyReport({ points: series([0.01, 0.01]) }).skipped).toBeTruthy();
    // 第 1 天占 90% 曝光 → 前半段只有 1 天，估不出日间方差
    const lopsided = series(new Array(4).fill(0.01)).map((p, i) => ({ ...p, nPerArm: i === 0 ? 9000 : 300 }));
    const r = noveltyReport({ points: lopsided });
    expect(r.skipped).toBeTruthy();
    expect(r.pattern).toBe('insufficient');
  });

  it('前半段有效、后半段归零 → 判为衰减，方向与幅度一致', () => {
    // 7 天等量时，累计曝光首次过半在第 4 天，切点归前半段 → 4 天 vs 3 天
    const pts = series([0.02, 0.02, 0.02, 0.02, 0, 0, 0], 0.004);
    const split = planExposureSplit(pts)!;
    expect(split.cutDay).toBe(4);
    const r = noveltyReport({ points: pts });
    expect(r.early.diff).toBeCloseTo(0.02, 10);
    expect(r.late.diff).toBeCloseTo(0, 10);
    expect(r.pattern).toBe('decay');
    expect(r.delta).toBeCloseTo(-0.02, 10);
    expect(r.relativeDelta).toBeCloseTo(-1, 10);
    expect(r.p).toBeLessThan(0.01);
    // 逐日斜率也应为负
    expect(r.slope!).toBeLessThan(0);
    expect(r.slopeP!).toBeLessThan(0.01);
  });

  it('后段比前段更强 → growth（不能只说"异质"，方向要分）', () => {
    const pts = series([0, 0, 0, 0, 0.02, 0.02, 0.02], 0.004);
    const r = noveltyReport({ points: pts });
    expect(r.pattern).toBe('growth');
    expect(r.delta).toBeCloseTo(r.late.diff - r.early.diff, 12);
    expect(r.delta).toBeGreaterThan(0);
  });

  it('df 用 Welch–Satterthwaite，临界值明显宽于 1.96（7 天时约 2.7）', () => {
    const pts = series([0.02, 0.02, 0.02, 0.02, 0.01, 0.01, 0.01], 0.004);
    const r = noveltyReport({ points: pts });
    // 4 天 vs 3 天、方差相同 → ν = (1/4+1/3)² / ((1/4)²/3 + (1/3)²/2) ≈ 4.5
    expect(r.df).toBeGreaterThan(3.5);
    expect(r.df).toBeLessThan(5.5);
    expect(studentTInv(0.975, r.df)).toBeGreaterThan(2.4);
    // 同一个 t 值，按正态判会显著、按 t 判不显著：这正是之前误报 12% 的来源
    const t = r.t;
    const pNormal = 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));
    expect(pNormal).toBeLessThan(r.p);
  });

  it('detectableDelta 给出"这个样本量能看出多大的衰减"，且随日间抖动变大', () => {
    const quiet = series([0.01, 0.012, 0.008, 0.011, 0.009, 0.01, 0.011], 0.004);
    const noisy = series([0.03, -0.01, 0.025, -0.005, 0.02, 0, 0.03], 0.004);
    const a = noveltyReport({ points: quiet });
    const b = noveltyReport({ points: noisy });
    expect(a.detectableDelta).toBeGreaterThan(0);
    expect(Number.isFinite(a.detectableDelta)).toBe(true);
    expect(b.detectableDelta).toBeGreaterThan(a.detectableDelta * 2);
    // 判 stable 的实验也要给出这个数：检不出 ≠ 没有
    expect(a.pattern).toBe('stable');
  });

  it('平坦序列不判衰减（误报率受控在名义 α 附近）', () => {
    const rng = mulberry32(424242);
    const N = 2000;
    let flagged = 0;
    const pts = series(new Array(7).fill(0), 0.0049);
    for (let t = 0; t < N; t++) {
      const noisy = pts.map((p) => ({ ...p, diff: 0.005 + 0.0049 * randn(rng) }));
      if (noveltyReport({ points: noisy }).pattern !== 'stable') flagged++;
    }
    const rate = flagged / N;
    // 名义 5%：t 参考下应略低于 5%（ν≈4.5 的 t 比正态宽）
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.065);
  });

  it('注入衰减的检出率（功效）足够，且注入越强越容易检出', () => {
    const rng = mulberry32(9876);
    const N = 800;
    const pts = series(new Array(7).fill(0), 0.0049);
    const power = (d: number) => {
      let hit = 0;
      for (let t = 0; t < N; t++) {
        const noisy = pts.map((p, i) => ({ ...p, diff: d * (i < 4 ? 1 : 0) + 0.0049 * randn(rng) }));
        if (noveltyReport({ points: noisy }).pattern === 'decay') hit++;
      }
      return hit / N;
    };
    const weak = power(0.008);
    const strong = power(0.02);
    expect(strong).toBeGreaterThan(0.85);
    expect(strong).toBeGreaterThan(weak);
  });

  it('斜率对过离散做修正：锯齿被当成"每天衰减一点"时会虚报显著', () => {
    // 造一条「真有线性趋势（每天 +0.4pp）但被 ±2pp 锯齿污染」的序列：
    // 锯齿与天序号正交，所以斜率点估计正好是 0.004；但因为噪声远大于单日 SE，
    // 不做 φ 修正时 t ≈ 5，会报成"每天显著上升"。
    const se = 0.004;
    const zig = [-0.01, 0.034, -0.002, 0.042, 0.006, 0.05, 0.014];
    const pts = series(zig, se);
    const r = noveltyReport({ points: pts });

    const n = zig.length;
    const xbar = (n + 1) / 2;
    const ybar = zig.reduce((a, b) => a + b, 0) / n;
    const sxx = zig.reduce((s, _, i) => s + (i + 1 - xbar) ** 2, 0);
    const sxy = zig.reduce((s, y, i) => s + (i + 1 - xbar) * (y - ybar), 0);
    const b = sxy / sxx;
    const pNaive = 2 * (1 - 0.5 * (1 + erf(Math.abs(b / (se / Math.sqrt(sxx))) / Math.SQRT2)));

    expect(pNaive).toBeLessThan(0.01); // 未修正 → 假显著
    expect(r.slope!).toBeCloseTo(b, 12); // φ 只放宽 SE，不动效应量
    expect(r.dispersion!).toBeGreaterThan(20);
    expect(r.slopeP!).toBeGreaterThan(0.05);
    expect(r.slopeP!).toBeGreaterThan(pNaive * 100);
  });
});

/** 只用 erf 的互补（避免依赖 stats 内部实现） */
function erf(x: number): number {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

describe('新颖效应接进引擎', () => {
  const ds = generateDataset(20261031);
  const byExp = new Map<string, typeof ds.daily>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }

  it('每个实验都给得出 7 个逐日分段点，且逐日点互不重叠（样本加起来=总量）', () => {
    for (const e of ds.experiments.slice(0, 10)) {
      const rows = byExp.get(e.id) ?? [];
      const a = analyze(e, rows);
      expect(a.novelty.skipped).toBeUndefined();
      expect(a.novelty.points.length).toBe(7);
      const sum = a.novelty.points.reduce((s, p) => s + p.nPerArm, 0);
      expect(sum).toBeCloseTo((a.overall.n1 + a.overall.n2) / 2, 6);
      expect(a.novelty.early.days + a.novelty.late.days).toBe(7);
    }
  });

  it('分段估计（dailySegments）与累计估计（dailyLooks）必须不同——混用会低估 SE', () => {
    const e = ds.experiments[0];
    const rows = byExp.get(e.id) ?? [];
    const a = analyze(e, rows);
    const segs = dailySegments(rows, a.primary.kind, a.primary.via);
    const looks = a.sequential.looks;
    // 分段：每天样本量在同一个量级（会波动，但不会累积）
    const nSeg = segs.map((s) => s.nPerArm);
    expect(Math.max(...nSeg) / Math.min(...nSeg)).toBeLessThan(1.25);
    // 累计：末次样本量是首次的数倍
    expect(looks[looks.length - 1].nPerArm).toBeGreaterThan(looks[0].nPerArm * 4);
    // 分段样本之和 ≈ 总量（互不重叠）
    expect(nSeg.reduce((x, y) => x + y, 0)).toBeCloseTo(looks[looks.length - 1].nPerArm, 0);
    // 累计 SE 必须变小；分段的不会（样本没变多）
    expect(looks[looks.length - 1].se).toBeLessThan(looks[0].se);
  });

  it('A/A 上误报率受控（1000 个零效应实验，真引擎路径）', () => {
    const aa = generateAA(600, 20261101, 7);
    const byAa = new Map<string, typeof aa.daily>();
    for (const r of aa.daily) {
      const l = byAa.get(r.expId);
      if (l) l.push(r);
      else byAa.set(r.expId, [r]);
    }
    let fp = 0;
    let up = 0;
    let down = 0;
    for (const e of aa.experiments) {
      const a = analyze(e, byAa.get(e.id) ?? []);
      if (a.novelty.pattern === 'stable' || a.novelty.pattern === 'insufficient') continue;
      fp++;
      if (a.novelty.delta > 0) up++;
      else down++;
    }
    const rate = fp / aa.experiments.length;
    // 之前「两段各自重估 + 正态」在这里是 12%~15%；日级聚类 + Welch t 应落到 10% 以内
    expect(rate).toBeLessThan(0.1);
    expect(rate).toBeGreaterThan(0.01);
    // 零效应下不能有方向性偏差（判 growth 与 decay 应大致对半）
    expect(Math.min(up, down) / Math.max(up, down)).toBeGreaterThan(0.4);
  });

  it('真实数据上多数实验不判衰减（比例要能解释，不是全判或全不判）', () => {
    let flagged = 0;
    let stable = 0;
    for (const e of ds.experiments) {
      const a = analyze(e, byExp.get(e.id) ?? []);
      if (a.novelty.pattern === 'stable') stable++;
      if (a.novelty.pattern === 'decay' || a.novelty.pattern === 'growth') flagged++;
    }
    expect(stable).toBeGreaterThan(ds.experiments.length * 0.8);
    expect(flagged).toBeLessThan(ds.experiments.length * 0.2);
  });
});
