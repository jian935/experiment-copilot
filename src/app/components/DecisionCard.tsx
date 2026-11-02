import { useState } from 'react';
import { Check, ClipboardCopy, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import { fmtDiff, fmtNum, fmtP } from '../lib/format';
import {
  HUMAN_LABEL,
  needsReason,
  snapshotOf,
  type DecisionRecord,
  type HumanDecision,
} from '../lib/decisions';
import { Button, cx } from './ui';

const ORDER: HumanDecision[] = ['ship', 'iterate', 'hold', 'no-ship'];

/**
 * 决策记录卡：引擎给建议，人做决定，并且**把当时看到的数字一起冻住**。
 *
 * 与引擎不一致时理由必填——否则这条记录只是把引擎结论抄了一遍，
 * 三个月后完全看不出「当时是谁、为什么敢这么定」。
 */
export function DecisionCard({
  expId,
  analysis,
  record,
  onSave,
  onRemove,
}: {
  expId: string;
  analysis: Analysis;
  record?: DecisionRecord;
  onSave: (rec: DecisionRecord) => void;
  onRemove: (expId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<HumanDecision>(record?.decision ?? (analysis.decision as HumanDecision));
  const [note, setNote] = useState(record?.note ?? '');
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mustNote = needsReason(analysis.decision, pick);

  function save() {
    if (mustNote && !note.trim()) {
      setErr('你的决定与引擎不一致，请写一句理由——这句话是这条记录的全部价值');
      return;
    }
    setErr(null);
    onSave({
      expId,
      decision: pick,
      note: note.trim(),
      decidedAt: new Date().toISOString(),
      snapshot: snapshotOf(analysis),
    });
    setEditing(false);
  }

  if (!editing && record) {
    const s = record.snapshot;
    const differs = needsReason(s.engineDecision, record.decision);
    return (
      <section className="rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-[11.5px] font-medium text-ink">决策记录</span>
          <span
            className={cx(
              'rounded px-1.5 py-0.5 text-[10.5px]',
              record.decision === 'ship' ? 'bg-ship/15 text-ship' : 'bg-panel2 text-muted',
            )}
          >
            {HUMAN_LABEL[record.decision]}
          </span>
          <span className="num text-[10.5px] text-dim">{record.decidedAt.slice(0, 10)}</span>
          {differs && <span className="text-[10px] text-iterate">与引擎结论不同</span>}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => {
                setEditing(true);
                setPick(record.decision);
                setNote(record.note);
              }}
              className="rounded p-1 text-dim hover:bg-panel2 hover:text-ink"
              title="修改"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => onRemove(expId)}
              className="rounded p-1 text-dim hover:bg-panel2 hover:text-noship"
              title="删除这条记录"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
        <div className="space-y-1.5 px-4 py-2.5">
          {record.note && <p className="text-[11.5px] leading-5 text-ink">{record.note}</p>}
          <p className="num text-[10.5px] leading-4 text-dim">
            当时看到的：差值 {fmtDiff(s.diff, s.unit as 'pp' | '元')}，p = {fmtP(s.p)}，n = {fmtNum(s.n)}，
            引擎结论 {s.engineDecision} / {s.reasonCode}
          </p>
          <button
            onClick={() => {
              const md = `## ${expId}\n\n- 决定：${HUMAN_LABEL[record.decision]}（${record.decidedAt.slice(0, 10)}）\n- 理由：${record.note || '—'}\n- 当时：差值 ${fmtDiff(s.diff, s.unit as 'pp' | '元')}，p=${fmtP(s.p)}，n=${fmtNum(s.n)}，引擎 ${s.engineDecision}\n`;
              void navigator.clipboard?.writeText(md).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="flex items-center gap-1 text-[10.5px] text-brand2 hover:underline"
          >
            {copied ? <Check size={11} /> : <ClipboardCopy size={11} />}
            {copied ? '已复制' : '复制成 markdown（贴进周报）'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[11.5px] font-medium text-ink">决策记录</span>
        <span className="text-[10.5px] text-dim">
          引擎建议「{analysis.decision}」——你可以不同意，不同意时写清为什么
        </span>
        {!editing && (
          <button
            onClick={() => {
              setEditing(true);
              setPick(analysis.decision as HumanDecision);
            }}
            className="ml-auto text-[10.5px] text-brand2 hover:underline"
          >
            记录决定
          </button>
        )}
      </div>
      {editing && (
        <div className="space-y-2.5 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {ORDER.map((d) => (
              <button
                key={d}
                onClick={() => setPick(d)}
                aria-pressed={pick === d}
                className={cx(
                  'rounded-lg border px-2.5 py-1 text-[11px] transition-colors',
                  pick === d
                    ? 'border-brand bg-brand/10 text-ink'
                    : 'border-line text-muted hover:border-line2 hover:text-ink',
                )}
              >
                {HUMAN_LABEL[d]}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setErr(null);
            }}
            rows={2}
            placeholder={
              mustNote
                ? '必填：为什么你的判断和引擎不同？（这条理由三个月后会被翻出来）'
                : '可选：补充背景、后续动作、负责人都行'
            }
            className={cx(
              'w-full resize-y rounded-lg border bg-base px-3 py-2 text-[11.5px] leading-5 text-ink outline-none',
              mustNote && !note.trim() ? 'border-iterate/50 focus:border-iterate' : 'border-line focus:border-brand/60',
            )}
          />
          {err && (
            <p className="flex items-center gap-1 text-[10.5px] text-noship">
              <TriangleAlert size={11} /> {err}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              保存记录
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
