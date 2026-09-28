// 执行方式的驱动（#212、#266）：会话用户怎么定、cursor-agent 的起法（会话用户自己读 API 密钥、现找版本目录）、grok 的起法
// （会话用户先看它在不在）、三家驱动拼的参数、报告整理成的同一个形状（读不到的不记成 0）。起法的 sh 都真跑（本机的 sh、假的
// cursor-agent / grok 脚本），每条失败路径都故意造一次；看属主、权限的那几条只在 Linux 上跑（Windows 的 Git Bash 在 NTFS 上
// 表示不了 600）。
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GrokRunSpec, judgeRun, runGrok, type SessionUser } from '@fleet-dao/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURSOR_KEY_BAD,
  CURSOR_KEY_EXIT,
  CURSOR_KEY_STAGE_LENGTH,
  CURSOR_MISSING,
  CURSOR_PENDING_PREFIX,
  cursorLaunchCommand,
  DEFAULT_CURSOR_API_KEY_FILE,
  DEFAULT_CURSOR_VERSIONS_DIR,
  DEFAULT_GROK_BIN,
  GROK_MISSING,
  grokLaunchCommand,
  grokReport,
  type HostRunners,
  type HostRunSpec,
  hostDrivers,
  MIRASIM_AGENT_BY_MODEL,
  MIRASIM_PENDING_PREFIX,
  mirasimAgentFor,
  sessionUserOf,
  WIRED_HOSTS,
  wiredHostNames,
} from '../../src/real/hosts.ts';
import { agentCommands, realPortsConfigFromEnv } from '../../src/real/index.ts';
import { runChild } from '../child.ts';
import {
  CURSOR_NO_LOGIN,
  CURSOR_SESSION,
  type FakeCursorScript,
  type FakeGrokScript,
  type FakeMirasimScript,
  fakeCursorRun,
  fakeGrokRun,
  fakeMirasimDeps,
  fakeMirasimRun,
  fakeRun,
  GROK_NOT_SIGNED_IN,
  grokAnswered,
  grokRefused,
} from './fixtures.ts';

describe('会话用户怎么定', () => {
  const claude = { userFrom: 'pool' as const };
  const cursor = { userFrom: 'sole' as const };

  it('池上定了、是现在的会话用户：照池（两家都是）', () => {
    expect(sessionUserOf(claude, 'fleet-agent-carpool')).toEqual({ user: 'fleet-agent-carpool' });
    expect(sessionUserOf(cursor, 'fleet-agent-carpool')).toEqual({ user: 'fleet-agent-carpool' });
  });

  it('池上定的不是现在的会话用户（已停用的）：报缺什么，不瞎挑一个', () => {
    const who = sessionUserOf(claude, 'fleet-agent-dedicated');
    expect(who).toEqual({ missing: expect.stringContaining('不是现在的会话用户') });
  });

  it('Claude 的池没定会话用户：报没定（它绑着 reclaude 组织，猜不得）', () => {
    expect(sessionUserOf(claude, null)).toEqual({ missing: expect.stringContaining('没定会话用户') });
  });

  it('cursor 的池不绑：用唯一的会话用户', () => {
    expect(sessionUserOf(cursor, null)).toEqual({ user: 'fleet-agent-carpool' });
  });

  it('cursor 的池不绑、会话用户却不止一个或一个都没有：报缺什么，不瞎挑一个', () => {
    const two = ['fleet-agent-carpool', 'fleet-agent-other'] as unknown as SessionUser[];
    expect(sessionUserOf(cursor, null, two)).toEqual({ missing: expect.stringContaining('不止一个') });
    expect(sessionUserOf(cursor, null, [])).toEqual({ missing: expect.stringContaining('不知道以谁起') });
  });
});

describe('接上的执行方式', () => {
  it('Claude Code、cursor-agent、grok 和 mirasim；报错里的说法跟着这张表', () => {
    expect([...WIRED_HOSTS]).toEqual(['claude-code', 'cursor-agent', 'grok', 'mirasim']);
    expect(wiredHostNames()).toBe('Claude Code、Cursor Agent、Grok 命令行、Mirasim');
  });
});

// ---- cursor-agent 的起法：会话用户自己现找版本目录

const SH = process.platform === 'win32' ? 'sh' : '/bin/sh';
const posix = (p: string) => p.replaceAll('\\', '/');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-hosts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 假的 cursor-agent：能跑的先报自己是哪一个，再一行一个报参数；不能跑的（没有执行权限）不该被挑中。 */
function agent(dir: string, label: string, runnable = true) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cursor-agent');
  writeFileSync(
    file,
    runnable ? `#!/bin/sh\necho "${label}"\nfor a in "$@"; do echo "[$a]"; done\n` : `echo "${label}"\n`,
  );
  chmodSync(file, runnable ? 0o755 : 0o644);
}

const HOME_VERSIONS = '/home/u/.local/share/cursor-agent/versions';
const HOME_KEY = '/home/u/.cursor/fleet-api-key';

/** 照 cursorLaunchCommand 的后一段（找 cursor-agent）真跑一次（版本目录换成这次造的；Windows 上用 Git 的 sh）。 */
function launch(versionsDir: string, args: string[] = []) {
  const [sh, flag, script, name, dir, ...rest] = cursorLaunchCommand(HOME_VERSIONS, HOME_KEY).slice(
    CURSOR_KEY_STAGE_LENGTH,
  );
  expect([sh, flag, name, dir, rest]).toEqual(['/bin/sh', '-c', 'cursor-agent', HOME_VERSIONS, []]);
  const r = runChild(SH, [flag as string, script as string, name as string, posix(versionsDir), ...args]);
  return { status: r.status, lines: r.stdout.trim().split('\n'), stderr: r.stderr.trim() };
}

