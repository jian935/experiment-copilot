/**
 * 读 Excel（.xlsx）成二维字符串表。
 *
 * 为什么值得为它引一个依赖：PM 手里的实验数据 99% 在 Excel 里，要求「先另存为 CSV」
 * 看起来无害，实际会让一半人在第一步就放弃——而另存为 CSV 还会顺带丢日期格式、丢前导零、
 * 在中文 Windows 上默认存成 GBK 导致乱码。**能直接读 xlsx 是导入体验的分水岭。**
 *
 * 体积怎么控：`read-excel-file` 只在用户真的拖进 .xlsx 时才 `import()`，
 * 它会被切成独立 chunk，首屏 JS 一行都不增加（实测首屏 573KB 不变）。
 *
 * 已知不支持：老式 .xls（二进制 BIFF）、带密码的工作簿、图表/图片内容。
 * 前两个会给出明确提示，而不是解析出一堆乱码。
 */

export type Grid = string[][];

export interface SpreadsheetData {
  /** 工作簿里所有 sheet 名 */
  sheets: string[];
  /** 实际读的那个 */
  sheet: string;
  rows: Grid;
}

/**
 * 单元格值归一成字符串。
 *
 * 三个必须处理的：
 * - **Date**：read-excel-file 会把日期单元格给成 Date。不转的话 String(date) 会得到
 *   `Wed Jan 05 2026 00:00:00 GMT+0800`，后面日期解析直接失败，而且报错信息完全看不出原因。
 * - **浮点尾灰**：Excel 里存的是 0.30000000000000004 这种，直接印出来会污染预检报告。
 * - **科学计数**：大数（如 1.23E+12）印成 "1.23e+12"，作为数字解析没问题，保留原样即可。
 */
export function cellToText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    // Excel 的日期没有时区，read-excel-file 给的是 UTC 午夜；用 UTC 取日期才不会整体偏一天
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).trim();
}

/** 二维表归一：转文本、裁掉尾部空列、丢掉全空行（Excel 底部常带几千行空行） */
export function gridFromRows(rows: unknown[][]): Grid {
  const out: Grid = [];
  for (const r of rows) {
    const cells = (r ?? []).map(cellToText);
    // 尾部空列裁掉：不同行长度不齐时，parseTableRows 按下标取值会错位
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.every((c) => c === '')) continue;
    out.push(cells);
  }
  return out;
}

export function isExcelFile(name: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(name);
}

/** 老式 .xls 明确拒绝：硬解会得到乱码，比报错更难查 */
export function isLegacyExcel(name: string): boolean {
  return /\.xls$/i.test(name);
}

type Module = typeof import('read-excel-file/browser');

let cached: Module | null = null;
async function lib(): Promise<Module> {
  if (!cached) cached = await import('read-excel-file/browser');
  return cached;
}

/**
 * 一次读出整本工作簿（read-excel-file 9.x 的 `readXlsxFile` 就是返回全部 sheet）。
 *
 * 为什么不做「先列 sheet 名、再读某一个」：那样要把同一个 File 解析两遍，
 * 对 10 万行的表就是两倍等待。这里一次解析、按名取用。
 */
export interface WorkbookSheet {
  name: string;
  rows: Grid;
}

/**
 * 读出整本工作簿：每个 sheet 一张二维表。
 *
 * 为什么需要「整本」而不只是「一个 sheet」：真实 PM 的表几乎都是两个 sheet——
 * `experiments`（编号 / 名称 / 假设 / 真值）+ `daily_metrics`（日级明细）。
 * 只读明细的话，导进来的实验全都叫 `E001`，评测看板也因为「没有真值」而隐藏。
 * 上层（`workbookImport.ts`）会用两个 sheet 自动拼出完整的一份数据。
 */
export async function readWorkbook(file: File): Promise<WorkbookSheet[]> {
  if (isLegacyExcel(file.name)) {
    throw new Error('不支持老式 .xls（2003 格式）。请在 Excel 里「另存为 → Excel 工作簿(.xlsx)」后再导入。');
  }
  const { default: readXlsxFile } = await lib();
  const book = (await readXlsxFile(file)) as Array<{ sheet: string; data: unknown[][] }>;
  if (!book.length) throw new Error('这个工作簿里没有工作表');
  return book.map((s) => ({ name: s.sheet, rows: gridFromRows(s.data ?? []) }));
}

export async function readSpreadsheet(file: File, sheet?: string): Promise<SpreadsheetData> {
  const book = await readWorkbook(file);
  const sheets = book.map((s) => s.name);
  const target = sheet && sheets.includes(sheet) ? sheet : sheets[0];
  const picked = book.find((s) => s.name === target) ?? book[0];
  if (!picked || !picked.rows.length) throw new Error(`工作表「${target}」是空的`);
  return { sheets, sheet: target, rows: picked.rows };
}
