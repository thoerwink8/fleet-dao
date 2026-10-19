import { mkdirSync, realpathSync as realpath, symlinkSync, unlinkSync as unlink } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks, checkHooks, hookCommand } from '../src/hooks.ts';
import { codexHookHash, scanCodexConfig, tomlString } from '../src/hooks-codex.ts';
import * as sync from '../src/sync.ts';
import { HOOK_TARGETS, type HookSpec } from '../src/targets.ts';
import {
  cleanup,
  ctxFor,
  get,
  getJson,
  HOOK_FILES,
  makeRepo,
  PLATFORM,
  put,
  sources,
  tempDir,
} from './helpers.ts';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture 缺少预期入口');
  return value;
}
const codex = required(HOOK_TARGETS.find((t) => t.format === 'codex'));
const originalSpecs = codex.hooks;
afterEach(() => {
  codex.hooks = originalSpecs;
});

type Handler = { type?: string; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Handler[] };
type Root = { hooks: Record<string, Group[]> };
function handler(root: Root, event: string, group = 0, index = 0): Handler {
  return required(required(required(root.hooks[event])[group]).hooks[index]);
}
const relay = '.mirasim/agent-homes/codex-relay';

function machine(layout = 'default') {
  const home = tempDir('codex-migration');
  const ctx = ctxFor(home, ['codex']);
  const src = sources(
    makeRepo({}, undefined, {
      ...HOOK_FILES,
      'stop-codex.mjs': '// fixture only\n',
      'continuation-progress-codex.mjs': '// fixture only\n',
    }),
  );
  if (layout !== 'default') mkdirSync(join(home, relay), { recursive: true });
  const apply = () => applyHooks(ctx, src, new Backups(home, PLATFORM, new Date('2026-10-19T00:00:00Z')));
  apply();
  if (layout === 'shared-hooks' || layout === 'shared-both') {
    put(home, `${relay}/hooks.json`, '');
    // 链接替换的是本测试刚产生的文件，绝不触碰用户配置。
    const link = join(home, relay, 'hooks.json');
    unlink(link);
    symlinkSync(join(home, '.codex/hooks.json'), link, 'file');
  }
  if (layout === 'shared-config' || layout === 'shared-both') {
    const link = join(home, relay, 'config.toml');
    unlink(link);
    symlinkSync(join(home, '.codex/config.toml'), link, 'file');
  }
  if (layout.startsWith('shared')) apply();
  const base = layout === 'default' ? '.codex' : relay;
  const config =
    layout === 'shared-config' || layout === 'shared-both' ? '.codex/config.toml' : `${base}/config.toml`;
  return {
    home,
    ctx,
    src,
    apply,
    base,
    config,
    key: (event: string, group: number, handler = 0) =>
      `${join(realpath.native(join(home, base)), 'hooks.json')}:${event}:${group}:${handler}`,
  };
}

function entries(text: string) {
  const scanned = scanCodexConfig(text);
  if (!scanned.ok) throw new Error(scanned.why);
  return scanned.value.entries;
}

function useDedicatedSpecs() {
  codex.hooks = originalSpecs.map(
    (spec): HookSpec => ({
      ...spec,
      script:
        spec.event === 'Stop'
          ? 'stop-codex.mjs'
          : spec.event === 'PostToolUse'
            ? 'continuation-progress-codex.mjs'
            : spec.script,
    }),
  );
}

