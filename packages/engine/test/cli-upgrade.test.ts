// 命令行工具升级（#1971）：会话在跑就拒绝；冒烟或核对不过就退回上一版并锁死；没写渠道不升。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CliToolSpec,
  decide,
  isIdle,
  parseChannel,
  parseUpgradeState,
  readCliToolsConfig,
  runUpgrade,
  type UpgradeIo,
  type UpgradeState,
} from '../src/cli-upgrade.ts';

const NOW = new Date('2026-10-12T00:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const claude = (channel?: string): CliToolSpec => ({
  id: 'claude-code',
  name: 'Claude Code',
  via: 'npm',
  packageName: '@anthropic-ai/claude-code',
  bin: 'claude',
  ...(channel !== undefined ? { channel } : {}),
});

const codex = (channel = 'latest+3d'): CliToolSpec => ({
  id: 'codex',
  name: 'Codex',
  via: 'npm',
  packageName: '@openai/codex',
  bin: 'codex',
  channel,
});

const grok = (channel = 'latest+3d'): CliToolSpec => ({
  id: 'grok',
  name: 'Grok',
  via: 'self-update',
  bin: '/home/fleet-agent-carpool/.grok/bin/grok',
  user: 'fleet-agent-carpool',
  channel,
});

interface Fake extends UpgradeIo {
  installs: string[];
  smokes: number;
  selfs: number;
  restores: number;
}

