import { describe, expect, it } from 'vitest';
import {
  buildPeekReport,
  snapToEqual,
  msprtAlwaysValidP,
  msprtBestCaseZ,
  msprtLogLR,
  msprtRequiredZ,
  obfAlphaSpent,
  obfBoundary,
  pocockAlphaSpent,
  type LookInput,
} from '../src/lib/sequential.ts';
import { mulberry32, normalCdf, normalInv } from '../src/lib/stats.ts';
import { analyze, dailyLooks, estimateAt } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 在标准布朗运动上跑「反复窥探」：Z_k 是累计统计量（Var = t_k），
 * 标准化后 Z_k/√t_k ~ N(0,1) 且 Corr = √(t_j/t_k)。
 * 这是序贯检验的规范模型；真实数据里的过离散/聚类方差由稳健 SE 吸收，模拟用来验证边界本身。
 */
function simulateFwer(
  bounds: number[],
  times: number[],
  trials: number,
  seed: number,
): { obf: number; naive: number } {
  const rng = mulberry32(seed);
  let obf = 0;
  let naive = 0;
  for (let t = 0; t < trials; t++) {
    let z = 0;
    let prev = 0;
    let hitObf = false;
    let hitNaive = false;
    for (let k = 0; k < times.length; k++) {
      z += Math.sqrt(times[k] - prev) * randn(rng);
      prev = times[k];
      const w = z / Math.sqrt(times[k]);
      if (Math.abs(w) >= bounds[k]) hitObf = true;
      if (Math.abs(w) >= normalInv(0.975)) hitNaive = true;
    }
    if (hitObf) obf++;
    if (hitNaive) naive++;
  }
  return { obf: obf / trials, naive: naive / trials };
}

describe('序贯检验：α 消耗与边界（A2）', () => {
  it('α 消耗函数：早期几乎不给 α，末期正好用完', () => {
    expect(obfAlphaSpent(1, 0.05)).toBeCloseTo(0.05, 12);
    expect(obfAlphaSpent(0, 0.05)).toBe(0);
    expect(obfAlphaSpent(0.1, 0.05)).toBeLessThan(1e-8);
    // 单调不减
    let prev = -1;
    for (const t of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const v = obfAlphaSpent(t, 0.05);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // Pocock 早期给得多：这正是"要不要尽早停"的差别
    expect(pocockAlphaSpent(0.25, 0.05)).toBeGreaterThan(obfAlphaSpent(0.25, 0.05) + 1e-3);
  });

  it('边界单调：观察次数越多、末期门槛越贴合，但绝不宽于 naive', () => {
    const K = 7;
    const times = Array.from({ length: K }, (_, i) => (i + 1) / K);
    const b = obfBoundary(times, 0.05);
    expect(b.boundaries.length).toBe(K);
    for (let i = 1; i < K; i++) expect(b.boundaries[i]).toBeLessThan(b.boundaries[i - 1]);
    // 末期边界必须严格大于 1.96：如果等于 1.96，说明前面几次的拒绝机会被漏算了
    expect(b.boundaries[K - 1]).toBeGreaterThan(1.96);
    for (let i = 0; i < K; i++) expect(b.nominalP[i]).toBeGreaterThan(0);
  });

  it('递推自洽：解出来的边界确实把累计越界概率压在 α 上', () => {
    for (const K of [2, 3, 5, 7]) {
      const times = Array.from({ length: K }, (_, i) => (i + 1) / K);
      const b = obfBoundary(times, 0.05);
      for (let i = 0; i < K; i++) {
        expect(Math.abs(b.cumulativeError[i] - b.alphaSpent[i])).toBeLessThan(2e-4);
      }
    }
  });

  /**
   * 独立实现的对照：K=2 时 tailMass 可以化成一维网格积分（Z₁ 的密度 × 给定 Z₁ 时的条件尾概率），
   * 与被测代码里的「密度矩阵递推」是两条不同的算法路径。一致才算递推没写错。
   */
  it('与暴力二维积分一致（K=2，独立实现路径）', () => {
    const b = obfBoundary([0.5, 1], 0.05);
    const [c1, c2] = b.boundaries;
    const rho = Math.sqrt(0.5);
    const s = Math.sqrt(1 - rho * rho);
    const H = 2e-3;
    let mass = 0;
    for (let u = -6; u <= 6; u += H) {
      if (Math.abs(u) >= c1) continue;
      const fu = Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI) * H;
      mass += fu * (1 - normalCdf((c2 - rho * u) / s) + normalCdf((-c2 - rho * u) / s));
    }
    const bruteForce = b.alphaSpent[0] + mass;
    expect(bruteForce).toBeCloseTo(0.05, 3);
  });

  it('反复窥探下 FWER 受控（7 次等距，零效应模拟）', () => {
    const K = 7;
    const times = Array.from({ length: K }, (_, i) => (i + 1) / K);
    const b = obfBoundary(times, 0.05);
    const r = simulateFwer(b.boundaries, times, 40000, 20261101);
    // 名义 5%：允许蒙特卡洛误差（40000 次，SE ≈ 0.11pp）
    expect(r.obf).toBeGreaterThan(0.035);
    expect(r.obf).toBeLessThan(0.065);
    // 而且它必须真的比「每天看一次还按 0.05 判」好——否则这块就没必要做
    expect(r.naive).toBeGreaterThan(0.12);
    expect(r.obf).toBeLessThan(r.naive - 0.05);
  });

  it('观察时点不等距也成立（Lan–DeMets 优于固定序列 OBF 的地方）', () => {
    const times = [0.1, 0.55, 0.8, 1];
    const b = obfBoundary(times, 0.05);
    const r = simulateFwer(b.boundaries, times, 40000, 777);
    expect(r.obf).toBeGreaterThan(0.035);
    expect(r.obf).toBeLessThan(0.065);
    // 早期信息量只有 10%，边界必须极宽
    expect(b.boundaries[0]).toBeGreaterThan(4.5);
  });

  it('只有在偏差 ≤2% 时才吸附到等距网格，且吸附带来的边界误差 < 0.02σ', () => {
    // 吸附是为了让同一观察次数只解一次边界（否则 120 个实验要解 120 次、加载慢数倍）。
    // 代价必须可量化，否则就是"为了性能偷偷改口径"。
    const K = 7;
    const exact = Array.from({ length: K }, (_, i) => (i + 1) / K);
    const near = exact.map((t, i) => t * (1 + (i % 2 ? 0.015 : -0.015)) * (i === K - 1 ? 1 / (1 * (1 + 0.015 * ((K - 1) % 2 ? 1 : -1))) : 1));
    const snapped = snapToEqual(near);
    expect(snapped.snapped).toBe(true);
    expect(snapped.times).toEqual(exact);
    // 真实的不均匀（某天没跑量）不吸附
    const uneven = [0.05, 0.2, 0.85, 1];
    expect(snapToEqual(uneven).snapped).toBe(false);
    expect(snapToEqual(uneven).times).toEqual(uneven);

    const a = obfBoundary(exact, 0.05).boundaries;
    const b = obfBoundary([0.14, 0.29, 0.43, 0.57, 0.72, 0.86, 1], 0.05).boundaries;
    for (let i = 0; i < K; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.02);
  });

  it('α 越小边界越严（单调性，防「换个 α 反而更松」这类实现错误）', () => {
    const times = [0.25, 0.5, 0.75, 1];
    const strict = obfBoundary(times, 0.01);
    const loose = obfBoundary(times, 0.05);
    for (let i = 0; i < times.length; i++) expect(strict.boundaries[i]).toBeGreaterThan(loose.boundaries[i]);
  });
});

