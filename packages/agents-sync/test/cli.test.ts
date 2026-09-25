// 命令行：参数、身份、退出码。和系统打交道的几样换成假的。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Deps, type PasswdEntry, runCli } from '../src/cli.ts';
import { BLOCK, cleanup, fakeBin, get, IS_ROOT, makeRepo, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

interface Run {
  code: number;
  out: string;
  err: string;
  became: { name: string; entry: PasswdEntry }[];
}

function run(argv: string[], over: Partial<Deps> = {}): Run {
  let out = '';
  let err = '';
  const became: Run['became'] = [];
  const bin = tempDir('bin');
  fakeBin(bin, 'claude');
  const deps: Deps = {
    platform: PLATFORM,
    env: { PATH: bin, PATHEXT: '.CMD' },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    now: () => new Date('2026-09-25T08:00:00Z'),
    homedir: () => {
      throw new Error('测试里不许落到真家目录');
    },
    defaultRepo: makeRepo({}),
    getuid: () => 1000,
    lookupUser: () => undefined,
    becomeUser: (name, entry) => {
      became.push({ name, entry });
    },
    ...over,
  };
  const code = runCli(argv, deps);
  return { code, out, err, became };
}

describe('用法', () => {
  it('不挑模式、挑两个、认不出的参数、--retire-old 不带 --old-repo：退出 64，说清为什么', () => {
    const home = tempDir('home');
    expect(run(['--home', home]).code).toBe(64);
    expect(run(['--check', '--apply', '--home', home]).code).toBe(64);
    expect(run(['--check', '--frobnicate', '--home', home]).err).toContain('认不出的参数：--frobnicate');
    const r = run(['--retire-old', '--home', home]);
    expect(r.code).toBe(64);
    expect(r.err).toContain('--retire-old 要带 --old-repo');
    expect(run(['--check', '--home']).err).toContain('--home 后面要跟一个值');
  });

  it('--help：退出 0，打印用法', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('agents-sync --check');
  });
});

describe('退出码', () => {
  it('缺失 1；写完 0；第二遍零改动；只装了 claude 的机器上其余各家列为没装', () => {
    const home = tempDir('home');
    const repo = makeRepo({});
    const first = run(['--check', '--home', home, '--repo', repo]);
    expect(first.code).toBe(1);
    expect(first.out).toContain('✗ ~/.claude/CLAUDE.md：缺失');
    expect(first.out).toContain('· ~/.codex/AGENTS.md：没装');
    const applied = run(['--apply', '--home', home, '--repo', repo]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('↻ ~/.claude/CLAUDE.md：新建');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
    const again = run(['--apply', '--home', home, '--repo', repo]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('↻');
    expect(again.out).toContain('结论：改动 0');
    expect(run(['--check', '--home', home, '--repo', repo]).code).toBe(0);
  });

  it('仓里的 AGENTS.md 没有通用段：没查成，退出 2，一个字不写', () => {
    const home = tempDir('home');
    const repo = makeRepo({}, '# 没有标记的 AGENTS.md\n');
    const r = run(['--apply', '--home', home, '--repo', repo]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('没查成');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('仓里没有 agents/skills/（检出不全）：查和写都没查成、退出 2，装过的 skill 一个不撤', () => {
    const home = tempDir('home');
    put(home, '.claude/skills/grill-me/SKILL.md', '装过的\n');
    put(home, '.fleet-dao/agents-sync.json', JSON.stringify({ skills: { '.claude/skills': ['grill-me'] } }));
    for (const mode of ['--check', '--apply']) {
      const r = run([mode, '--home', home, '--repo', makeRepo(null)]);
      expect(r.code, mode).toBe(2);
      expect(r.err, mode).toContain('没有 agents/skills/');
    }
    expect(get(home, '.claude/skills/grill-me/SKILL.md')).toBe('装过的\n');
  });

  it('家目录不在：没查成，退出 2', () => {
    const r = run(['--check', '--home', join(tempDir('x'), '没有这个目录'), '--repo', makeRepo({})]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('家目录');
  });

  it('--old-repo 写成相对路径：退出 64', () => {
    expect(run(['--retire-old', '--old-repo', 'windsurf-dao', '--home', tempDir('home')]).code).toBe(64);
  });

  it('--retire-old 没东西可撤：退出 0', () => {
    const r = run(['--retire-old', '--old-repo', tempDir('old'), '--home', tempDir('home')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('没有要撤的');
  });
});

describe('--user：替别的用户写', () => {
  // 假装在 Linux 上：PATH 按 : 分，Windows 上跑测试时盘符会被拆开，所以假的 claude 放进那个用户家里的 .local/bin
  const aliceHome = (): string => {
    const home = tempDir('alice');
    fakeBin(join(home, '.local', 'bin'), 'claude');
    return home;
  };

  it('Windows 上不支持：退出 64', () => {
    const r = run(['--check', '--user', 'alice'], { platform: 'win32' });
    expect(r.code).toBe(64);
    expect(r.became).toEqual([]);
  });

  it('不是 root：退出 64，不换身份', () => {
    const home = tempDir('alice');
    const r = run(['--apply', '--user', 'alice'], {
      platform: 'linux',
      getuid: () => 1000,
      lookupUser: () => ({ uid: 1001, gid: 1001, home }),
    });
    expect(r.code).toBe(64);
    expect(r.err).toContain('要 root');
    expect(r.became).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('没有这个用户：退出 64', () => {
    expect(run(['--check', '--user', 'nobody-here'], { platform: 'linux', getuid: () => 0 }).code).toBe(64);
  });

  it('root：先换成那个用户，再写那个用户的家（家目录取自 passwd）', () => {
    const home = aliceHome();
    const entry = { uid: 1001, gid: 1002, home };
    const r = run(['--apply', '--user', 'alice'], {
      platform: 'linux',
      getuid: () => 0,
      lookupUser: () => entry,
    });
    expect(r.became).toEqual([{ name: 'alice', entry }]);
    expect(r.out).toContain('用户 alice');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
  });

  it('本来就是那个用户：不用换身份', () => {
    const home = aliceHome();
    const r = run(['--check', '--user', 'alice'], {
      platform: 'linux',
      getuid: () => 1001,
      lookupUser: () => ({ uid: 1001, gid: 1001, home }),
    });
    expect(r.became).toEqual([]);
    expect(r.code).toBe(1);
  });

  it('换身份失败：没查成，退出 2，一个字不写', () => {
    const home = tempDir('alice');
    const r = run(['--apply', '--user', 'alice'], {
      platform: 'linux',
      getuid: () => 0,
      lookupUser: () => ({ uid: 1001, gid: 1001, home }),
      becomeUser: () => {
        throw new Error('EPERM');
      },
    });
    expect(r.code).toBe(2);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  // 临时目录归跑测试的用户，假装自己是 root 去写它（真以 root 跑测试时临时目录归 root，造不出这个样本）
  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    'root 不带 --user 往别人的家里写：退出 64（会留下 root 属主的文件）',
    () => {
      const home = tempDir('someone');
      const r = run(['--apply', '--home', home], { platform: 'linux', getuid: () => 0 });
      expect(r.code).toBe(64);
      expect(r.err).toContain('加 --user');
      expect(existsSync(join(home, '.claude'))).toBe(false);
    },
  );
});
