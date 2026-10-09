// 整理会话看得见验收停下的任务（#1400 第 5 项后半，#1465）。
// 任务表读失败记没查成，不把空数组当成没有停下的。故意造出的失败放最后。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '@fleet-dao/db';
import { GROOM_ACTION, type GroomAuditRow } from '@fleet-dao/shared';
import { githubWhitelist } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import {
  type GroomFacts,
  type GroomNotice,
  type GroomRunDeps,
  type ParkedTaskRow,
  readStoppedTasks,
  runGroomRequests,
} from '../src/jobs/groom.ts';
import { renderGroomPrompt } from '../src/jobs/groom-prompt.ts';
import type { IntakeIssue, IntakeRepo } from '../src/jobs/intake.ts';
import { groomJob } from '../src/real/groom.ts';
import {
  VERIFY_STOP_OTHER,
  VERIFY_STOP_OUT_OF_SCOPE,
  VERIFY_STOP_UNPROVABLE,
} from '../src/workflows/task-support.ts';

const NOW = new Date('2026-10-09T08:00:00.000Z');
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: '2026-10-01T00:00:00.000Z',
};
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const promptBase = {
  repo: 'acme/demo',
  issues: [] as IntakeIssue[],
  autoDispatchSince: '2026-10-01T00:00:00.000Z',
  alreadyGroomed: new Set<number>(),
  recentClosed: [] as { number: number; title: string }[],
  openPulls: [] as { number: number; title: string }[],
  mergedPulls: [] as { number: number; title: string; refs: number[] }[],
  mainHead: 'a'.repeat(40),
  now: NOW,
};

