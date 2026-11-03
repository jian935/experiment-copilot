import { auditNumbers, buildWhitelist } from './audit.ts';
import { runTool } from './tools.ts';
import { METRIC_LABELS } from '../metrics.ts';
import { MEMORY_DECISION_LABEL, type MemoryDecisionKind } from './memory.ts';
import type { AgentCtx, AgentReply, AgentTurn, ToolCall } from './types.ts';

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
const pp = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}pp`;
const pv = (p: number) => (p < 1e-16 ? '<1e-16' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));

type Unit = 'pp' | '元';
const fmtDiff = (v: number, unit: Unit, d = 2) => (unit === '元' ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}元` : pp(v, d));
const fmtLevel = (v: number, unit: Unit, d = 2) => (unit === '元' ? `${v.toFixed(d)}元` : pct(v, d));

const DECISION_CN: Record<string, string> = {
  ship: '建议上线',
  'no-ship': '不建议上线',
  iterate: '定向上线',
  inconclusive: '无法下结论',
};

function citeOf(ctx: AgentCtx, kind: 'metric' | 'decision' | 'srm' | 'guardrail' | 'segment'): string[] {
  return ctx.analysis.evidence.filter((e) => e.kind === kind).map((e) => e.id);
}

function citesOf(calls: ToolCall[]): string[] {
  const seen = new Set<string>();
  for (const c of calls) for (const id of c.cites) seen.add(id);
  return [...seen];
}

/** 贝叶斯视角一句话（带 metric 引用，便于审计溯源） */
function bayesLine(ctx: AgentCtx): { call: ToolCall; text: string } {
  const b = runTool('bayesian_view', ctx);
  const d = b.data as { probPct: number; credText: string; unit: string; posterior: string };
  const text =
    `贝叶斯视角（${d.posterior === 'normal' ? '正态' : 'Beta'}后验）：treatment 有 ${d.probPct}% 的概率优于 control` +
    `（95% 可信区间 ${d.credText}）`;
  return { call: b, text: withCites(text, b.cites) };
}

function withCites(text: string, ids: string[]): string {
  return ids.length ? `${text.replace(/[。；]$/, '')} [${ids.join('][')}]。` : text;
}

interface IntentDef {
  key: string;
  test: RegExp;
  run: (ctx: AgentCtx) => { calls: ToolCall[]; text: string };
}

