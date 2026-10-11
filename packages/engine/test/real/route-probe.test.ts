// 路由探针的真装配（#129）：内存库上跑真迁移、假插头（不起真执行体）、假工作树管家。
// 探通 → 在线；登录失效、设备被撤销 → 离线写明原因、整池暂停报警，恢复后下一轮转回在线、撤掉报警；额度用满被拒 → 算通、
// 额度读数记账；回答认不出、超时、起不来、连不上、工作目录交不出去、账号池没定会话用户 → 离线写明原因。每条都故意造一次。
// cursor 的 API 密钥另走一遍真插头、真起法（经假帮手真起进程，只在 Linux 上）：探针带上了它，哪里都搜不到值。
// grok（#266）：探通、放慢、没登录、登录过期、没装、型号不认、回话的不是点名那一代、stdin 不是真管道、额度用满，各造一次。
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  notifications,
  quotaWindows,
  readRouteProbeHistory,
  routes,
  scheduleRuns,
  toRoute,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PROBE_JOB, runRouteProbeJob } from '../../src/jobs/route-probe.ts';
import { CURSOR_KEY_BAD, CURSOR_KEY_EXIT, CURSOR_MISSING, GROK_MISSING } from '../../src/real/hosts.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import { pingPrompt } from '../../src/real/probe-identity.ts';
import { identityAlertKey, iqAlertKey, PROBE_DIR, routeProbeJob } from '../../src/real/route-probe.ts';
import { poolHoldKey } from '../../src/real/store-ports.ts';
import {
  addCursorRoute,
  addGrokRoute,
  addMirasimRoute,
  CURSOR_KEY_REJECTED,
  CURSOR_NO_LOGIN,
  CURSOR_SESSION,
  CURSOR_TRUST_REQUIRED,
  type CursorKeyRig,
  cursorKeyRig,
  dumpDb,
  type FakeCursorScript,
  type FakeGrokScript,
  type FakeMirasimScript,
  type FakeRunScript,
  fakeCursorRun,
  fakeGrokRun,
  fakeMirasimDeps,
  fakeMirasimRun,
  fakeRun,
  fakeTrees,
  GROK_NO_STDIN,
  GROK_NOT_SIGNED_IN,
  GROK_TOKEN_EXPIRED,
  GROK_UNKNOWN_MODEL,
  grokAnswered,
  grokRefused,
  IDENTITY_REPLY_NEW,
  IDENTITY_REPLY_OLD,
  IDENTITY_REPLY_UNKNOWN,
  NOW,
  pickTestQuestion,
  REPLY,
  TEST_Q,
  world,
} from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  // 夹具里「5 分钟前探通」落在前 2 位 30 分钟的间隔之内（#1635），这一轮会照旧不探；这里测的是探的行为，把上一次探通挪到间隔之外
  await t.client.query(
    "update routes set probed_at = probed_at - interval '35 minutes' where probe_state = 'ok'",
  );
  // 真实的样子：独享池挂在独享组织上（这里的会话用户挂着拼车，setup 的 sessionOrg，这个池不探）
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  await registerEngineJobs(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-probe-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const quiet = () => {};

function setup(
  script: (n: number) => FakeRunScript,
  over: {
    adoptFails?: string;
    runThrows?: string;
    cursor?: (n: number) => FakeCursorScript;
    /** cursor 的路由用真插头、真起法（经假帮手真起进程，fixtures 的 cursorKeyRig），不用假插头。 */
    realCursor?: CursorKeyRig;
    grok?: (n: number) => FakeGrokScript;
    mirasim?: (n: number) => FakeMirasimScript;
    /** 强制探身份题（默认按 probeKindFor，Claude 订阅走 ping）。 */
    identity?: boolean;
  } = {},
) {
  const fake = fakeRun((_, n) => script(n));
  const cursor = fakeCursorRun((_, n) => {
    if (!over.cursor) throw new Error('这条用例不该起 cursor-agent');
    return over.cursor(n);
  });
  const grok = fakeGrokRun((_, n) => {
    if (!over.grok) throw new Error('这条用例不该起 grok');
    return over.grok(n);
  });
  const mirasim = fakeMirasimRun((_, n) => {
    if (!over.mirasim) throw new Error('这条用例不该起 Mirasim');
    return over.mirasim(n);
  });
  const trees = fakeTrees(join(root, 'work'));
  if (over.adoptFails) {
    const message = over.adoptFails;
    trees.trees.adopt = async () => {
      throw new Error(message);
    };
  }
  let clock = NOW.getTime();
  const thrower = async (): Promise<never> => {
    throw new Error(over.runThrows);
  };
  const logs: string[] = [];
  const rig = over.realCursor;
  const job = routeProbeJob({
    db: t.db,
    trees: trees.trees,
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: rig ? rig.command : (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    machine: '法国',
    now: () => new Date(clock),
    log: rig ? (level, text, fields) => void logs.push(JSON.stringify([level, text, fields])) : quiet,
    sleep: async () => {},
    retryDelayMs: 0,
    ...(over.identity ? { kindFor: () => 'identity' as const, pickQuestion: pickTestQuestion } : {}),
    run: over.runThrows
      ? { 'claude-code': thrower, 'cursor-agent': thrower, grok: thrower, mirasim: thrower }
      : rig
        ? { 'claude-code': fake.run, grok: grok.run, mirasim: mirasim.run }
        : { 'claude-code': fake.run, 'cursor-agent': cursor.run, grok: grok.run, mirasim: mirasim.run },
    ...(rig ? { helper: rig.helper, sudo: rig.sudo } : {}),
  });
  return {
    fake,
    cursor,
    grok,
    mirasim,
    trees,
    logs,
    round: async () => runRouteProbeJob(job()),
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
  };
}

const row = async (id: string) => (await t.db.select().from(routes)).find((r) => r.id === id);
const hold = async () =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey('claude-carpool'));
const answered = (): FakeRunScript => ({ result: { text: REPLY } });

describe('探通：在线，结论和时刻写进库，定时任务页那一行对得上', () => {
  it('拼车池的路由探通在线；独享池因为会话用户挂着拼车没探、codex 插头没接，都不在线且写明原因', async () => {
    const s = setup(answered);
    const run = await s.round();
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 2, online: ['carpool'] });

    const carpool = await row('carpool');
    expect(carpool).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });
    expect(carpool?.probeDetail).toMatch(/^答上了：pong · 用时 \d+ 秒/);
    expect(carpool?.probeKind).toBe('ping');
    expect(toRoute(carpool as typeof routes.$inferSelect).probe).toMatchObject({
      state: 'ok',
      at: NOW.toISOString(),
    });
    // 独享池原来（夹具里）是在线的：这一轮没探，就不在线了（不许拿上一次的在线冒充）
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped' });
    expect((await row('solo'))?.probeDetail).toContain('会话用户现在挂的是拼车组织');
    expect(await row('luna')).toMatchObject({ alive: false, probeState: 'not_wired' });
    expect((await row('luna'))?.probeDetail).toContain('Codex');

    const carpoolHistory = await readRouteProbeHistory(t.db, 'carpool', 10);
    expect(carpoolHistory[0]).toMatchObject({
      result: 'passed',
      durationMs: 1,
      requestText: pingPrompt(),
      responseText: REPLY,
      failureReason: null,
      kind: 'ping',
    });
    const soloHistory = await readRouteProbeHistory(t.db, 'solo', 10);
    expect(soloHistory[0]).toMatchObject({
      result: 'not_probed',
      durationMs: null,
      requestText: null,
      responseText: null,
    });
    expect(soloHistory[0]?.failureReason).toContain('拼车');
    const lunaHistory = await readRouteProbeHistory(t.db, 'luna', 10);
    expect(lunaHistory[0]).toMatchObject({
      result: 'not_probed',
      durationMs: null,
      requestText: null,
      responseText: null,
    });
    expect(lunaHistory[0]?.failureReason).toContain('Codex');

    const runs = (await t.db.select().from(scheduleRuns)).filter((r) => r.job === ROUTE_PROBE_JOB.id);
    expect(runs.map((r) => [r.outcome, r.scanned, r.found])).toEqual([['ok', 3, 2]]);
  });

  it('起的是和干活的会话同一个插头、同一份 reclaude、同一个模型串：不存记录、什么工具都用不了、问一句 pong', async () => {
    const s = setup(answered);
    await s.round();
    expect(s.fake.count()).toBe(1);
    const [spec] = s.fake.specs;
    const [options] = s.fake.options;
    const dir = join(root, 'work').replaceAll('\\', '/');
    expect(spec).toMatchObject({
      prompt: pingPrompt(),
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

describe('身份题（#1798 片 5）', () => {
  const identityAlert = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === identityAlertKey('carpool'));
  const iqAlert = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === iqAlertKey('carpool'));

  it('答出新答案：通过，历史记下题和实答，写 kind=identity，不推提醒', async () => {
    const s = setup(() => ({ result: { text: IDENTITY_REPLY_NEW } }), { identity: true });
    await s.round();
    const up = await row('carpool');
    expect(up).toMatchObject({ alive: true, probeState: 'ok', probeKind: 'identity' });
    expect(up?.probeDetail).toContain('身份题通过（日本首相）');
    const [h] = await readRouteProbeHistory(t.db, 'carpool', 1);
    expect(h).toMatchObject({
      result: 'passed',
      kind: 'identity',
      checkQuestion: TEST_Q.text,
      checkAnswer: '高市早苗',
      checkPassed: true,
      selfIdentity: 'gpt-6-sol',
    });
    expect(await identityAlert()).toBeUndefined();
  });

  it('说出旧答案：疑似换成旧模型，下线，推 probe-identity；再探通撤掉，并顺手撤老 probe-iq', async () => {
    await upsertAlert(t.db, {
      dedupeKey: iqAlertKey('carpool'),
      level: 'alert',
      taskId: null,
      title: '路由疑似降智',
      body: '老降智提醒，探通后应一并撤',
    });
    let good = false;
    const s = setup(() => ({ result: { text: good ? IDENTITY_REPLY_NEW : IDENTITY_REPLY_OLD } }), {
      identity: true,
    });
    await s.round();
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('疑似换成旧模型');
    expect(down?.probeDetail).toContain('石破茂');
    const [h] = await readRouteProbeHistory(t.db, 'carpool', 1);
    expect(h).toMatchObject({
      result: 'failed',
      checkAnswer: '石破茂',
      checkPassed: false,
      selfIdentity: 'gpt-6-astra',
    });
    const alert = await identityAlert();
    expect(alert).toMatchObject({ title: '路由疑似换成旧模型', resolvedAt: null });
    expect(alert?.body).toContain('石破茂');
    expect((await iqAlert())?.resolvedAt).toBeNull();

    s.advance(60);
    await s.round();
    const same = (await t.db.select().from(notifications)).filter(
      (n) => n.dedupeKey === identityAlertKey('carpool'),
    );
    expect(same).toHaveLength(1);

    good = true;
    s.advance(60);
    await s.round();
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect((await identityAlert())?.resolvedAt).not.toBeNull();
    expect((await iqAlert())?.resolvedAt).not.toBeNull();
  });

  it('认不出：check_passed 为空，结论照通，不推提醒', async () => {
    const s = setup(() => ({ result: { text: IDENTITY_REPLY_UNKNOWN } }), { identity: true });
    await s.round();
    const up = await row('carpool');
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toContain('身份题认不出');
    const [h] = await readRouteProbeHistory(t.db, 'carpool', 1);
    expect(h).toMatchObject({
      result: 'passed',
      checkAnswer: '我不确定',
      checkPassed: null,
      selfIdentity: '某模型',
    });
    expect(await identityAlert()).toBeUndefined();
  });

  it('连通探测：只回 pong 就通，历史 kind=ping，没有身份题记录', async () => {
    const s = setup(answered);
    await s.round();
    const up = await row('carpool');
    expect(up).toMatchObject({ alive: true, probeState: 'ok', probeKind: 'ping' });
    expect(up?.probeDetail).toMatch(/^答上了：pong · 用时 \d+ 秒/);
    const [h] = await readRouteProbeHistory(t.db, 'carpool', 1);
    expect(h).toMatchObject({
      result: 'passed',
      kind: 'ping',
      checkQuestion: null,
      checkPassed: null,
    });
    expect(await identityAlert()).toBeUndefined();
  });

  it('没有第一行 pong：回答认不出，不推身份提醒', async () => {
    const s = setup(() => ({ result: { text: '答案：高市早苗' } }), { identity: true });
    await s.round();
    const down = await row('carpool');
    expect(down?.probeDetail).toContain('回答认不出');
    expect(down?.probeDetail).not.toContain('疑似换成旧模型');
    expect(await identityAlert()).toBeUndefined();
  });

  it('额度用满被拒：照旧算通，没有身份题记录', async () => {
    const s = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: '拼车 5 小时额度已用完，约 20 分钟后重置' },
      exitCode: 1,
    }));
    await s.round();
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    const [h] = await readRouteProbeHistory(t.db, 'carpool', 1);
    expect(h?.checkPassed).toBeNull();
    expect(h?.checkQuestion).toBeNull();
    expect(await identityAlert()).toBeUndefined();
  });
});

