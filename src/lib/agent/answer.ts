import { auditNumbers, buildWhitelist } from './audit.ts';
import { runTool } from './tools.ts';
import type { AgentCtx, AgentReply, ToolCall } from './types.ts';

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
const pp = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}pp`;
const pv = (p: number) => (p < 1e-16 ? '<1e-16' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));

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
  const d = b.data as { probPP: number; credLowPP: number; credHighPP: number };
  const text = `贝叶斯视角：treatment 有 ${d.probPP}% 的概率优于 control（95% 可信区间 [${d.credLowPP}, ${d.credHighPP}]pp）`;
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
    test: /arpu|客单价|人均收入|gmv|交易额|成交额|留存|retention|dau|mau|日活|月活|ctr|点击率|营收|收入|付费率/i,
    run: (ctx) => {
      const KNOWN: [RegExp, string][] = [
        [/arpu|客单价|人均收入/i, 'ARPU'],
        [/gmv|交易额|成交额/i, 'GMV'],
        [/留存|retention/i, '留存率'],
        [/dau|mau|日活|月活/i, '活跃用户数'],
        [/ctr|点击率/i, '点击率'],
        [/营收|收入|revenue/i, '收入'],
        [/付费率/i, '付费率'],
      ];
      const asked = KNOWN.find(([re]) => re.test(ctx.question ?? ''))?.[1] ?? '这个指标';
      const measured = [ctx.exp.primaryMetric, ...ctx.exp.guardrailMetrics].join('、');
      const cites = citeOf(ctx, 'metric');
      return {
        calls: [runTool('get_overview', ctx)],
        text: withCites(
          `这个实验只测了 ${measured}，数据里没有「${asked}」的口径，所以我答不了「${asked} 提升了多少」——这类跨口径的结论不能从转化率类推`,
          cites,
        ) + `如果确实要评估 ${asked}，需要一个以它为指标的实验，或者提供对应的埋点数据。`,
      };
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
    key: 'segment',
    test: /分层|新老|用户群|人群|设备|ios|安卓|哪类|细分|异质|个体差异/i,
    run: (ctx) => {
      const dim = /设备|ios|安卓/i.test(ctx.question ?? '') ? 'device' : 'tenure';
      const t = runTool('segment_breakdown', ctx, { dimension: dim });
      const d = runTool('segment_breakdown', ctx, { dimension: 'device' });
      const { rows, interaction } = t.data as {
        rows: { label: string; diff: number; p: number; q: number }[];
        interaction: { diffDiff: number; p: number } | null;
      };
      const sig = rows.filter((r) => r.q <= 0.1);
      const head = rows.map((r) => `${r.label} ${pp(r.diff)}（q=${r.q.toFixed(3)}）`).join('、');
      const interactionText = interaction
        ? `两层效应差 ${pp(interaction.diffDiff)}，交互检验 p=${pv(interaction.p)}${interaction.p < 0.01 ? '，说明差异不是噪声' : '，差异可能来自抽样波动'}`
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
      const metric = ctx.analysis.overall;
      const bayes = bayesLine(ctx);
      return {
        calls: [r, o, bayes.call],
        text: `${withCites(head, r.cites)}${withCites(
          `主指标 ${pp(metric.diff)}（p=${pv(metric.p)}，95% CI ${pp(metric.ci95[0])} ~ ${pp(metric.ci95[1])}）`,
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
      const d = m.data as { baseline: number; nPerArm: number; mde: number; power: number; observedDiff: number };
      const enough = Math.abs(d.observedDiff) >= d.mde;
      return {
        calls: [m],
        text: `${withCites(
          `按每组 ${d.nPerArm.toLocaleString('en-US')} 个样本、基线 ${pct(d.baseline)}（α=0.05、功效 80%）算，最小可检出差异是 ${pp(d.mde)}`,
          m.cites,
        )}${
          enough
            ? `本次观测到的 ${pp(d.observedDiff)} 大于这个门槛，所以「没效果」不是样本不足造成的。`
            : `本次观测到的 ${pp(d.observedDiff)} 小于这个门槛，因此「不显著」有可能只是样本不够，不能当作「无效」的证据。`
        }`,
      };
    },
  },

  {
    key: 'similar',
    test: /类似|相似|历史|其他实验|横向|对比|同类/,
    run: (ctx) => {
      const s = runTool('find_similar', ctx, { limit: 5 });
      const rows = s.data as { id: string; name: string; decision: string; diff: number }[];
      const text = rows.length
        ? `同类实验有 ${rows.length} 个：${rows
            .map((r) => `${r.id} ${r.name}（${DECISION_CN[r.decision]}，${pp(r.diff)}）`)
            .join('；')}。它们在同一个引擎下走的是同一套规则，可以直接横向看。`
        : '数据集中没有主指标或类型相同的实验，暂时无法横向对比。';
      return { calls: [s], text };
    },
  },

  {
    key: 'test',
    test: /显著|有效|效果|提升|转化|p ?值|差值|置信|区间/,
    run: (ctx) => {
      const t = runTool('run_test', ctx);
      const o = ctx.analysis.overall;
      const srm = ctx.analysis.srm;
      const sig = o.p < 0.05;
      const bayes = bayesLine(ctx);
      return {
        calls: [t, bayes.call],
        text:
          withCites(
            `主指标 control ${pct(o.controlRate, 3)} → treatment ${pct(o.treatmentRate, 3)}，差值 ${pp(o.diff)}，95% CI ${pp(o.ci95[0])} ~ ${pp(o.ci95[1])}，p=${pv(o.p)}`,
            t.cites,
          ) +
          (sig
            ? `区间不跨 0，差异在统计上成立（SRM 相对偏差 ${(srm.relImb * 100).toFixed(2)}%，分流正常）。`
            : `区间跨过 0，这点差异还不足以说明有效果——更准确的说法是「没能证明有差异」。`) +
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
    return {
      calls: [o, t, bayes.call],
      text: `${withCites(
        `这个实验的结论是「${DECISION_CN[data.decision]}」，规则 ${data.reasonCode}`,
        o.cites,
      )}主指标差值 ${pp(ctx.analysis.overall.diff)}，p=${pv(ctx.analysis.overall.p)}。${bayes.text}可以继续问我：为什么是这个结论、新老用户有没有差异、护栏有没有恶化、样本够不够。`,
    };
  },
};

/** 规则模式：不需要任何密钥，纯确定性路由与模板 */
export function answerQuestion(question: string, ctx: AgentCtx): AgentReply {
  const q = question.trim();
  const hit = INTENTS.find((i) => i.test.test(q)) ?? FALLBACK;
  const { calls, text } = hit.run({ ...ctx, question: q });
  const whitelist = buildWhitelist([ctx.analysis, ...calls.map((c) => c.data)]);
  const audit = auditNumbers(text, whitelist);
  return { text, intent: hit.key, calls, audit, by: 'rules', violations: violationsOf(text, calls, audit) };
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
    '4. 口径变化必须显式说明：如果用户问的口径与当前实验不同（例如问 ARPU 但实验只测转化率），先说明口径差异。',
    '5. 不许编造历史实验或行业基准；需要对比时只能调用 find_similar / list_experiments。',
    '6. 数字照抄工具给的格式化字段（如 diffPP、pText、summary），小数最多两位；禁止把 16 位浮点原样写进回答。',
    '',
    `当前实验：${ctx.exp.id} ${ctx.exp.name}；主指标 ${ctx.exp.primaryMetric}；数据为固定种子合成数据。`,
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
