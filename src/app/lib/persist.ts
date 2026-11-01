/**
 * 导入数据的本机持久化（C3）。
 *
 * 要解决的问题很具体：现在导入一份数据、刷新页面就没了——这是「半成品感」最直接的来源之一。
 * 但持久化有三件事必须先想清楚，否则做出来的是个更隐蔽的坑：
 *
 * ① **存哪儿**：`public/data/dataset.json` 已经 1.7MB，用户真实数据只会更大。
 *    localStorage 存的是 **UTF-16 字符串**，1.7MB 的 JSON 要占 3.4MB，而配额通常只有 5MB——
 *    一次稍大的导入就 `QuotaExceededError`。所以主路径用 **IndexedDB**（存结构化对象、配额按源给、通常几百 MB）。
 *    localStorage 只作为 IndexedDB 不可用时的降级（隐私模式、老浏览器），并且要如实告诉用户降级了。
 * ② **怎么失败**：存不下时**不能静默**。导入本身要照常成功（内存里能用），
 *    但必须返回「本次只在当前标签页有效」这种话。静默失败比不持久化更糟。
 * ③ **什么时候作废**：数据结构会演进。老记录里的字段可能已经不存在，
 *    拿它去跑 `analyze()` 会得到 NaN 而不是报错。所以记录带 `v`，版本不符**直接丢掉**并说明。
 *
 * 设计上把「纯决策」和「浏览器 API」分开：
 *   - `createImporter(backend)` 只依赖一个三方法的 `KvBackend` 接口 → 单测用内存后端就能覆盖全部逻辑；
 *   - IndexedDB / localStorage 的差异被关在 `pickBackend()` 里，不渗透到调用方。
 */

import type { Dataset } from '../../lib/types.ts';

/** 记录格式版本。任何会让旧记录跑不通的改动都要 +1（然后旧记录会被丢弃）。 */
export const STORE_VERSION = 1;

const KEY_IMPORT = 'import.dataset';
/** 单独存一份小 meta：只在需要「本机有没有存档」时读它，不用把 1.7MB 数据整个取出来 */
const KEY_META = 'import.meta';
const KEY_ACTIVE = 'active.source';

/** 数据源：内置合成数据，或用户导入的那一份 */
export type DataSource = 'builtin' | 'user';

export interface DatasetMeta {
  /** 文件名，或「粘贴的 JSON」/「CSV 导入」 */
  name: string;
  importedAt: string;
  experiments: number;
  rows: number;
  groundTruth: boolean;
  /** 存进去了没有。false = 只在当前标签页有效（配额不足或后端不可用） */
  persisted: boolean;
  /** 没存进去的原因（给 UI 显示，不要吞掉） */
  persistedNote?: string;
}

export interface StoredImport {
  meta: DatasetMeta;
  dataset: Dataset;
}

/** 存储后端的最小接口。三个方法就够，故意不做事务 / 索引——这里只需要一个「槽位」。 */
export interface KvBackend {
  readonly kind: 'idb' | 'localStorage' | 'memory';
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

/* ───────────────────────── 后端实现 ───────────────────────── */

const DB_NAME = 'experiment-copilot';
const DB_VERSION = 1;
const STORE = 'kv';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
  });
}

function idbBackend(): KvBackend {
  let dbP: Promise<IDBDatabase> | null = null;
  const db = () => (dbP ??= openIdb());

  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
        }),
    );

  return {
    kind: 'idb',
    get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).then((v) => v ?? null),
    set: <T>(key: string, value: T) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
    del: (key: string) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
  };
}

/** localStorage 降级：IDB 不可用时用。存字符串，所以大对象有配额风险。 */
function lsBackend(): KvBackend {
  const raw = (k: string) => window.localStorage.getItem(`${DB_NAME}.${k}`);
  return {
    kind: 'localStorage',
    get: async <T>(key: string) => {
      const s = raw(key);
      return s === null ? null : (JSON.parse(s) as T);
    },
    set: async <T>(key: string, value: T) => {
      window.localStorage.setItem(`${DB_NAME}.${key}`, JSON.stringify(value));
    },
    del: async (key: string) => {
      window.localStorage.removeItem(`${DB_NAME}.${key}`);
    },
  };
}

/** 内存后端：单测用，也给「什么都没得用」的极端情形兜底（此时就是不持久化）。 */
export function memoryBackend(): KvBackend {
  const m = new Map<string, unknown>();
  return {
    kind: 'memory',
    get: async <T>(key: string) => (m.has(key) ? (m.get(key) as T) : null),
    set: async <T>(key: string, value: T) => {
      m.set(key, value);
    },
    del: async (key: string) => {
      m.delete(key);
    },
  };
}

/**
 * 挑一个可用的后端：IndexedDB → localStorage → 内存（不持久化）。
 * 判断方式是**真的写一次再删**，不是只看 `'indexedDB' in window`——
 * 隐私模式下 API 存在但写入会抛，那种情况必须降级。
 */
