import { describe, expect, it } from 'vitest';
import {
  CAVEAT,
  concentrationOf,
  leverageRows,
  robustnessReport,
  winsorizeCells,
  type RobustCell,
} from '../src/lib/robust.ts';
import { ratioTest } from '../src/lib/stats.ts';

/** 造一行：n 次曝光、sum 元收入 */
const c = (n: number, sum: number, treatment: boolean, label?: string): RobustCell => ({
  n,
  sum,
  treatment,
  label,
});

/** 造一组「每格 n 人、人均 arpu」的行 */
const arm = (arpus: number[], treatment: boolean, n = 100): RobustCell[] =>
  arpus.map((a, i) => c(n, a * n, treatment, `D${String(i + 1).padStart(2, '0')}`));

const steady = [5.0, 5.2, 4.8, 5.1, 4.9, 5.3, 4.7, 5.05, 4.95, 5.0];

describe('winsorizeCells', () => {
  it('截尾 0 档必须是逐位无操作（否则敏感性曲线第一档就不是原始口径）', () => {
    const cells = [...arm(steady, false), ...arm(steady.map((v) => v + 0.5), true)];
    const w = winsorizeCells(cells, 0, 0);
    const before = ratioTest(cells)!;
    const after = ratioTest(w.cells)!;
    // 顺序会变（对照在前），所以比检验结果与逐行金额，而不比数组顺序
    expect(after).toEqual(before);
    expect(w.control.clippedHigh).toBe(0);
    expect(w.control.revenueAfter).toBeCloseTo(w.control.revenueBefore, 10);
    expect(w.treatment.revenueAfter).toBeCloseTo(w.treatment.revenueBefore, 10);
  });

  it('上界截尾把最高的那一行压到分位线，且只压这一行', () => {
    // 人均 1..10 各一格：type-7 在 q=0.9 处 = 9 + 0.1×(10−9) = 9.1
    const cells = arm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true);
    const w = winsorizeCells(cells, 0, 0.1);
    expect(w.treatment.upper).toBeCloseTo(9.1, 10);
    expect(w.treatment.clippedHigh).toBe(1);
    expect(w.treatment.clippedLow).toBe(0);
    // 被压的那一行金额 = 9.1 × 100
    const maxSum = Math.max(...w.cells.map((x) => x.sum));
    expect(maxSum).toBeCloseTo(910, 6);
    // 总收入只能变少
    expect(w.treatment.revenueAfter).toBeLessThan(w.treatment.revenueBefore);
  });

  it('两臂各自定分位线（处理臂的长尾不会顺手截掉对照臂）', () => {
    const cells = [...arm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false), ...arm([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], true)];
    const w = winsorizeCells(cells, 0, 0.1);
    expect(w.control.upper).toBeCloseTo(9.1, 10);
    expect(w.treatment.upper).toBeCloseTo(910, 10);
    expect(w.control.clippedHigh).toBe(1);
    expect(w.treatment.clippedHigh).toBe(1);
  });

  it('下界默认关闭：ARPU 的左尾是「没买」的合法值，截掉它等于假装所有人都买了', () => {
    // 人均 0..9：q=0.1 落在第 1.9 位 ≈ 0.9，于是人均 0 的那一格被抬到 0.9
    const cells = arm([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], true);
    const off = winsorizeCells(cells, 0, 0.1);
    expect(off.treatment.clippedLow).toBe(0);
    // 显式打开下界才会动左尾
    const on = winsorizeCells(cells, 0.1, 0);
    expect(on.treatment.clippedLow).toBe(1);
    expect(on.treatment.lower).toBeCloseTo(0.9, 10);
    expect(on.treatment.revenueAfter).toBeGreaterThan(on.treatment.revenueBefore);
  });

  it('截尾比例越大保留的收入越少（单调不增）', () => {
    const cells = [...arm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false), ...arm([2, 3, 4, 5, 6, 7, 8, 9, 10, 11], true)];
    let prev = Infinity;
    for (const p of [0, 0.005, 0.01, 0.1, 0.2, 1]) {
      const w = winsorizeCells(cells, 0, p);
      const kept = w.control.revenueAfter + w.treatment.revenueAfter;
      expect(kept).toBeLessThanOrEqual(prev + 1e-9);
      prev = kept;
    }
  });

  it('p=1 时除最小那一行外全部被压平', () => {
    const cells = arm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true);
    const w = winsorizeCells(cells, 0, 1);
    expect(w.treatment.upper).toBeCloseTo(1, 10);
    expect(w.treatment.clippedHigh).toBe(9);
  });

  it('曝光触及比例报出「刚刚压平了多少流量」', () => {
    const cells = arm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true, 100);
    const w = winsorizeCells(cells, 0, 0.1);
    expect(w.treatment.touchedExposures).toBe(100);
    expect(w.treatment.exposureTouchedShare).toBeCloseTo(0.1, 10);
  });
});

