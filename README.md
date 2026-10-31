# Experiment Copilot · 实验结论官

> 状态：**M1 完成（数据 + 统计 + 决策规则 + 校准）** ｜ 2026-10-31
> 完整方案：[`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) ｜ M1 报告：[`docs/EVAL.md`](docs/EVAL.md)

**一句话**：输入一个 A/B 实验，输出一张「能不能上」的可审计结论卡。
统计与计算全部由确定性引擎完成，LLM 只负责编排、解释与追问——**每个数字都能点开看公式、样本量与数据版本，并能一键复算。**

## 为什么做这个

- 15 份目标 JD 里，**「数据分析 SQL/统计」出现 9/15**，是唯一还没有独立项目覆盖的高频项（多模态已做两个）。
- GitHub 现状：通用 ChatBI 已挤爆（Vanna 23.8k / pandas-ai 23.9k / Chat2DB 28.3k / WrenAI 18k），
  而**实验分析只有统计库（confidence 312、abba 241）和平台（GrowthBook 8.5k），没有 AI 层**。
- 定位差异：不做 NL2SQL，不做 ChatBI，做「**可复算的实验决策**」。

## 四条原则

1. LLM never does math（所有数字来自引擎）
2. Every claim is reproducible（证据抽屉 + 一键复算）
3. Check before conclude（先 SRM / 样本量 / 护栏）
4. Say "I don't know"（不确定就说不确定）

## 已定的三个选择

| 项 | 决定 |
|---|---|
| 仓库名 | `experiment-copilot`（英文）+ 中文副标题「实验结论官」 |
| 数据 | 合成数据 + 固定种子的开源生成器（**明确标注**用于已知真值评测，不是真实业务数据） |
| UI | 深色专业分析风，主色靛蓝；参考 GrowthBook / Metabase / Vercel AI Chatbot / shadcn |

## 数据（已有一份可用 seed）

- `data/A_B实验数据-v2.xlsx`：6 个实验（`experiments` / `daily_metrics` / `notes`），覆盖 ship / inconclusive / no-ship / iterate / SRM 异常五种情况。
- 修正记录与口径：`docs/DATA-CHANGELOG.md`（改了什么、为什么、自检 p 值）。
- 评测集仍需用生成器扩到 120 例；这 6 个作为 seed 与演示数据。

## 已完成（M1）

| 模块 | 文件 | 状态 |
|---|---|---|
| 统计引擎 | `src/lib/stats.ts` | ✅ SRM / 两比例 z / Newcombe CI / BH / 功效 / MDE |
| 决策引擎 | `src/lib/decide.ts` | ✅ 6 条规则，输出结论 + 证据链 |
| 数据生成器 | `src/lib/simulate.ts` + `scripts/gen_experiments.ts` | ✅ 120 实验 / 6,720 行，固定种子 |
| 单测 | `tests/*.test.ts` | ✅ 18 个，含 6 组 scipy 对齐 |
| 校准自检 | `scripts/check_calibration.ts` | ✅ 决策准确率 **96.7%**，FPR 7.5%，FNR 0 |

```bash
npm install
npm test          # 18 个单测
npm run gen       # 生成 data/experiments.json + csv
npm run calibrate # 120 例校准，输出混淆矩阵与指标
```

> 当前校准：120 例里 116 例与真实决策一致；剩下 4 个是 null 实验的正常假阳性（α=0.05），
> 不修——评测看板要如实展示失败案例，详见 `docs/EVAL.md`。

## 目录

```
src/lib/stats.ts      统计引擎（零依赖）
src/lib/decide.ts     决策 + 证据链
src/lib/simulate.ts   数据生成器（种子可复现）
scripts/              生成 / 校准
tests/                单测 + scipy 参考值
data/                 生成的 120 例数据（json + csv）
docs/                 蓝图 / 数据需求 / 数据修正记录 / M1 评测
```

## 技术栈

Vite + React 18 + TypeScript + Tailwind + shadcn/ui + Recharts + KaTeX；
统计自研（TS，带单测）；Agent 自研轻量工具循环；LLM 走 DeepSeek（浏览器直连，CORS 已验证）；
部署 GitHub Pages（静态，不占 WorkBuddy 应用槽）。

## 里程碑

M1 数据+统计+单测 → M2 结论卡 UI → M3 证据链 → M4 Agent → M5 120 例评测 → M6 打磨/部署/视频。
验收标准见蓝图 §13。
