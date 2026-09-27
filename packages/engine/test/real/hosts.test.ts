// 执行方式的驱动（#212、#266）：会话用户怎么定、cursor-agent 的起法（会话用户自己读 API 密钥、现找版本目录）、grok 的起法
// （会话用户先看它在不在）、三家驱动拼的参数、报告整理成的同一个形状（读不到的不记成 0）。起法的 sh 都真跑（本机的 sh、假的
// cursor-agent / grok 脚本），每条失败路径都故意造一次；看属主、权限的那几条只在 Linux 上跑（Windows 的 Git Bash 在 NTFS 上
// 表示不了 600）。
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionUser } from '@fleet-dao/adapters';
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
  type HostRunners,
  type HostRunSpec,
  hostDrivers,
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
  fakeCursorRun,
  fakeGrokRun,
  fakeRun,
  GROK_NOT_SIGNED_IN,
  grokAnswered,
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
  it('Claude Code、cursor-agent 和 grok；报错里的说法跟着这张表', () => {
    expect([...WIRED_HOSTS]).toEqual(['claude-code', 'cursor-agent', 'grok']);
    expect(wiredHostNames()).toBe('Claude Code、Cursor Agent、Grok 命令行');
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
