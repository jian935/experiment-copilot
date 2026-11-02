/**
 * 决策留痕。
 *
 * 为什么一个「分析工具」需要记流水账：统计结论会过期，决定不会。
 * 三个月后有人问「这个实验为什么上了」，能翻出来的必须不只是「当时 p=0.03」，
 * 而是**当时看到的是什么数字、按什么口径、谁拍的板、如果和引擎不一致那是为什么**。
 *
 * 三条设计约束：
 * 1. **记录里冻结当时的数字快照**。数据会变（重新导入、口径调整），事后回看时
 *    如果只存结论，就永远无法还原「当时屏幕上写的是什么」。
 * 2. **与引擎结论不一致时必须写理由**。否则这条记录只是把引擎结论抄了一遍，
 *    失去了「人做过判断」的全部信息。
 * 3. 纯前端：存在本机 localStorage，不假装有协作与权限（那条边界写在 README 里）。
 */

import type { Analysis } from '../../lib/decide.ts';

export type HumanDecision = 'ship' | 'no-ship' | 'iterate' | 'hold';

export const HUMAN_LABEL: Record<HumanDecision, string> = {
  ship: '上线',
  'no-ship': '不上线',
  iterate: '迭代后再说',
  hold: '先搁置',
};

export interface DecisionSnapshot {
  /** 当时的引擎结论 */
  engineDecision: string;
  reasonCode: string;
  /** 主指标差值与单位（pp 或 元） */
  diff: number;
  unit: string;
  p: number;
  ci: [number, number];
  /** 两臂合计曝光 */
  n: number;
}

export interface DecisionRecord {
  expId: string;
  decision: HumanDecision;
  /** 为什么这么定。与引擎不一致时必填 */
  note: string;
  decidedAt: string;
  snapshot: DecisionSnapshot;
}

const KEY = 'ec_decisions_v1';

export interface DecisionStore {
  all(): DecisionRecord[];
  get(expId: string): DecisionRecord | undefined;
  put(rec: DecisionRecord): void;
  remove(expId: string): void;
}

type Kv = Pick<Storage, 'getItem' | 'setItem'>;

/** 内存版：测试与隐私模式下用（localStorage 抛错时上层会回退到这里） */
export function memoryKv(): Kv & { removeItem(k: string): void } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export function createDecisionStore(kv: Kv): DecisionStore {
  const read = (): Record<string, DecisionRecord> => {
    try {
      const raw = kv.getItem(KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, DecisionRecord>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // 坏数据不能把整页搞崩：当作没有记录（用户最多重新记一次）
      return {};
    }
  };
  const write = (all: Record<string, DecisionRecord>) => {
    try {
      kv.setItem(KEY, JSON.stringify(all));
    } catch {
      // 配额满时静默失败是本项目的禁忌，但这里没法弹窗——上层会比对「写入后读出来是否一致」
    }
  };
  return {
    all: () => Object.values(read()).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
    get: (expId) => read()[expId],
    put: (rec) => {
      const all = read();
      all[rec.expId] = rec;
      write(all);
    },
    remove: (expId) => {
      const all = read();
      delete all[expId];
      write(all);
    },
  };
}

/** 把分析结果冻成快照：只留「当时屏幕上最关键的五个数」 */
export function snapshotOf(an: Analysis): DecisionSnapshot {
  const p = an.primary;
  return {
    engineDecision: an.decision,
    reasonCode: an.reasonCode,
    diff: p.diff,
    unit: p.unit,
    p: p.p,
    ci: [p.ci95[0], p.ci95[1]],
    // 两臂曝光合计用整体的 n1+n2：主指标是 ARPU 时也仍然有这两个数（转化率恒有）
    n: an.overall.n1 + an.overall.n2,
  };
}

/**
 * 与引擎不一致时是否必须写理由。
 * 注意方向：**引擎说不上线而人决定上线**才是最需要解释的（谁在为风险签字）；
 * 引擎说上线而人决定不上线同样要写（否则无法区分「有更好的理由」与「随手点了」）。
 * 唯一不需要理由的是「与引擎一致」。
 */
export function needsReason(engine: string, mine: HumanDecision): boolean {
  // 「先搁置」不是统计结论，引擎永远产不出它——所以这个决定**无论如何**都要人解释一句。
  // 早期写法是 `mine !== engine`，于是 engine 恰好等于 'hold' 时会返回 false（虽然实际不会发生，
  // 但这类「靠上游不变量兜底」的写法一旦上游变了就会静默出错）。
  if (mine === 'hold') return true;
  return mine !== engine;
}

/** 导出成 markdown：贴在周报/复盘文档里就能用，不需要再截图 */
export function exportMarkdown(
  records: DecisionRecord[],
  nameOf: (expId: string) => string,
  fmt: (v: number, unit: string) => string,
): string {
  if (!records.length) return '还没有记录任何决定。';
  const lines = ['# 实验决策记录', ''];
  for (const r of records) {
    const s = r.snapshot;
    lines.push(`## ${r.expId} ${nameOf(r.expId)}`);
    lines.push('');
    lines.push(`- **决定**：${HUMAN_LABEL[r.decision]}（${r.decidedAt.slice(0, 10)}）`);
    lines.push(
      `- **当时的引擎结论**：${s.engineDecision} / ${s.reasonCode}——差值 ${fmt(s.diff, s.unit)}，p=${s.p.toFixed(4)}，n=${s.n.toLocaleString()}`,
    );
    if (needsReason(s.engineDecision, r.decision)) {
      lines.push(`- **为什么与引擎不同**：${r.note || '（未填写）'}`);
    } else if (r.note) {
      lines.push(`- **备注**：${r.note}`);
    }
    lines.push('');
  }
  lines.push('> 由 Experiment Copilot 导出。快照里的数字是**记录当时**的值，之后数据变化不会改写它们。');
  return lines.join('\n');
}
