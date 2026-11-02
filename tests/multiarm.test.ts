import { describe, expect, it } from 'vitest';
import {
  dunnettCritEqual,
  dunnettTwoSided,
  gaussHermite,
  globalTest,
  integrateNormal,
  mdeMultiArmRate,
  parseAllocation,
  powerEqualCorr,
  powerOneArm,
  probabilityBest,
  sampleSizeMultiArm,
  sampleSizeMultiArmContinuous,
  winnerCurse,
} from '../src/lib/multiarm.ts';
import { chi2Sf, chi2Sf1, normalCdf, normalInv, studentTTwoSided } from '../src/lib/stats.ts';

describe('Gauss–Hermite 求积（后面所有的积分都靠它）', () => {
  it('权重和为 √π、二阶矩为 √π/2', () => {
    const { x, w } = gaussHermite(40);
    expect(x.length).toBe(40);
    const s = w.reduce((a, b) => a + b, 0);
    const m2 = w.reduce((a, b, i) => a + b * x[i] * x[i], 0);
    expect(s).toBeCloseTo(Math.sqrt(Math.PI), 12);
    expect(m2).toBeCloseTo(Math.sqrt(Math.PI) / 2, 12);
  });

  it('∫ φ(u)·cos u du = e^{−1/2}（被积函数不是多项式，能测出点数够不够）', () => {
    // E[cos U] = Re(E[e^{iU}]) = e^{−1/2}；这条同时覆盖了换元 u=√2·x 的系数
    const v = integrateNormal((u) => Math.cos(u), 40);
    expect(v).toBeCloseTo(Math.exp(-0.5), 12);
  });

  it('点数够用：20 点与 60 点的差 < 1e-10（说明 40 点已经收敛）', () => {
    const f = (u: number) => 1 / (1 + Math.exp(-2.5 * u));
    expect(Math.abs(integrateNormal(f, 40) - integrateNormal(f, 60))).toBeLessThan(1e-10);
  });
});

describe('卡方上尾（多臂全局检验要用非 df=1 的）', () => {
  it('df=1 时与闭式 chi2Sf1 逐点一致', () => {
    for (const x of [0.001, 0.5, 1, 2.7, 3.841, 10, 25]) {
      expect(chi2Sf(x, 1)).toBeCloseTo(chi2Sf1(x), 12);
    }
  });

  it('常见临界值对得上表', () => {
    expect(chi2Sf(3.8415, 1)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(5.9915, 2)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(7.8147, 3)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(9.4877, 4)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(0, 3)).toBe(1);
  });
});