describe('mSPRT / always-valid p', () => {
  const se = 0.004;
  const tau = 1.96 * se;

  it('零效应下 E[Λ] = 1（鞅的性质；否则 Ville 不等式不成立）', () => {
    // 用确定性数值积分而不是蒙特卡洛：E[Λ] 有闭式 = √(1/(1+k))·E[exp(k z²/(2(1+k)))] 且恒为 1，
    // 蒙特卡洛在这里噪声太大（BF 右尾很重），用积分才能把"恰好等于 1"钉到 1e-6。
    const k = (tau * tau) / (se * se);
    const integrand = (z: number) =>
      Math.sqrt(1 / (1 + k)) * Math.exp((k * z * z) / (2 * (1 + k))) * Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    // 被积函数其实是标准差 1/√(1−2a) ≈ 2.2 的高斯，±8 只有 3.6σ，尾巴会漏掉 3e-4 —— 所以要积到 ±20
    const H = 5e-3;
    let sum = 0;
    for (let z = -20; z <= 20; z += H) sum += integrand(z) * H;
    expect(sum).toBeCloseTo(1, 6);
    // 估计为 0 时 Λ = 1/√(1+k) < 1，于是"违反" H0 的方向为 0：p 必须被夹到 1
    expect(msprtLogLR(0, se, tau)).toBeCloseTo(-0.5 * Math.log(1 + k), 12);
    expect(msprtAlwaysValidP(0, se, tau)).toBe(1);
  });

  it('p 只在 |z| 变大时下降，且估计为 0 时 p=1', () => {
    expect(msprtAlwaysValidP(0, se, tau)).toBe(1);
    let prev = 1;
    for (const z of [1, 2, 2.5, 3, 4, 6]) {
      const p = msprtAlwaysValidP(z * se, se, tau);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
    expect(prev).toBeLessThan(0.05);
  });

  it('"随时可看"的价格是 ~3σ：比 naive 1.96 明显更严', () => {
    const best = msprtBestCaseZ(0.05);
    expect(best).toBeGreaterThan(2.8);
    expect(best).toBeLessThan(3.2);
    // 同一 α 下，先验尺度越偏离真实效应越贵
    expect(msprtRequiredZ(1.96, 0.05)).toBeGreaterThan(3);
    expect(msprtRequiredZ(0.2, 0.05)).toBeGreaterThan(msprtRequiredZ(1.96, 0.05));
  });
});

describe('窥探报告（把三套口径放在同一份数据上）', () => {
  const looks: LookInput[] = Array.from({ length: 5 }, (_, i) => ({
    day: i + 1,
    date: `2026-11-0${i + 1}`,
    nPerArm: 2000 * (i + 1),
    diff: 0.004,
    se: 0.004 / Math.sqrt(i + 1),
  }));

  it('只有一次观察时明确拒答，而不是硬算一个边界', () => {
    const r = buildPeekReport([looks[0]]);
    expect(r.skipped).toBeTruthy();
    expect(r.looks.length).toBe(0);
  });

  it('三套判定各自成立，且 OBF 门槛一定比 naive 紧', () => {
    const r = buildPeekReport(looks, { alpha: 0.05 });
    expect(r.k).toBe(5);
    expect(r.finalPBoundary).toBeLessThan(0.05);
    expect(r.obfTightening).toBeGreaterThan(1);
    expect(r.looks.map((l) => l.infoFrac)).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    // 这个构造里 |z| = 0.004/(0.004/√k) = √k，最后一次 z=2.236
    expect(r.looks[r.looks.length - 1].z).toBeCloseTo(Math.sqrt(5), 6);
    expect(r.naiveSig).toBe(true);
    for (const l of r.looks) {
      expect(l.pNaive).toBeGreaterThanOrEqual(0);
      expect(l.pNaive).toBeLessThanOrEqual(1);
      expect(l.pAlways).toBeGreaterThan(0);
      expect(l.pAlways).toBeLessThanOrEqual(1);
    }
  });

  it('早期观察几乎不可能判显著（边界极宽），这正是"防早停"的机制', () => {
    const r = buildPeekReport(looks, { alpha: 0.05 });
    expect(r.looks[0].zBoundary).toBeGreaterThan(3.5);
    expect(r.looks[0].zBoundary).toBeGreaterThan(r.looks[4].zBoundary);
  });

  it('priorScale 默认 1.96×最终 SE，可以显式覆盖', () => {
    const r = buildPeekReport(looks, { alpha: 0.05 });
    expect(r.priorScale).toBeCloseTo(normalInv(0.975) * looks[4].se, 10);
    const r2 = buildPeekReport(looks, { alpha: 0.05, priorScale: 0.01 });
    expect(r2.priorScale).toBe(0.01);
    expect(r2.finalPAlways).not.toBe(r.finalPAlways);
  });
});

describe('逐日重估与主指标口径不漂移', () => {
  const ds = generateDataset(20261031);
  const byExp = new Map<string, typeof ds.daily>();
  for (const r of ds.daily) {
    const list = byExp.get(r.expId);
    if (list) list.push(r);
    else byExp.set(r.expId, [r]);
  }

  it('estimateAt(全部数据) 与 analysis.primary 逐位相同（120 个实验）', () => {
    let checked = 0;
    for (const e of ds.experiments) {
      const rows = byExp.get(e.id) ?? [];
      const a = analyze(e, rows);
      const est = estimateAt(rows, a.primary.kind, a.primary.via);
      expect(est).not.toBeNull();
      expect(est!.diff).toBe(a.primary.diff);
      expect(est!.se).toBe(a.primary.se);
      expect(est!.via).toBe(a.primary.via);
      checked++;
    }
    expect(checked).toBe(ds.experiments.length);
  });

  it('逐日观察样本单调不减，且最后一次等于全集', () => {
    for (const e of ds.experiments.slice(0, 12)) {
      const rows = byExp.get(e.id) ?? [];
      const a = analyze(e, rows);
      const looks = dailyLooks(rows, a.primary.kind, a.primary.via);
      expect(looks.length).toBe(new Set(rows.map((r) => r.date)).size);
      for (let i = 1; i < looks.length; i++) {
        expect(looks[i].nPerArm).toBeGreaterThan(looks[i - 1].nPerArm);
        expect(looks[i].day).toBe(i + 1);
      }
      const last = looks[looks.length - 1];
      expect(last.nPerArm).toBeCloseTo((a.overall.n1 + a.overall.n2) / 2, 6);
      expect(a.sequential.k).toBe(looks.length);
      expect(a.sequential.skipped).toBeUndefined();
    }
  });
});
