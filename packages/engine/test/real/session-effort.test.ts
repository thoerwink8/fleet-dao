// #470「怎么算做完」：驾驶舱改一个模型（路由）的档位，下一个起的会话命令行里带的就是新档位；没配用 high；配置读不到或写错就报错、
// 不起会话。真库（PGlite）里的路由两层 + 生产 Spawner + 真驱动（只把起进程那一步换成假插头），档位从库里现读、经驱动合成、
// 拼进命令行（和插头起 reclaude、grok 用的是同一个参数拼法）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, buildGrokArgs } from '@fleet-dao/adapters';
import { routingCatalog, setRoutingEffort } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type HostRunners, hostDrivers } from '../../src/real/hosts.ts';
import { hostSegmentSpawner, type SegmentSpawnerDeps } from '../../src/real/segment-spawner.ts';
import { type OneShotInput, runOneShot } from '../../src/runner/one-shot.ts';
import { addGrokRoute, fakeGrokRun, fakeMirasimDeps, fakeRun, grokAnswered, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let tmp: string;
beforeEach(async () => {
  await resetTestDb(t);
  // 两条 Claude Code 路由（solo、carpool，模型 opus-5.5）挂在路由两层里，档位都没配
  await world(t.db);
  tmp = mkdtempSync(join(tmpdir(), 'fleet-session-effort-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function rig(over: Partial<SegmentSpawnerDeps> = {}) {
  const claude = fakeRun(() => ({ result: { text: 'OK' } }));
  const grok = fakeGrokRun(() => ({ frames: grokAnswered() }));
  const run: HostRunners = { 'claude-code': claude.run, grok: grok.run };
  const spawn = hostSegmentSpawner({
    db: t.db,
    drivers: hostDrivers({
      claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
      cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
      grokCommand: (user) => [`/opt/fake/${user}/grok`],
      ...fakeMirasimDeps(),
      run,
    }),
    trees: {
      tmpFor: (runId) => join(tmp, 'sessions', runId),
      adopt: async () => undefined,
      remove: async () => ({ gone: true }),
    },
    baseEnv: { PATH: '/usr/bin' },
    resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
    ...over,
  });
  let n = 0;
  /** 起一个动手会话（一次性段），tier 是分档给的档位。 */
  const session = (routeId: string, tier?: OneShotInput['effort']) =>
    runOneShot(
      {
        runId: `run-${++n}`,
        segment: 'manual',
        modelId: 'opus-5.5',
        routeId,
        prompt: '干活',
        cwd: join(tmp, 'tree'),
        timeoutMinutes: 30,
        ...(tier === undefined ? {} : { effort: tier }),
      },
      { spawn, runs: { async start() {}, async record() {} }, tmpDir: tmp },
    );
  /** 最近一次 Claude 会话的命令行里 --effort 后面那个值。 */
  const claudeEffort = () => {
    const spec = claude.specs.at(-1);
    if (!spec) throw new Error('Claude 的插头一次都没被调用');
    const args = buildClaudeArgs(spec);
    return args[args.indexOf('--effort') + 1];
  };
  const grokEffort = () => {
    const spec = grok.specs.at(-1);
    if (!spec) throw new Error('Grok 的插头一次都没被调用');
    const args = buildGrokArgs(spec);
    return args[args.indexOf('--reasoning-effort') + 1];
  };
  return { claude, grok, session, claudeEffort, grokEffort };
}

describe('驾驶舱配的档位进命令行', () => {
  it('没配用 high；驾驶舱改了，下一个起的会话命令行带的就是新档位；清掉又回到 high', async () => {
    const r = rig();
    expect((await r.session('solo')).outcome).toBe('done');
    expect(r.claudeEffort()).toBe('high');

    expect(
      await setRoutingEffort(t.db, { modelId: 'opus-5.5', routeId: 'solo', effort: 'xhigh' }),
    ).toMatchObject({
      ok: true,
    });
    await r.session('solo');
    expect(r.claudeEffort()).toBe('xhigh');

    await setRoutingEffort(t.db, { modelId: 'opus-5.5', routeId: 'solo', effort: 'low' });
    await r.session('solo');
    expect(r.claudeEffort()).toBe('low');

    // 改的是 solo 这一条：同一模型下的另一条路由不受影响
    await r.session('carpool');
    expect(r.claudeEffort()).toBe('high');

    await setRoutingEffort(t.db, { modelId: 'opus-5.5', routeId: 'solo', effort: null });
    await r.session('solo');
    expect(r.claudeEffort()).toBe('high');
    expect(r.claude.count()).toBe(5);
  });

  it('分档只往下压：配了 xhigh，快档（medium）的活是 medium，中档、主力档（high）的活照 xhigh', async () => {
    const r = rig();
    await setRoutingEffort(t.db, { modelId: 'opus-5.5', routeId: 'solo', effort: 'xhigh' });
    await r.session('solo', 'medium');
    expect(r.claudeEffort()).toBe('medium');
    await r.session('solo', 'high');
    expect(r.claudeEffort()).toBe('xhigh');
  });

  it('Grok 路由：配了 medium，命令行是 --reasoning-effort medium', async () => {
    const { routeId } = await addGrokRoute(t.db, { stages: ['execute'] });
    const r = rig();
    await r.session(routeId);
    expect(r.grokEffort()).toBe('high');
    await setRoutingEffort(t.db, { modelId: 'grok-4.7', routeId, effort: 'medium' });
    await r.session(routeId);
    expect(r.grokEffort()).toBe('medium');
  });
});

describe('【故意造出的失败】配置写错、读不到：报错、不起会话，不当成 high', () => {
  it('库里给 Grok 路由写了它不认的 max（绕过了驾驶舱的校验）：起不了，说清哪条路由、为什么，插头一次没起', async () => {
    const { routeId } = await addGrokRoute(t.db, { stages: ['execute'] });
    // 只有这一行是 grok 的；world 的两条 Claude 路由也被写成 max，Claude 认 max，不影响这条用例
    await t.db.update(routingCatalog).set({ effort: 'max' });
    const r = rig();
    const err = await r.session(routeId).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(
      new RegExp(`路由 ${routeId} 配的思考档位起不了会话.*Grok 命令行 不支持思考档位（effort）max`),
    );
    expect(r.grok.count()).toBe(0);
  });

  it('驾驶舱那一步就拒：给 Grok 路由配 max 写不进库，库里还是没配', async () => {
    const { routeId } = await addGrokRoute(t.db, { stages: ['execute'] });
    expect(await setRoutingEffort(t.db, { modelId: 'grok-4.7', routeId, effort: 'max' })).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    const r = rig();
    await r.session(routeId);
    expect(r.grokEffort()).toBe('high');
  });

  it('档位读不到（查路由那一步出错）：起不了会话，插头一次没起', async () => {
    const r = rig({
      routeFacts: async () => {
        throw new Error('库连不上：connection refused');
      },
    });
    await expect(r.session('solo')).rejects.toThrow('库连不上');
    expect(r.claude.count()).toBe(0);
  });
});
