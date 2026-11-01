import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  KeyRound,
  Loader2,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { answerQuestion } from '../../lib/agent/answer.ts';
import { TOOL_LABEL } from '../../lib/agent/tools.ts';
import type { AgentCtx, AgentReply, AgentTurn, ToolCall } from '../../lib/agent/types.ts';
import { askWithLlm } from '../lib/llm';
import { useSettings } from '../lib/settings';
import { Button, Drawer, cx } from './ui';

const MODE_STORE = 'ec_agent_mode';

/** 从 base URL 里取 host，避免界面上把完整 URL（含路径）塞满 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || '默认端点';
  }
}

const SUGGESTIONS = [
  '为什么是这个结论？',
  '主指标显著吗？',
  '新老用户有差异吗？',
  '护栏有没有恶化？',
  '样本够不够？',
  '还要跑几天？',
  '有哪些实验被拦截了？',
];

type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: AgentReply; error?: string };

export function AgentPanel({
  open,
  onClose,
  ctx,
  onCite,
}: {
  open: boolean;
  onClose: () => void;
  ctx: AgentCtx;
  onCite: (evId: string) => void;
}) {
  // 模型设置来自设置页（provider / base_url / model / Key），不再是硬编码的 DeepSeek
  const { settings, patchLlm } = useSettings();
  const [mode, setMode] = useState<'rules' | 'llm'>(() => {
    try {
      return (localStorage.getItem(MODE_STORE) as 'rules' | 'llm') || 'rules';
    } catch {
      return 'rules';
    }
  });
  const [apiKey, setApiKey] = useState(() => settings.llm.apiKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTool, setPendingTool] = useState<ToolCall | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_STORE, mode);
    } catch {
      /* 忽略 */
    }
  }, [mode]);

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, open, busy]);

  const needKey = mode === 'llm' && !apiKey;
  const toolCalls = useMemo(
    () =>
      turns.reduce((n, t) => n + (t.role === 'assistant' ? t.reply.calls.length : 0), 0),
    [turns],
  );
  // 多轮上下文：把已完成的轮次转成 AgentTurn（助手轮带上意图，规则模式靠它判断「上一轮在聊什么」）
  const history = useMemo<AgentTurn[]>(
    () =>
      turns.map((t) =>
        t.role === 'user'
          ? { role: 'user' as const, text: t.text }
          : { role: 'assistant' as const, text: t.reply.text, intent: t.reply.intent },
      ),
    [turns],
  );

  // 换实验就换会话：把上一题的上下文带过去只会答错
  useEffect(() => {
    setTurns([]);
    setPendingTool(null);
  }, [ctx.exp.id]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput('');
    setTurns((p) => [...p, { role: 'user', text: question }]);
    setBusy(true);
    setPendingTool(null);

    // history 只含这次提问之前的轮次（turns 还没被 setState 刷新）
    const withHistory: AgentCtx = { ...ctx, history };

    try {
      if (mode === 'llm' && apiKey) {
        const reply = await askWithLlm(question, withHistory, {
          apiKey,
          baseUrl: settings.llm.baseUrl || undefined,
          model: settings.llm.model || undefined,
          onTool: (c) => setPendingTool(c),
        });
        setTurns((p) => [...p, { role: 'assistant', reply }]);
      } else {
        const reply = answerQuestion(question, withHistory, history);
        await new Promise((r) => setTimeout(r, 180)); // 让"思考中"可见，避免闪烁
        setTurns((p) => [...p, { role: 'assistant', reply }]);
      }
    } catch (e) {
      const fallback = answerQuestion(question, withHistory, history);
      setTurns((p) => [
        ...p,
        {
          role: 'assistant',
          reply: fallback,
          error: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setBusy(false);
      setPendingTool(null);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`问这个实验 · ${ctx.exp.id} ${ctx.exp.name}`}
      subtitle="模型只负责编排与解释：所有数字来自工具（引擎），每个结论都要带证据引用；答不上来必须说不知道。"
      width={640}
      footer={
        <div className="space-y-2">
          {needKey ? (
            <div className="flex items-center gap-2">
              <KeyRound size={13} className="shrink-0 text-iterate" />
              <input
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="填入 DeepSeek API Key 以启用智能模式"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel2/70 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-dim focus:border-brand/60"
                type="password"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const k = keyDraft.trim();
                  if (!k) return;
                  setApiKey(k);
                  patchLlm({ apiKey: k }); // 与设置页共享同一份配置
                  setKeyDraft('');
                }}
              >
                保存
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask(input);
                  }
                }}
                rows={2}
                placeholder="问：为什么不能上线？护栏有没有恶化？（Enter 发送，Shift+Enter 换行）"
                className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-panel2/70 px-2.5 py-2 text-xs leading-5 text-ink outline-none placeholder:text-dim focus:border-brand/60"
              />
              <Button variant="primary" size="sm" disabled={busy || !input.trim()} onClick={() => ask(input)}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} 发送
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] text-dim">
            <span>
              {mode === 'llm'
                ? apiKey
                  ? `智能模式：${settings.llm.model || '默认模型'} @ ${hostOf(settings.llm.baseUrl)}`
                  : '智能模式需要 Key，或切回规则模式'
                : '规则模式：无需密钥，全部离线计算'}
            </span>
            <span>
              已调用工具 {toolCalls} 次 · 回答 {turns.filter((t) => t.role === 'assistant').length} 条
            </span>
          </div>
        </div>
      }
    >
      {/* 模式切换 */}
      <div className="mb-3 flex items-center gap-1.5">
        {(
          [
            ['rules', '规则模式', '免密钥 · 确定性'],
            ['llm', '智能模式', 'OpenAI 兼容 · 需 Key'],
          ] as const
        ).map(([k, label, hint]) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            className={cx(
              'rounded-lg border px-2.5 py-1.5 text-left transition-colors',
              mode === k
                ? 'border-brand/60 bg-brand/15 text-brand2'
                : 'border-line bg-panel2/50 text-muted hover:border-line2 hover:text-ink',
            )}
          >
            <span className="block text-[11.5px] font-medium">{label}</span>
            <span className="block text-[9.5px] text-dim">{hint}</span>
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-dim">
          <ShieldCheck size={11} className="text-ship" />
          数字不由模型生成
        </span>
        {turns.length > 0 && (
          <button
            onClick={() => {
              setTurns([]);
              setPendingTool(null);
            }}
            className="rounded-lg border border-line bg-panel px-2 py-1 text-[10px] text-muted transition-colors hover:border-line2 hover:text-ink"
            title="清空上下文并开始新会话"
          >
            新会话
          </button>
        )}
      </div>

      <div ref={listRef} className="min-h-[240px] space-y-3">
        {turns.length === 0 && (
          <div className="rounded-xl border border-line bg-panel2/40 p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <Sparkles size={13} className="text-brand2" /> 试试这样问
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-brand/50 hover:text-brand2"
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-4 text-dim">
              这个实验有 {ctx.analysis.evidence.length} 条证据、6 条判定规则。回答里的
              <span className="mx-0.5 rounded bg-brand/15 px-1 font-mono text-brand2">E1</span>
              可以直接点开看原始证据。
            </p>
            <div className="mt-3 border-t border-line/60 pt-2.5">
              <div className="text-[10px] text-dim">
                可调用的 {Object.keys(TOOL_LABEL).length} 个工具（模型只能通过它们取数）
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {Object.values(TOOL_LABEL).map((t) => (
                  <span key={t} className="rounded border border-line bg-panel px-1.5 py-0.5 text-[9.5px] text-muted">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-xl rounded-br-sm bg-brand/15 px-3 py-2 text-[12px] leading-5 text-ink">
                {t.text}
              </div>
            </div>
          ) : (
            <AssistantTurn key={i} reply={t.reply} error={t.error} onCite={onCite} />
          ),
        )}

        {busy && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-panel2/50 px-3 py-2 text-[11px] text-muted">
            <Loader2 size={12} className="animate-spin text-brand2" />
            {pendingTool ? (
              <span>
                调用工具 <span className="text-brand2">{TOOL_LABEL[pendingTool.tool]}</span> · {pendingTool.summary}
              </span>
            ) : mode === 'llm' ? (
              '模型思考中…'
            ) : (
              '检索证据中…'
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

function AssistantTurn({
  reply,
  error,
  onCite,
}: {
  reply: AgentReply;
  error?: string;
  onCite: (id: string) => void;
}) {
  const [openTool, setOpenTool] = useState<number | null>(null);
  const ok = (reply.violations?.length ?? 0) === 0;

  return (
    <div className="rounded-xl border border-line bg-panel2/50 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-panel2 px-1.5 py-0.5 text-[9.5px] text-dim">
          {reply.by === 'llm' ? 'DeepSeek' : '规则引擎'}
        </span>
        <span className="font-mono text-[9.5px] text-dim">{reply.intent}</span>
        <span
          className={cx(
            'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px]',
            ok ? 'bg-ship/10 text-ship' : 'bg-noship/10 text-noship',
          )}
        >
          {ok ? <Check size={9} /> : <AlertTriangle size={9} />}
          {ok ? `${reply.audit.total} 个数字全部可溯源` : `${reply.violations!.length} 处违规`}
        </span>
      </div>

      {reply.context && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-brand/25 bg-brand/8 px-2 py-1 text-[10px] leading-4 text-brand2">
          <CornerDownLeft size={10} className="mt-0.5 shrink-0" />
          <span>
            承接上文 → 理解为「{reply.context.effective}」
            {reply.context.why ? ` · ${reply.context.why}` : ''}
            <span className="text-dim">（原话太省略，这是规则模式的补全结果，不对可以换个说法）</span>
          </span>
        </div>
      )}

      {reply.calls.length > 0 && (
        <div className="mb-2 space-y-1">
          {reply.calls.map((c, i) => (
            <div key={i} className="rounded-lg border border-line/70 bg-panel/60">
              <button
                onClick={() => setOpenTool(openTool === i ? null : i)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
              >
                <Wrench size={10} className="shrink-0 text-brand2" />
                <span className="shrink-0 text-[10px] text-brand2">{TOOL_LABEL[c.tool]}</span>
                <span className="truncate text-[10px] text-dim">{c.summary}</span>
                <ChevronDown
                  size={10}
                  className={cx('ml-auto shrink-0 text-dim transition-transform', openTool === i && 'rotate-180')}
                />
              </button>
              {openTool === i && (
                <pre className="max-h-[180px] overflow-auto border-t border-line/60 px-2 py-1.5 font-mono text-[9.5px] leading-4 text-muted">
                  {JSON.stringify({ args: c.args, cites: c.cites, data: c.data }, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5 text-[12.5px] leading-6 text-ink/90">
        {renderRich(reply.text, onCite)}
      </div>

      {reply.note && <p className="mt-1 text-[10px] text-dim">备注：{reply.note}</p>}

      {error && (
        <p className="mt-2 rounded-lg border border-iterate/30 bg-iterate/10 px-2 py-1.5 text-[10.5px] leading-4 text-iterate">
          模型调用失败，已回退到规则模式：{error}
        </p>
      )}

      {!ok && (
        <ul className="mt-2 space-y-1">
          {reply.violations!.map((v) => (
            <li
              key={v}
              className="flex items-start gap-1.5 rounded-lg border border-noship/25 bg-noship/10 px-2 py-1 text-[10.5px] leading-4 text-noship"
            >
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 轻量渲染：只支持模型实际会用的三种写法——段落、`- ` 列表、`**加粗**`。
 * 不引 markdown 库：一来体积，二来这里只需要这三种，其余一律当纯文本（安全）。
 */
function renderRich(text: string, onCite: (id: string) => void) {
  // 只有标点/空白、没有实义字符的行直接丢掉（模型偶尔会多输出一个「。」）
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /[\p{L}\p{N}]/u.test(l));
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];

  const flush = (key: string) => {
    if (bullets.length) {
      blocks.push(
        <ul key={`ul-${key}`} className="ml-1 list-disc space-y-0.5 pl-4 marker:text-dim">
          {bullets.map((b, i) => (
            <li key={i}>{inline(b, onCite)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
    if (numbers.length) {
      blocks.push(
        <ol key={`ol-${key}`} className="ml-1 list-decimal space-y-0.5 pl-5 marker:text-dim">
          {numbers.map((b, i) => (
            <li key={i}>{inline(b, onCite)}</li>
          ))}
        </ol>,
      );
      numbers = [];
    }
  };

  lines.forEach((line, i) => {
    if (/^[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s+/, ''));
      return;
    }
    if (/^\d+[.、)]\s+/.test(line)) {
      numbers.push(line.replace(/^\d+[.、)]\s+/, ''));
      return;
    }
    flush(String(i));
    const plain = line.replace(/^#{1,6}\s*/, '');
    blocks.push(<p key={i}>{inline(plain, onCite)}</p>);
  });
  flush('end');
  return blocks;
}

/** 行内：**加粗** 与 [E6] 引用 */
function inline(text: string, onCite: (id: string) => void) {
  return text.split(/(\*\*[^*]+\*\*|\[E\d+\])/g).map((part, i) => {
    const cite = /^\[(E\d+)\]$/.exec(part);
    if (cite) return <CiteChip key={i} id={cite[1]} onCite={onCite} />;
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) return <strong key={i} className="font-semibold text-ink">{bold[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

/** 把 [E6] 渲染成可点的证据 chip */
function CiteChip({ id, onCite }: { id: string; onCite: (id: string) => void }) {
  return (
    <button
      onClick={() => onCite(id)}
      className="mx-1 rounded bg-brand/15 px-1.5 py-[1px] font-mono text-[10px] text-brand2 transition-colors hover:bg-brand/25"
      title={`查看证据 ${id}`}
    >
      {id}
    </button>
  );
}
