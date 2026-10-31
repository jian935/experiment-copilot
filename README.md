# Experiment Copilot · 实验结论官

> 状态：**M6 完成（36s 演示视频 + 单文件作品集落地页 + 简历素材）** ｜ 2026-11-01
> 方案：[`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) ｜ M1 评测：[`docs/EVAL.md`](docs/EVAL.md) ｜ UI 说明：[`docs/UI.md`](docs/UI.md)

**一句话**：输入一个 A/B 实验，输出一张「能不能上」的可审计结论卡。
统计与决策全部由确定性引擎完成，模型只负责解释与追问——**每个数字都能点开看公式、样本量与数据版本，并能一键复算。**

![实验列表](docs/screenshots/01-实验列表.png)

## 为什么做这个

- 15 份目标 JD 里，**「数据分析 SQL/统计」出现 9/15**，是唯一还没有独立项目覆盖的高频项。
- GitHub 现状：通用 ChatBI 已挤爆（Vanna 23.8k / pandas-ai 23.9k / Chat2DB 28.3k / WrenAI 18k），
  而**实验分析只有统计库（confidence 312、abba 241）和平台（GrowthBook 8.5k），没有 AI 层**。
- 定位差异：不做 NL2SQL、不做 ChatBI，做「**可复算的实验决策**」。

## 四条原则

1. LLM never does math（所有数字来自引擎，模型不参与计算）
2. Every claim is reproducible（证据抽屉 + 一键复算）
3. Check before conclude（先 SRM / 样本量 / 护栏，再谈显著性）
4. Say "I don't know"（证据不足就说无法下结论）

## 三个屏

| 屏 | 关键内容 | 截图 |
|---|---|---|
| 实验列表 | 120 个实验、5 个可点击统计块、筛选与排序、迷你 CI；筛选状态写进 URL | [`01-实验列表.png`](docs/screenshots/01-实验列表.png) |
| 实验详情 | 结论卡 + 三条硬前置检查 + 森林图 + 趋势 + 指标/分层/护栏/计算过程 | [`02-实验详情-护栏拦截.png`](docs/screenshots/02-实验详情-护栏拦截.png) |
| 证据链 | 9 条证据时间线，**每条都能展开看逐步代入**（① 转化率 → ② SE → ③ z/p → ④ Newcombe CI → ⑤ 判定阈值） | [`03-证据链-逐步代入.png`](docs/screenshots/03-证据链-逐步代入.png) |
| 规则轨迹 | 结论那条证据展开后是 6 条规则按优先级依次判断，标出命中/被覆盖/未触发 | [`04-规则判定轨迹.png`](docs/screenshots/04-规则判定轨迹.png) |
| 结论卡导出 | 一键导出 2 倍图 PNG（880×552），可直接贴文档/简历/群聊 | [`05-结论卡导出.png`](docs/screenshots/05-结论卡导出.png) |
| Agent 面板 | 建议问题、规则/智能双模式、工具调用可视化、回答带可点引用、数字审计徽章 | [`06-Agent-建议问题.png`](docs/screenshots/06-Agent-建议问题.png) · [`07-Agent-问答.png`](docs/screenshots/07-Agent-问答.png) |
| 评测看板 | 混淆矩阵、按类型/按 p 值分桶准确率、4 条失败案例可点开、ablation 双列对比 | [`08-评测看板.png`](docs/screenshots/08-评测看板.png) |

**演示视频（36s）**：[`deliverables/video/Experiment-Copilot-演示.mp4`](deliverables/video/Experiment-Copilot-演示.mp4) —— 真实操作录屏 + 中文旁白 + 字幕。
**作品集落地页**：[`portfolio/index.html`](portfolio/index.html) —— 单文件 1.75MB，视频与截图全部内联，可直接发人。

深链：`#/e/E001` 直达实验，`#/e/E001?ev=E6` 直接展开第 6 条证据，`#/?d=ship&s=diff` 还原筛选视图。

详情页里两个「别的 demo 没有」的东西：

- **计算过程 Tab**：把 `p̂ = c/n`、`SE = √(p̄(1−p̄)(1/n₁+1/n₂))`、`z`、Newcombe 区间、SRM 卡方的**代入数值**全摊开，任何一条都能手算核对。
- **真值对照**（折叠）：合成数据注入过真实效应，所以可以把「引擎判定 vs 真实决策」放在页面上——包括不一致的那几个。

## 快速开始

```bash
npm install
npm run dev        # 本地开发（自动先跑 npm run data）
npm run build      # 生成 dist/（含 tsc --noEmit + vite build）
npm run preview    # 预览构建产物

npm test           # 56 个单测（统计 / 决策 / 证据推导 / 导出卡片 / Agent / 工具循环 / 评测口径）
npm run ablation   # 规则 vs 大模型对比，输出 docs/ABLATION.md
node scripts/record_demo.mjs && python scripts/build_demo_video.py   # 重录演示视频
python scripts/build_portfolio.py                                    # 重建作品集页
npm run gen        # 用固定种子重新生成 120 个实验（data/）
npm run calibrate  # 120 例校准：混淆矩阵 + 五项指标
```

打开后：列表页点任意实验 → 详情页 → 右上角「证据链」→ 底部「一键复算」。

## 目录

```
src/lib/stats.ts        统计引擎（零依赖）：SRM / 两比例 z / Newcombe CI / Wilson / BH / 功效 / Welch
src/lib/decide.ts       决策引擎：6 条规则的优先级 + 证据链生成
src/lib/simulate.ts     数据生成器（固定种子，6 类原型）
src/app/                UI：Vite + React 19 + TS + Tailwind v3
  components/Forest.tsx        手写 SVG 森林图（比图表库更可控）
  components/Trend.tsx         Recharts 分日趋势
  components/ExperimentList.tsx / ExperimentDetail.tsx / EvidenceDrawer.tsx
scripts/                生成 / 校准 / 导出前端数据 / 录屏 / 视频 / 作品集构建
  record_demo.mjs         真实操作录屏（CDP screencast + 帧时间戳）
  build_demo_video.py     旁白视频合成（edge-tts + 按时间戳重采样 + ASS 字幕）
  build_portfolio.py      单文件作品集页（视频/截图内联）
tests/                  18 个单测（含 6 组 scipy 对齐）
data/                   120 个实验 / 6,720 行；另有 6 个手工核对过的 seed（xlsx）
docs/                   蓝图 / 数据需求 / 数据修正记录 / M1 评测 / UI 说明 / Ablation / 截图
```

## 已完成

### M1 — 数据 + 统计 + 决策 + 校准

| 模块 | 内容 |
|---|---|
| 统计引擎 | SRM 卡方、两比例 z、Newcombe 差值 CI、Wilson、BH 多重比较、功效/MDE、Welch |
| 决策引擎 | 6 条优先规则 → `ship / no-ship / iterate / inconclusive` + 证据链 |
| 数据生成器 | 120 实验 / 6,720 行，固定种子可复现（null 40 / positive 25 / guardrail 15 / heterogeneous 15 / negative 15 / srm 10） |
| 单测 | 18 个全绿，6 组 z 检验 p 值与 scipy 相对误差 < 1e-4 |
| 校准 | **决策准确率 96.7%**（116/120）、null 误报 7.5%、正负效应漏判 0%、异质/ SRM / 护栏识别 100% |

> 剩下 4 例全是 null 实验在 α=0.05 下的正常假阳性，**故意不修**——评测看板要如实展示失败案例。

### M2 — 结论卡 UI + 证据链

| 模块 | 内容 |
|---|---|
| 列表 | 120 行、5 个可点击统计块、搜索 / 类型 / 排序、行内迷你 CI |
| 详情 | 结论卡、三条硬前置检查、森林图、7 日趋势、指标明细、分层（含 BH q）、护栏、计算过程、真值对照 |
| 证据链 | 侧滑抽屉、9 条证据、数据口径表、一键复算（逐项比对，0.1–0.3ms） |
| 交互 | hash 路由可直接分享单实验链接、Esc 关闭抽屉、响应式（1440 / 1024 / 820 均验过） |

### M3 — 让证据链可验算

| 模块 | 内容 |
|---|---|
| 逐步代入 | 每条证据自带 3–5 步推导（公式 + 实际数值），护栏复用真实 z / CI，不构造占位值 |
| 规则轨迹 | 引擎输出 `rules: 6 条规则 × (条件, 明细, 是否命中)`；抽屉里高亮命中项，标出「被更高优先级覆盖」 |
| 结论卡导出 | 手写 SVG → canvas → PNG（2 倍图），零第三方截图库；卡片高度随理由行数自适应 |
| 深链 | 列表筛选写回 URL（`replaceState`，不触发 hashchange）；证据级深链 `?ev=E6` 自动展开并滚动到可视区 |
| 单测 | 27 个（新增 9 个）：推导数值必须对得上引擎、规则轨迹恰好命中一条、护栏 z 不得为占位 0、SVG 不得含 undefined/NaN |

### M4 — Agent（说话的人，不是算数的人）

| 模块 | 内容 |
|---|---|
| 8 个工具 | 读取结论 / 重算检验 / 扫描分层 / 检查护栏 / 推算 MDE / 检索相似 / 检索列表 / 回溯规则；全部纯函数只读引擎结果 |
| 5 条铁律 | 不许自己算数 / 每个数字必须带 `[E#]` 引用 / 证据不足就说不知道 / 口径变化必须说明 / 不许编造历史实验 |
| 双模式 | **规则模式**（免密钥，确定性路由 + 模板）；**智能模式**（DeepSeek function calling，浏览器直连，Key 只存 sessionStorage），失败自动回退规则模式并说明原因 |
| 数字审计 | 回答里的每个数字都要在白名单（引擎 + 工具返回）里按显示精度对得上；对不上就标红列出 |
| 引用可点 | 回答里的 `E6` 是按钮，点开直接跳到证据抽屉并展开该条 |
| Ablation | `npm run ablation`：同一批问题（8 题 × 3 个实验）跑规则/智能两种模式，比较引用覆盖率、可疑数字率、口径识别率 |

**规则模式当前成绩**（24 条问答，`docs/ABLATION.md`）：引用覆盖 **100%**、可疑数字 **0**、违规 **0**、口径陷阱识别 **100%**。
智能模式需要 DeepSeek Key（`DEEPSEEK_API_KEY=sk-... npm run ablation`），尚未跑；**没有跑之前不会给它写任何数字**。

**没有 Key 也能验证链路**（不产生任何模型能力结论，只验证工具循环）：

```bash
node scripts/mock_llm.mjs          # 本地 mock，返回「先调工具、再作答」
# 浏览器控制台：localStorage.ec_llm_base = 'http://127.0.0.1:8787/v1'，Key 随便填
```

工具循环本身有 8 个单测覆盖（`tests/llm.test.ts`）：工具结果回填、未知工具、坏 JSON 参数、超过 3 轮、
接口 401、网络不通、模型编数字被抓、缺引用被判违规。

### M5 — 评测看板（`#/eval`）

| 模块 | 内容 |
|---|---|
| 五个 KPI | 决策准确率 96.7%（116/120）、null 误报率 7.5%（3/40）、正/负效应漏判 0%、Agent 引用覆盖 100% |
| 混淆矩阵 | 4×4，对角线绿、错判红，鼠标悬停看「真实 → 引擎」的计数 |
| 证据强度分桶 | 按 p 值分四桶看准确率：p<0.001 是 100%，**0.01–0.05 是 0%（0/3）**——恰好跨过阈值的实验本就无法判定 |
| 失败案例 | 4 条全部列出、可点开看证据链；不修是刻意的（改了反而像在挑数据） |
| Ablation | 规则模式 vs 智能模式并排：引用覆盖率 / 可疑数字率 / 违规率 / 口径识别 / 平均字数 |
| 口径 | 单一源 `src/lib/evaluate.ts`，脚本 `npm run calibrate` 与看板共用，杜绝两套数字 |

> FPR 分母只取 `archetype=null`（40 个真实无效应）。SRM 实验属于「数据坏了」另一种失败模式，
> 混进分母会把误报率稀释成 6.0%——那不是更准，是分母被白送。

### M6 — 演示与包装

| 模块 | 内容 | 复现 |
|---|---|---|
| 演示视频 | 36s / 1280×720 / 30fps，真实操作 + 旁白 + 字幕；8 个片段按「先展示拒绝、再展示解释」排序 | `node scripts/record_demo.mjs` → `python scripts/build_demo_video.py` |
| 作品集落地页 | 单文件自包含（视频 0.79MB + 6 张截图内联），可单独发给面试官 | `python scripts/build_portfolio.py` |
| 简历素材 | 3 条 bullet、3 分钟面试动线、能说/不能说的数字、6 个高频追问 | `简历素材-项目链接与要点.md` |

**视频流水线踩到的三个坑**（都写进了脚本注释）：
1. screencast 只在画面变化时出帧，静止段没有帧 → 必须用 CDP 的帧时间戳重采样，不能按平均帧率算；
2. 用 concat demuxer 的 `duration` 拼图片序列会漂移（实测 28.6s 拼成 33.1s）→ 改成 Python 侧按时间戳重采样成严格 30fps 序列；
3. 录制脚本靠 sleep 等渲染不可靠（页面渲染比脚本慢）→ 全部改成轮询等元素出现再点，否则会点到还没挂载的按钮。

## 技术栈

Vite 8 + React 19 + TypeScript + Tailwind CSS **v3**（不用 v4：其区间语法媒体查询在 Chrome<104 失效）+ Recharts（仅趋势图）；
森林图手写 SVG；统计自研带单测；无后端、无数据库。后续 Agent 走 DeepSeek 浏览器直连，部署 GitHub Pages。

## 里程碑

M1 数据+统计 ✅ → M2 结论卡 UI ✅ → M3 证据链可验算 ✅ → M4 Agent ✅ → M5 评测看板 ✅ → **M6 演示与包装 ✅** → 部署（等网络）。
验收标准见蓝图 §13。
