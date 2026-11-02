import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  FileJson,
  FileSpreadsheet,
  FileUp,
  Loader2,
  Table2,
  Upload,
  X,
} from 'lucide-react';
import type { Dataset } from '../../lib/types.ts';
import {
  ImportError,
  parseDatasetJson,
  reportForJson,
  SAMPLE_CSV,
  SAMPLE_CSV_MULTIARM,
  SAMPLE_JSON,
  textToRows,
  type ImportReport,
} from '../../lib/import.ts';
import { parseTableRows } from '../../lib/tableImport.ts';
import { detectColumns, FIELDS, type FieldKey } from '../../lib/columnMap.ts';
import { parseWorkbookSheets } from '../../lib/workbookImport.ts';
import { isExcelFile, isLegacyExcel, readWorkbook, type WorkbookSheet } from '../../lib/spreadsheet.ts';
import { armLabel } from '../../lib/arms.ts';
import { fmtNum } from '../lib/format';
import { Button } from './ui';

type Mode = 'table' | 'json';

interface Preview {
  dataset: Dataset;
  report: ImportReport;
  name: string;
  /** 原始数据，改列映射时用它同步重跑（不再读一遍文件） */
  source:
    | { kind: 'json' }
    | { kind: 'csv'; rows: string[][] }
    | { kind: 'xlsx'; book: WorkbookSheet[] };
  /** 工作簿层面的说明（读了哪张表、合并了哪张） */
  workbookNote?: string;
}

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
  const [mode, setMode] = useState<Mode>('table');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showMapping, setShowMapping] = useState(false);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, number>>>({});
  /** 手动指定的对照臂（多臂表里「第一个臂是不是基线」经常反直觉，必须可改） */
  const [controlArm, setControlArm] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const sample = mode === 'json' ? SAMPLE_JSON : SAMPLE_CSV;

  function reset() {
    setPreview(null);
    setMapping({});
    setControlArm(undefined);
    setError(null);
    setOk(null);
    setShowMapping(false);
  }

  /** 改列映射 / 改对照臂后重跑：纯逻辑、同步，不重新读文件 */
  function reparse(next: Partial<Record<FieldKey, number>>, nextControl = controlArm) {
    if (!preview) return;
    setMapping(next);
    setControlArm(nextControl);
    setError(null);
    try {
      if (preview.source.kind === 'csv') {
        const r = parseTableRows(preview.source.rows, { source: 'csv', mapping: next, controlArm: nextControl });
        setPreview({ ...preview, ...r });
      } else if (preview.source.kind === 'xlsx') {
        const r = parseWorkbookSheets(preview.source.book, next, nextControl);
        setPreview({ ...preview, ...r });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function loadCsv(raw: string, name: string) {
    // 先拿到二维表，再走 parseTableRows：这样「首次解析」与「改映射后重跑」用的是同一份 rows，
    // 不会出现「改了个下拉框结果就变了」这种只在特定表格上才复现的怪事
    const rows = textToRows(raw);
    if (rows.length < 2) throw new ImportError('至少要有一行表头 + 一行数据');
    const r = parseTableRows(rows, { source: 'csv' });
    setPreview({ ...r, name, source: { kind: 'csv', rows } });
    setMapping({});
    setControlArm(undefined);
  }

  function loadJson(raw: string, name: string) {
    const dataset = parseDatasetJson(raw);
    setPreview({ dataset, report: reportForJson(dataset), name, source: { kind: 'json' } });
    setMapping({});
  }

  async function handleFile(file: File) {
    reset();
    try {
      if (isLegacyExcel(file.name)) {
        throw new ImportError(
          '不支持老式 .xls（2003 格式）。请在 Excel 里「另存为 → Excel 工作簿(.xlsx)」后再导入。',
        );
      }
      if (/\.json$/i.test(file.name)) {
        setBusy('读取 JSON…');
        loadJson(await file.text(), file.name);
      } else if (/\.(csv|txt)$/i.test(file.name)) {
        setBusy('读取 CSV…');
        loadCsv(await file.text(), file.name);
      } else if (isExcelFile(file.name)) {
        setBusy('解析 Excel（首次会加载表格解析器）…');
        const book = await readWorkbook(file);
        setBusy('识别列、合并工作表…');
        const r = parseWorkbookSheets(book);
        setPreview({
          ...r,
          name: file.name,
          source: { kind: 'xlsx', book },
          workbookNote:
            r.workbook.metaSheets.length > 0
              ? `明细表「${r.workbook.detailSheet}」+ 元信息「${r.workbook.metaSheets.map((m) => m.sheet).join('」「')}」`
              : `明细表「${r.workbook.detailSheet}」${r.workbook.sheets.length > 1 ? `（工作簿共 ${r.workbook.sheets.length} 张表）` : ''}`,
        });
        setMapping({});
      } else {
        throw new ImportError('只支持 .xlsx / .csv / .json 三种文件');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function handlePaste() {
    reset();
    const raw = text.trim();
    if (!raw) {
      setError('请先粘贴数据，或上传一个文件');
      return;
    }
    // 按内容判断格式，而不是让用户先选对页签：
    // 粘一份 JSON 进「表格」页签是最常见的误操作，报「没有识别出必需字段」会让人以为是数据问题。
    const looksJson = raw.startsWith('{') || raw.startsWith('[');
    try {
      if (mode === 'json' || looksJson) {
        if (looksJson && mode !== 'json') setMode('json');
        loadJson(raw, '粘贴的 JSON');
      } else {
        loadCsv(raw, raw.includes('\t') ? '粘贴的表格（Tab 分隔）' : '粘贴的表格（CSV）');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirm() {
    if (!preview) return;
    setError(null);
    const ds = preview.dataset;
    const gtNote = ds.groundTruth ? '（含已知真值，评测看板可用）' : '（无已知真值，评测看板将隐藏）';
    const head = `已载入 ${ds.experiments.length} 个实验、${fmtNum(ds.daily.length)} 行明细 ${gtNote}`;
    try {
      const meta = await onImport(ds, preview.name);
      setOk(meta.persisted ? `${head}，已保存在本机，刷新不丢` : `${head}。${meta.persistedNote ?? '本次只在当前标签页有效'}`);
      setTimeout(onClose, meta.persisted ? 900 : 2600);
    } catch (e) {
      setError(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="scrim absolute inset-0 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div className="anim-up relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              {preview ? '确认导入' : '导入自己的实验数据'}
            </h2>
            <p className="mt-1 text-[11px] leading-4 text-dim">
              {preview
                ? '下面的识别结果都可以改——列指错了比导入失败更难发现'
                : '拖入 Excel / CSV / JSON，浏览器端重新分析（确定性引擎，不上传服务器）'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1.5 text-dim transition-colors hover:bg-panel2 hover:text-ink"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {preview ? (
            <PreviewPanel
              preview={preview}
              onBack={() => {
                reset();
                setText('');
              }}
              showMapping={showMapping}
              toggleMapping={() => setShowMapping((v) => !v)}
              mapping={mapping}
              onMap={(k, i) => {
                const next = { ...mapping };
                if (i < 0) delete next[k];
                else next[k] = i;
                reparse(next);
              }}
              controlArm={controlArm}
              onControlArm={(arm) => reparse(mapping, arm)}
            />
          ) : (
            <>
              {/* 拖拽区：文件是所有格式的统一入口 */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void handleFile(f);
                }}
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click();
                }}
                role="button"
                tabIndex={0}
                aria-label="选择或拖入数据文件"
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 transition-colors ${
                  dragOver
                    ? 'border-brand bg-brand/[0.06]'
                    : 'border-line bg-panel2/40 hover:border-line2 hover:bg-panel2/70'
                }`}
              >
                {busy ? (
                  <>
                    <Loader2 size={20} className="animate-spin text-brand" />
                    <div className="text-[12px] text-muted">{busy}</div>
                  </>
                ) : (
                  <>
                    <FileUp size={22} className={dragOver ? 'text-brand' : 'text-dim'} />
                    <div className="text-[12.5px] font-medium text-ink">
                      把 Excel / CSV / JSON 拖进来，或点这里选文件
                    </div>
                    <div className="text-[10.5px] text-dim">
                      .xlsx（支持多 sheet 自动合并）· .csv · .json ｜ 列名是中文也认
                    </div>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xlsm,.csv,.json,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />

              <div className="my-3 flex items-center gap-2 text-[10.5px] text-dim">
                <span className="h-px flex-1 bg-line" />
                或者直接粘贴
                <span className="h-px flex-1 bg-line" />
              </div>

              <div className="mb-2 flex gap-1 rounded-lg bg-panel2/60 p-1">
                <TabBtn active={mode === 'table'} onClick={() => setMode('table')} icon={<FileSpreadsheet size={13} />} label="CSV / 表格" />
                <TabBtn active={mode === 'json'} onClick={() => setMode('json')} icon={<FileJson size={13} />} label="JSON" />
              </div>

              <p className="mb-2 text-[11px] leading-4 text-muted">
                {mode === 'json' ? (
                  <>
                    JSON 需含 <code className="rounded bg-panel2 px-1">experiments</code> 与{' '}
                    <code className="rounded bg-panel2 px-1">daily</code> 两个数组；若每个实验都带{' '}
                    <code className="rounded bg-panel2 px-1">trueDecision</code> /{' '}
                    <code className="rounded bg-panel2 px-1">trueLiftOverall</code>，评测看板可继续用。
                  </>
                ) : (
                  <>
                    从 Excel 里复制一片区域直接粘贴也行（Tab 分隔会自动识别）。必需列：
                    <code className="rounded bg-panel2 px-1">实验编号 / 日期 / 分组 / 曝光数 / 转化数</code>
                    ——中文、英文、下划线写法都能认，认不出会让你手动指。
                  </>
                )}
              </p>

              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setText(sample);
                    setError(null);
                  }}
                >
                  填入示例
                </Button>
                {mode === 'table' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setText(SAMPLE_CSV_MULTIARM);
                      setError(null);
                    }}
                    title="3 个臂（control / 实验组 / 方案C），分流 50/25/25"
                  >
                    3 臂样例（A/B/n）
                  </Button>
                )}
                <span className="text-[10.5px] text-dim">示例是编造的，只用来演示格式</span>
              </div>

              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                spellCheck={false}
                placeholder={
                  mode === 'json'
                    ? '在此粘贴 Dataset JSON…'
                    : '在此粘贴表格（第一行是表头）。从 Excel 复制的那片区域直接贴进来就行'
                }
                className="h-40 w-full resize-y rounded-lg border border-line bg-base px-3 py-2 font-mono text-[11.5px] leading-5 text-ink outline-none focus:border-brand/60"
              />
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-brand2">查看示例格式</summary>
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-panel2/50 px-3 py-2 font-mono text-[10.5px] leading-4 text-muted">
                  {sample}
                </pre>
              </details>
            </>
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
          <span className="text-[10.5px] text-dim">
            {preview ? '导入后可在「实验列表 / 详情」查看分析与贝叶斯视角' : '数据不上传服务器，解析全在本机完成'}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              取消
            </Button>
            {preview ? (
              <Button size="sm" variant="primary" onClick={() => void confirm()}>
                <Check size={13} /> 确认导入
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={handlePaste} disabled={busy !== null}>
                载入并分析
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ───────────────────────── 预检面板 ───────────────────────── */

function PreviewPanel({
  preview,
  onBack,
  showMapping,
  toggleMapping,
  mapping,
  onMap,
  controlArm,
  onControlArm,
}: {
  preview: Preview;
  onBack: () => void;
  showMapping: boolean;
  toggleMapping: () => void;
  mapping: Partial<Record<FieldKey, number>>;
  onMap: (k: FieldKey, i: number) => void;
  controlArm?: string;
  onControlArm: (arm: string | undefined) => void;
}) {
  const { dataset, report } = preview;
  const exposures = useMemo(() => dataset.daily.reduce((s, r) => s + r.exposures, 0), [dataset]);
  const canMap = preview.source.kind !== 'json';

  return (
    <div className="space-y-3">
      {/* 摘要 */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-xl border border-line bg-panel2/40 px-4 py-3">
        <Stat value={fmtNum(dataset.experiments.length)} unit="个实验" />
        <Stat value={fmtNum(dataset.daily.length)} unit="行明细" />
        <Stat value={fmtNum(exposures)} unit="次曝光" />
        {dataset.groundTruth && (
          <span className="rounded bg-ship/15 px-1.5 py-0.5 text-[10.5px] text-ship">含真值 · 评测看板可用</span>
        )}
        <button onClick={onBack} className="ml-auto text-[11px] text-dim underline-offset-2 hover:text-ink hover:underline">
          重新选择
        </button>
      </div>

      {preview.workbookNote && (
        <p className="text-[10.5px] leading-4 text-dim">
          <Table2 size={11} className="mr-1 inline" />
          {preview.workbookNote}
        </p>
      )}

      {/* 列识别 */}
      <section className="rounded-xl border border-line">
        <button
          onClick={toggleMapping}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
          aria-expanded={showMapping}
        >
          <ChevronDown size={13} className={`text-dim transition-transform ${showMapping ? '' : '-rotate-90'}`} />
          <span className="text-[11.5px] font-medium text-ink">列识别</span>
          <span className="text-[10.5px] text-dim">
            {canMap ? '点开可以手动改；认错的列比导入失败更难发现' : 'JSON 是结构化格式，不需要列映射'}
          </span>
          {report.guessed.length > 0 && canMap && (
            <span className="ml-auto rounded bg-iterate/15 px-1.5 py-0.5 text-[10px] text-iterate">
              {report.guessed.length} 处是猜的，建议核对
            </span>
          )}
        </button>
        {showMapping && canMap && (
          <div className="border-t border-line px-4 py-2">
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {FIELDS.map((f) => {
                const idx = mapping[f.key] ?? -1;
                const current = idx >= 0 ? idx : -2; // -2 = 用自动识别的
                const autoName = report.mapping[f.key];
                const guessed = report.guessed.includes(f.key);
                return (
                  <label key={f.key} className="flex items-center gap-2 text-[11px]">
                    <span className="w-20 shrink-0 text-muted">
                      {f.label}
                      {f.required && <span className="text-noship">*</span>}
                    </span>
                    <select
                      value={current}
                      onChange={(e) => onMap(f.key, Number(e.target.value))}
                      className="min-w-0 flex-1 rounded border border-line bg-base px-1.5 py-1 text-[11px] text-ink outline-none focus:border-brand/60"
                    >
                      <option value={-2}>{autoName ? `自动：${autoName}` : '自动（未识别）'}</option>
                      <option value={-1}>未指定</option>
                      {report.header.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `(第 ${i + 1} 列，空表头)`}
                        </option>
                      ))}
                    </select>
                    <span className="w-4 shrink-0 text-center">
                      {autoName && !guessed ? (
                        <Check size={11} className="inline text-ship" />
                      ) : autoName ? (
                        <span className="text-[10px] text-iterate">?</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-dim">
              {FIELDS.find((f) => f.key === 'refunds')!.hint}
            </p>
          </div>
        )}
      </section>

      {/* 实验清单 */}
      <section className="rounded-xl border border-line">
        <div className="flex items-baseline gap-2 px-4 py-2.5">
          <span className="text-[11.5px] font-medium text-ink">进来的实验</span>
          <span className="text-[10.5px] text-dim">
            {report.experiments.length > 6 ? `前 6 个，共 ${report.experiments.length} 个` : '全部'}
          </span>
          {report.experiments.some((e) => e.arms.length > 2) && (
            <span className="ml-auto rounded bg-brand/12 px-1.5 py-0.5 text-[10px] text-brand2">
              含多臂实验 · 会按 A/B/n 分析
            </span>
          )}
        </div>
        <div className="border-t border-line">
          <table className="w-full text-[11px]">
            <tbody>
              {report.experiments.slice(0, 6).map((e) => {
                const multi = e.arms.length > 2;
                // 只有多臂才让人改对照臂：两臂的对照是唯一的，给个下拉只会增加误操作
                const canPickControl = multi && e.arms.length > 1;
                return (
                  <tr key={e.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-1.5 font-medium text-ink">{e.id}</td>
                    <td className="max-w-[160px] truncate px-2 py-1.5 text-muted">{e.name}</td>
                    <td className="px-2 py-1.5 text-right text-dim">{e.days} 天</td>
                    <td className="px-2 py-1.5 text-dim">{e.metricType === 'continuous' ? 'ARPU' : '率'}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${multi ? 'bg-brand/12 text-brand2' : 'bg-panel2 text-dim'}`}>
                          {e.arms.length} 臂
                        </span>
                        {e.arms.slice(0, 4).map((a) => (
                          <span
                            key={a}
                            className={`rounded px-1 py-0.5 text-[10px] ${
                              a === e.controlArm ? 'bg-ship/15 text-ship' : 'bg-panel2/70 text-muted'
                            }`}
                            title={a === e.controlArm ? '对照组' : '与对照组比较'}
                          >
                            {armLabel(a)}
                          </span>
                        ))}
                        {e.arms.length > 4 && <span className="text-[10px] text-dim">+{e.arms.length - 4}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {e.arms.length >= 2 ? (
                        <span className="text-[10.5px] text-ship">{multi ? '多臂可比' : '两臂齐'}</span>
                      ) : (
                        <span className="text-[10.5px] text-noship">缺一臂</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {canPickControl ? (
                        <select
                          value={controlArm && e.arms.includes(controlArm) ? controlArm : e.controlArm}
                          onChange={(ev) => onControlArm(ev.target.value)}
                          title="对照臂：错误的对照会让所有差值反号"
                          className={`rounded border px-1 py-0.5 text-[10.5px] outline-none ${
                            e.controlImplicit
                              ? 'border-iterate/60 bg-iterate/10 text-iterate'
                              : 'border-line bg-base text-muted'
                          }`}
                        >
                          {e.arms.map((a) => (
                            <option key={a} value={a}>
                              对照：{armLabel(a)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[10px] text-dim">对照：{armLabel(e.controlArm)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 推断 / 警告 / 丢弃 */}
      {report.inferred.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-line bg-panel2/30 px-4 py-2.5">
          {report.inferred.map((s, i) => (
            <li key={i} className="flex gap-1.5 text-[10.5px] leading-4 text-muted">
              <span className="text-brand2">→</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-iterate/35 bg-iterate/[0.07] px-4 py-2.5">
          {report.warnings.map((s, i) => (
            <li key={i} className="flex gap-1.5 text-[10.5px] leading-4 text-iterate">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}

      {report.dropped.length > 0 && (
        <details className="rounded-xl border border-noship/35 bg-noship/[0.06] px-4 py-2.5">
          <summary className="cursor-pointer text-[10.5px] text-noship">
            已跳过 {report.dropped.length} 行（点开看是哪几行、为什么）
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {report.dropped.map((d) => (
              <li key={d.row} className="text-[10.5px] text-muted">
                第 {d.row} 行：{d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.unmatchedColumns.length > 0 && (
        <p className="text-[10.5px] leading-4 text-dim">
          这些列没被用上：{report.unmatchedColumns.slice(0, 6).join('、')}
          {report.unmatchedColumns.length > 6 ? ` 等 ${report.unmatchedColumns.length} 列` : ''}
          （不影响分析，只是不会参与计算）
        </p>
      )}
    </div>
  );
}

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="num text-[15px] font-semibold text-ink">{value}</span>
      <span className="text-[10.5px] text-dim">{unit}</span>
    </span>
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
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11.5px] transition-colors ${
        active ? 'bg-panel text-ink shadow-sm' : 'text-dim hover:text-muted'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

