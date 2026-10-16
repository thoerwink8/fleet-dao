// fleet-api flow-mode：全程模式开关（设置 engine.flowMode，#2823）的运维命令。status 只看、set <值> --reason "<原因>" 改并记操作记录。
// 读不到、认不出按 three 并说出来；没做成的每条路（参数不对、连不上库、写库出错）退出码非 0、说清原因。
import { FLOW_MODE_SETTING } from '@fleet-dao/shared';
import { createMemoryStore, devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type CliDeps, CliError, flowMode, main, parseFlowModeArgs } from '../src/cli.ts';
import type { Store } from '../src/ports.ts';

const T0 = new Date('2026-10-16T13:00:00.000Z');

function setup() {
  const store = createMemoryStore(devFixtures(T0), { now: () => T0 });
  const row = () => store.data.settings.find((s) => s.key === FLOW_MODE_SETTING);
  const audits = () => store.data.audit.filter((a) => a.target === `setting:${FLOW_MODE_SETTING}`);
  const out: string[] = [];
  const err: string[] = [];
  const deps = (s: Store = store, env: CliDeps['env'] = {}): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root', ...env },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => T0,
    openStore: async () => ({ store: s, close: async () => {} }),
  });
  const run = (args: string[], s?: Store) => main(['flow-mode', ...args], deps(s));
  return { store, row, audits, out, err, deps, run };
}

const write = (s: Store, value: unknown) =>
  s.putSetting(
    { key: FLOW_MODE_SETTING, value, expectedVersion: 0, by: { kind: 'user', id: 'x' } },
    { actor: { kind: 'user', id: 'x' }, action: 'setting.update', target: 's', via: 'cockpit', ok: true },
  );

describe('参数', () => {
  it('status，或 set <值> --reason <原因>；别的写法一律拒（退出码 2），不猜', () => {
    for (const argv of [
      [],
      ['on'],
      ['status', '--reason', 'x'],
      ['set'],
      ['set', 'full'],
      ['set', 'full', '--reason'],
      ['set', 'full', '--reason', '  '],
      ['set', '--reason', 'x', 'full'],
      ['set', 'half', '--reason', 'x'],
      ['set', 'split:101', '--reason', 'x'],
      ['set', 'full', '--reason', 'x', 'y'],
    ]) {
      let caught: unknown;
      try {
        parseFlowModeArgs(argv);
      } catch (e) {
        caught = e;
      }
      expect(caught, argv.join(' ')).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode, argv.join(' ')).toBe(2);
    }
    expect(parseFlowModeArgs(['status'])).toEqual({ action: 'status' });
    expect(parseFlowModeArgs(['set', 'split:50', '--reason', '先试对半'])).toEqual({
      action: 'set',
      value: 'split:50',
      reason: '先试对半',
    });
  });
});

describe('status', () => {
  it('没设过：按 three（默认），写明从没设过', async () => {
    const t = setup();
    const text = await flowMode({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(text).toContain('三步');
    expect(text).toContain('从没设过');
    expect(t.row()).toBeUndefined();
  });

  it('认不出的值：按 three，并把认不出和原值报出来，不悄悄当成三段', async () => {
    const t = setup();
    await write(t.store, 'half');
    const text = await flowMode({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(text).toContain('三步');
    expect(text).toContain('认不出');
    expect(text).toContain('half');
  });
});

describe('set', () => {
  it('改成 split:50：设置写上字符串、updatedBy 记 ops，同一事务记一条操作记录，原因带上', async () => {
    const t = setup();
    const text = await flowMode({
      store: t.store,
      args: { action: 'set', value: 'split:50', reason: '先对半试点' },
      operator: 'root',
    });
    expect(text).toContain('已改');
    expect(t.row()?.value).toBe('split:50');
    expect(t.row()?.updatedBy).toBe('ops:flow-mode');
    const [a] = t.audits();
    expect(t.audits()).toHaveLength(1);
    expect(a?.action).toBe('engine.flowMode.set');
    expect(a?.before).toBeNull();
    expect(a?.after).toBe('split:50');
    expect(a?.reason).toContain('先对半试点');
    expect(a?.reason).toContain('fleet-api flow-mode set');
    expect(a?.actor).toEqual({ kind: 'ops', id: 'ops:flow-mode' });
    expect(a?.via).toBe('ops');
  });

  it('已经是这个值：不改不记；再改成别的值，before 是上一个值', async () => {
    const t = setup();
    const set = (value: string) =>
      flowMode({ store: t.store, args: { action: 'set', value, reason: 'r' }, operator: 'root' });
    await set('full');
    expect(await set('full')).toContain('没改');
    expect(t.audits()).toHaveLength(1);
    await set('three');
    expect(t.audits()).toHaveLength(2);
    expect(t.audits().at(-1)?.before).toBe('full');
    expect(t.audits().at(-1)?.after).toBe('three');
  });

  it('没设过就设成 three：也要写一行（把「默认」变成人定的），记操作记录', async () => {
    const t = setup();
    const text = await flowMode({
      store: t.store,
      args: { action: 'set', value: 'three', reason: '明确定下' },
      operator: 'root',
    });
    expect(text).toContain('已改');
    expect(t.row()?.value).toBe('three');
  });

  it('库里原来是认不出的值：改成 three 也算改（不拿认不出的值当「已经是 three」）', async () => {
    const t = setup();
    await write(t.store, 'half');
    const text = await flowMode({
      store: t.store,
      args: { action: 'set', value: 'three', reason: '清掉写坏的值' },
      operator: 'root',
    });
    expect(text).toContain('已改');
    expect(t.row()?.value).toBe('three');
  });
});

describe('入口', () => {
  it('参数不对：退出码 2、不改；没带库连接也是 2', async () => {
    const t = setup();
    expect(await t.run(['set', 'half', '--reason', 'x'])).toBe(2);
    expect(t.err.at(-1)).toContain('认不出');
    expect(await main(['flow-mode', 'status'], t.deps(t.store, { DATABASE_URL: undefined }))).toBe(2);
    expect(t.row()).toBeUndefined();
  });

  it('看、改、再看：退出码 0', async () => {
    const t = setup();
    expect(await t.run(['status'])).toBe(0);
    expect(await t.run(['set', 'full', '--reason', '试点开全程'])).toBe(0);
    expect(await t.run(['status'])).toBe(0);
    expect(t.out.at(-1)).toContain('全程');
  });

  it('--help 列得出来', async () => {
    const t = setup();
    expect(await t.run(['--help'])).toBe(0);
    expect(t.out.at(-1)).toContain('fleet-api flow-mode');
  });

  it('连不上库：退出码 1，什么都没改', async () => {
    const t = setup();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const broken = new Proxy(t.store, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function'
          ? async () => {
              throw new Error('Failed query: select from settings', { cause: refused });
            }
          : value;
      },
    });
    expect(await t.run(['set', 'full', '--reason', 'x'], broken)).toBe(1);
    expect(t.err.at(-1)).toContain('连不上库');
    expect(t.row()).toBeUndefined();
  });
});
