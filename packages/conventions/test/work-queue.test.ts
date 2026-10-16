// 本机队列（单 #2731）：pnpm work queue [--json] 列本机做的开着的单，每张写领者、心跳几分钟前、开着的 PR、挂着的引导、能不能接。
// gh、git、心跳全换成假的。可接 = 没有开着的 PR、没有 30 分钟内的心跳、没贴「要人拍」；收尾钩子（agents/hooks/queue-stop.mjs）读 --json 判挡不挡。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Git } from '../src/directives.ts';
import type { GhResult } from '../src/issue-new.ts';
import { work } from '../src/work.ts';
import {
  type BeatLite,
  buildQueue,
  LIVE_MINUTES,
  type QueueReport,
  readLocalBeats,
} from '../src/work-queue.ts';

const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
const NOW = new Date('2026-10-16T09:00:00Z');
const minsAgo = (m: number) => NOW.getTime() - m * 60_000;

const ISSUES = [
  { number: 30, title: '有 PR 在做', body: '', labels: [{ name: '本机做' }] },
  { number: 10, title: '没人接', body: '原话见引导 20261016162904', labels: [{ name: '本机做' }] },
  { number: 20, title: '工人刚动过', body: '', labels: [{ name: '本机做' }] },
  { number: 40, title: '等人拍', body: '', labels: [{ name: '本机做' }, { name: '要人拍' }] },
  { number: 50, title: '心跳早断了', body: '引导 6173370315', labels: [{ name: '本机做' }] },
];
const PULLS = [{ number: 99, body: '**需求**：Closes #30', headRefName: 'feat/x' }];
const BEATS: BeatLite[] = [
  { id: 'aaaaaaaa-1111', branch: 'local/20-fix', worktree: '20-fix', lastSeenMs: minsAgo(3) },
  { id: 'bbbbbbbb-2222', branch: 'local/50-old', worktree: '50-old', lastSeenMs: minsAgo(LIVE_MINUTES + 30) },
  { id: 'cccccccc-3333', branch: 'main', worktree: null, lastSeenMs: minsAgo(1) },
];
const PENDING_FILE = [
  '# 创始人引导 20261016162904',
  '',
  '- 状态：待处理',
  '- 时间：2026-10-16 16:29 +0800',
  '- 主：无主',
  '- 来源：手填',
  '',
  '## 原话',
  '',
  '本机你可以开任意多个subagent',
  '',
  '## 经过',
  '',
].join('\n');

function deps(o: { issues?: GhResult; beats?: () => BeatLite[]; gitFails?: boolean } = {}) {
  const gh = async (args: string[]): Promise<GhResult> => {
    if (args[0] === 'issue' && args[1] === 'list') return o.issues ?? ok(JSON.stringify(ISSUES));
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(PULLS));
    return bad(`没想到的 gh：${args.join(' ')}`);
  };
  const git: Git = async (args) => {
    if (o.gitFails) return bad('fatal: not a git repository');
    if (args[0] === 'grep') return ok('origin/main:docs/directives/2026-10/20261016162904.md\n');
    if (args[0] === 'show') return ok(PENDING_FILE);
    return bad(`没想到的 git：${args.join(' ')}`);
  };
  return { gh, git, readBeats: o.beats ?? (() => BEATS), now: () => NOW };
}

