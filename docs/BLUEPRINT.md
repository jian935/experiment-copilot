# Experiment Copilot（实验结论官）· 完整产品与工程蓝图

> 下一个作品集项目 · 方案版本 v1.0 · 2026-10-31
> 定位：给增长 / 产品团队的「实验结论 Copilot」——**不让 LLM 算数，只让它编排与解释；每个结论可复算。**
> 目标：补齐你 15 份 JD 里**唯一没被覆盖的高频能力项「数据分析 SQL/统计（9/15）」**，并把它做成简历上最硬的一个项目。

---

## 0. 一句话结论

**做「实验结论官」：输入一个 A/B 实验，输出一张「能不能上」的可审计结论卡。**
统计与计算全部由确定性引擎完成，LLM 只负责编排分析步骤、解释结果、回答追问——每个数字都能点开看到公式、样本量与数据版本，并能一键复算。

不是第 1001 个 ChatBI，也不是又一个「Chat with your data」。

---

## 1. 为什么是它（证据，不是感觉）

### 1.1 你的 JD 能力频次（中午那份总结）

| 能力项 | 出现频次 | 你已有的项目覆盖 |
|---|---|---|
| LLM | 15/15 | career-loop、voice、storylight |
| AI Agent | 13/15 | career-loop、voice |
| **数据分析 SQL/Python** | **9/15** | ❌ **没有独立项目** |
| RAG | 8/15 | voice（轻）、career-loop（轻） |
| Prompt | 7/15 | 分散在各项目 |
| Vibe Coding | 6/15 | voice、storylight |
| 多模态 | 5/15 | voice、storylight（已两个） |

**结论：唯一的高频空白是「数据分析」。** 再做多模态是重复投入，边际收益最低。

### 1.2 GitHub 现状（2026-10-31 实测，避免重复造轮子）

| 方向 | 头部项目 | Star | 说明 |
|---|---|---|---|
| ChatBI / NL2SQL | Chat2DB | 28.3k | 数据库客户端 + AI |
| | pandas-ai | 23.9k | Chat with your dataframe |
| | Vanna | 23.8k | Text-to-SQL + RAG |
| | WrenAI | 18.0k | 语义层 + 受控 Text-to-SQL |
| | SQLBot | 7.0k | 国产智能问数 |
| 实验平台 | GrowthBook | 8.5k | 开源实验/Feature Flag 平台，**没有 AI copilot** |
| 实验统计库 | spotify/confidence | 312 | 纯 Python 统计库 |
| | thumbtack/abba | 241 | A/B 计算库 |
| AI 数据分析师 | Data-Analysis-Agent | 2.6k | 对话式报表/洞察 |

**三个判断：**
1. **通用 ChatBI 已经挤爆**——Vanna / WrenAI / pandas-ai 把「NL→SQL→图」吃干净了，再做没有理由被记住。
2. **实验分析只有「库」，没有「AI 层」**——`confidence`/`abba` 是统计库，GrowthBook 是平台，**没有一个把「实验结论」做成可审计 Copilot**。
3. **「experiment analysis + LLM」在 GitHub 上几乎搜不到像样项目**——这是真空档，而不是红海。

### 1.3 三条候选的取舍（为什么不是另两个）

| 候选 | 机会 | 为什么不选 |
|---|---|---|
| 可审计 ChatBI | 受众广 | 红海；差异化只能靠"审计"，容易被 WrenAI 的语义层覆盖 |
| 指标异动归因 | 视觉炸、可评测 | GitHub 信号极弱（0-1 star），需求存疑；且归因容易变成"LLM 编故事" |
| **实验结论 Copilot** | **真空档 + 高频 JD + 强评测** | ✅ 选它 |

---

## 2. 用户与场景