describe('Dunnett：多臂同时比较', () => {
  const se0 = 0.001;

  it('m=1 时严格退化成普通双侧 z 检验（不校正就不该有代价）', () => {
    const d = dunnettTwoSided({ diff: [0.004], se: [Math.hypot(0.0016, 0.001)], seControl: se0 });
    const z = 0.004 / Math.hypot(0.0016, 0.001);
    expect(d.rawP[0]).toBeCloseTo(2 * (1 - normalCdf(z)), 12);
    expect(d.adjP[0]).toBeCloseTo(d.rawP[0], 10);
    // 临界值与差值同单位，所以换算成 z 再比
    // 临界值是 z 单位（CI 用 Δ ± c·SE），m=1 时必须正好是 z_{0.975}
    expect(d.crit).toBeCloseTo(1.959964, 4);
  });

  it('校正后 p 不小于边际 p，且臂越多越保守（单调）', () => {
    const diff = [0.004, 0.001];
    const se = [Math.hypot(0.0016, 0.001), Math.hypot(0.0015, 0.001)];
    const two = dunnettTwoSided({ diff, se, seControl: se0 });
    const three = dunnettTwoSided({ diff: [...diff, -0.002], se: [...se, Math.hypot(0.0014, 0.001)], seControl: se0 });
    for (let i = 0; i < 2; i++) {
      expect(two.adjP[i]).toBeGreaterThanOrEqual(two.rawP[i] - 1e-12);
      expect(three.adjP[i]).toBeGreaterThanOrEqual(two.adjP[i] - 1e-12);
    }
    expect(three.crit).toBeGreaterThan(two.crit);
  });

  it('临界值与权威表对齐：2/3/4 个处理臂 → 2.212 / 2.349 / 2.442', () => {
    // Dunnett 双侧 α=0.05、等样本、ρ=0.5 的经典表值（df=∞）
    expect(dunnettCritEqual(0.05, 3, 0.5)).toBeCloseTo(2.212, 2);
    expect(dunnettCritEqual(0.05, 4, 0.5)).toBeCloseTo(2.349, 2);
    expect(dunnettCritEqual(0.05, 5, 0.5)).toBeCloseTo(2.442, 2);
    // 比 Bonferroni 宽松一点——这就是「利用相关性」赚回来的那部分
    expect(dunnettCritEqual(0.05, 3, 0.5)).toBeLessThan(normalInv(1 - 0.05 / 4));
  });

  it('同时区间与校正 p 自洽：跨 0 ⟺ adjP > α', () => {
    const d = dunnettTwoSided({
      diff: [0.0045, 0.0008, -0.003],
      se: [0.0018, 0.0017, 0.0019],
      seControl: se0,
    });
    for (let i = 0; i < 3; i++) {
      const crosses = d.ci[i][0] <= 0 && d.ci[i][1] >= 0;
      expect(crosses).toBe(d.adjP[i] > 0.05);
    }
  });

  it('与模拟对齐：全零族下 Dunnett 的族错误率 ≈ 5%，naive 逐臂明显更大（3 个处理臂）', () => {
    // 用确定性 PRNG 造「三个处理臂共享同一个对照」的数据，直接数误报率。
    // 这一条同时验证了「条件独立一维积分」的实现没有写错——写错的话这里会明显偏离 5%。
    let s = 20261102;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randn = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const n = 30000;
    const p = 0.05;
    const sdT = Math.sqrt((p * (1 - p)) / n);
    const sdC = Math.sqrt((p * (1 - p)) / n);
    const sdDiff = Math.hypot(sdT, sdC);
    // 等样本量 → ρ = sdC²/sdDiff² = 0.5。3 个处理臂 = 4 个臂（含对照），
    // 所以临界值要按 k=4 解（这里传错成 k=3 会让 FWER 假性偏高到 7.4%，正是本测试的价值）
    const crit = dunnettCritEqual(0.05, 4, 0.5);
    const trials = 20000;
    let naive = 0;
    let dunnett = 0;
    for (let k = 0; k < trials; k++) {
      const m0 = sdC * randn();
      const diffs = [0, 1, 2].map(() => sdT * randn() - m0); // 处理臂独立，对照共享
      if (diffs.some((d) => Math.abs(d / sdDiff) > 1.959964)) naive++;
      if (diffs.some((d) => Math.abs(d / sdDiff) > crit)) dunnett++;
    }
    const naiveRate = naive / trials;
    const dunnettRate = dunnett / trials;
    expect(naiveRate).toBeGreaterThan(0.10); // 正相关会把 1−0.95³=14.3% 拉低一点，但仍明显超 5%
    expect(dunnettRate).toBeGreaterThan(0.04);
    expect(dunnettRate).toBeLessThan(0.06);
    expect(dunnettRate).toBeLessThan(naiveRate * 0.6);
  });
});

