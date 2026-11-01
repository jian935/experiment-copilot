/**
 * Agent 问答自动评测（D6）的测试。
 *
 * 这个文件真正的价值不是「跑通」，而是**锁住两件事**：
 *  1. 规则模式不许出现引擎没算过的数字（幻觉数字率恒 0）——模板里一旦自己算数就红；
 *  2. 13 个工具必须都被题库覆盖 —— 写了工具却没人能用上，比没写更糟。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/lib/decide.ts';
import { evaluateAgent, byQa, QA_BANK } from '../src/lib/agentEval.ts';
import { auditNumbers, buildWhitelist } from '../src/lib/agent/audit.ts';
import type { Dataset } from '../src/lib/types.ts';

const ds: Dataset = JSON.parse(readFileSync('data/experiments.json', 'utf8')) as Dataset;
const analyses = new Map(ds.experiments.map((e) => [e.id, analyze(e, ds.daily)]));
const ev = evaluateAgent(ds, analyses);

describe('白名单要认得工具返回的格式化文本', () => {
  it('字符串里的数字属于「引擎返回过」，不算幻觉', () => {
    // 这条是回归锁：以前 walk 只收 number，于是「可检出的最小差异从 0.63pp 收窄到 0.4pp」
    // 里的 0.63 被判成无法溯源 —— 那是判定器 bug，不是回答的错。
    const wl = buildWhitelist([{ mdeNowText: '0.63pp', diffText: '+1.23元', pText: 'p=0.031' }]);
    expect(auditNumbers('最小差异从 0.63pp 收窄到 0.4pp', wl).suspicious).toEqual([]);
    expect(auditNumbers('差值 +1.23元', wl).suspicious).toEqual([]);
    expect(auditNumbers('p=0.031', wl).suspicious).toEqual([]);
  });

  it('白名单仍然抓得住编出来的数字（放宽不能放到失效）', () => {
    const wl = buildWhitelist([{ mdeNowText: '0.63pp' }]);
    expect(auditNumbers('样本需要 12345 人', wl).suspicious).toEqual(['12345']);
  });
});

describe('题库覆盖', () => {
  it('13 个工具一个都不能少（有工具没被用到 = 白写）', () => {
    expect(ev.uncoveredTools).toEqual([]);
    expect(ev.toolCalls.filter((t) => t.calls > 0)).toHaveLength(13);
  });

  it('每道题都至少被问过一次，且题号唯一', () => {
    const ids = [...new Set(ev.rows.map((r) => r.qaId))];
    expect(ids.sort()).toEqual(QA_BANK.map((q) => q.id).sort());
    expect(new Set(QA_BANK.map((q) => q.id)).size).toBe(QA_BANK.length);
  });
});

describe('规则模式的度量', () => {
  it('幻觉数字率恒为 0（模板不许自己算数）', () => {
    expect(ev.suspicious).toBe(0);
    expect(ev.hallucinationRate).toBe(0);
    expect(ev.dirtyAnswerRate).toBe(0);
    expect(ev.violationRate).toBe(0);
  });

  it('引用覆盖率只在该引的时候算分母（无证据可引的题不计入）', () => {
    expect(ev.citationRate).toBe(1);
    expect(ev.citableN).toBeLessThan(ev.n);
  });

  it('口径陷阱题：率口径实验被问 ARPU 时说清主/副指标', () => {
    // 分母必须正好是「主指标为转化率」的实验数（每题一条）
    const binary = ds.experiments.filter((e) => (e.metricType ?? 'binary') !== 'continuous').length;
    expect(ev.trapN).toBe(binary);
    expect(ev.scopeRate).toBe(1);
    const sample = ev.rows.find((r) => r.trap);
    expect(sample?.answer).toMatch(/主指标|副指标/);
  });

  it('路由准确率 100%（每题都走到期望意图）', () => {
    expect(ev.routeAccuracy).toBe(1);
    expect(ev.routeN).toBeGreaterThan(0);
  });

  it('byQa 的条数之和等于总问答数（聚合不能丢样本）', () => {
    expect(byQa(ev).reduce((s, q) => s + q.n, 0)).toBe(ev.n);
  });
});
