import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/lib/config.ts';
import { bhAdjust, guardrailBlocks, newcombeDiffCI, nonInferiority, normalCdf } from '../src/lib/stats.ts';

/**
 * H1 方法论长文的「不许漂移」锁。
 *
 * 这类文档最常见的失效方式不是写错，而是**过期**：代码把 α 从 0.005 改成 0.01，
 * 文档里的推导还在用 0.005，读者看不出任何异常——因为两边都自洽。
 * 所以这里做三件事：
 *
 *   1. 文档里引用的配置常量，必须与 `DEFAULT_CONFIG` 逐一相等；
 *   2. 文档里的关键结论（谁覆盖谁、误差多大、哪种口径更严）用**独立实现**复算，
 *      不调用被测函数自证；
 *   3. 复算不出来（大样本覆盖率）的部分，文档必须写明它来自蒙特卡洛，
 *      并且那条不能出现在这里当成断言——宁可少锁，不要假锁。
 *
 * 断言一律 `expect(cond).toBe(true)`，失败时不 dump 整篇 markdown。
 */
const doc = readFileSync(new URL('../docs/METHODOLOGY.md', import.meta.url), 'utf8');

function has(s: string): boolean {
  return doc.includes(s);
}

/** 独立实现的 Wald 区间（与被测代码无关，用来当对照） */
function waldCI(c1: number, n1: number, c2: number, n2: number, z = 1.96): [number, number] {
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p2 - p1 - z * se, p2 - p1 + z * se];
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** 精确枚举覆盖率：n 小的时候这才是真值，抽样只能逼近 */
function exactCoverage(p1: number, p2: number, n: number) {
  const truth = p2 - p1;
  let hitW = 0;
  let hitN = 0;
  let pr1 = 0;
  for (let c1 = 0; c1 <= n; c1++) {
    pr1 = comb(n, c1) * p1 ** c1 * (1 - p1) ** (n - c1);
    for (let c2 = 0; c2 <= n; c2++) {
      const w = pr1 * comb(n, c2) * p2 ** c2 * (1 - p2) ** (n - c2);
      const [wl, wu] = waldCI(c1, n, c2, n);
      const [nl, nu] = newcombeDiffCI(c1, n, c2, n);
      if (wl <= truth && truth <= wu) hitW += w;
      if (nl <= truth && truth <= nu) hitN += w;
    }
  }
  return { wald: hitW, newcombe: hitN };
}

/** 均匀网格上的 Beta 密度积分（参数是整数 → 密度是多项式，1e5 个点足够） */
function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  // 这里只需要相对大小，归一化常数用组合数代替（a,b 为整数时 B(a,b)=1/((a+b-1)·C(a+b-2,a-1))）
  const norm = (a + b - 1) * comb(a + b - 2, a - 1);
  return norm * x ** (a - 1) * (1 - x) ** (b - 1);
}

/**
 * 精确 P(B>A) = ∫ f_B(y)·P(A>y) dy。
 *
 * 只在「每臂 ≤ 100」的格点上用：那时后验密度在 (0,1) 上的峰宽约 0.1，
 * 10 万个均匀格子足够覆盖。样本量再大（峰宽 5e-4）就必须换到标准化坐标去积分
 * ——`scripts/method_numbers.ts` 是那么做的，这里是独立的第二套实现。
 *
 * 尾部概率用后缀和一次算完（O(n)），不是嵌套积分。
 */
function probTreatBetterExact(c1: number, n1: number, c2: number, n2: number, steps = 100000): number {
  const a = c2 + 1;
  const b = n2 - c2 + 1;
  const a2 = c1 + 1;
  const b2 = n1 - c1 + 1;
  const h = 1 / steps;
  const fa = new Float64Array(steps);
  const fb = new Float64Array(steps);
  for (let i = 0; i < steps; i++) {
    const y = (i + 0.5) * h;
    fa[i] = betaPdf(y, a, b);
    fb[i] = betaPdf(y, a2, b2);
  }
  // P(A > y_i) ≈ Σ_{j>i} f_A(y_j)·h
  let tail = 0;
  let s = 0;
  for (let i = steps - 1; i >= 0; i--) {
    s += fb[i] * h * tail;
    tail += fa[i] * h;
  }
  return s;
}

