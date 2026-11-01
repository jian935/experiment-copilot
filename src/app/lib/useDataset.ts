import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyze, type Analysis } from '../../lib/decide.ts';
import type { DecisionConfig } from '../../lib/config.ts';
import type { Dataset, DailyRow, Experiment } from '../../lib/types.ts';

export interface Loaded {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  rowsByExp: Map<string, DailyRow[]>;
}

let cache: Promise<Loaded> | null = null;

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

let raw: Promise<Dataset> | null = null;

async function load(cfg?: Partial<DecisionConfig>): Promise<Loaded> {
  raw = raw ?? fetchDataset();
  return buildLoaded(await raw, cfg);
}

export function useDataset(cfg?: Partial<DecisionConfig>) {
  const [state, setState] = useState<{ data: Loaded | null; error: string | null }>({
    data: null,
    error: null,
  });
  // 只有真正影响结论的字段变化才重算，避免每次渲染都跑一遍 120 个实验
  const cfgKey = useMemo(
    () => (cfg ? JSON.stringify(cfg) : ''),
    [cfg],
  );

  useEffect(() => {
    let alive = true;
    if (cache) {
      // 已有数据（初始加载过或导入过）：只按新口径重算，不重新拉网络
      cache
        .then((d) => alive && setState({ data: buildLoaded(d.dataset, cfg), error: null }))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }
    cache = load(cfg);
    cache
      .then((d) => alive && setState({ data: d, error: null }))
      .catch((e: unknown) => {
        cache = null;
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [cfgKey]);

  /** 用用户导入的数据替换内存中的数据并重新计算（不走网络、不重建）。失败抛出 ImportError。 */
  const importData = useCallback((dataset: Dataset) => {
    try {
      const loaded = buildLoaded(dataset, cfg);
      cache = Promise.resolve(loaded);
      setState({ data: loaded, error: null });
    } catch (e) {
      setState({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [cfgKey]);

  return { ...state, importData };
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
    go: (h) => {
      window.location.hash = h;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
  };
}
