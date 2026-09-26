// 会话断了接着干的方式（decideContinuation，#212）：每个分支一条，先后就是判断的先后。起会话、交给插头的那一段在
// sessions.test.ts 里用真库、假插头各走一遍。
import { describe, expect, it } from 'vitest';
import { type ContinuationFacts, decideContinuation } from '../../src/real/sessions.ts';

const REAL = 'e06fc62e-72a6-4020-9144-01155dbba6db';
const DIR = '/var/lib/fleet-work/o/r/12-login';
const PRIOR = {
  runAsUser: 'fleet-agent-carpool',
  routeId: 'cursor:cursor-auto:cursor-agent',
  worktreePath: DIR,
  contextTokens: null,
};

function facts(over: Partial<ContinuationFacts> = {}): ContinuationFacts {
  return {
    resumeId: REAL,
    prior: PRIOR,
    before: { hostId: 'cursor-agent', poolId: 'cursor' },
    route: { poolId: 'cursor' },
    driver: { hostId: 'cursor-agent', canFork: false },
    user: 'fleet-agent-carpool',
    dir: DIR,
    forkMax: 100_000,
    ...over,
  };
}
const claude = { hostId: 'claude-code' as const, canFork: true };
const claudeBefore = { hostId: 'claude-code', poolId: 'claude-solo' };

describe('续得上：--resume', () => {
  it('同池、同会话用户、同执行方式、同一个目录、真号', () => {
    expect(decideContinuation(facts())).toEqual({ mode: 'resume', why: '' });
    expect(
      decideContinuation(facts({ driver: claude, before: claudeBefore, route: { poolId: 'claude-solo' } })),
    ).toEqual({ mode: 'resume', why: '' });
  });
});

describe('续不上：接力（开新会话带接力任务书），why 写清为什么', () => {
  const relay = (over: Partial<ContinuationFacts>, words: string) => {
    const got = decideContinuation(facts(over));
    expect(got.mode).toBe('relay');
    expect(got.why).toContain(words);
  };

  it('上一轮的记录查不到', () => relay({ prior: null }, '记录查不到'));

  it('上一轮跑在别的（已停用的）会话用户下；没记会话用户的也一样', () => {
    relay({ prior: { ...PRIOR, runAsUser: 'fleet-agent-dedicated' } }, '不是现在的会话用户');
    relay({ prior: { ...PRIOR, runAsUser: null } }, '没记');
  });

  it('上一轮的路由已不在：不知道它是哪种执行方式、哪个账号池', () => relay({ before: null }, '已不在'));

  it('换了执行方式（Claude 的号拿到 cursor 上、cursor 的号拿到 Claude 上）', () => {
    relay({ before: claudeBefore }, '换了执行方式');
    relay({ driver: claude, route: { poolId: 'claude-solo' } }, '换了执行方式');
  });

  it('续的号不是 UUID（cursor 报出真号之前就断了，工作流手里只有临时号）', () =>
    relay({ resumeId: `cursor-pending:${REAL}` }, '不是执行体自己的会话号'));

  it('换了目录（会话记录按目录存）；上一轮没记目录的也一样', () => {
    relay({ dir: '/var/lib/fleet-work/o/r/elsewhere' }, '换了目录续不上');
    relay({ prior: { ...PRIOR, worktreePath: null } }, '没记的目录');
  });

  it('cursor 换了账号池：没有 fork', () =>
    relay({ route: { poolId: 'cursor-b' } }, '换了账号池（cursor → cursor-b），Cursor Agent 不能 fork'));

  it('Claude 换了账号池、上一轮上下文不知道多大或大了：不 fork', () => {
    const moved = { driver: claude, before: claudeBefore, route: { poolId: 'claude-carpool' } };
    relay(moved, '上下文大小不知道');
    relay({ ...moved, prior: { ...PRIOR, contextTokens: 200_000 } }, '大了不 fork');
    relay({ ...moved, prior: { ...PRIOR, contextTokens: 100_000 } }, '大了不 fork');
  });

  it('先后：换了执行方式又是临时号，报的是换了执行方式（先判的那个）', () =>
    relay({ before: claudeBefore, resumeId: `cursor-pending:${REAL}` }, '换了执行方式'));
});

describe('fork：只有 Claude，只换了池、上一轮上下文还小', () => {
  it('上下文比上限小', () => {
    const got = decideContinuation(
      facts({
        driver: claude,
        before: claudeBefore,
        route: { poolId: 'claude-carpool' },
        prior: { ...PRIOR, contextTokens: 5_000 },
      }),
    );
    expect(got).toEqual({ mode: 'fork', why: '' });
  });
});
