import { C } from './palette';

export function fmtPct(v: number, digits = 2): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** 绝对差值：pp（百分点） */
export function fmtPP(v: number, digits = 2): string {
  const s = (v * 100).toFixed(digits);
  return `${v > 0 ? '+' : ''}${s}pp`;
}

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  // erfc 在大 |z| 时会下溢到 0，直接显示 <1e-16 比 0.00e+0 更诚实
  if (p < 1e-16) return '<1e-16';
  if (p < 0.0001) return p.toExponential(1).replace('e-', 'e−');
  if (p < 0.001) return p.toFixed(4);
  return p.toFixed(3);
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtMs(v: number): string {
  return `${v.toFixed(0)}ms`;
}

export type Tone = 'ship' | 'noship' | 'iterate' | 'incon';


export const DECISION_META: Record<string, { label: string; short: string; tone: Tone; desc: string }> = {
  ship: { label: '建议上线', short: '上线', tone: 'ship', desc: '主指标显著正向且护栏无恶化' },
  'no-ship': { label: '不建议上线', short: '拦截', tone: 'noship', desc: '主指标负向或护栏显著恶化' },
  iterate: { label: '定向上线', short: '定向', tone: 'iterate', desc: '整体有效但只在部分分层成立' },
  inconclusive: { label: '无法下结论', short: '存疑', tone: 'incon', desc: '证据不足或分流异常' },
};

export const REASON_META: Record<string, string> = {
  SRM: '分流异常',
  GUARDRAIL: '护栏不通过',
  NEGATIVE: '主指标负向',
  HETEROGENEOUS: '效应异质',
  NOT_SIG: '证据不足',
  POSITIVE: '显著正向',
};

export const ARCHETYPE_LABEL: Record<string, string> = {
  null: '无真实效应',
  positive: '正向效应',
  negative: '负向效应',
  heterogeneous: '分层异质',
  srm: '分流异常',
  guardrail: '护栏恶化',
};

export function toneText(tone: Tone): string {
  return {
    ship: 'text-ship',
    noship: 'text-noship',
    iterate: 'text-iterate',
    incon: 'text-incon',
  }[tone];
}

export function toneBg(tone: Tone): string {
  return {
    ship: 'bg-ship/10 text-ship ring-ship/30',
    noship: 'bg-noship/10 text-noship ring-noship/30',
    iterate: 'bg-iterate/10 text-iterate ring-iterate/30',
    incon: 'bg-incon/10 text-incon ring-incon/30',
  }[tone];
}

export function toneStroke(tone: Tone): string {
  return { ship: C.ship, noship: C.noship, iterate: C.iterate, incon: C.incon }[tone];
}

/** 差值方向着色：正向=绿（收益），负向=红（损失）。决策色与方向色分开，避免混用。 */
export function liftClass(v: number): string {
  if (v > 0) return 'text-ship';
  if (v < 0) return 'text-noship';
  return 'text-muted';
}
