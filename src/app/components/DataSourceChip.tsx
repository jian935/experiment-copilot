import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Database, HardDriveDownload, Trash2, TriangleAlert } from 'lucide-react';
import { importer, type DataSource, type DatasetMeta, type KvBackend } from '../lib/persist';
import { cx } from './ui';

/**
 * 顶部「数据源」芯片（C3）。
 *
 * 为什么这不是个可有可无的装饰：导入过数据的人刷新页面后必须能一眼看出
 * 「我现在看的是自己导的数据，还是内置的 120 例」——两者的可信度完全不同
 * （内置带已知真值，评测看板才有意义；导入的真实数据没有真值）。
 * 说错这一句，后面所有数字都会被误读。
 */
export function DataSourceChip({
  source,
  meta,
  storedMeta,
  builtinCount,
  hasImport,
  onUseBuiltin,
  onUseImported,
  onForget,
}: {
  source: DataSource;
  /** 当前生效数据源的元信息（内置时是 null） */
  meta: DatasetMeta | null;
  /** 本机存档的元信息（即使当前在用内置数据也要有，否则切回入口会说"没有存档"） */
  storedMeta: DatasetMeta | null;
  builtinCount: number;
  /** 本机是否存着上次导入的数据（即使当前用内置，也要能切回去） */
  hasImport: boolean;
  onUseBuiltin: () => void;
  onUseImported: () => void;
  onForget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<KvBackend['kind'] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // 页脚必须说**真实**的存储位置：隐私模式下会降级到 localStorage，甚至只能用内存。
  // 无条件写「存在 IndexedDB」是在替浏览器撒谎，而这恰恰是用户最需要知道的一件事。
  useEffect(() => {
    let alive = true;
    importer()
      .then((i) => alive && setKind(i.backendKind))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const isUser = source === 'user';
  const label = isUser ? `导入 · ${meta?.experiments ?? '?'} 例` : `内置 · ${builtinCount} 例`;

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="当前数据源"
        className={cx(
          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] transition-colors',
          isUser
            ? 'border-brand/40 bg-brand/10 text-brand2 hover:bg-brand/15'
            : 'border-line bg-panel2/60 text-muted hover:border-line2 hover:text-ink',
        )}
      >
        {isUser ? <HardDriveDownload size={11} /> : <Database size={11} />}
        {label}
        <ChevronDown size={10} className={cx('transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="anim-up absolute right-0 top-full z-40 mt-1.5 w-[292px] overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
          <div className="border-b border-line px-3 py-2 text-[10.5px] text-dim">当前数据源</div>

          <Row
            active={!isUser}
            icon={<Database size={12} />}
            title={`内置合成数据（${builtinCount} 例）`}
            note="固定种子生成，带已知真值 → 评测看板 / 真值对照可用"
            onClick={() => {
              setOpen(false);
              if (isUser) onUseBuiltin();
            }}
          />
          <Row
            active={isUser}
            icon={<HardDriveDownload size={12} />}
            title={storedMeta ? `导入：${storedMeta.name}` : '导入的数据'}
            note={
              storedMeta
                ? `${storedMeta.experiments} 个实验 · ${storedMeta.rows} 行明细 · ${new Date(storedMeta.importedAt).toLocaleString('zh-CN')}`
                : '本机没有存档'
            }
            onClick={() => {
              setOpen(false);
              if (!isUser) onUseImported();
            }}
            disabled={!hasImport}
          />

          {isUser && meta && !meta.persisted && (
            <div className="flex items-start gap-1.5 border-t border-line bg-iterate/5 px-3 py-2 text-[10px] leading-4 text-iterate">
              <TriangleAlert size={11} className="mt-0.5 shrink-0" />
              {meta.persistedNote ?? '这份数据没有存进本机，刷新后会丢'}
            </div>
          )}

          {hasImport && (
            <button
              onClick={() => {
                setOpen(false);
                onForget();
              }}
              className="flex w-full items-center gap-1.5 border-t border-line px-3 py-2 text-left text-[10.5px] text-noship transition-colors hover:bg-noship/5"
            >
              <Trash2 size={11} /> 删除本机存档
            </button>
          )}

          <p className="border-t border-line bg-panel2/40 px-3 py-2 text-[10px] leading-4 text-dim">
            {kind === 'idb' && '数据只存在这台设备的浏览器里（IndexedDB），不上传任何服务器。'}
            {kind === 'localStorage' && '这台浏览器用不了 IndexedDB，已降级到 localStorage：容量更小，大文件可能存不下。'}
            {kind === 'memory' && (
              <span className="text-iterate">
                当前环境无法写入本机存储，导入的数据<strong>不会保留</strong>，刷新即丢（隐私模式常见）。
              </span>
            )}
            {kind === null && '数据只存在这台设备的浏览器里，不上传任何服务器。'}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  active,
  icon,
  title,
  note,
  onClick,
  disabled,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  note: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-panel2/70',
        active && 'bg-brand/[0.04]',
      )}
    >
      <span className={cx('mt-0.5 shrink-0', active ? 'text-brand2' : 'text-dim')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink">
          <span className="truncate">{title}</span>
          {active && <Check size={11} className="shrink-0 text-brand2" />}
        </span>
        <span className="mt-0.5 block text-[10px] leading-4 text-dim">{note}</span>
      </span>
    </button>
  );
}