describe('buildQueue：本机做的开着的单', () => {
  it('按单号排；领者、心跳、PR、挂着的引导逐栏填；可接 = 没 PR、没活着的领者、没贴要人拍', async () => {
    const r = await buildQueue(deps());
    expect(r.problems).toEqual([]);
    const by = new Map(r.items.map((i) => [i.issue, i]));
    expect(r.items.map((i) => i.issue)).toEqual([10, 20, 30, 40, 50]);
    expect(by.get(10)).toMatchObject({
      takeable: true,
      pr: null,
      claimers: [],
      directives: ['20261016162904'],
    });
    expect(by.get(20)).toMatchObject({ takeable: false, heartbeatMinutes: 3 });
    expect(by.get(20)?.claimers).toEqual([
      { session: 'aaaaaaaa', worktree: '20-fix', branch: 'local/20-fix', minutesAgo: 3 },
    ]);
    expect(by.get(30)).toMatchObject({ takeable: false, pr: 99 });
    expect(by.get(40)).toMatchObject({ takeable: false, waitingHuman: true });
    // 心跳超过 30 分钟：领者照列，但算没人在做，可接；它写到的引导已经办完（不在待处理里），不列
    expect(by.get(50)).toMatchObject({ takeable: true, heartbeatMinutes: LIVE_MINUTES + 30, directives: [] });
  });

  it('【故意造出的失败】心跳、引导读不成：照列单，没读成的写进 problems，不当成没有', async () => {
    const r = await buildQueue(
      deps({
        beats: () => {
          throw new Error('EACCES');
        },
        gitFails: true,
      }),
    );
    expect(r.items).toHaveLength(5);
    expect(r.problems.join('\n')).toContain('心跳没读成');
    expect(r.problems.join('\n')).toContain('引导没读成');
  });

  it('【故意造出的失败】单读不成、或到了 200 张没翻全：整条抛，不当成队列空', async () => {
    await expect(buildQueue(deps({ issues: bad('HTTP 502') }))).rejects.toThrow(/没读成/);
    const many = Array.from({ length: 200 }, (_, i) => ({ number: i + 1, title: 't', body: '', labels: [] }));
    await expect(buildQueue(deps({ issues: ok(JSON.stringify(many)) }))).rejects.toThrow(/没翻全/);
  });
});

describe('pnpm work queue [--json]', () => {
  const run = async (argv: string[], d = deps()) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await work(argv, {
      gh: d.gh,
      post: async () => {
        throw new Error('queue 不该碰法国');
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      queue: { git: d.git, readBeats: d.readBeats, now: d.now },
    });
    return { code, out, err };
  };

  it('文字版：头一行写总数和可接数，一张一行带状态、领者、心跳、PR、引导', async () => {
    const r = await run(['queue']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain('5 张');
    expect(r.out[0]).toContain('可接 2 张');
    expect(r.out.find((l) => l.includes('#10 '))).toBe(
      '[可接] #10 没人接 | 领者：无 | 心跳：无 | PR：无 | 引导 20261016162904',
    );
    expect(r.out.find((l) => l.includes('#20 '))).toContain(
      '[在做] #20 工人刚动过 | 领者：aaaaaaaa（20-fix） | 心跳 3 分钟前',
    );
    expect(r.out.find((l) => l.includes('#30 '))).toContain('PR #99');
    expect(r.out.find((l) => l.includes('#40 '))).toContain('[等人拍]');
  });

  it('--json：收尾钩子读的那一份，items 和 problems 都在', async () => {
    const r = await run(['queue', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out.join('')) as QueueReport;
    expect(report.items.filter((i) => i.takeable).map((i) => i.issue)).toEqual([10, 50]);
    expect(report.problems).toEqual([]);
  });

  it('【故意造出的失败】gh 出错：退出码 1，原因在 stderr；认不出的参数也是 1', async () => {
    const r = await run(['queue'], deps({ issues: bad('could not resolve host') }));
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('could not resolve host');
    expect((await run(['queue', '--all'])).code).toBe(1);
  });
});

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readLocalBeats：本机会话心跳', () => {
  it('读会话号、分支、工作树名；最后一次动取心跳和会话记录修改时间里晚的那个；坏文件跳过；目录不在是空', () => {
    const home = mkdtempSync(join(tmpdir(), 'queue-home-'));
    made.push(home);
    expect(readLocalBeats(home, join(home, '.claude'))).toEqual([]);
    const dir = join(home, '.fleet-dao', 'local-sessions', 'sessions');
    mkdirSync(dir, { recursive: true });
    const seen = '2026-10-16T08:00:00.000Z';
    writeFileSync(
      join(dir, 's1.json'),
      JSON.stringify({ id: 's1', branch: 'local/7-x', worktree: '7-x', lastSeenAt: seen }),
    );
    writeFileSync(join(dir, 'bad.json'), '{坏的');
    const projects = join(home, '.claude', 'projects', 'D--frank-fleet-dao');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's1.jsonl'), '{}\n');
    const later = new Date('2026-10-16T08:30:00.000Z');
    utimesSync(join(projects, 's1.jsonl'), later, later);
    expect(readLocalBeats(home, join(home, '.claude'))).toEqual([
      { id: 's1', branch: 'local/7-x', worktree: '7-x', lastSeenMs: later.getTime() },
    ]);
  });
});
