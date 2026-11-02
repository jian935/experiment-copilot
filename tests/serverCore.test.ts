import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actionsOf, alertId, appendAudit, can, checkPassword, diffScan, hashPassword, newToken,
  readAudit, readJson, sha256, verifyPassword, writeJson,
  type AuditEntry, type ScanPoint,
} from '../server/core.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'ec-srv-'));

describe('密码：scrypt + 独立盐', () => {
  it('同一个密码两次哈希不同（盐不同），但都能验过', () => {
    const a = hashPassword('exp2026abc');
    const b = hashPassword('exp2026abc');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('exp2026abc', a)).toBe(true);
    expect(verifyPassword('exp2026abc', b)).toBe(true);
    expect(verifyPassword('exp2026abd', a)).toBe(false);
  });

  it('存坏的哈希不会抛异常，只是验不过（不能因为一条脏数据让登录接口 500）', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'md5$aa$bb')).toBe(false);
  });

  it('弱密码只拦「人人都能猜到」的那几种，不做复杂度表演', () => {
    expect(checkPassword('12345678')).toMatch(/字母和数字|常见/);
    expect(checkPassword('short1')).toMatch(/至少 8 位/);
    expect(checkPassword('password')).toMatch(/字母和数字/);
    expect(checkPassword('password1')).toMatch(/常见/);
    expect(checkPassword('exp2026abc')).toBeNull();
    expect(checkPassword('a1b2c3d4')).toBeNull();
  });
});

describe('RBAC：角色 → 动作', () => {
  it('viewer 只能读，analyst 能传数据与记决策，admin 全部', () => {
    expect(can('viewer', 'analysis:read')).toBe(true);
    expect(can('viewer', 'alert:read')).toBe(true);
    expect(can('viewer', 'decision:write')).toBe(false);
    expect(can('viewer', 'audit:read')).toBe(false);

    expect(can('analyst', 'decision:write')).toBe(true);
    expect(can('analyst', 'dataset:write')).toBe(true);
    // 分析师不能审批、不能改口径、不能管人
    expect(can('analyst', 'decision:approve')).toBe(false);
    expect(can('analyst', 'metric:write')).toBe(false);
    expect(can('analyst', 'user:manage')).toBe(false);

    for (const a of actionsOf('admin')) expect(can('admin', a)).toBe(true);
    expect(can('admin', 'audit:read')).toBe(true);
  });

  it('权限是包含关系：admin ⊇ analyst ⊇ viewer', () => {
    for (const a of actionsOf('viewer')) expect(can('analyst', a)).toBe(true);
    for (const a of actionsOf('analyst')) expect(can('admin', a)).toBe(true);
  });
});

describe('API Token', () => {
  it('明文只出现一次，库里存的是哈希，尾号用来区分', () => {
    const t = newToken();
    expect(t.plain.startsWith('ec_')).toBe(true);
    expect(t.hash).toBe(sha256(t.plain));
    expect(t.hash).not.toContain(t.plain);
    expect(t.plain.endsWith(t.tail)).toBe(true);
    expect(t.tail).toHaveLength(6);
  });

  it('两次生成的 token 不重复', () => {
    const set = new Set(Array.from({ length: 50 }, () => newToken().plain));
    expect(set.size).toBe(50);
  });
});