function parked(
  issue: number,
  over: Partial<ParkedTaskRow> & { category?: string; reason?: string } = {},
): ParkedTaskRow {
  const category = over.category;
  const body =
    over.alertBodies ??
    (category === undefined ? [] : [`${category}${over.reason === undefined ? '' : `\n${over.reason}`}`]);
  return {
    issue,
    state: over.state ?? 'stalled',
    doing: over.doing === undefined ? '停下等人：验收 2 轮都没过' : over.doing,
    alertBodies: body,
  };
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...tsFiles(path));
    else if (ent.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('整理提示词 · 验收停下', () => {
  it('有停下任务时，提示词含单号、类别、原话，并写明 amend 只能追加、补不出报 needsHuman', () => {
    const prompt = renderGroomPrompt({
      ...promptBase,
      stoppedTasks: [
        {
          issue: 1431,
          category: VERIFY_STOP_UNPROVABLE,
          reason: '页面上要能看到「已导出」这条在 diff 里无法证明',
        },
      ],
    });
    expect(prompt).toContain('## 验收停下的任务');
    expect(prompt).toContain(`#1431 ${VERIFY_STOP_UNPROVABLE}`);
    expect(prompt).toContain('原话：页面上要能看到「已导出」这条在 diff 里无法证明');
    expect(prompt).toContain('用 amend 补充');
    expect(prompt).toContain('只能追加，不能改原验收条');
    expect(prompt).toContain('diff 里看得见的替代验收条');
    expect(prompt).toContain('needsHuman');
  });

  it('类别字符串只在 task-support.ts 定义，整理提示词引用那一份', () => {
    const hits = tsFiles(SRC).filter((path) => {
      const text = readFileSync(path, 'utf8');
      return text.includes(VERIFY_STOP_UNPROVABLE) || text.includes(VERIFY_STOP_OUT_OF_SCOPE);
    });
    expect(hits).toEqual([join(SRC, 'workflows/task-support.ts')]);
    const promptSrc = readFileSync(join(SRC, 'jobs/groom-prompt.ts'), 'utf8');
    expect(promptSrc).toContain('GROOM_VERIFY_STOP_CATEGORIES');
  });

  it('读到了、没有这类停下的：是空数组，提示词不写没查成', async () => {
    const got = await readStoppedTasks(async () => []);
    expect(got).toEqual([]);
    const prompt = renderGroomPrompt({ ...promptBase, stoppedTasks: got });
    expect(prompt).toContain('没有要补验收条的停下任务');
    expect(prompt).not.toContain('没查成');
  });

  it('其它类别不进这一节；没在停下等人、当前原因不是这两类的也不进', async () => {
    const rows: ParkedTaskRow[] = [
      parked(1432, { category: VERIFY_STOP_OUT_OF_SCOPE, reason: '动了范围外的 packages/other.ts' }),
      parked(1431, { category: VERIFY_STOP_UNPROVABLE, reason: 'UNPROVABLE-1431' }),
      parked(1500, { category: VERIFY_STOP_OTHER, reason: '这条无法证明，但类别是其它 OTHER-1500' }),
      parked(1501, { state: 'running', category: VERIFY_STOP_UNPROVABLE, reason: 'RUNNING-1501' }),
      parked(1502, { doing: '验收第 1 轮', category: VERIFY_STOP_UNPROVABLE, reason: 'DOING-1502' }),
      parked(1503, {
        alertBodies: [
          `${VERIFY_STOP_OTHER}\n现在这次是其它 NEWER-1503`,
          `${VERIFY_STOP_UNPROVABLE}\n更早的 OLDER-1503`,
        ],
      }),
      parked(1504, { alertBodies: [] }),
      parked(1505, { alertBodies: ['这条无法证明，但第一行不是类别 UNCLASSIFIED-1505'] }),
    ];
    const got = await readStoppedTasks(async () => rows);
    expect(got?.map((row) => row.issue)).toEqual([1431, 1432]);
    const prompt = renderGroomPrompt({ ...promptBase, stoppedTasks: got });
    expect(prompt).toContain(`#1431 ${VERIFY_STOP_UNPROVABLE}`);
    expect(prompt).toContain('原话：UNPROVABLE-1431');
    expect(prompt).toContain(`#1432 ${VERIFY_STOP_OUT_OF_SCOPE}`);
    expect(prompt).toContain('原话：动了范围外的 packages/other.ts');
    for (const number of [1500, 1501, 1502, 1503, 1504, 1505]) {
      expect(prompt).not.toContain(`#${number}`);
    }
    expect(prompt).not.toContain('OTHER-1500');
    expect(prompt).not.toContain('NEWER-1503');
    expect(prompt).not.toContain('OLDER-1503');
    expect(prompt).not.toContain('UNCLASSIFIED-1505');
    expect(prompt).not.toContain(VERIFY_STOP_OTHER);
  });
});

describe('整理这一轮 · 任务表没读成', () => {
  it('读任务表失败：整理照常跑，摘要和提示词记没查成，不当成没有停下的', async () => {
    const prompts: string[] = [];
    const notices: GroomNotice[] = [];
    const dones: { ok: boolean; summary?: string }[] = [];
    const facts: GroomFacts = {
      issues: [],
      openMilestones: [],
      closed: [],
      pulls: [],
      stoppedTasks: null,
      mainHead: 'b'.repeat(40),
    };
    const row: GroomAuditRow = {
      at: new Date(NOW.getTime() - 60_000),
      action: GROOM_ACTION.request,
      actorId: 'x',
      after: { requestId: 'req-1', repo: 'acme/demo', source: 'cli' },
      ok: true,
      error: null,
    };
    const deps: GroomRunDeps = {
      rows: async () => [row],
      engineMaster: async () => ({ on: true }),
      recordStart: async () => undefined,
      recordDone: async (input) => {
        dones.push({ ok: input.ok, ...(input.result ? { summary: input.result.summary } : {}) });
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
      readMergedPulls: async () => [],
      standardPaths: async () => [],
      runSession: async (input) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          answer: '```json\n{"summary":"没补","reviews":[],"amendments":[],"newIssues":[]}\n```',
        };
      },
      writes: () => ({
        openIssue: async () => ({ number: 1, url: 'u', created: true }),
        comment: async () => ({ created: true }),
        addLabel: async () => undefined,
        appendBody: async () => ({ outcome: 'written' }),
      }),
      notify: async (notice) => {
        notices.push(notice);
      },
      now: () => NOW,
      log: () => undefined,
    };
    expect(await runGroomRequests(deps)).toBe(1);
    expect(dones[0]?.ok).toBe(true);
    expect(dones[0]?.summary).toContain('没查成');
    expect(dones[0]?.summary).toContain('任务表没读成');
    expect(dones[0]?.summary).not.toContain('没有要补验收条的停下任务');
    expect(prompts[0]).toContain('没查成');
    expect(prompts[0]).toContain('这一轮不要按这一节补验收条');
    expect(prompts[0]).not.toContain('没有要补验收条的停下任务');
    expect(notices[0]?.body).toContain('没查成');
  });

  it('【故意造出的失败】任务表读取抛错：不会把空数组当成没有停下的', async () => {
    const got = await readStoppedTasks(async () => {
      throw new Error('任务表读不了');
    });
    expect(got).toBeNull();
    expect(got).not.toEqual([]);
    const prompt = renderGroomPrompt({ ...promptBase, stoppedTasks: got });
    expect(prompt).toContain('没查成');
    expect(prompt).not.toContain('没有要补验收条的停下任务');

    const db = {
      select() {
        throw new Error('任务表读不了');
      },
    } as unknown as Db;
    const deps = groomJob({
      db,
      gh: {
        readGroomFacts: async () => ({
          milestones: [],
          issues: [
            {
              number: 7,
              title: '还开着',
              body: '正文',
              author: 'frank',
              authorId: 1,
              authorType: 'User',
              authorIsBot: false,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
              labels: ['需求'],
              milestone: null,
            },
          ],
        }),
        listClosedIssues: async () => [],
        claims: { openPulls: async () => [] },
        fetchMainline: async () => ({ head: 'c'.repeat(40), defaultBranch: 'main' }),
      } as unknown as Parameters<typeof groomJob>[0]['gh'],
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/groom-stopped',
      spawner: {} as never,
      pickRoute: async () => ({ ok: false, waitFor: 'none', detail: '用不上' }),
      sessions: {} as never,
      log: () => undefined,
    })();
    const facts = await deps.readFacts(REPO);
    expect(facts.issues.map((issue) => issue.number)).toEqual([7]);
    expect(facts.stoppedTasks).toBeNull();
    expect(facts.stoppedTasks).not.toEqual([]);
  });
});