| 维度 | 内容 |
|---|---|
| **谁** | 增长/产品 PM、数据分析师、运营（有实验平台但没分析人力的团队） |
| **何时** | 每周实验复盘会前 1-2 小时；实验跑到第 7 天，要决定"上不上/延不延" |
| **现状** | 手工拉数 → Excel/BI 算 → 写结论 → 会上被质疑口径 → 重算 |
| **痛点** | ① 重复劳动（SRM、显著性、分层、护栏一套 1-2h）② 口径不统一，不同人算的分母不同 ③ 结论不可复算，会上扯皮 ④ 直接问 ChatGPT 会编数字、不会统计 |
| **成功标准** | 从"2 小时出结论"变成"5 分钟拿到可复算结论卡"，且**结论与统计真值一致** |

---

## 3. 洞察与产品原则

### 3.1 三条洞察

1. **实验分析 90% 是确定性计算，LLM 不该算数。** 让 LLM 算 p 值 = 让它编。正确分工：引擎算，LLM 编排 + 解释 + 追问。
2. **用户要的不是"SQL"，是"能不能上"。** 输出必须是决策（ship / no-ship / iterate / inconclusive），不是一张表。
3. **可审计性才是信任的来源。** 每个数字能点开看公式、样本量、数据版本，并能一键复算——这是 ChatBI 都没做好的。

### 3.2 四条产品原则（写进 README 首屏）

1. **LLM never does math**：所有统计量来自引擎；LLM 回答里出现的每个数字必须能对上证据 ID。
2. **Every claim is reproducible**：结论卡 → 证据抽屉 → 公式 + 输入 + 输出 + 一键复算。
3. **Check before conclude**：先 SRM、样本量、护栏，再谈显著性；不满足前提就判"不可结论"。
4. **Say "I don't know"**：置信区间宽、样本不足、多重比较未校正时，明确说不确定，而不是给一个漂亮结论。

---

## 4. 体验闭环（8 步）

```
选实验 / 导入配置
   │
   ▼
自动体检（SRM / 样本量 / 曝光定义 / 数据完整性）
   │  不通过 → 直接判「不可结论」并说明原因
   ▼
算核心指标（频率派 + 贝叶斯，CI / p / effect size）
   │
   ▼
分层扫描（设备 / 新老 / 渠道；BH 多重比较校正）
   │
   ▼
护栏指标（退款 / 投诉 / 延迟；非劣检验）
   │
   ▼
生成结论卡（ship / no-ship / iterate / inconclusive + 置信度 + 风险 + 下一步）
   │
   ▼
追问（「为什么没显著？」「如果延一周？」→ Agent 调引擎重算，不编）
   │
   ▼
导出 memo（一页，含所有证据链接）
```

---

## 5. 功能清单（P0 / P1 / P2）

### P0（必须，决定项目成立）
- 实验列表（状态徽章：进行中/可结论/样本不足）
- 实验详情：结论卡 + 核心指标表（曝光/转化/转化率/相对提升/CI/p）
- SRM 检查（卡方 + 期望样本偏差）
- 两比例 z 检验 + 差值置信区间（Newcombe）
- 分层扫描（最多 3 个维度，BH 校正）
- 护栏指标（非劣检验）
- 证据抽屉（公式、输入、样本量、数据版本、复算按钮）
- Agent 对话：只调工具、只引用证据；无 Key 时降级为模板结论
- 结论卡导出（Markdown / 复制）

### P1（差异化，简历亮点）
- 贝叶斯（Beta-Binomial）P(B>A) 与期望损失
- 功效/MDE 计算器（"还要跑几天"）
- 评测看板（120 例，决策准确率 / FPR / 数字保真度）
- Trace 面板（每步工具调用、耗时、token）
- 口径字典（指标定义集中管理，Agent 不能自创）

### P2（路线图，不阻塞 v1）
- CUPED 方差缩减
- 序贯检验（always-valid p）
- 多实验同时比较（FWER 控制）
- 真实数据源连接器（BigQuery / ClickHouse）

---

## 6. 界面设计（6 屏 + 参考项目）

