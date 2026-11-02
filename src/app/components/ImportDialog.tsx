import { useRef, useState, type ReactNode } from 'react';
import { Upload, AlertTriangle, CheckCircle2, FileJson, FileSpreadsheet } from 'lucide-react';
import type { Dataset } from '../../lib/types.ts';
import {
  ImportError,
  parseDatasetCsv,
  parseDatasetJson,
  SAMPLE_CSV,
  SAMPLE_JSON,
} from '../../lib/import.ts';
import { Button, Panel } from './ui';

type Tab = 'json' | 'csv';

export function ImportDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  /** 返回落盘结果：persisted=false 时说明只在本标签页有效，必须显示给用户看 */
  onImport: (dataset: Dataset, name: string) => Promise<{ persisted: boolean; persistedNote?: string }>;
}) {
  const [tab, setTab] = useState<Tab>('json');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showExample, setShowExample] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const sample = tab === 'json' ? SAMPLE_JSON : SAMPLE_CSV;

  async function readFile(file: File) {
    setError(null);
    setOk(null);
    try {
      const content = await file.text();
      setText(content);
      setFileName(file.name);
    } catch (e) {
      setError(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleImport() {
    setError(null);
    setOk(null);
    if (!text.trim()) {
      setError('请先粘贴数据，或上传一个文件');
      return;
    }
    let dataset: Dataset;
    try {
      dataset = tab === 'json' ? parseDatasetJson(text) : parseDatasetCsv(text);
    } catch (e) {
      if (e instanceof ImportError) setError(e.message);
      else setError(`导入失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const gtNote = dataset.groundTruth ? '（含已知真值，评测看板可用）' : '（无已知真值，评测看板将隐藏）';
    const name = fileName ?? (tab === 'csv' ? '粘贴的 CSV' : '粘贴的 JSON');
    const head = `已载入 ${dataset.experiments.length} 个实验、${dataset.daily.length} 行明细 ${gtNote}`;
    try {
      const meta = await onImport(dataset, name);
      // 存不下必须说出来：静默失败比不持久化更糟（用户会以为下次还在）
      setOk(meta.persisted ? `${head}，已保存在本机，刷新不丢` : `${head}。${meta.persistedNote ?? '本次只在当前标签页有效'}`);
      setTimeout(onClose, meta.persisted ? 900 : 2600);
    } catch (e) {
      setError(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="scrim absolute inset-0 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div className="anim-up relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">导入自己的实验数据</h2>
            <p className="mt-1 text-[11px] leading-4 text-dim">
              粘贴或上传 JSON / CSV，立即在浏览器端重新分析（确定性引擎，不上传服务器）
            </p>
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1.5 text-dim transition-colors hover:bg-panel2 hover:text-ink"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* tab 切换 */}
          <div className="mb-3 flex gap-1 rounded-lg bg-panel2/60 p-1">
            <TabBtn active={tab === 'json'} onClick={() => setTab('json')} icon={<FileJson size={13} />} label="JSON" />
            <TabBtn active={tab === 'csv'} onClick={() => setTab('csv')} icon={<FileSpreadsheet size={13} />} label="CSV" />
          </div>

          <p className="mb-2 text-[11px] leading-4 text-muted">
            {tab === 'json' ? (
              <>
                JSON 需含 <code className="rounded bg-panel2 px-1">experiments</code> 与{' '}
                <code className="rounded bg-panel2 px-1">daily</code> 两个数组；若每个实验都带{' '}
                <code className="rounded bg-panel2 px-1">trueDecision</code> /{' '}
                <code className="rounded bg-panel2 px-1">trueLiftOverall</code>，评测看板可继续用。
              </>
            ) : (
              <>
                CSV 必需列：<code className="rounded bg-panel2 px-1">expId, date, variant, exposures, conversions</code>
                ；可选：<code className="rounded bg-panel2 px-1">device, tenure, refunds, complaints, latencyP95, name</code>
                。要按 <b className="text-ink">ARPU</b> 算就再加{' '}
                <code className="rounded bg-panel2 px-1">revenue</code>（该行总收入，元）+
                <code className="rounded bg-panel2 px-1">metricType=continuous</code>；要开 CUPED 再加{' '}
                <code className="rounded bg-panel2 px-1">preExposures, preConversions, preRevenue</code>
                （驼峰，不是下划线）。列头少一个会让整行错位。真实数据通常无真值 → 评测看板自动隐藏。
              </>
            )}
          </p>

          {/* 文件上传 + 粘贴 */}
          <div className="mb-2 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={tab === 'json' ? '.json,application/json' : '.csv,text/csv'}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
              }}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> 上传文件
            </Button>
            {fileName && <span className="truncate text-[11px] text-dim">已选：{fileName}</span>}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(sample);
                setFileName(null);
                setError(null);
              }}
            >
              填入示例
            </Button>
            <button
              className="ml-auto text-[11px] text-brand2 hover:underline"
              onClick={() => setShowExample((v) => !v)}
            >
              {showExample ? '收起格式' : '查看格式'}
            </button>
          </div>

          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setOk(null);
            }}
            spellCheck={false}
            placeholder={tab === 'json' ? '在此粘贴 Dataset JSON…' : '在此粘贴 CSV（含表头）…'}
            className="h-56 w-full resize-y rounded-lg border border-line bg-base px-3 py-2 font-mono text-[11.5px] leading-5 text-ink outline-none focus:border-brand/60"
          />

          {showExample && (
            <Panel className="mt-3">
              <pre className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[10.5px] leading-4 text-muted">
                {sample}
              </pre>
            </Panel>
          )}

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-noship/35 bg-noship/10 px-3 py-2 text-[11.5px] leading-5 text-noship">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {ok && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-ship/35 bg-ship/10 px-3 py-2 text-[11.5px] text-ship">
              <CheckCircle2 size={14} className="shrink-0" />
              <span>{ok}</span>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[10.5px] text-dim">导入后可在「实验列表 / 详情」查看分析与贝叶斯视角</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={handleImport}>
              载入并分析
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ' +
        (active ? 'bg-panel text-brand2 shadow-sm' : 'text-muted hover:text-ink')
      }
    >
      {icon}
      {label}
    </button>
  );
}
