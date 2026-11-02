/**
 * 指标表达式的解析与求值（自定义指标用）。
 *
 * 为什么不是 `eval` / `new Function`：用户输入的表达式会被送进**决策引擎**。
 * `new Function` 在这里等于把一个任意代码执行的入口交给到访者——哪怕只是本机 localStorage，
 * 也意味着「导入一份别人的 JSON 就可能跑别人的代码」。所以自己写一个只认四则运算的解析器：
 * 词法白名单、语法白名单、字段白名单，三处都关死，多一个字符都报错。
 *
 * 支持：数字、白名单字段、`+ - * /`、括号、一元负号。**不支持**函数调用、比较、字符串、属性访问。
 *
 * 除法遇到分母 0 返回 `null`（= 这一行算不出值），而不是 `Infinity` 或 0。
 * 这两种处理都会悄悄改变指标含义：返回 0 把「没有分母」算成「值很小」，
 * 返回 Infinity 会把整组的均值拉成 NaN，而两者都不会报错。
 */

/** 允许在表达式里引用的行字段（都是 DailyRow 上的数值字段） */
export const EXPR_FIELDS = [
  'exposures',
  'conversions',
  'refunds',
  'complaints',
  'latencyP95',
  'revenue',
  'preExposures',
  'preConversions',
  'preRevenue',
] as const;

export type ExprField = (typeof EXPR_FIELDS)[number];

export type ExprNode =
  | { t: 'num'; v: number }
  | { t: 'ref'; name: ExprField }
  | { t: 'neg'; a: ExprNode }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: ExprNode; b: ExprNode };

export class ExprError extends Error {}

const FIELD_SET = new Set<string>(EXPR_FIELDS);

interface Token {
  t: 'num' | 'id' | 'op' | 'lp' | 'rp';
  v: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      const raw = src.slice(i, j).replace(/_/g, '');
      if (!/^\d*\.?\d+$/.test(raw)) throw new ExprError(`数字写错了：「${src.slice(i, j)}」`);
      out.push({ t: 'num', v: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      out.push({ t: 'lp', v: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      out.push({ t: 'rp', v: ch });
      i++;
      continue;
    }
    throw new ExprError(`不认识的字符「${ch}」（只支持数字、字段名、+ - * / 和括号）`);
  }
  return out;
}

/** 递归下降解析：expr → term → factor */
export function parseMetricExpr(src: string): ExprNode {
  const toks = tokenize(String(src ?? ''));
  if (!toks.length) throw new ExprError('表达式是空的');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const parseExpr = (): ExprNode => {
    let node = parseTerm();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v as '+' | '-';
      node = { t: 'bin', op, a: node, b: parseTerm() };
    }
    return node;
  };
  const parseTerm = (): ExprNode => {
    let node = parseFactor();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v as '*' | '/';
      node = { t: 'bin', op, a: node, b: parseFactor() };
    }
    return node;
  };
  const parseFactor = (): ExprNode => {
    const tk = peek();
    if (!tk) throw new ExprError('表达式在这里提前结束了（末尾缺一个数或字段）');
    if (tk.t === 'op' && tk.v === '-') {
      next();
      return { t: 'neg', a: parseFactor() };
    }
    if (tk.t === 'op' && tk.v === '+') {
      next();
      return parseFactor();
    }
    if (tk.t === 'num') {
      next();
      return { t: 'num', v: Number(tk.v) };
    }
    if (tk.t === 'id') {
      next();
      if (!FIELD_SET.has(tk.v)) {
        throw new ExprError(
          `不认识字段「${tk.v}」——可用字段只有：${EXPR_FIELDS.join(' / ')}（不支持函数调用）`,
        );
      }
      return { t: 'ref', name: tk.v as ExprField };
    }
    if (tk.t === 'lp') {
      next();
      const inner = parseExpr();
      const close = peek();
      if (!close || close.t !== 'rp') throw new ExprError('括号没闭合');
      next();
      return inner;
    }
    throw new ExprError(`这里不该出现「${tk.v}」`);
  };

  const ast = parseExpr();
  if (p < toks.length) throw new ExprError(`多余的内容：「${toks.slice(p).map((t) => t.v).join(' ')}」`);
  return ast;
}

/** 表达式引用到的字段（去重、保持出现顺序）——用于「这一列没有」的早期报错 */
export function exprRefs(node: ExprNode): ExprField[] {
  const out: ExprField[] = [];
  const walk = (n: ExprNode) => {
    if (n.t === 'ref') {
      if (!out.includes(n.name)) out.push(n.name);
    } else if (n.t === 'neg') walk(n.a);
    else if (n.t === 'bin') {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(node);
  return out;
}

export type ExprRow = Partial<Record<ExprField, number>>;

/**
 * 求值。返回 `null` 表示「这一行算不出值」（字段缺失，或除数为 0）。
 * 调用方必须**跳过** null 行而不是当 0 —— 当 0 会让「没数据」变成「值为零」。
 */
export function evalMetricExpr(node: ExprNode, row: ExprRow): number | null {
  const go = (n: ExprNode): number | null => {
    switch (n.t) {
      case 'num':
        return n.v;
      case 'ref': {
        const v = row[n.name];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      }
      case 'neg': {
        const a = go(n.a);
        return a === null ? null : -a;
      }
      case 'bin': {
        const a = go(n.a);
        if (a === null) return null;
        const b = go(n.b);
        if (b === null) return null;
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (b === 0) return null;
        return a / b;
      }
    }
  };
  const v = go(node);
  return v === null || !Number.isFinite(v) ? null : v;
}

/** 编译一次、多次求值（每个自定义指标每行都要算，别在循环里重复解析） */
export function compileMetricExpr(src: string): { node: ExprNode; refs: ExprField[]; eval: (row: ExprRow) => number | null } {
  const node = parseMetricExpr(src);
  return { node, refs: exprRefs(node), eval: (row) => evalMetricExpr(node, row) };
}