| # | 屏 | 关键元素 | 参考 GitHub 项目 |
|---|---|---|---|
| 1 | 实验列表 | 状态徽章、主指标、结论列、搜索 | GrowthBook Experiments、shadcn/ui Data Table |
| 2 | 实验详情 | 结论卡（大字结论 + 置信度）、指标表、CI 图、分层热力图、护栏卡 | GrowthBook Experiment Detail、Metabase 指标卡、Tremor |
| 3 | 证据抽屉 | 公式（KaTeX）、输入输出、样本量、数据版本、复算按钮 | Langfuse Trace、WrenAI 语义层 |
| 4 | Agent 侧栏 | 对话 + 引用角标（[E1][E2]）+ 建议追问 | Vercel AI Chatbot、assistant-ui |
| 5 | 评测看板 | 准确率/FPR/校准曲线/数字保真度 | Langfuse Dashboard、shadcn Charts |
| 6 | 设置 | LLM Key、统计口径（α、校正方法）、主题 | shadcn/ui Forms |

**视觉方向**：深色专业分析风（参考 Linear / Vercel Dashboard），主色靛蓝，图表用 Recharts；数字用 tabular-nums；结论卡用大字号 + 颜色语义（绿=可上、黄=观望、红=不可上、灰=不可结论）。

---

## 7. 数据设计

### 7.1 为什么用合成数据（并且要坦白）

- 真实实验数据涉及公司隐私，拿不到；公开 A/B 数据集缺少"已知真值"。
- **评测需要 ground truth**：只有合成才能知道"真实提升是多少、正确决策是什么"。
- **诚实标注**：README 首屏写"数据由可复现的模拟器生成（种子固定），用于已知真值评测，不是真实业务数据"。这比编一个"日均百万订单"更可信。

### 7.2 实验规模

| 项 | 设计 |
|---|---|
| 实验数 | 40 个（P0）；评测集 120 个（P1，含边界） |
| 每实验样本 | 20k–200k 曝光（按功效计算） |
| 变体 | A/A、A/B、A/B/C |
| 维度 | 设备（iOS/Android/Web）× 新老 × 渠道（5 个） |
| 指标 | 转化率（二值）、ARPU（连续）、退款率（护栏）、投诉率（护栏）、延迟 p95（护栏） |
| 真值类型 | null（40）、正效应（40）、负效应（20）、异质效应（20，仅某分层有效）、SRM 异常（10）、护栏恶化（10） |

### 7.3 表结构（SQLite / JSON）

```sql
experiments(id, name, hypothesis, start_date, end_date, variants, primary_metric, status, data_version)
assignments(exp_id, variant, day, segment_device, segment_tenure, segment_channel, exposures, conversions, revenue_sum, revenue_sq_sum, refunds, complaints, latency_p95)
metric_definitions(key, name, numerator, denominator, direction, guardrail)
ground_truth(exp_id, true_lift, true_decision, notes)
```

> P0 可先预聚合到 JSON（静态站可跑）；P2 再接 SQLite。

### 7.4 数据生成器（必须开源 + 固定种子）

`scripts/gen_experiments.py`：给定 seed、效应量、样本量、分层异质性、SRM 偏移，生成上述表 + ground truth。
关键：**生成过程写进 README**，任何人可复现同样的 120 个实验。

---

## 8. 统计引擎（确定性，必须单测）

| 方法 | 用途 | 实现要点 |
|---|---|---|
| 卡方 SRM | 样本比例是否偏离预期 | 期望 = 总样本 × 分流比；p<0.001 判异常 |
| 两比例 z 检验 | 转化率 | 池化方差；双侧 p；Newcombe 差值 CI |
| Welch t 检验 | ARPU 等连续指标 | 不假设等方差 |
| Bootstrap（10k） | 比值指标 / 稳健 CI | 固定种子，可复现 |
| Beta-Binomial | 贝叶斯 P(B>A)、期望损失 | 无信息先验；输出 P 与损失 |
| BH 校正 | 分层多重比较 | q=0.1；报告校正前后 |
| 非劣检验 | 护栏指标 | margin 预设（如退款率 +0.5pp） |
| 功效/MDE | "还要跑几天" | 给定 α、power=0.8、基线率 |

