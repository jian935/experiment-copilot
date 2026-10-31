/**
 * Ablation：同一批问题，分别用「规则模板」与「大模型 + 工具」回答，比较差异。
 *
 * 关注三件事（都不是"哪个更好看"）：
 *  1. 引用覆盖率：回答里有没有 [E1] 这种可点开的证据引用
 *  2. 可疑数字率：回答里出现引擎从未算过的数字的比例（幻觉）
 *  3. 口径识别：问一个实验里没有的指标时，会不会老实说"没有"
 *
 * 用法：
 *   npx tsx scripts/ablation.ts                 # 只跑规则模式
 *   DEEPSEEK_API_KEY=sk-... npx tsx scripts/ablation.ts   # 同时跑 LLM
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/lib/decide.ts';
import { generateDataset } from '../src/lib/simulate.ts';
import { answerQuestion } from '../src/lib/agent/answer.ts';
import { askWithLlm } from '../src/app/lib/llm.ts';
import type { AgentCtx, AgentReply } from '../src/lib/agent/types.ts';

const QUESTIONS = [
  '为什么是这个结论？',
  '主指标显著吗？',
  '护栏有没有恶化？',
  '新老用户有差异吗？',
  '样本够不够？',
  '有类似实验吗？',
  '有哪些实验被拦截了？',
  '这个实验的 ARPU 提升了多少？', // 口径陷阱：实验只测转化率
];

const EXPS = ['E001', 'E002', 'E004']; // 护栏拦截 / 分层异质 / 无真实效应

const ds = generateDataset(20261031);
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));

interface Row {
  exp: string;
  q: string;
  by: 'rules' | 'llm';
  intent: string;
  citable: boolean;
  cited: boolean;
  numbers: number;
  suspicious: number;
  tools: number;
  chars: number;
  suspiciousList: string[];
  answersNoData: boolean;
  text: string;
  violations: number;
}

function metrics(rows: Row[]) {
  const n = rows.length || 1;
  return {
    n: rows.length,
    citationRate:
      rows.filter((r) => r.citable && r.cited).length / Math.max(1, rows.filter((r) => r.citable).length),
    suspiciousRate:
      rows.reduce((s, r) => s + r.suspicious, 0) / Math.max(1, rows.reduce((s, r) => s + r.numbers, 0)),
    avgTools: rows.reduce((s, r) => s + r.tools, 0) / n,
    avgChars: Math.round(rows.reduce((s, r) => s + r.chars, 0) / n),
    violationRate: rows.filter((r) => r.violations > 0).length / n,
    // 只在「口径陷阱」题上统计：问 ARPU，但这些实验只测转化率
    noDataRate: (() => {
      const arpu = rows.filter((r) => r.q.includes('ARPU'));
      return arpu.filter((r) => r.answersNoData).length / Math.max(1, arpu.length);
    })(),
  };
}

function toRow(ctx: AgentCtx, q: string, reply: AgentReply): Row {
  return {
    exp: ctx.exp.id,
    q,
    by: reply.by,
    intent: reply.intent,
    citable: reply.calls.some((c) => c.cites.length > 0),
    cited: /\[E\d+\]/.test(reply.text),
    numbers: reply.audit.total,
    suspicious: reply.audit.suspicious.length,
    tools: reply.calls.length,
    chars: reply.text.length,
    suspiciousList: reply.audit.suspicious,
    answersNoData: /没有「|数据里没有|未提供|不包含这个口径|不是这个口径|只测了/.test(reply.text),
    text: reply.text,
    violations: reply.violations?.length ?? 0,
  };
}

async function main() {
  // Key 优先读环境变量，其次读本地 .local/deepseek.key（已 gitignore，不会进仓库）
  const key =
    process.env.DEEPSEEK_API_KEY ||
    (existsSync('.local/deepseek.key') ? readFileSync('.local/deepseek.key', 'utf8').trim() : '');
  const rulesRows: Row[] = [];
  const llmRows: Row[] = [];

  for (const id of EXPS) {
    const exp = ds.experiments.find((e) => e.id === id);
    const analysis = analyses.get(id);
    if (!exp || !analysis) continue;
    const ctx: AgentCtx = { dataset: ds, analyses, exp, analysis };

    for (const q of QUESTIONS) {
      rulesRows.push(toRow(ctx, q, answerQuestion(q, ctx)));
      if (key) {
        try {
          const r = await askWithLlm(q, ctx, { apiKey: key });
          llmRows.push(toRow(ctx, q, r));
        } catch (e) {
          console.error(`LLM 失败 ${id} / ${q}：`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  const mr = metrics(rulesRows);
  const ml = llmRows.length ? metrics(llmRows) : null;

  const fmt = (v: number, pct = true) => (pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2));
  const lines: string[] = [];
  lines.push('# Ablation：规则模板 vs 大模型 + 工具\n');
  lines.push(`> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} ｜ 题目 ${QUESTIONS.length} 条 × 实验 ${EXPS.length} 个\n`);
  lines.push('## 汇总\n');
  lines.push('| 指标 | 规则模式（免密钥） | 智能模式（DeepSeek） |');
  lines.push('|---|---|---|');
  lines.push(`| 样本数 | ${mr.n} | ${ml ? ml.n : '未运行'} |`);
  lines.push(`| 引用覆盖率 | ${fmt(mr.citationRate)} | ${ml ? fmt(ml.citationRate) : '—'} |`);
  lines.push(`| 可疑数字率 | ${fmt(mr.suspiciousRate)} | ${ml ? fmt(ml.suspiciousRate) : '—'} |`);
  lines.push(`| 违规率（缺引用/可疑数字） | ${fmt(mr.violationRate)} | ${ml ? fmt(ml.violationRate) : '—'} |`);
  lines.push(`| 平均工具调用 | ${mr.avgTools.toFixed(2)} | ${ml ? ml.avgTools.toFixed(2) : '—'} |`);
  lines.push(`| 平均字数 | ${mr.avgChars} | ${ml ? ml.avgChars : '—'} |`);
  lines.push(`| 口径陷阱识别率 | ${fmt(mr.noDataRate)} | ${ml ? fmt(ml.noDataRate) : '—'} |`);
  lines.push('');
  const table = (rows: Row[]) => {
    lines.push('| 实验 | 问题 | 工具数 | 引用 | 数字 | 可疑 | 违规 | 可疑数字 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(
        `| ${r.exp} | ${r.q} | ${r.tools} | ${r.cited ? '✓' : '✗'} | ${r.numbers} | ${r.suspicious} | ${r.violations} | ${
          r.suspiciousList.join('、') || '—'
        } |`,
      );
    }
    lines.push('');
  };

  lines.push('## 逐题结果（规则模式）\n');
  table(rulesRows);
  if (llmRows.length) {
    lines.push('## 逐题结果（智能模式）\n');
    table(llmRows);
  }
  lines.push('');
  lines.push('## 逐题回答（规则模式）\n');
  for (const r of rulesRows) {
    lines.push(`### ${r.exp} · ${r.q}`);
    lines.push(`> ${r.text}\n`);
  }
  if (llmRows.length) {
    lines.push('## 逐题回答（智能模式）\n');
    for (const r of llmRows) {
      lines.push(`### ${r.exp} · ${r.q}`);
      lines.push(`> ${r.text}\n`);
    }
  }
  lines.push('## 怎么读这份报告\n');
  lines.push('- **引用覆盖率**低 = 回答无法核对，等于叫你相信它。');
  lines.push('- **可疑数字率** > 0 = 模型说了引擎没算过的数，这是最危险的失败模式。');
  lines.push('- **口径陷阱识别率** = 问到实验没测的指标时，是否老实说"没有"。');
  lines.push('- 规则模式在这三项上通常是满分，但它的语言生硬、只能回答预设意图——这正是 LLM 的位置：**不是替它判断，是替它说话**。');

  writeFileSync('docs/ABLATION.md', lines.join('\n'));

  // 给评测看板吃的摘要（只放聚合数字，不放全文，避免前端体积膨胀）
  mkdirSync('public/data', { recursive: true });
  writeFileSync(
    'public/data/ablation.json',
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      questions: QUESTIONS.length,
      experiments: EXPS,
      rules: mr,
      llm: ml,
      rows: rulesRows.map((r) => ({ exp: r.exp, q: r.q, intent: r.intent, cited: r.cited, numbers: r.numbers, suspicious: r.suspicious })),
    }),
  );
  console.log(`规则模式：${mr.n} 条｜引用覆盖 ${fmt(mr.citationRate)}｜可疑数字 ${fmt(mr.suspiciousRate)}｜违规 ${fmt(mr.violationRate)}`);
  if (ml) console.log(`智能模式：${ml.n} 条｜引用覆盖 ${fmt(ml.citationRate)}｜可疑数字 ${fmt(ml.suspiciousRate)}｜违规 ${fmt(ml.violationRate)}`);
  else console.log('智能模式未运行（未提供 DEEPSEEK_API_KEY）');
  console.log('报告：docs/ABLATION.md');
}

void main();
