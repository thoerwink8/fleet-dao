// fleet-api project show / set-profile（#2738）：看、换一个仓的档案。形状不对就拒（退出码 2），库里没有这个仓退出码 1；
// 写和操作记录同一事务（db 的 setRepoProfile，真库那一面在 packages/db/test/intake.test.ts），这里用内存的假端口。
// project installations（#2977）：两个 App 装没装，只读，和导入列表同一份归并；没查成退出 1，不当成没装。
import type { RepoProfileRow } from '@fleet-dao/db';
import type { InstallationListedRepo } from '@fleet-dao/github';
import { DEFAULT_REPO_PROFILE } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import type { InstallationReposPort } from '../src/deps.ts';
import {
  INSTALLATIONS_SOURCE,
  installationFacts,
  ProjectCliError,
  type ProjectPort,
  parseProjectArgs,
} from '../src/project-cli.ts';
import { mergedInstallations } from '../src/repo-import-routes.ts';
import { attachPolicyBridge } from './ci-policy-helper.ts';
import { harness } from './harness.ts';

const T0 = new Date('2026-10-16T09:00:00.000Z');

function setup(rows: RepoProfileRow[] = [fluxwatch()]) {
  const audits: { repoId: string; profile: unknown; reason: string; actor: unknown }[] = [];
  const port: ProjectPort = {
    async register(input) {
      const byId = rows.find((r) => r.githubId === input.githubId);
      const byName = rows.find((r) => r.owner === input.owner && r.name === input.name);
      if (byId && byId !== byName)
        return { outcome: 'conflict', why: `仓号已经登记在 ${byId.owner}/${byId.name} 上` };
      if (byName?.githubId === input.githubId) return { outcome: 'unchanged', repoId: byName.id };
      if (byName) {
        byName.githubId = input.githubId;
        audits.push({ repoId: byName.id, profile: null, reason: input.reason, actor: input.actor });
        return { outcome: 'updated', repoId: byName.id, auditId: audits.length };
      }
      const id = `22222222-2222-2222-2222-22222222222${rows.length}`;
      rows.push({
        id,
        owner: input.owner,
        name: input.name,
        githubId: input.githubId,
        defaultBranch: input.defaultBranch,
        testCommand: 'pnpm check',
        ciPolicy: 'force',
        autoDispatchSince: null,
        profile: {},
      });
      audits.push({ repoId: id, profile: null, reason: input.reason, actor: input.actor });
      return { outcome: 'created', repoId: id, auditId: audits.length };
    },
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
  const refresh = vi.fn(async () => ({ public: true, heads: 2 }));
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => T0,
    openStore: async () => {
      throw new Error('project 不该开 Store');
    },
    openProject: async () => ({ port, close: async () => {} }),
    openPolicyBridge: async () => {
      const h = harness();
      const { bridge } = attachPolicyBridge(h);
      return {
        bridge: {
          ...bridge,
          refresh,
          describe: async () => ({
            version: 1,
            publisher: true,
            public: true,
            endpoint: 'https://policy.example.test/api/public/ci-policy/v1/repos/1418484822',
          }),
        },
        close: async () => {},
      };
    },
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
    refresh,
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
      ciPolicyBridge: {
        version: 1,
        public: true,
        publisher: true,
        endpoint: 'https://policy.example.test/api/public/ci-policy/v1/repos/1418484822',
      },
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

describe('project refresh-policy-source', () => {
  it('受保护管理命令强制重发事件，仅返回排重算，不宣称 gate 成功', async () => {
    const s = setup();
    expect(await s.run(['refresh-policy-source', 'thoerwink8/fluxwatch'])).toBe(0);
    expect(s.refresh).toHaveBeenCalledWith(
      { action: 'refresh-policy-source', owner: 'thoerwink8', name: 'fluxwatch' },
      true,
    );
    expect(JSON.parse(s.out.join('\n'))).toEqual({ public: true, heads: 2 });
    expect(s.audits).toEqual([]);
  });
  it('source 刷新失败退出1，不拿空 heads 或成功冒充', async () => {
    const s = setup();
    s.refresh.mockRejectedValueOnce(new Error('source unavailable'));
    expect(await s.run(['refresh-policy-source', 'thoerwink8/fluxwatch'])).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain('source unavailable');
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

describe('project register（#2749）', () => {
  it('参数：要 --github-id 正整数，--default-branch 可选（默认 main）；别的写法拒', () => {
    expect(parseProjectArgs(['register', 'acme/new', '--github-id', '42'])).toEqual({
      action: 'register',
      owner: 'acme',
      name: 'new',
      githubId: 42,
      defaultBranch: 'main',
    });
    expect(
      parseProjectArgs(['register', 'acme/new', '--github-id', '42', '--default-branch', 'trunk']),
    ).toMatchObject({ defaultBranch: 'trunk' });
    for (const argv of [
      ['register', 'acme/new'],
      ['register', 'acme/new', '--github-id', '0'],
      ['register', 'acme/new', '--github-id', 'abc'],
      ['register', 'acme/new', '--github-id', '42', '--force'],
    ])
      expect(() => parseProjectArgs(argv)).toThrow(ProjectCliError);
  });

  it('没有就建、老行补仓号、一样的不改；仓号在别的名字上（改名）退出码 1', async () => {
    const s = setup([{ ...fluxwatch(), githubId: null }]);
    expect(await s.run(['register', 'acme/new', '--github-id', '42'])).toBe(0);
    expect(s.out.at(-1)).toContain('已登记');
    expect(await s.run(['register', 'thoerwink8/fluxwatch', '--github-id', '1418484822'])).toBe(0);
    expect(s.out.at(-1)).toContain('补上了仓号');
    expect(await s.run(['register', 'thoerwink8/fluxwatch', '--github-id', '1418484822'])).toBe(0);
    expect(s.out.at(-1)).toContain('没改');
    expect(s.audits).toHaveLength(2);
    expect(await s.run(['register', 'acme/renamed', '--github-id', '42'])).toBe(1);
    expect(s.err.at(-1)).toContain('acme/new');
  });
});

describe('project installations（#2977）', () => {
  const flux: InstallationListedRepo = {
    id: 1418484822,
    owner: 'thoerwink8',
    name: 'fluxwatch',
    fullName: 'thoerwink8/fluxwatch',
    private: true,
    defaultBranch: 'main',
    ownerType: 'User',
    archived: false,
    empty: false,
  };
  const other: InstallationListedRepo = {
    ...flux,
    id: 999,
    name: 'secret-other',
    fullName: 'thoerwink8/secret-other',
  };
  const ARGS = ['installations', 'thoerwink8/fluxwatch', '--github-id', '1418484822'];

  /** 只给 list：真的那份（listInstallationRepositories）只 GET，令牌只要 metadata:read，见 github 的 installation-repos 测试。 */
  function withSource(list: InstallationReposPort['list']) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[] = [];
    const counts = { opened: 0, closed: 0 };
    const deps: CliDeps = {
      env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      now: () => T0,
      openStore: async () => {
        throw new Error('installations 不该开 Store');
      },
      openProject: async () => {
        throw new Error('installations 不该连 repos 表（登记、档案不是安装事实）');
      },
      readFile: async () => {
        throw new Error('installations 不该读文件');
      },
      openInstallationRepos: async () => {
        counts.opened += 1;
        return {
          source: {
            list: async (role) => {
              calls.push(role);
              return list(role);
            },
          },
          close: async () => {
            counts.closed += 1;
          },
        };
      },
    };
    return { out, err, calls, counts, run: (args: string[]) => main(['project', ...args], deps) };
  }

  it('参数：要 owner/仓名 和 --github-id 正整数；别的写法拒（退出码 2）', () => {
    expect(parseProjectArgs(ARGS)).toEqual({
      action: 'installations',
      owner: 'thoerwink8',
      name: 'fluxwatch',
      githubId: 1418484822,
    });
    for (const argv of [
      ['installations', 'thoerwink8/fluxwatch'],
      ['installations', 'thoerwink8/fluxwatch', '--github-id', '0'],
      ['installations', 'thoerwink8/fluxwatch', '--github-id', 'x'],
      ['installations', 'thoerwink8/fluxwatch', '--github-id', '1', '--force'],
      ['installations', 'fluxwatch', '--github-id', '1'],
    ]) {
      expect(() => parseProjectArgs(argv)).toThrow(ProjectCliError);
      try {
        parseProjectArgs(argv);
      } catch (e) {
        expect((e as ProjectCliError).exitCode).toBe(2);
      }
    }
  });

  it.each([
    ['两边都在', [flux, other], [flux], true, true],
    ['只有 agent 在', [flux, other], [other], true, false],
    ['只有 engine 在', [other], [flux], false, true],
    ['两边都不在', [other], [other], false, false],
  ] as const)('完整列表%s：退出码 0，只打目标仓的事实', async (_n, agent, engine, a, e) => {
    const s = withSource(async (role) => (role === 'agent' ? [...agent] : [...engine]));
    expect(await s.run(ARGS)).toBe(0);
    const text = s.out.join('\n');
    expect(JSON.parse(text)).toEqual({
      source: INSTALLATIONS_SOURCE,
      readAt: T0.toISOString(),
      repo: 'thoerwink8/fluxwatch',
      githubId: 1418484822,
      agentInstalled: a,
      engineInstalled: e,
      fullyInstalled: a && e,
      reason: null,
    });
    // 别的仓、令牌一样都不打
    expect(text).not.toContain('secret-other');
    expect(text).not.toMatch(/token|ghs_|PRIVATE KEY|cookie/i);
    // 两个角色各列一次（只列，端口上没有写口），用完就关
    expect([...s.calls].sort()).toEqual(['agent', 'engine']);
    expect(s.counts).toEqual({ opened: 1, closed: 1 });
  });

  it('和导入列表同一份归并：结果就是 mergedInstallations 里这个仓号那一行', async () => {
    const source: InstallationReposPort = {
      list: async (role) => (role === 'agent' ? [flux, other] : [other]),
    };
    const merged = (await mergedInstallations(source)).find((r) => r.repo.id === flux.id);
    const facts = await installationFacts(
      { owner: 'thoerwink8', name: 'fluxwatch', githubId: flux.id },
      { installations: async () => source, now: () => T0 },
    );
    expect({ agent: facts.agentInstalled, engine: facts.engineInstalled }).toEqual({
      agent: merged?.agent,
      engine: merged?.engine,
    });
  });

  it('一个角色没列成：没查成退出 1，写明来源和原因，不打半份', async () => {
    const s = withSource(async (role) => {
      if (role === 'engine') throw new Error('engine 换安装令牌 HTTP 502');
      return [flux];
    });
    expect(await s.run(ARGS)).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join('\n')).toContain(INSTALLATIONS_SOURCE);
    expect(s.err.join('\n')).toContain('engine 换安装令牌 HTTP 502');
    expect(s.counts.closed).toBe(1);
  });

  it('机器人凭据没读到：没查成退出 1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['project', ...ARGS], {
      env: { DATABASE_URL: 'postgres:///fleet' },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      now: () => T0,
      openStore: async () => {
        throw new Error('不该开');
      },
      openInstallationRepos: async () => {
        throw new Error('读不到 /etc/fleet-dao/github/agent.pem');
      },
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/没查成.*agent\.pem/);
  });

  it('仓号和名字对不上（改名、写错号）：没查成退出 1，不当成没装', async () => {
    const renamed = { ...flux, name: 'fluxwatch-old', fullName: 'thoerwink8/fluxwatch-old' };
    const s1 = withSource(async () => [renamed]);
    expect(await s1.run(ARGS)).toBe(1);
    expect(s1.err.join('\n')).toContain('身份对不上');
    const s2 = withSource(async () => [{ ...flux, id: 7 }]);
    expect(await s2.run(ARGS)).toBe(1);
    expect(s2.err.join('\n')).toContain('身份对不上');
    expect(s2.out).toEqual([]);
  });
});