// 下面两组同步起 sh：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 ../child.ts 开头）。
describe('cursorLaunchCommand：会话用户按 current → 最新版本目录现找（CU-03：升级会删掉旧版本目录）', {
  timeout: 0,
}, () => {
  it('有 current 就用 current', () => {
    const v = join(root, 'versions');
    agent(join(v, 'current'), 'current');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['current'] });
  });

  it('没有 current：按版本号挑最新的（月、日不补零也排得对）', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.9.5-aaa1111'), 'aaa');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['ccc'] });
  });

  it('最新的那个目录里的 cursor-agent 不能跑：跳过，用下一个', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc', false);
    expect(launch(v)).toMatchObject({ status: 0, lines: ['bbb'] });
  });

  it('不是版本号的名字（安装时下载的 UUID 临时包、latest 这类）不认，哪怕按版本号排它更「新」', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '80975bde-8b97-4c7b-bdcb-00741e363c13'), 'uuid');
    agent(join(v, 'latest'), 'latest');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['bbb'] });
  });

  it('插头的参数原样交给 cursor-agent（带空格、引号的也不拆）', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    // Windows 上 Node 把参数拼成一行交给 Git 的 sh，单引号会被它当成引号吃掉（生产在 Linux 上直接传 argv，没有这一层）
    const quoted = process.platform === 'win32' ? [] : ["it's"];
    const r = launch(v, ['-p', '--output-format', 'stream-json', 'a b', ...quoted, '--model', 'auto']);
    expect(r).toMatchObject({ status: 0 });
    expect(r.lines).toEqual([
      'bbb',
      '[-p]',
      '[--output-format]',
      '[stream-json]',
      '[a b]',
      ...quoted.map((q) => `[${q}]`),
      '[--model]',
      '[auto]',
    ]);
  });

  it('版本目录是空的、不存在、里面都不能跑：退出 127，stderr 写清没装（失败分流认成执行方式配置不对）', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const broken = join(root, 'broken');
    agent(join(broken, '2026.09.23-bbb2222'), 'bbb', false);
    for (const dir of [empty, join(root, 'nowhere'), broken]) {
      const r = launch(dir);
      expect(r.status).toBe(127);
      expect(r.stderr).toContain(CURSOR_MISSING);
      expect(r.stderr).toContain('没装 cursor-agent');
      expect(r.stderr).toContain(posix(dir));
    }
  });

  it('版本目录、密钥文件要写绝对路径、不带控制字符；命令行里没有换行这类控制字符（要经 sudo 记日志）', () => {
    expect(() => cursorLaunchCommand('home/u/versions', HOME_KEY)).toThrow('版本目录要写绝对路径');
    expect(() => cursorLaunchCommand(HOME_VERSIONS, '.cursor/fleet-api-key')).toThrow('密钥文件要写绝对路径');
    expect(() => cursorLaunchCommand(HOME_VERSIONS, '/home/u/key\n')).toThrow('控制字符');
    expect(() => cursorLaunchCommand('/home/u/v\r', HOME_KEY)).toThrow('控制字符');
    for (const arg of cursorLaunchCommand(HOME_VERSIONS, HOME_KEY)) {
      expect([...arg].every((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\u007f')).toBe(true);
    }
  });

  it('本机配置：默认在会话用户家里找，{user} 换成会话用户；密钥文件不做成配置，固定在会话用户家里；写了相对路径就起不来（一次列全）', () => {
    const env = { FLEET_MACHINE_NAME: '法国', DATABASE_URL: 'postgres:///fleet' };
    const config = realPortsConfigFromEnv(env);
    expect(config.cursorVersionsDir).toBe(DEFAULT_CURSOR_VERSIONS_DIR);
    expect(agentCommands(config).cursorCommand('fleet-agent-carpool')).toEqual(
      cursorLaunchCommand(
        '/home/fleet-agent-carpool/.local/share/cursor-agent/versions',
        '/home/fleet-agent-carpool/.cursor/fleet-api-key',
      ),
    );
    const custom = realPortsConfigFromEnv({
      ...env,
      FLEET_CURSOR_VERSIONS_DIR: '/opt/{user}/cursor/versions',
    });
    expect(agentCommands(custom).cursorCommand('fleet-agent-carpool').at(-1)).toBe(
      '/opt/fleet-agent-carpool/cursor/versions',
    );
    expect(() => realPortsConfigFromEnv({ ...env, FLEET_CURSOR_VERSIONS_DIR: 'versions' })).toThrow(
      'FLEET_CURSOR_VERSIONS_DIR 要写绝对路径',
    );
  });
});

// ---- cursor-agent 的起法，前一段：会话用户自己读家里的 API 密钥、放进环境（值不上命令行、不打出来）

const onPosix = process.platform !== 'win32';
/** 属主那一条要一个不归跑测试的人的文件：root 跑测试时找不到（root 什么都归它），跳过。 */
const asRoot = process.getuid?.() === 0;

/** 在这次的临时家里放一个密钥文件：content 为 null 就不放；给了 mode 再改权限。 */
function putKey(content: string | null, mode = 0o600): string {
  const file = join(root, 'home', '.cursor', 'fleet-api-key');
  mkdirSync(dirname(file), { recursive: true });
  if (content !== null) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return file;
}

/** 后面接的命令（顶替找 cursor-agent 的那段）：环境里的 CURSOR_API_KEY 和文件里的对不对得上只报一个词，参数一行一个。 */
const REPORT_KEY =
  'if ! printenv CURSOR_API_KEY >/dev/null; then echo NO_KEY; elif [ "$CURSOR_API_KEY" = "$(cat "$1")" ]; then echo KEY_OK; else echo KEY_MISMATCH; fi; shift; for a in "$@"; do echo "[$a]"; done';

/** 照 cursorLaunchCommand 的前一段真跑一次：读 keyFile，放进环境，再 exec 后面的 REPORT_KEY。 */
function keyStage(keyFile: string) {
  const [sh, flag, script, name, file, ...rest] = cursorLaunchCommand(HOME_VERSIONS, HOME_KEY);
  expect([sh, flag, name, file, rest[0], rest[3]]).toEqual([
    '/bin/sh',
    '-c',
    'cursor-key',
    HOME_KEY,
    '/bin/sh',
    'cursor-agent',
  ]);
  const next = [SH, '-c', REPORT_KEY, 'next', posix(keyFile), '-p', '--model', 'auto'];
  const r = runChild(SH, [flag as string, script as string, name as string, posix(keyFile), ...next]);
  return { status: r.status, stdout: r.stdout, lines: r.stdout.trim().split('\n'), stderr: r.stderr.trim() };
}

// 同步起 sh：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 ../child.ts 开头）。
describe('cursorLaunchCommand 的前一段：会话用户自己读家里的 API 密钥，放进环境再起 cursor-agent', {
  timeout: 0,
}, () => {
  /** 没放好：退出 78，stderr 头一句写哪里不对、再写文件和照哪一节放；后面的命令一次都没起。 */
  const refused = (r: ReturnType<typeof keyStage>, file: string, why: string) => {
    expect(r.status).toBe(CURSOR_KEY_EXIT);
    expect(r.stderr).toBe(
      `${CURSOR_KEY_BAD}：${why}。文件是 ${posix(file)}，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」放好`,
    );
    expect(r.stdout).toBe('');
  };

  it('不在：不起，报不在（不去试浏览器登录、不空着跑）', () => {
    const file = putKey(null);
    refused(keyStage(file), file, '不在');
  });

  it('是空的：不起，报是空的', () => {
    const file = putKey('');
    refused(keyStage(file), file, '是空的');
  });

  it('是个目录：不起，报不是普通文件', () => {
    const file = putKey(null);
    mkdirSync(file);
    refused(keyStage(file), file, '不是普通文件');
  });

  it.skipIf(!onPosix)(
    '放好了（属自己、600、一行）：后面的命令拿到的就是文件里那一把，参数原样交过去；哪里都不打值',
    () => {
      const key = `fake-cursor-key-${randomBytes(24).toString('hex')}`;
      const file = putKey(key);
      const r = keyStage(file);
      expect(r).toMatchObject({ status: 0, stderr: '', lines: ['KEY_OK', '[-p]', '[--model]', '[auto]'] });
      expect(`${r.stdout}${r.stderr}`).not.toContain(key);
      expect(cursorLaunchCommand(HOME_VERSIONS, file).join(' ')).not.toContain(key);
    },
  );

  it.skipIf(!onPosix)('末尾多一个换行（echo 写进去的）：照收，放进环境的不带换行', () => {
    const file = putKey('fake-cursor-key-abc\n');
    expect(keyStage(file)).toMatchObject({ status: 0, lines: ['KEY_OK', '[-p]', '[--model]', '[auto]'] });
  });

  it.skipIf(!onPosix)('权限太松（644）、不是 600（400）：不起，报权限', () => {
    for (const [mode, text] of [
      [0o644, '644'],
      [0o400, '400'],
    ] as const) {
      const file = putKey('fake-cursor-key-abc', mode);
      refused(keyStage(file), file, `权限是 ${text}，要 600`);
    }
  });

  it.skipIf(!onPosix || asRoot)(
    '属主不对（别人的文件，这里拿 root 的 /etc/passwd）：不起，报属主和该是谁',
    () => {
      const me = process.getuid?.();
      refused(keyStage('/etc/passwd'), '/etc/passwd', `属主不对：是 uid 0，要是会话用户自己的 uid ${me}`);
    },
  );

  it.skipIf(!onPosix)('是符号链接（哪怕指着一把放好了的）：不起，只认真文件', () => {
    const real = putKey('fake-cursor-key-abc');
    const link = join(root, 'home', 'link-key');
    symlinkSync(real, link);
    refused(keyStage(link), link, '是符号链接，只认真文件');
  });

  it.skipIf(!onPosix)('只有一个换行：不起，报没有密钥', () => {
    const file = putKey('\n');
    refused(keyStage(file), file, '只有换行，没有密钥');
  });

  it.skipIf(!onPosix)(
    '末尾多了空行、两行各带换行、只有几个换行：不起，报有几个换行（$(cat) 会把末尾的换行全去掉，不数就放过去了）',
    () => {
      for (const [content, n] of [
        ['fake-cursor-key-abc\n\n', 2],
        ['fake-cursor-key-a\nfake-cursor-key-b\n', 2],
        ['fake-cursor-key-abc\n\n\n', 3],
        ['\n\n', 2],
      ] as const) {
        const file = putKey(content);
        refused(keyStage(file), file, `有 ${n} 个换行，只该是一行密钥、末尾最多一个换行`);
      }
    },
  );

  it.skipIf(!onPosix)(
    '里面有空格、两行、Windows 的回车、控制字符：不起（交给 Cursor 只会报「密钥无效」，人会白换一把）',
    () => {
      for (const content of [
        'fake cursor key',
        'fake-cursor-key-a\nfake-cursor-key-b',
        'fake-cursor-key-abc\r\n',
        'fake-cursor-key-\u0001abc',
      ]) {
        const file = putKey(content);
        refused(keyStage(file), file, '里面有空白、换行或控制字符，只该是一行密钥、不带换行');
      }
    },
  );

  it.skipIf(!onPosix)(
    '两段接起来真跑：先读密钥再找 cursor-agent，cursor-agent 拿到密钥和插头的参数；密钥没放好就不去找',
    () => {
      const key = `fake-cursor-key-${randomBytes(24).toString('hex')}`;
      const file = putKey(key);
      const v = join(root, 'versions');
      const agentDir = join(v, '2026.09.26-aaa1111');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'cursor-agent'),
        `#!/bin/sh\nif [ "$CURSOR_API_KEY" = "$(cat '${file}')" ]; then echo KEY_OK; else echo KEY_MISMATCH; fi\nfor a in "$@"; do echo "[$a]"; done\n`,
      );
      chmodSync(join(agentDir, 'cursor-agent'), 0o755);
      const [bin, ...args] = cursorLaunchCommand(v, file);
      const ok = runChild(bin as string, [...args, '-p', '--trust']);
      expect(ok.status).toBe(0);
      expect(ok.stdout.trim().split('\n')).toEqual(['KEY_OK', '[-p]', '[--trust]']);
      expect(`${ok.stdout}${ok.stderr}`).not.toContain(key);

      // 密钥放好了、cursor-agent 没装：照旧报没装（127）
      const [bin2, ...args2] = cursorLaunchCommand(join(root, 'nowhere'), file);
      const missing = runChild(bin2 as string, args2);
      expect(missing.status).toBe(127);
      expect(missing.stderr).toContain(CURSOR_MISSING);

      // 密钥没放好：先报密钥（78），不去找 cursor-agent
      chmodSync(file, 0o644);
      const [bin3, ...args3] = cursorLaunchCommand(v, file);
      const bad = runChild(bin3 as string, args3);
      expect(bad.status).toBe(CURSOR_KEY_EXIT);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain(`${CURSOR_KEY_BAD}：权限是 644，要 600`);
    },
  );

  it('密钥文件的位置和装机脚本、放密钥的命令认的一样（deploy/lib/cursor-key.sh 的 CURSOR_API_KEY_FILE）', () => {
    const lib = fileURLToPath(new URL('../../../../deploy/lib/cursor-key.sh', import.meta.url));
    const line = readFileSync(lib, 'utf8').match(/^CURSOR_API_KEY_FILE='([^']*)'$/m);
    expect(line?.[1]).toBe(DEFAULT_CURSOR_API_KEY_FILE);
  });
});

