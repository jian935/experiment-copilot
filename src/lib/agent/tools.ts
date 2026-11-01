import { mdeTwoProportion, normalCdf, normalInv, powerTwoProportion } from '../stats.ts';
import { dailyRatePerArm, forecast } from '../forecast.ts';
import { familyReport } from '../multiplicity.ts';
import { LOSS_CAUTIONS, LOSS_GATES, applyGates, defaultLoss, expectedLoss } from '../loss.ts';
import type { Analysis, Evidence } from '../decide.ts';
import type { Decision } from '../types.ts';
import type { AgentCtx, ToolCall, ToolName } from './types.ts';
import { METRIC_DEFS, directionLabel, findMetrics } from '../metrics.ts';

export const TOOL_LABEL: Record<ToolName, string> = {
  get_overview: '读取结论',
  run_test: '重算主指标检验',
  segment_breakdown: '扫描分层',
  check_guardrails: '检查护栏',
  compute_mde: '推算 MDE / 功效',
  forecast_days: '预测还要跑几天',
  find_similar: '检索相似实验',
  list_experiments: '检索实验列表',
  explain_rules: '回溯判定规则',
  bayesian_view: '贝叶斯视角',
  metric_decompose: '指标因子分解',
  metric_dictionary: '口径字典',
  peeking_check: '窥探校正（序贯）',
  novelty_check: '新颖效应（时间衰减）',
  fwer_check: '多人比较校正（FWER）',
  loss_decide: '期望损失决策',
};

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
/**
 * 负零归一：`-k·E[损失]` 在损失为 0 时会算出 -0，toFixed 会印成「-0.00」。
 *
 * ⚠️ 阈值必须按**单位**算，不能按数值算：pp 的显示值是 v×100，末位 1e-2 对应 v 的 1e-4，
 * 所以半位是 5e-5；元的末位就是 1e-2，半位 5e-3。两者差 100 倍——
 * 一律用 0.5·10⁻ᵈ 会把 0.3pp 这种正常值误判成 0（实测少算 656 个数字，被基线比对抓到）。
 */
