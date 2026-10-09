// 整理待办读分片关系（#1478）：closed PR 超过 10×100、第 10 页末条仍在 30 天窗口里时，
// 真的 listMergedPulls 经 readGroomMergedPulls 喂进 runGroomRequests。journal 不记「没读到分片关系」，
// 总账分片已合、没有开着的分片时开出下一片（#1405 的开片规则）。
//
// 开单前检索（2026-10-09，https://api.github.com/search/issues ，仓 thoerwink8/fleet-dao）：
// - `is:issue is:open listMergedPulls` total_count=1，只有本单 #1478（created_at 2026-10-09T14:28:19Z）。
// - `is:issue is:open "翻了 10 页"` total_count=1，只有 #1478。
// - `is:issue is:open "没读到分片关系"` total_count=1，只有 #1478。
// - `is:issue listMergedPulls`（不限开关）total_count=1，只有 #1478。
// #1405 state=closed，closed_at=2026-10-09T03:56:09Z，closed_by=fleet-dao-engine[bot]，state_reason=completed。
// 标题「整理会话给总账单开下一片：已有分片合了、没有开着的分片就开下一片（#1400 第 2 项）」。
// 已知的模块：packages/engine/src/jobs/groom-prompt.ts、groom-plan.ts、groom.ts、packages/engine/test/groom.test.ts。
// 验收四条：提示词在已有合并分片且没有开着分片时点名开下一片；读不到时摘要写「没读到分片关系」；
// splitFrom 标题必须带「（#总账单号 第 N 片）」；对应测试。范围停在该不该开下一片。
import { generateKeyPairSync } from 'node:crypto';
import { type AppCredentials, createGitHub, memoryLedger } from '@fleet-dao/github';
import { GROOM_ACTION, type GroomAuditRow, type GroomResult } from '@fleet-dao/shared';
import { githubWhitelist } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import {
  GROOM_CLOSED_DAYS,
  type GroomFacts,
  type GroomNotice,
  type GroomRunDeps,
  runGroomRequests,
} from '../src/jobs/groom.ts';
import type { IntakeIssue, IntakeRepo } from '../src/jobs/intake.ts';
import { readGroomMergedPulls } from '../src/real/groom.ts';

const API = 'https://api.github.test';
const NOW = new Date('2026-10-09T13:08:34.000Z');
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: '2026-10-01T00:00:00.000Z',
};
const SLUG = `${REPO.owner}/${REPO.name}`;
const PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'write',
  metadata: 'read',
};

const FULL_BODY = [
  '## 场景',
  '',
  '要在驾驶舱看到状态。',
  '',
  '## 原话',
  '',
  '「我要看到状态」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」',
  '',
].join('\n');

interface ClosedPull {
  number: number;
  updated_at: string;
  merged: boolean;
  title: string;
  body: string;
}