it('受管Stop先于第三方时，修正timeout不能把人为disabled丢到旧位置', () => {
  const home = tempDir('codex-disabled-migration');
  const ctx = ctxFor(home, ['codex']);
  const src = sources(makeRepo({}, undefined, HOOK_FILES));
  const apply = () => applyHooks(ctx, src, new Backups(home, PLATFORM, new Date('2026-10-19T00:00:00Z')));
  apply();
  const root = getJson(home, '.codex/hooks.json') as {
    hooks: { Stop: { hooks: { command: string; timeout?: number }[] }[] };
  };
  const thirdParty = { hooks: [{ command: 'python third-party.py' }] };
  handler(root, 'Stop').timeout = 11;
  root.hooks.Stop.push(thirdParty);
  put(home, '.codex/hooks.json', JSON.stringify(root));
  put(
    home,
    '.codex/config.toml',
    get(home, '.codex/config.toml').replace(/(\[hooks\.state\."[^\n]*stop:0:0"\]\n)/, '$1enabled = false\n'),
  );
  apply();
  const next = getJson(home, '.codex/hooks.json') as typeof root;
  const at = next.hooks.Stop.findIndex((g) =>
    g.hooks.some((h) => h.command === hookCommand(home, PLATFORM, 'stop.mjs')),
  );
  const scanned = scanCodexConfig(get(home, '.codex/config.toml'));
  if (!scanned.ok) throw new Error(scanned.why);
  const key = `${join(realpath.native(join(home, '.codex')), 'hooks.json')}:stop:${at}:0`;
  expect(scanned.value.entries.get(key)?.enabled?.value).toBe(false);
  expect(next.hooks.Stop.filter((g) => g.hooks.some((h) => h.command === 'python third-party.py'))).toEqual([
    thirdParty,
  ]);
  expect(checkHooks(ctx, src).some((l) => l.text.includes('enabled = false'))).toBe(true);
});

it.each(['default', 'independent', 'shared-hooks', 'shared-config', 'shared-both'])(
  '%s：旧Stop/PostToolUse迁专用入口仍绑定原位disabled，第三方顺序与信任不变',
  (layout) => {
    const m = machine(layout);
    const root = getJson(m.home, `${m.base}/hooks.json`) as Root;
    const third = { hooks: [{ type: 'command', command: 'python third-party.py' }] };
    for (const event of ['Stop', 'PostToolUse']) required(root.hooks[event]).push(third);
    // shared-hooks必须通过默认普通路径写，测试也不写穿共享链接。
    put(
      m.home,
      layout === 'shared-hooks' || layout === 'shared-both' ? '.codex/hooks.json' : `${m.base}/hooks.json`,
      JSON.stringify(root),
    );
    let text = get(m.home, m.config);
    for (const event of ['stop', 'post_tool_use']) {
      const key = m.key(event, 0);
      text = text.replace(
        `[hooks.state.${tomlString(key)}]\n`,
        `[hooks.state.${tomlString(key)}]\nenabled = false\n`,
      );
    }
    const thirdKey = m.key('stop', 1);
    text += `\n[hooks.state.${tomlString(thirdKey)}]\ntrusted_hash = "third-original-hash"\nenabled = false\n`;
    put(m.home, m.config, text);
    useDedicatedSpecs();
    const applied = m.apply();
    expect(applied.some((l) => l.kind === 'failed' && l.text.includes('enabled = false'))).toBe(true);
    const after = getJson(m.home, `${m.base}/hooks.json`) as Root;
    const states = entries(get(m.home, m.config));
    for (const [event, label, script] of [
      ['Stop', 'stop', 'stop-codex.mjs'],
      ['PostToolUse', 'post_tool_use', 'continuation-progress-codex.mjs'],
    ] as const) {
      expect(handler(after, event).command).toBe(hookCommand(m.home, PLATFORM, script));
      expect(states.get(m.key(label, 0))?.enabled?.value).toBe(false);
      expect(states.get(m.key(label, 0))?.trustedHash?.value).toBe(
        codexHookHash(event, undefined, hookCommand(m.home, PLATFORM, script), 10),
      );
      expect(required(after.hooks[event])[1]).toEqual(third);
    }
    expect(states.get(thirdKey)?.trustedHash?.value).toBe('third-original-hash');
    expect(states.get(thirdKey)?.enabled?.value).toBe(false);
    const stable = get(m.home, m.config);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
    expect(get(m.home, m.config)).toBe(stable);
    expect(checkHooks(m.ctx, m.src).some((l) => l.text.includes('enabled = false'))).toBe(true);
  },
);

