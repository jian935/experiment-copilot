/**
 * 可编辑口径字典的持久化层。
 *
 * 与 `decisions.ts` 完全同构（纯函数库 + 一个 hook + localStorage），
 * 因为两者的数据形态一样：一份文档 + 一条不可变历史。
 *
 * 一条纪律：**读到坏数据一律回退到「初始版本」，不做尽可能的修补**。
 * 口径字典坏了会让所有实验的结论变得无法解释，而且没人看得出来——
 * 与其猜一个半对的形状，不如明确回到出厂口径（历史版本还在，用户能自己回滚）。
 */

import { useCallback, useMemo, useState } from 'react';
import {
  baseDoc, currentSnapshot, currentVersion, resolveDefs, rollbackTo, saveSnapshot,
  type MetricDoc, type MetricSnapshot,
} from '../../lib/metricDict.ts';

const KEY = 'ec_metric_dict_v1';

function validDoc(x: unknown): MetricDoc | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as MetricDoc;
  if (!Array.isArray(d.versions) || !d.versions.length) return null;
  for (const v of d.versions) {
    if (typeof v.version !== 'number' || !v.snapshot || typeof v.snapshot !== 'object') return null;
    if (!Array.isArray(v.snapshot.custom)) return null;
    if (!v.snapshot.patches || typeof v.snapshot.patches !== 'object') return null;
  }
  return d;
}

function load(): MetricDoc {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return baseDoc();
    return validDoc(JSON.parse(raw)) ?? baseDoc();
  } catch {
    return baseDoc();
  }
}

export interface MetricDictApi {
  doc: MetricDoc;
  snapshot: MetricSnapshot;
  version: number;
  /** 当前生效的完整指标表（内置覆盖 + 自定义） */
  defs: ReturnType<typeof resolveDefs>;
  /** 保存成新版本；没有实际改动时抛错（不产生空版本） */
  save: (next: MetricSnapshot) => { version: number; summary: string[] };
  rollback: (version: number) => { version: number; summary: string[] };
  /** 清空本机改动，回到出厂口径（也会新增一个版本，历史不丢） */
  reset: () => void;
}

export function useMetricDict(): MetricDictApi {
  const [doc, setDoc] = useState<MetricDoc>(load);

  const commit = useCallback((next: MetricDoc) => {
    setDoc(next);
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 配额满 / 隐私模式：内存里仍然生效，刷新会丢——与导入存档的处理一致 */
    }
  }, []);

  const save = useCallback(
    (next: MetricSnapshot) => {
      const r = saveSnapshot(doc, next, '本机', new Date().toISOString());
      commit(r.doc);
      return { version: r.version, summary: r.summary };
    },
    [doc, commit],
  );

  const rollback = useCallback(
    (version: number) => {
      const r = rollbackTo(doc, version, '本机', new Date().toISOString());
      commit(r.doc);
      return { version: r.version, summary: r.summary };
    },
    [doc, commit],
  );

  const reset = useCallback(() => {
    try {
      commit(saveSnapshot(doc, { patches: {}, custom: [] }, '本机', new Date().toISOString()).doc);
    } catch {
      /* 本来就没有改动，不用回滚 */
    }
  }, [doc, commit]);

  const snapshot = useMemo(() => currentSnapshot(doc), [doc]);
  const defs = useMemo(() => resolveDefs(snapshot), [snapshot]);
  return { doc, snapshot, version: currentVersion(doc), defs, save, rollback, reset };
}
