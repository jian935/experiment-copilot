import { mdeTwoProportion, mulberry32, normalCdf, normalInv, twoSidedP } from './stats.ts';

/**
 * 「还要跑几天」——实验结论时间的预测。
 *
 * 市面上的实验平台几乎只回答「现在显不显著」，没人回答「我还要等几天」。而这个才是
 * 产品经理每天真正要问的问题。这里给两种口径，并且**两个都要给**，因为它们回答的是
 * 两个不同的问题：
 *
 *   A. 点估计外推（point）：「如果现在这点效应就是真的，需要多少样本 / 多少天」。
 *      确定性计算，闭式可复算。问题：把「观测到的效应」当成了「真实效应」，
 *      而效应本身是不确定的 —— 当观测差值刚好在 0 附近时，它会把等待时间算得长得离谱
 *      却不告诉你「其实可能永远等不到」。
 *
 *   B. 概率模拟（sim）：「把效应本身的不确定性一起算进去，多少天后有 X% 的把握能下结论」。
 *      每次模拟先从抽样分布抽一个可能的真实效应 θ*，再按 θ* 往后生成未来的转化数据，
 *      逐日做检验，记录第一次显著的日期。给出的不只是中位数，还有 20%/80% 分位与
 *      「在 horizon 内始终等不到」的比例 —— 后者才是最有用的那个数。
 *
 * 为什么不能只做 A：A 在效应≈0 时会返回一个天文数字的样本量，用户以为「再等就行」；
 * 而 B 会直接说「78% 的模拟在 30 天内等不到显著性」——这才是该收尾的信号。
 *
 * 已知简化（写进 UI 与文档，不藏）：
 *   1. 假设日均曝光不变、效应不随时间衰减（无新奇效应）；
 *   2. 基线率按当前观测值固定（其不确定性远小于差值的不确定性）；
 *   3. 未来转化用正态近似抽样（每日每臂曝光量级 ≥ 数百，CLT 足够）；
 *   4. 只预测「首次 p < α」，不预测决策会不会被护栏翻掉——那是另一层判断。
 */

export interface ForecastInput {
  /** 当前累计曝光 / 转化（control） */
  n1: number;
  c1: number;
  /** 当前累计曝光 / 转化（treatment） */
  n2: number;
  c2: number;
  /**
   * 指标类型。rate = 转化率（走二项抽样 + 两比例功效公式）；
   * continuous = ARPU 这类连续指标（走 SE ∝ 1/√n 的通用外推，不用二项功效）。
   * 两条路的「50% 点 ≈ 50% 功效」这一原理性检验都成立，但所用的功效公式不同。
   */
  kind?: 'rate' | 'continuous';
  /** control 的水平值（连续指标用于展示与 MDE 语境；率指标可省略，默认 p1） */
  baselineValue?: number;
  /** 每臂日均曝光（由日表明细算，不是拍脑袋填的） */
  dailyRate: number;
  /** 实验已经跑了多少天（只用于展示进度） */
  elapsedDays?: number;
  /** 决策口径的差值，默认 p̂₂ − p̂₁ */
  diff?: number;
  /** 决策口径的标准误，默认非合并两比例 SE；传 CUPED 的 SE 即按 CUPED 口径预测 */
  se?: number;
  alpha?: number;
  power?: number;
  /** 最多往后模拟多少天 */
  horizonDays?: number;
  sims?: number;
  seed?: number;
}

export interface ForecastResult {
  observed: {
    /** 指标类型（决定单位是 pp 还是元） */
    kind: 'rate' | 'continuous';
    /** control / treatment 的水平值（率=转化率，连续=ARPU） */
    controlValue: number;
    treatmentValue: number;
    controlRate: number;
    treatmentRate: number;
    diff: number;
    se: number;
    nPerArm: number;
    p: number;
    significant: boolean;
  };
  rate: {
    perArmPerDay: number;
    /** 已跑天数（由调用方从日期区间给出，仅用于展示进度） */
    elapsedDays: number;
  };
  /** A. 点估计外推：假设当前观测效应就是真值 */
  point: {
    requiredNPerArm: number;
    remainingNPerArm: number;
    remainingDays: number;
    /** 需要的时间超过 10 年 → 视为「这个效应小到不值得为它等」 */
    unrealistic: boolean;
  };
  /** B. 概率模拟：效应本身也不确定 */
  sim: {
    /** 把握度首次达到 50% 的天数；null = 一次都没能得出结论 */
    medianDays: number | null;
    p20Days: number | null;
    p80Days: number | null;
    /** 跑到 horizon 那天仍无法下结论的比例（0–1） */
    stuck: number;
    /** 把握度曲线：curve[d].p = 「跑到第 d 天时 p < α」的模拟比例 */
    curve: { day: number; p: number }[];
    sims: number;
    seed: number;
    horizonDays: number;
  };
  /** 可检出能力随时间改善 */
  mde: { now: number; atHorizon: number; unit: 'pp' | '元' };
  verdict: { code: 'done' | 'eta' | 'unlikely'; text: string };
}