describe('没探通的：离线，写明是哪一种（不许拿默认值、上一轮的在线冒充）', () => {
  it('答了、但答的不是 pong（输出认不出）：隔一会儿再探一次，还不对就离线', async () => {
    const s = setup(() => ({ result: { text: '你好！有什么可以帮你？' } }));
    await s.round();
    expect(s.fake.count()).toBe(2);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('回答认不出');
    expect(down?.probeDetail).toContain('连探两次都没通');
  });

  // 只要「含 pong」就算通，会把这几种也写成在线：整句必须就是 pong
  it.each(['Not pong', 'pong, but I cannot run tools here', 'pong.', 'pong pong', 'pong 好的'])(
    '回答「%s」不是只回 pong：不算探通，离线、原因里带着原话',
    async (reply) => {
      const s = setup(() => ({ result: { text: reply } }));
      await s.round();
      const down = await row('carpool');
      expect(down).toMatchObject({ alive: false, probeState: 'failed' });
      expect(down?.probeDetail).toContain('回答认不出（要的是第一行只写 pong）');
      expect(down?.probeDetail).toContain(reply);
    },
  );

  it.each(['pong', 'PONG', '  pong\n', '```\npong\n```', '**pong**'])(
    '回答「%s」（第一行整行是 pong；粗体、代码块围栏都认）：探通',
    async (reply) => {
      const s = setup(() => ({ result: { text: reply } }));
      await s.round();
      expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    },
  );

  // 超时三种（插头强杀）：迟迟没有第一帧（reclaude 卡在同步配置上）、总时长到顶、长时间没动静。都不是要人修的整池问题：
  // 隔一会儿同一轮再探一次，还不通才离线，原因写明是哪种超时和执行体最后说的话；不写「整池暂停」。
  it.each([
    ['startup_timeout', '起来之后迟迟没有第一帧'],
    ['wall_clock_timeout', '总时长到顶'],
    ['idle_timeout', '长时间没有动静'],
  ] as const)('超时（%s）：同一轮再探一次，还不通就离线、写明超时，不当成整池问题', async (killed, text) => {
    const s = setup(() => ({ result: null, killed, stderrTail: 'Syncing config…' }));
    const run = await s.round();
    expect(run).toMatchObject({ outcome: 'ok', online: [] });
    expect(s.fake.count()).toBe(2);
    const down = await row('carpool');
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('连探两次都没通');
    expect(down?.probeDetail).toContain(text);
    expect(down?.probeDetail).toContain('Syncing config');
    expect(await hold()).toBeUndefined();
  });

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

describe('cursor-agent 的路由（#212）：和干活的会话同一个驱动探，判法同一套', () => {
  let routeId: string;
  beforeEach(async () => {
    ({ routeId } = await addCursorRoute(t.db, { stages: ['verify'] }));
    // 上一次探通是 3 小时前：cursor 探通了隔 2 小时再探，这一轮到点了
    await t.client.query('update routes set probed_at = $2::timestamptz where id = $1', [
      routeId,
      new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
    ]);
  });
  const cursorHold = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey('cursor'));
  /** 法国真跑夹具的 init 帧，接一个只回 text 的终帧。 */
  const replied = (text = REPLY): FakeCursorScript => ({
    replay: 'cursor-edit-commit',
    replayLines: 1,
    frames: [
      { type: 'result', subtype: 'success', is_error: false, result: text, session_id: CURSOR_SESSION },
    ],
  });
  const failing = (stderr: string, exitCode = 1): FakeCursorScript => ({ stderr, exitCode });

  it('探通：在线；以唯一的会话用户、不放开命令（不带 --force）、照路由上的模型问一句 OK，不给 fleet 命令的地址', async () => {
    const s = setup(answered, { cursor: () => replied() });
    const run = await s.round();
    expect(run.online).toEqual(expect.arrayContaining(['carpool', routeId]));
    const up = await row(routeId);
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toMatch(/^答上了：pong · 用时 \d+ 秒$/);
    expect(s.cursor.count()).toBe(1);
    const [spec] = s.cursor.specs;
    expect(spec).toMatchObject({
      prompt: pingPrompt(),
      model: 'auto',
      force: false,
      session: { mode: 'new' },
      cgroup: { user: 'fleet-agent-carpool' },
      env: { fleetApi: '', fleetToken: '' },
    });
    expect(spec?.cwd.replaceAll('\\', '/')).toBe(
      `${join(root, 'work').replaceAll('\\', '/')}/${PROBE_DIR}/fleet-agent-carpool`,
    );
    expect(s.cursor.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/cursor-agent']);
  });

  it('探通了：15 分钟后那一轮不再真探、不重写，结论照旧（还在线）；到 2 小时再真探（一次扣的是按月的包含用量）', async () => {
    const s = setup(answered, { cursor: () => replied() });
    await s.round();
    expect(s.cursor.count()).toBe(1);
    const first = await row(routeId);
    expect(first).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });

    s.advance(15);
    const second = await s.round();
    expect(s.cursor.count()).toBe(1);
    expect(second.online).toContain(routeId);
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });
    // Claude 的路由在前 2 位：探通了隔 30 分钟才再真探（#1635），15 分钟后这一轮也不探
    expect(s.fake.count()).toBe(1);

    s.advance(105);
    await s.round();
    expect(s.cursor.count()).toBe(2);
    expect((await row(routeId))?.probedAt).toEqual(new Date(NOW.getTime() + 120 * 60_000));
  });

  it('路由上点名了具体模型：探针就用它（不限定 auto）', async () => {
    await t.client.query("update routes set upstream_model = 'composer-2' where id = $1", [routeId]);
    const s = setup(answered, { cursor: () => replied() });
    await s.round();
    expect(s.cursor.specs[0]?.model).toBe('composer-2');
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok' });
  });

  it('连不上 Cursor（只在 stderr 报、没有 JSON）：隔一会儿再探一次，还不通就离线，原因带原话；不整池暂停', async () => {
    const s = setup(answered, {
      cursor: () =>
        failing(
          '✗ Failed to reach the Cursor API. Check that your proxy (http://<回环>:7890/) is reachable.',
        ),
    });
    await s.round();
    expect(s.cursor.count()).toBe(2);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('连探两次都没通');
    expect(down?.probeDetail).toContain('Failed to reach the Cursor API');
    expect(await cursorHold()).toBeUndefined();
  });

  it('没登录（-p 模式的原话）：同一轮不再试；离线写清去 Cursor 后台重新生成密钥、照 ops 放进哪台机器、谁家里，整池暂停；放好后下一轮转回在线、撤掉', async () => {
    const s = setup(answered, { cursor: (n) => (n === 1 ? failing(CURSOR_NO_LOGIN) : replied()) });
    await s.round();
    expect(s.cursor.count()).toBe(1);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('Cursor 登录失效');
    expect(down?.probeDetail).toContain('法国');
    expect(down?.probeDetail).toContain('fleet-agent-carpool');
    expect(down?.probeDetail).toContain('cursor.com/dashboard/api');
    expect(down?.probeDetail).toContain('docs/ops.md 第五节「会话用户的 Cursor 密钥」');
    const alert = await cursorHold();
    expect(alert).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(alert?.title).toContain('Cursor 登录失效');
    // 拼车池的 Claude 路由不受牵连
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });

    s.advance(15);
    await s.round();
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok' });
    expect((await cursorHold())?.resolvedAt).not.toBeNull();
  });

  it('Cursor 拒了会话用户的 API 密钥（无效、被撤、过期；原话带终端颜色）：同一轮不再试；离线、整池暂停，写清去后台重新生成、照 ops 放进法国', async () => {
    const s = setup(answered, { cursor: () => failing(CURSOR_KEY_REJECTED) });
    await s.round();
    expect(s.cursor.count()).toBe(1);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('Cursor 登录失效');
    expect(down?.probeDetail).toContain('The provided API key is invalid');
    expect(down?.probeDetail).toContain('cursor.com/dashboard/api');
    expect(down?.probeDetail).toContain('法国');
    // 终端颜色去掉了，不带进库
    expect(down?.probeDetail).not.toContain('\u001b');
    expect((await cursorHold())?.title).toContain('Cursor 登录失效');
  });

  it('会话用户家里的密钥文件没放好（起它的那段 sh 退出 78）：同一轮不再试；离线写清哪里不对、照 ops 放好，整池暂停；放好后下一轮转回在线', async () => {
    const bad = `${CURSOR_KEY_BAD}：权限是 644，要 600。文件是 /home/fleet-agent-carpool/.cursor/fleet-api-key，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」放好`;
    const s = setup(answered, {
      cursor: (n) => (n === 1 ? failing(bad, CURSOR_KEY_EXIT) : replied()),
    });
    await s.round();
    expect(s.cursor.count()).toBe(1);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('Cursor 密钥没放好');
    expect(down?.probeDetail).toContain('权限是 644，要 600');
    expect(down?.probeDetail).toContain('会话用户 fleet-agent-carpool');
    const alert = await cursorHold();
    expect(alert).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(alert?.title).toContain('Cursor 密钥没放好');
    // 哪里不对摘进了提醒：人不用翻探针的结论就知道要改什么
    expect(alert?.body).toContain('权限是 644，要 600');

    s.advance(15);
    await s.round();
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok' });
    expect((await cursorHold())?.resolvedAt).not.toBeNull();
  });

  for (const exitCode of [0, 1]) {
    it(`没信任过的目录（-p 打一段 Workspace Trust 提示就退出，退出码 ${exitCode}）：不算探通，认成执行方式或路由配置不对、写明那一句，不是认不出`, async () => {
      const s = setup(answered, { cursor: () => failing(CURSOR_TRUST_REQUIRED, exitCode) });
      await s.round();
      const down = await row(routeId);
      expect(down).toMatchObject({ alive: false, probeState: 'failed' });
      expect(down?.probeDetail).toContain('执行方式或路由配置不对');
      expect(down?.probeDetail).toContain('Workspace Trust Required');
      expect(down?.probeDetail).toContain('Pass --trust');
      // 是这条路由的起法坏了，不是这个池要人修：不整池暂停
      expect(await cursorHold()).toBeUndefined();
    });
  }

  it('会话用户家里没装 cursor-agent（找版本目录的那段 sh 退出 127）：离线，原因写没装；不整池暂停', async () => {
    const s = setup(answered, {
      cursor: () =>
        failing(
          `${CURSOR_MISSING}：/home/fleet-agent-carpool/.local/share/cursor-agent/versions 下既没有 current，也没有能跑的版本目录（会话用户家里没装 cursor-agent）`,
          127,
        ),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('没装 cursor-agent');
    expect(await cursorHold()).toBeUndefined();
  });

  it('订阅里的用量用完（请求被拒、不扣钱）：算通（在线），原因写额度用满、带原话，同一轮不再试', async () => {
    const s = setup(answered, {
      cursor: () =>
        failing(
          "Error: You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 10/5/2026.",
        ),
    });
    const run = await s.round();
    expect(run.online).toContain(routeId);
    const up = await row(routeId);
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toContain('额度用满');
    expect(up?.probeDetail).toContain('hit your usage limit');
    expect(s.cursor.count()).toBe(1);
    expect(await cursorHold()).toBeUndefined();
  });

  it('答了、但答的不是 OK：和 Claude 一样不算探通', async () => {
    const s = setup(answered, { cursor: () => replied('OK, but I cannot run tools here') });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('回答认不出（要的是第一行只写 pong）');
  });
});

