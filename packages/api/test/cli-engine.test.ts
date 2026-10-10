// fleet-api engine：引擎总开关（设置 engine.master，#1086）的运维命令。开、关、只看；写和命令行外那条路
// （驾驶舱 PUT /settings/engine.master、发版脚本）是同一个设置键、同一对操作记录名。
// 没做成的每条路（参数不对、连不上库、写库出错、版本冲突）都故意造一遍：退出码非 0，说清原因。
import { describeEngineMaster, ENGINE_MASTER_SETTING } from '@fleet-dao/shared';
import { createMemoryStore, devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type CliDeps, CliError, engine, main, parseEngineArgs } from '../src/cli.ts';
import type { Store } from '../src/ports.ts';

const T0 = new Date('2026-10-05T13:00:00.000Z');

function setup() {
  const clock = { now: new Date(T0) };
  const store = createMemoryStore(devFixtures(T0), { now: () => clock.now });
  const row = () => store.data.settings.find((s) => s.key === ENGINE_MASTER_SETTING);
  const out: string[] = [];
  const err: string[] = [];
  const deps = (s: Store = store, env: CliDeps['env'] = {}): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root', ...env },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => T0,
    openStore: async () => ({ store: s, close: async () => {} }),
  });
  const run = (args: string[], s?: Store) => main(['engine', ...args], deps(s));
  return { clock, store, row, out, err, deps, run };
}

/** 每个方法都抛同一种错的 Store（连不上库）。 */
function failingStore(base: Store, err: () => unknown): Store {
  return new Proxy(base, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function'
        ? async () => {
            throw err();
          }
        : value;
    },
  });
}

describe('参数', () => {
  it('恰好一个动作（on、off、status），可选 --reason <原因>；别的写法一律拒（退出码 2），不猜', () => {
    for (const argv of [
      [],
      ['ON'],
      ['enable'],
      ['on', 'now'],
      ['on', '--force'],
      ['status', '--reason', 'x'],
      ['on', '--reason'],
      ['on', '--reason', '  '],
      ['--reason', 'x', 'on'],
    ]) {
      let caught: unknown;
      try {
        parseEngineArgs(argv);
      } catch (e) {
        caught = e;
      }
      expect(caught, argv.join(' ')).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode, argv.join(' ')).toBe(2);
    }
    expect(parseEngineArgs(['on'])).toEqual({ action: 'on' });
    expect(parseEngineArgs(['off', '--reason', '发版 v4 自动置关'])).toEqual({
      action: 'off',
      reason: '发版 v4 自动置关',
    });
    expect(parseEngineArgs(['status'])).toEqual({ action: 'status' });
    expect(parseEngineArgs(['heal-orphan'])).toEqual({ action: 'heal-orphan' });
  });
});

