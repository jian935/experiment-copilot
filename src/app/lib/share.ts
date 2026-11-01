/** 列表筛选状态 ↔ URL（hash 查询串），让「复制链接」能带上当前视图 */

export interface ListFilters {
  d?: string; // decision
  a?: string; // archetype
  q?: string; // keyword
  s?: string; // sort
  fw?: string; // '1' = 全局校正（Holm）
}

const STORE_KEY = 'ec_list_filters';

function queryOf(hash: string): URLSearchParams {
  const i = hash.indexOf('?');
  return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : '');
}

export function readFilters(): ListFilters {
  const q = queryOf(window.location.hash);
  const out: ListFilters = {};
  const d = q.get('d');
  const a = q.get('a');
  const kw = q.get('q');
  const s = q.get('s');
  const fw = q.get('fw');
  if (d) out.d = d;
  if (a) out.a = a;
  if (kw) out.q = kw;
  if (s) out.s = s;
  if (fw) out.fw = fw;
  if (Object.keys(out).length) return out;
  // 从详情页返回列表时恢复上一次的筛选（URL 已被 #/e/xxx 顶掉）
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as ListFilters;
  } catch {
    /* 忽略隐私模式下的异常 */
  }
  return {};
}

/** 用 replaceState 写回，避免触发 hashchange 造成重复渲染 */
export function writeFilters(f: ListFilters): void {
  const q = new URLSearchParams();
  if (f.d) q.set('d', f.d);
  if (f.a) q.set('a', f.a);
  if (f.q) q.set('q', f.q);
  if (f.s) q.set('s', f.s);
  if (f.fw) q.set('fw', f.fw);
  const qs = q.toString();
  const next = `#/${qs ? `?${qs}` : ''}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
  }
  try {
    if (qs) sessionStorage.setItem(STORE_KEY, JSON.stringify(f));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* 忽略 */
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function absoluteUrl(hash: string): string {
  return `${window.location.origin}${window.location.pathname}${hash}`;
}
