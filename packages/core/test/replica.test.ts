// 流程配置副本的边界表：对账读完往副本里写什么（没有文件用全组织默认并标出来、认不出停派、没查成副本不动），
// 派活前副本能不能用（认不出、从没同步过、太旧都停派），写码会话拿哪条测试命令（项目没写就明确失败）。
import { readFileSync } from 'node:fs';
import type { StageKind } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { Source } from '../src/config.ts';
import {
  CODE_STAGES,
  FLOW_REPLICA_MAX_AGE_MINUTES,
  type FlowRead,
  type FlowReplica,
  flowSync,
  replicaVerdict,
  sessionTestCommand,
  UNSYNCED_REPLICA,
} from '../src/replica.ts';

const ORG_TEXT = readFileSync(new URL('../flow.default.json', import.meta.url), 'utf8');
const org: Source = { kind: 'text', text: ORG_TEXT };
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NOW = new Date('2026-09-27T08:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const read = (file: Source): FlowRead => ({ kind: 'read', commit: COMMIT, file });
const text = (o: unknown): Source => ({ kind: 'text', text: JSON.stringify(o) });
const fresh: FlowReplica = { syncedAt: ago(10), error: null, unread: null, testCommand: 'pnpm test:changed' };

describe('对账读完一个仓，往副本里写什么', () => {
  it('仓里没有 .fleet/flow.json：用全组织默认、标成 org_default，测试命令是空的（全组织默认不放）', () => {
    expect(flowSync(org, read({ kind: 'missing' }))).toMatchObject({
      write: 'synced',
      source: 'org_default',
      commit: COMMIT,
      testCommand: null,
    });
  });

  it('仓里写了测试命令：副本整份换成合并后的，测试命令、读的提交跟着写', () => {
    const got = flowSync(org, read(text({ formatVersion: 1, testCommand: 'pnpm test:changed' })));
    expect(got).toMatchObject({ write: 'synced', source: 'project', commit: COMMIT });
    if (got.write !== 'synced') throw new Error(got.why);
    expect(got.testCommand).toBe('pnpm test:changed');
    expect(got.config.testCommand).toBe('pnpm test:changed');
    expect(got.config.bans.map((b) => b.id).sort()).toEqual(['gpt-no-ui', 'no-fable']);
  });

  it('仓里改了命令：下一轮写进去的就是新的', () => {
    const before = flowSync(org, read(text({ formatVersion: 1, testCommand: 'pnpm check' })));
    const after = flowSync(org, read(text({ formatVersion: 1, testCommand: 'pnpm test:changed' })));
    expect(before).toMatchObject({ write: 'synced', testCommand: 'pnpm check' });
    expect(after).toMatchObject({ write: 'synced', testCommand: 'pnpm test:changed' });
  });

  it.each<[string, Source, RegExp]>([
    ['不是 JSON', { kind: 'text', text: '{"formatVersion": 1,' }, /不是 JSON.*（提交 0123456）/],
    ['格式版本认不出', text({ formatVersion: 7 }), /格式版本 7 认不出/],
    ['测试命令是空串', text({ formatVersion: 1, testCommand: '  ' }), /testCommand/],
    ['想改禁令', text({ formatVersion: 1, bans: [] }), /禁令只能写在全组织默认里/],
    ['那个路径不是文件（目录、链接）', { kind: 'unreadable', error: '是个目录' }, /读不了（是个目录）/],
  ])('【失败】仓里的配置%s：认不出、这个项目停派，原因带上是哪个提交', (_name, file, why) => {
    const got = flowSync(org, read(file));
    expect(got).toMatchObject({ write: 'invalid', scope: 'project' });
    if (got.write === 'invalid') expect(got.why).toMatch(why);
  });

  it('【失败】GitHub 接口出错（没查成）：只记原因，不当成「没有这个文件」、不改副本里的配置', () => {
    expect(flowSync(org, { kind: 'unread', why: 'GitHub 回 502' })).toEqual({
      write: 'unread',
      why: 'GitHub 回 502',
    });
    // 没带原因也不许写成空的
    expect(flowSync(org, { kind: 'unread', why: ' ' })).toEqual({ write: 'unread', why: '没带原因' });
  });

  it('【失败】全组织默认坏了：仓里读没读成都判认不出（org），一律停派', () => {
    const broken: Source = { kind: 'text', text: '{' };
    expect(flowSync(broken, read(text({ formatVersion: 1, testCommand: 'x' })))).toMatchObject({
      write: 'invalid',
      scope: 'org',
      why: expect.stringMatching(/^全组织默认：不是 JSON/),
    });
    expect(flowSync(broken, { kind: 'unread', why: 'GitHub 回 502' })).toMatchObject({
      write: 'invalid',
      scope: 'org',
    });
  });
});

describe('派活前看副本', () => {
  it('刚同步过：能派；最近一次没查成但还在时限里：照样能派', () => {
    expect(replicaVerdict(fresh, NOW)).toEqual({ ok: true });
    expect(replicaVerdict({ ...fresh, unread: 'GitHub 回 502' }, NOW)).toEqual({ ok: true });
  });

  it('刚好 45 分钟还能派，过了就停；同步时刻在将来（钟差）不为此停派', () => {
    expect(replicaVerdict({ ...fresh, syncedAt: ago(FLOW_REPLICA_MAX_AGE_MINUTES) }, NOW)).toEqual({
      ok: true,
    });
    expect(replicaVerdict({ ...fresh, syncedAt: ago(-2) }, NOW)).toEqual({ ok: true });
  });

  it.each<[string, FlowReplica, RegExp]>([
    [
      '认不出',
      { ...fresh, error: '项目配置 .fleet/flow.json：不是 JSON' },
      /^流程配置认不出：项目配置.*改好仓里的/,
    ],
    ['从没同步过（刚加上副本这几列）', UNSYNCED_REPLICA, /还没从仓里同步过流程配置/],
    [
      '从没同步成、最近一次没查成',
      { ...UNSYNCED_REPLICA, unread: 'GitHub 回 502' },
      /还没从仓里同步过.*最近一次没查成：GitHub 回 502/,
    ],
    [
      '46 分钟没同步成',
      { ...fresh, syncedAt: ago(46), unread: 'GitHub 回 502' },
      /46 分钟没同步成（超过 45 分钟就停派.*最近一次没查成：GitHub 回 502/,
    ],
    ['同步时刻认不出', { ...fresh, syncedAt: '昨天' }, /同步时刻认不出（昨天）/],
  ])('【失败】副本%s：停派，写明原因', (_name, replica, why) => {
    const got = replicaVerdict(replica, NOW);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });
});

describe('起会话拿哪条测试命令', () => {
  it('写码阶段只有 execute、ui（和交活核对要测试证据的一样）', () => {
    expect([...CODE_STAGES].sort()).toEqual(['execute', 'ui']);
  });

  it('写码阶段拿副本里的命令；别的阶段项目没写也照样起（没有命令）', () => {
    expect(sessionTestCommand(fresh, 'execute', NOW)).toEqual({ ok: true, command: 'pnpm test:changed' });
    expect(sessionTestCommand({ ...fresh, testCommand: null }, 'triage', NOW)).toEqual({
      ok: true,
      command: null,
    });
    expect(sessionTestCommand(fresh, 'review', NOW)).toEqual({ ok: true, command: 'pnpm test:changed' });
  });

  it.each<[StageKind, string | null]>([
    ['execute', null],
    ['ui', null],
    ['execute', '   '],
  ])('【失败】项目没写测试命令（%s，命令 %j）：写码会话明确失败，不拿空串、旧值顶', (stage, command) => {
    const got = sessionTestCommand({ ...fresh, testCommand: command }, stage, NOW);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(/^项目没写测试命令：.*\.fleet\/flow\.json.*testCommand/);
  });

  it('【失败】副本本身停派：什么阶段都不起，原因照副本的说', () => {
    const got = sessionTestCommand({ ...fresh, syncedAt: ago(90) }, 'triage', NOW);
    expect(got).toEqual({ ok: false, why: expect.stringMatching(/90 分钟没同步成/) });
  });
});
