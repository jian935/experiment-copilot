/**
 * 期望损失决策的证据产出（B1）。
 *
 * 这块最容易变成"看起来很高级其实没用"，所以必须用**合成数据的真值**来算总账：
 *   120 个实验都有注入的真实效应（trueLiftOverall），于是可以对几种策略算
 *   **事后真实净价值**（拿真值直接算，不是期望值）：
 *
 *     策略 A：全部上线        —— 上限基准（什么都上）
 *     策略 B：全部不上线      —— 下限基准（什么都不上，净价值恒 0）
 *     策略 C：频率派规则（本项目 decision：主指标显著 + 护栏 + SRM）
 *     策略 D：期望损失**裸规则**（只有主指标净价值，忽略门禁）
 *     策略 E：期望损失**两层**（硬门禁否决 + 净价值）← 本文件真正推荐的形态
 *
 * 净价值 = max(0,Δ) − k·max(0,−Δ) − MMP（Δ 取真值），**越高越好**。
 *
 * 为什么必须有 D 这一档：D 的净价值大概率比 E 高，因为它的价值函数只记主指标、
 * 而 guardrail 原型恰好是"主指标真的涨了 1.8pp、退款率翻倍"。D 会为了这点涨去上线它。
 * 所以 D 与 E 的差额不是"E 更保守"，而是**D 漏记了另一套货币的账**——
 * 这一条必须在报告里被数字看见，而不是靠嘴说。
 *
 * 另外单独跑一组**成本敏感性**：把 k_负 从 0.5 扫到 5，看策略 E 的推荐动作怎么变。
 * 这一组是为了说明"结论依赖成本参数"，不是"引擎有个正确答案"。
 *
 * 用法：
 *   npm run loss                 # 写 data/loss_report.json
 *   npm run loss -- --dry        # 只打印（CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { applyGates, defaultLoss, expectedLoss, type LossAction, type LossParams } from '../src/lib/loss.ts';
import type { DailyRow, Dataset } from '../src/lib/types.ts';

export interface PolicyRow {
  id: string;
  archetype: string;
  unit: 'pp' | '元';
  diff: number;
  se: number;
  p: number;
  trueEffect: number;
  decision: string;
  reasonCode: string;
  /** 裸规则（忽略门禁）的动作 */
  rawAction: LossAction;
  /** 两层合并后的动作 */
  gatedAction: LossAction;
  vetoCode: string | null;
  vetoReason: string | null;
  /** 事后真实净价值（按同一套成本参数；越高越好） */
  lossA: number;
  lossB: number;
  lossC: number;
  lossD: number;
  lossE: number;
}

export interface PolicyTotals {
  /** 单位：效应量当量（率指标 = pp，ARPU = 元），按实验汇总；越高越好 */
  all: number;
  none: number;
  frequentist: number;
  /** 裸期望损失规则 */
  expectedLoss: number;
  /** 硬门禁 + 净价值 */
  expectedLossGated: number;
  /** 相对频率派规则的提升（正 = 期望损失决策更好） */
  improvementVsFrequentist: number;
  improvementVsFrequentistGated: number;
  /** 各自的上线次数 */
  shipCount: { all: number; none: number; frequentist: number; expectedLoss: number; expectedLossGated: number };
  /** 判成「无差别」的条数（期望损失口径特有） */
  indifferent: number;
  /** 被硬门禁改写的条数 */
  vetoed: number;
  /**
   * 裸规则为了主指标收益而上线的、护栏已恶化的实验数。
   * 这个数字是 D 与 E 差额的解释，必须单独出现，不能只体现在总净价值里。
   */
  rawShipsGuardrailBroken: number;
}

export interface Sensitivity {
  ratio: number;
  shipCount: number;
  loss: number;
}

