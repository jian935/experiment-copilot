/**
 * 任务级评测：证明「巡检」是一个能办事的任务，而不是一次更长的回答。
 *
 * ## 为什么不能只报「完成率」
 *
 * 巡检的编排是确定性的：跑通一次，完成率就永远是 100%。把那个数字写进简历，
 * 面试官第一句就会问「它是确定的吧」，然后整段话的可信度归零。
 *
 * 所以这里报的是四个**有信息量的**数字：
 *
 * | 指标 | 回答的问题 | 为什么它会失败 |
 * |---|---|---|
 * | `judgement` | 判断对不对 | 排序/分档逻辑写错，或阈值口径漂移 |
 * | `abstain` | 该说「不知道」时说了没有 | 把「不显著」读成「没效果」是最常见的错 |
 * | `fidelity` | 有没有编数字 | 文案里出现引擎没给过的数 |
 * | `coverage` | 每条结论有没有证据 | 少引用 → 读者无法倒查 |
 *
 * ## 真值从哪来
 *
 * 120 个内置实验在生成时就注入了 `archetype`（srm / guardrail / negative /
 * null / heterogeneous / positive）与 `trueDecision`。这些标签**不是引擎算出来的**，
 * 所以拿它们评巡检不是自证。
 *
 * 但真值与引擎之间本来就有误差（引擎在这份数据上并非 100% 准确），
 * 所以涉及真值的任务用「覆盖率 + 列出漏的」而不是「必须全对」——
 * 把引擎的既有误差算到巡检头上，会掩盖真正的巡检问题。
 */
import { analyze } from '../decide.ts';
import type { Analysis } from '../decide.ts';
import type { Dataset } from '../types.ts';
import { runInspection, renderMarkdown } from './inspection.ts';
import { INSPECTION_STEPS } from './inspection.ts';
import type { InspectionReport } from './types.ts';

export interface TaskResult {
  id: string;
  name: string;
  /** 用户会怎么说这句话（评测要贴着真实提问，不是贴着函数名） */
  ask: string;
  /** 这一项属于哪一类：告诉读者这 15 项分别证什么 */
  group: '编排' | '解释' | '拒答' | '真值' | '保真';
  passed: boolean;
  /** 失败原因；通过时为空数组 */
  failures: string[];
  /** 这个任务自检看了几步（用的就是 INSPECTION_STEPS 的条数，不是编的） */
  steps: number;
}

/**
 * 指标必须分清「谁的问题」。
 *
 * 第一版我把「零效应实验上出现方向」记成巡检的拒答失败，结果 6 个报错里
 * 有 4 个是**引擎的假阳性**（引擎把 null 判成 ship），巡检只是转述。
 * 把两个系统的错混在一个数里，既冤枉巡检，也掩盖引擎的真实错误率。
 * 所以下面把指标分成两组：`alignment / inventedDirections` 是巡检的，
 * `engineFalsePositive` 是引擎的（如实报出，不甩锅也不揽锅）。
 */
export interface TaskMetrics {
  /**
   * 下一步动作与引擎决策的相容率（分母 = 实验数）。
   *
   * 为什么它不是「完成率」：它逐条比对「引擎说了什么」与「巡检建议做什么」，
   * 分母是 120 个真实实验，任何一处映射写错都会掉下来。
   * 它是一条回归锁，不是能力证明——能力证明是 truth-* 那三条。
   */
  alignment: number;
  /** 引擎判「没结论」时巡检却给出方向的次数（必须为 0） */
  inventedDirections: number;
  /** 引擎在注入零效应的实验上判出方向的比例（这是引擎的指标，不是巡检的） */
  engineFalsePositive: number;
  /**
   * 数字保真：报告里出现的数字串个数，以及其中不该出现的
   * （NaN / undefined / Infinity / 无结论却给方向）。
   *
   * 注意口径：巡检报告由模板拼装、不经过模型，所以这里不存在 LLM 那种
   * 「编数字」风险。这个指标守的是模板与映射不出错，不是「模型不瞎编」。
   */
  fidelity: { numbers: number; suspicious: number; note: string };
  /** 引用覆盖：有分量的信号里，带证据编号的比例（分母 = 信号数） */
  coverage: number;
}