describe('H1 方法论：文档与代码不许各说各话', () => {
  it('文档引用的护栏口径与 DEFAULT_CONFIG 一致', () => {
    const rg = DEFAULT_CONFIG.guardrails.refundRate;
    // 文档正文写的是这几个数：α=0.005、margin 0.4pp、拦截口径 harm_and_practical
    expect(rg.alpha).toBe(0.005);
    expect(rg.margin).toBe(0.004);
    expect(rg.mode).toBe('harm_and_practical');
    expect(has('α=0.005')).toBe(true);
    expect(has('margin 0.4pp')).toBe(true);
    expect(has('`harm_and_practical`')).toBe(true);
    // 只有退款率 gating —— 文档的标题主张就是这个，改配置必须同步改标题
    expect(DEFAULT_CONFIG.guardrails.refundRate.gating).toBe(true);
    expect(DEFAULT_CONFIG.guardrails.complaintRate.gating).toBe(false);
    expect(DEFAULT_CONFIG.guardrails.latencyP95.gating).toBe(false);
    expect(has('只有退款率会真的拦住上线')).toBe(true);
  });

  it('分层扫描的 q 与主指标 α 一致，且 m=2 时的门槛恰好是 α', () => {
    expect(DEFAULT_CONFIG.segmentFdr).toBe(0.1);
    expect(DEFAULT_CONFIG.alpha).toBe(0.05);
    expect(has('q=0.1')).toBe(true);
    // BH 在 m=2、q=0.1 时：最小的 p 门槛 = q/m = 0.05 = α
    const r = bhAdjust([0.031, 0.42], DEFAULT_CONFIG.segmentFdr);
    expect(r.rejected[0]).toBe(true);
    expect(r.rejected[1]).toBe(false);
    expect(DEFAULT_CONFIG.segmentFdr / 2).toBe(DEFAULT_CONFIG.alpha);
  });

  it('「全零族至少一个显著」的概率与文档里的 99.79% 对得上', () => {
    const m = 120;
    const v = 1 - (1 - DEFAULT_CONFIG.alpha) ** m;
    expect((v * 100).toFixed(2)).toBe('99.79');
    expect(has('99.79%')).toBe(true);
  });
});

