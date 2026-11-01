/**
 * 数字保真度检查（启发式）
 *
 * 目的：抓「回答里出现了引擎从未算过的数字」这类幻觉。它不是形式化验证器，
 * 而是把可疑数字挑出来给人复核——规则模式下应当恒为 0 条可疑。
 */

/** 白名单里固定允许的常量：阈值、置信水平、功效、百分比基数等 */
const CONSTANTS = [0, 1, 2, 3, 5, 10, 20, 50, 80, 95, 100, 0.05, 0.01, 0.001, 0.1, 0.4, 0.004, 0.02, 1.96];

function walk(value: unknown, out: number[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value, Math.abs(value));
    // 比例类数值常以百分数展示（0.0186 → 1.86%），只对 0~1 之间的值补一个 ×100 的写法
    if (Math.abs(value) <= 1) out.push(value * 100, Math.abs(value) * 100);
    return;
  }
  // 工具返回的**格式化文本字段**（diffText / mdeNowText / credText …）里带着数字，
  // 回答照抄这些字段是合规的（system prompt 第 6 条就是这么要求的），所以必须进白名单。
  // 以前只收 number，于是「可检出的最小差异从 0.63pp 收窄到 0.4pp」被判成幻觉数字——
  // 那是判定器的 bug，不是回答的错。数字从字符串里解析出来后按同样规则补 ×100 变体。
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      if (!Number.isFinite(n)) continue;
      out.push(n, Math.abs(n));
      if (Math.abs(n) <= 1) out.push(n * 100, Math.abs(n) * 100);
    }
    return;
  }
  if (Array.isArray(value)) {
    out.push(value.length); // 「共 31 个」这类计数也要能对上
    for (const v of value) walk(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) walk(v, out, depth + 1);
  }
}

export function buildWhitelist(payloads: unknown[]): number[] {
  const out: number[] = [...CONSTANTS];
  for (const p of payloads) walk(p, out);
  return out;
}

/**
 * 按「文本里写了几位小数」来核对：把白名单的数值四舍五入到同样精度再比。
 * 这样 0.623 既能对上 "0.62"，也不会让 "0.015" 蒙混过 7.26e-7 的 p 值。
 */
function matches(raw: string, value: number, whitelist: number[]): boolean {
  if (/e/i.test(raw)) {
    // 科学计数法：只做相对比较（写法本身有舍入）
    return whitelist.some((w) => Math.abs(w - value) <= Math.max(Math.abs(value) * 0.05, 1e-15));
  }
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
  return whitelist.some((w) => Math.abs(Number(w.toFixed(Math.min(decimals, 8))) - value) <= 1e-9);
}

/**
 * 抽出文本中的数字并逐一核对。
 * 跳过：年份（19xx/20xx）、小于 12 的整数（多半是序号/条数）、纯章节编号。
 */
export function auditNumbers(text: string, whitelist: number[]): { total: number; suspicious: string[] } {
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;
  const suspicious: string[] = [];
  let total = 0;

  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const prev = start > 0 ? text[start - 1] : '';
    // 跳过标识符里的数字（E013、P95），它们不是「统计数字」
    if (/[A-Za-z_]/.test(prev)) continue;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (/^(19|20)\d{2}$/.test(raw)) continue; // 年份
    if (Number.isInteger(value) && Math.abs(value) < 12) continue; // 序号 / 条数
    total += 1;
    if (!matches(raw, value, whitelist)) suspicious.push(raw);
  }

  return { total, suspicious };
}
