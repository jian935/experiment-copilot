import { mdeTwoProportion, powerTwoProportion } from '../stats.ts';
import type { Analysis, Evidence } from '../decide.ts';
import type { Decision } from '../types.ts';
import type { AgentCtx, ToolCall, ToolName } from './types.ts';

export const TOOL_LABEL: Record<ToolName, string> = {
  get_overview: '读取结论',
  run_test: '重算主指标检验',
  segment_breakdown: '扫描分层',
  check_guardrails: '检查护栏',
  compute_mde: '推算 MDE / 功效',
  find_similar: '检索相似实验',
  list_experiments: '检索实验列表',
  explain_rules: '回溯判定规则',
};

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
const pp = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}pp`;
const pv = (p: number) => (p < 1e-16 ? '<1e-16' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));

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

/** 8 个工具全部是纯函数：只读 Analysis / Dataset，不联网、不算任何新口径 */
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
          diffPP: Number((a.overall.diff * 100).toFixed(3)),
          p: a.overall.p,
          n: a.overall.n1 + a.overall.n2,
        },
        cites: [...cite(a, 'metric'), ...cite(a, 'decision')],
      };
    }

    case 'run_test': {
      const o = a.overall;
      return {
        tool: name,
        args,
        summary: `差值 ${pp(o.diff)}（95% CI ${pp(o.ci95[0])} ~ ${pp(o.ci95[1])}），p=${pv(o.p)}`,
        data: {
          controlRate: o.controlRate,
          treatmentRate: o.treatmentRate,
          diff: o.diff,
          ci95: o.ci95,
          relativeLift: o.relativeLift,
          z: o.z,
          p: o.p,
          n1: o.n1,
          n2: o.n2,
          significant: o.p < 0.05,
        },
        cites: cite(a, 'metric'),
      };
    }

    case 'segment_breakdown': {
      const dim = String(args.dimension ?? 'tenure') as 'tenure' | 'device';
      const rows = a.segments[dim] ?? a.segments.tenure;
      return {
        tool: name,
        args: { dimension: dim },
        summary: rows.map((s) => `${s.label} ${pp(s.test.diff)}（q=${s.q.toFixed(2)}）`).join('；'),
        data: {
          dimension: dim,
          rows: rows.map((s) => ({
            label: s.label,
            controlRate: s.test.controlRate,
            treatmentRate: s.test.treatmentRate,
            diff: s.test.diff,
            p: s.test.p,
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
      const baseline = typeof args.baseline === 'number' ? args.baseline : a.overall.controlRate;
      const nPerArm = typeof args.nPerArm === 'number' ? args.nPerArm : Math.min(a.overall.n1, a.overall.n2);
      const mde = mdeTwoProportion(baseline, nPerArm);
      const power = powerTwoProportion(baseline, a.overall.treatmentRate, nPerArm);
      return {
        tool: name,
        args: { baseline, nPerArm },
        summary: `在 n=${nPerArm}/组、基线 ${pct(baseline)} 下，80% 功效的最小可检出差异为 ${pp(mde)}`,
        data: { baseline, nPerArm, mde, power, observedDiff: a.overall.diff },
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
          const diff = an?.overall.diff ?? 0;
          const p = an?.overall.p ?? 1;
          return {
            id: e.id,
            name: e.name,
            archetype: e.archetype,
            decision: an?.decision ?? 'unknown',
            decisionLabel: DECISION_CN[an?.decision ?? 'inconclusive'],
            // 给模型直接可抄的字符串：避免它输出 16 位浮点（实测会被数字审计判为可疑）
            diffPP: pp(diff),
            pText: pv(p),
            diff,
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
            diffPP: pp(an.overall.diff),
            pText: pv(an.overall.p),
            diff: an.overall.diff,
            p: an.overall.p,
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
];

export const TOOL_NAMES = TOOL_SCHEMA.map((t) => t.function.name) as ToolName[];
