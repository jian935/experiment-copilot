import { describe, expect, it } from 'vitest';
import { runLogOf, runLogJson } from '../src/lib/agent/runlog.ts';
import type { AgentReply } from '../src/lib/agent/types.ts';

/** 手搓一条回答，只关心 runlog 读取的字段（不依赖数据集，纯结构测试） */
function makeReply(partial?: Partial<AgentReply>): AgentReply {
  return {
    text: '主指标显著（p=0.01）。 [E1]',
    intent: 'significance',
    by: 'rules',
    calls: [
      { tool: 'run_test', args: {}, summary: 'p=0.01', data: {}, cites: ['E1', 'E2'], durationMs: 0.42 },
      { tool: 'get_overview', args: { note: 'x' }, summary: '结论 ship', data: {}, cites: ['E3'] },
    ],
    audit: { total: 3, suspicious: [] },
    violations: [],
    elapsedMs: 12.34,
    ...partial,
  };
}

describe('运行日志（M19）', () => {
  it('逐步保留工具、耗时、引用数与参数', () => {
    const log = runLogOf(makeReply());
    expect(log.toolCount).toBe(2);
    expect(log.tools.map((t) => t.tool)).toEqual(['run_test', 'get_overview']);
    expect(log.tools[0].durationMs).toBe(0.42);
    expect(log.tools[0].cites).toBe(2);
    expect(log.tools[1].args).toEqual({ note: 'x' });
  });

  it('缺失的耗时记为 null，不填 0 假装测到', () => {
    const log = runLogOf(makeReply());
    expect(log.tools[1].durationMs).toBeNull();
  });

  it('usage 缺省为 null；有则原样透传', () => {
    expect(runLogOf(makeReply()).usage).toBeNull();
    const withUsage = runLogOf(
      makeReply({ by: 'llm', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
    );
    expect(withUsage.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  });

  it('审计与违规被复制，不共享引用（改日志不影响原回答）', () => {
    const reply = makeReply();
    const log = runLogOf(reply);
    log.audit.suspicious.push('999');
    log.violations.push('x');
    expect(reply.audit.suspicious).toEqual([]);
    expect(reply.violations).toEqual([]);
  });

  it('runLogJson 可被 JSON.parse，且与 runLogOf 结构一致', () => {
    const reply = makeReply();
    const parsed = JSON.parse(runLogJson(reply));
    expect(parsed).toEqual(runLogOf(reply));
    expect(parsed.by).toBe('rules');
    expect(parsed.elapsedMs).toBe(12.34);
  });

  it('规则模式没有 usage 时，整数计数与审计结论一致', () => {
    const log = runLogOf(makeReply());
    expect(log.by).toBe('rules');
    expect(log.usage).toBeNull();
    expect(log.audit.total).toBe(3);
  });
});