function fake(over: Partial<UpgradeIo> = {}): Fake {
  const installs: string[] = [];
  const f: Fake = {
    installs,
    smokes: 0,
    selfs: 0,
    restores: 0,
    now: () => NOW,
    sessions: () => 0,
    npmVersion: async (spec) => (spec.endsWith('@stable') ? '2.1.287' : '0.162.1'),
    npmPublishedAt: async () => new Date(NOW.getTime() - 4 * DAY),
    npmInstall: async (spec) => {
      installs.push(spec);
      return { code: 0, stdout: '', stderr: '' };
    },
    npmUninstall: async (pkg) => {
      installs.push(`uninstall ${pkg}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    grokLatestVersion: async () => '1.2.3',
    versionOf: async () => ({ code: 0, stdout: 'claude 2.0.0\n', stderr: '' }),
    smoke: async () => {
      f.smokes += 1;
      return { code: 0, stdout: 'help', stderr: '' };
    },
    installSelf: async () => {
      f.selfs += 1;
      return { code: 0, stdout: '', stderr: '' };
    },
    backup: async () => ({ id: 'bak' }),
    restore: async () => {
      f.restores += 1;
      return { code: 0, stdout: '', stderr: '' };
    },
    ...over,
  };
  return f;
}

function run(tools: CliToolSpec[], io: UpgradeIo, previous: UpgradeState | null = null) {
  return runUpgrade({ tools, previous, io, why: 'idle', requestAt: NOW.toISOString() });
}

describe('渠道', () => {
  it('stable、latest、latest+3d 认得出；空的和别的写法不升', () => {
    expect(parseChannel('stable')).toEqual({ kind: 'stable' });
    expect(parseChannel('latest')).toEqual({ kind: 'latest', minAgeDays: 0 });
    expect(parseChannel('latest+3d')).toEqual({ kind: 'latest', minAgeDays: 3 });
    expect(parseChannel('')).toBeNull();
    expect(parseChannel(undefined)).toBeNull();
    expect(parseChannel('beta')).toBeNull();
    expect(parseChannel('latest+3')).toBeNull();
  });
});

describe('【故意造出的失败】正在跑会话时拒绝升级', () => {
  it('一个二进制都不换，不记失败，下一轮还能再试', async () => {
    const io = fake({ sessions: () => 2 });
    const state = await run([claude('stable'), codex()], io);
    expect(io.installs).toEqual([]);
    expect(io.smokes).toBe(0);
    expect(state.tools['claude-code']).toMatchObject({ outcome: 'refused' });
    expect(state.tools['claude-code']).not.toHaveProperty('failure');
    expect(state.tools.codex?.outcome).toBe('refused');
  });

  it('升到一半出现会话：剩下的不换', async () => {
    let n = 0;
    const io = fake({
      // 开头问一次（还没有），每个工具真要装之前再问一次
      sessions: () => {
        n += 1;
        return n >= 3 ? 1 : 0;
      },
    });
    let version = 'old';
    io.versionOf = async (spec) => {
      const shown = spec.id === 'claude-code' && version === 'new' ? '2.1.287' : '0.1.0';
      if (spec.id === 'codex') return { code: 0, stdout: 'codex 0.1.0\n', stderr: '' };
      return { code: 0, stdout: `claude ${shown}\n`, stderr: '' };
    };
    io.npmInstall = async (spec) => {
      io.installs.push(spec);
      version = 'new';
      return { code: 0, stdout: '', stderr: '' };
    };
    const state = await run([claude('stable'), codex()], io);
    expect(state.tools['claude-code']?.outcome).toBe('ok');
    expect(state.tools.codex?.outcome).toBe('refused');
    expect(io.installs.some((s) => s.includes('@openai/codex'))).toBe(false);
  });
});

describe('冒烟失败会回退', () => {
  it('核对不上就装回上一版，并锁死，不再装第二次', async () => {
    let version = '2.0.0';
    const io = fake({
      npmInstall: async (spec) => {
        io.installs.push(spec);
        const at = spec.lastIndexOf('@');
        version = spec.slice(at + 1);
        return { code: 0, stdout: '', stderr: '' };
      },
      versionOf: async () => ({ code: 0, stdout: `claude ${version}\n`, stderr: '' }),
      smoke: async () => ({ code: 1, stdout: '', stderr: '冒烟崩了' }),
    });
    const state = await run([claude('stable')], io);
    expect(io.installs).toEqual(['@anthropic-ai/claude-code@2.1.287', '@anthropic-ai/claude-code@2.0.0']);
    expect(state.tools['claude-code']).toMatchObject({
      outcome: 'rolled-back',
      version: '2.0.0',
      failure: { reason: expect.stringContaining('冒烟') },
    });
    io.installs.length = 0;
    const again = await run([claude('stable')], io, state);
    expect(io.installs).toEqual([]);
    expect(again.tools['claude-code']?.failure?.at).toBe(state.tools['claude-code']?.failure?.at);
  });

  it('版本对不上也不留在坏版本上；退不回去就记失败', async () => {
    const io = fake({
      versionOf: async () => ({ code: 0, stdout: 'claude 9.9.9\n', stderr: '' }),
      npmInstall: async (spec) => {
        io.installs.push(spec);
        return spec.endsWith('@2.0.0')
          ? { code: 1, stdout: '', stderr: '退不回去' }
          : { code: 0, stdout: '', stderr: '' };
      },
    });
    // 第一次 versionOf 在安装前：让上一版是 2.0.0，装完再问还是 9.9.9
    let calls = 0;
    io.versionOf = async () => {
      calls += 1;
      return { code: 0, stdout: calls === 1 ? 'claude 2.0.0\n' : 'claude 9.9.9\n', stderr: '' };
    };
    const state = await run([claude('stable')], io);
    expect(io.smokes).toBe(0);
    expect(state.tools['claude-code']?.outcome).toBe('failed');
    expect(state.tools['claude-code']?.failure?.reason).toContain('退不回去');
  });
});

describe('没写渠道的工具不升', () => {
  it('没有 channel、空字符串、认不出的渠道都不装', async () => {
    const io = fake();
    const state = await run([claude(), claude('') as never, { ...codex(), channel: 'beta' }], io);
    // 三个规格的 id 会互相覆盖，分开跑
    const missing = await run([claude()], io);
    const empty = await run([{ ...claude(), channel: '  ' }], io);
    const unknown = await run([{ ...codex(), channel: 'beta' }], io);
    expect(io.installs).toEqual([]);
    expect(missing.tools['claude-code']?.detail).toContain('没写渠道');
    expect(empty.tools['claude-code']?.outcome).toBe('skipped');
    expect(unknown.tools.codex?.detail).toContain('认不出');
    expect(state.tools['claude-code']?.outcome).toBe('skipped');
  });

  it('期望里没有 cliTools 就是空名单', () => {
    expect(readCliToolsConfig({ files: {} })).toEqual({ ok: true, tools: [] });
    const parsed = readCliToolsConfig({
      cliTools: {
        tools: {
          'claude-code': {
            name: 'Claude Code',
            via: 'npm',
            package: '@anthropic-ai/claude-code',
            bin: 'claude',
            channel: 'stable',
          },
          cursor: { name: 'Cursor', bin: 'cursor-agent' },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.tools.map((t) => t.id)).toEqual(['claude-code', 'cursor']);
      expect(parsed.tools[1]?.channel).toBeUndefined();
      expect(parsed.tools[1]?.via).toBeNull();
    }
  });
});

describe('latest 要满天数', () => {
  it('发布未满 3 天不装；刚好 3 天装', async () => {
    const young = fake({ npmPublishedAt: async () => new Date(NOW.getTime() - 2 * DAY) });
    const skipped = await run([codex()], young);
    expect(young.installs).toEqual([]);
    expect(skipped.tools.codex?.detail).toContain('未满 3 天');
    expect(skipped.tools.codex?.failure).toBeUndefined();

    const oldEnough = fake({ npmPublishedAt: async () => new Date(NOW.getTime() - 3 * DAY) });
    let version = '0.1.0';
    oldEnough.versionOf = async () => ({ code: 0, stdout: `codex ${version}\n`, stderr: '' });
    oldEnough.npmInstall = async (spec) => {
      oldEnough.installs.push(spec);
      version = '0.162.1';
      return { code: 0, stdout: '', stderr: '' };
    };
    const state = await run([codex()], oldEnough);
    expect(oldEnough.installs).toEqual(['@openai/codex@0.162.1']);
    expect(state.tools.codex).toMatchObject({
      outcome: 'ok',
      version: '0.162.1',
      upgradedAt: NOW.toISOString(),
    });
  });

  it('没有发布时间这轮不升，不锁死', async () => {
    const io = fake({ npmPublishedAt: async () => null });
    const state = await run([codex()], io);
    expect(io.installs).toEqual([]);
    expect(state.tools.codex?.outcome).toBe('skipped');
    expect(state.tools.codex?.failure).toBeUndefined();
  });

  it('Grok 没有发布日：第一次看见只记账，满 3 天再升；渠道改成 latest 就这次升', async () => {
    let shown = '1.0.0';
    const first = fake({
      versionOf: async () => ({ code: 0, stdout: `grok ${shown}\n`, stderr: '' }),
    });
    const seen = await run([grok()], first);
    expect(first.selfs).toBe(0);
    expect(seen.seen?.grok).toEqual({ version: '1.2.3', since: NOW.toISOString() });
    expect(seen.tools.grok?.outcome).toBe('skipped');

    const laterIo = fake({
      now: () => new Date(NOW.getTime() + 3 * DAY),
      versionOf: async () => ({ code: 0, stdout: `grok ${shown}\n`, stderr: '' }),
      installSelf: async () => {
        laterIo.selfs += 1;
        shown = '1.2.3';
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const later = await runUpgrade({
      tools: [grok()],
      previous: seen,
      io: laterIo,
      why: 'idle',
      requestAt: null,
    });
    expect(laterIo.selfs).toBe(1);
    expect(later.tools.grok?.outcome).toBe('ok');

    const immediate = fake({
      versionOf: async () => ({ code: 0, stdout: 'grok 1.0.0\n', stderr: '' }),
      installSelf: async () => {
        immediate.selfs += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    let phase = 0;
    immediate.versionOf = async () => {
      phase += 1;
      return { code: 0, stdout: phase === 1 ? 'grok 1.0.0\n' : 'grok 1.2.3\n', stderr: '' };
    };
    const now = await run([grok('latest')], immediate);
    expect(immediate.selfs).toBe(1);
    expect(now.tools.grok?.outcome).toBe('ok');
  });
});

describe('已经是目标版本', () => {
  it('不重装，也不改上次升级时间', async () => {
    const previous: UpgradeState = {
      schema: 1,
      at: null,
      checkedAt: '2026-10-01T00:00:00.000Z',
      why: 'release',
      tools: {
        'claude-code': {
          name: 'Claude Code',
          version: '2.1.287',
          upgradedAt: '2026-10-01T00:00:00.000Z',
          channel: 'stable',
          outcome: 'ok',
          detail: '升到 2.1.287',
        },
      },
    };
    const io = fake({ versionOf: async () => ({ code: 0, stdout: '2.1.287 (Claude Code)\n', stderr: '' }) });
    const state = await run([claude('stable')], io, previous);
    expect(io.installs).toEqual([]);
    expect(state.tools['claude-code']).toMatchObject({
      outcome: 'current',
      upgradedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('空闲才写请求', () => {
  const idle = {
    now: NOW,
    inFlight: 0,
    masterOn: true,
    intakeFound: [0, 0] as (number | null)[],
    cordon: null,
    pendingAt: null,
    state: null,
  };

  it('总开关开着、这一小时拉单都是 0、没有会话：写请求', () => {
    expect(isIdle(idle)).toBe(true);
    expect(decide(idle)).toMatchObject({ kind: 'request' });
  });

  it('有会话、有候选、总开关开着却没有拉单记录：不写', () => {
    expect(isIdle({ ...idle, inFlight: 1 })).toBe(false);
    expect(isIdle({ ...idle, intakeFound: [0, 2] })).toBe(false);
    expect(isIdle({ ...idle, intakeFound: [] })).toBe(false);
    expect(decide({ ...idle, inFlight: 1 }).kind).toBe('wait');
  });

  it('拉单停（总开关关）且没有候选：空闲；这一小时发现过候选就不是', () => {
    expect(isIdle({ inFlight: 0, masterOn: false, intakeFound: [] })).toBe(true);
    expect(isIdle({ inFlight: 0, masterOn: false, intakeFound: [1] })).toBe(false);
  });

  it('发布在排空、或上次失败还在：不另写请求', () => {
    expect(decide({ ...idle, cordon: { source: 'release', since: NOW.toISOString() } }).kind).toBe('wait');
    const failed: UpgradeState = {
      schema: 1,
      at: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
      why: 'idle',
      tools: {
        codex: {
          name: 'Codex',
          version: '0.1.0',
          upgradedAt: null,
          channel: 'latest+3d',
          outcome: 'rolled-back',
          detail: '已退回',
          failure: { at: NOW.toISOString(), reason: '冒烟失败' },
        },
      },
    };
    const held = decide({ ...idle, state: failed });
    expect(held.kind).toBe('wait');
    expect(held.kind === 'wait' ? held.why : '').toContain('不再重试');
  });

  it('单元回报了就撤；请求还在就等；等太久算卡住', () => {
    const cordon = { source: 'cli-upgrade', since: NOW.toISOString() };
    const pendingAt = NOW.toISOString();
    expect(decide({ ...idle, cordon, pendingAt, state: null }).kind).toBe('hold');
    const done: UpgradeState = {
      schema: 1,
      at: pendingAt,
      checkedAt: new Date(NOW.getTime() + 1000).toISOString(),
      why: 'idle',
      tools: {},
    };
    expect(decide({ ...idle, cordon, pendingAt, state: done }).kind).toBe('finish');
    expect(
      decide({
        ...idle,
        now: new Date(NOW.getTime() + 45 * 60_000),
        cordon,
        pendingAt,
        state: null,
      }).kind,
    ).toBe('stuck');
  });

  it('刚核对过且没有要装的，6 小时内不再排空', () => {
    const state: UpgradeState = {
      schema: 1,
      at: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
      why: 'idle',
      tools: {
        'claude-code': {
          name: 'Claude Code',
          version: '2.1.287',
          upgradedAt: null,
          channel: 'stable',
          outcome: 'current',
          detail: '已是',
        },
      },
    };
    expect(decide({ ...idle, state }).kind).toBe('wait');
    expect(parseUpgradeState(state)?.schema).toBe(1);
    expect(parseUpgradeState({ schema: 2 })).toBeNull();
  });
});

describe('期望里的渠道', () => {
  it('Claude Code 跟 stable，Codex 和 Grok 跟 latest+3d，Cursor 和 reclaude 不写渠道', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../../deploy/france/desired-config.json', import.meta.url), 'utf8'),
    ) as unknown;
    const parsed = readCliToolsConfig(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const byId = Object.fromEntries(parsed.tools.map((t) => [t.id, t]));
    expect(byId['claude-code']).toMatchObject({
      channel: 'stable',
      via: 'npm',
      prefix: '/usr',
      packageName: '@anthropic-ai/claude-code',
      bin: '/usr/bin/claude',
    });
    expect(byId.codex).toMatchObject({ channel: 'latest+3d', via: 'npm', prefix: '/usr' });
    expect(byId.grok).toMatchObject({ channel: 'latest+3d', via: 'self-update' });
    expect(byId['cursor-agent']?.channel).toBeUndefined();
    expect(byId.reclaude?.channel).toBeUndefined();
  });

  it('npm 装进 prefix，环境清干净', () => {
    const main = readFileSync(new URL('../src/cli-upgrade-main.ts', import.meta.url), 'utf8');
    expect(main).toContain("'--prefix'");
    expect(main).toContain('npm_config_update_notifier');
    expect(main).toContain("HOME: '/root'");
  });
});

describe('发版窗口的位置', () => {
  it('等收尾之后、切版本之前才升级', () => {
    const sh = readFileSync(new URL('../../../deploy/release.sh', import.meta.url), 'utf8');
    const body = /do_release\(\) \{[\s\S]*?\n\}/.exec(sh)?.[0] ?? '';
    const drain = body.indexOf('maybe_drain_engine "$SHA"');
    const up = body.indexOf('upgrade_cli_tools');
    const migrate = body.indexOf('migrate "$SHA"');
    const activate = body.indexOf('activate "$SHA"');
    expect(drain).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(drain);
    expect(migrate).toBeGreaterThan(up);
    expect(activate).toBeGreaterThan(up);
    const fn = /upgrade_cli_tools\(\) \{[\s\S]*?\n\}/.exec(sh)?.[0] ?? '';
    expect(fn).toContain('wanted.json');
    expect(fn).toContain('--release-window');
    expect(fn).not.toContain('red ');
    // 引擎运行内容没变、没停（deploy/lib/runtime-same.mjs）：不在发版窗口换，留给空闲升级
    expect(fn).toContain('SKIP_RESTART[fleet-engine]');
  });
});