const INTENTS: IntentDef[] = [
  {
    key: 'list',
    test: /哪些|列出|有几个|有多少|被拦|拦截|全量/,
    run: (ctx) => {
      const wantNoShip = /拦|不上|拒绝|no-ship|坏/.test(ctx.question ?? '');
      const l = runTool('list_experiments', ctx, wantNoShip ? { decision: 'no-ship' } : {});
      const rows = l.data as { id: string; name: string; decision: string }[];
      const byDecision = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.decision] = (acc[r.decision] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(byDecision)
        .map(([k, v]) => `${DECISION_CN[k] ?? k} ${v} 个`)
        .join('、');
      return {
        calls: [l],
        text: `检索到 ${rows.length} 个实验（${summary}），例如 ${rows
          .slice(0, 5)
          .map((r) => `${r.id} ${r.name}`)
          .join('、')}${rows.length > 5 ? ' 等' : ''}。需要我打开其中某一个看证据链吗？`,
      };
    },
  },

  {
    key: 'metric_scope',
    // 注意：ARPU 已经登记进口径字典，不再属于「字典外指标」。
    // 这里只兜住真正没登记的东西（GMV / 留存 / DAU / CTR…），
    // 否则会把「已经算过的指标」也拒答掉，那是比答错更糟的体验。
    test: /gmv|交易额|成交额|留存|retention|dau|mau|日活|月活|ctr|点击率|付费率/i,
    run: (ctx) => {
      // 以口径字典为唯一真源：字典里没有的指标一律拒答，不在代码里另维护一份"已知指标"清单
      const q = ctx.question ?? '';
      const asked = q.match(/gmv|交易额|成交额|留存|retention|dau|mau|日活|月活|ctr|点击率|付费率/i)?.[0] ?? '这个指标';
      const registered = METRIC_LABELS.join('、');
      const cites = citeOf(ctx, 'metric');
      return {
        calls: [runTool('get_overview', ctx)],
        text:
          withCites(
            `「${asked}」不在口径字典里（已登记的只有 ${registered}），引擎没有算过它，所以我答不了它提升了多少——我不能替你定义一个口径，也不能从转化率类推`,
            cites,
          ) + `如果确实要评估 ${asked}，需要先在数据里补上对应字段并登记进口径字典，或者用一个以它为指标的实验。`,
      };
    },
  },

  {
    key: 'decompose',
    test: /分解|客单价|aov|是转化率还是|涨在哪|靠什么|为什么.*(涨|跌|提升|下降|变化)|收入.*(涨|跌|变)/,
    run: (ctx) => {
      const dec = runTool('metric_decompose', ctx);
      const d = dec.data as {
        available: boolean;
        reason?: string;
        totalText?: string;
        fromCvrText?: string;
        fromAovText?: string;
        fromInteractionText?: string;
        cvrText?: string;
        aovText?: string;
        dominant?: string;
        oppositeSigns?: boolean;
      };
      if (!d.available) {
        return {
          calls: [dec],
          text: `这份数据没有收入字段（${d.reason}），所以 ARPU 和客单价都算不出来——我不能用转化率去推一个没有采集过的口径`,
        };
      }
      const head =
        `ARPU 变化 ${d.totalText} 可以拆成两块：转化率 ${d.cvrText}（贡献 ${d.fromCvrText}）、` +
        `客单价 ${d.aovText}（贡献 ${d.fromAovText}），交叉项 ${d.fromInteractionText}`;
      const tail = d.oppositeSigns
        ? `两块方向相反——只看 ARPU 总量会以为「没什么变化」，实际是「更多人买」和「单笔更便宜」在互相抵消，业务上该按两条线分别判断。`
        : `主要由${d.dominant}驱动，两块同向，不存在互相抵消。`;
      return { calls: [dec], text: `${withCites(head, dec.cites)}${tail}` };
    },
  },

  {
    key: 'guardrail',
    test: /护栏|退款|投诉|延迟|风险|副作用|伤害|代价/,
    run: (ctx) => {
      const g = runTool('check_guardrails', ctx);
      const o = runTool('get_overview', ctx);
      const rows = g.data as { label: string; diff: number; p: number; worse: boolean; gating: boolean; key: string; control: number; treatment: number }[];
      const hard = rows.find((r) => r.gating);
      const parts: string[] = [];
      if (hard) {
        parts.push(
          `${hard.label}从 ${pct(hard.control)} 升到 ${pct(hard.treatment)}，变化 ${pp(hard.diff)}，p=${pv(hard.p)}`,
        );
      }
      const others = rows.filter((r) => !r.gating && r.key !== 'latency_p95');
      if (others.length) {
        parts.push(others.map((r) => `${r.label} ${pp(r.diff)}（p=${pv(r.p)}，仅展示不拦截）`).join('；'));
      }
      const verdict = (o.data as { decision: string; reasonCode: string }).decision;
      const tail =
        verdict === 'no-ship'
          ? `硬护栏不通过，按规则不能上线，即使主指标是正向的——结论是「${DECISION_CN[verdict]}」。`
          : `硬护栏未触发恶化，所以护栏没有拦住这个实验；当前结论是「${DECISION_CN[verdict]}」。`;
      return {
        calls: [g, o],
        text: `${withCites(`护栏检查：${parts.join('；')}`, g.cites)}${tail}`,
      };
    },
  },

  {
    key: 'peek',
    // 这条意图的存在本身就是产品立场：多数工具只会回答「现在显不显著」，
    // 而真实的人每天都在刷新看板。不把「看了几次」算进阈值，就等于默许 p-hacking。
    test: /偷看|窥探|序贯|看了几次|看上?了几次|每天都(在)?看|peek|always.?valid|现在(能|可以).{0,4}(下结论|宣布|上线)/i,
    run: (ctx) => {
      const t = runTool('peeking_check', ctx);
      const d = t.data as {
        available: boolean;
        reason?: string;
        looks: number;
        finalPBoundaryText: string;
        finalPNaiveText: string;
        finalPAlwaysText: string;
        zText: string;
        zBoundaryText: string;
        tightening: number;
        naiveSig: boolean;
        obfSig: boolean;
        obfCrossDay: number | null;
        obfSigNow: boolean;
        minAlwaysPText: string;
      };
      if (!d.available) {
        return {
          calls: [t],
          text: `这份数据没法做序贯校正（${d.reason}）——没有逐日明细就谈不上「看了几次」，我不能凭一个总 p 值反推窥探次数。`,
        };
      }
      const head =
        `这份看板你已经在 ${d.looks} 次观察里看过同一份数据（每次都是累计口径）。` +
        `按 OBF α 消耗，最后一次要 p<${d.finalPBoundaryText} 才算显著，比 naive 的 5% 紧 ${d.tightening.toFixed(2)} 倍`;
      const verdict = d.obfSig && d.obfSigNow
        ? `当前 |z|=${d.zText} 已越过该次边界 ${d.zBoundaryText}，序贯口径下也显著。`
        : d.obfCrossDay
          ? `第 ${d.obfCrossDay} 次观察曾越过边界（当时就该停下并宣布）；此刻 |z|=${d.zText} 已回落到边界 ${d.zBoundaryText} 之下，「等它涨回来再看」不算数。`
          : d.naiveSig
          ? `当前 naive p=${d.finalPNaiveText} 看着过了 0.05，但 |z|=${d.zText} 还没越过边界 ${d.zBoundaryText}——这正是「偷看把不显著看成显著」的样子，先别宣布。`
          : `当前 naive p=${d.finalPNaiveText}，本来就不显著；继续看不会受罚（OBF 只收紧阈值，不禁止继续观察）。`;
      return {
        calls: [t],
        text: `${withCites(head, t.cites)}${verdict}想「随时都能看」就得改用 always-valid p=${d.minAlwaysPText}（全程最小），代价是门槛抬到约 3σ。`,
      };
    },
  },

  {
    key: 'novelty',
    // 「第一天有效、第五天打脸」是上线后最常见的翻车方式，而所有看板都只显示累计值。
    // 这条意图专门回答「这个效果会不会缩水」，并且必须把「看不出来的最小幅度」一起说。
    test: /衰减|新颖效应|新奇|novelty|时效|时间维度|前(半|后)(段|几)|后几(天|日)|效果.{0,6}(会不会|是否).{0,6}(变|降|缩|掉)|还(在不在|剩多少)|继续(有效|管用)|掉下来|逐渐(变|降)/i,
    run: (ctx) => {
      const t = runTool('novelty_check', ctx);
      const d = t.data as {
        available: boolean;
        reason?: string;
        pattern: string;
        patternText: string;
        earlyDiffText: string;
        earlyDays: number;
        lateDiffText: string;
        lateDays: number;
        deltaText: string;
        pText: string;
        tText: string;
        dfText: string;
        relativeDeltaText: string;
        detectableDeltaText: string;
      };
      if (!d.available) {
        return {
          calls: [t],
          text: `这份数据做不了衰减判定（${d.reason}）——没有逐日明细就没法把前后半段分开估，我不能拿一个总差值去猜时间趋势。`,
        };
      }
      const head =
        `按曝光量对半切：前半段 ${d.earlyDays} 天 ${d.earlyDiffText}，后半段 ${d.lateDays} 天 ${d.lateDiffText}，` +
        `前后差 ${d.deltaText}（t=${d.tText}，ν=${d.dfText}，p=${d.pText}）`;
      const tail =
        d.pattern === 'decay'
          ? `后半段明显变弱，相对变化 ${d.relativeDeltaText}——累计曲线会把这件事平均掉，所以「整体有效」不代表下一周还站得住。`
          : d.pattern === 'growth'
            ? '后半段明显更强，可能是爬坡期（缓存预热、用户学习），说明现在的累计值还偏低。'
            : `判「未见衰减」，但这不是「没有衰减」：小于 ±${d.detectableDeltaText} 的衰减这个样本量看不出来。`;
      return {
        calls: [t],
        text: `${withCites(head, t.cites)}${tail}这项只做检测、不改结论（真值标注按主指标 + 护栏口径）。`,
      };
    },
  },

  {
    key: 'fwer',
    // 「扫一遍 120 个实验，挑出显著的」这一步本身就是多重比较。
    // 不校正的话，全零族下"至少一个显著"的概率是 99.8%——这题必须把算术摆出来。
    test: /多重比较|全局校正|族错误|fwer|holm|bonferroni|一起看|看一遍|全部实验|所有实验|校正后|总有一个/i,
    run: (ctx) => {
      const t = runTool('fwer_check', ctx);
      const d = t.data as {
        available: boolean;
        n: number;
        naiveSig: number;
        holmSig: number;
        bonferroniSig: number;
        bhSig: number;
        fdr: number;
        rescinded: number;
        rescindedFalse: number | null;
        naiveAnySigText: string;
        ownPText: string | null;
        ownPHolmText: string | null;
        ownHolmSig: boolean | null;
        ownRescinded: boolean | null;
      };
      if (!d.available) {
        return { calls: [t], text: '只有这一个实验，谈不上多重比较——校正是在「一起看很多个」的时候才需要的。' };
      }
      const head =
        `把 ${d.n} 个实验当成一个家族一起看：naive 口径有 ${d.naiveSig} 个显著，` +
        `Holm 校正后 ${d.holmSig} 个（Bonferroni ${d.bonferroniSig} 个，BH(q=${d.fdr}) ${d.bhSig} 个），` +
        `一共收回 ${d.rescinded} 条` +
        (d.rescindedFalse !== null ? `（其中 ${d.rescindedFalse} 条注入效应为 0，本就该收回）` : '');
      // 注意：这里不能再写「1−0.95^n」这种字面公式——数字审计只认引擎/工具返回过的数字，
      // 字面常量在大多数实验上恰好撞上白名单里的某个值，于是"看起来没问题"，
      // 直到某个实验的白名单里没这个值才报出来（E093 就是这样被抓到的）。
      const why =
        `全零假设下「至少一个显著」的概率是 ${d.naiveAnySigText}——` +
        `「总有一个能上线」不是运气，是算术。`;
      const mine =
        d.ownPHolmText === null
          ? ''
          : d.ownHolmSig
            ? `本实验 p=${d.ownPText}，校正后 ${d.ownPHolmText}，仍然显著。`
            : `本实验 p=${d.ownPText}，校正后 ${d.ownPHolmText}${d.ownRescinded ? '——属于「单看不显著、校正后更不显著」的那一类' : ''}，不能算数。`;
      return {
        calls: [t],
        text: `${withCites(head, t.cites)}${why}${mine}校正只标在清单上，不改任何单个实验的结论（决策仍按单实验口径 + 护栏判）。`,
      };
    },
  },

  {
    key: 'loss',
    // 「显不显著」和「该不该上」是两个问题。这条意图回答后者：
    // 在你声明的成本下，上线相对不上线值多少。必须把 k 与 MMP 一起念出来，
    // 否则同一句话换个默认参数就不成立。
    test: /该不该上|值不值得上|值不值(得)?上|要不要上|期望损失|期望价值|决策论|期望净价值|划不划算|划算吗|亏不亏|风险厌恶|mmp|最小值得|上线(能|会|要)?(赚|亏)|成本.{0,6}(多|几)/i,
    run: (ctx) => {
      const t = runTool('loss_decide', ctx);
      const d = t.data as {
        unit: Unit;
        riskAversionText: string;
        mmpText: string;
        diffText: string;
        eGainText: string;
        eHarmWeightedText: string;
        netAfterMmpText: string;
        actionText: string;
        rawActionText: string;
        vetoed: boolean;
        vetoCode: string | null;
        vetoReason: string | null;
        caution: string | null;
        breakEvenDiffText: string;
        breakEvenGapText: string;
        breakEvenIfNeutralText: string;
      };
      const head =
        `主指标 ${d.diffText}，按 k=${d.riskAversionText}、MMP=${d.mmpText} 算：` +
        `上线能拿到 ${d.eGainText} 的期望收益、要冒 ${d.eHarmWeightedText} 的期望损失，` +
        `扣掉 MMP 后净价值 ${d.netAfterMmpText} → ${d.rawActionText}`;
      const gate = d.vetoed
        ? `但这条被 ${d.vetoCode} 否决了（${d.vetoReason}）——护栏是约束，不能拿主指标收益去抵，所以最终结论是${d.actionText}。`
        : d.caution
          ? `不过要补一句：${d.caution}。`
          : '';
      const tail =
        `等价点是 ${d.breakEvenDiffText}：真实效应得高于它才划算，现在离它 ${d.breakEvenGapText}。` +
        `如果把 k 调成 1（完全不厌恶风险），等价点会掉到 ${d.breakEvenIfNeutralText}，规则就退化成「点估计超过它就上线」——` +
        `所以这个判断的价值全在 k 大于 1 和 MMP 大于 0 这两件事上，参数不同结论就不同。`;
      return {
        calls: [t],
        text: `${withCites(head, t.cites)}${gate}${tail}这只给建议、不改结论（决策口径仍按主指标 + 护栏的标准判）。`,
      };
    },
  },

  {
    key: 'segment',
    test: /分层|新老|用户群|人群|设备|ios|安卓|哪类|细分|异质|个体差异/i,
    run: (ctx) => {
      const dim = /设备|ios|安卓/i.test(ctx.question ?? '') ? 'device' : 'tenure';
      const t = runTool('segment_breakdown', ctx, { dimension: dim });
      const d = runTool('segment_breakdown', ctx, { dimension: 'device' });
      const { rows, interaction, unit } = t.data as {
        rows: { label: string; diff: number; diffText: string; p: number; q: number }[];
        interaction: { diffDiff: number; p: number } | null;
        unit: Unit;
      };
      const sig = rows.filter((r) => r.q <= 0.1);
      const head = rows.map((r) => `${r.label} ${r.diffText}（q=${r.q.toFixed(3)}）`).join('、');
      const interactionText = interaction
        ? `两层效应差 ${fmtDiff(interaction.diffDiff, unit)}，交互检验 p=${pv(interaction.p)}${interaction.p < 0.01 ? '，说明差异不是噪声' : '，差异可能来自抽样波动'}`
        : '';
      const hetero = ctx.analysis.reasonCode === 'HETEROGENEOUS';
      const tail = hetero
        ? '所以这个实验的正确动作不是「上线/不上线」，而是只对有效的那一层放开。'
        : sig.length === rows.length
          ? '两层方向一致，说明效应是整体的，不是某一类人专属。'
          : '两层里有的显著有的不显著，建议按分层再跑一轮更大的样本。';
      return {
        calls: [t, d],
        text: `${withCites(`按新老分层：${head}`, t.cites)}${interactionText ? `${withCites(interactionText, t.cites)}` : ''}${tail}`,
      };
    },
  },

  {
    key: 'metric',
    test: /口径|指标定义|怎么算|如何计算|什么是.*率|字典/,
    run: (ctx) => {
      const d = runTool('metric_dictionary', ctx, { metric: ctx.question ?? '' });
      const data = d.data as {
        known: { key: string; label: string; formula: string; directionLabel: string; unit: string; method: string; guardrailMargin: number | null }[];
        matched: string[];
        unknownMention: boolean;
      };
      const hit = data.known.filter((m) => data.matched.includes(m.key));
      const list = hit.length ? hit : data.known;
      const lines = list
        .map(
          (m) =>
            `${m.label}（${m.directionLabel}）：${m.formula}；统计方法 ${m.method}` +
            (m.guardrailMargin !== null ? `；护栏容忍度 ${m.unit === 'ms' ? `+${(m.guardrailMargin * 100).toFixed(0)}%` : `${(m.guardrailMargin * 100).toFixed(2)}pp`}` : ''),
        )
        .join('；');
      const head = hit.length
        ? `口径字典里命中 ${hit.length} 个：${lines}`
        : `口径字典共登记 ${data.known.length} 个指标：${lines}`;
      const tail = data.unknownMention
        ? ' 你问的指标不在口径字典里，引擎没有算过它，我不能替你定义——需要的话先把字段加进数据再说。'
        : '';
      return { calls: [d], text: `${withCites(head, d.cites)}${tail}` };
    },
  },

  {
    key: 'rules',
    test: /为什么|凭什么|规则|判定|怎么得出|结论是|不能上|不该上|不建议|依据/,
    run: (ctx) => {
      const r = runTool('explain_rules', ctx);
      const o = runTool('get_overview', ctx);
      const rules = r.data as { code: string; condition: string; hit: boolean; detail: string }[];
      const idx = rules.findIndex((x) => x.code === ctx.analysis.reasonCode);
      const hit = rules[idx];
      const passing = rules.slice(0, idx).map((x) => x.code);
      const head = `引擎按固定优先级逐条判断，第 ${idx + 1} 条「${hit.code}」先命中（条件：${hit.condition}）`;
      const passed = passing.length ? `它前面的 ${passing.join('、')} 都没有触发，` : '';
      const body = `${passed}命中依据是 ${hit.detail}。`;
      const p = ctx.analysis.primary;
      const bayes = bayesLine(ctx);
      return {
        calls: [r, o, bayes.call],
        text: `${withCites(head, r.cites)}${withCites(
          `主指标 ${p.label} ${fmtDiff(p.diff, p.unit)}（p=${pv(p.p)}，95% CI ${fmtDiff(p.ci95[0], p.unit)} ~ ${fmtDiff(p.ci95[1], p.unit)}）`,
          runTool('run_test', ctx).cites,
        )}${body}${bayes.text}`,
      };
    },
  },

  {
    key: 'mde',
    test: /样本|mde|功效|power|够不够|需要多少|样本量|检不出/,
    run: (ctx) => {
      const m = runTool('compute_mde', ctx);
      const d = m.data as {
        metricKind: 'rate' | 'continuous';
        baseline?: number;
        nPerArm: number;
        mde: number;
        mdeText: string;
        power: number;
        observedDiff: number;
        observedDiffText: string;
      };
      const enough = Math.abs(d.observedDiff) >= d.mde;
      const context =
        d.metricKind === 'continuous'
          ? `按每组 ${d.nPerArm.toLocaleString('en-US')} 个样本、当前标准误算，80% 功效的最小可检出 ARPU 差异是 ${d.mdeText}`
          : `按每组 ${d.nPerArm.toLocaleString('en-US')} 个样本、基线 ${pct(d.baseline ?? 0)}（α=0.05、功效 80%）算，最小可检出差异是 ${d.mdeText}`;
      return {
        calls: [m],
        text: `${withCites(context, m.cites)}${
          enough
            ? `本次观测到的 ${d.observedDiffText} 大于这个门槛，所以「没效果」不是样本不足造成的。`
            : `本次观测到的 ${d.observedDiffText} 小于这个门槛，因此「不显著」有可能只是样本不够，不能当作「无效」的证据。`
        }`,
      };
    },
  },

  {
    key: 'forecast',
    test: /还要.*(几天|多久)|跑多久|多久才(能|会)|需要.*(几天|多久)|什么时候.*(结束|结论)|预计.*(结束|完成|多久)|结束时间|还要等|再跑多久/,
    run: (ctx) => {
      const fc = runTool('forecast_days', ctx);
      const d = fc.data as {
        verdictCode: 'done' | 'eta' | 'unlikely';
        horizonDays: number;
        medianDays: number | null;
        p20Days: number | null;
        p80Days: number | null;
        stuckPP: number;
        requiredNPerArm: number | null;
        mdeNowText: string;
        mdeAtHorizonText: string;
        p: number;
        via: string;
      };
      if (d.verdictCode === 'done') {
        return {
          calls: [fc],
          text: withCites(
            `已经能下结论了（主指标检验的 p=${pv(d.p)}），不用再等——继续跑只会让区间更窄，不会改变判定`,
            fc.cites,
          ),
        };
      }
      if (d.verdictCode === 'unlikely' || d.medianDays === null) {
        return {
          calls: [fc],
          text: withCites(
            `按当前效应和流量，跑到第 ${d.horizonDays} 天仍有 ${d.stuckPP}% 的模拟等不到显著性。` +
              `这通常说明真实效应小到不值得为它继续投入流量：更该做的是按「无实质差异」收尾，或者改设计再跑一轮`,
            fc.cites,
          ),
        };
      }
      const samples =
        d.requiredNPerArm !== null
          ? `按现在这点效应，每组需要 ${d.requiredNPerArm.toLocaleString('en-US')} 个样本才算得出来；`
          : '';
      return {
        calls: [fc],
        text:
          withCites(
            `预计第 ${d.medianDays} 天能下结论，第 ${d.p80Days ?? '—'} 天有 80% 把握（20% 分位是第 ${d.p20Days ?? '—'} 天）；` +
              samples +
              `同期可检出的最小差异会从 ${d.mdeNowText} 收窄到 ${d.mdeAtHorizonText}`,
            fc.cites,
          ) +
          `这个预测用的是${d.via === 'cuped' ? 'CUPED 调整后' : '当前'}的差值与标准误，前提是流量和效应都不变。`,
      };
    },
  },

  {
    key: 'similar',
    test: /类似|相似|历史|其他实验|横向|对比|同类/,
    run: (ctx) => {
      const s = runTool('find_similar', ctx, { limit: 5 });
      const rows = s.data as { id: string; name: string; decision: string; diffText: string; primaryMetric: string }[];
      const text = rows.length
        ? `同类实验有 ${rows.length} 个：${rows
            .map((r) => `${r.id} ${r.name}（${DECISION_CN[r.decision]}，${r.primaryMetric} ${r.diffText}）`)
            .join('；')}。它们在同一个引擎下走的是同一套规则，可以直接横向看。`
        : '数据集中没有主指标或类型相同的实验，暂时无法横向对比。';
      return { calls: [s], text };
    },
  },

  {
    key: 'recall',
    // 记忆层入口（M18）：只认「问历史判决」的问法，避免和相似实验检索（也含「历史」一词）抢。
    // 题库题「我之前对这个实验怎么判的」必须命这里；其余检索类问法不含这些词，不会误触。
    test: /之前|上次|当初|记得|已经判|判过|怎么判|如何判|决定过/,
    run: (ctx) => {
      const fc = runTool('recall_decision', ctx);
      const d = fc.data as {
        hasDecision: boolean;
        decision?: MemoryDecisionKind;
        note?: string;
        decidedAt?: string;
        engineDecision?: string | null;
        contradicts?: boolean;
      };
      const text = d.hasDecision
        ? `你于 ${d.decidedAt!.slice(0, 10)} 对该实验判了「${MEMORY_DECISION_LABEL[d.decision!]}」。${
            d.engineDecision ? `引擎当时的结论是 ${d.engineDecision}。` : ''
          }${d.note ? `当时的理由是：${d.note}。` : ''}${
            d.contradicts
              ? '你的判决和引擎结论不一致——这条留痕就是把「人做过判断」冻结下来，复盘看理由而不是 p 值。'
              : ''
          }`
        : '你还没有对这个实验下过人工决定。决策留痕只存在你本机浏览器，不上传、不进评测、不进任何公开产物——换机器或清缓存就看不到了。';
      return { calls: [fc], text };
    },
  },

  {
    key: 'test',
    test: /显著|有效|效果|提升|转化|p ?值|差值|置信|区间/,
    run: (ctx) => {
      const t = runTool('run_test', ctx);
      const a = ctx.analysis;
      const p = a.primary;
      const srm = a.srm;
      const sig = p.p < 0.05;
      const bayes = bayesLine(ctx);
      // 主指标是 ARPU 时，顺手把转化率口径也报一句：两者同源，读者会问「那转化率呢」
      const cross =
        p.kind === 'continuous'
          ? `同期支付转化率 ${pct(a.overall.controlRate, 3)} → ${pct(a.overall.treatmentRate, 3)}（${pp(a.overall.diff)}，p=${pv(a.overall.p)}），作为交叉验证。`
          : '';
      return {
        calls: [t, bayes.call],
        text:
          withCites(
            `主指标 ${p.label}：${fmtLevel(p.controlValue, p.unit, 3)} → ${fmtLevel(p.treatmentValue, p.unit, 3)}，差值 ${fmtDiff(p.diff, p.unit)}，95% CI ${fmtDiff(p.ci95[0], p.unit)} ~ ${fmtDiff(p.ci95[1], p.unit)}，p=${pv(p.p)}`,
            t.cites,
          ) +
          (sig
            ? `区间不跨 0，差异在统计上成立（SRM 相对偏差 ${(srm.relImb * 100).toFixed(2)}%，分流正常）。`
            : `区间跨过 0，这点差异还不足以说明有效果——更准确的说法是「没能证明有差异」。`) +
          cross +
          bayes.text,
      };
    },
  },
];

