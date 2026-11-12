// #3924：agent 名单、登录、命令行。不真起 CLI。
import { describe, expect, it } from 'vitest';
import {
  type AgentRun,
  claudeLoggedIn,
  cliAuth,
  discoverAgents,
  orderModels,
  parseGrokModels,
  piAuthReady,
  probeLaunch,
} from '../src/ade/agents.ts';
import { adeCommand } from '../src/ade/service.ts';

const GROK_MODELS = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

describe('名单', () => {
  it('grok models 认登录和型号，默认 grok-4.7 排第一', () => {
    expect(parseGrokModels(GROK_MODELS)).toEqual({
      loggedIn: true,
      models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
    });
    expect(parseGrokModels('Not logged in')).toEqual({ loggedIn: false, models: [] });
    expect(orderModels(['grok-4.5', 'grok-4.7'], 'grok-4.7')[0]).toBe('grok-4.7');
  });

  it('claude 只认 loggedIn 字段，codex 认 Not logged in，pi 空账本当没登录', () => {
    expect(claudeLoggedIn('{"loggedIn":true,"email":"a@b.c"}')).toBe(true);
    expect(claudeLoggedIn('{"loggedIn":false}')).toBe(false);
    expect(claudeLoggedIn('同步配置')).toBeNull();
    expect(cliAuth('Not logged in\n', 1)).toBe('out');
    expect(cliAuth('Logged in\n', 0)).toBe('in');
    expect(piAuthReady(null)).toBe('out');
    expect(piAuthReady('{}')).toBe('out');
    expect(piAuthReady('{"anthropic":{"type":"oauth"}}')).toBe('in');
    expect(piAuthReady('not json')).toBe('unknown');
  });

  it('装了但没登录的不能选，grok 用探测到的型号', async () => {
    const run: AgentRun = async (_bin, args) => {
      if (args[0] === 'auth') return { code: 0, out: '{"loggedIn":true}', timedOut: false };
      if (args[0] === 'models') return { code: 0, out: GROK_MODELS, timedOut: false };
      if (args[0] === 'login') return { code: 1, out: 'Not logged in', timedOut: false };
      return { code: 1, out: 'nope', timedOut: false };
    };
    const list = await discoverAgents(
      { FLEET2_MODELS: 'sonnet,opus' },
      {
        run,
        binFor: async (id) => `/bin/${id}`,
        readText: async () => '{}',
      },
    );
    expect(list.map((a) => [a.id, a.ready, a.resume, a.note, a.models[0]])).toEqual([
      ['claude', true, true, undefined, 'sonnet'],
      ['grok', true, true, undefined, 'grok-4.7'],
      ['codex', false, false, '未登录', undefined],
      ['pi', false, false, '未登录', undefined],
    ]);
  });

  it('一家探测抛了，其余照样列出', async () => {
    const run: AgentRun = async (_bin, args) => {
      if (args[0] === 'models') throw new Error('spawn EINVAL');
      if (args[0] === 'auth') return { code: 0, out: '{"loggedIn":true}', timedOut: false };
      return { code: 1, out: 'Not logged in', timedOut: false };
    };
    const list = await discoverAgents(
      {},
      { run, binFor: async (id) => `/bin/${id}`, readText: async () => '{}' },
    );
    expect(list.find((a) => a.id === 'claude')?.ready).toBe(true);
    expect(list.find((a) => a.id === 'grok')).toMatchObject({ ready: false, note: '没查成登录' });
    expect(list.find((a) => a.id === 'codex')?.note).toBe('未登录');
  });

  it('windows 上 .cmd 经 cmd.exe 跑，不直接 spawn', () => {
    const spec = probeLaunch('D:\\Tools\\node\\codex.cmd', ['login', 'status'], {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    if (process.platform === 'win32') {
      expect(spec.verbatim).toBe(true);
      expect(spec.file.toLowerCase()).toContain('cmd.exe');
      expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(spec.args[3]).toContain('codex.cmd');
      expect(spec.args[3]).toContain('login');
    } else {
      expect(spec).toEqual({
        file: 'D:\\Tools\\node\\codex.cmd',
        args: ['login', 'status'],
        verbatim: false,
      });
    }
    expect(probeLaunch('/bin/grok', ['models'], {})).toEqual({
      file: '/bin/grok',
      args: ['models'],
      verbatim: false,
    });
  });
});

describe('命令', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('claude 续跑带 --resume，权限档是 acceptEdits', () => {
    const first = adeCommand('claude', 'sonnet', id, false);
    const second = adeCommand('claude', 'sonnet', id, true);
    expect(first).toContain('--session-id');
    expect(first).toContain(id);
    expect(second).toContain('--resume');
    expect(second).toContain(id);
    expect(second).not.toContain('--session-id');
    for (const cmd of [first, second]) {
      expect(cmd).toContain('acceptEdits');
      expect(cmd.join(' ')).not.toContain('bypassPermissions');
    }
  });

  it('grok 用 acceptEdits 和 -r，不带 always-approve', () => {
    const extra = { promptFile: 'p.md', cwd: 'C:\\repo' };
    const first = adeCommand('grok', 'grok-4.7', id, false, extra);
    const second = adeCommand('grok', 'grok-4.7', id, true, extra);
    expect(first).toContain('-s');
    expect(second).toContain('-r');
    expect(second).toContain(id);
    expect(second).not.toContain('--continue');
    expect(second).not.toContain('--always-approve');
    expect(second).not.toContain('--yolo');
    expect(second.join(' ')).not.toContain('bypassPermissions');
    expect(second).toContain('--permission-mode');
    expect(second[second.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(second).toContain('--prompt-file');
    expect(second).toContain('streaming-json');
  });

  it('codex 和 pi 不带它们自己的续跑旗标', () => {
    for (const cmd of [adeCommand('codex', 'default', id, true), adeCommand('pi', 'default', id, true)]) {
      expect(cmd.join(' ')).not.toMatch(/resume|--continue|-r\b|-c\b/);
      expect(cmd.join(' ')).not.toContain('bypassPermissions');
    }
  });
});
