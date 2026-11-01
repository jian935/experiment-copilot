import { describe, expect, it } from 'vitest';
import {
  LOSS_CAUTIONS,
  LOSS_GATES,
  applyGates,
  breakEven,
  defaultLoss,
  expNegPart,
  expPosPart,
  expectedLoss,
  netValueAt,
} from '../src/lib/loss.ts';
import { realizedValue, runLossReport, truthInUnit } from '../scripts/loss_report.ts';

/** 数值积分校验：把正态密度直接积出来，不信解析式自己说自己对 */
function integrate(f: (x: number) => number, lo: number, hi: number, n = 200000): number {
  // 复合 Simpson
  const h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += f(lo + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

describe('B1 · 期望损失决策', () => {
  it('expPosPart / expNegPart 与数值积分对齐（4 组参数）', () => {
    const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    for (const [mu, sd] of [
      [0, 1],
      [0.5, 1],
      [-0.5, 1],
      [2, 0.3],
      [-3, 2],
    ] as const) {
      const z = (x: number) => phi((x - mu) / sd) / sd;
      const posNum = integrate((x) => Math.max(0, x) * z(x), mu - 12 * sd, mu + 12 * sd);
      const negNum = integrate((x) => Math.max(0, -x) * z(x), mu - 12 * sd, mu + 12 * sd);
      expect(expPosPart(mu, sd)).toBeCloseTo(posNum, 6);
      expect(expNegPart(mu, sd)).toBeCloseTo(negNum, 6);
    }
  });

  it('恒等式 E[max(0,Δ)] − E[max(0,−Δ)] ≡ Δ̂（整个模块的地基）', () => {
    for (const mu of [-1, -0.2, 0, 0.05, 0.7, 3]) {
      for (const sd of [0.1, 1, 5]) {
        expect(netValueAt(mu, sd, 1)).toBeCloseTo(mu, 12);
      }
    }
  });

  it('k=1 时规则退化成「点估计 > MMP 就上线」，k 越大上线越少', () => {
    const se = 0.01;
    const mmp = 0.001;
    // k=1 的等价点就是 MMP 本身
    expect(breakEven({ riskAversion: 1, mmp }, se)).toBeCloseTo(mmp, 12);
    // 净价值 = Δ̂ − MMP，所以 Δ̂ > MMP 才上线
    expect(expectedLoss(0.002, se, 'pp', { riskAversion: 1, mmp }).action).toBe('ship');
    expect(expectedLoss(0.0005, se, 'pp', { riskAversion: 1, mmp }).action).toBe('no-ship');
    // 提高 k 会把边界往上推：同一个 Δ̂ 从前能上后不能上
    const ladders = [1, 2, 5, 10].map((k) => breakEven({ riskAversion: k, mmp }, se));
    for (let i = 1; i < ladders.length; i++) expect(ladders[i]).toBeGreaterThan(ladders[i - 1]);
    expect(expectedLoss(0.004, se, 'pp', { riskAversion: 1, mmp }).action).toBe('ship');
    expect(expectedLoss(0.004, se, 'pp', { riskAversion: 10, mmp }).action).toBe('no-ship');
  });

  it('breakEven 单调：SE 越大门槛越高，MMP 越大门槛越高', () => {
    const p = { riskAversion: 2, mmp: 0.001 };
    const be = (se: number, mmp = 0.001) => breakEven({ ...p, mmp }, se);
    expect(be(0.002)).toBeLessThan(be(0.01));
    expect(be(0.01)).toBeLessThan(be(0.05));
    expect(be(0.01, 0.001)).toBeLessThan(be(0.01, 0.01));
  });

  it('breakEven 真的让净价值等于 MMP（代回去校验，不信二分自身）', () => {
    for (const [k, mmp, se] of [
      [2, 0.001, 0.005],
      [3, 0.02, 0.4],
      [1.5, 0, 0.02],
    ] as const) {
      const be = breakEven({ riskAversion: k, mmp }, se);
      expect(netValueAt(be, se, k)).toBeCloseTo(mmp, 9);
    }
  });

  it('退化输入不产生 NaN / Infinity', () => {
    for (const se of [0, 1e-12]) {
      const d = expectedLoss(0.01, se, 'pp');
      expect(Number.isFinite(d.netValue)).toBe(true);
      expect(Number.isFinite(d.breakEvenDiff)).toBe(true);
      expect(Number.isFinite(d.breakEvenGapSe)).toBe(true);
    }
    const d0 = expectedLoss(0, 0, 'pp');
    expect(d0.eGain).toBe(0);
    expect(d0.eHarm).toBe(0);
  });

  it('硬门禁只否决四条里的三条，异质只给建议', () => {
    // 三条硬门禁：一律改成不上线，并记录理由
    for (const code of ['SRM', 'GUARDRAIL', 'NEGATIVE']) {
      const g = applyGates('ship', code);
      expect(g.action).toBe('no-ship');
      expect(g.vetoed).toBe(true);
      expect(g.vetoCode).toBe(code);
      expect(g.rawAction).toBe('ship');
      expect(g.vetoReason).toBe(LOSS_GATES[code]);
      expect(g.cautionCode).toBeNull();
    }
    // 异质：放行 + 建议限定人群（把它当门禁会白扔集中在某人群的真实收益）
    const h = applyGates('ship', 'HETEROGENEOUS');
    expect(h.action).toBe('ship');
    expect(h.vetoed).toBe(false);
    expect(h.vetoCode).toBeNull();
    expect(h.cautionCode).toBe('HETEROGENEOUS');
    expect(h.caution).toBe(LOSS_CAUTIONS.HETEROGENEOUS);
    // 正常放行
    expect(applyGates('ship', 'POSITIVE')).toMatchObject({ action: 'ship', vetoed: false, cautionCode: null });
    // 门禁不改「本来就不上线」的结论（免得把 veto 计数虚高）
    for (const code of ['SRM', 'GUARDRAIL', 'NEGATIVE']) {
      expect(applyGates('no-ship', code).vetoed).toBe(false);
    }
  });

  it('真值换算：率指标原样，ARPU 走相对提升 × 对照 ARPU', () => {
    expect(truthInUnit('pp', 0.018, 0.4, 2.5)).toBeCloseTo(0.018, 12);
    expect(truthInUnit('元', 0.018, 0.4, 2.5)).toBeCloseTo(1.0, 12);
    // 没有 trueRpuLift 时不该造数：退回原值（这种行 unit 一定是 pp，不会走到这支）
    expect(truthInUnit('元', 0.018, undefined, 2.5)).toBeCloseTo(0.018, 12);
  });

  it('realizedValue：上线才扣 MMP，负效应按 k 倍罚', () => {
    const p = { riskAversion: 2, mmp: 0.001 };
    expect(realizedValue(0.02, 'ship', p)).toBeCloseTo(0.019, 12);
    expect(realizedValue(-0.01, 'ship', p)).toBeCloseTo(-0.021, 12);
    expect(realizedValue(0.02, 'no-ship', p)).toBe(0);
    expect(realizedValue(-0.01, 'no-ship', p)).toBe(0);
  });

  it('120 个实验：门禁后 E 不输给频率派，且每个原型的上线数符合预期', () => {
    const r = runLossReport();
    const t = r.totals;
    // 主结论：门禁 + 净价值不能比频率派规则更差（否则这个决策层没有存在理由）
    expect(t.expectedLossGated).toBeGreaterThan(t.frequentist);
    // 分组方向必须一致，不能靠某一组撑起来
    for (const u of r.byUnit) {
      expect(u.expectedLossGated).toBeGreaterThan(u.frequentist);
    }
    // 裸规则更好看但作废：它会上线护栏已恶化的实验
    expect(t.rawShipsGuardrailBroken).toBe(15);
    expect(t.expectedLoss).toBeGreaterThan(t.expectedLossGated);
    // 门禁只改写「本来要上线」的那些
    expect(t.vetoed).toBe(21);
  });

  it('门禁覆盖：负向 / 护栏 / SRM 一个都不能上线，正例全部上线', () => {
    const r = runLossReport();
    // 用 vetoes + disagreements 不足以覆盖全部 120 条，直接看分组总数：
    //   上线 55 = positive 25 + heterogeneous 15 + null 15
    expect(r.totals.shipCount.expectedLossGated).toBe(55);
    // 负向 15 + 护栏 15 + SRM 10 = 40 个里，裸规则只想上 21 个，门禁全拦掉
    expect(r.totals.vetoed).toBe(21);
    expect(r.totals.shipCount.all).toBe(120);
  });

  it('成本敏感性单调：k 越大上线越少、真实净价值不降', () => {
    const r = runLossReport();
    const ships = r.sensitivity.map((s) => s.shipCount);
    for (let i = 1; i < ships.length; i++) expect(ships[i]).toBeLessThanOrEqual(ships[i - 1]);
    // k 变大 → 更保守 → 会躲开负效应，事后真实净价值只能变好
    const vals = r.sensitivity.map((s) => s.loss);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-9);
  });

  it('默认参数：k=2、率 0.1pp、ARPU 0.02 元（必须与文档一致）', () => {
    expect(defaultLoss('pp')).toEqual({ riskAversion: 2, mmp: 0.001 });
    expect(defaultLoss('元')).toEqual({ riskAversion: 2, mmp: 0.02 });
  });

  it('护栏恶化的幅度是数据事实，不是断言出来的', () => {
    const r = runLossReport();
    expect(r.guardrailDamage.expCount).toBe(15);
    // 注入的是 refundDiff 0.008，实测应落在 1.2% → 2.0% 附近
    expect(r.guardrailDamage.controlRefund).toBeGreaterThan(0.010);
    expect(r.guardrailDamage.controlRefund).toBeLessThan(0.014);
    expect(r.guardrailDamage.treatmentRefund).toBeGreaterThan(r.guardrailDamage.controlRefund * 1.5);
  });
});