const FALLBACK: IntentDef = {
  key: 'overview',
  test: /.^/,
  run: (ctx) => {
    const o = runTool('get_overview', ctx);
    const t = runTool('run_test', ctx);
    const bayes = bayesLine(ctx);
    const data = o.data as { decision: string; reasonCode: string; reason: string };
    const p = ctx.analysis.primary;
    return {
      calls: [o, t, bayes.call],
      text: `${withCites(
        `这个实验的结论是「${DECISION_CN[data.decision]}」，规则 ${data.reasonCode}`,
        o.cites,
      )}主指标 ${p.label} 差值 ${fmtDiff(p.diff, p.unit)}，p=${pv(p.p)}。${bayes.text}可以继续问我：为什么是这个结论、新老用户有没有差异、护栏有没有恶化、样本够不够、还要跑几天。`,
    };
  },
};

/** 意图的中文名：多轮补全时给用户看的「我把你这句话理解成了什么」 */
export const INTENT_LABEL: Record<string, string> = {
  test: '主指标是否显著',
  rules: '为什么是这个结论',
  guardrail: '护栏是否恶化',
  segment: '分层（新老 / 设备）差异',
  mde: '样本够不够',
  forecast: '还要跑几天',
  similar: '同类实验横向对比',
  list: '实验清单',
  metric: '指标口径',
  metric_scope: '指标是否在口径内',
  decompose: 'ARPU 因子分解',
  overview: '整体结论',
};