**单测（必须有）**：
- z 检验 p 值与 scipy 对齐（误差 <1e-6）
- CI 覆盖率模拟（重复 1000 次，覆盖率 ≈95%）
- SRM 在无偏移时误报率 <0.1%
- BH 校正后 FDR 受控
- 固定种子 bootstrap 结果可复现

> 这一节是"我懂统计"的证据。没有单测的统计代码 = 不可信。

---

## 9. Agent 设计（关键：不让它算数）

### 9.1 角色分工

```
用户问题
  → Planner（LLM）：决定要跑哪些分析（不产出数字）
  → Tools（确定性引擎）：SRM / 指标 / 分层 / 护栏 / 功效
  → Decider（规则）：按阈值产出决策 + 置信度
  → Narrator（LLM）：只解释工具结果，每个数字带证据 ID
```

### 9.2 工具清单（全部返回结构化证据）

| 工具 | 输入 | 输出 |
|---|---|---|
| `get_experiment` | exp_id | 配置、状态、数据版本 |
| `run_srm` | exp_id | 各变体期望/实际、卡方、p、是否通过 |
| `compute_metric` | exp_id, metric, variant | 值、差值、CI、p、effect size |
| `segment_scan` | exp_id, dimension | 各分层结果 + BH 校正 + 显著分层 |
| `guardrail_check` | exp_id | 各护栏是否非劣 |
| `power_analysis` | baseline, mde, alpha | 所需样本 / 还需天数 |
| `decide` | 上述证据 | ship/no-ship/iterate/inconclusive + 理由码 |
| `get_evidence` | evidence_id | 公式、输入、输出、数据版本 |

### 9.3 System Prompt 铁律

1. 你**不能**自己做算术；所有数字必须来自工具返回。
2. 回答里每个数字后必须带 `[E#]` 引用；没有证据的数字不许出现。
3. 工具结果不足以支撑结论时，回答"不可结论"并说明缺什么。
4. 不要提"显著"却不给 p 值与 CI。
5. 分层结论必须说明已做多重比较校正。

### 9.4 无 Key 降级

没有配置 LLM Key 时：直接渲染确定性结论卡 + 模板文案（"主指标 +2.1%，95% CI [0.4%, 3.8%]，p=0.013；SRM 通过；护栏无恶化 → 建议上线"）。
**保证任何环境都能演示**，与 voice 项目的"模拟模式"同一思路。

---

## 10. 评测体系（简历上最值钱的部分）

### 10.1 数据集

120 个实验（见 §7.2），每个带 `true_lift` 与 `true_decision`。

### 10.2 指标

| 指标 | 定义 | 目标 |
|---|---|---|
| **决策准确率** | Agent 决策 == 真值决策 | ≥ 90% |
| **FPR（null 上误判有效）** | null 实验被判 ship 的比例 | ≤ 5% |
| **FNR（真有效被判无效）** | 正效应实验被判 no-ship 的比例 | ≤ 10% |
| **校准（Brier）** | 置信度 vs 实际正确率 | 越低越好 |
| **分层检测 F1** | 异质效应实验的分层识别 | ≥ 0.8 |
| **数字保真度** | 叙述中数字能在证据里找到的比例 | ≥ 99% |
| **幻觉数字率** | 证据里不存在的数字占比 | ≤ 1% |
| 延迟 / 成本 | 每次分析 P50/P95、token 成本 | 记录 |

### 10.3 跑分与看板

- `scripts/run_eval.mjs`：批量跑 120 例，输出 `eval/report.json` + `eval/report.md`
- 看板：准确率、混淆矩阵、校准曲线、保真度、失败案例 Top10（可点开看证据）
- **CI**：GitHub Actions 每次 push 跑评测，防回归

### 10.4 数字保真度怎么自动测

从 LLM 回答里正则抽取所有数字（含百分比、小数），逐个在证据集合里查找（容差 0.1pp / 0.01），找不到即记为幻觉数字。
这是本项目的"可证伪"机制，也是面试最能讲的一点。