export async function pickBackend(): Promise<KvBackend> {
  const probe = async (b: KvBackend): Promise<boolean> => {
    try {
      await b.set('__probe', { t: Date.now() });
      const back = await b.get<{ t: number }>('__probe');
      await b.del('__probe');
      return back !== null;
    } catch {
      return false;
    }
  };

  if (typeof indexedDB !== 'undefined') {
    const b = idbBackend();
    if (await probe(b)) return b;
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const b = lsBackend();
    if (await probe(b)) return b;
  }
  return memoryBackend();
}

/* ───────────────────────── 纯逻辑（可在 node 里测） ───────────────────────── */

/** 从数据集算出可展示的元信息。导入对话框与顶部数据源条都用它，避免两处说法不一。 */
export function buildMeta(dataset: Dataset, name: string, now = new Date()): DatasetMeta {
  return {
    name,
    importedAt: now.toISOString(),
    experiments: dataset.experiments.length,
    rows: dataset.daily.length,
    groundTruth: dataset.groundTruth !== false,
    persisted: false,
  };
}

/**
 * 记录是否还能用。
 *
 * 为什么版本不符要直接丢而不是「尽量兼容」：`analyze()` 读的都是具体字段，
 * 少一个 `spec.regressionSd` 之类不会报错，只会算出 NaN 或者悄悄用 0——
 * 那比直接告诉用户"存档过期"危险得多。
 */
export function isCompatible(rec: unknown): rec is { v: number; meta: DatasetMeta; dataset: Dataset } {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as { v?: unknown; meta?: unknown; dataset?: unknown };
  if (r.v !== STORE_VERSION) return false;
  const ds = r.dataset as Dataset | undefined;
  if (!ds || !Array.isArray(ds.experiments) || !Array.isArray(ds.daily)) return false;
  if (ds.experiments.length === 0) return false;
  return true;
}

/* ───────────────────────── 对外 API ───────────────────────── */

export interface Importer {
  readonly backendKind: KvBackend['kind'];
  /** 保存一份导入数据并切到它。存不下时**不抛错**，而是返回 persisted:false 的 meta。 */
  save(dataset: Dataset, name: string): Promise<DatasetMeta>;
  load(): Promise<StoredImport | null>;
  /** 只读 meta（不取数据本体）：判断「本机有没有存档」用它，别用 load() */
  peek(): Promise<DatasetMeta | null>;
  clear(): Promise<void>;
  setActive(src: DataSource): Promise<void>;
  getActive(): Promise<DataSource>;
}

export function createImporter(backend: KvBackend): Importer {
  return {
    backendKind: backend.kind,

    async save(dataset, name) {
      const meta = buildMeta(dataset, name);
      try {
        await backend.set(KEY_IMPORT, { v: STORE_VERSION, meta, dataset });
        await backend.set(KEY_META, { v: STORE_VERSION, meta });
        await backend.set(KEY_ACTIVE, 'user');
        return { ...meta, persisted: true };
      } catch (e) {
        // 存不下不是致命错误：内存里照样能用，但必须说清楚这次不持久
        const msg = e instanceof Error ? e.message : String(e);
        const quota = /quota|exceed|storage/i.test(msg);
        return {
          ...meta,
          persisted: false,
          persistedNote: quota
            ? `本机存储空间不足（${backendKindLabel(backend.kind)}），本次导入只在当前标签页有效`
            : `没能写入本机存储（${msg}），本次导入只在当前标签页有效`,
        };
      }
    },

    async load() {
      const rec = await backend.get<unknown>(KEY_IMPORT);
      if (!rec) return null;
      if (!isCompatible(rec)) {
        // 旧版本的存档：丢掉并说明，避免用过期结构跑出 NaN
        await backend.del(KEY_IMPORT);
        await backend.del(KEY_META);
        await backend.del(KEY_ACTIVE);
        return null;
      }
      return { meta: rec.meta, dataset: rec.dataset };
    },

    async peek() {
      const rec = await backend.get<{ v?: number; meta?: DatasetMeta }>(KEY_META);
      return rec && rec.v === STORE_VERSION && rec.meta ? rec.meta : null;
    },

    async clear() {
      await backend.del(KEY_IMPORT);
      await backend.del(KEY_META);
      await backend.set(KEY_ACTIVE, 'builtin');
    },

    async setActive(src) {
      await backend.set(KEY_ACTIVE, src);
    },

    async getActive() {
      const v = await backend.get<DataSource>(KEY_ACTIVE);
      return v === 'user' ? 'user' : 'builtin';
    },
  };
}

function backendKindLabel(k: KvBackend['kind']): string {
  return k === 'idb' ? 'IndexedDB' : k === 'localStorage' ? 'localStorage' : '内存';
}

/* 浏览器端的单例：后端只探测一次 */
let singleton: Promise<Importer> | null = null;

export function importer(): Promise<Importer> {
  return (singleton ??= pickBackend().then(createImporter));
}

/** 单测用：替换后端（传 null 复位） */
export function __setBackend(backend: KvBackend | null): void {
  singleton = backend ? Promise.resolve(createImporter(backend)) : null;
}
