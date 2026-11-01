import { Activity, Code2, Loader2, Search, Settings2, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useDataset, useHashRoute } from './lib/useDataset';
import { useSettings } from './lib/settings';
import { ExperimentList } from './components/ExperimentList';
import { ExperimentDetail } from './components/ExperimentDetail';
import { EvalScreen } from './components/EvalScreen';
import { ImportDialog } from './components/ImportDialog';
import { DataSourceChip } from './components/DataSourceChip';
import { CompareScreen, compareHref } from './components/CompareScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { CommandPalette } from './components/CommandPalette';
import { buildDocs, type SearchDoc } from '../lib/search.ts';
import { Button } from './components/ui';
// 面板里承诺了「能按规则名搜」：引擎只有英文规则码，中文标签得从这里补进去
import { DECISION_META, REASON_META } from './lib/format';

export default function App() {
  const { settings, patchConfig, patchLlm, reset } = useSettings();
  // 口径变了要立刻重算：analyze 接受 Partial<DecisionConfig>，改 α / margin 后结论随之变化
  const { data, error, source, meta, storedMeta, importData, useBuiltin, useImported, forgetImport } =
    useDataset(settings.config);
  const { expId, ev, isEval, isSettings, isCompare, compareA, compareB, go } = useHashRoute();
  const [importOpen, setImportOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl+K：Win/Linux 上没有 ⌘，两个都收；输入框里也放行（浏览器默认 Ctrl+K 是跳浏览器搜索栏）
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  /** ⌘K 里能执行的动作：静态页 + 需要回调的事（导入、切数据源）。
   *  数据源相关的两条按当前状态给——没有存档时不该出现「切回导入」。 */
  /**
   * ⌘K 里能执行的动作：静态页 + 需要回调的事（导入、切数据源）。
   * 数据源相关的两条按当前状态给——没有存档时不该出现「切回导入」。
   *
   * 每个动作**显式声明 `extra` 关键词**，`subtitle` 只作展示：
   * 早期把副标题也当可搜内容，结果搜「护栏」第一条蹦出来的是设置页——
   * 因为它的副标题写着「α、护栏 margin、SRM 阈值」。那是解说字段名，不是这个名字。
   */
  const actions = useMemo<SearchDoc[]>(
    () => [
      {
        kind: 'action',
        id: 'act:list',
        target: '#/',
        title: '回到实验列表',
        subtitle: '全部 120 个实验，可再筛选',
        extra: '实验列表 全部 清选 排序',
        group: '功能',
      },
      {
        kind: 'action',
        id: 'act:eval',
        target: '#/eval',
        title: '评测看板',
        subtitle: '准确率 / FPR / 分层 F1 / 幻觉数字率',
        extra: '评测 看板 准确率 FPR 分层 F1 幻觉 数字 混淆矩阵 自校准',
        group: '功能',
      },
      {
        kind: 'action',
        id: 'act:settings',
        target: '#/settings',
        title: '口径字典 / 设置',
        subtitle: 'α、护栏 margin、SRM 阈值、判定口径',
        extra: '设置 口径字典 字典 α margin SRM 阈值 判定口径',
        group: '功能',
      },
      {
        kind: 'action',
        id: 'act:compare',
        target: '#/compare',
        title: '实验对比',
        subtitle: '选两个实验共用一条横轴对照',
        extra: '对比 对照 横轴 两次实验',
        group: '功能',
      },
      {
        kind: 'action',
        id: 'act:import',
        target: 'import',
        title: '导入数据',
        subtitle: '支持本产品导出的 JSON / CSV，存在本机刷新不丢',
        extra: '导入 上传 JSON CSV 本机存储 IndexedDB',
        group: '功能',
      },
      ...(storedMeta
        ? [
            {
              kind: 'action' as const,
              id: 'act:use-imported',
              target: 'use-imported',
              title: `切到导入的数据（${storedMeta.experiments} 例）`,
              subtitle: storedMeta.name,
              extra: '数据源 切换 导入的数据 存档',
              group: '功能',
            },
            {
              kind: 'action' as const,
              id: 'act:forget',
              target: 'forget',
              title: '删除本机存档',
              subtitle: '删掉这份导入数据，回到内置 120 例',
              extra: '删除 存档 数据源 内置',
              group: '功能',
            },
          ]
        : []),
    ],
    [storedMeta],
  );
  const searchDocsAll = useMemo(
    () =>
      data
        ? buildDocs(data.dataset, data.analyses, actions, (an) => [
            REASON_META[an.reasonCode] ?? '',
            DECISION_META[an.decision]?.label ?? '',
          ])
        : actions,
    [data, actions],
  );

  return (
    <div className="min-h-screen bg-base bg-grid">
      <header className="sticky top-0 z-30 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-6">
          <button
            onClick={() => go('#/')}
            className="flex items-center gap-2.5 rounded-lg py-1 pr-2 text-left transition-opacity hover:opacity-85"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/15 ring-1 ring-inset ring-brand/30">
              <Activity size={15} className="text-brand2" />
            </span>
            <span className="leading-tight">
              <span className="block text-[13.5px] font-semibold tracking-tight text-ink">Experiment Copilot</span>
              <span className="hidden text-[10px] text-dim sm:block">实验结论官 · 可复算的实验决策</span>
            </span>
          </button>

          <div className="ml-1 flex items-center gap-0.5 sm:ml-3 sm:gap-1">
            <button
              onClick={() => go('#/')}
              className={
                expId || isEval
                  ? 'whitespace-nowrap rounded-lg px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-panel2 hover:text-ink sm:px-2.5 sm:text-xs'
                  : 'whitespace-nowrap rounded-lg bg-panel2 px-2 py-1.5 text-[11.5px] text-ink sm:px-2.5 sm:text-xs'
              }
            >
              实验列表
            </button>
            <button
              onClick={() => go('#/eval')}
              className={
                isEval
                  ? 'whitespace-nowrap rounded-lg bg-panel2 px-2 py-1.5 text-[11.5px] text-ink sm:px-2.5 sm:text-xs'
                  : 'whitespace-nowrap rounded-lg px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-panel2 hover:text-ink sm:px-2.5 sm:text-xs'
              }
            >
              评测看板
            </button>
            <button
              onClick={() => go('#/settings')}
              className={
                isSettings
                  ? 'whitespace-nowrap rounded-lg bg-panel2 px-2 py-1.5 text-[11.5px] text-ink sm:px-2.5 sm:text-xs'
                  : 'whitespace-nowrap rounded-lg px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-panel2 hover:text-ink sm:px-2.5 sm:text-xs'
              }
            >
              口径字典 / 设置
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              title="全局搜索（⌘K / Ctrl+K）"
              className="hidden items-center gap-2 rounded-lg border border-line bg-panel2/70 py-1.5 pl-2.5 pr-2 text-[11.5px] text-dim transition-colors hover:border-line2 hover:text-muted md:flex"
            >
              <Search size={13} />
              搜索
              <kbd className="rounded border border-line2 px-1 text-[10px]">⌘K</kbd>
            </button>
            <DataSourceChip
              source={source}
              meta={meta}
              storedMeta={storedMeta}
              builtinCount={data?.dataset.experiments.length ?? 0}
              hasImport={storedMeta !== null}
              onUseBuiltin={useBuiltin}
              onUseImported={useImported}
              onForget={forgetImport}
            />
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} title="导入自己的数据（保存在本机，刷新不丢）">
              <Upload size={13} /> 导入数据
            </Button>
            <button
              onClick={() => go('#/settings')}
              title="决策口径与模型设置"
              className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line2 hover:text-ink"
            >
              <Settings2 size={14} />
            </button>
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-panel2/60 px-2.5 py-1 text-[10.5px] text-muted sm:flex">
              <i className="h-1.5 w-1.5 rounded-full bg-ship" />
              确定性引擎 · 无模型参与计算
            </span>
            <a
              href="https://github.com/jian935/experiment-copilot"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line2 hover:text-ink"
              title="源码仓库"
            >
              <Code2 size={14} />
            </a>
          </div>
        </div>
      </header>

      <main>
        {error && (
          <div className="mx-auto mt-10 max-w-lg">
            <div className="rounded-xl border border-noship/35 bg-noship/10 p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-noship">
                <TriangleAlert size={15} /> 数据加载失败
              </div>
              <p className="mt-2 text-xs leading-5 text-noship/80">{error}</p>
              <p className="mt-2 text-xs leading-5 text-muted">
                确认 <code className="rounded bg-panel2 px-1">public/data/dataset.json</code> 存在
                （执行 <code className="rounded bg-panel2 px-1">npm run data</code> 生成）。
              </p>
              <Button className="mt-3" size="sm" onClick={() => location.reload()}>
                重新加载
              </Button>
            </div>
          </div>
        )}

        {!data && !error && (
          <div className="flex flex-col items-center justify-center gap-3 py-32 text-dim">
            <Loader2 size={22} className="animate-spin" />
            <span className="text-xs">加载 120 个实验并实时计算…</span>
          </div>
        )}

        {data && isSettings && (
          <SettingsScreen
            settings={settings}
            patchConfig={patchConfig}
            patchLlm={patchLlm}
            reset={reset}
            dataset={data.dataset}
            analyses={data.analyses}
            onBack={() => go('#/')}
          />
        )}

        {data && isEval && (
          <EvalScreen
            dataset={data.dataset}
            analyses={data.analyses}
            config={settings.config}
            onOpen={(id) => go(`#/e/${id}`)}
            onBack={() => go('#/')}
          />
        )}

        {data && isCompare && (
          <CompareScreen
            dataset={data.dataset}
            analyses={data.analyses}
            aId={compareA}
            bId={compareB}
            onBack={() => go('#/')}
            onOpen={(id) => go(`#/e/${id}`)}
            go={go}
          />
        )}

        {data && !expId && !isEval && !isSettings && !isCompare && (
          <ExperimentList
            dataset={data.dataset}
            analyses={data.analyses}
            onOpen={(id) => go(`#/e/${id}`)}
            onCompare={(a, b) => go(compareHref(a, b))}
            seedNote={
              data.dataset.groundTruth === false ? '导入数据（无已知真值）' : `seed ${data.dataset.seedBase}`
            }
          />
        )}

        {data && expId && !isEval && !isSettings && !isCompare && (() => {
          const exp = data.dataset.experiments.find((e) => e.id === expId);
          const analysis = data.analyses.get(expId);
          if (!exp || !analysis) {
            return (
              <div className="mx-auto mt-16 max-w-md text-center">
                <p className="text-sm text-muted">找不到实验 {expId}</p>
                <Button className="mt-3" size="sm" onClick={() => go('#/')}>
                  返回列表
                </Button>
              </div>
            );
          }
          return (
            <ExperimentDetail
              key={expId}
              exp={exp}
              analysis={analysis}
              rows={data.rowsByExp.get(expId) ?? []}
              dataset={data.dataset}
              analyses={data.analyses}
              initialEv={ev}
              onBack={() => go('#/')}
              onCompare={(id) => go(compareHref(id))}
            />
          );
        })()}
      </main>

      <footer className="border-t border-line/70">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-4 gap-y-1 px-6 py-5 text-[10.5px] text-dim">
          <span>Experiment Copilot · 实验结论官</span>
          <span className="text-line2">|</span>
          <span>统计与决策全部在浏览器端确定性计算</span>
          <span className="text-line2">|</span>
          {source === 'user' ? (
            data && data.dataset.groundTruth === false ? (
              <span>当前为导入数据（不含已知真值），评测看板指标不适用</span>
            ) : (
              <span>当前为导入数据（含已知真值），已保存在本机</span>
            )
          ) : (
            <span>数据为固定种子合成数据，用于已知真值评测</span>
          )}
          <span className="ml-auto">作者：jian935</span>
        </div>
      </footer>

      <CommandPalette
        open={paletteOpen}
        docs={searchDocsAll}
        onClose={() => setPaletteOpen(false)}
        hint={source === 'user' ? '当前为导入数据' : `内置 ${data?.dataset.experiments.length ?? 0} 例`}
        onRun={(h) => {
          setPaletteOpen(false);
          const t = h.doc.target;
          if (t === 'import') setImportOpen(true);
          else if (t === 'use-imported') void useImported();
          else if (t === 'forget') void forgetImport();
          else go(t);
        }}
      />

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importData} />
    </div>
  );
}