---

## 11. 技术栈与目录

### 11.1 选型（为什么）

| 层 | 选择 | 理由 |
|---|---|---|
| 前端 | Vite + React 18 + TypeScript | 静态构建，GitHub Pages 可跑 |
| UI | Tailwind + shadcn/ui + lucide | 成熟、克制、像正经产品 |
| 图表 | Recharts | CI 图 / 分层图够用，轻 |
| 公式 | KaTeX | 证据抽屉里展示公式 |
| 统计 | 自研 TS + 单测 | 不依赖 Python，浏览器可跑；可控可测 |
| Agent | 自研轻量工具循环（无框架） | 展示"懂原理"，不是调包 |
| LLM | DeepSeek（OpenAI 兼容，浏览器直连，CORS 已验证） | 零服务端也能演示 |
| 状态 | Zustand | 轻 |
| 部署 | GitHub Pages（静态） | 不占 WorkBuddy 应用槽，独立链接 |

### 11.2 目录结构

```
experiment-copilot/
├─ web/
│  ├─ src/
│  │  ├─ pages/{Experiments,ExperimentDetail,EvalDashboard,Settings}.tsx
│  │  ├─ components/
│  │  │  ├─ ConclusionCard.tsx      # 大字结论 + 置信度 + 颜色语义
│  │  │  ├─ MetricTable.tsx         # 曝光/转化/率/提升/CI/p
│  │  │  ├─ CIPlot.tsx              # 差值 + 95% CI
│  │  │  ├─ SegmentHeatmap.tsx      # 分层效应 + BH 标记
│  │  │  ├─ GuardrailPanel.tsx      # 护栏非劣
│  │  │  ├─ EvidenceDrawer.tsx      # 公式/输入/输出/复算
│  │  │  ├─ ChatPanel.tsx           # Agent 追问（带引用）
│  │  │  └─ TracePanel.tsx          # 工具调用轨迹
│  │  ├─ lib/
│  │  │  ├─ stats/{srm,ztest,ttest,bootstrap,bayes,bh,power}.ts
│  │  │  ├─ engine/{analyze,decide,evidence}.ts
│  │  │  ├─ agent/{planner,tools,prompt,narrator}.ts
│  │  │  └─ data/{load,types}.ts
│  │  └─ data/experiments.json      # 生成物（含 ground truth）
│  └─ tests/stats/*.test.ts
├─ scripts/
│  ├─ gen_experiments.py            # 固定种子生成器
│  ├─ build_data.mjs                # 转 JSON / 校验
│  └─ run_eval.mjs                  # 120 例跑分
├─ eval/{golden.json,report.json,report.md}
├─ docs/{BLUEPRINT.md,EVAL.md,DECISIONS.md}
└─ .github/workflows/{deploy.yml,eval.yml}
```

---

## 12. 部署（避开上次的坑）

- **GitHub Pages（静态）**：`web/dist` 推到 `gh-pages` 或 `docs/`；链接形如 `https://jian935.github.io/experiment-copilot/`
- **不占用 WorkBuddy 应用槽**，与 StoryLight3D 完全独立
- LLM 走浏览器直连 DeepSeek（CORS 已验证），Key 存 sessionStorage；不填 Key 也能看确定性结论卡

---

## 13. 里程碑（每阶段有验收标准）

| 阶段 | 做什么 | 验收标准 |
|---|---|---|
| **M1 数据 + 统计** | 生成器、统计库、单测 | `npm test` 全绿；p 值与 scipy 对齐；CI 覆盖率 94–96% |
| **M2 结论卡 UI** | 列表 + 详情 + 结论卡 + 指标表 + CI 图 | 打开就有 40 个实验，点开任一实验 3 秒内出结论卡 |
| **M3 证据链** | 证据抽屉 + 复算 + 数据版本 | 每个数字可点开，复算结果与展示一致 |
| **M4 Agent** | 工具循环 + 引用 + 无 Key 降级 + Trace | 追问 10 个问题，0 个幻觉数字 |
| **M5 评测** | 120 例 + 看板 + CI | 报告出决策准确率/FPR/FNR/保真度；CI 防回归 |
| **M6 打磨** | 空态/错误态/移动端/文档/视频 | 陌生人不看代码 5 分钟能讲清价值 |

