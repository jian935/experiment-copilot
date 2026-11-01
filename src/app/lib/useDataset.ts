import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyze, type Analysis } from '../../lib/decide.ts';
import type { DecisionConfig } from '../../lib/config.ts';
import type { Dataset, DailyRow, Experiment } from '../../lib/types.ts';
import { importer, type DataSource, type DatasetMeta } from './persist';

export interface Loaded {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  rowsByExp: Map<string, DailyRow[]>;
}

/** 当前生效的数据（可能是内置的，也可能是用户导入的） */
let active: Loaded | null = null;
/** 内置数据只在第一次需要时拉网络，切来切去不重复拉 */
let builtinP: Promise<Loaded> | null = null;

/** 由 Dataset 构造运行时视图：按 expId 归桶 + 对每个实验跑确定性分析。
 *  初始加载与「用户导入」共用，保证两条路径产出的结构完全一致。
 *  cfg 来自设置页：改 α / 护栏 margin 后结论必须立刻跟着变，否则"可配置"就是假的。 */
export function buildLoaded(dataset: Dataset, cfg?: Partial<DecisionConfig>): Loaded {
  const rowsByExp = new Map<string, DailyRow[]>();
  for (const r of dataset.daily) {
    const list = rowsByExp.get(r.expId);
    if (list) list.push(r);
    else rowsByExp.set(r.expId, [r]);
  }

  const analyses = new Map<string, Analysis>();
  for (const e of dataset.experiments) analyses.set(e.id, analyze(e, rowsByExp.get(e.id) ?? [], cfg));

  return { dataset, analyses, rowsByExp };
}

