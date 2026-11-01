import { Activity, Code2, Loader2, TriangleAlert } from 'lucide-react';
import { useDataset, useHashRoute } from './lib/useDataset';
import { ExperimentList } from './components/ExperimentList';
import { ExperimentDetail } from './components/ExperimentDetail';
import { EvalScreen } from './components/EvalScreen';
import { Button } from './components/ui';

export default function App() {
  const { data, error } = useDataset();
  const { expId, ev, isEval, go } = useHashRoute();

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
          </div>

          <div className="ml-auto flex items-center gap-2">
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

        {data && isEval && (
          <EvalScreen
            dataset={data.dataset}
            analyses={data.analyses}
            onOpen={(id) => go(`#/e/${id}`)}
            onBack={() => go('#/')}
          />
        )}

        {data && !expId && !isEval && (
          <ExperimentList
            dataset={data.dataset}
            analyses={data.analyses}
            onOpen={(id) => go(`#/e/${id}`)}
            seedNote={`seed ${data.dataset.seedBase}`}
          />
        )}

        {data && expId && !isEval && (() => {
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
          <span>数据为固定种子合成数据，用于已知真值评测</span>
          <span className="ml-auto">作者：jian935</span>
        </div>
      </footer>
    </div>
  );
}
