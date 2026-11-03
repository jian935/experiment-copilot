/**
 * Agent 记忆层（M18）的纯函数测试。
 *
 * 记忆层不依赖任何存储 / 浏览器：调用方把已经读出的记录传进来，这里只做聚合与文本生成。
 * 所以测试直接构造 MemoryDecision[]，不需要 localStorage。
 */
import { describe, expect, it } from 'vitest';
import { buildMemory, EMPTY_MEMORY, type MemoryDecision } from '../src/lib/agent/memory.ts';

const mk = (over: Partial<MemoryDecision> & Pick<MemoryDecision, 'expId' | 'decision'>): MemoryDecision => ({
  note: '',
  decidedAt: '2026-11-01T10:00:00.000Z',
  ...over,
});

describe('buildMemory 聚合', () => {
  it('空记录得到空记忆，且所有查询安全', () => {
    expect(EMPTY_MEMORY.count).toBe(0);
    expect(EMPTY_MEMORY.byDecision).toEqual({});
    expect(EMPTY_MEMORY.decisionFor('E001')).toBeUndefined();
    expect(EMPTY_MEMORY.contradicts('E001')).toBe(false);
    expect(EMPTY_MEMORY.summaryFor('E001')).toContain('尚未');
    expect(EMPTY_MEMORY.recent()).toEqual([]);
  });

  it('计数与按判决分类正确，recent 按时间倒序', () => {
    const m = buildMemory([
      mk({ expId: 'E001', decision: 'ship', decidedAt: '2026-01-01T00:00:00.000Z' }),
      mk({ expId: 'E002', decision: 'no-ship', decidedAt: '2026-03-01T00:00:00.000Z' }),
      mk({ expId: 'E003', decision: 'ship', decidedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(m.count).toBe(3);
    expect(m.byDecision).toEqual({ ship: 2, 'no-ship': 1 });
    expect(m.recent(2).map((d) => d.expId)).toEqual(['E002', 'E003']); // 3月 > 2月 > 1月
  });
});

describe('矛盾判定只取明确相反', () => {
  it('人 ship 且引擎 no-ship → 矛盾', () => {
    const m = buildMemory([mk({ expId: 'E001', decision: 'ship', engineDecision: 'no-ship' })]);
    expect(m.contradicts('E001')).toBe(true);
  });

  it('人 no-ship 且引擎 ship → 矛盾', () => {
    const m = buildMemory([mk({ expId: 'E001', decision: 'no-ship', engineDecision: 'ship' })]);
    expect(m.contradicts('E001')).toBe(true);
  });

  it('引擎 inconclusive 时任何人工判决都不算矛盾（引擎自己没结论）', () => {
    const m = buildMemory([mk({ expId: 'E001', decision: 'ship', engineDecision: 'inconclusive' })]);
    expect(m.contradicts('E001')).toBe(false);
  });

  it('iterate / hold 是暂缓，不算矛盾（即使引擎相反）', () => {
    const m = buildMemory([mk({ expId: 'E001', decision: 'iterate', engineDecision: 'ship' })]);
    expect(m.contradicts('E001')).toBe(false);
  });

  it('人和引擎方向一致时不矛盾', () => {
    const m = buildMemory([mk({ expId: 'E001', decision: 'ship', engineDecision: 'ship' })]);
    expect(m.contradicts('E001')).toBe(false);
  });
});

describe('summaryFor 文本', () => {
  it('有记录时给出判决、日期、引擎结论与理由', () => {
    const m = buildMemory([
      mk({ expId: 'E001', decision: 'ship', engineDecision: 'no-ship', note: '护栏虽恶化但可承受', decidedAt: '2026-05-12T08:30:00.000Z' }),
    ]);
    const s = m.summaryFor('E001');
    expect(s).toContain('2026-05-12');
    expect(s).toContain('上线');
    expect(s).toContain('no-ship');
    expect(s).toContain('护栏虽恶化但可承受');
    expect(s).toContain('不一致');
  });

  it('无记录时明确说没有，并说明只在本机', () => {
    expect(EMPTY_MEMORY.summaryFor('E999')).toContain('本机浏览器');
  });
});
