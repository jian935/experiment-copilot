import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyze, type Analysis } from '../../lib/decide.ts';
import type { Dataset, DailyRow, Experiment } from '../../lib/types.ts';

export interface Loaded {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  rowsByExp: Map<string, DailyRow[]>;
}

let cache: Promise<Loaded> | null = null;

/** 由 Dataset 构造运行时视图：按 expId 归桶 + 对每个实验跑确定性分析。
 *  初始加载与「用户导入」共用，保证两条路径产出的结构完全一致。 */
export function buildLoaded(dataset: Dataset): Loaded {
  const rowsByExp = new Map<string, DailyRow[]>();
  for (const r of dataset.daily) {
    const list = rowsByExp.get(r.expId);
    if (list) list.push(r);
    else rowsByExp.set(r.expId, [r]);
  }

  const analyses = new Map<string, Analysis>();
  for (const e of dataset.experiments) analyses.set(e.id, analyze(e, rowsByExp.get(e.id) ?? []));

  return { dataset, analyses, rowsByExp };
}

async function load(): Promise<Loaded> {
  const url = `${import.meta.env.BASE_URL}data/dataset.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`数据加载失败（${res.status}）：${url}`);
  const dataset = (await res.json()) as Dataset;
  return buildLoaded(dataset);
}

export function useDataset() {
  const [state, setState] = useState<{ data: Loaded | null; error: string | null }>({
    data: null,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    cache = cache ?? load();
    cache
      .then((d) => alive && setState({ data: d, error: null }))
      .catch((e: unknown) => {
        cache = null;
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 用用户导入的数据替换内存中的数据并重新计算（不走网络、不重建）。失败抛出 ImportError。 */
  const importData = useCallback((dataset: Dataset) => {
    try {
      const loaded = buildLoaded(dataset);
      cache = Promise.resolve(loaded);
      setState({ data: loaded, error: null });
    } catch (e) {
      setState({ data: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  return { ...state, importData };
}

/** 单实验重新计算（用于「一键复算」对比） */
export function recompute(exp: Experiment, rows: DailyRow[]): Analysis {
  return analyze(exp, rows);
}

export function useHashRoute(): {
  expId: string | null;
  ev: string | null;
  isEval: boolean;
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
    go: (h) => {
      window.location.hash = h;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
  };
}