// ---- 装机脚本装、查 cursor-agent 时照的是同一个找法（france.sh 以会话用户跑 deploy/lib/cursor-agent-version.sh）

const DEPLOY_PROBE = fileURLToPath(
  new URL('../../../../deploy/lib/cursor-agent-version.sh', import.meta.url),
);
const FRANCE_SH = fileURLToPath(new URL('../../../../deploy/france.sh', import.meta.url));

/** 照装机脚本那样真跑一次：先打一行挑中的路径，再 exec 它 --version。 */
function deployProbe(versionsDir: string) {
  const r = runChild(SH, [posix(DEPLOY_PROBE), posix(versionsDir)]);
  return { status: r.status, lines: r.stdout.trim().split('\n'), stdout: r.stdout, stderr: r.stderr };
}

describe('装机脚本找 cursor-agent 和引擎起它挑的是同一个（改了一边另一边跟着改）', { timeout: 0 }, () => {
  const layouts: Record<string, (v: string) => void> = {
    '有 current': (v) => {
      agent(join(v, 'current'), 'current');
      agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    },
    '没有 current：按版本号挑最新的': (v) => {
      agent(join(v, '2026.9.5-aaa1111'), 'aaa');
      agent(join(v, '2026.09.23-bbb2222'), 'bbb');
      agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    },
    最新的不能跑: (v) => {
      agent(join(v, '2026.09.23-bbb2222'), 'bbb');
      agent(join(v, '2026.10.1-ccc3333'), 'ccc', false);
    },
    'current 不能跑': (v) => {
      agent(join(v, 'current'), 'current', false);
      agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    },
    '不是版本号的名字、安装时的临时目录': (v) => {
      agent(join(v, '2026.09.23-bbb2222'), 'bbb');
      agent(join(v, '80975bde-8b97-4c7b-bdcb-00741e363c13'), 'uuid');
      agent(join(v, 'latest'), 'latest');
      agent(join(v, '.tmp-2026.10.2-ddd4444-1790000000'), 'tmp');
    },
  };

  for (const [name, make] of Object.entries(layouts)) {
    it(`${name}：两边挑中同一个，交给它的都是 --version`, () => {
      const v = join(root, 'versions');
      make(v);
      const engine = launch(v, ['--version']);
      const deploy = deployProbe(v);
      expect(engine.status).toBe(0);
      expect(deploy.status).toBe(0);
      expect(deploy.lines.slice(1)).toEqual(engine.lines);
      expect(deploy.lines[0]?.startsWith(`${posix(v)}/`)).toBe(true);
      expect(deploy.lines[0]?.endsWith('/cursor-agent')).toBe(true);
    });
  }

  it('一个能跑的都没有：两边都退出 127；装机那边什么都不打（它凭这个认「没装」，才去装）', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const broken = join(root, 'broken');
    agent(join(broken, '2026.09.23-bbb2222'), 'bbb', false);
    for (const dir of [empty, join(root, 'nowhere'), broken]) {
      expect(launch(dir).status).toBe(127);
      expect(deployProbe(dir)).toMatchObject({ status: 127, stdout: '', stderr: '' });
    }
  });

  it('找的版本目录和引擎默认的一样（france.sh 的 CURSOR_VERSIONS_DIR）', () => {
    const line = readFileSync(FRANCE_SH, 'utf8').match(/^CURSOR_VERSIONS_DIR='([^']*)'$/m);
    expect(line?.[1]).toBe(DEFAULT_CURSOR_VERSIONS_DIR);
  });
});

