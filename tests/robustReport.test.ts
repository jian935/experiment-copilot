/**
 * `npm run robust` 的自检。
 *
 * 这些断言锁的不是「数字正好是多少」，而是**结论的方向**——
 * 因为文档与面板里引用的就是这些方向（「原始口径守得住覆盖率」「截尾后不能当检验」）。
 * 一旦哪天有人改了截尾口径或 ratioTest 的方差，方向翻了，这里会先红，
 * 而不是等 README 里的数字悄悄变成假话。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runRobustReport } from '../scripts/robust_report.ts';

const R = runRobustReport(120, 600);

describe('robust_report', () => {
  it('三段报告齐全，档位与粒度都不缺', () => {
    expect(R.tail.map((t) => t.kappa)).toEqual([1, 10, 50, 200]);
    expect(R.power.map((p) => p.kappa)).toEqual([1, 10, 50, 200]);
    expect(R.granularity.map((g) => g.perCell)).toEqual([1, 5, 50]);
    expect(R.params).toMatchObject({ payerRate: 0.08, arpuTarget: 3.6, trimP: 0.01 });
  });

  it('长尾不会让原始区间误报：覆盖率在所有长尾档位都守在 90% 以上', () => {
    for (const t of R.tail) {
      expect(t.coverRaw).toBeGreaterThan(0.9);
    }
    // 误报率也不该被长尾推高（名义 5%，120 次抽样噪声约 ±2 个点）
    for (const t of R.tail) {
      expect(t.falseSigRaw).toBeLessThan(0.1);
    }
  });

  it('长尾让点估计变飘：κ=200 的平均绝对偏差明显高于 κ=1', () => {
    const plain = R.tail.find((t) => t.kappa === 1)!;
    const heavy = R.tail.find((t) => t.kappa === 200)!;
    expect(heavy.biasAbs).toBeGreaterThan(plain.biasAbs * 1.5);
    expect(heavy.mseRaw).toBeGreaterThan(plain.mseRaw * 2);
  });

  it('截尾确实降 MSE，但代价是区间不再覆盖 ARPU 差（这条锁住「不能当第二次检验」）', () => {
    const heavy = R.tail.find((t) => t.kappa === 200)!;
    expect(heavy.mseTrim).toBeLessThan(heavy.mseRaw * 0.6);
    expect(heavy.coverTrim).toBeLessThan(0.5);
    // 干净数据（κ=1）上截尾也是纯亏：覆盖率照样掉
    const plain = R.tail.find((t) => t.kappa === 1)!;
    expect(plain.coverTrim).toBeLessThan(plain.coverRaw);
  });

  it('「截尾后更显著」是换假设换来的：检出率涨的同时覆盖率塌', () => {
    const heavy = R.power.find((p) => p.kappa === 200)!;
    expect(heavy.detectTrim).toBeGreaterThan(heavy.detectRaw);
    expect(heavy.coverTrim).toBeLessThan(0.5);
  });

  it('粒度决定截尾有没有用：每行一个人 ≫ 每行 5 个人 ≫ 每行 50 个人', () => {
    const [user, five, fifty] = R.granularity;
    expect(user.biasGain).toBeGreaterThan(five.biasGain);
    expect(five.biasGain).toBeGreaterThanOrEqual(fifty.biasGain);
    expect(user.biasGain).toBeGreaterThan(0.3);
    expect(fifty.biasGain).toBeLessThan(0.2);
  });

  it('同参数两次运行逐位相同（除生成时间）', () => {
    const a = runRobustReport(30, 300);
    const b = runRobustReport(30, 300);
    expect({ ...a, generatedAt: '' }).toEqual({ ...b, generatedAt: '' });
  });

  it('仓库里提交的 data/robust_report.json 也满足这些方向（防止只改数据不改代码）', () => {
    const json = JSON.parse(readFileSync('data/robust_report.json', 'utf8')) as typeof R;
    expect(json.tail.length).toBe(4);
    for (const t of json.tail) expect(t.coverRaw).toBeGreaterThan(0.9);
    const heavy = json.tail.find((t) => t.kappa === 200)!;
    expect(heavy.coverTrim).toBeLessThan(0.5);
    expect(json.granularity[0].biasGain).toBeGreaterThan(json.granularity[2].biasGain);
  });
});
