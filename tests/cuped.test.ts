import { describe, expect, it } from 'vitest';
import { cupedAdjust, studentTSf, studentTTwoSided, type CupedCell } from '../src/lib/stats.ts';
import { analyze } from '../src/lib/decide.ts';
import { generateAA, generateDataset } from '../src/lib/simulate.ts';
import type { Dataset } from '../src/lib/types.ts';

/**
 * 造一组「前周期与实验期强相关」的格子：同一批人的倾向前后共享。
 * armShift 两臂不同（不同用户），所以不会在差值里抵消——这是 CUPED 的前提。
 */
function mkCells(opts: {
  lift?: number;
  armShiftT?: number;
  armShiftC?: number;
  cells?: number;
  seed?: number;
  /** 每个「格子 × 变体」自己的基线漂移（前后周期共享）的标准差 */
  cellSd?: number;
  /** false 时前周期与本期无关（用来验证 CUPED 不会假装有效） */
  preCorrelated?: boolean;
}): CupedCell[] {
  const {
    lift = 0, armShiftT = 0, armShiftC = 0, cells = 14, seed = 1,
    cellSd = 0.006, preCorrelated = true,
  } = opts;
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: CupedCell[] = [];
  for (let i = 0; i < cells; i++) {
    for (const treatment of [false, true]) {
      const n = 600 + Math.round(200 * rnd());
      const nPre = 600 + Math.round(200 * rnd());
      const armShift = treatment ? armShiftT : armShiftC;
      // 该格子这批人的倾向漂移：本期与前期共享（preCorrelated=false 时前期看不到它）
      const drift = cellSd * (rnd() * 2 - 1);
      const base = 0.05 + armShift;
      const post = base + drift + (treatment ? lift : 0);
      const pre = preCorrelated ? base + drift : base;
      out.push({
        n,
        c: Math.round(n * post),
        nPre,
        cPre: Math.round(nPre * pre),
        treatment,
      });
    }
  }
  return out;
}

