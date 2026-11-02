/**
 * 多臂证据脚本的自检。
 *
 * 为什么脚本也要单测：`docs/` 与 README 里的「Dunnett 把误报率控在 α」这类断言
 * 都是从这份 JSON 抄过去的。脚本悄悄跑坏（比如把 ρ 传成 0、把临界值算错），
 * 文档就会跟着变成假话，而且没有任何测试会红。
 */
import { describe, expect, it } from 'vitest';
import { runMultiArmReport } from '../scripts/multiarm_report.ts';

const report = runMultiArmReport(4000, 20260301);

describe('全零族误报率', () => {
  it('naive 随臂数增长，且接近「独立」公式的下界（相关性会让它略低）', () => {
    const byArms = new Map(report.fwer.map((f) => [f.arms, f]));
    expect(byArms.get(2)!.naive).toBeLessThan(0.08);
    // 3 臂 naive 应该在 9%~10.5% 之间：理论 9.75%，ρ=0.5 会略微压低
    expect(byArms.get(3)!.naive).toBeGreaterThan(0.085);
    expect(byArms.get(3)!.naive).toBeLessThan(0.105);
    // 臂越多越容易误报
    expect(byArms.get(4)!.naive).toBeGreaterThan(byArms.get(3)!.naive);
    expect(byArms.get(5)!.naive).toBeGreaterThan(byArms.get(4)!.naive);
  });

  it('Dunnett 在每一档臂数下都把误报率控在 α 附近（±1.5 个点，4000 次模拟的抽样误差）', () => {
    for (const f of report.fwer) {
      expect(f.dunnett).toBeGreaterThan(0.035);
      expect(f.dunnett).toBeLessThan(0.065);
    }
  });

  it('Dunnett 的临界值永远比 Bonferroni 小（这就是「用上相关性」省下的那部分）', () => {
    for (const f of report.fwer.filter((x) => x.comparisons > 1)) {
      expect(f.crit).toBeLessThan(f.bonferroniCrit);
      // 2 臂时两者退化为同一个双侧 z
      expect(f.bonferroniCrit - f.crit).toBeLessThan(0.06);
    }
  });
});

describe('赢家识别与赢家诅咒', () => {
  it('效应越大越容易挑对，且全零时挑最大是抛硬币', () => {
    const at = (lift: number) => report.selection.find((s) => s.lift === lift)!;
    expect(at(0).pickMaxPoint).toBeGreaterThan(0.42);
    expect(at(0).pickMaxPoint).toBeLessThan(0.58);
    expect(at(0.05).pickMaxPoint).toBeLessThan(at(0.1).pickMaxPoint);
    expect(at(0.1).pickMaxPoint).toBeLessThan(at(0.2).pickMaxPoint);
    expect(at(0.2).pickMaxPoint).toBeGreaterThan(0.97);
  });

  it('「校正后显著才挑」在零效应下几乎不乱挑（≤3%），代价是小效应时经常说不出话', () => {
    const at = (lift: number) => report.selection.find((s) => s.lift === lift)!;
    expect(at(0).pickMaxSignificant).toBeLessThan(0.03);
    // 5% 提升在 8000/臂 下功效不高，所以「敢下结论」的比例明显低于「挑对」的比例
    expect(at(0.05).pickMaxSignificant).toBeLessThan(at(0.05).pickMaxPoint / 2);
  });

  it('赢家诅咒的量级非零但很小（n=8000 时约 0.1pp），不是夸张的大数', () => {
    const curse = report.selection.find((s) => s.cursePP !== null)!.cursePP!;
    expect(curse).toBeGreaterThan(0.02);
    expect(curse).toBeLessThan(0.4);
  });
});

describe('P(best) 的读数纪律', () => {
  it('全零族下平均置信度仍然很高（≈70%），所以它不能单独当证据', () => {
    expect(report.nullMaxProb).toBeGreaterThan(0.6);
    expect(report.nullMaxProb).toBeLessThan(0.8);
  });

  it('有真实效应时偏保守（置信度 ≤ 实际命中率），且效应越大越接近', () => {
    for (const c of report.calibration) {
      expect(c.stated).toBeLessThanOrEqual(c.actual + 1e-9);
    }
    const near = report.calibration.find((c) => c.lift === 0.05)!;
    const strong = report.calibration.find((c) => c.lift === 0.2)!;
    expect(Math.abs(strong.stated - strong.actual)).toBeLessThan(Math.abs(near.stated - near.actual) + 0.2);
  });
});

describe('可复现', () => {
  it('同 seed 两次运行逐位相同（否则文档里的数字无法核验）', () => {
    const again = runMultiArmReport(4000, 20260301);
    expect(JSON.stringify(again.fwer)).toEqual(JSON.stringify(report.fwer));
    expect(JSON.stringify(again.selection)).toEqual(JSON.stringify(report.selection));
  });
});