// ---- grok 的起法：会话用户先看自己家里的 grok 在不在、能不能跑，在就 exec 成它

const HOME_GROK = '/home/u/.grok/bin/grok';

/** 假的 grok：能跑的先报自己是哪一个，再一行一个报参数；不能跑的（没有执行权限）不该被起。 */
function grokBin(file: string, label: string, runnable = true) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    runnable ? `#!/bin/sh\necho "${label}"\nfor a in "$@"; do echo "[$a]"; done\n` : `echo "${label}"\n`,
  );
  chmodSync(file, runnable ? 0o755 : 0o644);
}

/** 照 grokLaunchCommand 真跑一次（位置换成这次造的；Windows 上用 Git 的 sh）。 */
function grokLaunch(bin: string, args: string[] = []) {
  const [sh, flag, script, name, path, ...rest] = grokLaunchCommand(HOME_GROK);
  expect([sh, flag, name, path, rest]).toEqual(['/bin/sh', '-c', 'grok', HOME_GROK, []]);
  const r = runChild(SH, [flag as string, script as string, name as string, posix(bin), ...args]);
  return { status: r.status, lines: r.stdout.trim().split('\n'), stdout: r.stdout, stderr: r.stderr.trim() };
}

// 同步起 sh：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 ../child.ts 开头）。
describe('grokLaunchCommand：会话用户先看自己家里的 grok 在不在、能不能跑，在就 exec 成它', {
  timeout: 0,
}, () => {
  it('在、能跑：exec 成它，插头的参数原样交过去（带空格的也不拆）', () => {
    const bin = join(root, 'home', '.grok', 'bin', 'grok');
    grokBin(bin, 'grok');
    const r = grokLaunch(bin, ['--prompt-file', '/dev/stdin', '-m', 'grok-4.7', '--cwd', '/w/a b']);
    expect(r).toMatchObject({ status: 0, stderr: '' });
    expect(r.lines).toEqual([
      'grok',
      '[--prompt-file]',
      '[/dev/stdin]',
      '[-m]',
      '[grok-4.7]',
      '[--cwd]',
      '[/w/a b]',
    ]);
  });

  it('不在、不能跑、是个目录：退出 127，stderr 写清没装、在哪（失败分流认成执行方式配置不对），一样都没起', () => {
    const missing = join(root, 'nowhere', 'grok');
    const broken = join(root, 'broken', 'grok');
    grokBin(broken, 'broken', false);
    const dir = join(root, 'dir', 'grok');
    mkdirSync(dir, { recursive: true });
    for (const bin of [missing, broken, dir]) {
      const r = grokLaunch(bin, ['--version']);
      expect(r.status).toBe(127);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe(
        `${GROK_MISSING}：${posix(bin)} 不在或不能跑（会话用户家里没装 grok 命令行，docs/ops.md 第五节「会话用户的 grok」）`,
      );
    }
  });

  it('位置要写绝对路径、不带控制字符；命令行里没有换行这类控制字符（要经 sudo 记日志）', () => {
    expect(() => grokLaunchCommand('.grok/bin/grok')).toThrow('grok 的位置要写绝对路径');
    expect(() => grokLaunchCommand('/home/u/grok\n')).toThrow('控制字符');
    for (const arg of grokLaunchCommand(HOME_GROK)) {
      expect([...arg].every((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\u007f')).toBe(true);
    }
  });

  it('本机配置：默认在会话用户家里（官方安装脚本装的位置，{user} 换成会话用户）；能改；写了相对路径就起不来', () => {
    const env = { FLEET_MACHINE_NAME: '法国', DATABASE_URL: 'postgres:///fleet' };
    const config = realPortsConfigFromEnv(env);
    expect(config.grokBin).toBe(DEFAULT_GROK_BIN);
    expect(agentCommands(config).grokCommand('fleet-agent-carpool')).toEqual(
      grokLaunchCommand('/home/fleet-agent-carpool/.grok/bin/grok'),
    );
    const custom = realPortsConfigFromEnv({ ...env, FLEET_GROK_BIN: '/opt/{user}/grok' });
    expect(agentCommands(custom).grokCommand('fleet-agent-carpool').at(-1)).toBe(
      '/opt/fleet-agent-carpool/grok',
    );
    expect(() => realPortsConfigFromEnv({ ...env, FLEET_GROK_BIN: 'grok' })).toThrow(
      'FLEET_GROK_BIN 要写绝对路径',
    );
  });

  it('位置和装机脚本装、查的一样（deploy/lib/grok.sh 的 GROK_BIN）', () => {
    const lib = fileURLToPath(new URL('../../../../deploy/lib/grok.sh', import.meta.url));
    const line = readFileSync(lib, 'utf8').match(/^GROK_BIN='([^']*)'$/m);
    expect(line?.[1]).toBe(DEFAULT_GROK_BIN);
  });
});

// 真插头（runGrok）接真起法（grokLaunchCommand）：提示词经插头垫的 cat 进真管道，再经起法 exec 到 grok；没装就退出 127、
// 判没有终帧。不经帮手（不进 scope），只验这两层接得上。Windows 上起不了 /bin/sh。
describe.skipIf(!onPosix)('grok 的真插头接真起法', () => {
  /** 假 grok：记下 stdin 是不是真管道、读到的提示词、参数；照 streaming-json 回 OK，终帧回 -s / -r 给的号和 <模型>-build。 */
  function grokRig() {
    const bin = join(root, 'home', '.grok', 'bin', 'grok');
    const log = join(root, 'grok.log');
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ -p /dev/stdin ]; then kind=fifo; else kind=not-a-pipe; fi',
        'prompt=$(cat)',
        `{ echo "$kind"; printf '%s\\n' "$prompt"; for a in "$@"; do printf '[%s]\\n' "$a"; done; } >'${log}'`,
        'sid=; model=',
        'while [ $# -gt 0 ]; do case $1 in -s|-r) sid=$2; shift ;; -m) model=$2; shift ;; esac; shift; done',
        `printf '%s\\n' '{"type":"text","data":"O"}' '{"type":"text","data":"K"}'`,
        `printf '{"type":"end","stopReason":"end_turn","sessionId":"%s","usage":{"input_tokens":3,"output_tokens":1},"num_turns":1,"modelUsage":{"%s-build":{"inputTokens":3,"outputTokens":1}}}\\n' "$sid" "$model"`,
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { bin, log: () => readFileSync(log, 'utf8').trim().split('\n') };
  }
  const grokSpec = (session: GrokRunSpec['session']): GrokRunSpec => ({
    runId: randomUUID(),
    cwd: root,
    prompt: '只回 OK',
    model: 'grok-4.7',
    session,
    alwaysApprove: false,
    env: { base: { PATH: '/usr/bin:/bin' }, fleetApi: '', fleetToken: '' },
  });

  it('开新会话、续会话：提示词经真管道到了 grok，参数原样到了；终帧回的号和实际模型核得上，判正常结束、回答 OK', async () => {
    const rig = grokRig();
    const id = randomUUID();
    for (const session of [
      { mode: 'new', id },
      { mode: 'resume', id },
    ] as const) {
      const report = grokReport(await runGrok(grokSpec(session), { command: grokLaunchCommand(rig.bin) }));
      expect(report).toMatchObject({ sessionId: id, actualModel: 'grok-4.7-build', answer: 'OK' });
      expect(judgeRun(report.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
      const [kind, prompt, ...args] = rig.log();
      expect([kind, prompt]).toEqual(['fifo', '只回 OK']);
      expect(args).toEqual(
        [
          '--prompt-file',
          '/dev/stdin',
          '--output-format',
          'streaming-json',
          '-m',
          'grok-4.7',
          '--cwd',
          root,
          session.mode === 'new' ? '-s' : '-r',
          id,
        ].map((a) => `[${a}]`),
      );
    }
  });

  it('会话用户家里没装：起法退出 127，没有终帧，原因写没装、在哪（失败分流认成执行方式配置不对）', async () => {
    const bin = join(root, 'nowhere', '.grok', 'bin', 'grok');
    const report = grokReport(
      await runGrok(grokSpec({ mode: 'new', id: randomUUID() }), { command: grokLaunchCommand(bin) }),
    );
    expect(report.facts.exitCode).toBe(127);
    const verdict = judgeRun(report.facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'no_result' });
    expect(verdict.detail).toContain(`${GROK_MISSING}：${bin} 不在或不能跑`);
    expect(report.rawError).toContain('会话用户家里没装 grok 命令行');
  });
});

// ---- 两家驱动：拼的参数、整理成的同一个形状

function spec(over: Partial<HostRunSpec> = {}): HostRunSpec {
  const runId = randomUUID();
  return {
    runId,
    user: 'fleet-agent-carpool',
    cwd: '/var/lib/fleet-work/o/r/12-login',
    prompt: '只回 OK',
    env: { base: {}, fleetApi: '', fleetToken: '' },
    limits: {},
    testCommands: [],
    cgroup: {
      id: runId,
      user: 'fleet-agent-carpool',
      limits: { memoryHigh: '1024M', memoryMax: '1536M', memorySwapMax: '0' },
    },
    model: 'auto',
    session: { mode: 'new', id: 'ignored' },
    purpose: 'work',
    ...over,
  };
}

function drivers(run: HostRunners) {
  return hostDrivers({
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    run,
  });
}

describe('cursor-agent 的驱动', () => {
  const cursorWith = (script: FakeCursorScript) => {
    const fake = fakeCursorRun(() => script);
    return { fake, driver: drivers({ 'cursor-agent': fake.run })['cursor-agent'] };
  };

  it('开新会话先回临时号（一眼看得出不是 UUID），真号由 init 帧报上来', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-edit-commit' });
    const fresh = driver.newSessionId('run-1');
    expect(fresh).toEqual({ id: `${CURSOR_PENDING_PREFIX}run-1`, known: false });
    const ids: string[] = [];
    const report = await driver.run(spec(), { onSessionId: (id) => ids.push(id) });
    expect(ids).toEqual([CURSOR_SESSION]);
    expect(report.sessionId).toBe(CURSOR_SESSION);
    // cursor 自己起号：插头拿到的新会话不带我们的号
    expect(fake.specs[0]?.session).toEqual({ mode: 'new' });
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/cursor-agent']);
  });

  it('干活的会话放开命令（--force），探针不放；续会话照原号 --resume', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-resume' });
    await driver.run(spec({ purpose: 'work', session: { mode: 'resume', id: CURSOR_SESSION } }), {});
    await driver.run(spec({ purpose: 'probe' }), {});
    expect(fake.specs[0]).toMatchObject({ force: true, session: { mode: 'resume', id: CURSOR_SESSION } });
    expect(fake.specs[1]).toMatchObject({ force: false, session: { mode: 'new' } });
  });

  it('要 fork：拒（cursor 没有 fork，换了账号池走接力），插头不起', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-edit-commit' });
    expect(driver.canFork).toBe(false);
    await expect(
      driver.run(spec({ session: { mode: 'fork', from: CURSOR_SESSION, id: 'x' } }), {}),
    ).rejects.toThrow('没有 fork');
    expect(fake.count()).toBe(0);
  });

  it('报告：token 照终帧（含缓存读写），没有花费、没有实际模型、没有上下文大小；回答照终帧', async () => {
    const { driver } = cursorWith({ replay: 'cursor-edit-commit' });
    const report = await driver.run(spec(), {});
    expect(report.usage).toEqual({
      inputTokens: 12715,
      outputTokens: 178,
      cacheReadTokens: 19968,
      cacheWriteTokens: 0,
    });
    expect(report).not.toHaveProperty('sessionCostUsd');
    expect(report).not.toHaveProperty('actualModel');
    expect(report).not.toHaveProperty('contextTokens');
    expect(report).not.toHaveProperty('rawError');
    expect(report.answer).toContain('好了');
    expect(report.facts).toMatchObject({ exitCode: 0, terminal: { isError: false } });
  });

  it('终帧里的用量读不到、不是数：那几项不给（不记成 0）', async () => {
    const { driver } = cursorWith({
      replay: 'cursor-edit-commit',
      replayLines: 1,
      frames: [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'OK',
          usage: { inputTokens: 5, outputTokens: 'x', cacheReadTokens: null },
        },
      ],
    });
    expect((await driver.run(spec(), {})).usage).toEqual({ inputTokens: 5 });
    const bare = cursorWith({ replay: 'cursor-edit-commit', replayLines: 1 });
    expect((await bare.driver.run(spec(), {})).usage).toEqual({});
  });

  it('只在 stderr 里的报错（没登录：退出 1、没有 JSON）：原话进 rawError，没有会话号', async () => {
    const { driver } = cursorWith({ stderr: CURSOR_NO_LOGIN, exitCode: 1 });
    const report = await driver.run(spec(), {});
    expect(report.rawError).toBe(CURSOR_NO_LOGIN);
    expect(report).not.toHaveProperty('sessionId');
    expect(report.usage).toEqual({});
    expect(report.facts).toMatchObject({ exitCode: 1, lastWords: CURSOR_NO_LOGIN, quotaExhausted: false });
  });

  it('登录失效的修法：去 Cursor 后台重新生成一把密钥，照 ops 放进哪台机器、谁家里（浏览器登录在服务器上存不下，不再叫人去登录）', () => {
    const { driver } = cursorWith({});
    const fix = driver.loginFix('「法国」', 'fleet-agent-carpool');
    expect(fix).toBe(
      '去 Cursor 后台（cursor.com/dashboard/api）重新生成一把 API 密钥，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」那条命令放进「法国」（fleet-agent-carpool 家里的 ~/.cursor/fleet-api-key）',
    );
    expect(fix).not.toContain('cursor-agent login');
  });
});

