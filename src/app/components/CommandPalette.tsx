import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CornerDownLeft, FlaskConical, Search, Upload, X } from 'lucide-react';
import { groupHits, searchDocs, tokenize, type SearchDoc, type SearchHit } from '../../lib/search.ts';
import { cx } from './ui';

/**
 * ⌘K 命令面板（F4）。
 *
 * 之所以要做这一屏：列表页能搜「实验名 / ID / 假设」，但用户想找的常常是
 * **一个动作**（「换数据源」「进评测看板」「比一比这两个」）或者按**结论/规则名**找实验
 * （「那个被护栏拦住的」）。这两件事在表格里都做不到。
 *
 * 两条纪律：
 * ① 检索与排序一刀不动地交给 `lib/search.ts`（纯函数 + 单测），这里只画
 *    ——否则「什么算命中」会有两份实现。
 * ② 键盘走完全程：↑↓ 选、Enter 进、Esc 关，选中的那条永远滚进视野。
 */
export function CommandPalette({
  open,
  docs,
  onClose,
  onRun,
  hint,
}: {
  open: boolean;
  docs: SearchDoc[];
  onClose: () => void;
  /** 命中内容的执行：`experiment` 传 target（hash），`action` 传 action key */
  onRun: (h: SearchHit) => void;
  hint?: string;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => groupHits(searchDocs(docs, q, 40)), [docs, q]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  // 每次换查询回到第一条：不然上一次选中的行可能已经不在结果里，Enter 会打到别的实验
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      // 自动聚焦要等面板真正进 DOM
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, q]);

  if (!open) return null;

  const run = (i: number) => {
    const h = flat[i];
    if (h) onRun(h);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[620px] overflow-hidden rounded-xl border border-line2 bg-panel shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <Search size={15} className="shrink-0 text-dim" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(sel);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="搜实验（含假设 / 规则名）、找功能… 空格分隔多词"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-dim"
          />
          <button onClick={onClose} className="shrink-0 rounded p-1 text-dim transition-colors hover:text-ink" aria-label="关闭搜索">
            <X size={14} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {tokenize(q).length === 0 && (
            <div className="px-4 py-6 text-center text-[11.5px] leading-5 text-dim">
              输入关键词开始搜索。
              <br />
              试：<span className="text-muted">护栏</span>（按规则名找）、<span className="text-muted">ARPU</span>（按指标找）、
              <span className="text-muted">E029</span>（按编号找）
            </div>
          )}

          {tokenize(q).length > 0 && flat.length === 0 && (
            <div className="px-4 py-6 text-center text-[11.5px] text-dim">
              没有匹配「{q.trim()}」的实验或功能。
              <br />
              多个词是「都要出现」，不是「任一出现」——少输一个词试试。
            </div>
          )}

          {groups.map((g) => (
            <div key={g.group}>
              {/* 分组标题与结果行用**同一个布局容器**（px-4 + 图标位 + gap-3），
                  不再靠算 44px padding 去凑——凑出来的偏移在不同行高下还会再错一次 */}
              <div className="flex items-center gap-3 px-4 pb-1 pt-2.5">
                <span className="w-4 shrink-0" />
                <span className="text-[10px] uppercase tracking-wide text-dim">{g.group}</span>
              </div>
              {g.hits.map((h) => {
                const i = flat.indexOf(h);
                const active = i === sel;
                return (
                  <button
                    key={h.doc.kind + h.doc.id}
                    data-idx={i}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(i)}
                    className={cx(
                      'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
                      active ? 'bg-brand/[0.09]' : 'hover:bg-panel2/70',
                    )}
                  >
                    {/* 图标位恒定宽度：不占位的话，实验行（无图标）与功能行（有图标）的标题会错开 13px */}
                    <span className="flex w-4 shrink-0 justify-center text-dim">{iconFor(h.doc)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-ink">{mark(h.doc.title, h.marks)}</span>
                      {h.doc.subtitle && (
                        <span className="mt-0.5 block truncate text-[10.5px] text-dim">{h.doc.subtitle}</span>
                      )}
                      {/* 标题没命中时，把正文里那一小段贴出来——不然用户看不出这条为什么会出现 */}
                      {h.snippet && (
                        <span className="mt-0.5 block truncate text-[10.5px] text-brand2/70">
                          命中「{h.snippet}」
                        </span>
                      )}
                    </span>
                    {active && <CornerDownLeft size={12} className="shrink-0 text-brand" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10.5px] text-dim">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line2 px-1">↑</kbd>
            <kbd className="rounded border border-line2 px-1">↓</kbd> 选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line2 px-1">↵</kbd> 打开
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line2 px-1">Esc</kbd> 关闭
          </span>
          {hint && <span className="ml-auto">{hint}</span>}
        </div>
      </div>
    </div>
  );
}

function iconFor(doc: SearchDoc) {
  if (doc.kind === 'experiment') return <FlaskConical size={13} />;
  if (doc.target === 'import') return <Upload size={13} />;
  return <ArrowRight size={13} />;
}

/** 把命中片段包成 <mark>：不用 dangerouslySetInnerHTML，避免查 `(`、`*` 之类字符时出岔子 */
function mark(text: string, ranges: [number, number][]) {
  if (ranges.length === 0) return text;
  const [s, e] = ranges[0];
  return (
    <>
      {text.slice(0, s)}
      <mark className="rounded bg-brand/15 px-0.5 text-brand2">{text.slice(s, e)}</mark>
      {text.slice(e)}
    </>
  );
}
