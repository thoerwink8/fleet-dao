// 渠道模型名册：假的命令输出和假的 Mirasim 连接。空名单、读不成都不得变成 ok 加空数组。

import { describe, expect, it } from 'vitest';
import type { MirasimFrame, MirasimWire } from '../src/mirasim/wire.ts';
import { modelsFromMirasimWire } from '../src/model-roster/mirasim.ts';
import { parseListedModels } from '../src/model-roster/parse.ts';
import { readChannelModelRosters } from '../src/model-roster/read.ts';
import type { CommandResult, RunCommand } from '../src/quota/context.ts';

const channels = [
  { kind: 'mirasim', channelId: 'mirasim' },
  { kind: 'cursor', channelId: 'cursor' },
  { kind: 'grok', channelId: 'xai' },
  { kind: 'claude', channelId: 'claude-sub' },
];

function runOf(over: Partial<CommandResult>): CommandResult {
  return { code: 0, stdout: '', stderr: '', killed: false, ...over };
}

function scripted(handler: (argv: string[]) => CommandResult | Promise<CommandResult>): RunCommand {
  return (argv) => Promise.resolve(handler(argv));
}

describe('命令行模型表', () => {
  it('cursor 按行认模型串，方括号原样留下', () => {
    const parsed = parseListedModels(
      'cursor',
      'Available models\ncomposer-2.5 - Composer 2.5 (current, default)\ngrok-4.7[context=256k,reasoning=high] - Grok\n',
    );
    expect(parsed).toEqual({
      ok: true,
      models: ['composer-2.5', 'grok-4.7[context=256k,reasoning=high]'],
    });
  });

  it('cursor 说没有模型、或没给出名单，是 bad_response，不是空的成功', () => {
    expect(parseListedModels('cursor', 'No models available').ok).toBe(false);
    expect(parseListedModels('cursor', 'failed to load models\n').ok).toBe(false);
    expect(parseListedModels('cursor', '   ').ok).toBe(false);
  });

  it('grok 有 Available models 就收下，哪怕抬头写着没登录；没有这段又没登录是 auth', () => {
    const listed = parseListedModels(
      'grok',
      'You are not authenticated.\nDefault model: grok-4\nAvailable models:\n* grok-4.7 (default)\n- grok-4.6\n',
    );
    expect(listed).toEqual({ ok: true, models: ['grok-4.7', 'grok-4.6'] });
    const denied = parseListedModels('grok', 'You are not authenticated.\n');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('auth');
  });

  it('cursor 认 JSON 里的 id；不认 models 子命令是 bad_response，不是空的成功', () => {
    const parsed = parseListedModels(
      'cursor',
      '{"data":[{"id":"claude-sonnet-5-5"},{"id":"claude-opus-5-5"}]}',
    );
    expect(parsed).toEqual({ ok: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
    const rejected = parseListedModels('cursor', "error: unknown command 'models'\n");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('bad_response');
  });
});

describe('四个渠道一起读', () => {
  it('一家崩了只记这一家，另外三家照常', async () => {
    const results = await readChannelModelRosters({
      channels,
      commands: { cursor: ['cursor-bin'], grok: ['grok-bin'] },
      connectMirasim: async () =>
        wireOf([
          { type: 'state', state: { agentsAvailable: ['codex'] } },
          { type: 'modelRoster', agent: 'codex', entries: [{ id: 'gpt-6.1-sol', enabled: false }] },
        ]),
      runCommand: scripted((argv) => {
        if (argv[0] === 'cursor-bin') throw new Error('cursor 崩了');
        return runOf({ stdout: 'Available models:\n* grok-4.7\n', code: 0 });
      }),
    });
    const byId = new Map(results.map((r) => [r.channelId, r]));
    expect(byId.get('mirasim')).toEqual({
      ok: true,
      channelId: 'mirasim',
      models: ['gpt-6.1-sol'],
      executors: [{ modelKey: 'gpt-6.1-sol', executor: 'codex' }],
    });
    expect(byId.get('xai')).toEqual({ ok: true, channelId: 'xai', models: ['grok-4.7'] });
    // Claude 没有只读的列模型命令：明说读不成，不起命令、不给空名单
    const claude = byId.get('claude-sub');
    expect(claude?.ok).toBe(false);
    if (claude && !claude.ok) expect(claude.error.code).toBe('config');
    const cursor = byId.get('cursor');
    expect(cursor?.ok).toBe(false);
    if (cursor && !cursor.ok) expect(cursor.error.code).toBe('crashed');
  });

  it('密钥没放好是 no_credentials，命令不在是 config，空输出不是成功', async () => {
    const results = await readChannelModelRosters({
      channels: [
        { kind: 'cursor', channelId: 'cursor' },
        { kind: 'grok', channelId: 'xai' },
      ],
      commands: { cursor: ['cursor-bin'], grok: ['grok-bin'] },
      runCommand: scripted((argv) => {
        if (argv[0] === 'cursor-bin') return runOf({ code: 78, stderr: 'Cursor 密钥没放好：文件是空的' });
        return runOf({ code: 127, stderr: 'spawn grok ENOENT' });
      }),
    });
    const byId = new Map(results.map((r) => [r.channelId, r]));
    const cursor = byId.get('cursor');
    expect(cursor?.ok).toBe(false);
    if (cursor && !cursor.ok) expect(cursor.error.code).toBe('no_credentials');
    const grok = byId.get('xai');
    expect(grok?.ok).toBe(false);
    if (grok && !grok.ok) expect(grok.error.code).toBe('config');
    const [empty] = await readChannelModelRosters({
      channels: [{ kind: 'grok', channelId: 'xai' }],
      commands: { cursor: [], grok: ['grok-bin'] },
      runCommand: scripted(() => runOf({ stdout: '', code: 0 })),
    });
    expect(empty?.ok).toBe(false);
  });

  it('命令挂住是 timeout', async () => {
    const [slow] = await readChannelModelRosters({
      channels: [{ kind: 'cursor', channelId: 'cursor' }],
      commands: { cursor: ['cursor-bin'], grok: [] },
      commandTimeoutMs: 30,
      runCommand: scripted(() => new Promise(() => {}) as Promise<CommandResult>),
    });
    expect(slow?.ok).toBe(false);
    if (slow && !slow.ok) expect(slow.error.code).toBe('timeout');
  });

  it('没给 Mirasim 桥接是 config，不拿空名单冒充', async () => {
    const [one] = await readChannelModelRosters({
      channels: [{ kind: 'mirasim', channelId: 'mirasim' }],
      commands: { cursor: [], grok: [] },
      runCommand: scripted(() => runOf({})),
    });
    expect(one?.ok).toBe(false);
    if (one && !one.ok) expect(one.error.code).toBe('config');
  });

  it('命令后面带着 models；Claude 不起任何命令（reclaude models 会起一个真会话）', async () => {
    const seen: string[][] = [];
    const results = await readChannelModelRosters({
      channels: [
        { kind: 'claude', channelId: 'claude-sub' },
        { kind: 'cursor', channelId: 'cursor' },
      ],
      commands: { cursor: ['/bin/cursor-agent'], grok: [] },
      runCommand: scripted((argv) => {
        seen.push(argv);
        return runOf({ stdout: 'composer-2.5\n' });
      }),
    });
    expect(seen).toEqual([['/bin/cursor-agent', 'models']]);
    expect(results[0]?.ok).toBe(false);
  });
});

describe('Mirasim 名册', () => {
  it('逐个执行体问，没勾上的也算渠道认这个模型；一个执行体报错则整渠失败', async () => {
    const sent: MirasimFrame[] = [];
    const ok = await modelsFromMirasimWire(async () =>
      wireOf(
        [
          { type: 'state', state: { agentsAvailable: ['codex', 'kimi'] } },
          { type: 'noise', agent: 'other' },
          {
            type: 'modelRoster',
            agent: 'codex',
            entries: [{ id: 'gpt-6.1-sol', enabled: false }, { id: '  ' }],
          },
          { type: 'modelRoster', agent: 'kimi', entries: [{ id: 'kimi-k3', enabled: true }] },
        ],
        sent,
      ),
    );
    expect(ok).toEqual({
      ok: true,
      models: ['gpt-6.1-sol', 'kimi-k3'],
      executors: [
        { modelKey: 'gpt-6.1-sol', executor: 'codex' },
        { modelKey: 'kimi-k3', executor: 'kimi' },
      ],
    });
    expect(sent.map((f) => f.type)).toEqual(['clientHello', 'getState', 'getModelRoster', 'getModelRoster']);

    const bad = await modelsFromMirasimWire(async () =>
      wireOf([
        { type: 'state', state: { agentsAvailable: ['codex', 'kimi'] } },
        { type: 'modelRoster', agent: 'codex', entries: [{ id: 'gpt-6.1-sol' }] },
        { type: 'error', message: 'kimi 名册读不了' },
      ]),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('upstream');
  });

  it('帧上没有 agent 也收下名单；条目上的 executor 盖过帧上的 agent', async () => {
    const missingAgent = await modelsFromMirasimWire(async () =>
      wireOf([
        { type: 'state', state: { agentsAvailable: ['codex'] } },
        { type: 'modelRoster', entries: [{ id: 'gpt-6-sol' }] },
      ]),
    );
    expect(missingAgent).toEqual({ ok: true, models: ['gpt-6-sol'], executors: [] });

    const entryWins = await modelsFromMirasimWire(async () =>
      wireOf([
        { type: 'state', state: { agentsAvailable: ['codex'] } },
        {
          type: 'modelRoster',
          agent: 'codex',
          entries: [{ id: 'glm-5.3-flash', executor: 'zcode' }],
        },
      ]),
    );
    expect(entryWins).toEqual({
      ok: true,
      models: ['glm-5.3-flash'],
      executors: [{ modelKey: 'glm-5.3-flash', executor: 'zcode' }],
    });
  });

  it('没有 agentsAvailable、或每个执行体都是空名册，是 bad_response', async () => {
    const missing = await modelsFromMirasimWire(async () =>
      wireOf([{ type: 'state', state: { version: '1' } }]),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('bad_response');
      expect(missing.message).toContain('agentsAvailable');
      expect(missing.message).toContain('有：version');
    }
    const empty = await modelsFromMirasimWire(async () =>
      wireOf([
        { type: 'state', state: { agentsAvailable: ['codex'] } },
        { type: 'modelRoster', agent: 'codex', entries: [] },
      ]),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('bad_response');
  });

  it('令牌读不到是 no_credentials', async () => {
    const failed = await modelsFromMirasimWire(async () => {
      throw new Error('读不了 Mirasim 的回环令牌（/home/x/.mirasim/run/local-1.token）：ENOENT');
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('no_credentials');
  });
});

function wireOf(frames: (MirasimFrame | 'timeout' | 'closed')[], sent: MirasimFrame[] = []): MirasimWire {
  let i = 0;
  return {
    send(frame) {
      sent.push(frame);
    },
    next() {
      const frame = frames[i++];
      if (frame === undefined) return Promise.resolve('closed');
      return Promise.resolve(frame);
    },
    close() {},
  };
}
