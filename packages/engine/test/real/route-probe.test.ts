// 路由探针的真装配（#129）：内存库上跑真迁移、假插头（不起真执行体）、假工作树管家。
// 探通 → 在线；登录失效、设备被撤销 → 离线写明原因、整池暂停报警，恢复后下一轮转回在线、撤掉报警；额度用满被拒 → 算通、
// 额度读数记账；回答认不出、起不来、工作目录交不出去、账号池没定会话用户 → 离线写明原因。每条都故意造一次。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifications, quotaWindows, routes, scheduleRuns, toRoute } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PROBE_JOB, runRouteProbeJob } from '../../src/jobs/route-probe.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import { PROBE_DIR, PROBE_PROMPT, routeProbeJob } from '../../src/real/route-probe.ts';
import { poolHoldKey } from '../../src/real/store-ports.ts';
import { type FakeRunScript, fakeRun, fakeTrees, NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  // 真实的样子：独享池挂在独享组织上（会话用户平时挂拼车，这个池不探）
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  await registerEngineJobs(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-probe-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const quiet = () => {};

function setup(script: (n: number) => FakeRunScript, over: { adoptFails?: string; runThrows?: string } = {}) {
  const fake = fakeRun((_, n) => script(n));
  const trees = fakeTrees(join(root, 'work'));
  if (over.adoptFails) {
    const message = over.adoptFails;
    trees.trees.adopt = async () => {
      throw new Error(message);
    };
  }
  let clock = NOW.getTime();
  const job = routeProbeJob({
    db: t.db,
    trees: trees.trees,
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    machine: '法国',
    now: () => new Date(clock),
    log: quiet,
    sleep: async () => {},
    retryDelayMs: 0,
    run: over.runThrows
      ? async () => {
          throw new Error(over.runThrows);
        }
      : fake.run,
  });
  return {
    fake,
    trees,
    round: async () => runRouteProbeJob(job()),
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
  };
}

const row = async (id: string) => (await t.db.select().from(routes)).find((r) => r.id === id);
const hold = async () =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey('claude-carpool'));
const answered = (): FakeRunScript => ({ result: { text: 'OK' } });

describe('探通：在线，结论和时刻写进库，定时任务页那一行对得上', () => {
  it('拼车池的路由探通在线；独享池因为会话用户挂着拼车没探、codex 插头没接，都不在线且写明原因', async () => {
    const s = setup(answered);
    const run = await s.round();
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 2, online: ['carpool'] });

    const carpool = await row('carpool');
    expect(carpool).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });
    expect(carpool?.probeDetail).toMatch(/^答上了：OK · 用时 \d+ 秒/);
    expect(toRoute(carpool as typeof routes.$inferSelect).probe).toMatchObject({
      state: 'ok',
      at: NOW.toISOString(),
    });
    // 独享池原来（夹具里）是在线的：这一轮没探，就不在线了（不许拿上一次的在线冒充）
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped' });
    expect((await row('solo'))?.probeDetail).toContain('会话用户现在挂的是拼车组织');
    expect(await row('luna')).toMatchObject({ alive: false, probeState: 'not_wired' });
    expect((await row('luna'))?.probeDetail).toContain('Codex');

    const runs = (await t.db.select().from(scheduleRuns)).filter((r) => r.job === ROUTE_PROBE_JOB.id);
    expect(runs.map((r) => [r.outcome, r.scanned, r.found])).toEqual([['ok', 3, 2]]);
  });

  it('起的是和干活的会话同一个插头、同一份 reclaude、同一个模型串：不存记录、什么工具都用不了、问一句 OK', async () => {
    const s = setup(answered);
    await s.round();
    expect(s.fake.count()).toBe(1);
    const [spec] = s.fake.specs;
    const [options] = s.fake.options;
    const dir = join(root, 'work').replaceAll('\\', '/');
    expect(spec).toMatchObject({
      prompt: PROBE_PROMPT,
      model: 'claude-opus-5-5',
      permissionMode: 'dontAsk',
      persistSession: false,
      session: { mode: 'new' },
      cgroup: { user: 'fleet-agent-carpool' },
      env: { fleetApi: '', fleetToken: '' },
    });
    expect(spec?.cwd.replaceAll('\\', '/')).toBe(`${dir}/${PROBE_DIR}/fleet-agent-carpool`);
    expect(spec?.cgroup?.id).toMatch(/^probe-[0-9a-f-]{36}$/);
    expect(spec?.cgroup?.id).toBe(spec?.runId);
    expect(options?.command).toEqual(['/opt/fake/fleet-agent-carpool/reclaude']);
    // 工作目录第一轮交给会话用户，之后不再每轮改属主
    expect(s.trees.adopts).toHaveLength(1);
    await s.round();
    expect(s.trees.adopts).toHaveLength(1);
  });
});

