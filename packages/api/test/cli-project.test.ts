// fleet-api project show / set-profile（#2738）：看、换一个仓的档案。形状不对就拒（退出码 2），库里没有这个仓退出码 1；
// 写和操作记录同一事务（db 的 setRepoProfile，真库那一面在 packages/db/test/intake.test.ts），这里用内存的假端口。
import type { RepoProfileRow } from '@fleet-dao/db';
import { DEFAULT_REPO_PROFILE } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import { ProjectCliError, type ProjectPort, parseProjectArgs } from '../src/project-cli.ts';

const T0 = new Date('2026-10-16T09:00:00.000Z');

function setup(rows: RepoProfileRow[] = [fluxwatch()]) {
  const audits: { repoId: string; profile: unknown; reason: string; actor: unknown }[] = [];
  const port: ProjectPort = {
    async find(owner, name) {
      return (
        rows.find(
          (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
        ) ?? null
      );
    },
    async setProfile(input) {
      const row = rows.find((r) => r.id === input.repoId);
      if (!row) return 'not_found';
      if (JSON.stringify(row.profile) === JSON.stringify(input.profile))
        return { changed: false, auditId: null };
      row.profile = input.profile;
      if (typeof input.profile.testCommand === 'string') row.testCommand = input.profile.testCommand;
      audits.push({ repoId: input.repoId, profile: input.profile, reason: input.reason, actor: input.actor });
      return { changed: true, auditId: audits.length };
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  let stdin = '';
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => T0,
    openStore: async () => {
      throw new Error('project 不该开 Store');
    },
    openProject: async () => ({ port, close: async () => {} }),
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    readStdin: async () => stdin,
  };
  return {
    rows,
    audits,
    out,
    err,
    files,
    setStdin: (s: string) => {
      stdin = s;
    },
    run: (args: string[]) => main(['project', ...args], deps),
  };
}

function fluxwatch(): RepoProfileRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    owner: 'thoerwink8',
    name: 'fluxwatch',
    githubId: 1418484822,
    defaultBranch: 'main',
    testCommand: 'pnpm check',
    ciPolicy: 'off',
    autoDispatchSince: null,
    profile: {},
  };
}

describe('参数', () => {
  it.each([
    [[]],
    [['show']],
    [['show', 'fluxwatch']],
    [['show', 'a/b', 'c']],
    [['list', 'a/b']],
    [['set-profile', 'a/b']],
    [['set-profile', 'a/b', '--file']],
    [['set-profile', 'a/b', '--file', 'x.json', '--force']],
    [['set-profile', 'https://github.com/a/b', '--file', 'x.json']],
  ])('认不出的写法一律拒（退出码 2），不猜：%j', (argv) => {
    expect(() => parseProjectArgs(argv)).toThrow(ProjectCliError);
    try {
      parseProjectArgs(argv);
    } catch (e) {
      expect((e as ProjectCliError).exitCode).toBe(2);
    }
  });

  it('show、set-profile 各一种写法', () => {
    expect(parseProjectArgs(['show', 'thoerwink8/fluxwatch'])).toEqual({
      action: 'show',
      owner: 'thoerwink8',
      name: 'fluxwatch',
    });
    expect(parseProjectArgs(['set-profile', 'thoerwink8/fluxwatch', '--file', '-'])).toEqual({
      action: 'set-profile',
      owner: 'thoerwink8',
      name: 'fluxwatch',
      file: '-',
    });
  });
});

