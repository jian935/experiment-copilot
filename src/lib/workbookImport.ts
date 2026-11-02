/**
 * 工作簿级导入：从一本 .xlsx 里自动拼出「一份完整的实验数据」。
 *
 * 真实 PM 的 Excel 长这样：
 *   - `experiments`：exp_id / exp_name / hypothesis / decision / true_lift …
 *   - `daily_metrics`：exp_id / date / variant / segment_* / exposures / conversions …
 *
 * 只读一个 sheet 会得到两种残废结果：读明细 → 6 个实验全叫 `E001`、评测看板因「无真值」隐藏；
 * 读元信息 → 一行数据都没有。所以这里的职责是**找对明细表、再把元信息按 id 合并进去**。
 *
 * 两条纪律：
 * 1. 选表不靠 sheet 名（`Sheet1` / `明细` / `data` 什么都有），靠「能不能解析成明细表」+ 行数。
 * 2. 合并时**只补空字段**，绝不覆盖明细里已有的值——元信息表常年过期，明细才是当次事实。
 */

import type { Dataset, Decision, Experiment } from './types.ts';
import { detectColumns, normalizeHeader } from './columnMap.ts';
import { ImportError, parseTableRows, type TableParseResult } from './tableImport.ts';
import { readWorkbook, type WorkbookSheet } from './spreadsheet.ts';

/** 元信息表里可能出现的列（不在 columnMap 的字段表里，因为不需要用户手动映射） */
const META_ALIASES = {
  hypothesis: ['hypothesis', '假设', '实验假设', '预期', '实验目的'],
  decision: ['decision', 'truedecision', 'true_decision', '真值', '真实结论', '判定', '结论'],
  lift: ['trueliftsoverall', 'true_lift_overall', 'truelift', 'true_lift', '真实提升', '真实差值', 'lift'],
  trafficSplit: ['trafficsplit', 'traffic_split', '分流比例', '分流'],
};

const DECISION_ALIASES: Record<string, Decision> = {
  ship: 'ship',
  上线: 'ship',
  可以上线: 'ship',
  'no-ship': 'no-ship',
  noship: 'no-ship',
  不上线: 'no-ship',
  不要上: 'no-ship',
  iterate: 'iterate',
  迭代: 'iterate',
  继续迭代: 'iterate',
  inconclusive: 'inconclusive',
  无法下结论: 'inconclusive',
  证据不足: 'inconclusive',
};

function findColumn(header: string[], aliases: string[]): number {
  const norm = header.map(normalizeHeader);
  for (const a of aliases) {
    const i = norm.indexOf(normalizeHeader(a));
    if (i >= 0) return i;
  }
  return -1;
}

export interface MergedMeta {
  sheet: string;
  /** 补上了名称的实验数 */
  named: number;
  /** 补上了真值的实验数 */
  withTruth: number;
}

export interface WorkbookReport extends TableParseResult {
  workbook: {
    sheets: string[];
    /** 被当成明细表的那一张 */
    detailSheet: string;
    /** 被当成元信息并进来的那些 */
    metaSheets: MergedMeta[];
  };
}

/**
 * 从「已读出的若干张表」拼数据。与读文件解耦，这样 UI 改列映射时可以**同步重跑**，
 * 不用把 File 再解析一遍（10 万行的表再解析一次要好几秒，用户会以为点坏了）。
 */
