// 命令行：参数、身份、退出码。和系统打交道的几样换成假的。
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BEGIN } from '../src/block.ts';
import { type Deps, type PasswdEntry, runCli } from '../src/cli.ts';
import {
  BLOCK,
  cleanup,
  fakeBin,
  get,
  git,
  gitify,
  IS_ROOT,
  makeRepo,
  PLATFORM,
  pushAhead,
  put,
  tempDir,
} from './helpers.ts';

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
  // 4 次 run() 各自真 spawn 一两次 git（git-excludes 那一步）：默认 5 秒在机器忙的时候不够
  it('缺失 1；写完 0；第二遍零改动；只装了 claude 的机器上其余各家列为没装', { timeout: 15_000 }, () => {
    const home = tempDir('home');
    const repo = makeRepo({});
    const first = run(['--check', '--home', home, '--repo', repo]);
    expect(first.code).toBe(1);
    expect(first.out).toContain('✗ ~/.claude/CLAUDE.md：缺失');
    expect(first.out).toContain('✗ ~/.claude/settings.json：缺失');
    expect(first.out).toContain('· ~/.codex/AGENTS.md：没装');
    expect(first.out).toContain('✗ ~/.claude/agents/Explore.md：缺失');
    const applied = run(['--apply', '--home', home, '--repo', repo]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('↻ ~/.claude/CLAUDE.md：新建');
    expect(applied.out).toContain('↻ ~/.claude/agents/Explore.md：装上了');
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
    const again = run(['--apply', '--home', home, '--repo', repo]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('↻');
    expect(again.out).toContain('结论：改动 0');
    expect(run(['--check', '--home', home, '--repo', repo]).code).toBe(0);
  });

  // 决定 0092：真实操作系统（deps.os）要一路传到权限那一步，Mac 在 platform 里也归 linux，只看 platform 判不出桌面机
  it('Mac 上 Mirasim 装了 mirasim-reclaude 启动器：写完不带子代理默认模型，报告说明为什么，退出 0', {
    timeout: 15_000,
  }, () => {
    const home = tempDir('home');
    put(
      home,
      '.mirasim/setting.json',
      JSON.stringify({ agentLaunch: { claude: { command: '/opt/mirasim-reclaude' } } }),
    );
    const r = run(['--apply', '--home', home, '--repo', makeRepo({})], { os: 'darwin' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('env.CLAUDE_CODE_SUBAGENT_MODEL 不写（决定 0092）');
    const settings = JSON.parse(get(home, '.claude/settings.json')) as { env?: Record<string, string> };
    expect(settings.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('【故意造出的失败】仓里的 agents/shared-rules.md 没有通用段标记：没查成，退出 2，一个字不写', () => {
    const home = tempDir('home');
    const repo = makeRepo({}, '# 没有标记的 shared-rules.md\n');
    const r = run(['--apply', '--home', home, '--repo', repo]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('没查成');
    expect(r.err).toContain('agents/shared-rules.md：没有通用段的标记');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('【故意造出的失败】仓里没有 agents/shared-rules.md（检出太旧，通用段还在 AGENTS.md 里）：查和写都没查成、退出 2，一个字不写', () => {
    const home = tempDir('home');
    const repo = makeRepo({}, null);
    for (const mode of ['--check', '--apply']) {
      const r = run([mode, '--home', home, '--repo', repo]);
      expect(r.code, mode).toBe(2);
      expect(r.err, mode).toContain('仓里没有 agents/shared-rules.md');
    }
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('【故意造出的失败】标记不成对：报出几个开始、几个结束，退出 2，一个字不写', () => {
    const home = tempDir('home');
    const repo = makeRepo({}, `${BEGIN}\n## 底线\n- 一条\n`);
    const r = run(['--apply', '--home', home, '--repo', repo]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('开始标记 1 个、结束标记 0 个');
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
    // 决定 0083：过程钩子不在用户级给每个仓跑。决定 0085：用户级多一个订阅加载器。
    expect(r.out).not.toContain('SessionStart：替别的用户写（--user）时不登记开会话钩子');
    const settings = JSON.parse(get(home, '.claude/settings.json')) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'PreToolUse']);
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('/.fleet-dao/hooks/pretool.mjs');
    expect(existsSync(join(home, '.fleet-dao', 'hooks', 'pretool.mjs'))).toBe(true);
    expect(existsSync(join(home, '.fleet-dao', 'hooks', 'stop.mjs'))).toBe(true);
    expect(r.code).toBe(0);
  });

  // 法国的检出停在自动发布发出去的那个提交上，落后主线是常态（等 CI、等引擎空闲）：拿主线比会让自动发布
  // 每次都误报「规矩同步没成」，所以替别的用户写时不记、不判同步位置（法国的看自动发布的读数）
  it('检出落后主线也照样退出 0、不记同步位置', { timeout: 60_000 }, () => {
    const home = aliceHome();
    const repo = makeRepo({});
    const origin = gitify(repo);
    pushAhead(origin, 'agents/new-rule.md', '# 主线上新的规矩\n');
    git(repo, 'fetch', '-q', 'origin');
    const deps = {
      platform: 'linux' as const,
      getuid: () => 0,
      lookupUser: () => ({ uid: 1001, gid: 1001, home }),
    };
    for (const mode of ['--apply', '--check']) {
      const r = run([mode, '--user', 'alice', '--repo', repo], deps);
      expect(r.out, mode).toContain('· 同步位置：替别的用户写（--user）时不记同步位置');
      expect(r.out, mode).not.toContain('✗');
      expect(r.code, mode).toBe(0);
    }
    expect(existsSync(join(home, '.fleet-dao', 'synced.json'))).toBe(false);
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

describe('仓里的原件在但读不了', () => {
  // 家里先放一份装过的 skill 和记着它的清单。仓里同名 skill 内容不同：读不了若被当成「仓里没有」，
  // --apply 会把家里这份撤掉；若读成功并往下走，会新建 ~/.claude/CLAUDE.md。
  function seeded() {
    const home = tempDir('home');
    put(home, '.claude/skills/grill-me/SKILL.md', '装过的\n');
    const manifestText = `${JSON.stringify({ skills: { '.claude/skills': ['grill-me'] } })}\n`;
    put(home, '.fleet-dao/agents-sync.json', manifestText);
    const repo = makeRepo({ 'grill-me': { 'SKILL.md': '仓里的、和家里不一样\n' } });
    return { home, repo, manifestText };
  }

  function expectStopped(home: string, repo: string, manifestText: string, why: string, absent?: string) {
    for (const mode of ['--check', '--apply']) {
      const r = run([mode, '--home', home, '--repo', repo]);
      expect(r.code, mode).toBe(2);
      expect(r.out, mode).toBe('');
      expect(r.err, mode).toContain('没查成');
      expect(r.err, mode).toContain(why);
      expect(r.err, mode).toContain('EACCES');
      if (absent !== undefined) expect(r.err, mode).not.toContain(absent);
    }
    expect(get(home, '.claude/skills/grill-me/SKILL.md')).toBe('装过的\n');
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(get(home, '.fleet-dao/agents-sync.json')).toBe(manifestText);
  }

  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    '仓里的 agents/shared-rules.md 在但读不了：查和写都没查成，一个文件都不写',
    () => {
      const { home, repo, manifestText } = seeded();
      const file = join(repo, 'agents', 'shared-rules.md');
      chmodSync(file, 0o000);
      try {
        expectStopped(home, repo, manifestText, '读不了仓里的 agents/shared-rules.md（');
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    '仓里的 agents/skills/ 在但读不了：查和写都没查成，装过的 skill 一个不撤',
    () => {
      const { home, repo, manifestText } = seeded();
      const dir = join(repo, 'agents', 'skills');
      chmodSync(dir, 0o000);
      try {
        expectStopped(home, repo, manifestText, '读不了仓里的 agents/skills/（', '没有 agents/skills/');
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    '仓里的 agents/skills/ 下有文件读不了：查和写都没查成，装过的 skill 一个不撤',
    () => {
      const { home, repo, manifestText } = seeded();
      const file = join(repo, 'agents', 'skills', 'grill-me', 'SKILL.md');
      chmodSync(file, 0o000);
      try {
        expectStopped(home, repo, manifestText, '读不了仓里的 agents/skills/ 下的文件（');
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );
});

describe('清单在但读不了', () => {
  // 两次 --apply 加一次 --check，每次都会真跑 git（全局忽略）：默认 5 秒在机器忙的时候不够
  it.skipIf(PLATFORM === 'win32' || IS_ROOT)(
    '清单文件在但读不了：不当成空清单，--apply 不撤也不新装',
    { timeout: 30_000 },
    () => {
      const bin = tempDir('bin');
      fakeBin(bin, 'claude');
      fakeBin(bin, 'codex');
      const env = { PATH: bin, PATHEXT: '.CMD' };
      const home = tempDir('home');
      const repo = makeRepo({ 'grill-me': { 'SKILL.md': '仓里的\n' } });
      const first = run(['--apply', '--home', home, '--repo', repo], { env });
      expect(first.code, first.out + first.err).toBe(0);

      rmSync(join(home, '.agents', 'skills', 'grill-me'), { recursive: true });
      put(home, '.claude/skills/chain-first/SKILL.md', '别撤我\n');
      const manifestFile = join(home, '.fleet-dao', 'agents-sync.json');
      const doc = JSON.parse(readFileSync(manifestFile, 'utf8')) as { skills: Record<string, string[]> };
      doc.skills['.claude/skills'] = [...(doc.skills['.claude/skills'] ?? []), 'chain-first'];
      const manifestText = `${JSON.stringify(doc, null, 2)}\n`;
      writeFileSync(manifestFile, manifestText);

      chmodSync(manifestFile, 0o000);
      try {
        const check = run(['--check', '--home', home, '--repo', repo], { env });
        expect(check.code, check.out).toBe(2);
        expect(check.out).toContain('没查成');
        expect(check.out).toContain('读不了（EACCES）');
        expect(check.out).not.toContain('没有 skill 可分发');

        const applied = run(['--apply', '--home', home, '--repo', repo], { env });
        expect(applied.code, applied.out).toBe(1);
        expect(applied.out).toContain('没做成');
        expect(applied.out).toContain('读不了（EACCES）');
        expect(applied.out).toContain('一个没动');
        expect(applied.out).not.toContain('装上了');
        expect(applied.out).not.toContain('撤掉了');
        expect(get(home, '.claude/skills/chain-first/SKILL.md')).toBe('别撤我\n');
        expect(existsSync(join(home, '.agents', 'skills', 'grill-me'))).toBe(false);
        expect(get(home, '.claude/skills/grill-me/SKILL.md')).toBe('仓里的\n');
      } finally {
        chmodSync(manifestFile, 0o644);
      }
      expect(readFileSync(manifestFile, 'utf8')).toBe(manifestText);
    },
  );
});

// 决定 0093：法国引擎一次性会话的用户家里装着 commander、discuss 这些通用 skill，grok、cursor 起的动手会话一启动就去读
// （近 7 天 147 段动手会话里 88 段读过，读完才开始干活）。--no-skills 给这种用户：不装，以前装的照清单撤掉。
describe('--no-skills：引擎一次性会话的用户家里不装 skill', () => {
  it('写：清单里记着的撤掉、清单清空；查判对、那一行说明为什么；不是本脚本装的不碰', {
    timeout: 30_000,
  }, () => {
    const home = tempDir('home');
    const repo = makeRepo({ commander: { 'SKILL.md': '---\nname: commander\n---\n指挥官\n' } });
    expect(run(['--apply', '--home', home, '--repo', repo]).code).toBe(0);
    expect(existsSync(join(home, '.claude/skills/commander/SKILL.md'))).toBe(true);
    put(home, '.claude/skills/mine/SKILL.md', '别人装的\n');

    const off = run(['--apply', '--no-skills', '--home', home, '--repo', repo]);
    expect(off.code).toBe(0);
    expect(existsSync(join(home, '.claude/skills/commander'))).toBe(false);
    expect(get(home, '.claude/skills/mine/SKILL.md')).toBe('别人装的\n');
    expect(get(home, '.fleet-dao/agents-sync.json')).not.toContain('commander');

    const check = run(['--check', '--no-skills', '--home', home, '--repo', repo]);
    expect(check.code).toBe(0);
    expect(check.out).toContain('不装（--no-skills）');
    // 不带 --no-skills 查：缺了仓里的 skill，判缺失（两种用户的判据各是各的）
    expect(run(['--check', '--home', home, '--repo', repo]).code).toBe(1);
  });

  it('--retire-old 带 --no-skills：退出 64', () => {
    const home = tempDir('home');
    const r = run(['--retire-old', '--old-repo', home, '--no-skills', '--home', home]);
    expect(r.code).toBe(64);
    expect(r.err).toContain('--no-skills 只给 --check、--apply 用');
  });
});