const snapZero = (v: number, unit: Unit, d = 2) => {
  const half = unit === '元' ? 0.5 * 10 ** -d : 0.5 * 10 ** -(d + 2);
  return Math.abs(v) < half ? 0 : v;
};
const pp = (v: number, d = 2) => {
  const x = snapZero(v, 'pp', d);
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}pp`;
};
const pv = (p: number) => (p < 1e-16 ? '<1e-16' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));

/** 指标单位。Agent 回答里的每个差值都必须带对单位，否则「+0.42」是 pp 还是元没人知道 */
type Unit = 'pp' | '元';
const fmtDiff = (v: number, unit: Unit, d = 2) => {
  const x = snapZero(v, unit, d);
  return unit === '元' ? `${x > 0 ? '+' : ''}${x.toFixed(d)}元` : pp(x, d);
};
const fmtLevel = (v: number, unit: Unit, d = 2) => (unit === '元' ? `${v.toFixed(d)}元` : pct(v, d));

const DECISION_CN: Record<string, string> = {
  ship: '建议上线',
  'no-ship': '不建议上线',
  iterate: '定向上线',
  inconclusive: '无法下结论',
  unknown: '未知',
};

function cite(a: Analysis, kind: Evidence['kind'], labelPart?: string): string[] {
  const hit = a.evidence.filter((e) => e.kind === kind && (!labelPart || e.label.includes(labelPart)));
  return hit.map((e) => e.id);
}

/** 10 个工具全部是纯函数：只读 Analysis / Dataset 与口径字典，不联网、不算任何新口径 */
export function runTool(name: ToolName, ctx: AgentCtx, args: Record<string, unknown> = {}): ToolCall {
  const { analysis: a, exp, dataset } = ctx;

  switch (name) {
    case 'get_overview': {
      return {
        tool: name,
        args,
        summary: `结论：${a.decision}（规则 ${a.reasonCode}）`,
        data: {
          decision: a.decision,
          reasonCode: a.reasonCode,
          reason: a.reason,
          primaryMetric: a.primary.label,
          metricKind: a.primary.kind,
          unit: a.primary.unit,
          /** 已格式化好的差值文本（模型直接抄，不用自己换算单位） */
          diffText: fmtDiff(a.primary.diff, a.primary.unit),
          diff: a.primary.diff,
          p: a.primary.p,
          pText: pv(a.primary.p),
          n: a.overall.n1 + a.overall.n2,
        },
        cites: [...cite(a, 'metric'), ...cite(a, 'decision')],
      };
    }

    case 'run_test': {
      const p = a.primary;
      return {
        tool: name,
        args,
        summary: `${p.label}：${fmtLevel(p.controlValue, p.unit)} → ${fmtLevel(p.treatmentValue, p.unit)}，差值 ${fmtDiff(p.diff, p.unit)}（95% CI ${fmtDiff(p.ci95[0], p.unit)} ~ ${fmtDiff(p.ci95[1], p.unit)}），p=${pv(p.p)}`,
        data: {
          /** 主指标口径（率或 ARPU），决策就是按它下的 */
          primary: {
            label: p.label,
            kind: p.kind,
            unit: p.unit,
            via: p.via,
            controlValue: p.controlValue,
            treatmentValue: p.treatmentValue,
            diff: p.diff,
            diffText: fmtDiff(p.diff, p.unit),
            ci95: p.ci95,
            ciText: `${fmtDiff(p.ci95[0], p.unit)} ~ ${fmtDiff(p.ci95[1], p.unit)}`,
            relativeLift: p.relativeLift,
            p: p.p,
            pText: pv(p.p),
            significant: p.p < 0.05,
          },
          /** 转化率口径（恒有，用作交叉验证；ARPU 主指标时它是副指标） */
          conversion: {
            controlRate: a.overall.controlRate,
            treatmentRate: a.overall.treatmentRate,
            diff: a.overall.diff,
            diffText: pp(a.overall.diff),
            p: a.overall.p,
            pText: pv(a.overall.p),
          },
          /** ARPU 口径（数据里有收入时才有） */
          arpu: a.arpu
            ? {
                controlValue: a.arpu.controlValue,
                treatmentValue: a.arpu.treatmentValue,
                diff: a.arpu.diff,
                diffText: fmtDiff(a.arpu.diff, '元'),
                p: a.arpu.p,
                pText: pv(a.arpu.p),
                df: Math.round(a.arpu.df),
              }
            : null,
          n1: a.overall.n1,
          n2: a.overall.n2,
        },
        cites: cite(a, 'metric'),
      };
    }

    case 'segment_breakdown': {
      const dim = String(args.dimension ?? 'tenure') as 'tenure' | 'device';
      const rows = a.segments[dim] ?? a.segments.tenure;
      const unit = a.primary.unit;
      return {
        tool: name,
        args: { dimension: dim },
        summary: rows.map((s) => `${s.label} ${fmtDiff(s.diff, unit)}（q=${s.q.toFixed(2)}）`).join('；'),
        data: {
          dimension: dim,
          unit,
          rows: rows.map((s) => ({
            label: s.label,
            controlValue: s.controlValue,
            treatmentValue: s.treatmentValue,
            diff: s.diff,
            diffText: fmtDiff(s.diff, unit),
            p: s.p,
            pText: pv(s.p),
            q: s.q,
            significant: s.q <= 0.1,
          })),
          interaction: a.interaction.tenure,
        },
        cites: cite(a, 'segment'),
      };
    }

    case 'check_guardrails': {
      return {
        tool: name,
        args,
        summary: a.guardrails
          .map((g) => `${g.label} ${g.key === 'latency_p95' ? `${g.diff >= 0 ? '+' : ''}${g.diff.toFixed(0)}ms` : pp(g.diff)}${g.worse ? '（恶化）' : ''}`)
          .join('；'),
        data: a.guardrails.map((g) => ({
          key: g.key,
          label: g.label,
          control: g.controlRate,
          treatment: g.treatmentRate,
          diff: g.diff,
          p: g.p,
          worse: g.worse,
          gating: g.gating,
        })),
        cites: cite(a, 'guardrail'),
      };
    }

    case 'compute_mde': {
      const p = a.primary;
      const nCur = Math.min(a.overall.n1, a.overall.n2);
      if (p.kind === 'continuous') {
        // 连续指标：MDE = (z₁₋α/₂+z_power)·SE(n)，SE ∝ 1/√n，所以换到指定样本量只需按比例缩放。
        // 功效反过来算：P(|Δ̂| > z·SE) = Φ(|Δ|/SE − z) + Φ(−|Δ|/SE − z)。
        const nPerArm = typeof args.nPerArm === 'number' ? args.nPerArm : nCur;
        const za = Math.abs(normalInv(0.975));
        const zb = normalInv(0.8);
        const seAt = p.se * Math.sqrt(Math.max(1, nCur) / Math.max(1, nPerArm));
        const mde = (za + zb) * seAt;
        const zz = seAt > 0 ? Math.abs(p.diff) / seAt : 0;
        const power = Math.min(1, normalCdf(zz - za) + normalCdf(-zz - za));
        return {
          tool: name,
          args: { nPerArm },
          summary: `ARPU 在 n=${nPerArm}/组、当前 SE 下，80% 功效的最小可检出差值为 ${mde.toFixed(3)}元`,
          data: {
            metricKind: 'continuous',
            unit: '元',
            nPerArm,
            mde,
            mdeText: `${mde.toFixed(3)}元`,
            power,
            observedDiff: p.diff,
            observedDiffText: fmtDiff(p.diff, '元'),
            seAt,
          },
          cites: cite(a, 'metric'),
        };
      }
      const baseline = typeof args.baseline === 'number' ? args.baseline : a.overall.controlRate;
      const nPerArm = typeof args.nPerArm === 'number' ? args.nPerArm : nCur;
      const mde = mdeTwoProportion(baseline, nPerArm);
      const power = powerTwoProportion(baseline, a.overall.treatmentRate, nPerArm);
      return {
        tool: name,
        args: { baseline, nPerArm },
        summary: `在 n=${nPerArm}/组、基线 ${pct(baseline)} 下，80% 功效的最小可检出差异为 ${pp(mde)}`,
        data: {
          metricKind: 'rate',
          unit: 'pp',
          baseline,
          nPerArm,
          mde,
          mdeText: pp(mde),
          power,
          observedDiff: p.diff,
          observedDiffText: pp(p.diff),
        },
        cites: cite(a, 'metric'),
      };
    }

    case 'forecast_days': {
      // 「还要跑几天」：流量从日表算（不让人拍脑袋填），差值与标准误沿用当前决策口径，
      // 所以开了 CUPED 时预测用的也是 CUPED 的 SE —— 口径必须和结论页一致。
      const rows = dataset.daily.filter((r) => r.expId === exp.id);
      let n1 = 0, c1 = 0, n2 = 0, c2 = 0;
      for (const r of rows) {
        if (r.variant === 'control') {
          n1 += r.exposures;
          c1 += r.conversions;
        } else {
          n2 += r.exposures;
          c2 += r.conversions;
        }
      }
      const horizonDays = typeof args.horizonDays === 'number' ? args.horizonDays : 30;
      const p = a.primary;
      const f = forecast({
        n1,
        c1,
        n2,
        c2,
        kind: p.kind,
        baselineValue: p.controlValue,
        diff: p.diff,
        se: p.se,
        dailyRate: dailyRatePerArm(rows, 3),
        elapsedDays: new Set(rows.map((r) => r.date)).size,
        horizonDays,
        sims: 1200,
        seed: 20261101,
      });
      const fmtMde = (v: number) => (f.mde.unit === '元' ? `${v.toFixed(3)}元` : `${(v * 100).toFixed(2)}pp`);
      return {
        tool: name,
        args: { horizonDays },
        summary:
          f.verdict.code === 'done'
            ? `已可下结论，不必再等（p=${pv(f.observed.p)}）`
            : `预计第 ${f.sim.medianDays ?? '—'} 天可下结论；跑满 ${horizonDays} 天仍等不到的概率 ${Math.round(f.sim.stuck * 100)}%`,
        data: {
          verdictCode: f.verdict.code,
          verdictText: f.verdict.text,
          horizonDays,
          medianDays: f.sim.medianDays,
          p20Days: f.sim.p20Days,
          p80Days: f.sim.p80Days,
          stuckPP: Math.round(f.sim.stuck * 100),
          p: f.observed.p,
          requiredNPerArm: Number.isFinite(f.point.requiredNPerArm) ? f.point.requiredNPerArm : null,
          remainingDays: Number.isFinite(f.point.remainingDays) ? f.point.remainingDays : null,
          nPerArm: f.observed.nPerArm,
          dailyRate: f.rate.perArmPerDay,
          metricKind: f.observed.kind,
          /** 已经格式化好的 MDE 文本（模型别自己换算单位） */
          mdeNowText: fmtMde(f.mde.now),
          mdeAtHorizonText: fmtMde(f.mde.atHorizon),
          via: a.primary.via,
        },
        cites: cite(a, 'metric'),
      };
    }

    case 'find_similar': {
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const rows = [...dataset.experiments]
        .filter((e) => e.id !== exp.id && (e.archetype === exp.archetype || e.primaryMetric === exp.primaryMetric))
        .slice(0, limit)
        .map((e) => {
          const an = ctx.analyses.get(e.id);
          const unit: Unit = an?.primary.unit ?? 'pp';
          const diff = an?.primary.diff ?? 0;
          const p = an?.primary.p ?? 1;
          return {
            id: e.id,
            name: e.name,
            archetype: e.archetype,
            primaryMetric: an?.primary.label ?? e.primaryMetric,
            decision: an?.decision ?? 'unknown',
            decisionLabel: DECISION_CN[an?.decision ?? 'inconclusive'],
            // 给模型直接可抄的字符串：避免它输出 16 位浮点（实测会被数字审计判为可疑），
            // 也避免把不同实验的 pp / 元 混成一个单位
            diffText: fmtDiff(diff, unit),
            pText: pv(p),
            diff,
            unit,
            p,
          };
        });
      return {
        tool: name,
        args: { limit },
        summary: rows.length
          ? rows.map((r) => `${r.id} ${r.name}（${r.decision}）`).join('；')
          : '没有找到相同类型的实验',
        data: rows,
        cites: [],
      };
    }

    case 'list_experiments': {
      const decision = typeof args.decision === 'string' ? (args.decision as Decision) : undefined;
      const archetype = typeof args.archetype === 'string' ? args.archetype : undefined;
      const kw = typeof args.keyword === 'string' ? args.keyword.toLowerCase() : '';
      const rows = dataset.experiments
        .filter((e) => {
          const an = ctx.analyses.get(e.id);
          if (!an) return false;
          if (decision && an.decision !== decision) return false;
          if (archetype && e.archetype !== archetype) return false;
          if (kw && !`${e.id}${e.name}${e.hypothesis}${e.primaryMetric}`.toLowerCase().includes(kw)) return false;
          return true;
        })
        .map((e) => {
          const an = ctx.analyses.get(e.id)!;
          return {
            id: e.id,
            name: e.name,
            decision: an.decision,
            decisionLabel: DECISION_CN[an.decision],
            primaryMetric: an.primary.label,
            diffText: fmtDiff(an.primary.diff, an.primary.unit),
            pText: pv(an.primary.p),
            diff: an.primary.diff,
            unit: an.primary.unit,
            p: an.primary.p,
          };
        });
      return {
        tool: name,
        args: { decision, archetype, keyword: kw || undefined },
        summary: `命中 ${rows.length} 个实验${rows.length ? `：${rows.slice(0, 5).map((r) => r.id).join('、')}${rows.length > 5 ? ' 等' : ''}` : ''}`,
        data: rows,
        cites: [],
      };
    }

    case 'explain_rules': {
      const hit = a.rules.find((r) => r.code === a.reasonCode);
      const idx = a.rules.findIndex((r) => r.code === a.reasonCode);
      return {
        tool: name,
        args,
        summary: `第 ${idx + 1} 条规则「${a.reasonCode}」命中：${hit?.detail ?? ''}`,
        data: a.rules,
        cites: cite(a, 'decision'),
      };
    }

    case 'bayesian_view': {
      const b = a.bayes;
      const unit = a.primary.unit;
      const probPct = Math.min(99.9, +(b.probTreatBetter * 100).toFixed(1));
      return {
        tool: name,
        args,
        summary: `treatment 更优概率 ${probPct}% · 95% 可信区间 ${fmtDiff(b.credLow, unit, 3)} ~ ${fmtDiff(b.credHigh, unit, 3)}`,
        data: {
          metricLabel: a.primary.label,
          metricKind: a.primary.kind,
          unit,
          /** 后验分布口径：率指标 Beta-Binomial，连续指标正态 */
          posterior: a.primary.kind === 'continuous' ? 'normal' : 'beta-binomial',
          probTreatBetter: b.probTreatBetter,
          probPct,
          credLow: b.credLow,
          credHigh: b.credHigh,
          credText: `${fmtDiff(b.credLow, unit, 3)} ~ ${fmtDiff(b.credHigh, unit, 3)}`,
          meanDiff: b.meanDiff,
          meanDiffText: fmtDiff(b.meanDiff, unit, 3),
          expectedLoss: b.expectedLoss,
          expectedLossText: fmtDiff(b.expectedLoss, unit, 3),
        },
        cites: cite(a, 'metric'),
      };
    }

    case 'metric_decompose': {
      // ARPU = 转化率 × 客单价。这个工具存在的唯一理由：
      // 「ARPU 涨了，是因为买的人多了，还是因为买得更贵了」——两条路径的业务含义完全不同，
      // 而只看总量（甚至只看 p 值）永远回答不了这个问题。
      const bd = a.arpuBreakdown;
      const rt = a.arpu;
      if (!bd || !rt) {
        return {
          tool: name,
          args,
          summary: '这份数据没有收入字段，无法做 ARPU 分解',
          data: { available: false, reason: '数据缺 revenue 字段（导入时补上收入列即可启用）' },
          cites: [],
        };
      }
      const d = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
      const dominant = Math.abs(bd.fromCvr) >= Math.abs(bd.fromAov) ? '转化率' : '客单价';
      const conflict = bd.fromCvr * bd.fromAov < 0;
      return {
        tool: name,
        args,
        summary:
          `ARPU ${d(bd.total)}元 = 转化率贡献 ${d(bd.fromCvr)}元 + 客单价贡献 ${d(bd.fromAov)}元 + 交叉项 ${d(bd.fromInteraction)}元；` +
          `主要由${dominant}驱动`,
        data: {
          available: true,
          unit: '元',
          controlCvr: bd.controlCvr,
          treatmentCvr: bd.treatmentCvr,
          controlAov: bd.controlAov,
          treatmentAov: bd.treatmentAov,
          /** 三块贡献（元/曝光），严格相加等于 total */
          fromCvr: bd.fromCvr,
          fromAov: bd.fromAov,
          fromInteraction: bd.fromInteraction,
          total: bd.total,
          fromCvrText: `${d(bd.fromCvr)}元`,
          fromAovText: `${d(bd.fromAov)}元`,
          fromInteractionText: `${d(bd.fromInteraction)}元`,
          totalText: `${d(bd.total)}元`,
          dominant,
          /** 两块贡献方向相反：总量会掩盖真实变化，必须显式说 */
          oppositeSigns: conflict,
          cvrText: `${pct(bd.controlCvr, 3)} → ${pct(bd.treatmentCvr, 3)}`,
          aovText: `${bd.controlAov.toFixed(2)}元 → ${bd.treatmentAov.toFixed(2)}元`,
          arpuP: rt.p,
          arpuPText: pv(rt.p),
        },
        cites: cite(a, 'metric').filter((id) => {
          const e = a.evidence.find((x) => x.id === id);
          return !!e && /ARPU/.test(e.label);
        }),
      };
    }

    case 'metric_dictionary': {
      // 口径字典是「Agent 不能自创指标」的唯一依据：
      // 只认 METRIC_DEFS 里登记过的口径，问到没登记的必须明说没有，不许现编。
      const q = typeof args.metric === 'string' ? args.metric : (ctx.question ?? '');
      const mentioned = findMetrics(q);
      const wantUnknown =
        mentioned.length === 0 &&
        /口径|指标|定义|怎么算|如何计算|什么是/.test(q) &&
        /[A-Za-z\u4e00-\u9fa5]{2,}/.test(q);

      return {
        tool: name,
        args,
        summary: mentioned.length
          ? `命中 ${mentioned.length} 个已登记口径：${mentioned.map((m) => m.label).join('、')}`
          : `已登记口径共 ${METRIC_DEFS.length} 个：${METRIC_DEFS.map((m) => m.label).join('、')}`,
        data: {
          known: METRIC_DEFS.map((m) => ({
            key: m.key,
            label: m.label,
            kind: m.kind,
            direction: m.direction,
            directionLabel: directionLabel(m),
            unit: m.unit,
            formula: m.formula,
            source: m.source,
            method: m.method,
            guardrailMargin: m.guardrailMargin,
          })),
          matched: mentioned.map((m) => m.key),
          /** 问了一个字典里没有的指标：只能说没有，不许编 */
          unknownMention: wantUnknown,
        },
        cites: mentioned.length ? cite(a, 'metric') : [],
      };
    }

    case 'peeking_check': {
      // 序贯监控：回答「我每天都在看，现在算不算数」。
      // 关键是把「看了几次」这个事实和「门槛被收紧到多少」连起来，
      // 否则用户会以为序贯校正只是又给了一个 p 值。
      const s = a.sequential;
      const unit = a.primary.unit;
      if (s.skipped || s.looks.length < 2) {
        return {
          tool: name,
          args,
          summary: `无法做序贯校正：${s.skipped ?? '观察次数不足'}`,
          data: { available: false, reason: s.skipped ?? '观察次数不足', looks: 0 },
          cites: [],
        };
      }
      const last = s.looks[s.looks.length - 1];
      return {
        tool: name,
        args,
        summary:
          `已观察 ${s.k} 次；按 OBF 口径最后一次要 p<${(s.finalPBoundary * 100).toFixed(2)}%（naive 为 ${(s.alpha * 100).toFixed(0)}%）；` +
          `naive p=${pv(s.finalPNaive)}、OBF ${s.obfCrossDay ? `第 ${s.obfCrossDay} 次越过` : '全程未越界'}、always-valid p=${pv(s.finalPAlways)}`,
        data: {
          available: true,
          looks: s.k,
          alpha: s.alpha,
          /** 最终那次观察的名义门槛（p 尺度）与百分数写法，回答里引用哪个都不会错 */
          finalPBoundary: s.finalPBoundary,
          finalPBoundaryText: `${(s.finalPBoundary * 100).toFixed(2)}%`,
          tightening: s.obfTightening,
          tighteningText: `收紧 ${s.obfTightening.toFixed(2)} 倍`,
          finalPNaive: s.finalPNaive,
          finalPNaiveText: pv(s.finalPNaive),
          finalPAlways: s.finalPAlways,
          finalPAlwaysText: pv(s.finalPAlways),
          /** always-valid p 的正确报法是全程最小值（它控制的是「整个过程有没有出现证据」） */
          minAlwaysP: s.minAlwaysP,
          minAlwaysPText: pv(s.minAlwaysP),
          minNaiveP: s.minNaiveP,
          minNaivePText: pv(s.minNaiveP),
          z: last.z,
          zText: last.z.toFixed(2),
          zBoundary: last.zBoundary,
          zBoundaryText: last.zBoundary.toFixed(2),
          naiveSig: s.naiveSig,
          obfSig: s.obfSig,
          alwaysSig: s.alwaysSig,
          /** 第一次越过边界是第几次观察；null = 全程没越过 */
          obfCrossDay: s.obfCrossDay,
          alwaysCrossDay: s.alwaysCrossDay,
          /** 最后一次观察本身有没有越过（早期越过、后面回落要说清楚） */
          obfSigNow: s.obfSigNow,
          obfCrossText: s.obfCrossDay ? `第 ${s.obfCrossDay} 次观察越过边界` : '全程未越过边界',
          /** 「偷看把不显著看成显著」的那一类：回答必须点明，否则用户会以为引擎自相矛盾 */
          rescuedByCorrection: s.naiveSig && !s.obfSig,
          priorScale: s.priorScale,
          priorScaleText: fmtDiff(s.priorScale, unit, 3),
          unit,
          /** 每次观察的边界序列：给"边界一路收紧"这个说法提供数字 */
          boundaries: s.looks.map((l) => ({ day: l.day, date: l.date, z: +l.z.toFixed(3), zBoundary: +l.zBoundary.toFixed(3), pNaive: l.pNaive })),
        },
        cites: cite(a, 'metric', '序贯'),
      };
    }

    case 'novelty_check': {
      // 新颖效应：回答「这个效果会不会随着时间缩水 / 上周的效果这周还在不在」。
      // 必须同时给三件事：前后半段各是多少、差异的 p、以及「比这更小的衰减看不出来」——
      // 只说"未见衰减"会让人以为已经排除了衰减。
      const n = a.novelty;
      const unit = a.primary.unit;
      if (n.skipped) {
        return {
          tool: name,
          args,
          summary: `无法做衰减判定：${n.skipped}`,
          data: { available: false, reason: n.skipped },
          cites: [],
        };
      }
      const PATTERN: Record<string, string> = {
        decay: '效应在衰减（后半段显著低于前半段）',
        growth: '效应在增强（后半段显著高于前半段）',
        stable: '未见衰减（不等于没有衰减，见可检出下限）',
        insufficient: '数据不足',
      };
      return {
        tool: name,
        args,
        summary:
          `前半段 ${n.early.days} 天 ${fmtDiff(n.early.diff, unit)}、后半段 ${n.late.days} 天 ${fmtDiff(n.late.diff, unit)}；` +
          `前后差 ${fmtDiff(n.delta, unit)}，p=${pv(n.p)} → ${PATTERN[n.pattern]}`,
        data: {
          available: true,
          pattern: n.pattern,
          patternText: PATTERN[n.pattern],
          earlyDiff: n.early.diff,
          earlyDiffText: fmtDiff(n.early.diff, unit),
          earlyDays: n.early.days,
          earlySeText: fmtDiff(n.early.se, unit),
          lateDiff: n.late.diff,
          lateDiffText: fmtDiff(n.late.diff, unit),
          lateDays: n.late.days,
          lateSeText: fmtDiff(n.late.se, unit),
          delta: n.delta,
          deltaText: fmtDiff(n.delta, unit),
          relativeDelta: n.relativeDelta,
          relativeDeltaText: n.relativeDelta === null ? '—（前半段效应≈0，谈相对变化没有意义）' : `${(n.relativeDelta * 100).toFixed(1)}%`,
          seDelta: n.seDelta,
          seDeltaText: fmtDiff(n.seDelta, unit),
          t: n.t,
          tText: n.t.toFixed(2),
          /** 日数少，参考分布是 t 不是正态：自由度必须一起给，否则 t 值没法核 */
          df: n.df,
          dfText: n.df.toFixed(1),
          p: n.p,
          pText: pv(n.p),
          alpha: n.alpha,
          /** 80% 功效下可检出的最小衰减 —— "未见衰减"必须配上这个数才诚实 */
          detectableDelta: n.detectableDelta,
          detectableDeltaText: fmtDiff(n.detectableDelta, unit),
          unit,
          slope: n.slope,
          slopeText: n.slope === null ? '逐日点数不足，未拟合斜率' : `${fmtDiff(n.slope, unit)}/天`,
          slopePText: n.slopeP === null ? '—' : pv(n.slopeP),
          dispersion: n.dispersion,
          dispersionText: n.dispersion === null ? '—' : `φ = ${n.dispersion.toFixed(2)}`,
          /** 逐日点（互不重叠，不是累计值），给"哪一天掉了"提供依据 */
          points: n.points.map((pt) => ({ day: pt.day, date: pt.date, diff: +pt.diff.toFixed(6), se: +pt.se.toFixed(6), half: pt.half, sig: pt.sig })),
          /** 检测器不参与决策：回答里要能说清"这个结论没被衰减改写" */
          affectsDecision: false,
        },
        cites: cite(a, 'metric', '新颖效应'),
      };
    }

    case 'fwer_check': {
      // 「我看了一遍全部实验，哪个是真显著」——不校正的话，120 个零效应实验里
      // 至少一个显著的概率是 99.8%，这题必须把算术摆出来。
      const family = familyReport(
        (dataset?.experiments ?? []).map((e) => {
          const a = ctx.analyses?.get(e.id);
          return {
            id: e.id,
            name: e.name,
            p: a ? a.primary.p : 1,
            decision: a?.decision ?? 'inconclusive',
            archetype: e.archetype,
            trueEffect: e.trueLiftOverall,
          };
        }),
      );
      const mine = family.rows.find((r) => r.id === exp.id);
      return {
        tool: name,
        args,
        summary:
          `一起看 ${family.n} 个实验：naive 显著 ${family.naiveSig} 个，Holm 校正后 ${family.holmSig} 个` +
          (mine ? `；本实验 p=${pv(mine.p)} → Holm ${pv(mine.pHolm)}${mine.holmSig ? '（仍显著）' : '（校正后不显著）'}` : ''),
        data: {
          available: family.n > 1,
          n: family.n,
          alpha: family.alpha,
          fdr: family.fdr,
          naiveSig: family.naiveSig,
          holmSig: family.holmSig,
          bonferroniSig: family.bonferroniSig,
          bhSig: family.bhSig,
          rescinded: family.rescinded,
          rescindedFalse: family.rescindedFalse,
          /** 全零假设下"至少一个显著"的概率：1−(1−α)^n —— 这就是"总有一个能上线" */
          naiveAnySig: family.naiveAnySig,
          naiveAnySigText: `${(family.naiveAnySig * 100).toFixed(1)}%`,
          /** 本实验在家族里的位置 */
          ownP: mine?.p ?? null,
          ownPText: mine ? pv(mine.p) : null,
          ownPHolm: mine?.pHolm ?? null,
          ownPHolmText: mine ? pv(mine.pHolm) : null,
          ownHolmSig: mine?.holmSig ?? null,
          ownRescinded: mine?.rescinded ?? null,
          /** 校正只标清单，不改 decision —— 回答里必须说清 */
          affectsDecision: false,
          top: family.rows
            .slice()
            .sort((x, y) => x.p - y.p)
            .slice(0, 8)
            .map((r) => ({ id: r.id, p: r.p, pHolm: r.pHolm, holmSig: r.holmSig })),
        },
        cites: cite(a, 'metric', '序贯'),
      };
    }

    case 'loss_decide': {
      // 「该不该上」不是「显不显著」。两个参数（风险厌恶 k、最小值得上线的 MMP）都由调用方给，
      // 缺省用文档里的默认值；**必须把参数回显**，否则同一句话会随默认值变化而失去可复现性。
      const unit = a.primary.unit;
      const base = defaultLoss(unit);
      const k = typeof args.riskAversion === 'number' ? args.riskAversion : base.riskAversion;
      const mmp = typeof args.mmp === 'number' ? args.mmp : base.mmp;
      const d = expectedLoss(a.primary.diff, a.primary.se, unit, { riskAversion: k, mmp });
      const gate = applyGates(d.action, a.reasonCode);
      const ACTION_CN: Record<string, string> = {
        ship: '建议上线',
        'no-ship': '不值得上线',
        indistinguishable: '分不出高下',
      };
      return {
        tool: name,
        args,
        summary:
          `主指标 ${fmtDiff(a.primary.diff, unit)}、SE ${fmtDiff(a.primary.se, unit)}；` +
          `在 k=${k}、MMP=${fmtDiff(mmp, unit)} 下净价值 ${fmtDiff(d.netAfterMmp, unit)} → ${ACTION_CN[gate.action]}` +
          (gate.vetoed ? `（但被 ${gate.vetoCode} 否决）` : ''),
        data: {
          available: true,
          unit,
          /** 参数必须回显：结论依赖它们，藏起来就变成"引擎有个正确答案" */
          riskAversion: k,
          riskAversionText: `${k}×`,
          mmp,
          mmpText: fmtDiff(mmp, unit),
          diff: a.primary.diff,
          diffText: fmtDiff(a.primary.diff, unit),
          se: a.primary.se,
          seText: fmtDiff(a.primary.se, unit),
          /** 两笔账：上线能拿到的期望收益 / 要冒的期望损失（乘 k 之后才是代价） */
          eGain: d.eGain,
          eGainText: fmtDiff(d.eGain, unit),
          eHarm: d.eHarm,
          eHarmText: fmtDiff(d.eHarm, unit),
          eHarmWeightedText: fmtDiff(-k * d.eHarm, unit),
          netValue: d.netValue,
          netValueText: fmtDiff(d.netValue, unit),
          netAfterMmp: d.netAfterMmp,
          netAfterMmpText: fmtDiff(d.netAfterMmp, unit),
          /** 净价值层自己的结论（门禁之前） */
          rawAction: d.action,
          rawActionText: ACTION_CN[d.action],
          /** 门禁 + 建议之后的最终建议 */
          action: gate.action,
          actionText: ACTION_CN[gate.action],
          vetoed: gate.vetoed,
          vetoCode: gate.vetoCode,
          vetoReason: gate.vetoReason,
          cautionCode: gate.cautionCode,
          caution: gate.caution,
          /** 等价点：真实效应高于它才划算；gap 用 SE 计量，便于和"几个 sigma"对照 */
          breakEvenDiff: d.breakEvenDiff,
          breakEvenDiffText: fmtDiff(d.breakEvenDiff, unit),
          breakEvenGapSe: d.breakEvenGapSe,
          breakEvenGapText: `${d.breakEvenGapSe.toFixed(2)} 个 SE`,
          /** k=1 时的等价点 = MMP：给"不厌恶风险时门槛在哪"做对账 */
          breakEvenIfNeutral: d.breakEvenIfNeutral,
          breakEvenIfNeutralText: fmtDiff(d.breakEvenIfNeutral, unit),
          /** 两个参数的含义必须能原样念给用户听 */
          paramsNote: `k=1 时这条规则等价于「点估计 > MMP 就上线」；k=${k} 时负向效应被放大 ${k} 倍`,
          gates: Object.keys(LOSS_GATES),
          cautions: Object.keys(LOSS_CAUTIONS),
          /** 与 heterogeneity / sequential / novelty / fwer 一样，只出建议，不改 decision */
          affectsDecision: false,
        },
        cites: cite(a, 'metric', '期望损失'),
      };
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}

/** 给 LLM 的工具描述（OpenAI function-calling 格式） */
export const TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'get_overview',
      description: '读取当前实验的结论：决策、命中的规则、理由与关键数字',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_test',
      description: '重新计算主指标的两比例 z 检验，返回转化率、差值、95% CI、p 值',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'segment_breakdown',
      description: '按维度扫描分层效应（新老用户 / 设备），返回各层差值与 BH 校正后的 q 值',
      parameters: {
        type: 'object',
        properties: { dimension: { type: 'string', enum: ['tenure', 'device'] } },
        required: ['dimension'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_guardrails',
      description: '检查护栏指标（退款率、投诉率、P95 延迟）是否恶化，以及是否参与决策',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'compute_mde',
      description: '在给定基线与每组样本量下推算 MDE（最小可检出差异）与当前功效',
      parameters: {
        type: 'object',
        properties: {
          baseline: { type: 'number', description: '基线转化率（0-1），默认取 control' },
          nPerArm: { type: 'number', description: '每组样本量，默认取现有样本' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'forecast_days',
      description:
        '预测「还要跑几天」才能下结论：给出预计天数（50% / 80% 把握）、跑满预测期仍等不到显著性的概率、以及所需样本量。流量从日表实算，口径与当前决策一致',
      parameters: {
        type: 'object',
        properties: {
          horizonDays: { type: 'number', description: '最多往后预测多少天，默认 30' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_similar',
      description: '按实验类型或主指标检索相似实验，用于横向对比',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_experiments',
      description: '按决策、实验类型或关键词检索实验列表',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['ship', 'no-ship', 'iterate', 'inconclusive'] },
          archetype: { type: 'string' },
          keyword: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'explain_rules',
      description: '回溯判定规则：6 条规则的顺序、条件、是否命中',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bayesian_view',
      description:
        '贝叶斯视角：用 Beta-Binomial 后验给出 treatment 优于 control 的概率（P(B>A)）、95% 可信区间与期望损失（若误判上线的平均损失）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'metric_decompose',
      description:
        '把 ARPU 的变化拆成「转化率 × 客单价」两块的贡献（另加交叉项），三块严格相加等于总差值。用于回答「ARPU 涨了是因为买的人多了还是买得更贵了」。数据没有收入字段时会返回 available=false',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'metric_dictionary',
      description:
        '查口径字典：所有已登记指标的定义、方向、单位、计算式、统计方法与护栏容忍度。只能引用字典里存在的指标，字典里没有的必须说明没有，不得自行定义',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', description: '要查的指标名（如「退款率」）；留空则返回全部' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'peeking_check',
      description: '序贯监控：如果每天都在看同一份看板，现在这一次观察需要多严的阈值才算显著（OBF / always-valid p）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'novelty_check',
      description: '新颖效应：按曝光量把观察期对半切，检验后半段效应是否显著低于（或高于）前半段，并给出可检出的最小衰减',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fwer_check',
      description: '多重比较校正（Holm/Bonferroni/BH）：把全部实验当一个家族，返回校正后还有几个显著、本实验校正后的 p',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'loss_decide',
      description:
        '期望损失决策：在给定的风险厌恶系数与最小值得上线的提升下，算出「上线」相对「不上线」的期望净价值，并给出等价点与硬门禁否决结果',
      parameters: {
        type: 'object',
        properties: {
          riskAversion: { type: 'number', description: '风险厌恶系数 k（≥1，默认 2）' },
          mmp: { type: 'number', description: '最小值得上线的提升（效应单位，默认率 0.001 / ARPU 0.02）' },
        },
        required: [],
      },
    },
  },
];

export const TOOL_NAMES = TOOL_SCHEMA.map((t) => t.function.name) as ToolName[];