describe('grok 的路由（#266）：和干活的会话同一个驱动探，判法同一套', () => {
  let routeId: string;
  beforeEach(async () => {
    ({ routeId } = await addGrokRoute(t.db, { stages: ['verify'] }));
    // 上一次探通是 3 小时前：grok 探通了隔 2 小时再探，这一轮到点了
    await t.client.query('update routes set probed_at = $2::timestamptz where id = $1', [
      routeId,
      new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
    ]);
  });
  const grokHold = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey('grok'));
  const replied = (text = REPLY, model = 'grok-4.7-build'): FakeGrokScript => ({
    frames: grokAnswered(text, model),
  });

  it('探通：在线；以唯一的会话用户、不放开命令（不带 --always-approve）、照路由上的模型、我们起的会话号问一句 OK，不给 fleet 命令的地址', async () => {
    const s = setup(answered, { grok: () => replied() });
    const run = await s.round();
    expect(run.online).toEqual(expect.arrayContaining(['carpool', routeId]));
    const up = await row(routeId);
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toMatch(/^答上了：pong · 用时 \d+ 秒$/);
    expect(s.grok.count()).toBe(1);
    const [spec] = s.grok.specs;
    expect(spec).toMatchObject({
      prompt: pingPrompt(),
      model: 'grok-4.7',
      alwaysApprove: false,
      session: { mode: 'new' },
      cgroup: { user: 'fleet-agent-carpool' },
      env: { fleetApi: '', fleetToken: '' },
    });
    expect(spec?.session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(spec?.cwd.replaceAll('\\', '/')).toBe(
      `${join(root, 'work').replaceAll('\\', '/')}/${PROBE_DIR}/fleet-agent-carpool`,
    );
    expect(s.grok.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/grok']);
  });

  it('探通了：15 分钟后那一轮不再真探、不重写，结论照旧（还在线）；到 2 小时再真探（一次扣的是按周的订阅额度）', async () => {
    const s = setup(answered, { grok: () => replied() });
    await s.round();
    expect(s.grok.count()).toBe(1);
    s.advance(15);
    const second = await s.round();
    expect(s.grok.count()).toBe(1);
    expect(second.online).toContain(routeId);
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });
    s.advance(105);
    await s.round();
    expect(s.grok.count()).toBe(2);
    expect((await row(routeId))?.probedAt).toEqual(new Date(NOW.getTime() + 120 * 60_000));
  });

  it('没登录（error 帧和 stderr 各一遍、退出 1）：同一轮不再试；离线写清在哪台机器以哪个会话用户跑 grok login --device-code，整池暂停；登录后下一轮转回在线、撤掉', async () => {
    const s = setup(answered, { grok: (n) => (n === 1 ? grokRefused(GROK_NOT_SIGNED_IN) : replied()) });
    await s.round();
    expect(s.grok.count()).toBe(1);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('Grok 登录失效');
    expect(down?.probeDetail).toContain('Not signed in');
    expect(down?.probeDetail).toContain(
      '在「法国」上以会话用户 fleet-agent-carpool 跑 grok login --device-code',
    );
    expect(down?.probeDetail).toContain('docs/ops.md 第五节「会话用户的 grok」');
    const alert = await grokHold();
    expect(alert).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(alert?.title).toContain('Grok 登录失效');
    expect(alert?.body).toContain('grok login --device-code');
    // 拼车池的 Claude 路由不受牵连
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });

    s.advance(15);
    await s.round();
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok' });
    expect((await grokHold())?.resolvedAt).not.toBeNull();
  });

  it('登录过期、续不上（Token expired）：照登录失效离线、整池暂停，写清重新登录', async () => {
    const s = setup(answered, { grok: () => grokRefused(GROK_TOKEN_EXPIRED) });
    await s.round();
    expect(s.grok.count()).toBe(1);
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('Token expired');
    expect(down?.probeDetail).toContain('grok login --device-code');
    expect((await grokHold())?.title).toContain('Grok 登录失效');
  });

  it('会话用户家里没装 grok（起法那段 sh 退出 127）：离线，原因写没装；不整池暂停', async () => {
    const s = setup(answered, {
      grok: () => ({
        stderr: `${GROK_MISSING}：/home/fleet-agent-carpool/.grok/bin/grok 不在或不能跑（会话用户家里没装 grok 命令行，docs/ops.md 第五节「会话用户的 grok」）`,
        exitCode: 127,
      }),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('执行方式或路由配置不对');
    expect(down?.probeDetail).toContain('没装 grok 命令行');
    expect(await grokHold()).toBeUndefined();
  });

  it("路由上写的型号 grok 不认（Couldn't set model）：离线，认成模型不存在或已下架、带原话；不整池暂停", async () => {
    const s = setup(answered, { grok: () => grokRefused(GROK_UNKNOWN_MODEL) });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('模型不存在或已下架');
    expect(down?.probeDetail).toContain('unknown model id');
    expect(await grokHold()).toBeUndefined();
  });

  it('答了 OK、回话的却是别的一代（点名 grok-4.7、回 grok-4.6-build）：不算探通，写明点名和实际', async () => {
    const s = setup(answered, { grok: () => replied(REPLY, 'grok-4.6-build') });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('点名 grok-4.7，实际 grok-4.6-build');
    expect(await grokHold()).toBeUndefined();
  });

  it('stdin 不是真管道（插头没垫上 cat，读 /dev/stdin 报 ENXIO）：认成执行方式或路由配置不对，不当成没登录、不整池暂停', async () => {
    const s = setup(answered, { grok: () => ({ stderr: `${GROK_NO_STDIN}\n`, exitCode: 1 }) });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('执行方式或路由配置不对');
    expect(down?.probeDetail).toContain('No such device or address (os error 6)');
    expect(down?.probeDetail).not.toContain('登录');
    expect(await grokHold()).toBeUndefined();
  });

  it('额度用完（订阅的周额度撞顶、要订阅）：算通（在线），原因写额度用满、带原话，同一轮不再试', async () => {
    const s = setup(answered, {
      grok: () => ({
        stderr: 'Error: 403 You have run out of credits or need a Grok subscription\n',
        exitCode: 1,
      }),
    });
    const run = await s.round();
    expect(run.online).toContain(routeId);
    const up = await row(routeId);
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toContain('额度用满');
    expect(s.grok.count()).toBe(1);
    expect(await grokHold()).toBeUndefined();
  });

  it('答了、但答的不是 OK：和 Claude 一样不算探通', async () => {
    const s = setup(answered, { grok: () => replied('OK, but I cannot run tools here') });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('回答认不出（要的是第一行只写 pong）');
  });
});

