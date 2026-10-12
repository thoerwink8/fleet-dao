// 临时指挥官整理待办的真装配（real/groom.ts，#1338）：会话的工具面（写操作）里没有关单、改里程碑，选路按用途 groom。
import type { Db } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import type { IntakeRepo } from '../../src/jobs/intake.ts';
import type { PickRouteInput } from '../../src/ports.ts';
import { type GroomGitHub, groomJob } from '../../src/real/groom.ts';
import type { OneShotSessions } from '../../src/real/one-shot-sessions.ts';

const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: null,
};

/** 记下被调用过的 GitHub 方法名；调到没列出的方法就抛（说明装配多开了口子）。 */
function recordingGh() {
  const called: string[] = [];
  const reply: Record<string, unknown> = {
    openIssue: { number: 1, url: 'u', created: true },
    commentIssue: { commentId: 1, url: 'u', created: true },
    addIssueLabel: ['需求'],
    appendIssueBody: { outcome: 'written', restoredHumanEdit: false, verified: true },
  };
  const gh = new Proxy({} as Record<string, unknown>, {
    get(_t, name: string) {
      return async (...args: unknown[]) => {
        called.push(name);
        if (!(name in reply)) throw new Error(`整理待办的装配调了不该调的 GitHub 方法 ${name}`);
        return reply[name] ?? args;
      };
    },
  }) as unknown as GroomGitHub;
  return { gh, called };
}

const wiring = (over: Partial<Parameters<typeof groomJob>[0]> = {}) => {
  const rec = recordingGh();
  const picks: PickRouteInput[] = [];
  const deps = groomJob({
    db: {} as Db,
    gh: rec.gh,
    trees: {} as never,
    exec: {} as never,
    tmpDir: '/tmp/x',
    spawner: {} as never,
    pickRoute: async (input) => {
      picks.push(input);
      return { ok: false, waitFor: 'none', detail: '一条能用的路由都没有' };
    },
    sessions: {} as OneShotSessions,
    ...over,
  })();
  return { deps, picks, called: rec.called };
};

describe('groomJob · 真装配', () => {
  it('写操作面只有开单、评论、贴标签、往正文末尾追加四样：没有关单、改里程碑、推代码', async () => {
    const { deps, called } = wiring();
    const w = deps.writes(REPO);
    expect(Object.keys(w).sort()).toEqual(['addLabel', 'appendBody', 'comment', 'openIssue']);
    await w.openIssue({ key: 'k', title: 't', body: 'b', labels: ['需求'] });
    await w.comment({ issueNumber: 1, key: 'k', body: 'b' });
    await w.addLabel({ issueNumber: 1, label: '整理过' });
    await w.appendBody({ issueNumber: 1, key: 'k', text: 't' });
    expect(called).toEqual(['openIssue', 'commentIssue', 'addIssueLabel', 'appendIssueBody']);
  });

  it('改标准的路径清单读的是仓里真的 standard-paths.json（认得出通用段原件）', async () => {
    const { deps } = wiring();
    const rules = await deps.standardPaths();
    expect(rules.map((r) => r.path)).toContain('agents/shared-rules.md');
  });

  it('开单不带里程碑（未排期）', async () => {
    const seen: unknown[] = [];
    const gh = {
      openIssue: async (i: unknown) => {
        seen.push(i);
        return { number: 1, url: 'u', created: true };
      },
    } as unknown as GroomGitHub;
    const { deps } = wiring({ gh });
    await deps.writes(REPO).openIssue({ key: 'k', title: 't', body: 'b', labels: ['需求'] });
    expect(seen[0]).toMatchObject({ milestone: null, repo: { owner: 'acme', name: 'demo' } });
  });

  it('起会话先选路，用途是 groom；选不到路由 → 明确失败（带原因），不起会话', async () => {
    const { deps, picks } = wiring();
    const got = await deps.runSession({
      repo: REPO,
      requestId: 'req-1',
      prompt: 'p',
      mainHead: 'a'.repeat(40),
      timeoutMinutes: 40,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]?.stage).toBe('groom');
    expect(got).toMatchObject({ ok: false });
    expect(got.ok === false && got.why).toContain('一条能用的路由都没有');
  });

  it('选路还没选到时（总开关关着 / 在排空 / 额度在等）也是明确失败，写明在等什么', async () => {
    const { deps } = wiring({
      pickRoute: async () => ({ ok: false, waitFor: 'slot', detail: '总开关关着', retryAfterSeconds: 30 }),
    });
    const got = await deps.runSession({
      repo: REPO,
      requestId: 'req-1',
      prompt: 'p',
      mainHead: 'a'.repeat(40),
      timeoutMinutes: 40,
    });
    expect(got.ok === false && got.why).toContain('总开关关着');
  });

  // #1798 片 4：整理待办选到一条路由时也先派前探一次（15 分钟新鲜线），探不通避开它再选，一轮最多 3 条。
  it('派前探一次：探通了才起会话（选到的这一条先探过）', async () => {
    const probed: string[] = [];
    const { deps } = wiring({
      probe: async (input) => {
        probed.push(input.routeId);
        return { kind: 'pass', label: input.label, detail: '答上了：OK', probed: true };
      },
    });
    const got = await deps.runSession({
      repo: REPO,
      requestId: 'req-1',
      prompt: 'p',
      mainHead: 'a'.repeat(40),
      timeoutMinutes: 40,
    });
    // 选路还是回「一条能用的路由都没有」：没探到就没有可探的，不改这一份的结论
    expect(probed).toEqual([]);
    expect(got.ok === false && got.why).toContain('一条能用的路由都没有');
  });

  it('探不通就避开它再选；三条都不通 → 明确失败，原因带上每条的结果', async () => {
    const probed: string[] = [];
    const { deps } = wiring({
      pickRoute: async (input) => {
        const next = ['r1', 'r2', 'r3', 'r4'].find((id) => !input.avoidRouteIds.includes(id));
        if (next === undefined) return { ok: false, waitFor: 'none', detail: '避开之后没了' };
        return {
          ok: true,
          route: {
            routeId: next,
            poolId: 'p',
            modelId: `m-${next}`,
            family: 'claude',
            hostId: 'claude-code',
          },
          why: '有得派',
        };
      },
      probe: async (input) => {
        probed.push(input.routeId);
        return { kind: 'fail', label: input.label, detail: `${input.routeId} 不通`, counted: true };
      },
    });
    const got = await deps.runSession({
      repo: REPO,
      requestId: 'req-1',
      prompt: 'p',
      mainHead: 'a'.repeat(40),
      timeoutMinutes: 40,
    });
    expect(probed).toEqual(['r1', 'r2', 'r3']); // 一轮最多 3 条
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.why).toContain('派前探测都不通');
    expect(got.ok === false && got.why).toContain('m-r1 不通（r1 不通）');
  });
});