describe('status', () => {
  it('没设过：关（默认关），写明从没设过', async () => {
    const t = setup();
    const text = await engine({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(text).toContain('关着');
    expect(text).toContain('从没设过');
    expect(t.row()).toBeUndefined();
  });

  it('设过：开着/关着照实说，带谁什么时候改的，并带操作记录', async () => {
    const t = setup();
    await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    const text = await engine({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(text).toContain('开着');
    expect(text).toContain('ops:engine');
    expect(text).toContain('最近一次开关');
    expect(text).toContain('打开');
  });

  it('发版前暂停后未开回（#1739）：status 写明断链，heal-orphan 开回', async () => {
    const t = setup();
    await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    await engine({
      store: t.store,
      args: { action: 'off', reason: '发版前暂停（驾驶舱点击发布，目标 45401408114c）' },
      operator: 'root',
    });
    const status = await engine({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(status).toContain('断链');
    expect(status).toContain('发版前暂停');
    expect(status).toContain('ops:engine');
    const healed = await engine({ store: t.store, args: { action: 'heal-orphan' }, operator: 'root' });
    expect(healed).toContain('已打开');
    expect(t.row()?.value).toBe(true);
    const again = await engine({ store: t.store, args: { action: 'heal-orphan' }, operator: 'root' });
    expect(again).toContain('没改');
  });

  it('人手关着：heal-orphan 不动', async () => {
    const t = setup();
    await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    await engine({
      store: t.store,
      args: { action: 'off', reason: '有意关着，预计明日重开' },
      operator: 'root',
    });
    const text = await engine({ store: t.store, args: { action: 'heal-orphan' }, operator: 'root' });
    expect(text).toContain('不是发版暂停后未恢复');
    expect(t.row()?.value).toBe(false);
  });
});

describe('on/off', () => {
  it('开：设置写上 true、updatedBy 记谁改的，同一事务记一条操作记录；读回对得上', async () => {
    const t = setup();
    const text = await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    expect(text).toContain('已打开');
    const row = t.row();
    expect(row?.value).toBe(true);
    expect(row?.updatedBy).toBe('ops:engine');
    const audits = t.store.data.audit.filter((a) => a.target === `setting:${ENGINE_MASTER_SETTING}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('engine.master.enable');
  });

  it('已经开着再开：不改、不记操作记录（开着再开不重设时刻）', async () => {
    const t = setup();
    await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    const before = t.row();
    const text = await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    expect(text).toContain('没改');
    expect(t.row()?.updatedAt).toBe(before?.updatedAt);
    expect(t.store.data.audit.filter((a) => a.target === `setting:${ENGINE_MASTER_SETTING}`)).toHaveLength(1);
  });

  it('关：设置写上 false 并记一条 disable 操作记录；带 --reason 的原因进操作记录', async () => {
    const t = setup();
    await engine({ store: t.store, args: { action: 'on' }, operator: 'root' });
    const text = await engine({
      store: t.store,
      args: { action: 'off', reason: '发版 v4 自动置关' },
      operator: 'root',
    });
    expect(text).toContain('已关上');
    expect(t.row()?.value).toBe(false);
    const last = t.store.data.audit.filter((a) => a.target === `setting:${ENGINE_MASTER_SETTING}`).at(-1);
    expect(last?.action).toBe('engine.master.disable');
    expect(last?.reason).toContain('发版 v4 自动置关');
    expect(last?.reason).toContain('fleet-api engine off');
  });

  it('没设过就关：不关不记（默认就是关），说一句本来就关着', async () => {
    const t = setup();
    const text = await engine({ store: t.store, args: { action: 'off' }, operator: 'root' });
    expect(text).toContain('没改');
    expect(t.row()).toBeUndefined();
    expect(t.store.data.audit.filter((a) => a.target === `setting:${ENGINE_MASTER_SETTING}`)).toHaveLength(0);
  });
});

describe('读法（shared 的 engineMasterOf 经 describeEngineMaster 给人看）', () => {
  it('认不出的值按关算，写明为什么不拿它当开', async () => {
    const t = setup();
    await t.store.putSetting(
      {
        key: ENGINE_MASTER_SETTING,
        value: { 开: 1 },
        expectedVersion: 0,
        by: { kind: 'engine', id: 'x' },
      },
      { actor: { kind: 'engine', id: 'x' }, action: 'setting.update', target: 's', via: 'engine', ok: true },
    );
    const text = await engine({ store: t.store, args: { action: 'status' }, operator: 'root' });
    expect(text).toContain('关着');
    expect(text).toContain('认不出');
    expect(describeEngineMaster({ on: false, why: 'unreadable' })).toContain('认不出');
  });
});

describe('入口（退出码和故意造出的失败）', () => {
  it('参数不对：退出码 2、不连库；没带库连接也是 2', async () => {
    const t = setup();
    expect(await t.run(['enable'])).toBe(2);
    expect(t.err.at(-1)).toContain('只收 on、off、status、heal-orphan');
    expect(await main(['engine', 'on'], t.deps(t.store, { DATABASE_URL: undefined }))).toBe(2);
    expect(t.err.at(-1)).toContain('DATABASE_URL');
    expect(t.row()).toBeUndefined();
  });

  it('开、看、关一圈：退出码 0，每次打印里有「引擎总开关」', async () => {
    const t = setup();
    expect(await t.run(['on', '--reason', '创始人在驾驶舱点了开'])).toBe(0);
    expect(t.out.at(-1)).toContain('已打开');
    expect(await t.run(['status'])).toBe(0);
    expect(t.out.at(-1)).toContain('开着');
    expect(await t.run(['off'])).toBe(0);
    expect(t.out.at(-1)).toContain('已关上');
  });

  it('连不上库：退出码 1、说清是连不上库，什么都没改', async () => {
    const t = setup();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const broken = failingStore(
      t.store,
      () => new Error('Failed query: select from settings', { cause: refused }),
    );
    expect(await t.run(['on'], broken)).toBe(1);
    expect(t.err.at(-1)).toContain('连不上库');
    expect(t.err.at(-1)).toContain('没改成');
    expect(t.row()).toBeUndefined();
  });

  it('刚被别处改过（版本对不上）：退出码 1，不假装改成了', async () => {
    const t = setup();
    // 命令读到的版本和写时的版本之间被人改了一次：写入口只认「读时版本」，对不上就返回冲突
    let first = true;
    const racing: Store = new Proxy(t.store, {
      get(target, key, receiver) {
        if (key !== 'putSetting') return Reflect.get(target, key, receiver);
        return async (...args: Parameters<Store['putSetting']>) => {
          if (first) {
            first = false;
            // 别处先把总开关设成开
            await target.putSetting(
              {
                key: ENGINE_MASTER_SETTING,
                value: true,
                expectedVersion: 0,
                by: { kind: 'user', id: 'other' },
              },
              {
                actor: { kind: 'user', id: 'other' },
                action: 'setting.update',
                target: 's',
                via: 'cockpit',
                ok: true,
              },
            );
          }
          return target.putSetting(...args);
        };
      },
    });
    expect(await t.run(['on'], racing)).toBe(1);
    expect(t.err.at(-1)).toContain('刚被别处改过');
  });
});