describe('整理待办 · closed PR 超过 10 页仍在窗口内', () => {
  it('满 10 页且末条仍新于 since：journal 不出现没读到分片关系，分片已合且无开着分片就开下一片', async () => {
    const since = new Date(NOW.getTime() - GROOM_CLOSED_DAYS * 24 * 60 * 60_000);
    const newest = Date.parse('2026-10-09T12:00:00.000Z');
    const pads: ClosedPull[] = [];
    for (let i = 0; i < 1000; i += 1) {
      pads.push({
        number: i + 1,
        updated_at: new Date(newest - i * 60_000).toISOString(),
        merged: false,
        title: `关掉的 ${i + 1}`,
        body: '',
      });
    }
    const shard: ClosedPull = {
      number: 2001,
      updated_at: new Date(newest - 1000 * 60_000).toISOString(),
      merged: true,
      title: 'design 决定表（#139 第 1 片）',
      body: '**需求**：Refs #139\n',
    };
    const older: ClosedPull = {
      number: 2002,
      updated_at: '2026-08-01T00:00:00.000Z',
      merged: true,
      title: '更早的一片',
      body: '**需求**：Refs #1\n',
    };
    const closed = [...pads, shard, older].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const pages: { number: number; updated_at: string }[][] = [];
    const { gh } = githubOf(closed, pages);

    const ledger: IntakeIssue = {
      number: 139,
      title: 'design 拆分（总账）',
      body: FULL_BODY,
      author: { login: 'frank', id: 1, type: 'User' },
      createdAt: '2026-09-20T00:00:00.000Z',
      labels: ['需求'],
      milestone: null,
    };
    const facts: GroomFacts = {
      issues: [ledger],
      openMilestones: [],
      closed: [],
      pulls: [],
      stoppedTasks: [],
      mainHead: 'b'.repeat(40),
    };
    const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const notices: GroomNotice[] = [];
    const prompts: string[] = [];
    const dones: { ok: boolean; result?: GroomResult; error?: string }[] = [];
    const opened: { title: string; body: string }[] = [];
    const deps: GroomRunDeps = {
      rows: async () => [
        {
          at: new Date(NOW.getTime() - 60_000),
          action: GROOM_ACTION.request,
          actorId: 'x',
          after: { requestId: 'req-1', repo: SLUG, source: 'cli' },
          ok: true,
          error: null,
        } satisfies GroomAuditRow,
      ],
      engineMaster: async () => ({ on: true }),
      recordStart: async () => undefined,
      recordDone: async (i) => {
        dones.push({
          ok: i.ok,
          ...(i.result ? { result: i.result } : {}),
          ...('error' in i ? { error: i.error } : {}),
        });
      },
      findRepo: async () => REPO,
      whitelist: async () =>
        githubWhitelist([
          {
            id: 'u1',
            displayName: '创始人',
            role: 'founder',
            active: true,
            githubId: 1,
            githubLogin: 'frank',
          },
        ]),
      readFacts: async () => facts,
      readMergedPulls: (repo) => readGroomMergedPulls(gh.claims, { owner: repo.owner, name: repo.name }, NOW),
      standardPaths: async () => [{ path: 'agents/**/*.md', why: 'x' }],
      runSession: async (input) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          answer: `\`\`\`json\n${JSON.stringify({
            summary: '开下一片',
            newIssues: [
              {
                title: '统一导出报表格式（#139 第 2 片）',
                kind: '需求',
                scene: '导出报表还是各写各的',
                done: ['页面上多出「导出」'],
                splitFrom: 139,
              },
            ],
          })}\n\`\`\``,
        };
      },
      writes: () => ({
        openIssue: async (i) => {
          opened.push({ title: i.title, body: i.body });
          return { number: 1500, url: 'https://x/1500', created: true };
        },
        comment: async () => ({ created: true }),
        addLabel: async () => undefined,
        appendBody: async () => ({ outcome: 'written' as const }),
      }),
      notify: async (n) => {
        notices.push(n);
      },
      now: () => NOW,
      log: (level, message, fields) => {
        logs.push({ level, message, ...(fields === undefined ? {} : { fields }) });
      },
    };

    expect(await runGroomRequests(deps)).toBe(1);

    expect(pages).toHaveLength(11);
    const page10Last = pages[9]?.at(-1);
    expect(page10Last).toBeDefined();
    expect(Date.parse(page10Last?.updated_at ?? '')).toBeGreaterThan(since.getTime());
    expect(pages[9]).toHaveLength(100);
    expect(pages[10]?.map((p) => p.number)).toContain(shard.number);

    const journal = JSON.stringify(logs);
    expect(logs.some((l) => l.message === '整理待办：接手')).toBe(true);
    expect(journal).not.toContain('没读到分片关系');
    expect(journal).not.toContain('翻了 10 页还没翻完');

    expect(dones[0]?.ok).toBe(true);
    expect(dones[0]?.result?.summary).toBe('开下一片');
    expect(dones[0]?.result?.summary ?? '').not.toContain('没读到分片关系');
    expect(dones[0]?.result?.opened).toEqual([
      { number: 1500, title: '统一导出报表格式（#139 第 2 片）', splitFrom: 139 },
    ]);
    expect(dones[0]?.result?.rejected ?? []).toEqual([]);
    expect(opened).toHaveLength(1);

    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('开出下一片');
    expect(prompt).toContain(`#${shard.number}`);
    expect(prompt).toContain('Refs #139');
    expect(prompt).not.toContain('没读到分片关系');
    expect(notices[0]?.body ?? '').not.toContain('没读到分片关系');
    expect(notices[0]?.body ?? '').toContain('#1500');
  });
});

function githubOf(closed: readonly ClosedPull[], pages: { number: number; updated_at: string }[][]) {
  let keys: Record<'agent' | 'engine', AppCredentials['privateKey']> | undefined;
  const apps = (): Record<'agent' | 'engine', AppCredentials> => {
    keys ??= {
      agent: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
      engine: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    };
    return {
      agent: { role: 'agent', appId: 101, slug: 'fleet-test-agent', privateKey: keys.agent, source: 'test' },
      engine: {
        role: 'engine',
        appId: 202,
        slug: 'fleet-test-engine',
        privateKey: keys.engine,
        source: 'test',
      },
    };
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/repos/${SLUG}/installation`) {
      return json(200, { id: 22, permissions: PERMISSIONS });
    }
    if (url.pathname === '/app/installations/22/access_tokens') {
      return json(201, {
        token: 'ghs_testengine1xxxxxxxxxxxxxxxx',
        expires_at: '2099-01-01T00:00:00.000Z',
        permissions: PERMISSIONS,
      });
    }
    if (url.pathname === `/repos/${SLUG}/pulls`) {
      const per = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const start = (page - 1) * per;
      const slice = closed.slice(start, start + per);
      pages.push(slice.map((p) => ({ number: p.number, updated_at: p.updated_at })));
      const headers: Record<string, string> = {};
      if (start + per < closed.length) {
        const next = new URL(url);
        next.searchParams.set('per_page', String(per));
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return json(
        200,
        slice.map((p) => ({
          number: p.number,
          node_id: `PR_${p.number}`,
          html_url: `https://github.test/${SLUG}/pull/${p.number}`,
          state: 'closed',
          title: p.title,
          body: p.body,
          draft: false,
          merged: p.merged,
          merged_at: p.merged ? p.updated_at : null,
          user: { login: 'frank', id: 1, type: 'User' },
          head: { ref: `fix/${p.number}`, sha: 'a'.repeat(40), repo: { full_name: SLUG } },
          base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: SLUG } },
          updated_at: p.updated_at,
          auto_merge: null,
        })),
        headers,
      );
    }
    return json(404, { message: `假 GitHub 里没有 ${url.pathname}` });
  };
  const gh = createGitHub({
    ledger: memoryLedger(),
    apps: apps(),
    apiUrl: API,
    fetch: fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    env: {},
    hygieneRepo: { owner: REPO.owner, name: REPO.name },
  });
  return { gh };
}