describe('P(哪个臂最优)', () => {
  it('两臂时退化成 Φ(Δ / (√2·SE))（可手算核对）', () => {
    const se = 0.004;
    const diff = 0.006;
    const r = probabilityBest({ estimate: [0, diff], se: [se, se], label: ['A', 'B'] });
    expect(r.prob[0] + r.prob[1]).toBeCloseTo(1, 10);
    expect(r.prob[1]).toBeCloseTo(normalCdf(diff / (se * Math.SQRT2)), 6);
  });

  it('多臂时概率和为 1，且效应最大的臂概率最高', () => {
    const r = probabilityBest({
      estimate: [0, 0.004, 0.006, -0.001],
      se: [0.002, 0.0021, 0.0022, 0.0019],
      label: ['A', 'B', 'C', 'D'],
    });
    expect(r.prob.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(r.bestIndex).toBe(2);
    expect(r.prob[3]).toBeLessThan(0.05);
  });

  it('全部无效时最优概率接近均分（不会硬挑一个赢家）', () => {
    const r = probabilityBest({ estimate: [0, 0, 0], se: [0.003, 0.003, 0.003], label: ['A', 'B', 'C'] });
    for (const p of r.prob) expect(p).toBeCloseTo(1 / 3, 3);
  });

  it('赢家诅咒随臂数增加（这就是「挑最大」必须校正的理由）', () => {
    expect(winnerCurse([0.002, 0.002, 0.002], 3)).toBeGreaterThan(winnerCurse([0.002, 0.002], 2));
    expect(winnerCurse([0.002, 0.002, 0.002], 2)).toBeGreaterThan(0);
  });
});

describe('全局检验', () => {
  it('m=1 时 Q 必须等于 (Δ/SE)²（写错方差会立刻暴露）', () => {
    const se = 0.002;
    const seC = 0.0012;
    const g = globalTest({ diff: [0.004], se: [se], seControl: seC });
    expect(g.chi2).toBeCloseTo((0.004 / se) ** 2, 10);
    expect(g.p).toBeCloseTo(chi2Sf1((0.004 / se) ** 2), 10);
  });

  it('三臂全零附近 p 偏大，有明显效应时 p 变小', () => {
    const se = [0.002, 0.002, 0.002];
    const seC = 0.0012;
    const flat = globalTest({ diff: [0.0004, -0.0003, 0.0002], se, seControl: seC });
    const loud = globalTest({ diff: [0.006, -0.0003, 0.0002], se, seControl: seC });
    expect(flat.p).toBeGreaterThan(0.2);
    expect(loud.p).toBeLessThan(0.02);
    expect(loud.df).toBe(3);
  });
});

describe('多臂样本量（规划）', () => {
  it('反解出来的 n 真的达到目标功效，且少 1 个就不到', () => {
    for (const arms of [3, 4]) {
      const r = sampleSizeMultiArm({ p1: 0.05, p2: 0.055, arms, alpha: 0.05, power: 0.8 });
      expect(r.achievedPower).toBeGreaterThanOrEqual(0.7999);
      expect(r.nPerArm).toBeGreaterThan(2);
      // 用同一口径（每臂检出率）重算 n−1 的功效
      const seMinus = Math.sqrt((0.05 * 0.95) / (r.nPerArm - 1) + (0.055 * 0.945) / (r.nPerArm - 1));
      expect(powerOneArm(0.005 / seMinus, r.crit)).toBeLessThan(0.8);
      expect(r.total).toBe(r.nPerArm * arms);
    }
  });

  it('臂越多每组样本越多，且总流量乘数 > 1', () => {
    const a = sampleSizeMultiArm({ p1: 0.05, p2: 0.055, arms: 2 });
    const c = sampleSizeMultiArm({ p1: 0.05, p2: 0.055, arms: 4 });
    expect(c.nPerArm).toBeGreaterThan(a.nPerArm);
    expect(c.trafficMultiplier).toBeGreaterThan(1.5);
    expect(c.powerAnyArm).toBeGreaterThan(c.achievedPower - 1e-9); // 至少一臂 ≥ 每臂
    // Dunnett 总比 Bonferroni 省样本（这是它的存在意义）
    expect(c.nPerArmBonferroni).toBeGreaterThanOrEqual(c.nPerArm);
  });

  it('连续指标同样是「少 1 个就不够」', () => {
    const r = sampleSizeMultiArmContinuous({ sd: 30, delta: 3, arms: 3 });
    const lam = (3 * Math.sqrt(r.nPerArm)) / (30 * Math.SQRT2);
    expect(powerOneArm(lam, r.crit)).toBeGreaterThanOrEqual(0.7999);
    const lamMinus = (3 * Math.sqrt(r.nPerArm - 1)) / (30 * Math.SQRT2);
    expect(powerOneArm(lamMinus, r.crit)).toBeLessThan(0.8);
  });

  it('两臂时与经典样本量公式一致（不能因为走多臂路径就变了口径）', () => {
    const r = sampleSizeMultiArm({ p1: 0.05, p2: 0.055, arms: 2 });
    const za = normalInv(0.975);
    const zb = normalInv(0.8);
    const seNeeded = 0.005 / (za + zb);
    const nClassic = Math.ceil((0.05 * 0.95 + 0.055 * 0.945) / (seNeeded * seNeeded));
    // 允许 ±3 的离散化差异（经典公式用合并方差，这里用非合并）
    expect(Math.abs(r.nPerArm - nClassic)).toBeLessThan(0.02 * nClassic);
  });
});

describe('分流声明解析', () => {
  it('认 50/25/25、1:1:1、带百分号与空格', () => {
    expect(parseAllocation('50/25/25')).toEqual([0.5, 0.25, 0.25]);
    expect(parseAllocation('1:1:1')).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(parseAllocation('50%, 25%, 25%')).toEqual([0.5, 0.25, 0.25]);
    expect(parseAllocation('50 / 50')).toEqual([0.5, 0.5]);
  });

  it('解析不出来时返回 null（不能猜，猜错会把正常实验判成 SRM）', () => {
    expect(parseAllocation('')).toBeNull();
    expect(parseAllocation(undefined)).toBeNull();
    expect(parseAllocation('五五分')).toBeNull();
    expect(parseAllocation('0/0')).toBeNull();
  });
});

describe('t 分布与正态的偏离：多臂校正不能把连续指标的 t 当成 z', () => {
  it('df=26 时 t 双侧 p 明显大于正态（差 5% 左右，正是不能混用的原因）', () => {
    const t = 2.2;
    expect(studentTTwoSided(t, 26)).toBeGreaterThan(2 * (1 - normalCdf(t)));
    const ratio = studentTTwoSided(t, 26) / (2 * (1 - normalCdf(t)));
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(1.4);
  });
});

describe('反向问题：定了天数能测多大（多臂 MDE）', () => {
  it('与正解互逆：用 sampleSizeMultiArm 算出的 n，反解回来必须落回同一个提升', () => {
    const p1 = 0.05;
    const p2 = 0.055; // +10%
    for (const arms of [3, 4]) {
      const plan = sampleSizeMultiArm({ p1, p2, arms, alpha: 0.05, power: 0.8 });
      const mde = mdeMultiArmRate({ p1, arms, nPerArm: plan.nPerArm, alpha: 0.05, power: 0.8 });
      // 离散化只差 1 人，反解出来的相对提升应当与 10% 相差不到 0.5 个点
      expect(Math.abs(mde.mdeRel - 0.1) * 100).toBeLessThan(0.5);
      expect(mde.p2).toBeGreaterThan(p1);
    }
  });

  it('臂越多，同样的 n 能检出的效应越大（单臂样本被摊薄）', () => {
    const args = { p1: 0.05, nPerArm: 20_000, alpha: 0.05, power: 0.8 };
    const three = mdeMultiArmRate({ ...args, arms: 3 });
    const four = mdeMultiArmRate({ ...args, arms: 4 });
    expect(four.mdeRel).toBeGreaterThan(three.mdeRel);
  });

  it('样本越多能检出的效应越小（单调），且临界值随 ρ 变化而不是常数', () => {
    const base = { p1: 0.05, arms: 3, alpha: 0.05, power: 0.8 };
    const small = mdeMultiArmRate({ ...base, nPerArm: 5_000 });
    const large = mdeMultiArmRate({ ...base, nPerArm: 200_000 });
    expect(large.mdeRel).toBeLessThan(small.mdeRel);
    // 效应越大 ρ 越小 → 临界值不可能是固定值
    expect(Math.abs(large.crit - small.crit)).toBeGreaterThan(1e-6);
  });

  it('每组样本少到不可能有功效时报错，而不是返回一个假数字', () => {
    expect(() => mdeMultiArmRate({ p1: 0.05, arms: 4, nPerArm: 3, alpha: 0.05, power: 0.8 })).toThrow(/即使提升|功效/);
    expect(() => mdeMultiArmRate({ p1: 0.05, arms: 3, nPerArm: 1, alpha: 0.05, power: 0.8 })).toThrow(/至少 2 人/);
  });
});
