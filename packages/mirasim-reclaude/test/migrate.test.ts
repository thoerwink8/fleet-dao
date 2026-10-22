import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWsServer, tempDir } from '@fleet-dao/adapters/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeSourceHash } from '../src/build.ts';
import { DRIFT_NOTICE, type MigrationOptions, migrate, runningSessions } from '../src/migrate.ts';
import { runChildOk } from './child.ts';

const mini =
  'package main\nimport("encoding/json";"os";"runtime")\nvar sourceHash string\nfunc main(){if len(os.Args)>1&&os.Args[1]=="--fleet-doctor"{json.NewEncoder(os.Stdout).Encode(map[string]any{"status":"ready"});return};json.NewEncoder(os.Stdout).Encode(map[string]any{"name":"fleet-mirasim-reclaude","schema":1,"version":"2.0.0","sourceHash":sourceHash,"sourceCommit":"fixture","platform":runtime.GOOS,"arch":runtime.GOARCH})}\n';
const moduleText = 'module fixture\n\ngo 1.22\n';
const wantedHash = createHash('sha256')
  .update('go.mod\0')
  .update(moduleText)
  .update('\0main.go\0')
  .update(mini)
  .update('\0')
  .digest('hex');
let nativeBinary = '';
let nativeDir = '';

beforeAll(() => {
  const base = resolve('_tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'migration-native-'));
  nativeDir = dir;
  writeFileSync(join(dir, 'go.mod'), moduleText);
  writeFileSync(join(dir, 'main.go'), mini);
  nativeBinary = join(dir, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  runChildOk('go', ['build', '-o', nativeBinary, '-ldflags', `-X main.sourceHash=${wantedHash}`, '.'], {
    cwd: dir,
    limitMs: 60_000,
  });
}, 70_000);
afterAll(() => {
  if (nativeDir.startsWith(join(resolve('_tmp'), 'migration-native-')))
    rmSync(nativeDir, { recursive: true, force: true });
});

async function machine(
  options: {
    busy?: boolean;
    ignoreSet?: boolean;
    custom?: boolean;
    badClis?: boolean;
    replyDelayMs?: number;
    silentClis?: boolean;
    native?: (frame: Record<string, unknown>) => Record<string, unknown>[];
  } = {},
) {
  const home = tempDir();
  const repo = tempDir();
  const launcher = join(repo, 'packages', 'mirasim-reclaude', 'launcher');
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(launcher, 'go.mod'), moduleText);
  writeFileSync(join(launcher, 'main.go'), mini);
  const ms = join(home, '.mirasim');
  mkdirSync(join(ms, 'run'), { recursive: true });
  const session = join(ms, 'sessions', 'claude', 'managed-one');
  mkdirSync(session, { recursive: true });
  const record = join(session, 'record.json');
  writeFileSync(
    record,
    JSON.stringify({
      agent: 'claude',
      sessionId: 'managed-one',
      runState: options.busy ? 'running' : 'completed',
    }),
  );
  const oldCommand = options.custom
    ? '/custom/keep-my-launcher'
    : join(home, '.local', 'bin', 'reclaude-mirasim.exe');
  const setting = join(ms, 'setting.json');
  const initial = {
    agentLaunch: { claude: { command: oldCommand, args: '--original' } },
    auth: { token: 'do-not-copy-auth' },
    claudeModel: 'keep-this-model',
  };
  writeFileSync(setting, JSON.stringify(initial));
  const frames: Record<string, unknown>[] = [];
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const server = await startWsServer((peer) => {
    const send = (response: unknown) => {
      if (options.replyDelayMs) {
        const timer = setTimeout(() => {
          pending.delete(timer);
          peer.send(response);
        }, options.replyDelayMs);
        pending.add(timer);
      } else peer.send(response);
    };
    peer.onMessage((f) => {
      frames.push(f);
      for (const response of options.native?.(f) ?? []) send(response);
      // 实机 getConfig 是脱敏后的功能设置，不含 agentLaunch；启动器须从 listClis 回读。
      if (f.type === 'getConfig')
        send({
          type: 'config',
          config: { agents: { claude: { model: 'sonnet', approvalMode: 'default' } } },
        });
      if (f.type === 'listClis' && !options.silentClis) {
        const data = JSON.parse(readFileSync(setting, 'utf8'));
        send({
          type: 'clis',
          clis: options.badClis
            ? []
            : [
                {
                  id: 'claude',
                  label: 'Claude Code',
                  kind: 'agent',
                  installed: true,
                  launch: {
                    ...data.agentLaunch.claude,
                    binEnv: 'MIRASIM_CLAUDE_BIN',
                    defaultBin: 'claude',
                    argsApply: true,
                  },
                  probing: false,
                },
              ],
        });
      }
      if (f.type === 'getState') peer.send({ type: 'state', sessions: [] });
      if (f.type === 'setAgentLaunch' && !options.ignoreSet) {
        const data = JSON.parse(readFileSync(setting, 'utf8'));
        data.agentLaunch.claude = { command: f.command, ...(f.args ? { args: f.args } : {}) };
        writeFileSync(setting, JSON.stringify(data));
      }
    });
  });
  writeFileSync(join(ms, 'run', `local-${server.port}.token`), 'fixture-ticket');
  const config: MigrationOptions = {
    home,
    repo,
    platform: process.platform,
    arch: process.arch,
    pollMs: 5,
    prepare: async ({ destination }) => {
      mkdirSync(resolve(destination, '..'), { recursive: true });
      // 和真实 prepareBinary 一样先写旁边再改名：macOS 上原地覆盖刚跑过的可执行文件，内核缓存的签名对不上，新进程一起来就被杀
      copyFileSync(nativeBinary, `${destination}.new`);
      renameSync(`${destination}.new`, destination);
      return destination;
    },
  };
  return {
    home,
    repo,
    record,
    setting,
    oldCommand,
    initial,
    frames,
    config,
    close: async () => {
      for (const timer of pending) clearTimeout(timer);
      await server.close();
    },
  };
}

describe('旧接入迁移与回读', { timeout: 20_000 }, () => {
  it('一条调用迁移旧命令，保留其他设置，备份不复制账号令牌', async () => {
    const m = await machine();
    try {
      const result = await migrate(m.config);
      expect(result.state).toBe('migrated');
      const config = JSON.parse(readFileSync(m.setting, 'utf8'));
      expect(config.agentLaunch.claude.command).toBe(result.command);
      expect(config.claudeModel).toBe('keep-this-model');
      expect(config.auth.token).toBe('do-not-copy-auth');
      expect(readFileSync(result.recordFile, 'utf8')).not.toContain('do-not-copy-auth');
      const state = JSON.parse(readFileSync(result.recordFile, 'utf8'));
      expect(state.previous).toEqual({ command: m.oldCommand, args: '--original' });
      expect(state.sourceHash).toBe(wantedHash);
      expect(existsSync(result.command)).toBe(true);
    } finally {
      await m.close();
    }
  });

  it('重复调用不重建、不重设命令；可以等空闲后撤回原命令', async () => {
    const m = await machine();
    try {
      const first = await migrate(m.config);
      const mutations = m.frames.filter((f) => f.type === 'setAgentLaunch').length;
      expect((await migrate(m.config)).state).toBe('current');
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(mutations);
      const back = await migrate({ ...m.config, rollback: true });
      expect(back.state).toBe('restored');
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude).toEqual({
        command: m.oldCommand,
        args: '--original',
      });
      expect(existsSync(first.command)).toBe(true);
    } finally {
      await m.close();
    }
  });

  it('WS 回读延迟 250ms 仍在默认限时内，迁移与撤回均确认真实配置', async () => {
    const m = await machine({ replyDelayMs: 250 });
    try {
      const first = await migrate(m.config);
      expect(first.state).toBe('migrated');
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.command).toBe(first.command);
      const back = await migrate({ ...m.config, rollback: true });
      expect(back.state).toBe('restored');
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude).toEqual({
        command: m.oldCommand,
        args: '--original',
      });
    } finally {
      await m.close();
    }
  });

  it('启动器列表始终不响应：到限时明确失败，不写启动配置或迁移记录', async () => {
    const m = await machine({ silentClis: true });
    try {
      await expect(migrate({ ...m.config, replyMs: 75 })).rejects.toThrow(/启动器列表.*超时/);
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude).toEqual({
        command: m.oldCommand,
        args: '--original',
      });
      expect(existsSync(join(m.home, '.fleet-dao', 'mirasim-reclaude', 'migration.json'))).toBe(false);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('在途回合没结束：等待到上限也不改命令、不宣称已迁移', async () => {
    const m = await machine({ busy: true });
    try {
      const result = await migrate({ ...m.config, wait: true, maxWaitMs: 80 });
      expect(result.state).toBe('waiting');
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.command).toBe(m.oldCommand);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('同一次命令等回合结束后继续迁移，期间保留旧机制', async () => {
    const m = await machine({ busy: true });
    const timer = setTimeout(
      () =>
        writeFileSync(
          m.record,
          JSON.stringify({ agent: 'claude', sessionId: 'managed-one', runState: 'completed' }),
        ),
      20,
    );
    try {
      expect((await migrate({ ...m.config, wait: true })).state).toBe('migrated');
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      await m.close();
    }
  });

  it('会话记录损坏，不能拿空列表冒充空闲：记为没查成、按判不了空闲等着，不改命令', async () => {
    const m = await machine();
    try {
      writeFileSync(m.record, '{broken');
      const result = await migrate(m.config);
      expect(result.state).toBe('waiting');
      expect(result.detail).toMatch(/没查成/);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('单个会话记录坏了不整个抛：数得清的照数，坏的记为没查成', () => {
    const home = tempDir();
    const dir = join(home, '.mirasim', 'sessions', 'claude');
    const put = (sid: string, text: string) => {
      mkdirSync(join(dir, sid), { recursive: true });
      writeFileSync(join(dir, sid, 'record.json'), text);
    };
    put('a', JSON.stringify({ runState: 'running' }));
    put('b', JSON.stringify({ runState: 'completed' }));
    put('c', '{broken');
    put('d', JSON.stringify({ runState: 'from-the-future' }));
    expect(runningSessions(home)).toEqual({ running: 1, unknown: ['c', 'd'] });
  });

  it('新程序架构或源码版本不对：不替换旧命令', async () => {
    const m = await machine();
    try {
      await expect(
        migrate({ ...m.config, arch: process.arch === 'arm64' ? 'x64' : 'arm64' }),
      ).rejects.toThrow(/架构|平台/);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('Mirasim 没接受命令：回读失败，不标迁移成功', async () => {
    const m = await machine({ ignoreSet: true });
    try {
      // 回读等满限时才判失败：默认 5 秒白等，这里给 600ms（假 Mirasim 当场回帧，回读一次几毫秒，照样轮好几次都对不上）。
      await expect(migrate({ ...m.config, replyMs: 600 })).rejects.toThrow(/启动命令回读未匹配/);
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.command).toBe(m.oldCommand);
    } finally {
      await m.close();
    }
  });

  it('启动器列表没有 Claude：明确读回失败，不猜默认命令、不改配置', async () => {
    const m = await machine({ badClis: true });
    try {
      await expect(migrate(m.config)).rejects.toThrow(/启动器列表/);
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.command).toBe(m.oldCommand);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('两个迁移同时开始，只替换一次，另一个明确等待', async () => {
    const m = await machine();
    try {
      const options = {
        ...m.config,
        maxWaitMs: 10_000,
        replyMs: 5_000,
        prepare: async (input: Parameters<NonNullable<MigrationOptions['prepare']>>[0]) => {
          await sleep(120);
          const prepare = m.config.prepare;
          if (!prepare) throw new Error('测试夹具没有准备程序');
          return prepare(input);
        },
      };
      const results = await Promise.all([migrate(options), migrate(options)]);
      expect(results.map((r) => r.state).sort()).toEqual(['migrated', 'waiting']);
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(1);
    } finally {
      await m.close();
    }
  });

  it('主动撤回的版本下次同步不会自动重装；显式命令仍可重新迁移', async () => {
    const m = await machine();
    try {
      await migrate(m.config);
      await migrate({ ...m.config, rollback: true });
      const mutations = m.frames.filter((f) => f.type === 'setAgentLaunch').length;
      expect((await migrate({ ...m.config, auto: true })).state).toBe('skipped');
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(mutations);
      expect((await migrate(m.config)).state).toBe('migrated');
    } finally {
      await m.close();
    }
  });

  it('真实的 incomplete 状态是已结束回合，迁移仍保留原启动参数', async () => {
    const m = await machine();
    try {
      writeFileSync(m.record, JSON.stringify({ runState: 'incomplete', sessionId: 'managed-one' }));
      expect((await migrate(m.config)).state).toBe('migrated');
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.args).toBe('--original');
    } finally {
      await m.close();
    }
  });

  it('已装文件被改过，即使自报同版也不重新信任它', async () => {
    const m = await machine();
    try {
      const first = await migrate(m.config);
      // Go 程序仍能执行且版本输出不变，但磁盘字节已被篡改。
      const original = readFileSync(first.command);
      writeFileSync(first.command, Buffer.concat([original, Buffer.from('tampered')]));
      await expect(migrate(m.config)).rejects.toThrow(/校验|改动/);
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(1);
    } finally {
      await m.close();
    }
  });

  it('撤回记录中的旧命令损坏：不向 Mirasim 发写入请求', async () => {
    const m = await machine();
    try {
      const first = await migrate(m.config);
      const record = JSON.parse(readFileSync(first.recordFile, 'utf8'));
      record.previous = { command: 42, args: {} };
      writeFileSync(first.recordFile, JSON.stringify(record));
      await expect(migrate({ ...m.config, rollback: true })).rejects.toThrow(/记录/);
      expect(m.frames.filter((f) => f.type === 'setAgentLaunch')).toHaveLength(1);
    } finally {
      await m.close();
    }
  });

  it('准备版本期间人改了启动命令，不覆盖人的新配置', async () => {
    const m = await machine();
    try {
      const prepare = m.config.prepare;
      if (!prepare) throw new Error('测试夹具没有准备程序');
      await expect(
        migrate({
          ...m.config,
          prepare: async (input) => {
            const executable = await prepare(input);
            const config = JSON.parse(readFileSync(m.setting, 'utf8'));
            config.agentLaunch.claude.command = '/custom/new-human-choice';
            writeFileSync(m.setting, JSON.stringify(config));
            return executable;
          },
        }),
      ).rejects.toThrow(/修改|覆盖/);
      expect(JSON.parse(readFileSync(m.setting, 'utf8')).agentLaunch.claude.command).toBe(
        '/custom/new-human-choice',
      );
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('自动同步不覆盖自定义启动器，也不把 Linux 的固定渠道改成桌面封装', async () => {
    const m = await machine({ custom: true });
    try {
      expect((await migrate({ ...m.config, auto: true })).state).toBe('skipped');
      expect((await migrate({ ...m.config, auto: true, platform: 'linux' })).state).toBe('skipped');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });
});

describe('残留会话的原生补核与等待源码更新', { timeout: 20_000 }, () => {
  const noRun = (f: Record<string, unknown>): Record<string, unknown>[] =>
    f.type === 'listSessions'
      ? [{ type: 'sessions', reqId: f.reqId, sessions: [], hasMore: false }]
      : f.type === 'subscribe'
        ? [{ type: 'outbox', sessionKey: f.sessionKey, items: [], baseline: true, noRun: true }]
        : [];

  it('无 record 的历史目录必须经完整 global 列表和明确 noRun 基线核实，原文件保留', async () => {
    const m = await machine({ native: noRun });
    try {
      rmSync(m.record);
      const turns = join(resolve(m.record, '..'), 'turns.jsonl');
      writeFileSync(turns, 'history\n');
      expect((await migrate(m.config)).state).toBe('migrated');
      expect(readFileSync(turns, 'utf8')).toBe('history\n');
      expect(existsSync(m.record)).toBe(false);
      const lists = m.frames.filter((f) => f.type === 'listSessions');
      expect(lists.length).toBeGreaterThanOrEqual(4);
      expect(
        lists.every(
          (f) => f.scope === 'global' && f.reqId && !('limit' in f) && !('query' in f) && !('source' in f),
        ),
      ).toBe(true);
      expect(m.frames.filter((f) => f.type === 'unsubscribe')).toHaveLength(4);
    } finally {
      await m.close();
    }
  });

  it.each([
    [
      '列表仍有该会话',
      (f: Record<string, unknown>) =>
        f.type === 'listSessions'
          ? [
              {
                type: 'sessions',
                reqId: f.reqId,
                sessions: [{ agent: 'claude', sessionKey: 'claude:managed-one', runState: 'completed' }],
                hasMore: false,
              },
            ]
          : noRun(f),
    ],
    [
      '其他会话正在运行',
      (f: Record<string, unknown>) =>
        f.type === 'listSessions'
          ? [
              {
                type: 'sessions',
                reqId: f.reqId,
                sessions: [{ agent: 'claude', sessionKey: 'claude:other', runState: 'running' }],
                hasMore: false,
              },
            ]
          : noRun(f),
    ],
    [
      '列表缺状态字段',
      (f: Record<string, unknown>) =>
        f.type === 'listSessions'
          ? [
              {
                type: 'sessions',
                reqId: f.reqId,
                sessions: [{ agent: 'claude', sessionKey: 'claude:other' }],
                hasMore: false,
              },
            ]
          : noRun(f),
    ],
    [
      '列表不完整',
      (f: Record<string, unknown>) =>
        noRun(f).map((r) => (r.type === 'sessions' ? { ...r, hasMore: true } : r)),
    ],
    [
      '列表缺完整标记',
      (f: Record<string, unknown>) =>
        noRun(f).map((r) => {
          const copy = { ...r };
          if (copy.type === 'sessions') delete copy.hasMore;
          return copy;
        }),
    ],
    [
      '坏列表',
      (f: Record<string, unknown>) =>
        noRun(f).map((r) => (r.type === 'sessions' ? { ...r, sessions: null } : r)),
    ],
    [
      '无 noRun',
      (f: Record<string, unknown>) => noRun(f).map((r) => (r.type === 'outbox' ? { ...r, noRun: false } : r)),
    ],
    [
      '有队列',
      (f: Record<string, unknown>) => noRun(f).map((r) => (r.type === 'outbox' ? { ...r, items: [{}] } : r)),
    ],
    [
      '仍有活动 snapshot',
      (f: Record<string, unknown>) =>
        f.type === 'subscribe'
          ? [{ type: 'snapshot', sessionKey: f.sessionKey, snapshot: { phase: 'streaming' } }, ...noRun(f)]
          : noRun(f),
    ],
    ['原生超时', () => []],
  ])('%s：不把残留目录当空闲', async (_name, native) => {
    const m = await machine({ native });
    try {
      rmSync(m.record);
      const result = await migrate({ ...m.config, replyMs: 40 });
      expect(result.state).toBe('waiting');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('磁盘 running 不被原生缺项覆盖', async () => {
    const m = await machine({ busy: true, native: noRun });
    try {
      expect((await migrate(m.config)).state).toBe('waiting');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('一个实例确认残留，另一个实例仍有运行态：保持等待', async () => {
    const m = await machine({ native: noRun });
    const other = await startWsServer((peer) =>
      peer.onMessage((f) => {
        if (f.type === 'getConfig') peer.send({ type: 'config', config: {} });
        if (f.type === 'listSessions')
          peer.send({ type: 'sessions', reqId: f.reqId, sessions: [], hasMore: false });
        if (f.type === 'subscribe')
          peer.send({ type: 'snapshot', sessionKey: f.sessionKey, snapshot: { phase: 'streaming' } });
      }),
    );
    try {
      rmSync(m.record);
      writeFileSync(join(m.home, '.mirasim', 'run', `local-${other.port}.token`), 'fixture-second');
      expect((await migrate({ ...m.config, replyMs: 50 })).state).toBe('waiting');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await other.close();
      await m.close();
    }
  });

  it('任一实例的凭据存在但连接失败，其他实例确认缺项也不解除 unknown', async () => {
    const m = await machine({ native: noRun });
    const other = await startWsServer(() => {});
    const port = other.port;
    await other.close();
    try {
      rmSync(m.record);
      writeFileSync(join(m.home, '.mirasim', 'run', `local-${port}.token`), 'fixture-unavailable');
      expect((await migrate({ ...m.config, replyMs: 50 })).state).toBe('waiting');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('原生基线超时后以新连接重查，迟到旧基线不能使同轮等待放行', async () => {
    const m = await machine({ native: (f) => (f.type === 'listSessions' ? noRun(f) : []) });
    try {
      rmSync(m.record);
      expect((await migrate({ ...m.config, wait: true, replyMs: 30, maxWaitMs: 150 })).state).toBe('waiting');
      expect(m.frames.filter((f) => f.type === 'subscribe')).toHaveLength(1);
    } finally {
      await m.close();
    }
  });

  it('等待时报告原因和核对时间，判闲后采用等待期间更新的源码', async () => {
    const m = await machine({ busy: true });
    const observations: { state: string; detail: string; checkedAt: string }[] = [];
    const source = join(m.repo, 'packages', 'mirasim-reclaude', 'launcher', 'main.go');
    try {
      const result = await migrate({
        ...m.config,
        wait: true,
        onWaiting: (observation) => {
          observations.push(observation);
          writeFileSync(source, `${mini}\n// updated while waiting\n`);
          writeFileSync(m.record, JSON.stringify({ runState: 'completed' }));
        },
        prepare: async ({ sourceHash, destination }) => {
          expect(sourceHash).not.toBe(wantedHash);
          expect(sourceHash).toBe(runtimeSourceHash(m.repo));
          mkdirSync(resolve(destination, '..'), { recursive: true });
          runChildOk(
            'go',
            ['build', '-o', destination, '-ldflags', `-X main.sourceHash=${sourceHash}`, '.'],
            {
              cwd: resolve(source, '..'),
              limitMs: 60_000,
            },
          );
          return destination;
        },
      });
      expect(result.state).toBe('migrated');
      expect(JSON.parse(readFileSync(result.recordFile, 'utf8')).sourceHash).toBe(runtimeSourceHash(m.repo));
      expect(observations).toHaveLength(1);
      expect(observations[0]?.state).toBe('busy');
      expect(observations[0]?.detail).toContain('1');
      expect(Number.isFinite(Date.parse(observations[0]?.checkedAt ?? ''))).toBe(true);
    } finally {
      await m.close();
    }
  });

  it('准备后源码再变化：保留旧接入', async () => {
    const m = await machine();
    try {
      const prepare = m.config.prepare;
      if (!prepare) throw new Error('missing fixture prepare');
      await expect(
        migrate({
          ...m.config,
          prepare: async (input) => {
            const result = await prepare(input);
            writeFileSync(
              join(m.repo, 'packages', 'mirasim-reclaude', 'launcher', 'main.go'),
              `${mini}\n// changed during prepare\n`,
            );
            return result;
          },
        }),
      ).rejects.toThrow('准备期间源码已更新');
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('unknown 的具体等待原因也报告，不能只报 starting', async () => {
    const m = await machine({ native: noRun });
    try {
      writeFileSync(m.record, '{broken');
      const observations: { state: string; detail: string; checkedAt: string }[] = [];
      // 原生列表仍有这个 ID，无法按历史残留解除。
      const other = await startWsServer((peer) =>
        peer.onMessage((f) => {
          if (f.type === 'getConfig') peer.send({ type: 'config', config: {} });
          if (f.type === 'listSessions')
            peer.send({ type: 'sessions', reqId: f.reqId, sessions: [], hasMore: true });
        }),
      );
      try {
        writeFileSync(join(m.home, '.mirasim', 'run', `local-${other.port}.token`), 'fixture-second');
        expect(
          (await migrate({ ...m.config, replyMs: 30, onWaiting: (o) => observations.push(o) })).state,
        ).toBe('waiting');
        expect(observations[0]?.state).toBe('unknown');
        expect(observations[0]?.detail).toContain('1 个');
        expect(Number.isFinite(Date.parse(observations[0]?.checkedAt ?? ''))).toBe(true);
      } finally {
        await other.close();
      }
    } finally {
      await m.close();
    }
  });
});

describe('启动命令被改回裸 claude：只发现、不自动装回', { timeout: 20_000 }, () => {
  const launchIn = (setting: string) => JSON.parse(readFileSync(setting, 'utf8')).agentLaunch.claude;
  const recordIn = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  /** 人在 Mirasim 界面清掉启动命令：只剩参数，listClis 回 defaultBin=claude。 */
  const clearCommand = (setting: string) => {
    const data = JSON.parse(readFileSync(setting, 'utf8'));
    delete data.agentLaunch.claude.command;
    writeFileSync(setting, JSON.stringify(data));
  };
  const setCommand = (setting: string, command: string) => {
    const data = JSON.parse(readFileSync(setting, 'utf8'));
    data.agentLaunch.claude.command = command;
    writeFileSync(setting, JSON.stringify(data));
  };
  const sets = (frames: Record<string, unknown>[]) =>
    frames.filter((f) => f.type === 'setAgentLaunch').length;
  // 自动同步在 Linux 上第一步就跳过（无头渠道归 Fleet 管），判被改掉是桌面行为：按桌面平台跑，Linux CI 上也测得到。
  const desktopAuto = { auto: true, platform: 'darwin' } as const;

  it('装过又被清成裸 claude：自动同步只报告不改设置，check 报 drift 退 75 档', async () => {
    const m = await machine();
    try {
      await migrate(m.config);
      clearCommand(m.setting);
      const before = sets(m.frames);
      const auto = await migrate({ ...m.config, ...desktopAuto });
      expect(auto.state).toBe('drift');
      expect(auto.detail).toBe(DRIFT_NOTICE);
      expect(auto.detail).toMatch(/pnpm mirasim:migrate；确定不用：pnpm mirasim:migrate --rollback/);
      expect(sets(m.frames)).toBe(before);
      expect(launchIn(m.setting)).toEqual({ args: '--original' });
      const check = await migrate({ ...m.config, check: true });
      expect(check.state).toBe('waiting');
      expect(check.status).toBe('drift');
      expect(check.detail).toContain('裸 claude');
    } finally {
      await m.close();
    }
  });

  it('被清成裸 claude 后显式 pnpm mirasim:migrate 装回，迁移前仍记最初那条', async () => {
    const m = await machine();
    try {
      const first = await migrate(m.config);
      clearCommand(m.setting);
      const back = await migrate(m.config);
      expect(back.state).toBe('migrated');
      expect(launchIn(m.setting)).toEqual({ command: first.command, args: '--original' });
      expect(recordIn(back.recordFile).previous).toEqual({ command: m.oldCommand, args: '--original' });
      expect((await migrate({ ...m.config, check: true })).state).toBe('current');
    } finally {
      await m.close();
    }
  });

  it('被清成裸 claude 后确定不用：--rollback 只记主动撤回、不改命令，之后自动同步静默', async () => {
    const m = await machine();
    try {
      await migrate(m.config);
      setCommand(m.setting, 'claude');
      const before = sets(m.frames);
      const back = await migrate({ ...m.config, rollback: true });
      expect(back.state).toBe('restored');
      expect(recordIn(back.recordFile).state).toBe('restored');
      expect(launchIn(m.setting).command).toBe('claude');
      const auto = await migrate({ ...m.config, ...desktopAuto });
      expect(auto.state).toBe('skipped');
      expect(auto.status).toBe('restored');
      expect(sets(m.frames)).toBe(before);
    } finally {
      await m.close();
    }
  });

  it('被改成别的自定义命令：不当成被改掉，自动同步仍不覆盖', async () => {
    const m = await machine();
    try {
      await migrate(m.config);
      setCommand(m.setting, '/custom/keep-my-launcher');
      const before = sets(m.frames);
      const auto = await migrate({ ...m.config, ...desktopAuto });
      expect(auto.state).toBe('skipped');
      expect(auto.status).toBe('custom');
      expect(sets(m.frames)).toBe(before);
      expect(launchIn(m.setting).command).toBe('/custom/keep-my-launcher');
    } finally {
      await m.close();
    }
  });

  it('从没装过的裸 claude：check 报没装过并给安装命令，自动同步不出声', async () => {
    const m = await machine();
    try {
      setCommand(m.setting, 'claude');
      const check = await migrate({ ...m.config, check: true });
      expect(check.state).toBe('waiting');
      expect(check.status).toBe('never');
      expect(check.detail).toContain('pnpm mirasim:migrate');
      expect((await migrate({ ...m.config, ...desktopAuto })).state).toBe('skipped');
      expect(sets(m.frames)).toBe(0);
    } finally {
      await m.close();
    }
  });
});