describe('project show', () => {
  it('打印一份 JSON：仓号、档案原文、补了默认值的档案、缺哪几项', async () => {
    const s = setup();
    expect(await s.run(['show', 'THOERWINK8/fluxwatch'])).toBe(0);
    const shown = JSON.parse(s.out.join('\n'));
    expect(shown).toMatchObject({
      repo: 'thoerwink8/fluxwatch',
      githubId: 1418484822,
      testCommand: 'pnpm check',
      ciPolicy: 'off',
      autoDispatchSince: null,
      profile: {},
      effective: DEFAULT_REPO_PROFILE,
    });
    expect(shown.gaps).toContain('language');
  });

  it('库里没有这个仓：退出码 1，说清楚', async () => {
    const s = setup();
    expect(await s.run(['show', 'thoerwink8/nope'])).toBe(1);
    expect(s.err.join('\n')).toContain('库里没有仓 thoerwink8/nope');
  });

  it('库里的档案形状坏了：照样打印原文，effective 为 null、写明错在哪', async () => {
    const row = { ...fluxwatch(), profile: { weight: 0 } };
    const s = setup([row]);
    expect(await s.run(['show', 'thoerwink8/fluxwatch'])).toBe(0);
    const shown = JSON.parse(s.out.join('\n'));
    expect(shown.effective).toBeNull();
    expect(shown.error).toContain('weight');
  });
});

describe('project set-profile', () => {
  const good = {
    language: 'go',
    toolchain: ['go'],
    testCommand: ' go test ./... ',
    moduleRoots: ['cmd/*', 'internal/*'],
  };

  it('从文件读、整份换掉，存显式写了的项（去掉首尾空白），记操作记录，读回对得上', async () => {
    const s = setup();
    s.files.set('flux.json', JSON.stringify(good));
    expect(await s.run(['set-profile', 'thoerwink8/fluxwatch', '--file', 'flux.json'])).toBe(0);
    const stored = { ...good, testCommand: 'go test ./...' };
    expect(s.rows[0]?.profile).toEqual(stored);
    expect(s.audits).toEqual([
      {
        repoId: fluxwatch().id,
        profile: stored,
        actor: { kind: 'ops', id: 'ops:project' },
        reason: '服务器上 root 跑的 fleet-api project set-profile thoerwink8/fluxwatch',
      },
    ]);
    expect(s.out.join('\n')).toContain('已改');
  });

  it('--file - 从标准输入读（经 ssh 用）；同样的再写一遍不改', async () => {
    const s = setup();
    s.setStdin(JSON.stringify(good));
    expect(await s.run(['set-profile', 'thoerwink8/fluxwatch', '--file', '-'])).toBe(0);
    expect(await s.run(['set-profile', 'thoerwink8/fluxwatch', '--file', '-'])).toBe(0);
    expect(s.audits).toHaveLength(1);
    expect(s.out.at(-1)).toContain('没改');
  });

  it.each([
    ['不是 JSON', '{language:', '不是 JSON'],
    ['认不出的键', JSON.stringify({ mergeSignal: ['ci'] }), 'mergeSignal'],
    ['权重是 0', JSON.stringify({ weight: 0 }), 'weight'],
    ['模块根往上跳', JSON.stringify({ moduleRoots: ['../x'] }), 'moduleRoots'],
    ['不是对象', JSON.stringify(['go']), '形状不对'],
  ])('形状不对就拒（退出码 2），库不动：%s', async (_why, text, hint) => {
    const s = setup();
    s.files.set('bad.json', text);
    expect(await s.run(['set-profile', 'thoerwink8/fluxwatch', '--file', 'bad.json'])).toBe(2);
    expect(s.err.join('\n')).toContain(hint);
    expect(s.audits).toEqual([]);
    expect(s.rows[0]?.profile).toEqual({});
  });

  it('文件读不到：退出码 2；仓不在：退出码 1', async () => {
    const s = setup();
    expect(await s.run(['set-profile', 'thoerwink8/fluxwatch', '--file', 'missing.json'])).toBe(2);
    expect(s.err.join('\n')).toContain('missing.json');
    s.files.set('ok.json', '{}');
    expect(await s.run(['set-profile', 'thoerwink8/nope', '--file', 'ok.json'])).toBe(1);
    expect(s.audits).toEqual([]);
  });
});