const MIN_RATE = 1e-9;

/** 与 mdeTwoProportion 同源的闭式反解：mde = (z₁₋α/₂+z_power)·√(2p(1−p)/n) → n */
export function requiredNPerArm(p: number, diff: number, alpha = 0.05, power = 0.8): number {
  const d = Math.abs(diff);
  if (!(d > 1e-12)) return Infinity;
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);
  return Math.ceil(((za + zb) ** 2 * 2 * p * (1 - p)) / (d * d));
}

/** 线性插值分位数（与 stats.quantile 的「类型 7」口径一致，输入未排序也可） */
function quantileOf(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function forecast(input: ForecastInput): ForecastResult {
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const horizonDays = Math.max(1, Math.round(input.horizonDays ?? 30));
  const sims = Math.max(1, Math.round(input.sims ?? 2000));
  const seed = input.seed ?? 20261101;
  const kind = input.kind ?? 'rate';

  const n1 = Math.max(0, input.n1);
  const n2 = Math.max(0, input.n2);
  const p1 = n1 > 0 ? input.c1 / n1 : 0;
  const p2 = n2 > 0 ? input.c2 / n2 : 0;
  const diff = input.diff ?? p2 - p1;
  const seDefault = Math.sqrt(
    (n1 > 0 ? (p1 * (1 - p1)) / n1 : 0) + (n2 > 0 ? (p2 * (1 - p2)) / n2 : 0),
  );
  const se = input.se ?? seDefault;
  const pNow = se > MIN_RATE ? twoSidedP(diff / se) : 1;
  const significant = pNow < alpha;
  const nPerArm = Math.min(n1, n2);
  const rate = input.dailyRate > 0 ? input.dailyRate : 0;
  const za = normalInv(1 - alpha / 2);
  const zb = normalInv(power);

  // ---- A. 点估计外推 ----
  // 率指标：闭式反解 n（与 mdeTwoProportion 互为反函数）；
  // 连续指标：SE ∝ 1/√n 是精确关系（用 delta method 也不改变），于是 n_target = n·(SE/SE_target)²，
  //   其中「到 80% 功效需要多大 SE」= |Δ|/(z₁₋α/₂+z_power)。两条路给出的都是"效应为真时的需要量"。
  const required =
    kind === 'continuous'
      ? Math.abs(diff) > 1e-12 && se > MIN_RATE && nPerArm > 0
        ? Math.ceil(nPerArm * (se / (Math.abs(diff) / (za + zb))) ** 2)
        : Infinity
      : requiredNPerArm(p1, diff, alpha, power);
  const remainingN = Math.max(0, required - nPerArm);
  const remainingDays = rate > 0 && Number.isFinite(remainingN) ? Math.ceil(remainingN / rate) : Infinity;
  const unrealistic = !Number.isFinite(required) || required > 1e9 || remainingDays > 3650;

  // ---- B. 概率模拟 ----
  // 口径是「跑到第 T 天、那时看一次」的把握度，而不是「每天看一次、第一次显著就停」。
  // 这两者差别不小：天天盯着看会让第一类错误随着检验次数膨胀（peeking bias），
  // 用首达时间会把天数估得更乐观。所以这里对每个 T 单独算 P(p_T < α)，
  // 与 powerTwoProportion 的无条件功效是同一个口径，可以互相对账（见单测）。
  const sigPerDay = new Array<number>(horizonDays + 1).fill(0);
  if (significant) {
    // 已显著 → 第 0 天起把握度就是 1，不必再跑（也避免 se=0 之类退化输入触发 NaN）
    sigPerDay.fill(sims);
  } else if (rate > 0) {
    const rng = mulberry32(seed);
    if (kind === 'continuous') {
      // 连续指标：抽「真实效应 θ*」→ 第 d 天的标准误按 1/√n 缩小 →
      // 该天显著的概率解析算（对 θ* 的抽样分布积分），而不是再抽一次观测值。
      // 这样每个 sim 贡献的是「显著概率」而不是 0/1，方差更小，期望值完全相同。
      for (let s = 0; s < sims; s++) {
        const theta = se > MIN_RATE ? diff + se * normalInv(rng()) : diff;
        for (let d = 1; d <= horizonDays; d++) {
          const nD = nPerArm + rate * d;
          const seD = se * Math.sqrt(nPerArm / nD);
          if (seD <= MIN_RATE) continue;
          const zz = theta / seD;
          // P(|Δ̂| > z·SE) = Φ(θ/SE − z) + Φ(−θ/SE − z)
          sigPerDay[d] += normalCdf(zz - za) + normalCdf(-zz - za);
        }
      }
    } else {
      const pt1 = Math.min(1 - MIN_RATE, Math.max(MIN_RATE, p1));
      const sd1 = Math.sqrt(rate * pt1 * (1 - pt1));
      for (let s = 0; s < sims; s++) {
        // 真实效应后验：以当前观测为均值、当前标准误为尺度（频率派抽样分布口径）
        const theta = se > MIN_RATE ? diff + se * normalInv(rng()) : diff;
        const pt2 = Math.min(1 - MIN_RATE, Math.max(MIN_RATE, p1 + theta));
        const sd2 = Math.sqrt(rate * pt2 * (1 - pt2));
        let n1t = n1;
        let c1t = input.c1;
        let n2t = n2;
        let c2t = input.c2;
        // 每个 sim 逐日推进，每天都独立判一次「第 d 天时 p < α」。
        // 不做「一旦显著就永久算显著」的粘滞：那等于把早期偶然的显著锁死，
        // 曲线的 50% 点会明显早于真实功效点（实测早到 37% 功效处），是 peeking 的变种。
        for (let d = 1; d <= horizonDays; d++) {
          n1t += rate;
          n2t += rate;
          c1t += rate * pt1 + sd1 * normalInv(rng());
          c2t += rate * pt2 + sd2 * normalInv(rng());
          const q1 = Math.min(1, Math.max(0, c1t / n1t));
          const q2 = Math.min(1, Math.max(0, c2t / n2t));
          const seD = Math.sqrt((q1 * (1 - q1)) / n1t + (q2 * (1 - q2)) / n2t);
          if (seD > MIN_RATE && twoSidedP((q2 - q1) / seD) < alpha) sigPerDay[d] += 1;
        }
      }
    }
  }

  const curve: { day: number; p: number }[] = [];
  for (let d = 0; d <= horizonDays; d++) curve.push({ day: d, p: sigPerDay[d] / sims });
  const stuck = 1 - sigPerDay[horizonDays] / sims;

  // 天数分布的 20/50/80 分位：曲线是「第 d 天的把握度」，取首次达到该比例的那天。
  // 曲线在小样本处会有抖动（p 值不随 n 严格单调），所以用的是「首次达到」，不是「累计」。
  const dayAt = (q: number): number | null => {
    if (sigPerDay[horizonDays] === 0) return null;
    const hit = curve.find((c) => c.p >= q);
    return hit ? hit.day : null;
  };
  const medianDays = dayAt(0.5);
  const p20Days = dayAt(0.2);
  const p80Days = dayAt(0.8);

  // ---- MDE 随时间改善 ----
  const mdeNow =
    kind === 'continuous'
      ? (za + zb) * se
      : mdeTwoProportion(p1, Math.max(1, nPerArm), alpha, power);
  const mdeAtHorizon =
    kind === 'continuous'
      ? (za + zb) * se * Math.sqrt(nPerArm / Math.max(1, nPerArm + rate * horizonDays))
      : mdeTwoProportion(p1, Math.max(1, nPerArm + rate * horizonDays), alpha, power);

  // 口心一致的判定：先说「现在到底能不能收」，再说「要等多久」
  let verdict: ForecastResult['verdict'];
  const pctFmt = (v: number) => `${Math.round(v * 100)}%`;
  const unit = kind === 'continuous' ? '元' : 'pp';
  const fmtMde = (v: number) => (kind === 'continuous' ? `${v.toFixed(3)}元` : `${(v * 100).toFixed(2)}pp`);
  if (significant) {
    verdict = {
      code: 'done',
      text: `当前样本已经能下结论（p=${pNow < 0.001 ? '<0.001' : pNow.toFixed(3)}），继续跑只会让区间更窄，不会改变判定。`,
    };
  } else if (rate <= 0) {
    // 没流量就谈不上「等不到显著」——那是数据缺失，不是效应太小，不能混为一谈
    verdict = {
      code: 'unlikely',
      text: '数据里没有可用的日级曝光（或每臂日均曝光为 0），无法预测还需要多久。',
    };
  } else if (stuck >= 0.5) {
    verdict = {
      code: 'unlikely',
      text:
        `按当前效应与流量，${pctFmt(stuck)} 的模拟在 ${horizonDays} 天内等不到显著性。` +
        `这通常意味着真实效应小到不值得为它继续投入流量——更该做的是按「无实质差异」收尾，或者改设计再跑一轮。`,
    };
  } else if (medianDays === null) {
    verdict = {
      code: 'unlikely',
      text: `模拟没有给出可用天数（每臂日均 ${rate.toFixed(0)}），无法预测。`,
    };
  } else {
    verdict = {
      code: 'eta',
      text:
        `再跑到第 ${medianDays} 天时，约 50% 的模拟能得出结论（20%–80% 分位：${p20Days ?? '—'}–${p80Days ?? '>' + horizonDays} 天）；` +
        `同期可检出的最小差异会从 ${fmtMde(mdeNow)} 收窄到 ${fmtMde(mdeAtHorizon)}。`,
    };
  }

  return {
    observed: {
      kind,
      controlValue: input.baselineValue ?? p1,
      treatmentValue: (input.baselineValue ?? p1) + diff,
      controlRate: p1,
      treatmentRate: p2,
      diff,
      se,
      nPerArm,
      p: pNow,
      significant,
    },
    rate: { perArmPerDay: rate, elapsedDays: input.elapsedDays ?? 0 },
    point: {
      requiredNPerArm: Number.isFinite(required) ? required : Infinity,
      remainingNPerArm: Number.isFinite(remainingN) ? remainingN : Infinity,
      remainingDays: Number.isFinite(remainingDays) ? remainingDays : Infinity,
      unrealistic,
    },
    sim: { medianDays, p20Days, p80Days, stuck, curve, sims, seed, horizonDays },
    mde: { now: mdeNow, atHorizon: mdeAtHorizon, unit },
    verdict,
  };
}

/** 从日表明细算「每臂日均曝光」：用最近 k 天，避免早期流量爬坡把均值拉低 */
export function dailyRatePerArm(
  rows: { variant: string; date: string; exposures: number }[],
  k = 3,
): number {
  const byDate = new Map<string, { control: number; treatment: number }>();
  for (const r of rows) {
    const b = byDate.get(r.date) ?? { control: 0, treatment: 0 };
    if (r.variant === 'control') b.control += r.exposures;
    else b.treatment += r.exposures;
    byDate.set(r.date, b);
  }
  const dates = [...byDate.keys()].sort().slice(-Math.max(1, k));
  if (!dates.length) return 0;
  let sum = 0;
  for (const d of dates) {
    const b = byDate.get(d)!;
    sum += Math.min(b.control, b.treatment);
  }
  return sum / dates.length;
}

/** 给 UI 的一句话口径说明（与上面「已知简化」同源，避免文档与实现走偏） */
export const FORECAST_ASSUMPTIONS = [
  '日均曝光与效应保持不变（不考虑新奇效应衰减）',
  '基线率按当前观测固定',
  '未来转化按正态近似抽样（日曝光量级 ≥ 数百时足够）',
  '只预测「首次 p < α」，不预测护栏是否会把结论翻掉',
] as const;

/** 连续指标（ARPU）额外的一条假设，UI 里跟上面 4 条一起展示 */
export const FORECAST_ASSUMPTION_CONTINUOUS =
  '连续指标（ARPU）按「标准误 ∝ 1/√n」外推，等价于假设收入分布的离散程度不随样本变化';