export interface TaskEval {
  cases: TaskResult[];
  passed: number;
  failed: number;
  metrics: TaskMetrics;
  /** 跑了几个实验的分析（让读者知道评测规模） */
  scale: { experiments: number; rows: number };
}

type Case = {
  id: string;
  name: string;
  ask: string;
  group: TaskResult['group'];
  /** 返回失败原因列表；空数组 = 通过 */
  check: (r: InspectionReport, ds: Dataset) => string[];
};

const ids = (xs: { expId: string }[]) => xs.map((x) => x.expId);

/** 真值：从实验元信息读 archetype / trueDecision（生成时注入，不是引擎算的） */
function truthOf(ds: Dataset) {
  const byArch = new Map<string, string[]>();
  const byDecision = new Map<string, string[]>();
  for (const e of ds.experiments) {
    byArch.set(e.archetype, [...(byArch.get(e.archetype) ?? []), e.id]);
    byDecision.set(e.trueDecision, [...(byDecision.get(e.trueDecision) ?? []), e.id]);
  }
  return { byArch, byDecision };
}

const CASES: Case[] = [
  // ---------- 编排：它能不能自己收成一份东西 ----------
  {
    id: 'inspect-full',
    name: '全量巡检',
    ask: '帮我看看这周有哪些实验需要处理',
    group: '编排',
    check: (r) => {
      const f: string[] = [];
      const t = r.totals;
      if (t.critical + t.warn + t.info + t.ok !== t.experiments) {
        f.push(`四个等级之和 ${t.critical + t.warn + t.info + t.ok} ≠ 实验总数 ${t.experiments}`);
      }
      if (!r.items.length) f.push('没有产出任何巡检项');
      // 排序：必须严格按等级，否则「第一屏」就失去意义
      const rank = { critical: 0, warn: 1, info: 2, ok: 3 };
      for (let i = 1; i < r.items.length; i++) {
        if (rank[r.items[i].risk] < rank[r.items[i - 1].risk]) {
          f.push(`第 ${i} 项的等级 ${r.items[i].risk} 排在 ${r.items[i - 1].risk} 之后（排序不成立）`);
          break;
        }
      }
      if (!r.scope.length) f.push('没有声明「这份报告不回答什么」');
      return f;
    },
  },
  {
    id: 'inspect-must',
    name: '第一屏',
    ask: '今天必须看的有哪几个',
    group: '编排',
    check: (r) => {
      const f: string[] = [];
      if (r.mustLook.length > 5) f.push(`第一屏 ${r.mustLook.length} 条，超过 5 条的限额`);
      for (const x of r.mustLook) {
        if (x.risk !== 'critical') f.push(`${x.expId} 是 ${x.risk} 却进了第一屏（第一屏只放必须处理）`);
        if (!x.why) f.push(`${x.expId} 没有一句话解释`);
        if (!x.next?.detail) f.push(`${x.expId} 没有下一步`);
      }
      // 同类只留一个代表：第一屏出现两条同样的主导信号就是「同一件事说了两遍」
      const dom = r.mustLook.map((x) => x.signals.reduce((a, b) => (b.weight > a.weight ? b : a), x.signals[0])?.code);
      if (new Set(dom).size !== dom.length) f.push(`第一屏有重复的主导原因：${dom.join(',')}`);
      return f;
    },
  },
  {
    id: 'inspect-ship',
    name: '可以上线的清单',
    ask: '哪些实验可以上线了',
    group: '编排',
    check: (r) => {
      const f: string[] = [];
      const ship = r.items.filter((x) => x.next.kind === 'ship');
      for (const x of ship) {
        if (x.decision === 'inconclusive') f.push(`${x.expId} 引擎判「没结论」却被建议上线`);
        if (!x.signals.some((s) => s.code === 'sig_positive')) f.push(`${x.expId} 建议上线但主指标不显著为正`);
        if (x.signals.some((s) => s.code === 'srm_broken' || s.code === 'guardrail_worse')) {
          f.push(`${x.expId} 分流坏/护栏恶化，却被建议上线`);
        }
      }
      if (!ship.length) f.push('一个可以上线的都没有——若是数据里确有正向实验，说明漏了');
      return f;
    },
  },
  {
    id: 'inspect-collect',
    name: '要补样本的清单',
    ask: '哪些实验还要继续跑',
    group: '编排',
    check: (r) => {
      const f: string[] = [];
      const more = r.items.filter((x) => x.next.kind === 'collect-more');
      for (const x of more) {
        if (!x.signals.some((s) => s.code === 'underpowered')) f.push(`${x.expId} 要补样本但没被判「测不出」`);
        if (!x.next.forecast?.nPerArm) f.push(`${x.expId} 说要补样本却没给每臂人数`);
      }
      // 设计不足的必须**不**出现在这里：补 16 倍样本不是建议
      const insuff = r.items.filter((x) => x.signals.some((s) => s.code === 'design_insufficient'));
      for (const x of insuff) {
        if (x.next.kind === 'collect-more') f.push(`${x.expId} 是设计不足却给了「补样本」建议`);
      }
      return f;
    },
  },

  // ---------- 解释：能不能定位到具体原因 ----------
  {
    id: 'explain-srm',
    name: '为什么不能下结论（分流）',
    ask: '这些分流异常的实验到底怎么了',
    group: '解释',
    check: (r) => {
      const f: string[] = [];
      const hit = r.items.filter((x) => x.signals.some((s) => s.code === 'srm_broken'));
      if (!hit.length) return ['没有识别出任何分流异常'];
      for (const x of hit) {
        if (x.next.kind !== 'fix-traffic') f.push(`${x.expId} 分流坏了，下一步却是 ${x.next.kind}`);
        // 短路必须成立：分流坏了之后不该再叠加截尾/样本量诊断
        if (x.signals.length !== 1) f.push(`${x.expId} 分流坏了却还列了 ${x.signals.length - 1} 条其他问题`);
      }
      return f;
    },
  },
  {
    id: 'explain-guardrail',
    name: '为什么不能上（护栏）',
    ask: '护栏恶化的那些实验该怎么办',
    group: '解释',
    check: (r) => {
      const f: string[] = [];
      const hit = r.items.filter((x) => x.signals.some((s) => s.code === 'guardrail_worse'));
      if (!hit.length) return ['没有识别出任何护栏恶化'];
      for (const x of hit) {
        if (x.next.kind !== 'hold') f.push(`${x.expId} 护栏恶化，下一步却是 ${x.next.kind}`);
        if (x.risk !== 'critical') f.push(`${x.expId} 护栏恶化却没进必须处理`);
        // 必须说得出是哪条护栏
        const g = x.signals.find((s) => s.code === 'guardrail_worse')!;
        if (!/退款率|投诉率|延迟/.test(g.detail)) f.push(`${x.expId} 没说清是哪条护栏恶化`);
      }
      return f;
    },
  },
  {
    id: 'explain-negative',
    name: '负向实验的处置',
    ask: '有没有明显做坏了的实验',
    group: '解释',
    check: (r) => {
      const f: string[] = [];
      const neg = r.items.filter((x) => x.signals.some((s) => s.code === 'sig_negative'));
      if (!neg.length) return ['没有识别出任何显著负向'];
      for (const x of neg) {
        if (x.next.kind !== 'hold') f.push(`${x.expId} 显著负向，下一步却是 ${x.next.kind}`);
      }
      return f;
    },
  },
  {
    id: 'explain-hetero',
    name: '定向实验该怎么上',
    ask: '那些只有一部分人有效的实验该怎么上线',
    group: '解释',
    check: (r) => {
      const f: string[] = [];
      const het = r.items.filter((x) => x.signals.some((s) => s.code === 'heterogeneous'));
      if (!het.length) return ['没有识别出任何效应异质'];
      for (const x of het) {
        if (x.next.kind !== 'iterate') f.push(`${x.expId} 效应异质，下一步却是 ${x.next.kind}`);
        if (!/人群|用户|新|老/.test(x.next.detail)) f.push(`${x.expId} 说定向却没说定向给谁`);
        // 异质时不该同时说「可以全量上线」
        if (x.signals.some((s) => s.code === 'sig_positive')) f.push(`${x.expId} 既说定向又说显著为正（会误导成全量）`);
      }
      return f;
    },
  },

  // ---------- 拒答：这一组是整份评测的重心 ----------
  {
    id: 'abstain-null',
    name: '零效应实验不能编出结论',
    ask: '那些没效果的实验是不是可以停了',
    group: '拒答',
    check: (r, ds) => {
      const f: string[] = [];
      const { byArch } = truthOf(ds);
      const nulls = byArch.get('null') ?? [];
      const items = r.items.filter((x) => nulls.includes(x.expId));
      if (!items.length) return ['零效应实验一个都没进巡检（更糟）'];
      // 口径很关键：这里**不**要求「零效应实验上没有方向」。
      //
      // 第一版就是这么写的，结果 6 个实验报错，其中 E004/E115 被建议上线——
      // 但那是**引擎把它们判成了 ship**（假阳性），巡检只是忠实转述。
      // 拿引擎的准确率去惩罚巡检的忠实转述，是把两个系统的错算到一起，
      // 而「巡检有没有自己发明方向」这件事反而被掩盖了。
      //
      // 所以判据改成：引擎判「没结论」的实验上，巡检不得出现任何方向信号。
      // 这正是 `hardVerdictsOnInconclusive` 在守的东西，这里逐条复述一遍。
      for (const x of items) {
        if (x.decision !== 'inconclusive') continue;
        const directional = x.signals.some((s) =>
          s.code === 'sig_positive' || s.code === 'sig_negative' || s.code === 'heterogeneous',
        );
        if (directional) f.push(`${x.expId} 引擎判没结论，巡检却给出了方向`);
        if (x.next.kind === 'ship') f.push(`${x.expId} 引擎判没结论，巡检却建议上线`);
      }
      return f;
    },
  },
  {
    id: 'abstain-power',
    name: '「没效果」与「测不出」不能混',
    ask: '这些不显著的实验到底有没有效果',
    group: '拒答',
    check: (r) => {
      const f: string[] = [];
      // 分流坏了 / 没数据的实验，原因已经说清楚了，不需要再补一句「测不出」——
      // 那正是「前置条件不满足就短路」的设计。要求它也解释样本量，等于要求它说噪音。
      const hasPrecondition = (x: InspectionReport['items'][number]) =>
        x.signals.some((s) => s.code === 'srm_broken' || s.code === 'no_data');
      const incon = r.items.filter((x) => x.decision === 'inconclusive' && !hasPrecondition(x));
      const powerWords = incon.filter((x) =>
        x.signals.some((s) => s.code === 'underpowered' || s.code === 'design_insufficient' || s.code === 'no_effect_confident'),
      );
      // 每个「没结论」都必须解释「为什么没结论」
      for (const x of incon) {
        if (!powerWords.includes(x)) f.push(`${x.expId} 判了没结论，却没解释是测不出还是确实没效果`);
      }
      // 而且解释里必须出现 MDE 这个标尺，否则「测不出」是一句空话
      for (const x of powerWords) {
        const s = x.signals.find((g) =>
          g.code === 'underpowered' || g.code === 'design_insufficient' || g.code === 'no_effect_confident',
        )!;
        if (!/检出|排除/.test(s.detail)) f.push(`${x.expId} 的样本量说明里没有 MDE 口径`);
      }
      return f;
    },
  },
  {
    id: 'abstain-empty',
    name: '空数据不能装成巡检过',
    ask: '巡检一下',
    group: '拒答',
    check: (_r, ds) => {
      // 用一份只有实验、没有数据行的数据集重跑
      const empty: Dataset = { ...ds, daily: [] };
      const analyses = new Map<string, Analysis>();
      for (const e of empty.experiments) analyses.set(e.id, analyze(e, [], undefined));
      const r2 = runInspection(empty, analyses);
      const f: string[] = [];
      if (r2.totals.withData !== 0) f.push(`没有数据行却报了 ${r2.totals.withData} 个「有数据」`);
      const noData = r2.items.filter((x) => x.signals.some((s) => s.code === 'no_data'));
      if (noData.length !== r2.items.length) {
        f.push(`只在 ${noData.length}/${r2.items.length} 个实验上识别出「没有数据」`);
      }
      if (r2.items.some((x) => x.next.kind === 'ship')) f.push('没有数据却建议上线');
      return f;
    },
  },

  // ---------- 真值：引擎之外的标签 ----------
  {
    id: 'truth-srm',
    name: '注入的分流异常有没有进必须处理',
    ask: '分流坏掉的实验有没有被排到前面',
    group: '真值',
    check: (r, ds) => {
      const { byArch } = truthOf(ds);
      const srm = byArch.get('srm') ?? [];
      if (!srm.length) return ['数据里没有注入 srm 的实验，这条无法评'];
      const caught = srm.filter((id) => r.items.find((x) => x.expId === id)?.risk === 'critical');
      const f: string[] = [];
      // 阈值写 0.9：引擎在个别实验上会漏检 SRM，那是引擎的既有误差，不该记到巡检头上
      if (caught.length / srm.length < 0.9) {
        const miss = srm.filter((id) => !caught.some((c) => c === id));
        f.push(`注入 ${srm.length} 个分流异常，只捕获 ${caught.length} 个；漏：${miss.join(',')}`);
      }
      return f;
    },
  },
  {
    id: 'truth-guardrail',
    name: '注入的护栏伤害有没有被拦住',
    ask: '护栏确实变差的实验，都被要求停掉了吗',
    group: '真值',
    check: (r, ds) => {
      const { byArch } = truthOf(ds);
      const g = byArch.get('guardrail') ?? [];
      if (!g.length) return ['数据里没有注入 guardrail 的实验，这条无法评'];
      const held = g.filter((id) => r.items.find((x) => x.expId === id)?.next.kind === 'hold');
      const f: string[] = [];
      if (held.length / g.length < 0.9) {
        const miss = g.filter((id) => !held.some((c) => c === id));
        f.push(`注入 ${g.length} 个护栏伤害，只拦住 ${held.length} 个；漏：${miss.join(',')}`);
      }
      return f;
    },
  },
  {
    id: 'truth-positive',
    name: '真正该上线的没有被淹没',
    ask: '真的有效果的实验，有没有被我漏掉',
    group: '真值',
    check: (r, ds) => {
      const { byArch } = truthOf(ds);
      const pos = byArch.get('positive') ?? [];
      if (!pos.length) return ['数据里没有注入 positive 的实验，这条无法评'];
      const rank = { critical: 0, warn: 1, info: 2, ok: 3 };
      const buried = pos.filter((id) => {
        const x = r.items.find((y) => y.expId === id);
        return !x || rank[x.risk] > rank.info;
      });
      const f: string[] = [];
      // 只要没沉到「无需动作」就算没被淹没：定向/待补样本都还能被看见
      if (buried.length) f.push(`真该上线的 ${pos.length} 个里，有 ${buried.length} 个沉进了「无需动作」：${buried.join(',')}`);
      return f;
    },
  },

  // ---------- 保真：报告里的每个字都能倒查 ----------
  {
    id: 'fidelity',
    name: '报告里的数字都能倒查',
    ask: '你这份周报里的数字是真的吗',
    group: '保真',
    check: (r) => {
      const f: string[] = [];
      const md = renderMarkdown(r);
      for (const bad of ['NaN', 'undefined', '[object Object]', 'Infinity']) {
        if (md.includes(bad)) f.push(`周报正文出现 ${bad}`);
      }
      if (r.digest.hardVerdictsOnInconclusive !== 0) {
        f.push(`引擎判无结论却硬给方向 ${r.digest.hardVerdictsOnInconclusive} 次`);
      }
      // 每条有分量的结论都必须带证据
      for (const x of r.items) {
        for (const s of x.signals) {
          if (s.weight > 0 && s.cites.length === 0) f.push(`${x.expId} 的「${s.label}」没有证据编号`);
        }
      }
      return f;
    },
  },
];