describe('grok 的驱动', () => {
  const grokWith = (script: FakeGrokScript) => {
    const fake = fakeGrokRun(() => script);
    return { fake, driver: drivers({ grok: fake.run }).grok };
  };
  const grokSpec = (over: Partial<HostRunSpec> = {}) =>
    spec({ model: 'grok-4.7', session: { mode: 'new', id: randomUUID() }, ...over });

  it('会话号由我们定（UUID，开新会话带它 -s），但它真开了会话才算数：终帧回的就是它；插头用的是会话用户家里那一份', async () => {
    const { fake, driver } = grokWith({ frames: grokAnswered() });
    const fresh = driver.newSessionId('run-1');
    expect(fresh.known).toBe(false);
    expect(fresh.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const report = await driver.run(grokSpec({ session: { mode: 'new', id: fresh.id } }), {});
    expect(fake.specs[0]?.session).toEqual({ mode: 'new', id: fresh.id });
    expect(report.sessionId).toBe(fresh.id);
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/grok']);
  });

  it('开了会话、没到终帧就断了（半路被停、连不上）：会话号还是我们给它的那个（下次 -r 续得上）；一帧都没有就不给', async () => {
    const id = randomUUID();
    const cut = await grokWith({ replay: 'grok-edit-commit', replayLines: 30, exitCode: null }).driver.run(
      grokSpec({ session: { mode: 'new', id } }),
      {},
    );
    expect(cut.facts).not.toHaveProperty('terminal');
    expect(cut.sessionId).toBe(id);
    const nothing = await grokWith({ stderr: 'Error: connection reset\n', exitCode: 1 }).driver.run(
      grokSpec({ session: { mode: 'new', id } }),
      {},
    );
    expect(nothing).not.toHaveProperty('sessionId');
  });

  it('干活的会话放开命令（--always-approve），探针不放（要权限的工具一律被拒）；续会话照原号 -r；模型串照路由', async () => {
    const { fake, driver } = grokWith({ replay: 'grok-resume' });
    const id = randomUUID();
    await driver.run(grokSpec({ purpose: 'work', session: { mode: 'resume', id } }), {});
    await driver.run(grokSpec({ purpose: 'probe' }), {});
    expect(fake.specs[0]).toMatchObject({
      alwaysApprove: true,
      model: 'grok-4.7',
      session: { mode: 'resume', id },
    });
    expect(fake.specs[1]).toMatchObject({ alwaysApprove: false, session: { mode: 'new' } });
  });

  it('要 fork：拒（grok 没有我们用得上的 fork，换了账号池走接力），插头不起', async () => {
    const { fake, driver } = grokWith({ frames: grokAnswered() });
    expect(driver.canFork).toBe(false);
    await expect(
      driver.run(grokSpec({ session: { mode: 'fork', from: randomUUID(), id: randomUUID() } }), {}),
    ).rejects.toThrow('grok 不 fork');
    expect(fake.count()).toBe(0);
  });

  it('报告：token 照终帧（含缓存读写），实际模型取终帧 modelUsage 的键；没有会话累计花费、上下文大小；回答是最后一段话', async () => {
    const { driver } = grokWith({ replay: 'grok-edit-commit' });
    const report = await driver.run(grokSpec(), {});
    expect(report.usage).toEqual({
      inputTokens: 42438,
      outputTokens: 955,
      cacheReadTokens: 68992,
      cacheWriteTokens: 0,
    });
    expect(report.actualModel).toBe('grok-4.7-build');
    expect(report).not.toHaveProperty('sessionCostUsd');
    expect(report).not.toHaveProperty('contextTokens');
    expect(report).not.toHaveProperty('rawError');
    expect(report.answer).toBe('好了');
    expect(report.facts).toMatchObject({ exitCode: 0, terminal: { isError: false } });
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'ok' });
  });

  it('终帧里的用量读不到、不是数：那几项不给（不记成 0）；一句话都没说：没有回答', async () => {
    const { driver } = grokWith({
      frames: [
        {
          type: 'end',
          stopReason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 'x', cache_read_input_tokens: null },
          modelUsage: { 'grok-4.7-build': {} },
        },
      ],
    });
    const report = await driver.run(grokSpec(), {});
    expect(report.usage).toEqual({ inputTokens: 5 });
    expect(report).not.toHaveProperty('answer');
    const bare = grokWith({ frames: [{ type: 'end', stopReason: 'end_turn', modelUsage: {} }] });
    const r2 = await bare.driver.run(grokSpec(), {});
    expect(r2.usage).toEqual({});
    expect(r2).not.toHaveProperty('actualModel');
  });

  it('没登录（error 帧和 stderr 各一遍、退出 1、没有终帧）：原话进 rawError、只一份；没有会话号、没有用量', async () => {
    const { driver } = grokWith(grokRefused(GROK_NOT_SIGNED_IN));
    const report = await driver.run(grokSpec(), {});
    expect(report.rawError).toBe(
      'Error: Not signed in. To authenticate without a browser, run: ⏎ grok login --device-code ⏎ ' +
        'Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.',
    );
    expect(report).not.toHaveProperty('sessionId');
    expect(report.usage).toEqual({});
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'failed', reason: 'no_result' });
  });

  it('实际回话的是别的一代（点名 grok-4.7、回 grok-4.6-build）：判模型不符；带渠道后缀的同一代不算', async () => {
    const other = await grokWith({ frames: grokAnswered('OK', 'grok-4.6-build') }).driver.run(grokSpec(), {});
    expect(judgeRun(other.facts)).toMatchObject({ outcome: 'failed', reason: 'model_mismatch' });
    const same = await grokWith({ frames: grokAnswered('OK', 'grok-4.7-build') }).driver.run(grokSpec(), {});
    expect(judgeRun(same.facts)).toMatchObject({ outcome: 'ok' });
  });

  it('登录失效的修法：在哪台机器上以会话用户跑 grok login --device-code，在浏览器里确认；照 ops 哪一节', () => {
    const { driver } = grokWith({});
    expect(driver.loginFix('「法国」', 'fleet-agent-carpool')).toBe(
      '在「法国」上以 fleet-agent-carpool 跑 grok login --device-code（docs/ops.md 第五节「会话用户的 grok」），在任意设备的浏览器里打开它给的链接、确认那串码',
    );
  });
});