describe('登录失效、设备被撤销：离线写明原因，整池暂停报警；恢复后下一轮转回在线、撤掉报警', () => {
  it('Not logged in：同一轮不再试；原因里写清去哪台机器、以谁重新登录', async () => {
    const s = setup((n) =>
      n === 1
        ? {
            result: { isError: true, terminalReason: 'api_error', text: 'Not logged in · Please run /login' },
            exitCode: 1,
          }
        : answered(),
    );
    const first = await s.round();
    expect(first).toMatchObject({ outcome: 'ok', online: [] });
    expect(s.fake.count()).toBe(1);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('登录失效');
    expect(down?.probeDetail).toContain('Not logged in');
    expect(down?.probeDetail).toContain('法国');
    expect(down?.probeDetail).toContain('fleet-agent-carpool');
    expect(down?.probeDetail).toContain('reclaude login');
    expect(await hold()).toMatchObject({ level: 'decision', resolvedAt: null });
    expect((await hold())?.title).toContain('登录失效');

    s.advance(15);
    const second = await s.round();
    expect(second.online).toEqual(['carpool']);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect((await hold())?.resolvedAt).not.toBeNull();
  });

  it('reclaude 没有有效登录（法国实测的样子）：开始设备授权、一直等到起不来被强杀——认成登录失效，不按起不来重试；授权链接不进库', async () => {
    const s = setup(() => ({
      result: null,
      killed: 'startup_timeout',
      // 那一句后面还有几行：挤出了最后三行也要认得出
      stderrTail: [
        'reclaude: tip: run `reclaude setup` once, then `reclaude` works in any terminal.',
        'Syncing config…',
        'reclaude: no valid login detected, starting device authorization flow…',
        'Connecting to reclaude.ai…',
        'Waiting for approval at https://auth.example.test/cli/auth?state=ONE-TIME-STATE-123 …',
        'still waiting…',
        'still waiting…',
      ].join('\n'),
    }));
    await s.round();
    // 要人修的整池问题：同一轮不再试（再试也是再等 150 秒）
    expect(s.fake.count()).toBe(1);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('登录失效');
    expect(down?.probeDetail).toContain('no valid login detected');
    expect(down?.probeDetail).toContain('reclaude login');
    expect(down?.probeDetail).not.toContain('ONE-TIME-STATE-123');
    const alert = await hold();
    expect(alert).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(`${alert?.title} ${alert?.body}`).not.toContain('ONE-TIME-STATE-123');
  });

  it('此设备已被解绑（reclaude 原话）：认成设备被撤销，离线、整池暂停', async () => {
    const s = setup(() => ({
      result: {
        isError: true,
        terminalReason: 'api_error',
        apiErrorStatus: 400,
        text: 'API Error: 400 此设备已被解绑，请在终端重新运行 reclaude 完成登录（请勿在 Claude Code 内使用 /login 登录）',
      },
      exitCode: 1,
    }));
    await s.round();
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('登录被撤销');
    expect(await hold()).toMatchObject({ resolvedAt: null });
  });
});

