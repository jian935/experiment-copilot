import { useMemo, useState } from 'react';
import {
  createDecisionStore,
  memoryKv,
  type DecisionRecord,
  type DecisionStore,
} from './decisions';

/**
 * 决策记录的读写。
 *
 * localStorage 在隐私模式/配额满时会抛错，这里直接回退到内存版：
 * 功能仍可用（当次有效），只是刷新后消失——这比整页崩掉好，也比假装保存成功好。
 */
export function useDecisions(): {
  map: Record<string, DecisionRecord>;
  put: (rec: DecisionRecord) => void;
  remove: (expId: string) => void;
  store: DecisionStore;
} {
  const store = useMemo<DecisionStore>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        // 先探一次：隐私模式下 setItem 会抛
        localStorage.setItem('ec_probe', '1');
        localStorage.removeItem('ec_probe');
        return createDecisionStore(localStorage);
      }
    } catch {
      // 落到内存版
    }
    return createDecisionStore(memoryKv());
  }, []);

  const [map, setMap] = useState<Record<string, DecisionRecord>>(() =>
    Object.fromEntries(store.all().map((r) => [r.expId, r])),
  );

  return {
    map,
    put: (rec) => {
      store.put(rec);
      setMap((prev) => ({ ...prev, [rec.expId]: rec }));
    },
    remove: (expId) => {
      store.remove(expId);
      setMap((prev) => {
        const next = { ...prev };
        delete next[expId];
        return next;
      });
    },
    store,
  };
}