describe('Claude Code 的驱动', () => {
  it('会话号由我们定（UUID）；干活放开权限，探针什么工具都不给、不存会话记录', async () => {
    const fake = fakeRun(() => ({ result: { text: 'OK' } }));
    const driver = drivers({ 'claude-code': fake.run })['claude-code'];
    const fresh = driver.newSessionId('run-1');
    expect(fresh.known).toBe(true);
    expect(fresh.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await driver.run(spec({ purpose: 'work', session: { mode: 'new', id: fresh.id } }), {});
    await driver.run(spec({ purpose: 'probe', session: { mode: 'new', id: fresh.id } }), {});
    expect(fake.specs[0]).toMatchObject({
      permissionMode: 'bypassPermissions',
      session: { mode: 'new', id: fresh.id },
    });
    expect(fake.specs[0]).not.toHaveProperty('persistSession');
    expect(fake.specs[1]).toMatchObject({ permissionMode: 'dontAsk', persistSession: false });
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/reclaude']);
  });
});

describe('模型串 → Mirasim 执行体（MIRASIM_AGENT_BY_MODEL）', () => {
  it('四条现挂的路由都认得出：opus-5.5→claude、gpt-5.6-luna→codex、kimi-k3→pi、deepseek-flash→dsh', () => {
    expect(mirasimAgentFor('claude-opus-5-5')).toBe('claude');
    expect(mirasimAgentFor('gpt-5.6-luna')).toBe('codex');
    expect(mirasimAgentFor('kimi-k3')).toBe('pi');
    expect(mirasimAgentFor('deepseek-flash')).toBe('dsh');
  });

  it('插头读到认不出的输出——模型串不在这张表里：明确报错，不落到某个默认执行体上（新路由忘了改这张表会当场炸，不会悄悄派错执行体）【故意造出的失败】', () => {
    expect(() => mirasimAgentFor('glm-6')).toThrow('Mirasim 认不出这个模型该起哪个执行体：glm-6');
    expect(() => mirasimAgentFor('')).toThrow('Mirasim 认不出这个模型该起哪个执行体：');
    // 报错里列出现在认得的几个，方便照着改表
    for (const known of Object.keys(MIRASIM_AGENT_BY_MODEL)) {
      expect(() => mirasimAgentFor('glm-6')).toThrow(new RegExp(known));
    }
  });
});

describe('Mirasim 的驱动（#345）', () => {
  const mirasimWith = (script: FakeMirasimScript) => {
    const fake = fakeMirasimRun(() => script);
    return { fake, driver: drivers({ mirasim: fake.run }).mirasim };
  };
  const mirasimSpec = (over: Partial<HostRunSpec> = {}) =>
    spec({ model: 'deepseek-flash', session: { mode: 'new', id: 'ignored' }, ...over });

  it('会话号不是我们起的：先回一眼看得出不是真号的临时号（cursor 同一个道理），server 的 accepted 帧才给真号', async () => {
    const { driver } = mirasimWith({ state: { text: 'OK' } });
    const fresh = driver.newSessionId('run-9');
    expect(fresh).toEqual({ id: `${MIRASIM_PENDING_PREFIX}run-9`, known: false });
    const ids: string[] = [];
    const report = await driver.run(mirasimSpec({ session: { mode: 'new', id: fresh.id } }), {
      onSessionId: (id) => ids.push(id),
    });
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^dsh:/);
    expect(report.sessionId).toBe(ids[0]);
  });

  it('起会话不带我们造的会话号（服务端自己起）：新会话给 { mode: "new" }，续会话按原 sessionKey 给 { mode: "resume", key }', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    await driver.run(mirasimSpec({ session: { mode: 'new', id: 'whatever' } }), {});
    await driver.run(mirasimSpec({ session: { mode: 'resume', id: 'dsh:abc-123' } }), {});
    expect(fake.specs[0]?.session).toEqual({ mode: 'new' });
    expect(fake.specs[1]?.session).toEqual({ mode: 'resume', key: 'dsh:abc-123' });
  });

  it('只留「中继额度」这一种路由：route 永远是 cloud（design 第三节第 12 条、MS-28：不许反代）', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    await driver.run(mirasimSpec(), {});
    expect(fake.specs[0]?.route).toBe('cloud');
  });

  it('模型串按路由上的：agent 由 MIRASIM_AGENT_BY_MODEL 现算，一般执行体带 model；pi（kimi-k3）不带 model，只带 expectModel 核对回读的快照（PI-02）', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    await driver.run(mirasimSpec({ model: 'deepseek-flash' }), {});
    expect(fake.specs[0]).toMatchObject({ agent: 'dsh', model: 'deepseek-flash' });
    expect(fake.specs[0]).not.toHaveProperty('expectModel');
    await driver.run(mirasimSpec({ model: 'kimi-k3' }), {});
    expect(fake.specs[1]).toMatchObject({ agent: 'pi', expectModel: 'kimi-k3' });
    expect(fake.specs[1]).not.toHaveProperty('model');
  });

  it('模型串这张表认不出：起会话之前就拒（不起插头），和其它认不出的配置一样交回工作流换新 runId', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    await expect(driver.run(mirasimSpec({ model: 'glm-6' }), {})).rejects.toThrow(
      'Mirasim 认不出这个模型该起哪个执行体：glm-6',
    );
    expect(fake.count()).toBe(0);
  });

  it('要 fork：拒（Mirasim 没有 fork，换了账号池走接力），插头不起', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    expect(driver.canFork).toBe(false);
    expect(driver.userFrom).toBe('sole');
    await expect(
      driver.run(mirasimSpec({ session: { mode: 'fork', from: 'dsh:aaa', id: 'dsh:bbb' } }), {}),
    ).rejects.toThrow('没有 fork');
    expect(fake.count()).toBe(0);
  });

  it('连接、账本目录、读账本都以这次会话的用户去拿（mirasimConnect / mirasimLedgerDir / mirasimLedgerFs 三个依赖都被调用）', async () => {
    const { fake, driver } = mirasimWith({ state: { text: 'OK' } });
    await driver.run(mirasimSpec({ user: 'fleet-agent-carpool' }), {});
    expect(fake.options[0]?.ledgerDir).toBe('/fake/fleet-agent-carpool/.mirasim/traffic');
    expect(typeof fake.options[0]?.connect).toBe('function');
    expect(typeof fake.options[0]?.ledgerFs?.readdir).toBe('function');
    expect(typeof fake.options[0]?.ledgerFs?.readFile).toBe('function');
  });

  it('没接 accepted（服务端没接这一针）：onSessionId 不会被调用', async () => {
    const { driver } = mirasimWith({ state: { text: 'OK' }, noAccept: true });
    const ids: string[] = [];
    await driver.run(mirasimSpec(), { onSessionId: (id) => ids.push(id) });
    expect(ids).toEqual([]);
  });

  it('报告：token、实际模型、回答从快照状态整理出来；没有 stderrTail（协议是 ws 帧、不是子进程，给空串）、没有 sessionCostUsd / httpStatus / contextTokens（Mirasim 没有这几个概念）、没有 rawError（原因已经在 facts 里，和 Claude 一个道理）', async () => {
    const { driver } = mirasimWith({
      state: {
        text: '好了',
        model: 'deepseek-flash',
        usage: { turnOutputTokens: 42 },
      },
    });
    const report = await driver.run(mirasimSpec(), {});
    expect(report.hostId).toBe('mirasim');
    expect(report.actualModel).toBe('deepseek-flash');
    expect(report.answer).toBe('好了');
    expect(report.usage).toEqual({ outputTokens: 42 });
    expect(report).not.toHaveProperty('sessionCostUsd');
    expect(report).not.toHaveProperty('httpStatus');
    expect(report).not.toHaveProperty('contextTokens');
    expect(report).not.toHaveProperty('rawError');
    expect(report.stderrTail).toBe('');
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it('一句话都没说：没有回答；用量读不到的字段不给（不记成 0）', async () => {
    const { driver } = mirasimWith({ state: { text: '' } });
    const report = await driver.run(mirasimSpec(), {});
    expect(report).not.toHaveProperty('answer');
    expect(report.usage).toEqual({});
  });

  it('起没起来没查成（服务端没有这个执行体、明确拒了这一针）：facts.spawnError，判失败、不算路由的账留给失败分流认', async () => {
    const { driver } = mirasimWith({
      state: { text: '' },
      report: { launchError: '服务端没有 dsh 这个执行体（有：claude、pi）' },
      noAccept: true,
    });
    const report = await driver.run(mirasimSpec(), {});
    expect(report).not.toHaveProperty('sessionId');
    const verdict = judgeRun(report.facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'spawn_failed' });
    expect(verdict.detail).toContain('服务端没有 dsh 这个执行体');
  });

  it('prompt 发出去了、没等到应答（可能已经在跑）：facts.launchUnknown，不当成「没起来」重派（会烧两次额度）', async () => {
    const { driver } = mirasimWith({
      state: { text: '' },
      report: { launchError: '起会话没查成：没收到 prompt 的应答帧', launchUnknown: true },
      noAccept: true,
    });
    const report = await driver.run(mirasimSpec(), {});
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'failed', reason: 'launch_unknown' });
  });

  it('中途被停（型号回读不符、停滞……）：killed 原因照 KillReason 判', async () => {
    const { driver } = mirasimWith({
      state: { text: '' },
      // terminal 不用清：judgeRun 里 killed 短路在最前面，不管 terminal 是不是默认的「done」都不影响这条判失败。
      report: { killed: { reason: 'model_mismatch', at: new Date().toISOString() } },
    });
    const report = await driver.run(mirasimSpec(), {});
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'failed', reason: 'model_mismatch' });
  });

  it('快照说 done、但没给账本目录：中转到底走没走上游没查成（DL3），不当成交了活也不当成执行体失败', async () => {
    const { driver } = mirasimWith({ state: { text: 'OK' }, report: { ledger: undefined } });
    const report = await driver.run(mirasimSpec(), {});
    const verdict = judgeRun(report.facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'relay_unknown' });
    expect(verdict.detail).toContain('没给账本目录');
  });

  it('快照说 done、账本读到了、起针之后却没有一次 2xx：不算真交了活', async () => {
    const { driver } = mirasimWith({
      state: { text: 'OK' },
      report: { ledger: { state: 'read', rows: [{ status: 500 }], unparsed: 0 } },
    });
    const report = await driver.run(mirasimSpec(), {});
    const verdict = judgeRun(report.facts);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.detail).toContain('账本里起针之后没有一次 2xx 的上游调用');
  });

  it('账本读不了（不是没有调用，是没查成）：不当成零次调用', async () => {
    const { driver } = mirasimWith({
      state: { text: 'OK' },
      report: { ledger: { state: 'unknown', detail: '账本没读成：EACCES' } },
    });
    const report = await driver.run(mirasimSpec(), {});
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'failed', reason: 'relay_unknown' });
  });

  it('登录失效的修法：用 Mirasim 桌面端以 SSH 远程模式连那台机器那个会话用户，登一次账号；照 ops 哪一节', () => {
    const { driver } = mirasimWith({ state: { text: 'OK' } });
    expect(driver.loginFix('「法国」', 'fleet-agent-carpool')).toBe(
      '用 Mirasim 桌面端以 SSH 远程模式连 fleet-agent-carpool@「法国」，把这个会话用户自己的 Mirasim 服务装起来、登一次账号（docs/ops.md 第五节「会话用户的 Mirasim」）',
    );
  });
});
