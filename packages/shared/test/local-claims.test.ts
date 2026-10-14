// 本机领单（决定 0096）：分支固定前缀认单号；本机会话心跳里哪些单还活着（续租用）。
import { describe, expect, it } from 'vitest';
import {
  issueOfBranch,
  LOCAL_LEASE_MS,
  LocalClaimRequestSchema,
  liveLocalIssues,
  localBranchPrefix,
} from '../src/local-claims.ts';
import type { LocalSession } from '../src/web-api/local-sessions.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;

describe('issueOfBranch：分支的固定前缀', () => {
  it('fleet/<单号>- 是引擎，local/<单号>- 是本机；别的认不出', () => {
    expect(issueOfBranch('fleet/12-tabcdef12')).toEqual({ executor: 'engine', issue: 12 });
    expect(issueOfBranch(`${localBranchPrefix(34)}fix-login`)).toEqual({ executor: 'local', issue: 34 });
    for (const ref of ['rethink/a2', 'local/x-1', 'local/0-a', 'fleet/12', 'main']) {
      expect(issueOfBranch(ref)).toBeNull();
    }
  });
});

describe('LocalClaimRequestSchema', () => {
  it('【故意造出的失败】多带字段、仓名不对、结局认不出：拒收', () => {
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'renew', repo: 'a/b', issue: 1, token: 'x' }).success,
    ).toBe(false);
    expect(LocalClaimRequestSchema.safeParse({ action: 'renew', repo: 'ab', issue: 1 }).success).toBe(false);
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'finish', repo: 'a/b', issue: 1, outcome: 'gone' }).success,
    ).toBe(false);
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'claim', repo: 'a/b', issue: 1, title: 't' }).success,
    ).toBe(true);
  });
});

function session(over: Partial<LocalSession>): LocalSession {
  return {
    id: 's',
    repo: 'acme/app',
    branch: 'local/7-x',
    worktree: 'a2',
    subagent: true,
    startedAt: at(-60 * MIN),
    lastSeenAt: at(-MIN),
    last: 'tool',
    lastTool: 'Bash',
    ...over,
  };
}

function node(sessions: LocalSession[], receivedAgo = MIN) {
  return {
    receivedAt: at(-receivedAgo),
    report: {
      schemaVersion: 1 as const,
      reportedAt: at(-receivedAgo),
      machine: 'pc',
      sessions,
      problems: [],
    },
  };
}

describe('liveLocalIssues：心跳里还活着的本机单', () => {
  it('local/<单号>- 分支上、不到租约时长前动过、没收场的才算；仓要对上；引擎分支不算', () => {
    const live = liveLocalIssues(
      [
        node([
          session({ id: 'a', branch: 'local/7-x' }),
          session({ id: 'b', branch: 'local/8-x', last: 'stop', lastSeenAt: at(-30 * MIN) }),
          session({ id: 'c', branch: 'local/9-x', lastSeenAt: at(-LOCAL_LEASE_MS - MIN) }),
          session({ id: 'd', branch: 'local/10-x', last: 'end' }),
          session({ id: 'e', branch: 'fleet/11-tabcdef12' }),
          session({ id: 'f', branch: 'local/12-x', repo: 'acme/other' }),
          session({ id: 'g', branch: 'feat/x' }),
        ]),
      ],
      'ACME/app',
      NOW,
    );
    expect([...live].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('【故意造出的失败】整份推来已经超过租约时长：不拿旧心跳当活着', () => {
    expect(liveLocalIssues([node([session({})], LOCAL_LEASE_MS + MIN)], 'acme/app', NOW).size).toBe(0);
  });
});
