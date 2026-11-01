import type { Analysis } from './decide.ts';
import type { Experiment } from './types.ts';

/**
 * 可比较性判定（F3）。
 *
 * 对比视图最容易犯的错，是「把两个数字并排放就叫对比」。真正决定
 * 「谁的效应大」这句话能不能说，只有一条硬约束和几条解释性约束：
 *
 * ① **同单位**。pp 与元不可通约——这是唯一一条会**改变画法**的约束
 *    （不给同轴，各画一张），所以它是 `block`。
 * ② **同指标**。单位一样但指标不同（转化率 vs 付费率），可以同轴看效应大小，
 *    但「A 比 B 好」不成立，所以是 `warn`。
 * ③ **观察期 / 分流比例**：它们直接决定置信区间的宽度，也就决定「谁更不确定」，
 *    是 `warn`。
 *
 * 刻意**不**把实验的 `archetype` 拿来比较：那是数据生成时注入的场景标签
 * （正向/负向/异质/护栏恶化…），不是实验设计类别。拿它当「两类实验不可比」
 * 的理由是范畴错误——真实导入的数据里这个字段根本无从得知。
 *
 * 也不给每种差异编权重、算一个「可比性得分」：那个分数没有理论依据，
 * 只会让人以为「得分 0.72 所以大致能比」。列表就是列表。
 */
export type CompareLevel = 'block' | 'warn';

export interface CompareIssue {
  level: CompareLevel;
  /** 稳定标识，供 UI 与测试断言，不随文案改动而变 */
  code: 'UNIT' | 'METRIC' | 'DAYS' | 'SPLIT';
  text: string;
}

export interface Comparability {
  /** 是否共用一条横轴（= 单位一致）。false 时两张图必须各画各的 */
  sharedAxis: boolean;
  issues: CompareIssue[];
  /** 存在 block 级问题：此时「谁的效应大」这句话整体不成立 */
  incompatible: boolean;
}

/** 观察期天数：取新颖效应序列的长度（数据不足时为 0，此时不参与比较） */
export function observedDays(an: Analysis): number {
  if (an.novelty.skipped) return 0;
  return new Set(an.novelty.points.map((p) => p.date)).size;
}

export function compareExperiments(
  a: Experiment,
  aa: Analysis,
  b: Experiment,
  ab: Analysis,
): Comparability {
  const issues: CompareIssue[] = [];
  const sameUnit = aa.primary.unit === ab.primary.unit;

  if (!sameUnit) {
    issues.push({
      level: 'block',
      code: 'UNIT',
      text: `主指标单位不同（${aa.primary.unit} vs ${ab.primary.unit}），不能画在同一条轴上——差值一个是百分点、一个是元，叠在一起比长短没有意义`,
    });
  } else if (aa.primary.label !== ab.primary.label) {
    issues.push({
      level: 'warn',
      code: 'METRIC',
      text: `主指标不同（${aa.primary.label} vs ${ab.primary.label}）：单位一样可以同轴看效应大小，但这是两个指标，不能互相替代`,
    });
  }

  const daysA = observedDays(aa);
  const daysB = observedDays(ab);
  // 任一侧数据不足（0 天）时这条不成立：没有天数就没有「天数不同」这回事
  if (daysA > 0 && daysB > 0 && daysA !== daysB) {
    issues.push({
      level: 'warn',
      code: 'DAYS',
      text: `观察期长度不同（${daysA} 天 vs ${daysB} 天），后者的置信区间天然更窄`,
    });
  }

  if (a.trafficSplit !== b.trafficSplit) {
    issues.push({
      level: 'warn',
      code: 'SPLIT',
      text: `分流比例不同（${a.trafficSplit} vs ${b.trafficSplit}），同等曝光下两边的样本效率不一样`,
    });
  }

  return {
    sharedAxis: sameUnit,
    issues,
    incompatible: issues.some((i) => i.level === 'block'),
  };
}
