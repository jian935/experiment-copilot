import { beforeEach, describe, expect, it } from 'vitest';
import {
  STORE_VERSION,
  buildMeta,
  createImporter,
  isCompatible,
  memoryBackend,
  type KvBackend,
} from '../src/app/lib/persist.ts';
import type { Dataset } from '../src/lib/types.ts';

/** 最小可用数据集：persist 不关心业务内容，只要能看出「是不是正经 Dataset」 */
function miniDataset(expCount = 2, rows = 8, groundTruth?: boolean): Dataset {
  return {
    generatedAt: '2026-11-01T00:00:00.000Z',
    seedBase: 1,
    groundTruth,
    spec: { days: 1, segments: ['new', 'old'], baselineRate: [0.04, 0.05], refundRate: 0.012, complaintRate: 0.0012, latencyMean: 820, latencySd: 90 },
    experiments: Array.from({ length: expCount }, (_, i) => ({ id: `E${i + 1}` })) as unknown as Dataset['experiments'],
    daily: Array.from({ length: rows }, () => ({ expId: 'E1' })) as unknown as Dataset['daily'],
  };
}

/** 记录访问过的 key，用来验证 peek 不会去取数据本体 */
function spyBackend(): KvBackend & { reads: string[] } {
  const inner = memoryBackend();
  const reads: string[] = [];
  return {
    kind: inner.kind,
    reads,
    get: <T>(k: string) => {
      reads.push(k);
      return inner.get<T>(k);
    },
    set: inner.set,
    del: inner.del,
  };
}

/** 写入必失败的后端：模拟配额不足 / 隐私模式 */
function failingBackend(): KvBackend {
  const inner = memoryBackend();
  return {
    kind: 'localStorage',
    get: inner.get,
    set: () => Promise.reject(new Error('QuotaExceededError: exceeded the quota')),
    del: inner.del,
  };
}

describe('C3 · 导入数据持久化', () => {
  let backend: KvBackend;
  let imp: ReturnType<typeof createImporter>;

  beforeEach(() => {
    backend = memoryBackend();
    imp = createImporter(backend);
  });

  it('存 → 取 往返，meta 与数据集内容一致', async () => {
    const ds = miniDataset(3, 12);
    const meta = await imp.save(ds, 'my-export.csv');
    expect(meta.persisted).toBe(true);
    expect(meta.name).toBe('my-export.csv');
    expect(meta.experiments).toBe(3);
    expect(meta.rows).toBe(12);

    const back = await imp.load();
    expect(back).not.toBeNull();
    expect(back!.meta.name).toBe('my-export.csv');
    expect(back!.dataset.experiments).toHaveLength(3);
    expect(back!.dataset.daily).toHaveLength(12);
  });

  it('保存后当前数据源变 user；clear 后变回 builtin 且取不到数据', async () => {
    await imp.save(miniDataset(), 'a.json');
    expect(await imp.getActive()).toBe('user');
    expect(await imp.peek()).not.toBeNull();

    await imp.clear();
    expect(await imp.getActive()).toBe('builtin');
    expect(await imp.load()).toBeNull();
    expect(await imp.peek()).toBeNull();
  });

  it('切回内置不删存档：还能再切回导入的那份', async () => {
    await imp.save(miniDataset(4, 9), 'a.json');
    await imp.setActive('builtin');
    expect(await imp.getActive()).toBe('builtin');
    // 数据本体还在
    const back = await imp.load();
    expect(back!.dataset.experiments).toHaveLength(4);
    expect(await imp.peek()).not.toBeNull();
    // 切回去
    await imp.setActive('user');
    expect(await imp.getActive()).toBe('user');
  });

  it('版本不符的存档直接丢弃（拿旧结构跑 analyze 会得到 NaN 而不是报错）', async () => {
    await backend.set('import.dataset', { v: STORE_VERSION + 1, meta: { name: 'old' }, dataset: miniDataset() });
    await backend.set('import.meta', { v: STORE_VERSION + 1, meta: { name: 'old' } });
    await backend.set('active.source', 'user');

    expect(await imp.load()).toBeNull();
    // 丢弃后要同时复位当前数据源，否则下次启动会拿不到数据却仍试 user
    expect(await imp.getActive()).toBe('builtin');
    expect(await imp.peek()).toBeNull();
  });

  it('存不下不抛错，而是返回 persisted:false + 能读懂的理由', async () => {
    const bad = createImporter(failingBackend());
    const meta = await bad.save(miniDataset(), 'big.csv');
    expect(meta.persisted).toBe(false);
    expect(meta.persistedNote).toContain('本机存储空间不足');
    // 关键：不能因为存不下就报导入失败——内存里照样能用
    expect(meta.experiments).toBe(2);
  });

  it('peek 不读数据本体（只读小 meta）', async () => {
    const spy = spyBackend();
    const i = createImporter(spy);
    await i.save(miniDataset(), 'a.json');
    spy.reads.length = 0;
    const m = await i.peek();
    expect(m!.name).toBe('a.json');
    expect(spy.reads).toEqual(['import.meta']);
  });

  it('buildMeta：groundTruth 缺省视为「有真值」，false 才是没有', () => {
    expect(buildMeta(miniDataset(1, 1), 'x').groundTruth).toBe(true);
    expect(buildMeta(miniDataset(1, 1, true), 'x').groundTruth).toBe(true);
    expect(buildMeta(miniDataset(1, 1, false), 'x').groundTruth).toBe(false);
    expect(buildMeta(miniDataset(1, 1), 'x').persisted).toBe(false);
  });

  it('isCompatible 只认「有 experiments 与 daily 且非空」的记录', () => {
    const ok = { v: STORE_VERSION, meta: {}, dataset: miniDataset() };
    expect(isCompatible(ok)).toBe(true);
    expect(isCompatible(null)).toBe(false);
    expect(isCompatible('x')).toBe(false);
    expect(isCompatible({})).toBe(false);
    expect(isCompatible({ v: STORE_VERSION, dataset: { experiments: [], daily: [] } })).toBe(false);
    expect(isCompatible({ v: STORE_VERSION, dataset: { experiments: [{ id: 'E1' }], daily: undefined } })).toBe(false);
  });

  it('内存后端的 kind 是 memory（用于 UI 上说明「本次不持久」）', async () => {
    expect(createImporter(memoryBackend()).backendKind).toBe('memory');
  });
});