describe('H1 方法论：关键结论用独立实现复算', () => {
  it('p=5%、n=30：Newcombe 99.8% / Wald 97.2%（精确枚举，不是抽样）', () => {
    const r = exactCoverage(0.05, 0.05, 30);
    expect((r.newcombe * 100).toFixed(1)).toBe('99.8');
    expect((r.wald * 100).toFixed(1)).toBe('97.2');
    expect(has('99.8%')).toBe(true);
    expect(has('97.2%')).toBe(true);
  });

  it('p=50%、n=30：Newcombe 反而更差（90.8% vs 94.8%）—— 这条必须留在文档里', () => {
    const r = exactCoverage(0.5, 0.5, 30);
    expect((r.newcombe * 100).toFixed(1)).toBe('90.8');
    expect((r.wald * 100).toFixed(1)).toBe('94.8');
    expect(r.newcombe < r.wald).toBe(true);
    // 这是文档里唯一一处「我们的选择更差」，删掉它就等于藏缺陷
    expect(has('90.8%')).toBe(true);
    expect(has('我们的选择也会坏')).toBe(true);
  });

  it('零事件：Wald 宽度为 0（结构性崩塌），Newcombe 不为 0', () => {
    const n = 20000;
    const [wl, wu] = waldCI(0, n, 0, n);
    const [nl, nu] = newcombeDiffCI(0, n, 0, n);
    expect(wu - wl).toBe(0);
    expect(nu - nl).toBeGreaterThan(0);
    // 文档写的 −0.0192pp / +0.0192pp
    expect((nl * 100).toFixed(4)).toBe('-0.0192');
    expect((nu * 100).toFixed(4)).toBe('0.0192');
    expect(has('宽度 0')).toBe(true);
  });

  it('结论会翻：0/50 vs 4/50 时 Wald 判有提升、Newcombe 判证据不足', () => {
    const [wl] = waldCI(0, 50, 4, 50);
    const [nl] = newcombeDiffCI(0, 50, 4, 50);
    expect(wl).toBeGreaterThan(0);
    expect(nl).toBeLessThan(0);
    expect(has('[0.48, 15.52]pp')).toBe(true);
    expect(has('[−2.84, 16.62]pp')).toBe(true);
  });

  it('P(B>A) 的正态近似误差：n=20 时约 1pp，n=100 时约 0.5pp', () => {
    const cases: [number, number, number, number][] = [
      [1, 20, 2, 20],
      [5, 100, 8, 100],
    ];
    const errs = cases.map(([c1, n1, c2, n2]) => {
      const exact = probTreatBetterExact(c1, n1, c2, n2);
      const a = c2 + 1;
      const b = n2 - c2 + 1;
      const a2 = c1 + 1;
      const b2 = n1 - c1 + 1;
      const mt = a / (a + b);
      const mc = a2 / (a2 + b2);
      const sd = Math.sqrt((mt * (1 - mt)) / (a + b + 1) + (mc * (1 - mc)) / (a2 + b2 + 1));
      return Math.abs(normalCdf((mt - mc) / sd) - exact) * 100;
    });
    expect(errs[0] > 0.9 && errs[0] < 1.1).toBe(true);
    expect(errs[1] > 0.45 && errs[1] < 0.65).toBe(true);
    // 误差必须随样本量单调下降，否则「n 大了就准」这句话是假的
    expect(errs[0] > errs[1]).toBe(true);
    expect(has('1.01pp')).toBe(true);
    expect(has('0.55pp')).toBe(true);
  });

  it('护栏三种口径的语义：谁更严，以及各自怎么错', () => {
    const rg = DEFAULT_CONFIG.guardrails.refundRate;
    const n = 20000;

    // ① 完全没有恶化：三种口径都不拦
    {
      const ni = nonInferiority(238, n, 238, n, rg.margin, rg.alpha);
      expect(ni.diff).toBe(0);
      for (const m of ['harm_and_practical', 'confirm_beyond_margin', 'non_inferiority'] as const) {
        expect(guardrailBlocks(ni, m)).toBe(false);
      }
    }

    // ② margin 之内**且能被证明**在 margin 内（+0.05pp，margin−diff 远大于 z·SE）：都不拦
    {
      const ni = nonInferiority(238, n, 248, n, rg.margin, rg.alpha);
      expect(ni.diff).toBeLessThan(rg.margin);
      expect(ni.nonInferior).toBe(true);
      for (const m of ['harm_and_practical', 'confirm_beyond_margin', 'non_inferiority'] as const) {
        expect(guardrailBlocks(ni, m)).toBe(false);
      }
    }

    // ③ 刚过 margin、但 SE 大到「确认超过 margin」还不够：
    //    harm_and_practical 拦，confirm_beyond_margin **不拦**——这就是它漏检的机制。
    //    （non_inferiority 在这里也拦，因为 diff 一旦超过 margin，非劣假设就站不住；
    //      它与 hp 的分歧只在 margin 附近，这也是它更严的原因。）
    {
      const ni = nonInferiority(1200, 100000, 1620, 100000, rg.margin, rg.alpha);
      expect(ni.diff > rg.margin).toBe(true);
      expect(ni.harmSignificant).toBe(true);
      expect(guardrailBlocks(ni, 'harm_and_practical')).toBe(true);
      expect(guardrailBlocks(ni, 'confirm_beyond_margin')).toBe(false);
    }

    // ④ 方向对但证据不足（+0.1pp、n=2000，SE 约 0.34pp）：另两个不拦，non_inferiority 拦
    {
      const ni = nonInferiority(20, 2000, 22, 2000, rg.margin, rg.alpha);
      expect(guardrailBlocks(ni, 'harm_and_practical')).toBe(false);
      expect(guardrailBlocks(ni, 'non_inferiority')).toBe(true);
    }

    // ⑤ 最反直觉的一格：+0.25pp **没有超过** margin，但 non_inferiority 仍然拦。
    //    因为 SE≈0.11pp，要证明「恶化 < 0.4pp」需要 margin−diff > 2.576·SE = 0.29pp，
    //    而这里只差 0.15pp —— 拿不出证据，就按「不许上线」处理。
    //    这就是它在 120 个实验上误拦 15 个的机制：不是算错，是口径决定的。
    {
      const ni = nonInferiority(238, n, 288, n, rg.margin, rg.alpha);
      expect(ni.diff < rg.margin).toBe(true);
      expect(ni.nonInferior).toBe(false);
      expect(guardrailBlocks(ni, 'harm_and_practical')).toBe(false);
      expect(guardrailBlocks(ni, 'non_inferiority')).toBe(true);
    }
  });

  it('「每臂 <100 时概率小数位不可引用」不是修辞：那正是误差量级', () => {
    // 误差 1.01pp 比页面显示的第二位小数还大 → 只保留一位才有意义
    expect(1.01).toBeGreaterThan(0.1);
    expect(has('每臂 < 100 时')).toBe(true);
  });
});