---

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 合成数据被质疑"假的" | 生成器开源 + 固定种子 + README 坦白；强调"用于已知真值评测" |
| 统计实现有 bug | 与 scipy 对齐单测 + CI 覆盖率模拟 |
| LLM 仍然编数字 | 数字保真度自动检测 + prompt 强制引用 + 无 Key 降级 |
| 被说"又一个 ChatBI" | 首屏明确"我们不生成 SQL，我们给可复算的决策"；对比表写进 README |
| 范围膨胀 | 严格 P0/P1/P2；P2 不阻塞 v1 |

---

## 15. 简历 bullet（草案，数字待回填）

- 独立设计并实现「实验结论 Copilot」：把 A/B 实验分析从"手工拉数 2 小时"压缩到"5 分钟出可复算结论卡"，覆盖 SRM 体检、显著性、分层扫描、护栏非劣与决策建议全流程。
- 提出并落地 **"LLM 不算数"** 架构：统计与计算全部由确定性引擎完成，LLM 只做编排与解释；配合**数字保真度自动检测**，把叙述中的幻觉数字率压到 **X%**（证据外数字占比）。
- 自建 **120 个已知真值实验**的评测集（含 null/正负效应/异质/ SRM 异常/护栏恶化），决策准确率 **X%**、null 误报率 **X%**、分层检测 F1 **X**；评测接入 CI 防回归。
- 完成 6 屏产品界面（实验列表 / 详情 / 证据抽屉 / Agent 侧栏 / 评测看板 / 设置），交互与信息架构参考 GrowthBook、Metabase、Vercel AI Chatbot 的成熟模式。

> 所有 X 必须等评测跑完再填，**不预估、不编造**。

---

## 16. 与已有项目的关系（作品集矩阵）

| 项目 | 证明什么 | 关键词 |
|---|---|---|
| career-loop | 可证伪的匹配 + 真实数据校准 | Agent、RAG、评测、真实用户 |
| realtime-voice-agent | 多模态交互 + 工程兜底 | 语音、实时、工具调用、PWA |
| storylight3d | 创意 + 3D 生成 + 产品叙事 | 多模态、Lux3D、体验设计 |
| **experiment-copilot** | **数据分析 + 统计严谨 + 评测体系** | **实验、决策、可审计、LLM 不算数** |

四个项目覆盖 JD 的全部高频项，且每个都有"别人不容易反驳"的硬证据。

---

## 17. 明确不做（防止膨胀）

- ❌ 不做通用 ChatBI / NL2SQL（红海）
- ❌ 不做实验平台（Feature Flag / 分流 SDK，GrowthBook 已做）
- ❌ 不接真实数据仓库（v1 用合成数据）
- ❌ 不做多租户 / 权限 / 协作
- ❌ 不做移动端 App（响应式即可）
- ❌ 不让 LLM 参与任何数值计算

---

## 18. 下一步（确认后立即开工）

1. 建仓库骨架（Vite + React + TS + Tailwind + shadcn）
2. 写 `gen_experiments.py` + 统计库 + 单测（M1）
3. 做结论卡 UI（M2）
4. 接 Agent 与证据链（M3/M4）
5. 跑 120 例评测、出报告（M5）
6. 部署 GitHub Pages + 写产品叙事 + 录 60s 演示

> 三个需要你拍板的点：**① 名字用 `experiment-copilot` 还是中文「实验结论官」作 repo 名**（建议英文 repo + 中文副标题）；**② 数据用合成（建议）还是找公开 A/B 数据集**；**③ UI 主色用靛蓝（建议）还是你偏好的其他色**。其余我按本蓝图执行。