/** 「那…呢 / 还有呢 / 那它呢」这类省略式追问的特征 */
const REFER = /^(那|那么|还有|再|它|这个|那个|这|其|另外|换成|改成)/;
const NEXT_TOPIC = /^(还有|继续|然后|接着|另外|下一个|再讲)/;
const PUNCT = /[\s，。？！?、,.!~：:；;"'“”‘’（）()]/g;

/** 把省略式追问补成能命中意图的完整问题（只补关键词，不改写语义） */
const TOPIC_SEED: Record<string, string> = {
  test: '主指标 显著性 效果 差值',
  rules: '为什么 依据 判定规则',
  guardrail: '护栏 退款 投诉 延迟',
  segment: '分层 新老用户',
  mde: '样本 够不够 需要多少',
  forecast: '还要跑几天 预计多久',
  similar: '类似 对比 历史实验',
  list: '有哪些 列出',
  metric: '口径 指标定义 怎么算',
  metric_scope: '口径 指标定义',
  decompose: '分解 客单价 转化率贡献',
  overview: '结论',
};

/** 「还有呢 / 继续」时按这个顺序换下一个主题——都是 PM 会依次追问的东西 */
const TOPIC_CYCLE = ['test', 'rules', 'segment', 'guardrail', 'forecast', 'similar'];

export interface FollowUp {
  /** 用于路由的问题（可能被补全） */
  effective: string;
  rewritten: boolean;
  why?: string;
  from?: string;
}

/**
 * 规则模式的多轮补全。
 *
 * 原则：**只在「确实是省略式追问」时才动手**，且补全内容必须可解释。
 * - 完整句子一律按原样路由（「主指标显著吗」不会被改写）；
 * - 原文已经能命中某个意图就不动（否则「那退款率呢」会被错改成主指标）；
 * - 只有短句 + 指代/省略特征（「那新用户呢」「还有呢」「那它呢」）才补。
 *
 * 为什么用「补关键词」而不是真的做指代消解：规则模式没有语义模型，
 * 硬做指代只会猜错还说不清。补关键词是**可复现、可解释**的做法，
 * 猜错了用户能从「承接上文」那行提示里立刻看出来。
 */
export function resolveFollowUp(question: string, history?: AgentTurn[]): FollowUp {
  const q = question.trim();
  if (!history?.length) return { effective: q, rewritten: false };
  const stripped = q.replace(PUNCT, '');
  if (!stripped) return { effective: q, rewritten: false };

  const isNext = NEXT_TOPIC.test(q);
  const referential = REFER.test(q) || /呢[？?]?\s*$/.test(q);
  // 短句 + 省略特征才算追问；长句子按原样走（宁可少补，不可乱补）
  if (stripped.length > 10 || !(referential || isNext)) return { effective: q, rewritten: false };
  if (INTENTS.some((i) => i.test.test(q))) return { effective: q, rewritten: false };

  const lastIntent = [...history].reverse().find((t) => t.role === 'assistant' && t.intent)?.intent;

  // ① 带明确维度词 → 补成对应分层问法
  if (/新用户|老用户|新老|人群/.test(q)) {
    return { effective: '分层 新老用户', rewritten: true, why: '补成「按新老用户分层」', from: lastIntent };
  }
  if (/ios|安卓|设备|客户端|移动端|机型/i.test(q)) {
    return { effective: '分层 设备 iOS Android', rewritten: true, why: '补成「按设备分层」', from: lastIntent };
  }
  // ② 「还有呢 / 继续」→ 按主题环换下一个
  if (isNext) {
    const i = lastIntent ? TOPIC_CYCLE.indexOf(lastIntent) : -1;
    const key = TOPIC_CYCLE[(i + 1) % TOPIC_CYCLE.length];
    return {
      effective: TOPIC_SEED[key],
      rewritten: true,
      why: `接着上一轮往下问，切到「${INTENT_LABEL[key]}」`,
      from: lastIntent,
    };
  }
  // ③ 纯指代（「那它呢」）→ 沿用上一轮主题
  if (lastIntent && TOPIC_SEED[lastIntent]) {
    return {
      effective: TOPIC_SEED[lastIntent],
      rewritten: true,
      why: `沿用上一轮主题「${INTENT_LABEL[lastIntent] ?? lastIntent}」`,
      from: lastIntent,
    };
  }
  return { effective: q, rewritten: false };
}

/** 规则模式：不需要任何密钥，纯确定性路由与模板 */
export function answerQuestion(question: string, ctx: AgentCtx, history?: AgentTurn[]): AgentReply {
  const q = question.trim();
  const hist = history ?? ctx.history;
  const fu = resolveFollowUp(q, hist);
  const hit = INTENTS.find((i) => i.test.test(fu.effective)) ?? FALLBACK;
  // 注意：路由用补全后的 fu.effective，但模板读到的仍是用户原话（ctx.question）——
  // 像「有哪些被拦截的实验」这种要靠原文关键词选筛选条件的，不能被补全污染。
  const { calls, text } = hit.run({ ...ctx, question: q });
  const whitelist = buildWhitelist([ctx.analysis, ...calls.map((c) => c.data)]);
  const audit = auditNumbers(text, whitelist);
  return {
    text,
    intent: hit.key,
    calls,
    audit,
    by: 'rules',
    violations: violationsOf(text, calls, audit),
    ...(fu.rewritten
      ? {
          context: {
            effective: INTENT_LABEL[hit.key] ?? hit.key,
            why: fu.why ?? '',
            from: fu.from ? (INTENT_LABEL[fu.from] ?? fu.from) : '上一轮',
          },
        }
      : {}),
  };
}

/** 给 LLM 的 system prompt：5 条铁律 */
export function systemPrompt(ctx: AgentCtx): string {
  const a = ctx.analysis;
  return [
    '你是 Experiment Copilot（实验结论官），帮产品经理读懂一个 A/B 实验。',
    '铁律（必须遵守）：',
    '1. 不许自己算数。所有数值只能来自工具返回结果，禁止心算、禁止四舍五入改写、禁止推测未提供的数字。',
    '2. 每个数字后面必须带证据编号引用，格式如 [E2]；引用只能用工具返回的 cites 里的编号。',
    '3. 证据不足就说不知道：如果工具没有返回所需信息，直接说「这一点数据里没有」，不要编。',
    '4. 口径必须说清：每个差值都要带单位（百分点写 pp，ARPU 写元）。' +
      '主指标是 ARPU 时，支付转化率只是副指标，不能拿副指标当结论依据；反过来也一样。',
    '5. 不许编造历史实验或行业基准；需要对比时只能调用 find_similar / list_experiments。',
    '6. 数字照抄工具给的格式化字段（如 diffText / pText / summary / mdeNowText），小数最多两位；禁止把 16 位浮点原样写进回答。',
    `7. 只能引用口径字典里登记过的指标（${METRIC_LABELS.join('、')}）。用户问到字典外的指标（如 GMV、留存），` +
      '必须先说「这个指标不在口径字典里，引擎没算过」，禁止自行定义口径或换算。',
    '8. 多轮对话：历史消息只用来理解指代（「那新老用户呢」「还有呢」「它呢」），**不能当作证据来源**。' +
      '历史里出现过的数字必须重新调用工具确认后才能再写一次，禁止直接复述历史里的数字——' +
      '那些数字可能来自不同的实验或不同的口径。',
    '',
    `当前实验：${ctx.exp.id} ${ctx.exp.name}；主指标 ${a.primary.label}（${a.primary.kind === 'continuous' ? '连续指标，单位元' : '率指标，单位 pp'}）；数据为固定种子合成数据。`,
    `引擎结论：${a.decision}（规则 ${a.reasonCode}）。`,
    '回答用中文，简洁、结论先行，最多 5 句话。',
  ].join('\n');
}

/** 铁律自检：缺引用 / 出现无法溯源的数字，都要显式报出来 */
export function violationsOf(text: string, calls: ToolCall[], audit: { suspicious: string[] }): string[] {
  const v: string[] = [];
  // 只有当工具确实带回了证据（cites 非空）时，"必须引用"才有意义；
  // 跨实验检索（list_experiments / find_similar）本来就没有当前实验的证据可引。
  const hasCitable = calls.some((c) => c.cites.length > 0);
  if (hasCitable && !/\[E\d+\]/.test(text)) v.push('回答没有给出证据引用（应带 [E1] 这类标记）');
  if (audit.suspicious.length > 0) v.push(`出现 ${audit.suspicious.length} 个无法溯源的数字：${audit.suspicious.join('、')}`);
  return v;
}

export function replyFromLlm(
  text: string,
  calls: ToolCall[],
  ctx: AgentCtx,
  note?: string,
): AgentReply {
  const whitelist = buildWhitelist([ctx.analysis, ...calls.map((c) => c.data)]);
  const audit = auditNumbers(text, whitelist);
  return { text, intent: 'llm', calls, audit, by: 'llm', note, violations: violationsOf(text, calls, audit) };
}

export { citesOf };