/**
 * 按主指标单位分组的汇总。
 *
 * 为什么必须拆：pp 与元**不可通约**，把两种单位相加得到的"总净价值"虽然算得出来，
 * 但没有业务含义，而且总值几乎全由 ARPU 实验（一单就是 0.5 元量级）撑起，
 * 会让人误以为率指标的改善微不足道。所以对外只引用分组数字，总额仅作排序参考。
 */
export interface UnitSlice {
  unit: 'pp' | '元';
  n: number;
  all: number;
  frequentist: number;
  expectedLoss: number;
  expectedLossGated: number;
  ship: { frequentist: number; expectedLoss: number; expectedLossGated: number };
}

/**
 * 裸规则漏记的那部分账，用数据本身量出来（不拍汇率）。
 *
 * 只对 guardrail 原型做描述统计：两臂的退款率 / 投诉率各是多少。
 * 刻意**不**把退款折成元再和主指标收益相减——那等于给"用户信任"标了个价，
 * 一旦这个价足够便宜，PM 就会去交易它。这就是"护栏是约束不是目标"的实操理由。
 */
export interface GuardrailDamage {
  expCount: number;
  controlRefund: number;
  treatmentRefund: number;
  controlComplaint: number;
  treatmentComplaint: number;
}

export interface LossReportFile {
  generatedAt: string;
  seedBase: number;
  params: LossParams;
  totals: PolicyTotals;
  sensitivity: Sensitivity[];
  /** 按主指标单位分组的汇总（pp 与元不可通约，对外只引用这一份） */
  byUnit: UnitSlice[];
  /** 裸规则漏记的那部分账（护栏原型的实际恶化幅度） */
  guardrailDamage: GuardrailDamage;
  /** 两种口径不一致的实验（给文档举例） */
  disagreements: PolicyRow[];
  /** 被门禁改写的实验（给文档举例） */
  vetoes: PolicyRow[];
}

/** 事后真实净价值：拿注入的真值直接算，不用后验（越高越好） */
export function realizedValue(trueEffect: number, action: 'ship' | 'no-ship', params: LossParams): number {
  if (action === 'no-ship') return 0;
  return Math.max(0, trueEffect) - params.riskAversion * Math.max(0, -trueEffect) - params.mmp;
}

/**
 * 把注入真值换成**该实验主指标自己的单位**再进价值函数。
 *
 * 数据里 `trueLiftOverall` 是**转化率的绝对提升（pp）**；ARPU 实验的主指标是「元」，
 * 直接拿 pp 当元用会把它低估一个量级（ARPU 约 2–3 元，pp 的真值 0.018 换算后是 1 元上下）。
 * 换算走数据自带的 `trueRpuLift`（相对提升）× 对照 ARPU，而不是另拍一个数。
 */
export function truthInUnit(
  unit: 'pp' | '元',
  trueLiftOverall: number,
  trueRpuLift: number | undefined,
  controlArpu: number,
): number {
  if (unit === 'pp') return trueLiftOverall;
  // 没有收入字段（退回率口径）的实验走这里，unit 一定是 pp，不会到这一支
  if (trueRpuLift === undefined) return trueLiftOverall;
  return trueRpuLift * controlArpu;
}