export function parseWorkbookSheets(
  book: WorkbookSheet[],
  mapping?: Partial<Record<import('./columnMap.ts').FieldKey, number>>,
  controlArm?: string,
): WorkbookReport {
  if (!book.length) throw new ImportError('这个工作簿里没有工作表');

  // 逐张试解析：能解出明细的才算候选（sheet 名不可信，只能靠内容判断）
  const attempts = book.map((s) => {
    try {
      return {
        sheet: s,
        result: parseTableRows(s.rows, { source: 'xlsx' as const, sheet: s.name, mapping, controlArm }),
        error: null,
      };
    } catch (e) {
      return { sheet: s, result: null, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const usable = attempts.filter((a) => a.result) as Array<{
    sheet: WorkbookSheet;
    result: TableParseResult;
    error: null;
  }>;
  if (!usable.length) {
    // 全都不行时，把每张表的原因列出来——只说「导入失败」等于没说
    const detail = attempts
      .map((a) => `「${a.sheet.name}」：${(a.error ?? '').split('\n')[0]}`)
      .join('\n');
    throw new ImportError(
      `这个工作簿里没有一张表能当明细用（需要能识别出 实验编号/日期/分组/曝光/转化）。\n${detail}`,
    );
  }

  // 明细表 = 有效行最多的那张（元信息表通常只有几行，选不出错）
  usable.sort((a, b) => b.result.report.rowsUsed - a.result.report.rowsUsed);
  const main = usable[0];
  const dataset = main.result.dataset;
  const report = main.result.report;
  report.sheet = main.sheet.name;

  const metaSheets: MergedMeta[] = [];
  for (const other of book) {
    if (other.name === main.sheet.name) continue;
    const merged = mergeMeta(dataset, other);
    if (merged) metaSheets.push(merged);
  }

  // 预检清单里的名称要跟着合并结果走。
  // 第一版漏了这一步：底部写着「合并了 6 个实验的名称」，上面清单里还全是 E001——
  // 两句话自相矛盾，而用户只会信清单。
  const nameById = new Map(dataset.experiments.map((e) => [e.id, e.name]));
  const metricById = new Map(dataset.experiments.map((e) => [e.id, e.metricType]));
  report.experiments = report.experiments.map((e) => ({
    ...e,
    name: nameById.get(e.id) ?? e.name,
    metricType: metricById.get(e.id) ?? e.metricType,
  }));

  const inferred = [...report.inferred];
  for (const m of metaSheets) {
    inferred.push(
      `从工作表「${m.sheet}」合并了 ${m.named} 个实验的名称${m.withTruth ? `、${m.withTruth} 个真值` : ''}`,
    );
  }
  if (book.length > 1 && !metaSheets.length) {
    report.warnings.push(
      `工作簿里还有 ${book.length - 1} 张表没被用上（${book
        .filter((s) => s.name !== main.sheet.name)
        .map((s) => s.name)
        .join('、')}）——如果里面有实验名称或真值，请确认它的编号列名能被识别（如 exp_id）`,
    );
  }

  return {
    dataset,
    report: { ...report, inferred },
    workbook: { sheets: book.map((s) => s.name), detailSheet: main.sheet.name, metaSheets },
  };
}

export async function importWorkbook(file: File): Promise<WorkbookReport> {
  return parseWorkbookSheets(await readWorkbook(file));
}

/** 把一张元信息表按实验编号并进 dataset；认不出编号列就返回 null（不是所有 sheet 都该并） */
function mergeMeta(dataset: Dataset, sheet: WorkbookSheet): MergedMeta | null {
  if (!sheet.rows.length) return null;
  const header = sheet.rows[0];
  const det = detectColumns(header);
  if (det.mapping.expId < 0) return null;

  const iId = det.mapping.expId;
  const iName = det.mapping.name;
  const iHyp = findColumn(header, META_ALIASES.hypothesis);
  const iDec = findColumn(header, META_ALIASES.decision);
  const iLift = findColumn(header, META_ALIASES.lift);
  // 一个能提供的信息都没有，就别声称「合并过」
  if (iName < 0 && iHyp < 0 && iDec < 0 && iLift < 0) return null;

  const byId = new Map<string, Experiment>(dataset.experiments.map((e) => [e.id, e]));
  let named = 0;
  let withTruth = 0;

  for (let r = 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const id = String(row[iId] ?? '').trim();
    if (!id) continue;
    const exp = byId.get(id);
    if (!exp) continue; // 明细里没有这个实验：不凭空造一条

    const name = iName >= 0 ? String(row[iName] ?? '').trim() : '';
    // 只补空字段：明细里的名字优先（元信息表常年过期）
    if (name && (exp.name === exp.id || !exp.name)) {
      exp.name = name;
      named++;
    }
    const hyp = iHyp >= 0 ? String(row[iHyp] ?? '').trim() : '';
    if (hyp && !exp.hypothesis) exp.hypothesis = hyp;

    if (iDec >= 0) {
      const raw = String(row[iDec] ?? '').trim();
      const dec = DECISION_ALIASES[raw.toLowerCase()] ?? DECISION_ALIASES[raw];
      if (dec) {
        exp.trueDecision = dec;
        withTruth++;
      }
    }
    if (iLift >= 0) {
      const v = Number(String(row[iLift] ?? '').replace(/[,，%\s]/g, '').trim());
      if (Number.isFinite(v)) {
        // 百分号写法（2.2%）→ 0.022；已是小数则原样
        exp.trueLiftOverall = String(row[iLift]).includes('%') ? v / 100 : v;
      }
    }
  }

  if (named === 0 && withTruth === 0) return null;

  // 每个实验都拿到了真值（inconclusive 也是标注，不能算「没有」）→ 评测看板可以用了。
  // 这是合并带来的第二个好处：只读明细的话，评测那一屏永远是隐藏的。
  if (withTruth >= dataset.experiments.length) dataset.groundTruth = true;
  return { sheet: sheet.name, named, withTruth };
}