it('同组第三方夹着受管handler：保留两侧位置、内容与块外点号enabled', () => {
  const m = machine();
  const root = getJson(m.home, '.codex/hooks.json') as Root;
  const managed = handler(root, 'Stop');
  const before = { type: 'command', command: 'python before.py' };
  const after = { type: 'command', command: 'python after.py' };
  root.hooks.Stop = [{ hooks: [before, managed, after] }];
  put(m.home, '.codex/hooks.json', JSON.stringify(root));
  const ownKey = m.key('stop', 0, 1);
  const thirdKey = m.key('stop', 0, 2);
  const config = `hooks.state.${tomlString(ownKey)}.enabled = false\nhooks.state.${tomlString(thirdKey)}.enabled = false\nhooks.state.${tomlString(thirdKey)}.trusted_hash = "keep-third"\n`;
  put(m.home, m.config, config);
  useDedicatedSpecs();
  m.apply();
  const next = getJson(m.home, '.codex/hooks.json') as Root;
  expect(required(required(next.hooks.Stop)[0]).hooks).toEqual([
    before,
    { ...managed, command: hookCommand(m.home, PLATFORM, 'stop-codex.mjs') },
    after,
  ]);
  expect(get(m.home, m.config)).toContain(config);
  expect(entries(get(m.home, m.config)).get(ownKey)?.enabled?.value).toBe(false);
  expect(entries(get(m.home, m.config)).get(ownKey)?.trustedHash?.value).toBe(
    codexHookHash('Stop', undefined, hookCommand(m.home, PLATFORM, 'stop-codex.mjs'), 10),
  );
  expect(entries(get(m.home, m.config)).get(thirdKey)?.trustedHash?.value).toBe('keep-third');
});

it.each(['table', 'dotted'])('块外%s受管disabled同时刷新真实新hash，保留enabled行', (style) => {
  const m = machine();
  const key = m.key('stop', 0);
  const head = `[hooks.state.${tomlString(key)}]\n`;
  const enabled = style === 'table' ? 'enabled = false' : `hooks.state.${tomlString(key)}.enabled = false`;
  const hash = style === 'table' ? 'trusted_hash' : `hooks.state.${tomlString(key)}.trusted_hash`;
  const before = `${style === 'table' ? head : ''}${enabled}\n${hash} = "sha256:old"\n`;
  put(m.home, m.config, before);
  useDedicatedSpecs();
  m.apply();
  const after = get(m.home, m.config);
  expect(after).toContain(enabled);
  expect(entries(after).get(key)?.enabled?.value).toBe(false);
  expect(entries(after).get(key)?.trustedHash?.value).toBe(
    codexHookHash('Stop', undefined, hookCommand(m.home, PLATFORM, 'stop-codex.mjs'), 10),
  );
});

it('新命令信任计划不能安全改写时，首写JSON之前拒绝，两文件重试原样', () => {
  const m = machine();
  const key = m.key('stop', 0);
  const before = `hooks.state.${tomlString(key)}.trusted_hash = "sha256:old"\n`;
  const json = get(m.home, '.codex/hooks.json');
  put(m.home, m.config, before);
  useDedicatedSpecs();
  for (let n = 0; n < 2; n++) {
    expect(m.apply().some((l) => l.kind === 'failed' && l.text.includes('预检新命令'))).toBe(true);
    expect(get(m.home, '.codex/hooks.json')).toBe(json);
    expect(get(m.home, m.config)).toBe(before);
  }
});