export function runLossReport(datasetPath = 'data/experiments.json'): LossReportFile {
  const ds: Dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const byExp = new Map<string, DailyRow[]>();
  for (const r of ds.daily) {
    const l = byExp.get(r.expId);
    if (l) l.push(r);
    else byExp.set(r.expId, [r]);
  }

  const rows: PolicyRow[] = [];
  let params = defaultLoss('pp');
  for (const e of ds.experiments) {
    const a = analyze(e, byExp.get(e.id) ?? []);
    const p = defaultLoss(a.primary.unit);
    if (a.primary.unit === 'pp') params = p;
    const loss = expectedLoss(a.primary.diff, a.primary.se, a.primary.unit, p);
    const gated = applyGates(loss.action, a.reasonCode);
    // 真值必须换成主指标自己的单位，否则 ARPU 实验会被按 pp 记账（低估一个量级）
    const truth = truthInUnit(a.primary.unit, e.trueLiftOverall, e.trueRpuLift, a.primary.controlValue);
    // 「无差别」按保守处理：算作不上线（想上线得先有证据）
    const actC: 'ship' | 'no-ship' = a.decision === 'ship' ? 'ship' : 'no-ship';
    const actD: 'ship' | 'no-ship' = loss.action === 'ship' ? 'ship' : 'no-ship';
    const actE: 'ship' | 'no-ship' = gated.action === 'ship' ? 'ship' : 'no-ship';
    rows.push({
      id: e.id,
      archetype: e.archetype,
      unit: a.primary.unit,
      diff: a.primary.diff,
      se: a.primary.se,
      p: a.primary.p,
      trueEffect: truth,
      decision: a.decision,
      reasonCode: a.reasonCode,
      rawAction: loss.action,
      gatedAction: gated.action,
      vetoCode: gated.vetoCode,
      vetoReason: gated.vetoReason,
      lossA: realizedValue(truth, 'ship', p),
      lossB: realizedValue(truth, 'no-ship', p),
      lossC: realizedValue(truth, actC, p),
      lossD: realizedValue(truth, actD, p),
      lossE: realizedValue(truth, actE, p),
    });
  }

  const sum = (f: (r: PolicyRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const freq = sum((r) => r.lossC);
  const raw = sum((r) => r.lossD);
  const gated = sum((r) => r.lossE);

  // 护栏原型的实际恶化幅度：直接从明细算两臂的率，不引用引擎判定
  const gIds = new Set(ds.experiments.filter((e) => e.archetype === 'guardrail').map((e) => e.id));
  const gAgg = { cn: 0, cr: 0, cc: 0, tn: 0, tr: 0, tc: 0 };
  for (const r of ds.daily) {
    if (!gIds.has(r.expId)) continue;
    if (r.variant === 'control') {
      gAgg.cn += r.exposures;
      gAgg.cr += r.refunds;
      gAgg.cc += r.complaints;
    } else {
      gAgg.tn += r.exposures;
      gAgg.tr += r.refunds;
      gAgg.tc += r.complaints;
    }
  }
  const guardrailDamage: GuardrailDamage = {
    expCount: gIds.size,
    controlRefund: gAgg.cn ? gAgg.cr / gAgg.cn : 0,
    treatmentRefund: gAgg.tn ? gAgg.tr / gAgg.tn : 0,
    controlComplaint: gAgg.cn ? gAgg.cc / gAgg.cn : 0,
    treatmentComplaint: gAgg.tn ? gAgg.tc / gAgg.tn : 0,
  };

  // 成本敏感性：只改风险厌恶系数 k（0.5 表示"更愿意冒险"），看上线数与真实净价值怎么变。
  // 注意每行要按自己的 unit 取默认 MMP，否则 ARPU 行会被按 pp 的 0.001 元门槛判（几乎全上线）。
  const sensitivity: Sensitivity[] = [];
  for (const ratio of [0.5, 1, 1.5, 2, 3, 5]) {
    let ships = 0;
    let total = 0;
    for (const r of rows) {
      const p: LossParams = { ...defaultLoss(r.unit), riskAversion: ratio };
      const l = expectedLoss(r.diff, r.se, r.unit, p);
      const act = applyGates(l.action, r.reasonCode).action === 'ship' ? 'ship' : 'no-ship';
      if (act === 'ship') ships++;
      total += realizedValue(r.trueEffect, act, p);
    }
    sensitivity.push({ ratio, shipCount: ships, loss: total });
  }

  // 按主指标单位分组（pp 与元不可通约，分组才是对外可引用的口径）
  const byUnit: UnitSlice[] = (['pp', '元'] as const).map((u) => {
    const g = rows.filter((r) => r.unit === u);
    const s = (f: (r: PolicyRow) => number) => g.reduce((acc, r) => acc + f(r), 0);
    return {
      unit: u,
      n: g.length,
      all: s((r) => r.lossA),
      frequentist: s((r) => r.lossC),
      expectedLoss: s((r) => r.lossD),
      expectedLossGated: s((r) => r.lossE),
      ship: {
        frequentist: g.filter((r) => r.decision === 'ship').length,
        expectedLoss: g.filter((r) => r.rawAction === 'ship').length,
        expectedLossGated: g.filter((r) => r.gatedAction === 'ship').length,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    seedBase: ds.seedBase,
    params,
    totals: {
      all: sum((r) => r.lossA),
      none: sum((r) => r.lossB),
      frequentist: freq,
      expectedLoss: raw,
      expectedLossGated: gated,
      // 净价值口径下越高越好，所以提升 = 期望损失决策 − 频率派
      improvementVsFrequentist: raw - freq,
      improvementVsFrequentistGated: gated - freq,
      shipCount: {
        all: rows.length,
        none: 0,
        frequentist: rows.filter((r) => r.decision === 'ship').length,
        expectedLoss: rows.filter((r) => r.rawAction === 'ship').length,
        expectedLossGated: rows.filter((r) => r.gatedAction === 'ship').length,
      },
      indifferent: rows.filter((r) => r.rawAction === 'indistinguishable').length,
      vetoed: rows.filter((r) => r.vetoCode !== null).length,
      rawShipsGuardrailBroken: rows.filter((r) => r.reasonCode === 'GUARDRAIL' && r.rawAction === 'ship').length,
    },
    sensitivity,
    byUnit,
    guardrailDamage,
    disagreements: rows
      .filter((r) => (r.decision === 'ship') !== (r.gatedAction === 'ship'))
      .slice(0, 10),
    vetoes: rows.filter((r) => r.vetoCode !== null).slice(0, 12),
  };
}

const isDirect = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/loss_report.ts');

if (isDirect) {
  const dry = process.argv.includes('--dry');
  const t0 = Date.now();
  const r = runLossReport();
  const json = `${JSON.stringify(r, null, 2)}\n`;
  if (!dry) {
    writeFileSync('data/loss_report.json', json);
    try {
      writeFileSync('public/data/loss_report.json', json);
    } catch {
      console.log('（public/data/ 不存在，跳过前端副本）');
    }
  }
  const t = r.totals;
  const f = (v: number) => v.toFixed(3);
  console.log(
    `\n事后真实净价值（120 个实验，k_负=${r.params.riskAversion} / MMP=0.1pp（率）· 0.02元（ARPU）；越高越好）`,
  );
  console.log('─'.repeat(82));
  console.log(`  A 全部上线              ${f(t.all).padStart(8)}   （上线 ${t.shipCount.all} 个）`);
  console.log(`  B 全部不上线            ${f(t.none).padStart(8)}   （上线 0 个）`);
  console.log(`  C 频率派规则            ${f(t.frequentist).padStart(8)}   （上线 ${t.shipCount.frequentist} 个）← 当前引擎 decision`);
  console.log(`  D 期望损失·裸规则       ${f(t.expectedLoss).padStart(8)}   （上线 ${t.shipCount.expectedLoss} 个）← 只记主指标的账`);
  console.log(
    `  E 期望损失·门禁+净价值  ${f(t.expectedLossGated).padStart(8)}   （上线 ${t.shipCount.expectedLossGated} 个，门禁改写 ${t.vetoed} 个）← 推荐形态`,
  );

  const pct = (d: number, base: number) => `${((Math.abs(d) / Math.max(Math.abs(base), 1e-9)) * 100).toFixed(1)}%`;
  console.log(
    `\n  E 相对 C ${t.improvementVsFrequentistGated >= 0 ? '多拿' : '少拿'} ${f(Math.abs(t.improvementVsFrequentistGated))}（${pct(t.improvementVsFrequentistGated, t.frequentist)}）`,
  );
  console.log(
    `  D 相对 C ${t.improvementVsFrequentist >= 0 ? '多拿' : '少拿'} ${f(Math.abs(t.improvementVsFrequentist))}（${pct(t.improvementVsFrequentist, t.frequentist)}）`,
  );
  console.log(
    `  ⚠️  D 的 ${f(t.expectedLoss - t.expectedLossGated)} 差额里，有 ${t.rawShipsGuardrailBroken} 个实验是"护栏已恶化、裸规则仍判上线"`,
  );
  console.log('      → D 不是更激进，是漏记了另一套货币的账（退款率 / 投诉率 / 延迟）');
  const gd = r.guardrailDamage;
  if (gd.expCount) {
    const pp = (v: number) => `${(v * 100).toFixed(2)}%`;
    console.log(
      `      这些实验（${gd.expCount} 个 guardrail 原型）的实际恶化：退款率 ${pp(gd.controlRefund)} → ${pp(gd.treatmentRefund)}（${(gd.treatmentRefund / Math.max(gd.controlRefund, 1e-9)).toFixed(2)}×），投诉率 ${pp(gd.controlComplaint)} → ${pp(gd.treatmentComplaint)}`,
    );
  }
  console.log(`  参照：全上 ${f(t.all)} / 全不上 ${f(t.none)} —— 任何策略都不该比这两个更差`);

  console.log('\n  按主指标单位拆开（pp 与元不可通约，这份才是能对外引用的数字）');
  console.log('  ' + '─'.repeat(78));
  for (const u of r.byUnit) {
    if (!u.n) continue;
    const unitTxt = u.unit === 'pp' ? 'pp' : '元';
    const relC = (u.expectedLossGated - u.frequentist) / Math.max(Math.abs(u.frequentist), 1e-9);
    console.log(
      `    ${unitTxt.padEnd(2)} n=${String(u.n).padStart(3)}  全上 ${f(u.all).padStart(8)}  C ${f(u.frequentist).padStart(8)}（${String(u.ship.frequentist).padStart(2)} 个）  E ${f(u.expectedLossGated).padStart(8)}（${String(u.ship.expectedLossGated).padStart(2)} 个）  Δ ${(relC * 100 >= 0 ? '+' : '') + (relC * 100).toFixed(1)}%`,
    );
  }

  console.log(`\n成本敏感性（只改 k_负，其余不动；MMP 按各行自己的单位取；口径 = E）`);
  console.log('─'.repeat(82));
  for (const s of r.sensitivity) {
    console.log(`  k_负=${s.ratio.toString().padEnd(4)} 上线 ${String(s.shipCount).padStart(3)} 个  真实净价值 ${f(s.loss)}`);
  }

  if (r.vetoes.length) {
    console.log('\n  被门禁改写的前几条：');
    for (const d of r.vetoes) {
      console.log(
        `    ${d.id} ${d.archetype.padEnd(13)} 裸判 ${d.rawAction.padEnd(18)} → ${d.vetoCode?.padEnd(14)} diff=${d.diff.toFixed(4)} 真值=${d.trueEffect.toFixed(4)}`,
      );
    }
  }
  if (r.disagreements.length) {
    console.log('\n  E 与 C 不一致的例子：');
    for (const d of r.disagreements) {
      console.log(
        `    ${d.id} ${d.archetype.padEnd(13)} ${d.decision.padEnd(12)} → 期望损失判 ${d.gatedAction.padEnd(14)} diff=${d.diff.toFixed(4)} p=${d.p.toExponential(1)} 真值=${d.trueEffect.toFixed(4)}`,
      );
    }
  }
  console.log(`\n  耗时 ${Date.now() - t0}ms → ${dry ? '（--dry，未写文件）' : 'data/loss_report.json'}\n`);
}
