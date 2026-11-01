import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { DECISION_META, type Tone, toneBg } from '../lib/format';
import { C } from '../lib/palette';

export const cx = (...a: Parameters<typeof clsx>) => twMerge(clsx(...a));

/* ---------------- Panel ---------------- */

export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'rounded-xl border border-line bg-panel shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PanelHead({
  title,
  hint,
  right,
}: {
  title: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">{title}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-4 text-dim">{hint}</div>}
      </div>
      {right}
    </div>
  );
}

/* ---------------- Badge ---------------- */

export function DecisionBadge({
  decision,
  size = 'md',
  showDot = true,
}: {
  decision: string;
  size?: 'sm' | 'md';
  showDot?: boolean;
}) {
  const meta = DECISION_META[decision] ?? DECISION_META.inconclusive;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full ring-1 ring-inset font-medium',
        toneBg(meta.tone),
        size === 'sm' ? 'px-2 py-[2px] text-[11px]' : 'px-2.5 py-1 text-xs',
      )}
    >
      {showDot && <i className="h-1.5 w-1.5 rounded-full bg-current" />}
      {meta.label}
    </span>
  );
}

export function Chip({
  active,
  children,
  onClick,
  tone,
  title,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      // 选中态原来只靠颜色（border-brand / bg-brand），读屏和键盘用户读不出来
      aria-pressed={active === undefined ? undefined : !!active}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-brand/60 bg-brand/15 text-brand2'
          : 'border-line bg-panel2/60 text-muted hover:border-line2 hover:text-ink',
      )}
    >
      {tone && <i className="h-1.5 w-1.5 rounded-full" style={{ background: toneColor(tone) }} />}
      {children}
    </button>
  );
}

function toneColor(tone: Tone): string {
  return { ship: C.ship, noship: C.noship, iterate: C.iterate, incon: C.incon }[tone];
}

/* ---------------- Button ---------------- */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'outline', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-[13px]',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand2',
        variant === 'outline' && 'border border-line bg-panel2/70 text-ink hover:border-line2 hover:bg-panel2',
        variant === 'ghost' && 'text-muted hover:bg-panel2 hover:text-ink',
        className,
      )}
      {...rest}
    />
  );
}

/* ---------------- Drawer ---------------- */

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="scrim absolute inset-0 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="anim-slide relative flex h-full flex-col border-l border-line bg-panel shadow-2xl"
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">{title}</div>
            {subtitle && <div className="mt-1 text-[11px] leading-4 text-dim">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1.5 text-dim transition-colors hover:bg-panel2 hover:text-ink"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </aside>
    </div>
  );
}

/* ---------------- Misc ---------------- */

export function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
  active?: boolean;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cx(
        'rounded-xl border px-4 py-3 text-left transition-colors',
        active ? 'border-brand/60 bg-brand/10' : 'border-line bg-panel/70',
        onClick && 'hover:border-line2 hover:bg-panel2/70',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-dim">
        {tone && <i className="h-1.5 w-1.5 rounded-full" style={{ background: toneColor(tone) }} />}
        {label}
      </div>
      <div className="num mt-1 text-xl font-semibold tracking-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-dim">{sub}</div>}
    </Comp>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-brand2">
      {children}
    </code>
  );
}