it('JSON原位换入口后信任写入失败：旧disabled仍生效，重试完成hash更新', () => {
  const m = machine();
  const key = m.key('stop', 0);
  put(
    m.home,
    m.config,
    get(m.home, m.config).replace(
      `[hooks.state.${tomlString(key)}]\n`,
      `[hooks.state.${tomlString(key)}]\nenabled = false\n`,
    ),
  );
  useDedicatedSpecs();
  const write = sync.writeAtomic;
  const spy = vi.spyOn(sync, 'writeAtomic').mockImplementation((file, ...args) => {
    if (file.endsWith('config.toml')) throw new Error('fixture: config write failed after hooks');
    return write(file, ...args);
  });
  expect(m.apply().some((l) => l.kind === 'failed' && l.text.includes('config write failed'))).toBe(true);
  expect(handler(getJson(m.home, '.codex/hooks.json') as Root, 'Stop').command).toBe(
    hookCommand(m.home, PLATFORM, 'stop-codex.mjs'),
  );
  expect(entries(get(m.home, m.config)).get(key)?.enabled?.value).toBe(false);
  spy.mockRestore();
  m.apply();
  expect(entries(get(m.home, m.config)).get(key)?.enabled?.value).toBe(false);
  expect(entries(get(m.home, m.config)).get(key)?.trustedHash?.value).toBe(
    codexHookHash('Stop', undefined, hookCommand(m.home, PLATFORM, 'stop-codex.mjs'), 10),
  );
});

it.each(['duplicate', 'retired-before-third', 'retired-in-group'])(
  '%s：会将旧有状态位置转给别人的迁移在JSON/config首写之前拒绝，重试也不丢disabled',
  (shape) => {
    const m = machine();
    const root = getJson(m.home, '.codex/hooks.json') as Root;
    const managed = handler(root, 'Stop');
    const retired = { type: 'command', command: hookCommand(m.home, PLATFORM, 'retired.mjs'), timeout: 10 };
    const third = { type: 'command', command: 'python third.py' };
    root.hooks.Stop =
      shape === 'duplicate'
        ? [{ hooks: [managed] }, { hooks: [managed] }]
        : shape === 'retired-before-third'
          ? [{ hooks: [retired] }, { hooks: [third] }, { hooks: [managed] }]
          : [{ hooks: [retired, third, managed] }];
    const json = JSON.stringify(root);
    const text = `hooks.state.${tomlString(m.key('stop', 0))}.enabled = false\n`;
    put(m.home, '.codex/hooks.json', json);
    put(m.home, m.config, text);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(m.apply().some((l) => l.kind === 'failed' && /归属|身份/.test(l.text))).toBe(true);
      expect(get(m.home, '.codex/hooks.json')).toBe(json);
      expect(get(m.home, m.config)).toBe(text);
    }
  },
);

it('受管项前后各有第三方组且总开关false：只原位更命令、保留总开关和独立第三方信任', () => {
  const m = machine();
  const root = getJson(m.home, '.codex/hooks.json') as Root;
  const managed = required(required(root.hooks.Stop)[0]);
  const first = { hooks: [{ type: 'command', command: 'python first.py' }] };
  const last = { hooks: [{ type: 'command', command: 'python last.py' }] };
  root.hooks.Stop = [first, managed, last];
  put(m.home, '.codex/hooks.json', JSON.stringify(root));
  const config = `[features]\nhooks = false\n\n[hooks.state.${tomlString(m.key('stop', 1))}]\nenabled = false\n\n[hooks.state.${tomlString(m.key('stop', 2))}]\ntrusted_hash = "keep-last"\nenabled = true\n`;
  put(m.home, m.config, config);
  useDedicatedSpecs();
  m.apply();
  const next = getJson(m.home, '.codex/hooks.json') as Root;
  expect(required(next.hooks.Stop)[0]).toEqual(first);
  expect(required(next.hooks.Stop)[2]).toEqual(last);
  expect(entries(get(m.home, m.config)).get(m.key('stop', 1))?.enabled?.value).toBe(false);
  expect(entries(get(m.home, m.config)).get(m.key('stop', 2))?.trustedHash?.value).toBe('keep-last');
  expect(get(m.home, m.config)).toContain('hooks = false');
});
