import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWsServer, tempDir } from '@fleet-dao/adapters/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MigrationOptions, migrate } from '../src/migrate.ts';
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
      copyFileSync(nativeBinary, destination);
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

  it('会话记录损坏，不能拿空列表冒充空闲', async () => {
    const m = await machine();
    try {
      writeFileSync(m.record, '{broken');
      await expect(migrate(m.config)).rejects.toThrow(/会话|空闲/);
      expect(m.frames.some((f) => f.type === 'setAgentLaunch')).toBe(false);
    } finally {
      await m.close();
    }
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