describe('额度用满被拒：算通（在线），额度读数记账，派不派交给额度那一套', () => {
  it('拼车 5 小时额度用完：路由在线、原因写额度用满，额度窗记成用满', async () => {
    const resetsAt = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    const s = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: '拼车 5 小时额度已用完，约 20 分钟后重置' },
      exitCode: 1,
      act: ({ rateLimit }) => {
        rateLimit({
          status: 'rejected',
          exhausted: true,
          rateLimitType: 'five_hour',
          resetsAt,
          windows: [{ name: 'five_hour', utilization: 1, resetsAt }],
          observedAt: NOW.toISOString(),
        });
      },
    }));
    const run = await s.round();
    expect(run.online).toEqual(['carpool']);
    const up = await row('carpool');
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toContain('额度用满');
    // 同一轮不再试（额度用满再探也是被拒）
    expect(s.fake.count()).toBe(1);
    // 读数写库是顺手异步写的：等它落地
    await expect
      .poll(async () =>
        (await t.db.select().from(quotaWindows)).find(
          (w) => w.poolId === 'claude-carpool' && w.label === 'five_hour',
        ),
      )
      .toMatchObject({ upstreamStatus: 'limit_reached' });
    expect(await hold()).toBeUndefined();
  });
});

describe('没探通的：离线，写明是哪一种（不许拿默认值、上一轮的在线冒充）', () => {
  it('答了、但答的不是 OK（输出认不出）：隔一会儿再探一次，还不对就离线', async () => {
    const s = setup(() => ({ result: { text: '你好！有什么可以帮你？' } }));
    await s.round();
    expect(s.fake.count()).toBe(2);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('回答认不出');
    expect(down?.probeDetail).toContain('连探两次都没通');
  });

  // 只要「含 OK」就算通，会把这几种也写成在线（#148 合并后补审）：整句必须就是 OK
  it.each(['Not OK', 'OK, but I cannot run tools here', 'ok.', 'OK OK', '`OK`'])(
    '回答「%s」不是只回 OK：不算探通，离线、原因里带着原话',
    async (reply) => {
      const s = setup(() => ({ result: { text: reply } }));
      await s.round();
      const down = await row('carpool');
      expect(down).toMatchObject({ alive: false, probeState: 'failed' });
      expect(down?.probeDetail).toContain('回答认不出（要的是只回 OK）');
      expect(down?.probeDetail).toContain(reply);
    },
  );

  it.each(['OK', 'ok', '  OK\n'])(
    '回答「%s」（去掉首尾空白后整句是 OK，不分大小写）：探通',
    async (reply) => {
      const s = setup(() => ({ result: { text: reply } }));
      await s.round();
      expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    },
  );

  it('进程起不来（reclaude 不在）：离线，原因写起不来', async () => {
    const s = setup(() => ({ spawnError: 'spawn /home/fleet-agent-carpool/.local/bin/reclaude ENOENT' }));
    await s.round();
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('ENOENT');
  });

  it('没有终帧就退出了：离线，原因带上执行体最后说的话', async () => {
    const s = setup(() => ({
      result: null,
      exitCode: 1,
      stderrTail: 'Error: connect ETIMEDOUT 1.2.3.4:443',
    }));
    await s.round();
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('没有终帧');
    expect(down?.probeDetail).toContain('ETIMEDOUT');
  });

  it('插头在起会话之前就拦下了（参数、环境不对）：离线，原因写被拦下', async () => {
    const s = setup(answered, { runThrows: '会话环境里不许带 HTTPS_PROXY' });
    await s.round();
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('起会话之前就被拦下了');
  });

  it('探针的工作目录交不给会话用户（fleet-agent-scope 失败）：离线，不在别的目录里起会话', async () => {
    const s = setup(answered, { adoptFails: 'fs.protected_hardlinks 没开' });
    await s.round();
    expect(s.fake.count()).toBe(0);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('工作目录');
    expect(down?.probeDetail).toContain('protected_hardlinks');
  });

  it('Claude Code 路由的账号池没定会话用户：离线，写明缺什么', async () => {
    await t.client.query("update pools set run_as_user = null, org_kind = null where id = 'claude-carpool'");
    const s = setup(answered);
    await s.round();
    expect(s.fake.count()).toBe(0);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('没定会话用户');
  });
});