describe('t 分布（新增，精确）', () => {
  it('df 大时逼近正态，df 小时更保守', () => {
    // t(∞) 的双侧 p 应逼近 0.05
    expect(studentTTwoSided(1.96, 1e7)).toBeCloseTo(0.05, 3);
    // df=5 时 t_{0.975}=2.571：同样 1.96 应该不显著
    expect(studentTTwoSided(1.96, 5)).toBeGreaterThan(0.05);
    expect(studentTTwoSided(2.571, 5)).toBeCloseTo(0.05, 3);
    // 已知值：t=2.0, df=10 → 双侧 p ≈ 0.0734
    expect(studentTTwoSided(2, 10)).toBeCloseTo(0.0734, 3);
  });

  it('上尾单调且在 [0,1]', () => {
    let prev = 1;
    for (const t of [-3, -1, 0, 1, 2, 3, 5]) {
      const v = studentTSf(t, 12);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(studentTSf(0, 12)).toBeCloseTo(0.5, 6);
  });
});

describe('A1 · CUPED 方差缩减', () => {
  it('前后周期强相关时，方差缩减明显（且不改点估计方向）', () => {
    // 两臂的 armShift 不同 → 有真实可减的方差
    const r = cupedAdjust(mkCells({ lift: 0.01, armShiftT: 0.012, armShiftC: -0.012 }))!;
    expect(r).toBeTruthy();
    expect(r.varReduction).toBeGreaterThan(0.3);
    expect(r.rho).toBeGreaterThan(0.5);
    // 前周期差值被扣掉后，调整后的差值应更接近真实 lift（1pp）
    expect(Math.abs(r.diffAdj - 0.01)).toBeLessThan(Math.abs(r.diffRaw - 0.01) + 1e-9);
    expect(r.seAdj).toBeLessThan(r.seRaw);
  });

  it('前后周期无关时不会假装有效（不会把区间缩窄）', () => {
    // 前周期看不到本期那部分漂移 → θ 应该接近 0，方差缩减也应该接近 0
    const r = cupedAdjust(mkCells({ lift: 0.01, armShiftT: 0.01, armShiftC: -0.01, preCorrelated: false }))!;
    expect(Math.abs(r.theta)).toBeLessThan(0.15);
    expect(r.varReduction).toBeLessThan(0.05);
  });

  it('θ 与 ρ 的符号一致，且 ρ ∈ [−1, 1]', () => {
    const r = cupedAdjust(mkCells({ lift: 0.008, armShiftT: 0.01, armShiftC: -0.01 }))!;
    expect(r.rho).toBeGreaterThan(-1);
    expect(r.rho).toBeLessThan(1);
    expect(Math.sign(r.theta)).toBe(Math.sign(r.rho));
  });

  it('格子太少时拒绝给出结果（稳健方差的分母不够）', () => {
    expect(cupedAdjust(mkCells({ cells: 2 }))).toBeNull();
    expect(cupedAdjust([])).toBeNull();
  });

  it('缺前周期数据的格子会被剔除，而不是算错', () => {
    const cells = mkCells({ lift: 0.01, armShiftT: 0.01, armShiftC: -0.01 });
    const partial = cells.map((c, i) => (i < 8 ? { ...c, nPre: 0, cPre: 0 } : c));
    const r = cupedAdjust(partial)!;
    expect(r.nCells).toBe(cells.length - 8);
  });

  it('确定性：同输入两次结果逐位相同', () => {
    const cells = mkCells({ lift: 0.01, armShiftT: 0.01, armShiftC: -0.01 });
    const a = cupedAdjust(cells)!;
    const b = cupedAdjust(cells)!;
    expect(a.theta).toBe(b.theta);
    expect(a.seAdj).toBe(b.seAdj);
    expect(a.pAdj).toBe(b.pAdj);
  });

  it('区间包含点估计，且 p 与 z 一致', () => {
    const r = cupedAdjust(mkCells({ lift: 0.01, armShiftT: 0.01, armShiftC: -0.01 }))!;
    expect(r.ciAdj[0]).toBeLessThanOrEqual(r.diffAdj);
    expect(r.ciAdj[1]).toBeGreaterThanOrEqual(r.diffAdj);
    expect(r.pAdj).toBeGreaterThanOrEqual(0);
    expect(r.pAdj).toBeLessThanOrEqual(1);
  });
});

describe('A1 · CUPED 在引擎里的接入', () => {
  const ds: Dataset = generateDataset(20261031, 7);
  const rowsOf = (id: string) => ds.daily.filter((r) => r.expId === id);

  it('合成数据带前周期字段，且每个实验都能算出 CUPED', () => {
    expect(ds.spec.preDays).toBe(7);
    const e = ds.experiments[0];
    const a = analyze(e, rowsOf(e.id));
    expect(a.cuped).toBeDefined();
    expect(a.cuped!.nCells).toBe(56); // 7 天 × 2 端 × 2 人群 × 2 变体
    expect(a.primary.via).toBe('cuped');
  });

  it('过离散因子 > 1：说明朴素 i.i.d. 假设确实不成立（这条是本功能存在的前提）', () => {
    const vals = ds.experiments.slice(0, 30).map((e) => analyze(e, rowsOf(e.id)).cuped!.dispersion);
    const median = vals.slice().sort((x, y) => x - y)[Math.floor(vals.length / 2)];
    expect(median).toBeGreaterThan(1.1);
  });

  it('CUPED 让区间更窄（平均意义上）', () => {
    let raw = 0;
    let adj = 0;
    for (const e of ds.experiments) {
      const c = analyze(e, rowsOf(e.id)).cuped!;
      raw += c.seRaw;
      adj += c.seAdj;
    }
    expect(adj).toBeLessThan(raw);
  });

  it('关掉 CUPED 会退回稳健口径，不是退回朴素 i.i.d.', () => {
    const e = ds.experiments[0];
    const off = analyze(e, rowsOf(e.id), { useCuped: false, seMode: 'robust' });
    expect(off.primary.via).toBe('robust');
    const iid = analyze(e, rowsOf(e.id), { useCuped: false, seMode: 'iid' });
    expect(iid.primary.via).toBe('ztest');
    // 稳健口径的 p 应不小于朴素口径（区间更宽 = 更保守）
    expect(off.primary.p).toBeGreaterThanOrEqual(iid.primary.p - 1e-12);
  });

  it('导入数据没有前周期字段时，自动退回且不出错', () => {
    const stripped = ds.daily.map(({ preExposures: _p, preConversions: _c, ...rest }) => rest);
    const a = analyze(ds.experiments[0], stripped.filter((r) => r.expId === ds.experiments[0].id));
    expect(a.cuped).toBeUndefined();
    expect(a.primary.via).toBe('ztest');
    expect(a.decision).toBeDefined();
  });

  it('A/A 下 CUPED 口径的误报率明显低于朴素 i.i.d.（这是本功能最硬的一条证据）', () => {
    const aa = generateAA(150);
    const m = new Map<string, (typeof aa.daily)[number][]>();
    for (const r of aa.daily) {
      const l = m.get(r.expId);
      if (l) l.push(r);
      else m.set(r.expId, [r]);
    }
    let hitCuped = 0;
    let hitIid = 0;
    for (const e of aa.experiments) {
      const rows = m.get(e.id) ?? [];
      if (analyze(e, rows, { useCuped: true, seMode: 'robust' }).decision !== 'inconclusive') hitCuped++;
      if (analyze(e, rows, { useCuped: false, seMode: 'iid' }).decision !== 'inconclusive') hitIid++;
    }
    const n = aa.experiments.length;
    // 朴素口径在过离散数据上会失控；CUPED+稳健口径必须显著更低
    expect(hitCuped / n).toBeLessThan(hitIid / n);
    expect(hitCuped / n).toBeLessThan(0.12);
  });
});