describe('Mirasim 的路由（#345）：和干活的会话同一个驱动探，判法同一套', () => {
  let routeId: string;
  beforeEach(async () => {
    ({ routeId } = await addMirasimRoute(t.db, { stages: ['verify'] }));
    // 上一次探通是 3 小时前：Mirasim 探通了隔 2 小时再探（额度紧，#345），这一轮到点了
    await t.client.query('update routes set probed_at = $2::timestamptz where id = $1', [
      routeId,
      new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
    ]);
  });

  it('探通：在线；以唯一的会话用户、route=cloud、模型串按路由上的、执行体按上游串前缀（deepseek-flash → dsh）', async () => {
    const s = setup(answered, { mirasim: () => ({ state: { text: REPLY } }) });
    const run = await s.round();
    expect(run.online).toEqual(expect.arrayContaining(['carpool', routeId]));
    const up = await row(routeId);
    expect(up).toMatchObject({ alive: true, probeState: 'ok' });
    expect(up?.probeDetail).toMatch(/^答上了：pong · 用时 \d+ 秒$/);
    expect(s.mirasim.count()).toBe(1);
    const [spec] = s.mirasim.specs;
    expect(spec).toMatchObject({
      prompt: pingPrompt(),
      agent: 'dsh',
      route: 'cloud',
      model: 'deepseek-flash',
      session: { mode: 'new' },
    });
    // 连接、账本都是以唯一的会话用户读的（mirasimDepsFor 的生产装配；这里是假的，只核对传的是哪个会话用户）
    expect(s.mirasim.options[0]?.ledgerDir).toBe('/fake/fleet-agent-carpool/.mirasim/traffic');
  });

  it('探通了：15 分钟后那一轮不再真探、不重写，结论照旧（还在线）；到 2 小时再真探（一次扣的是那份紧张的中转额度，#345）', async () => {
    const s = setup(answered, { mirasim: () => ({ state: { text: REPLY } }) });
    await s.round();
    expect(s.mirasim.count()).toBe(1);
    s.advance(15);
    const second = await s.round();
    expect(s.mirasim.count()).toBe(1);
    expect(second.online).toContain(routeId);
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW });
    s.advance(105);
    await s.round();
    expect(s.mirasim.count()).toBe(2);
    expect((await row(routeId))?.probedAt).toEqual(new Date(NOW.getTime() + 120 * 60_000));
  });

  it('路由上的模型串前缀认不出（glm-6）：起会话之前就被拦下，离线写明执行体未知，不落到 claude', async () => {
    const bad = await addMirasimRoute(t.db, {
      modelId: 'glm-6',
      upstreamModel: 'glm-6',
      stages: ['research'],
    });
    // 这条也是现插的种子（上一次「探通」是 5 分钟前）：不推到 3 小时前，2 小时的冷却会把这一轮当成「还没到点」整个跳过，
    // 到不了「起会话之前就被拦下」这条判断——和 beforeEach 里那条同一个道理。
    await t.client.query('update routes set probed_at = $2::timestamptz where id = $1', [
      bad.routeId,
      new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
    ]);
    const s = setup(answered, { mirasim: () => ({ state: { text: REPLY } }) });
    await s.round();
    const down = await row(bad.routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('起会话之前就被拦下了');
    expect(down?.probeDetail).toContain('执行体未知');
    expect(down?.probeDetail).toContain('Mirasim 认不出这个模型该起哪个执行体：glm-6');
    // 这条路由认不出，不连累另一条认得出的
    expect(await row(routeId)).toMatchObject({ alive: true, probeState: 'ok' });
  });

  it('服务端没有这个执行体、拒了这一针：离线，写明服务端的原话（不当成没起来重派）', async () => {
    const s = setup(answered, {
      mirasim: () => ({
        noAccept: true,
        report: { launchError: '服务端没有 dsh 这个执行体（有：claude、pi）' },
      }),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('没起来');
    expect(down?.probeDetail).toContain('服务端没有 dsh 这个执行体');
  });

  it('探针探不通——法国上这个会话用户的 Mirasim 服务连不上：离线、写明连不上，不当成还在线【故意造出的失败】', async () => {
    const s = setup(answered, {
      mirasim: () => ({ noAccept: true, report: { launchError: 'ECONNREFUSED' } }),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('没起来');
    expect(down?.probeDetail).toContain('ECONNREFUSED');
  });

  it('快照说 done，但账本没给目录：中转到底走没走上游没查成，不当成探通（DL3）', async () => {
    const s = setup(answered, {
      mirasim: () => ({ state: { text: REPLY }, report: { ledger: undefined } }),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('中转没查成');
    expect(down?.probeDetail).toContain('没给账本目录');
  });

  it('快照说 done，账本读到了、但起针之后没有一次 2xx：中转没真干活，不算探通', async () => {
    const s = setup(answered, {
      mirasim: () => ({
        state: { text: REPLY },
        report: {
          ledger: { state: 'read', rows: [{ status: 500, upstreamHost: 'x' }], unparsed: 0 },
        },
      }),
    });
    await s.round();
    const down = await row(routeId);
    expect(down).toMatchObject({ alive: false, probeState: 'failed' });
    expect(down?.probeDetail).toContain('账本里起针之后没有一次 2xx 的上游调用');
  });
});

// 真插头（runCursorAgent）、真起法（cursorLaunchCommand：会话用户自己读密钥、现找版本目录）、经假帮手真起进程：探针真带上了
// 那一把，库、日志、帮手收到的参数和环境、cursor-agent 收到的参数里都搜不到值。Windows 上起不了 /bin/sh，NTFS 也表示不了 600。
describe.skipIf(process.platform === 'win32')(
  'cursor 的 API 密钥真走一遍：探针带上了它，哪里都搜不到值',
  () => {
    let routeId: string;
    let rig: CursorKeyRig;
    beforeEach(async () => {
      ({ routeId } = await addCursorRoute(t.db, { stages: ['verify'] }));
      // 上一次探通是 3 小时前：cursor 探通了隔 2 小时再探，这一轮到点了
      await t.client.query('update routes set probed_at = $2::timestamptz where id = $1', [
        routeId,
        new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
      ]);
      rig = cursorKeyRig(root);
    });
    const cursorHold = async () =>
      (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey('cursor'));
    /** 库、引擎日志、帮手的记录、cursor-agent 收到的参数：值会漏去的地方拼在一起。 */
    const everywhere = async (logs: string[]) => [await dumpDb(t.client), rig.traces(), ...logs].join('\n');

    it('放好了：cursor-agent 拿到的就是文件里那一把（它只在对得上时回 OK），探通、在线；带 --trust 不带 --force；哪里都没有值', async () => {
      const s = setup(answered, { realCursor: rig });
      await s.round();
      const up = await row(routeId);
      expect(up?.probeDetail).toMatch(/^答上了：pong · /);
      expect(up).toMatchObject({ alive: true, probeState: 'ok' });
      const argv = rig.traces();
      expect(argv).toContain('--trust');
      expect(argv).not.toContain('--force');
      const all = await everywhere(s.logs);
      // 真攒上了东西：库里有这条路由，帮手记下了 run
      expect(all).toContain(routeId);
      expect(all).toContain('"action":"run"');
      expect(all).not.toContain(rig.key);
    });

    it('Cursor 拒了这一把（无效、被撤、过期）：离线、整池暂停，提醒写清去后台重新生成、照 ops 放进法国；哪里都没有值', async () => {
      rig.rejectKey();
      const s = setup(answered, { realCursor: rig });
      await s.round();
      const down = await row(routeId);
      expect(down).toMatchObject({ alive: false, probeState: 'failed' });
      expect(down?.probeDetail).toContain('The provided API key is invalid');
      expect(down?.probeDetail).toContain('cursor.com/dashboard/api');
      expect((await cursorHold())?.title).toContain('Cursor 登录失效');
      expect(await everywhere(s.logs)).not.toContain(rig.key);
    });

    it('密钥文件权限太松（644）：cursor-agent 不起，离线写清哪里不对，整池暂停；哪里都没有值', async () => {
      chmodSync(rig.keyFile, 0o644);
      const s = setup(answered, { realCursor: rig });
      await s.round();
      expect(rig.agentRan()).toBe(false);
      const down = await row(routeId);
      expect(down).toMatchObject({ alive: false, probeState: 'failed' });
      expect(down?.probeDetail).toContain(`${CURSOR_KEY_BAD}：权限是 644，要 600。文件是 ${rig.keyFile}`);
      expect(down?.probeDetail).toContain(`退出码 ${CURSOR_KEY_EXIT}`);
      expect((await cursorHold())?.title).toContain('Cursor 密钥没放好');
      expect(await everywhere(s.logs)).not.toContain(rig.key);
    });
  },
);