describe('存储：原子写 + 坏文件不静默吞掉', () => {
  it('写进去能读出来，且不留临时文件', () => {
    const dir = tmp();
    const f = join(dir, 'a.json');
    writeJson(f, { n: 1 });
    expect(readJson(f, { n: 0 })).toEqual({ n: 1 });
    expect(existsSync(`${f}.tmp-${process.pid}`)).toBe(false);
  });

  it('文件坏了 → 备份成 .bad-* 并回退默认值（不覆盖证据、不启动失败）', () => {
    const dir = tmp();
    const f = join(dir, 'b.json');
    writeFileSync(f, '{ 这不是 JSON', 'utf8');
    expect(readJson(f, { ok: false })).toEqual({ ok: false });
    // 坏文件被改名保留（不是删掉）：原始那几个字节还在，可以被人工核查
    const backups = readdirSync(dir).filter((n) => n.startsWith('b.json.bad-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toContain('这不是 JSON');
  });

  it('审计日志只追加、不改写，读的时候最新的在前', () => {
    const dir = tmp();
    const f = join(dir, 'audit.jsonl');
    const mk = (n: number): AuditEntry => ({
      id: `e${n}`, at: `2026-11-02T00:00:0${n}.000Z`, actor: 'a@b.c', actorRole: 'admin',
      action: 'test', target: `t${n}`,
    });
    appendAudit(f, mk(1));
    appendAudit(f, mk(2));
    appendAudit(f, mk(3));
    const got = readAudit(f, 10);
    expect(got.map((x) => x.id)).toEqual(['e3', 'e2', 'e1']);
    // 原文件是 3 行 JSONL（不是被重写的数组）
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('审计日志不存在时返回空数组而不是报错', () => {
    expect(readAudit(join(tmp(), 'nope.jsonl'))).toEqual([]);
  });
});

describe('告警判定 diffScan', () => {
  const names = { E1: '结算页', E2: '搜索', E3: '护栏实验' };
  const base = (p: ScanPoint): Record<string, ScanPoint> => ({ E1: p });

  it('第一次扫描只建基线，不报警（否则一接上就一堆「新实验」）', () => {
    const out = diffScan(undefined, { E1: { decision: 'ship', p: 0.01, diff: 0.02 } }, names);
    expect(out).toEqual([]);
  });

  it('结论变化会报，且变差时是 critical', () => {
    const out = diffScan(base({ decision: 'ship', p: 0.01, diff: 0.02 }), { E1: { decision: 'no-ship', p: 0.2, diff: -0.01 } }, names);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('decision_changed');
    expect(out[0].severity).toBe('critical');
    expect(out[0].message).toContain('ship');
    expect(out[0].expName).toBe('结算页');
  });

  it('「证据不足 → 有结论」也要报（那是好消息，但同样需要人知道）', () => {
    const out = diffScan(base({ decision: 'inconclusive', p: 0.4, diff: 0.001 }), { E1: { decision: 'ship', p: 0.01, diff: 0.02 } }, names);
    expect(out.map((a) => a.kind)).toContain('decision_changed');
  });

  it('SRM 只在「通过 → 异常」时报，恢复不占告警位', () => {
    const bad = diffScan(base({ decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: true }), { E1: { decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: true } }, names);
    expect(bad).toEqual([]);
    const fix = diffScan(base({ decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: true }), { E1: { decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: false } }, names);
    expect(fix).toEqual([]);
    const out = diffScan(base({ decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: false }), { E1: { decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: true } }, names);
    expect(out.map((a) => a.kind)).toEqual(['srm']);
    expect(out[0].severity).toBe('critical');
  });

  it('护栏从「未恶化」变「恶化」报 critical；换了一个护栏恶化也报', () => {
    const out = diffScan(
      base({ decision: 'ship', p: 0.01, diff: 0.02, worseGuardrail: null }),
      { E1: { decision: 'ship', p: 0.01, diff: 0.02, worseGuardrail: '退款率' } },
      names,
    );
    expect(out.map((a) => a.kind)).toEqual(['guardrail']);
    const swap = diffScan(
      base({ decision: 'no-ship', p: 0.01, diff: 0.02, worseGuardrail: '投诉率' }),
      { E1: { decision: 'no-ship', p: 0.01, diff: 0.02, worseGuardrail: '退款率' } },
      names,
    );
    expect(swap.map((a) => a.kind)).toEqual(['guardrail']);
  });

  it('p 从 ≥0.05 变 <0.05 报 info（不显著变显著）', () => {
    const out = diffScan(base({ decision: 'inconclusive', p: 0.08, diff: 0.01 }), { E1: { decision: 'inconclusive', p: 0.03, diff: 0.01 } }, names);
    expect(out.map((a) => a.kind)).toEqual(['newly_significant']);
    expect(out[0].severity).toBe('info');
  });

  it('什么都没变就不产出告警（不做「每次都发一条」的狼来了）', () => {
    const same: ScanPoint = { decision: 'ship', p: 0.01, diff: 0.02, srmFlagged: false, worseGuardrail: null };
    expect(diffScan(base(same), { E1: same }, names)).toEqual([]);
  });

  it('告警 id 定长补零（便于按 id 排序与对账）', () => {
    expect(alertId(7)).toBe('al_000007');
  });
});