describe('concentrationOf', () => {
  it('人人等额时 Gini 为 0、前 1% 曝光恰好贡献 1% 收入、付费率 100%', () => {
    const cells = Array.from({ length: 100 }, () => c(1, 5, true));
    const r = concentrationOf(cells);
    expect(r.gini).toBeCloseTo(0, 10);
    expect(r.payerShare).toBe(1);
    // 均匀分布下「前 1% 曝光」就贡献 1% 收入 —— 这个基准正是判读集中度的标尺
    expect(r.top[0].revenueShare).toBeCloseTo(0.01, 10);
    expect(r.totalRevenue).toBeCloseTo(500, 10);
  });

  it('一个用户吃掉九成收入时 Gini 升高、前 1% 占比≈91%', () => {
    const cells = [...Array.from({ length: 99 }, () => c(1, 1, true)), c(1, 1000, true)];
    const r = concentrationOf(cells);
    expect(r.top[0].revenueShare).toBeCloseTo(1000 / 1099, 6);
    expect(r.gini).toBeGreaterThan(0.8);
    // 前 pct 越大，累计收入占比只能变大
    expect(r.top[1].revenueShare).toBeGreaterThanOrEqual(r.top[0].revenueShare);
    expect(r.top[2].revenueShare).toBeGreaterThanOrEqual(r.top[1].revenueShare);
  });

  it('付费率只数有收入的那部分曝光', () => {
    const cells = [...Array.from({ length: 90 }, () => c(1, 0, true)), ...Array.from({ length: 10 }, () => c(1, 20, true))];
    expect(concentrationOf(cells).payerShare).toBeCloseTo(0.1, 10);
  });

  it('没有收入时返回零值而不是 NaN', () => {
    const r = concentrationOf([c(100, 0, true), c(100, 0, false)]);
    expect(r.gini).toBe(0);
    expect(r.top).toEqual([]);
    expect(r.totalRevenue).toBe(0);
  });
});

describe('leverageRows', () => {
  it('删掉极端那一行后差值大幅变化，并标出它属于哪一臂', () => {
    const cells = [...arm(Array.from({ length: 10 }, () => 5), false), ...arm([...Array.from({ length: 9 }, () => 5.5), 55], true)];
    const rows = leverageRows(cells, 3);
    expect(rows.length).toBeGreaterThan(0);
    const top = rows[0];
    expect(top.arm).toBe('treatment');
    expect(top.arpu).toBeCloseTo(55, 6);
    // 删掉这行以后处理臂 ARPU 掉回 5.5，差值也就掉下来
    expect(top.dDiff).toBeLessThan(0);
    expect(top.diffWithout).toBeLessThan(1);
  });

  it('对称数据上没有一行能撬动结论方向（删掉任何一格差值都还那么大）', () => {
    const cells = [...arm(steady, false), ...arm(steady.map((v) => v + 0.5), true)];
    const diff = ratioTest(cells)!.diff;
    const rows = leverageRows(cells, 3);
    for (const r of rows) {
      // 删一格最多让差值挪 1/(k−1) 量级，掀不翻方向，也改不了量级
      expect(Math.sign(r.diffWithout)).toBe(Math.sign(diff));
      expect(Math.abs(r.dDiff)).toBeLessThan(Math.abs(diff) / 5);
    }
  });

  it('行数不足两臂各 2 时返回空（算不出检验就别说杠杆）', () => {
    expect(leverageRows([c(100, 500, false), c(100, 500, true)], 3)).toEqual([]);
  });
});

describe('robustnessReport', () => {
  it('两臂分布相近时判「稳定」，且给出原始口径为第一档', () => {
    const cells = [...arm(steady, false), ...arm(steady.map((v) => v + 0.5), true)];
    const r = robustnessReport(cells);
    expect(r.verdict).toBe('stable');
    expect(r.grid[0].p).toBe(0);
    expect(r.grid[0].diff).toBeCloseTo(ratioTest(cells)!.diff, 10);
    expect(r.reason).toContain('没有变化');
    expect(r.caveat).toBe(CAVEAT);
  });

  it('结论靠一行撑起来时判「符号翻转」并说清从多少变到多少', () => {
    // 对照臂 9 格人均 10 + 1 格人均 1000 → 看起来对照更好；截掉最高 5% 后反过来
    const cells = [...arm([...Array.from({ length: 9 }, () => 10), 1000], false), ...arm(Array.from({ length: 10 }, () => 100), true)];
    const r = robustnessReport(cells);
    expect(r.verdict).toBe('flip');
    expect(r.reason).toContain('符号翻转');
    expect(r.grid[0].diff).toBeLessThan(0);
    expect(r.grid[r.grid.length - 1].diff).toBeGreaterThan(0);
    expect(r.maxAbsChange).toBeGreaterThan(1);
  });

  it('每臂格子太少时判「不可用」并说明原因（不静默隐藏）', () => {
    const r = robustnessReport([c(100, 500, false), c(100, 550, true)]);
    expect(r.verdict).toBe('unavailable');
    expect(r.reason).toContain('不足');
    expect(r.grid).toEqual([]);
  });

  it('粒度判断：每行就是一个人 → user；每行上千曝光 → cell', () => {
    const user = robustnessReport([...arm([5, 5, 6, 4, 5, 5, 6], false, 1), ...arm([5, 6, 6, 5, 6, 5, 6], true, 1)]);
    expect(user.granularity).toBe('user');
    const cell = robustnessReport([...arm(steady, false), ...arm(steady, true)]);
    expect(cell.granularity).toBe('cell');
    expect(cell.medianExposuresPerRow).toBe(100);
  });

  it('同输入两次结果逐位相同（敏感性曲线不能靠随机）', () => {
    const cells = [...arm(steady, false), ...arm([...steady.slice(1), 40], true)];
    expect(robustnessReport(cells)).toEqual(robustnessReport(cells));
  });

  it('参考档位给出各臂截尾统计，未截尾的臂保留原收入', () => {
    const cells = [...arm([4, 5, 6, 5, 5, 5], false), ...arm([5, 5, 5, 5, 5, 90], true)];
    const r = robustnessReport(cells);
    expect(r.arms.treatment.revenueBefore).toBeCloseTo(11500, 6);
    expect(r.arms.treatment.clippedHigh).toBeGreaterThan(0);
    expect(r.arms.treatment.revenueAfter).toBeLessThan(r.arms.treatment.revenueBefore);
    expect(r.leverage.length).toBeGreaterThan(0);
  });
});
