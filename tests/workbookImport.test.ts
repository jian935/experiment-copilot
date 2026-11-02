import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importWorkbook } from '../src/lib/workbookImport.ts';
import { analyze } from '../src/lib/decide.ts';
import { cellToText, gridFromRows } from '../src/lib/spreadsheet.ts';

const XLSX = resolve('data/A_B实验数据-v2.xlsx');
const has = existsSync(XLSX);

describe('单元格归一', () => {
  it('Excel 日期 → YYYY-MM-DD（不转的话 String(date) 会得到一串人看不懂的 GMT 文本）', () => {
    expect(cellToText(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
    expect(cellToText(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });

  it('浮点尾灰被压掉，整数不出现小数', () => {
    expect(cellToText(0.1 + 0.2)).toBe('0.3');
    expect(cellToText(1500)).toBe('1500');
    expect(cellToText(null)).toBe('');
    expect(cellToText(true)).toBe('true');
  });

  it('网格归一：裁掉尾部空列、丢掉全空行', () => {
    const rows = gridFromRows([
      ['a', 'b', '', ''],
      ['', '', ''],
      ['c', ''],
    ]);
    expect(rows).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});

describe.skipIf(!has)('工作簿导入：仓库里的真实 xlsx', () => {
  const file = () => new File([readFileSync(XLSX)], 'A_B实验数据-v2.xlsx');

  it('自动选出明细表、并把 experiments 表的名称与真值并进来', async () => {
    const { dataset, report, workbook } = await importWorkbook(file());
    expect(workbook.detailSheet).toBe('daily_metrics');
    expect(workbook.metaSheets.map((m) => m.sheet)).toEqual(['experiments']);
    expect(workbook.metaSheets[0].named).toBe(6);
    expect(workbook.metaSheets[0].withTruth).toBe(6);

    expect(dataset.experiments).toHaveLength(6);
    // 名称必须来自元信息表，而不是退化成编号
    expect(dataset.experiments[0].name).toBe('结算页改版');
    expect(dataset.experiments[0].hypothesis).toContain('结算页');
    // 拿到真值 → 评测看板可用，这是合并的第二个好处
    expect(dataset.groundTruth).toBe(true);
    expect(report.inferred.some((s) => s.includes('合并了 6 个实验'))).toBe(true);
    expect(report.dropped).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('引擎在这份真实数据上的结论与人工标注 6/6 一致', async () => {
    // 这条是整条导入链路的验收：解析 → 列映射 → 聚合 → 决策，任何一环错位都会掉分
    const { dataset } = await importWorkbook(file());
    const pairs = dataset.experiments.map((e) => {
      const an = analyze(e, dataset.daily.filter((r) => r.expId === e.id));
      return { id: e.id, truth: e.trueDecision, engine: an.decision, reason: an.reasonCode };
    });
    const wrong = pairs.filter((p) => p.truth !== p.engine);
    expect(wrong, `不一致：${JSON.stringify(wrong)}`).toEqual([]);
    expect(pairs).toHaveLength(6);
  });

  it('明细表里的列名（segment_device / latency_p95_ms）被标成「猜的」，等用户确认', async () => {
    const { report } = await importWorkbook(file());
    expect(report.guessed).toEqual(expect.arrayContaining(['device', 'tenure', 'latencyP95']));
    expect(report.unmatchedColumns).toEqual([]);
    expect(report.mapping.device).toBe('segment_device');
  });
});

describe.skipIf(!has)('工作簿导入：只读明细会丢什么（反证）', () => {
  it('只解析 daily_metrics 时实验名退化成编号、groundTruth 为 false', async () => {
    // 这条锁的是「为什么值得支持两个 sheet」：不合并的话，名称与真值都会消失
    const { parseTableRows } = await import('../src/lib/tableImport.ts');
    const { readWorkbook } = await import('../src/lib/spreadsheet.ts');
    const book = await readWorkbook(new File([readFileSync(XLSX)], 'x.xlsx'));
    const daily = book.find((s) => s.name === 'daily_metrics')!;
    const { dataset } = parseTableRows(daily.rows, { source: 'xlsx', sheet: 'daily_metrics' });
    expect(dataset.experiments[0].name).toBe(dataset.experiments[0].id);
    expect(dataset.groundTruth).toBe(false);
  });
});