async function fetchDataset(): Promise<Dataset> {
  const url = `${import.meta.env.BASE_URL}data/dataset.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`数据加载失败（${res.status}）：${url}`);
  return (await res.json()) as Dataset;
}

function loadBuiltin(): Promise<Loaded> {
  return (builtinP ??= fetchDataset().then((d) => {
    // 内置数据拉失败要允许重试，否则「重新加载」按钮按了也没用
    return buildLoaded(d);
  }).catch((e: unknown) => {
    builtinP = null;
    throw e;
  }));
}

export interface DatasetState {
  data: Loaded | null;
  error: string | null;
  /** 当前数据来自内置合成数据还是用户导入 */
  source: DataSource;
  /** **当前生效**数据源的元信息（内置数据时为 null） */
  meta: DatasetMeta | null;
  /** 本机存着的导入数据（即使当前在用内置数据也保留，用来支持"切回去"） */
  storedMeta: DatasetMeta | null;
  /** 正在恢复上次导入的存档（只用于首屏文案，不要拿它挡渲染） */
  restoring: boolean;
}

export function useDataset(cfg?: Partial<DecisionConfig>) {
  const [state, setState] = useState<DatasetState>({
    data: null,
    error: null,
    source: 'builtin',
    meta: null,
    storedMeta: null,
    restoring: true,
  });
  // 只有真正影响结论的字段变化才重算，避免每次渲染都跑一遍 120 个实验
  const cfgKey = useMemo(() => (cfg ? JSON.stringify(cfg) : ''), [cfg]);

  useEffect(() => {
    let alive = true;
    if (active) {
      // 已有数据（初始加载 / 导入 / 恢复存档）：只按新口径重算，不重新拉网络
      setState((s) => ({ ...s, data: buildLoaded(active!.dataset, cfg), error: null, restoring: false }));
      return () => {
        alive = false;
      };
    }

    (async () => {
      // 冷启动第一步：先问本机有没有上次导入的存档。有就用它，别去拉内置数据。
      try {
        const imp = await importer();
        // peek 只读小 meta：不能为了判断"有没有存档"就把 1.7MB 数据取出来
        const storedMeta = await imp.peek();
        if (alive && storedMeta) setState((st) => ({ ...st, storedMeta }));
        if ((await imp.getActive()) === 'user') {
          const stored = await imp.load();
          if (stored) {
            const loaded = buildLoaded(stored.dataset, cfg);
            active = loaded;
            if (alive) {
              setState({ data: loaded, error: null, source: 'user', meta: stored.meta, storedMeta: stored.meta, restoring: false });
            }
            return;
          }
        }
      } catch {
        // 存档读不出来就当没有——不能因为持久化坏了就打不开页面
      }

      try {
        const loaded = await loadBuiltin();
        active = loaded;
        if (alive) {
          const rebuilt = cfg ? buildLoaded(loaded.dataset, cfg) : loaded;
          setState((st) => ({ ...st, data: rebuilt, error: null, source: 'builtin', meta: null, restoring: false }));
        }
      } catch (e: unknown) {
        if (alive) {
          setState((st) => ({
            ...st,
            data: null,
            error: e instanceof Error ? e.message : String(e),
            source: 'builtin',
            meta: null,
            restoring: false,
          }));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [cfgKey]);

  /**
   * 用用户导入的数据替换当前数据，并**写进本机存储**（刷新不丢）。
   * 返回值是元信息：`persisted=false` 时说明这次只在当前标签页有效，UI 必须显示出来。
   */
  const importData = useCallback(
    async (dataset: Dataset, name = '导入数据'): Promise<DatasetMeta> => {
      const loaded = buildLoaded(dataset, cfg);
      active = loaded;
      const imp = await importer();
      const meta = await imp.save(dataset, name);
      setState({ data: loaded, error: null, source: 'user', meta, storedMeta: meta, restoring: false });
      return meta;
    },
    [cfgKey],
  );

  /** 切回内置合成数据（导入的那份仍留在本机，随时能切回来） */
  const useBuiltin = useCallback(async () => {
    const imp = await importer();
    await imp.setActive('builtin');
    const loaded = await loadBuiltin();
    active = cfg ? buildLoaded(loaded.dataset, cfg) : loaded;
    setState((st) => ({ ...st, data: active, error: null, source: 'builtin', meta: null, restoring: false }));
  }, [cfgKey]);

  /** 切回上次导入的数据（不重新导入） */
  const useImported = useCallback(async () => {
    const imp = await importer();
    const stored = await imp.load();
    if (!stored) return false;
    await imp.setActive('user');
    const loaded = buildLoaded(stored.dataset, cfg);
    active = loaded;
    setState({ data: loaded, error: null, source: 'user', meta: stored.meta, storedMeta: stored.meta, restoring: false });
    return true;
  }, [cfgKey]);

  /** 彻底删掉本机存档（不是切换，是删除） */
  const forgetImport = useCallback(async () => {
    const imp = await importer();
    await imp.clear();
    setState((s) => ({ ...s, source: 'builtin', meta: null, storedMeta: null }));
  }, []);

  return { ...state, importData, useBuiltin, useImported, forgetImport };
}

/** 单实验重新计算（用于「一键复算」对比）；口径与页面保持一致 */
export function recompute(exp: Experiment, rows: DailyRow[], cfg?: Partial<DecisionConfig>): Analysis {
  return analyze(exp, rows, cfg);
}

export function useHashRoute(): {
  expId: string | null;
  ev: string | null;
  isEval: boolean;
  isSettings: boolean;
  isCompare: boolean;
  go: (hash: string) => void;
} {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const route = useMemo(() => {
    const m = /^#\/e\/([\w-]+)/.exec(hash);
    const qi = hash.indexOf('?');
    const q = new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : '');
    return { expId: m ? m[1] : null, ev: q.get('ev') };
  }, [hash]);

  return {
    expId: route.expId,
    ev: route.ev,
    isEval: /^#\/eval/.test(hash),
    isSettings: /^#\/settings/.test(hash),
    isCompare: /^#\/compare/.test(hash),
    go: (h) => {
      window.location.hash = h;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
  };
}