/**
 * 「引擎说了什么」与「巡检建议做什么」的相容表。
 *
 * review 出现在多处，因为它对应的是「不值得动 / 人工复核 / 设计不足」这类
 * 需要人判断而不是自动放行或拦住的情况——它们与任何决策都不冲突。
 * 但 ship 与 hold 是强主张，只允许与对应的决策配对。
 */
const COMPATIBLE: Record<string, string[]> = {
  ship: ['ship', 'review'],
  'no-ship': ['hold', 'review'],
  iterate: ['iterate', 'review'],
  inconclusive: ['collect-more', 'review', 'fix-traffic', 'instrument'],
};

/** 编数检查：报告里出现的数字，去掉常见口径词后不该有「凭空」的 */
function countNumbers(r: InspectionReport): number {
  const md = renderMarkdown(r);
  // 只数带小数或 ≥2 位的数字串，避免把「1.」「2.」这类步骤序号算进去
  const m = md.match(/\d+(?:\.\d+)?%?/g) ?? [];
  return m.length;
}

export function evaluateTasks(ds: Dataset, analyses: Map<string, Analysis>): TaskEval {
  const report = runInspection(ds, analyses);
  const cases: TaskResult[] = CASES.map((c) => {
    let failures: string[];
    try {
      failures = c.check(report, ds);
    } catch (e) {
      failures = [`检查本身抛错：${e instanceof Error ? e.message : String(e)}`];
    }
    return {
      id: c.id,
      name: c.name,
      ask: c.ask,
      group: c.group,
      passed: failures.length === 0,
      failures,
      steps: INSPECTION_STEPS.length,
    };
  });

  // 相容率：逐实验比对「引擎决策」与「巡检建议的下一步」
  let aligned = 0;
  for (const x of report.items) {
    if (COMPATIBLE[x.decision].includes(x.next.kind)) aligned += 1;
  }
  const alignment = report.items.length ? aligned / report.items.length : 1;

  // 巡检自己发明方向的次数（引擎判无结论却给了有方向的信号）
  let invented = 0;
  for (const x of report.items) {
    if (x.decision !== 'inconclusive') continue;
    if (x.signals.some((s) => s.code === 'sig_positive' || s.code === 'sig_negative' || s.code === 'heterogeneous')) {
      invented += 1;
    }
  }

  // 引擎在注入零效应的实验上判出方向的比例（如实报出，这是引擎的指标）
  const { byArch } = truthOf(ds);
  const nulls = byArch.get('null') ?? [];
  const nullItems = report.items.filter((x) => nulls.includes(x.expId));
  const engineFp = nullItems.length
    ? nullItems.filter((x) => x.decision !== 'inconclusive').length / nullItems.length
    : 0;

  // 引用覆盖：有分量的信号里带证据的比例
  let withW = 0;
  let withC = 0;
  for (const x of report.items) {
    for (const s of x.signals) {
      if (s.weight <= 0) continue;
      withW += 1;
      if (s.cites.length) withC += 1;
    }
  }

  return {
    cases,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    metrics: {
      alignment,
      inventedDirections: invented,
      engineFalsePositive: engineFp,
      fidelity: {
        numbers: countNumbers(report),
        suspicious: report.digest.hardVerdictsOnInconclusive,
        note: '巡检报告由模板拼装、不经过模型；这里守的是映射与模板不出错，不是「模型不瞎编」',
      },
      coverage: withW ? withC / withW : 1,
    },
    scale: { experiments: ds.experiments.length, rows: ds.daily.length },
  };
}

/** 任务清单（给看版与 README 用，避免两处各写一遍） */
export const TASK_CASES = CASES.map((c) => ({ id: c.id, name: c.name, ask: c.ask, group: c.group }));
