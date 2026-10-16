// 驾驶舱「发布到法国」按钮的接活（deploy/france/release-request）：请求文件认得出才接、每个拒绝路径都有一条故意造出失败的测试、
// 走一趟的各步记进进度（和 release-train.json 同一个格式）、单元文件的路径和权限读回。
// 用法：node --test deploy/test/release-request.test.mjs（run.sh 的 node-tests 里跑）。
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HUMAN_TIER_PATHS } from '../france/auto-release/lib.mjs';
import {
  EXIT,
  FLEET_API,
  FOUNDER_WORD,
  LAST_FILE,
  LIMITS,
  MAX_REQUEST_BYTES,
  PHASES,
  parseAlerts,
  parseDrain,
  parseHealthz,
  parseRepoSwitches,
  parseRequest,
  RELEASE_ALERT_PREFIXES,
  RELEASE_SH,
  REQUEST_DIR,
  REQUEST_FILE,
  releaseMessage,
  releaseNote,
  repoSwitchDiff,
  runRequest,
  STATE_FILE,
  safeReadRequest,
  TRAIN_DIR,
} from '../france/release-request/lib.mjs';

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-10-07T12:00:00Z');
const REQ_AT = '2026-10-07T11:59:00.000Z';
const goodRequest = (over = {}) => JSON.stringify({ v: 1, sha: SHA, at: REQ_AT, by: '创始人', ...over });

const ciBody = (over = {}) =>
  JSON.stringify({
    workflow_runs: [
      {
        head_sha: SHA,
        event: 'push',
        head_branch: 'main',
        path: '.github/workflows/ci.yml@refs/heads/main',
        status: 'completed',
        conclusion: 'success',
        run_number: 7,
        ...over,
      },
    ],
  });

/** fleet-api alert show --json 的一行输出。 */
const alertJson = (alerts) =>
  `${JSON.stringify({ alerts: alerts.map((a, i) => ({ id: `id-${i}`, title: a.key, level: 'alert', createdAt: REQ_AT, ...a })), truncated: false, now: REQ_AT })}\n`;
const healthBody = (checks = { db: { ok: true } }) =>
  JSON.stringify({ ok: Object.values(checks).every((c) => c.ok), checks });
const SINCE = '2026-10-07 08:00:00+00';

/**
 * 假 io：记下每一次写和每一条命令；默认全部顺利。over 里的同名项盖掉默认。
 * opts.alerts(n)：第 n 次读开着的提醒（0 是发版前的基线）回哪几条；默认一条旧的、一直在。
 */
function fakeIo(over = {}, opts = {}) {
  let clock = T0;
  const log = {
    out: [],
    err: [],
    states: [],
    lasts: [],
    markers: 0,
    cleared: 0,
    fleetApi: [],
    release: [],
    check: 0,
    checkouts: [],
    sleeps: 0,
    pushes: [],
    notes: [],
    settled: 0,
    alertReads: 0,
    drains: 0,
  };
  let master = 'on';
  const alertsAt = opts.alerts ?? (() => [{ key: 'old:one' }]);
  const io = {
    now: () => new Date(clock),
    sleep: async (ms) => {
      log.sleeps += 1;
      clock += ms;
    },
    pid: 4242,
    pidAlive: () => false,
    out: (t) => log.out.push(t),
    err: (t) => log.err.push(t),
    readRequest: () => ({ kind: 'ok', text: goodRequest() }),
    readState: () => ({ ok: true, state: null }),
    writeState: (s) => log.states.push(JSON.parse(JSON.stringify(s))),
    writeLast: (o) => log.lasts.push(o),
    writeMarker: () => {
      log.markers += 1;
    },
    clearMarker: () => {
      log.cleared += 1;
    },
    markerExists: () => false,
    releaseBusy: async () => false,
    mainline: async () => ({ ok: true, onMain: true, at: '2026-10-07T11:00:00Z' }),
    ciRuns: async () => ({ status: 200, body: ciBody() }),
    fleetApi: async (args) => {
      log.fleetApi.push(args);
      if (args === 'alert show --json')
        return { status: 0, stdout: alertJson(alertsAt(log.alertReads++)), stderr: '' };
      if (args === 'engine status')
        return { status: 0, stdout: `引擎总开关：${master === 'on' ? '开着' : '关着'}\n`, stderr: '' };
      if (args.startsWith('engine off')) {
        master = 'off';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.startsWith('engine on')) {
        if (opts.onFails) return { status: 1, stdout: '', stderr: 'could not connect to database' };
        if (!opts.onSticks) master = 'on'; // onSticks：说成了但读回来还是关着
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '认不出的命令' };
    },
    // drain 接口保留，但第 3 步已不再读它（#2038）：读了就记一笔，测试核「没读」。
    drain: async () => {
      log.drains += 1;
      return { ok: true, engineDown: false, running: [] };
    },
    prepareCheckout: async (sha) => {
      log.checkouts.push(sha);
      return { ok: true };
    },
    runRelease: async (sha) => {
      log.release.push(sha);
      return { status: 0, stdout: '', stderr: '' };
    },
    releaseCheck: async () => {
      log.check += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
    historyLast: async () => ({ ok: true, line: `2026-10-07T12:10:00Z ${SHA} release` }),
    currentRelease: async () => ({ ok: true, sha: SHA }),
    healthz: async () => ({ status: 200, body: healthBody() }),
    mainHead: async () => ({ ok: true, sha: SHA, behind: 0 }),
    repoSwitches: async () => ({
      ok: true,
      repos: { 'thoerwink8/fleet-dao': SINCE, 'thoerwink8/other': null },
    }),
    notify: async (text, note) => {
      log.pushes.push(text);
      log.notes.push(note);
    },
    settleDone: async () => {
      log.settled += 1;
    },
    limits: { pollMs: 1000, sessionsMs: 5000, deployMs: 3000, verifyMs: 4000 },
    ...over,
  };
  return { io, log, setMaster: (m) => (master = m) };
}

/** 不读提醒的那些假 fleetApi（只管引擎开关的）用它把提醒那一条接上。 */
const withAlerts = (fn) => async (args) =>
  args === 'alert show --json' ? { status: 0, stdout: alertJson([]), stderr: '' } : fn(args);

const lastRefusal = (log) => log.lasts.find((l) => l.outcome === 'refused');
/** 被拒：退出码 1、记了原因（含 needle）、没动引擎也没发版、没写进度。 */
function assertRefused(code, log, needle) {
  assert.equal(code, EXIT.refused);
  const l = lastRefusal(log);
  assert.ok(l, '记了一条 refused');
  assert.match(l.why, needle);
  assert.deepEqual(log.release, [], '一次 release.sh 都没跑');
  assert.deepEqual(
    log.fleetApi.filter((a) => a.startsWith('engine off')),
    [],
    '没关引擎',
  );
  assert.equal(log.states.length, 0, '没碰 release-train.json');
}

// —— 顺利的一趟 ——

const engineOns = (log) => log.fleetApi.filter((a) => a.startsWith('engine on'));
const engineOffs = (log) => log.fleetApi.filter((a) => a.startsWith('engine off'));

test('顺利：九步各记一次进度，不关引擎总开关（决定 0093）、release.sh 发这个提交、验证、核对开关和发版前一致，founderOk 带「驾驶舱点击发布」和点的人、时间', async () => {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [SHA]);
  assert.deepEqual(log.checkouts, [SHA]);
  assert.equal(log.check, 1);
  assert.equal(log.markers, 0, '不写暂停标记');
  assert.equal(log.cleared, 1, '第 7 步照旧清标记');
  assert.equal(engineOffs(log).length, 0, '第 2 步不调 engine off');
  assert.equal(engineOns(log).length, 0, '第 7 步不碰总开关');
  assert.ok(log.out.some((l) => l.includes('不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）')));
  assert.ok(log.out.some((l) => l.includes('等收尾：跳过（release.sh 切版本前自己暂停在跑的任务，#2038）')));
  assert.equal(log.drains, 0, '第 3 步没读 drain');
  const phases = [...new Set(log.states.map((s) => s.phase))];
  assert.deepEqual(
    phases,
    PHASES.map((_, i) => i),
    '每一步都记过',
  );
  const final = log.states.at(-1);
  assert.equal(final.status, 'done');
  assert.equal(final.schema, 1);
  assert.deepEqual(final.target, { kind: 'sha', value: SHA, sha: SHA });
  assert.equal(final.restore, true);
  assert.equal(final.marker, false);
  assert.equal(final.pausedMaster, false);
  assert.equal(final.before.master, true, '发版前开着，记下了');
  assert.ok(!Number.isNaN(Date.parse(final.before.recordedAt)));
  assert.equal(final.founderOk, `${FOUNDER_WORD} ${REQ_AT} 创始人`);
  assert.equal(final.release.started, true);
  assert.equal(log.lasts[0].outcome, 'accepted');
  assert.equal(log.lasts.at(-1).outcome, 'done');
});

test('引擎本来就关着：跳过暂停，不再 off 一遍，照样发；发完仍关着（不替创始人开）', async () => {
  const { io, log, setMaster } = fakeIo();
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOffs(log).length, 0);
  assert.equal(engineOns(log).length, 0, '发版前就关着，发完不去开');
  assert.equal(log.markers, 0);
  assert.deepEqual(log.release, [SHA]);
  assert.equal(log.states.at(-1).before.master, false);
});

test('在用的版本还没有引擎总开关子命令（打用法）：当关着读，照样发', async () => {
  const { io, log } = fakeIo({
    fleetApi: withAlerts(async (args) => {
      log.fleetApi.push(args);
      return { status: 1, stdout: '', stderr: '用法：fleet-api <命令>' };
    }),
  });
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [SHA]);
});

test('release.sh 退出码 2（没红有待配）：记一句，接着验证，算做完', async () => {
  const { io, log } = fakeIo({ runRelease: async () => ({ status: 2, stdout: '', stderr: '' }) });
  assert.equal(await runRequest(io), EXIT.done);
  assert.ok(log.out.some((l) => l.includes('退出码 2')));
});

// —— 拒绝路径：每一条故意造出失败 ——

test('【故意造出的失败】没有请求文件：什么都不做，不写拒绝记录', async () => {
  const { io, log } = fakeIo({ readRequest: () => ({ kind: 'none' }) });
  assert.equal(await runRequest(io), EXIT.refused);
  assert.equal(log.lasts.length, 0);
  assert.equal(log.states.length, 0);
});

test('【故意造出的失败】请求文件不安全（符号链接、超长）：拒，记原因', async () => {
  const { io, log } = fakeIo({ readRequest: () => ({ kind: 'unsafe', why: '请求文件是符号链接' }) });
  assertRefused(await runRequest(io), log, /符号链接/);
});

for (const [name, text, needle] of [
  ['不是 JSON', 'not json', /不是 JSON/],
  ['是个数组', '[]', /不是一个对象/],
  ['提交号只有 39 位', goodRequest({ sha: 'a'.repeat(39) }), /40 位/],
  ['提交号是短号', goodRequest({ sha: 'aaaaaaa' }), /40 位/],
  ['提交号有大写', goodRequest({ sha: 'A'.repeat(40) }), /40 位/],
  ['提交号里有非十六进制', goodRequest({ sha: `${'a'.repeat(39)}g` }), /40 位/],
  ['提交号是 41 位', goodRequest({ sha: 'a'.repeat(41) }), /40 位/],
  ['多了一个键', goodRequest({ extra: 1 }), /键不对/],
  ['版本不是 1', goodRequest({ v: 2 }), /版本/],
  ['时间不是 ISO', goodRequest({ at: 'yesterday' }), /时间/],
  ['谁点的有引号', goodRequest({ by: 'a"b' }), /谁点的/],
  ['谁点的超长', goodRequest({ by: 'x'.repeat(65) }), /谁点的/],
]) {
  test(`【故意造出的失败】请求内容不对（${name}）：拒`, async () => {
    const { io, log } = fakeIo({ readRequest: () => ({ kind: 'ok', text }) });
    assertRefused(await runRequest(io), log, needle);
  });
}

test('【故意造出的失败】提交不是主线的祖先：拒，不关引擎、不发版', async () => {
  const { io, log } = fakeIo({ mainline: async () => ({ ok: true, onMain: false, at: '' }) });
  assertRefused(await runRequest(io), log, /不是主线的祖先/);
  assert.equal(lastRefusal(log).sha, SHA);
});

test('【故意造出的失败】取主线没成（读不到）：按拒绝，不当成在主线上', async () => {
  const { io, log } = fakeIo({ mainline: async () => ({ ok: false, why: '从 GitHub 取主线没成：超时' }) });
  assertRefused(await runRequest(io), log, /取主线没成/);
});

test('【故意造出的失败】进度记录说在走、那个进程还活着：已有发版在走，拒；进度记录原样不动', async () => {
  const running = {
    schema: 1,
    status: 'running',
    phase: 3,
    pid: 777,
    target: { kind: 'sha', value: 'b'.repeat(40) },
  };
  const { io, log } = fakeIo({ readState: () => ({ ok: true, state: running }), pidAlive: (p) => p === 777 });
  assertRefused(await runRequest(io), log, /已有发版在走/);
});

test('进度记录说在走、但那个进程已经没了（上一趟被打断）：不算在走，接着发新的', async () => {
  const stale = {
    schema: 1,
    status: 'running',
    phase: 3,
    pid: 777,
    target: { kind: 'sha', value: 'b'.repeat(40) },
  };
  const { io, log } = fakeIo({ readState: () => ({ ok: true, state: stale }), pidAlive: () => false });
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [SHA]);
});

test('【故意造出的失败】发布锁被占着（自动发布或人手动在发）：拒', async () => {
  const { io, log } = fakeIo({ releaseBusy: async () => true });
  assertRefused(await runRequest(io), log, /发布锁被占着/);
});

test('【故意造出的失败】看发布锁没成：按有发布在跑算，拒', async () => {
  const { io, log } = fakeIo({
    releaseBusy: async () => {
      throw new Error('flock 退出码 127');
    },
  });
  assertRefused(await runRequest(io), log, /看发布锁没成/);
});

test('【故意造出的失败】进度记录读不了：拒，不覆盖它', async () => {
  const { io, log } = fakeIo({ readState: () => ({ ok: false, why: 'EACCES' }) });
  assertRefused(await runRequest(io), log, /进度记录读不了/);
});

for (const [name, ciRuns, needle] of [
  ['CI 是红的', async () => ({ status: 200, body: ciBody({ conclusion: 'failure' }) }), /不是绿的（red）/],
  [
    'CI 还在跑',
    async () => ({ status: 200, body: ciBody({ status: 'in_progress', conclusion: null }) }),
    /不是绿的（pending）/,
  ],
  [
    '这个提交没有 CI 记录',
    async () => ({ status: 200, body: JSON.stringify({ workflow_runs: [] }) }),
    /不是绿的/,
  ],
  ['GitHub 回 403', async () => ({ status: 403, body: '{}' }), /读不到（GitHub 回 403）/],
  ['回话不是 JSON', async () => ({ status: 200, body: 'oops' }), /不是 JSON/],
  [
    '连不上 GitHub',
    async () => {
      throw new Error('fetch failed');
    },
    /读不到（fetch failed）/,
  ],
]) {
  test(`【故意造出的失败】CI 不绿（${name}）：拒，不拿读不到当绿`, async () => {
    const { io, log } = fakeIo({ ciRuns });
    assertRefused(await runRequest(io), log, needle);
  });
}

// —— 走到一半的失败 ——

test('【故意造出的失败】读不到引擎总开关：这一步没成，不发版', async () => {
  const { io, log } = fakeIo({
    fleetApi: withAlerts(async () => ({ status: 1, stdout: '', stderr: 'could not connect to database' })),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.deepEqual(log.release, []);
  const last = log.states.at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.phase, 2);
  assert.match(last.why, /读不到/);
});

test('第 2 步不调 engine off：总开关一直开着，照样发，fleet-api 一条 engine off/on 都没有', async () => {
  const { io, log } = fakeIo({
    fleetApi: withAlerts(async (args) => {
      log.fleetApi.push(args);
      return { status: 0, stdout: '引擎总开关：开着\n', stderr: '' };
    }),
  });
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [SHA]);
  assert.equal(engineOffs(log).length, 0);
  assert.equal(engineOns(log).length, 0);
  assert.ok(
    log.fleetApi.every((a) => a === 'engine status'),
    '只读总开关（提醒那条走 withAlerts，不进这里）',
  );
});

test('第 3 步不读 drain 直接过：引擎手上还有会话、甚至 drain 读不成，都不等、不拦，照发（#2038）', async () => {
  for (const drain of [
    async () => ({
      ok: true,
      running: [
        { runId: '11111111-aaaa', stage: 'execute' },
        { runId: '22222222-bbbb', stage: 'verify' },
      ],
    }),
    async () => ({ ok: false, why: 'drain.json 读不成：EACCES' }),
  ]) {
    let reads = 0;
    const { io, log } = fakeIo({
      drain: async () => {
        reads += 1;
        return drain();
      },
    });
    assert.equal(await runRequest(io), EXIT.done);
    assert.equal(reads, 0, '没读 drain');
    assert.deepEqual(log.release, [SHA], '没卡在等收尾，照发');
    assert.equal(log.sleeps, 0, '没等');
    assert.ok(log.out.some((l) => l.includes('等收尾：跳过')));
    assert.ok(!log.states.some((s) => s.status === 'blocked'), '没卡住过');
  }
});

test('parseDrain：引擎没在跑（serviceActive=false）回「不在跑、没会话」；pid 对不上不当成 0', () => {
  assert.deepEqual(parseDrain(null, '123', false), { ok: true, engineDown: true, running: [] });
  const mismatch = parseDrain('{"schema":2,"pid":999,"sessions":[]}', '123', true);
  assert.equal(mismatch.ok, false);
  assert.ok(!mismatch.engineDown);
  assert.match(mismatch.why, /上一个进程/);
  const ok = parseDrain(
    '{"schema":2,"pid":123,"sessions":[{"runId":"aaaaaaaa-1","stage":"execute"}]}',
    '123',
    true,
  );
  assert.deepEqual(ok, { ok: true, engineDown: false, running: [{ runId: 'aaaaaaaa-1', stage: 'execute' }] });
});

test('【故意造出的失败】部署检出没准备好：不跑 release.sh', async () => {
  const { io, log } = fakeIo({ prepareCheckout: async () => ({ ok: false, why: '有没提交的改动' }) });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.deepEqual(log.release, []);
  assert.match(log.states.at(-1).why, /部署检出没准备好/);
});

test('【故意造出的失败】release.sh 有红（退出码 1）：没成，记着已经动过手', async () => {
  const { io, log } = fakeIo({
    runRelease: async () => ({ status: 1, stdout: '', stderr: '健康检查没过，已退回' }),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  const last = log.states.at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.release.started, true);
  assert.match(last.why, /已退回/);
});

test('【故意造出的失败】release.sh 没跑完整（被超时杀）：说不知道发出去没有', async () => {
  const { io, log } = fakeIo({
    runRelease: async () => ({ status: null, stdout: '', stderr: '', error: 'spawnSync ETIMEDOUT' }),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.match(log.states.at(-1).why, /不知道发出去没有/);
});

test('【故意造出的失败】发布历史末行是 unhealthy：没成；末行一直不是目标：等到上限也没成', async () => {
  const a = fakeIo({
    historyLast: async () => ({ ok: true, line: `2026-10-07T12:10:00Z ${SHA} unhealthy` }),
  });
  assert.equal(await runRequest(a.io), EXIT.failed);
  assert.match(a.log.states.at(-1).why, /unhealthy/);
  assert.equal(engineOns(a.log).length, 0, '没过健康检查不恢复');
  const b = fakeIo({
    historyLast: async () => ({ ok: true, line: `2026-10-07T12:10:00Z ${'b'.repeat(40)} release` }),
  });
  assert.equal(await runRequest(b.io), EXIT.failed);
  assert.match(b.log.states.at(-1).why, /还不是目标/);
  const c = fakeIo({ historyLast: async () => ({ ok: false, why: 'ENOENT' }) });
  assert.equal(await runRequest(c.io), EXIT.failed);
});

test('【故意造出的失败】release.sh --check 有红：没成', async () => {
  const { io, log } = fakeIo({
    releaseCheck: async () => ({ status: 1, stdout: '', stderr: 'fleet-api 没在跑' }),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.match(log.states.at(-1).why, /--check 有红/);
});

test('发版前就关着、发布过程中被人开了：不再关回去，也不再开（发完按发版前记的，关着的保持关，不盖人的操作）', async () => {
  const { io, log, setMaster } = fakeIo();
  setMaster('off');
  const base = io.runRelease;
  io.runRelease = async (sha) => {
    const r = await base(sha);
    setMaster('on'); // 发布过程中被人开了
    return r;
  };
  // 发后体检照实报「总开关和发版前不一致」（不替人改回去）：版本发完了，退出码 3 要人看
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.equal(engineOffs(log).length, 0, '没有再关');
  assert.equal(engineOns(log).length, 0, '没有再开');
  assert.ok(log.out.some((l) => l.includes('发版期间有人动了')));
  const bad = log.states.at(-1).check.items.find((x) => x.name === '引擎总开关和发版前一致');
  assert.equal(bad.ok, false);
  assert.match(bad.text, /发版前关着，现在开着/);
});

test('发版前开着、发布过程中被人关了：第 7 步不自动开回（不是我们关的），体检报「总开关和发版前不一致」，退出码 3', async () => {
  const { io, log, setMaster } = fakeIo();
  const base = io.runRelease;
  io.runRelease = async (sha) => {
    const r = await base(sha);
    setMaster('off'); // 发布过程中被人关了
    return r;
  };
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.equal(engineOns(log).length, 0, '没替人开回');
  assert.equal(engineOffs(log).length, 0);
  assert.ok(log.out.some((l) => l.includes('这一趟没关过引擎总开关，不碰它')));
  const bad = log.states.at(-1).check.items.find((x) => x.name === '引擎总开关和发版前一致');
  assert.equal(bad.ok, false);
  assert.match(bad.text, /发版前开着，现在关着/);
  assert.equal(log.states.at(-1).status, 'done');
});

test('【故意造出的失败】老现场发完开回不成（engine on 失败）：没成，退出码 2，页面上是红的，写明发版已经发出去了、要到环境页点开，不当成成功', async () => {
  const { io, log } = await legacyRun({}, { onFails: true });
  assert.equal(await runRequest(io), EXIT.failed);
  const last = log.states.at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.phase, 7);
  assert.equal(last.release.started, true);
  assert.match(last.why, /恢复没成/);
  assert.match(last.why, /发版已经发出去了/);
  assert.match(last.why, /could not connect to database/);
  assert.ok(!log.out.some((l) => l.includes('总开关已开回')), '没有说「已开回」');
  assert.ok(log.err.some((l) => l.includes('恢复没成')));
});

test('【故意造出的失败】老现场 engine on 说成了、读回来总开关还是关着：恢复没成，不信「成了」', async () => {
  const { io, log } = await legacyRun({}, { onSticks: true });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.match(log.states.at(-1).why, /读回来总开关还是关着/);
});

test('【故意造出的失败】恢复那一步读不到总开关：没成，不猜着开或关', async () => {
  const { io, log } = fakeIo();
  const base = io.fleetApi;
  io.fleetApi = async (args) => {
    // 发完之后（已经发过版、走到第 7 步）读总开关读不到
    if (args === 'engine status' && log.release.length > 0 && log.states.at(-1)?.phase === 7)
      return { status: 1, stdout: '', stderr: 'could not connect to database' };
    return base(args);
  };
  assert.equal(await runRequest(io), EXIT.failed);
  const last = log.states.at(-1);
  assert.equal(last.phase, 7);
  assert.match(last.why, /恢复没成/);
  assert.equal(engineOns(log).length, 0);
});

test('【故意造出的失败】进度记录里没有发版前的总开关状态（before 缺）：恢复不猜，没成', async () => {
  const { io, log } = fakeIo();
  const base = io.writeState;
  io.writeState = (s) => {
    if (s.phase === 7) s.before = null;
    base(s);
  };
  assert.equal(await runRequest(io), EXIT.failed);
  assert.match(log.states.at(-1).why, /没记下发版前的总开关状态/);
  assert.equal(engineOns(log).length, 0);
});

test('发版没过健康检查（历史末行 unhealthy）：不恢复，引擎还关着等人看（只在健康检查过了才开回）', async () => {
  const { io, log } = fakeIo({
    historyLast: async () => ({ ok: true, line: `2026-10-07T12:10:00Z ${SHA} unhealthy` }),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.equal(engineOns(log).length, 0);
});

/**
 * 老版本留下的「停在第 3 步卡住」的进度记录：那时发版前开着、总开关是老版本关的（marker 为真），没有 pausedMaster 键。
 * 拿新版本顺利走一趟，截第 3 步那一刻的记录改成老样子（还没发版、还没体检）。
 */
async function legacyStuckState() {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  const s = clone(log.states.filter((x) => x.phase === 3).at(-1));
  assert.equal(s.release.started ?? false, false);
  s.status = 'blocked';
  s.why = '等了 13 分钟，法国还有 1 个会话在跑（老版本）';
  s.laggards = ['会话 execute(aaaa1111)'];
  s.before = { ...s.before, master: true };
  s.marker = true;
  delete s.pausedMaster;
  return s;
}

/** 老现场再点一次发布：进度记录是老版本卡住的那份，引擎还关着（老版本关的）。 */
async function legacyRun(over = {}, opts = {}) {
  const stuck = await legacyStuckState();
  const f = fakeIo({ readState: () => ({ ok: true, state: clone(stuck) }), ...over }, opts);
  f.setMaster('off');
  return f;
}

test('老现场（上一回老版本关了总开关、停在卡住）：再点发布，发版前开着的带过来、照旧记暂停标记，第 7 步开回', async () => {
  const { io, log } = await legacyRun();
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOffs(log).length, 0, '已经是关的，不再关');
  assert.equal(log.markers, 1, '照旧记暂停标记');
  assert.equal(engineOns(log).length, 1, '发完开回');
  assert.match(engineOns(log)[0], /engine on --reason '发版后恢复发版前的状态/, '原因写明是发版后恢复');
  assert.equal(log.out.filter((l) => l.includes('总开关已开回')).length, 1);
  const last = log.states.at(-1);
  assert.equal(last.before.master, true);
  assert.equal(last.pausedMaster, true);
  assert.equal(last.marker, false);
  assert.equal(last.check.ok, true, '开回后总开关和发版前一致');
});

test('【故意造出的失败】上一回是新版本没成的（没关过总开关）、现在总开关被人关了：不带上一回的「开着」，不当成我们关的，发完不开', async () => {
  const { io, log, setMaster } = fakeIo();
  io.readState = () => ({
    ok: true,
    state: {
      schema: 1,
      status: 'failed',
      phase: 4,
      pausedMaster: false,
      before: { master: true, repos: null },
      target: {},
    },
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOns(log).length, 0);
  assert.equal(log.markers, 0);
  assert.equal(log.states.at(-1).before.master, false, '按现在读到的记');
});

test('【故意造出的失败】上一回是做完了的（done）、这一回引擎发版前是关着：不带上一回的「开着」，发完保持关', async () => {
  const { io, log, setMaster } = fakeIo();
  io.readState = () => ({
    ok: true,
    state: { schema: 1, status: 'done', phase: 8, before: { master: true, repos: null }, target: {} },
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOns(log).length, 0);
});

// —— 发后体检、九步时间线、飞书（#2026）——

const checkOf = (log) => log.states.at(-1).check;
const itemOf = (log, name) => checkOf(log).items.find((x) => x.name === name);

test('发后体检全过：六项都通过，结论写进进度和 last-request.json，退出码 0', async () => {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  const check = checkOf(log);
  assert.equal(check.ok, true);
  assert.deepEqual(
    check.items.map((x) => x.name),
    [
      '目标提交在用',
      '/healthz',
      '没有新异常',
      '再跑一遍预检',
      '引擎总开关和发版前一致',
      '各仓接活开关没被动过',
    ],
  );
  assert.match(itemOf(log, '再跑一遍预检').text, /已是最新、没有要发的/);
  const last = log.lasts.at(-1);
  assert.equal(last.outcome, 'done');
  assert.equal(last.sha, SHA);
  assert.deepEqual(last.check, check);
  assert.equal(log.states.at(-1).before.repos['thoerwink8/fleet-dao'], SINCE, '第 2 步记下了各仓接活开关');
});

test('【故意造出的失败】发版后新出现一条和这次发版有关的卡住报警（auto-release:*）：体检没通过（立刻判，不等），开关不碰，退出码 3，推飞书「卡住」', async () => {
  const { io, log } = fakeIo(
    {},
    { alerts: (n) => (n === 0 ? [] : [{ key: 'auto-release:fleet-dao:failed', title: '自动发布挂了' }]) },
  );
  assert.equal(await runRequest(io), EXIT.blocked);
  const it = itemOf(log, '没有新异常');
  assert.equal(it.ok, false);
  assert.match(it.text, /新出现 1 条和这次发版有关的卡住报警：自动发布挂了（auto-release:fleet-dao:failed）/);
  assert.equal(log.sleeps, 0, '不是重启打断的那几类：不重试');
  assert.equal(engineOns(log).length, 0, '这一趟没关过总开关，不碰');
  assert.equal(log.states.at(-1).status, 'done');
  assert.equal(log.notes.length, 1, '只有体检没过这一条进通知');
  assert.equal(log.notes[0].kind, 'check');
  assert.match(log.pushes.at(-1), /【发版卡住】.*发后体检没通过：没有新异常/);
  assert.equal(log.notes.at(-1).level, 'decision', '体检没过进「要你拍」');
  assert.match(log.notes[0].key, /^release:check:aaaaaaaaaaaa:\d+$/);
  assert.match(log.pushes.at(-1), /aaaaaaaaaaaa/);
  assert.equal(log.settled, 0, '体检没过不收要你拍');
  assert.equal(log.lasts.at(-1).check.ok, false);
});

test('【故意造出的失败】发版后新出现 engine-drain 提醒：和这次发版有关，拦；同时出现的无关提醒列进说明', async () => {
  const { io, log } = fakeIo(
    {},
    {
      alerts: (n) =>
        n === 0
          ? []
          : [
              { key: 'engine-drain', title: '排空没收住' },
              { key: 'wf:failure:x', title: '任务失败' },
            ],
    },
  );
  assert.equal(await runRequest(io), EXIT.blocked);
  const it = itemOf(log, '没有新异常');
  assert.equal(it.ok, false);
  assert.match(it.text, /和这次发版有关的卡住报警：排空没收住（engine-drain）/);
  assert.match(it.text, /和这次发版无关的提醒，不拦：任务失败（wf:failure:x）/);
});

test('发版后新出现和这次发版无关的提醒（任务失败 wf:failure:、对账 reconcile:）：不拦，体检通过，说明里列出来', async () => {
  const { io, log } = fakeIo(
    {},
    {
      alerts: (n) =>
        n === 0
          ? []
          : [
              { key: 'wf:failure:x', title: '任务失败' },
              { key: 'reconcile:repo:a', title: '对账不平' },
            ],
    },
  );
  assert.equal(await runRequest(io), EXIT.done);
  const it = itemOf(log, '没有新异常');
  assert.equal(it.ok, true);
  assert.match(
    it.text,
    /发版后新出现 2 条和这次发版无关的提醒，不拦：任务失败（wf:failure:x）；对账不平（reconcile:repo:a）/,
  );
  assert.equal(log.sleeps, 0);
});

test('RELEASE_ALERT_PREFIXES：发版相关的五类键前缀', () => {
  assert.deepEqual(RELEASE_ALERT_PREFIXES, [
    'auto-release:',
    'engine-drain',
    'engine-session-io',
    'cli-upgrade:',
    'retired-schedule:',
  ]);
});

test('基线里就有的报警、任务挂起、再提醒、要你拍：都不算新异常', async () => {
  const { io, log } = fakeIo(
    {},
    {
      alerts: (n) =>
        n === 0
          ? [{ key: 'old:one' }]
          : [
              { key: 'old:one' },
              { key: 'task:a/b#1:park:2' },
              { key: 'remind:x:2026-10-07' },
              { key: 'approval:9', level: 'decision' },
            ],
    },
  );
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(itemOf(log, '没有新异常').ok, true);
});

test('发布重启打断的「每小时对账没跑成」（watchdog:job:*）：15 分钟窗口里重试，撤了就算过，不立刻判卡住', async () => {
  // 第 0 次是基线；第 1、2 次（发后）还开着；第 3 次撤了
  const { io, log } = fakeIo(
    { limits: { pollMs: 1000, sessionsMs: 5000, deployMs: 3000, verifyMs: 60_000 } },
    { alerts: (n) => (n === 1 || n === 2 ? [{ key: 'watchdog:job:hourly-reconcile:after-77' }] : []) },
  );
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(itemOf(log, '没有新异常').ok, true);
  assert.equal(log.sleeps, 2, '重试了两轮');
  assert.ok(
    log.states.some((s) => s.phase === 6 && /发后体检重试.*没有新异常/.test(s.waiting ?? '')),
    '时间线写着在等什么',
  );
});

test('【故意造出的失败】重启打断的那类过了窗口还没撤：体检没通过，写明还没撤', async () => {
  const { io, log } = fakeIo(
    {},
    { alerts: (n) => (n === 0 ? [] : [{ key: 'watchdog:job:hourly-reconcile:after-77' }]) },
  );
  assert.equal(await runRequest(io), EXIT.blocked);
  const it = itemOf(log, '没有新异常');
  assert.equal(it.ok, false);
  assert.match(it.text, /发布重启打断的 1 条还没撤/);
  assert.ok(log.sleeps >= 4, '等满了窗口（verifyMs 4 秒、每轮 1 秒）');
});

test('【故意造出的失败】开着的提醒读不到（发后）：体检那一项没通过，不当成没有异常', async () => {
  const { io, log } = fakeIo();
  const base = io.fleetApi;
  io.fleetApi = async (args) =>
    args === 'alert show --json' && log.alertReads++ > 0
      ? { status: 1, stdout: '', stderr: 'could not connect to database' }
      : base(args);
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.match(itemOf(log, '没有新异常').text, /读不到/);
});

test('【故意造出的失败】发版前异常基线读不到：第 0 步没成，什么都没动（没关引擎、没发版），推飞书「失败」', async () => {
  const { io, log } = fakeIo({
    fleetApi: async (args) => {
      log.fleetApi.push(args);
      if (args === 'alert show --json') return { status: 0, stdout: 'not json', stderr: '' };
      return { status: 0, stdout: '引擎总开关：开着\n', stderr: '' };
    },
  });
  assert.equal(await runRequest(io), EXIT.failed);
  const last = log.states.at(-1);
  assert.equal(last.phase, 0);
  assert.match(last.why, /发版前异常基线读不到/);
  assert.equal(engineOffs(log).length, 0);
  assert.deepEqual(log.release, []);
  assert.equal(log.notes.length, 1, '失败只写这一条通知，开始不写');
  assert.equal(log.notes[0].kind, 'failed');
  assert.match(log.pushes.at(-1), /【发版失败】aaaaaaaaaaaa 第 0 步「预检」没成/);
  assert.equal(log.notes.at(-1).level, 'decision', '失败进「要你拍」');
  assert.match(log.pushes.at(-1), /版本还没发/);
  assert.equal(log.lasts.at(-1).outcome, 'failed');
});

test('【故意造出的失败】/healthz 有发版前好好的、发版后坏了的项：体检没通过；发版前就坏的不算', async () => {
  const before = fakeIo({
    healthz: async () => ({
      status: 503,
      body: healthBody({ db: { ok: true }, quota: { ok: false, message: '旧问题' } }),
    }),
  });
  assert.equal(await runRequest(before.io), EXIT.done, '发版前就坏的项不算新坏');
  assert.match(itemOf(before.log, '/healthz').text, /发版前就不好的 1 项照旧/);

  let n = 0;
  const after = fakeIo({
    healthz: async () =>
      n++ === 0
        ? { status: 200, body: healthBody() }
        : { status: 503, body: healthBody({ db: { ok: false, message: '连不上库' } }) },
  });
  assert.equal(await runRequest(after.io), EXIT.blocked);
  assert.match(itemOf(after.log, '/healthz').text, /发版后新坏了：db（连不上库）/);
});

test('【故意造出的失败】/healthz 连不上：体检那一项没通过（窗口里重试过）', async () => {
  let n = 0;
  const { io, log } = fakeIo({
    healthz: async () =>
      n++ === 0 ? { status: 200, body: healthBody() } : { status: null, body: '', error: 'ECONNREFUSED' },
  });
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.match(itemOf(log, '/healthz').text, /连不上：ECONNREFUSED/);
  assert.ok(log.sleeps >= 4);
});

test('【故意造出的失败】法国在用的不是目标提交：体检没通过', async () => {
  const { io, log } = fakeIo({ currentRelease: async () => ({ ok: true, sha: 'b'.repeat(40) }) });
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.match(itemOf(log, '目标提交在用').text, /在用的是 bbbbbbbbbbbb，不是目标 aaaaaaaaaaaa/);
});

test('再跑一遍预检：发版期间主线又合进了新提交，这次要发的已在用，算通过并写一句；主线头读不到算没通过', async () => {
  const moved = fakeIo({ mainHead: async () => ({ ok: true, sha: 'c'.repeat(40), behind: 2 }) });
  assert.equal(await runRequest(moved.io), EXIT.done);
  assert.match(itemOf(moved.log, '再跑一遍预检').text, /又合进了 2 个提交/);

  const unread = fakeIo({ mainHead: async () => ({ ok: false, why: '从 GitHub 取主线没成：超时' }) });
  assert.equal(await runRequest(unread.io), EXIT.blocked);
  assert.match(itemOf(unread.log, '再跑一遍预检').text, /主线头读不到/);
});

test('【故意造出的失败】发版期间有仓的接活开关被动了：体检「各仓接活开关没被动过」没通过，写清哪个仓', async () => {
  let n = 0;
  const { io, log } = fakeIo({
    repoSwitches: async () => ({
      ok: true,
      repos: { 'thoerwink8/fleet-dao': n++ === 0 ? SINCE : null, 'thoerwink8/other': null },
    }),
  });
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.match(itemOf(log, '各仓接活开关没被动过').text, /thoerwink8\/fleet-dao（发版前开着，现在关着）/);
});

test('【故意造出的失败】各仓接活开关发版前读不到：第 2 步没成，没关引擎、没发版', async () => {
  const { io, log } = fakeIo({ repoSwitches: async () => ({ ok: false, why: 'psql 退出码 2' }) });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.equal(log.states.at(-1).phase, 2);
  assert.match(log.states.at(-1).why, /各仓接活开关发版前的样子读不到/);
  assert.equal(engineOffs(log).length, 0);
  assert.deepEqual(log.release, []);
});

test('九步时间线：每一步开始的时间都记在 steps 里，第 3 步不等（waiting 一直空着）', async () => {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  const final = log.states.at(-1);
  assert.equal(final.steps.length, PHASES.length);
  assert.ok(
    final.steps.every((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t))),
    '九步都有开始时间',
  );
  assert.ok(Date.parse(final.steps[4]) >= Date.parse(final.steps[3]), '第 4 步不比第 3 步早');
  assert.ok(
    log.states.filter((s) => s.phase === 3).every((s) => s.waiting === null),
    '第 3 步不在等什么',
  );
  assert.equal(final.waiting, null, '做完了不在等什么');
});

test('开始、成功只写进度，不写通知；成功时收掉之前开着的要你拍', async () => {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.notes, []);
  assert.deepEqual(log.pushes, []);
  assert.deepEqual(log.states.at(-1).pushes, []);
  assert.equal(log.states.at(-1).status, 'done');
  assert.equal(log.settled, 1);
});

test('发版提醒：只有 check、blocked、failed 写通知（decision）；开始、成功、重试、恢复、撤暂停回 null', () => {
  const st = { target: { value: SHA }, phase: 4, why: '停了' };
  const now = new Date(0);
  for (const kind of ['check', 'blocked', 'failed']) {
    const note = releaseNote(kind, st, '【x】y。z', now);
    assert.equal(note.level, 'decision', kind);
    assert.equal(note.key, `release:${kind}:aaaaaaaaaaaa:0`);
    assert.equal(note.title, '【x】y');
  }
  for (const kind of ['start', 'done', 'retry', 'restore', 'aborted']) {
    assert.equal(releaseNote(kind, st, '【x】y。z', now), null, kind);
  }
});

test('飞书：老版本停在等收尾的「卡住」带要点的「重试」；老现场开回没成推「失败」叫点「恢复引擎开关」；新版本没关过的不叫点它', () => {
  const stuck = releaseMessage('blocked', {
    target: { value: SHA },
    phase: 3,
    why: '等了 13 分钟，法国还有 1 个会话在跑',
  });
  assert.match(stuck, /^【发版卡住】aaaaaaaaaaaa 停在第 3 步「等收尾」：等了/);
  assert.match(stuck, /点「重试」/);
  const legacy = releaseMessage('failed', { target: { value: SHA }, phase: 7, why: '恢复没成' });
  assert.match(legacy, /^【发版失败】aaaaaaaaaaaa 第 7 步「恢复」没成/);
  assert.match(legacy, /点「恢复引擎开关」/);
  const fresh = releaseMessage('failed', {
    target: { value: SHA },
    phase: 7,
    why: '恢复没成',
    pausedMaster: false,
  });
  assert.doesNotMatch(fresh, /恢复引擎开关/);
});

test('飞书：老现场开回没成（真走一趟）推「失败」叫点「恢复引擎开关」', async () => {
  const restore = await legacyRun({}, { onFails: true });
  assert.equal(await runRequest(restore.io), EXIT.failed);
  assert.match(restore.log.pushes.at(-1), /^【发版失败】aaaaaaaaaaaa 第 7 步「恢复」没成/);
  assert.match(restore.log.pushes.at(-1), /点「恢复引擎开关」/);
  assert.equal(restore.log.lasts.at(-1).outcome, 'failed');
});

test('【故意造出的失败】要人看的发版提醒写不进通知：照样发完，进度里记「没记下」和原因，不当成记过', async () => {
  const { io, log } = fakeIo(
    {
      notify: async () => {
        throw new Error('写库没成（psql 退出码 2）：没配');
      },
    },
    { alerts: (n) => (n === 0 ? [] : [{ key: 'auto-release:fleet-dao:failed', title: '自动发布挂了' }]) },
  );
  assert.equal(await runRequest(io), EXIT.blocked);
  assert.deepEqual(log.release, [SHA]);
  const pushes = log.states.at(-1).pushes;
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].kind, 'check');
  assert.equal(pushes[0].ok, false);
  assert.match(pushes[0].why, /没配/);
  assert.ok(log.err.some((l) => l.includes('发版提醒没记下')));
});

test('parseAlerts / parseHealthz / parseRepoSwitches：认不出的一律回读不到，不当成没事', () => {
  assert.equal(
    parseAlerts({ status: 0, stdout: alertJson([{ key: 'a:b' }]), stderr: '' }).alerts[0].key,
    'a:b',
  );
  assert.equal(parseAlerts({ status: 1, stdout: '', stderr: 'boom' }).ok, false);
  assert.equal(parseAlerts({ status: 0, stdout: '{"x":1}', stderr: '' }).ok, false);
  assert.equal(parseAlerts({ status: 0, stdout: '{"alerts":[{"title":"t"}]}', stderr: '' }).ok, false);
  assert.deepEqual(parseHealthz({ status: 200, body: healthBody() }), { ok: true, bad: [] });
  assert.equal(parseHealthz({ status: 404, body: '' }).ok, false);
  assert.equal(parseHealthz({ status: 200, body: '{"ok":true}' }).ok, false);
  assert.deepEqual(parseRepoSwitches('a/b|2026-10-07 08:00:00+00\nc/d|\n'), {
    ok: true,
    repos: { 'a/b': '2026-10-07 08:00:00+00', 'c/d': null },
  });
  assert.equal(parseRepoSwitches('garbage').ok, false);
  assert.deepEqual(
    repoSwitchDiff({ 'a/b': '2026-10-07T08:00:00Z' }, { 'a/b': '2026-10-07 08:00:00+00' }),
    [],
  );
});

test('releaseMessage：五种结局的第一句各不相同，都带 12 位提交号', () => {
  const st = {
    target: { value: SHA },
    phase: 5,
    why: '历史末行是 unhealthy',
    requestedBy: '创始人',
    check: null,
  };
  for (const [kind, head] of [
    ['start', '【发版开始】'],
    ['done', '【发版成功】'],
    ['check', '【发版卡住】'],
    ['blocked', '【发版卡住】'],
    ['failed', '【发版失败】'],
  ]) {
    const m = releaseMessage(kind, st);
    assert.ok(m.startsWith(head), `${kind}：${m}`);
    assert.ok(m.includes(SHA.slice(0, 12)));
  }
});

// —— 卡住、失败后的按钮（#2027）：重试、恢复引擎开关、撤掉暂停 ——

const reqOf = (kind, over = {}) =>
  JSON.stringify(
    kind === 'restore' || kind === 'abort'
      ? { v: 1, kind, at: REQ_AT, by: '创始人', ...over }
      : { v: 1, kind, sha: SHA, at: REQ_AT, by: '创始人', ...over },
  );
const asRequest = (text) => ({ readRequest: () => ({ kind: 'ok', text }) });
const clone = (x) => JSON.parse(JSON.stringify(x));
const SESSIONS = [{ runId: 'aaaa1111-xxxx', stage: 'execute' }];

/** 老版本留下的停在「卡住」（等收尾超时）的进度记录（新版本第 3 步不再卡住）。 */
const stuckState = legacyStuckState;
/** 老现场走一趟停在「没成在恢复」（engine on 失败，发版已发出去），回那份进度记录。 */
async function restoreFailedState() {
  const { io, log } = await legacyRun({}, { onFails: true });
  assert.equal(await runRequest(io), EXIT.failed);
  return clone(log.states.at(-1));
}

test('parseRequest：老样子的发布请求（不带 kind）还是发布；带 kind 的四种各按各的键认', () => {
  assert.deepEqual(parseRequest(goodRequest()), {
    ok: true,
    kind: 'release',
    sha: SHA,
    at: REQ_AT,
    by: '创始人',
  });
  assert.equal(parseRequest(reqOf('release')).kind, 'release');
  assert.deepEqual(parseRequest(reqOf('retry')), {
    ok: true,
    kind: 'retry',
    sha: SHA,
    at: REQ_AT,
    by: '创始人',
  });
  assert.deepEqual(parseRequest(reqOf('restore')), {
    ok: true,
    kind: 'restore',
    sha: null,
    at: REQ_AT,
    by: '创始人',
  });
  assert.deepEqual(parseRequest(reqOf('abort')), {
    ok: true,
    kind: 'abort',
    sha: null,
    at: REQ_AT,
    by: '创始人',
  });
});

for (const [name, text, needle] of [
  ['未知的种类', reqOf('purge'), /种类认不出/],
  ['kind 是空', JSON.stringify({ v: 1, kind: null, sha: SHA, at: REQ_AT, by: '创始人' }), /种类认不出/],
  ['restore 带了提交号', reqOf('restore', { sha: SHA }), /键不对/],
  ['abort 带了提交号', reqOf('abort', { sha: SHA }), /键不对/],
  ['retry 没带提交号', JSON.stringify({ v: 1, kind: 'retry', at: REQ_AT, by: '创始人' }), /键不对/],
  ['retry 提交号是短号', reqOf('retry', { sha: 'abc' }), /40 位/],
]) {
  test(`【故意造出的失败】请求种类不对（${name}）：拒并写原因，不当成发布，不动现场`, async () => {
    const { io, log } = fakeIo(asRequest(text));
    assertRefused(await runRequest(io), log, needle);
    assert.equal(log.fleetApi.length, 0, '一条 fleet-api 命令都没跑');
  });
}

test('重试：停在「卡住（等收尾）」的那一趟，会话收完了，从第 3 步接着走——不再暂停一遍、不再记基线，发完开回总开关', async () => {
  const stuck = await stuckState();
  assert.equal(stuck.status, 'blocked');
  assert.equal(stuck.phase, 3);
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('retry')),
    readState: () => ({ ok: true, state: clone(stuck) }),
  });
  setMaster('off'); // 上一回关的，还关着
  assert.equal(await runRequest(io), EXIT.done);
  assert.ok(!log.out.some((l) => l.includes('第 0 步') || l.includes('第 2 步')), '没从头走');
  assert.ok(log.out.some((l) => l.includes('第 3 步「等收尾」')));
  assert.equal(engineOffs(log).length, 0, '没再关一遍引擎');
  assert.equal(log.alertReads, 1, '没再记基线：只有发后体检读了一次提醒');
  assert.deepEqual(log.release, [SHA], '发了这个提交一次');
  const last = log.states.at(-1);
  assert.equal(last.status, 'done');
  assert.deepEqual(last.resumes, [{ kind: 'retry', by: '创始人', at: REQ_AT }]);
  assert.equal(last.baseline.at, stuck.baseline.at, '基线还是第一回记的');
  assert.equal(last.steps[0], stuck.steps[0], '第 0 步的开始时间没被覆盖');
  assert.ok(last.before.master === true && engineOns(log).length === 1, '发版前开着的开回');
  assert.equal(log.lasts.find((l) => l.outcome === 'accepted').kind, 'retry');
  assert.equal(log.lasts.at(-1).kind, 'retry');
  assert.deepEqual(log.notes, [], '重试、成功都不写通知');
  assert.equal(log.settled, 1, '做完了仍收掉开着的要你拍');
});

test('重试：引擎手上还有会话——第 3 步不再等它（不读 drain），照样从第 3 步接着发完', async () => {
  const stuck = await stuckState();
  let reads = 0;
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('retry')),
    readState: () => ({ ok: true, state: clone(stuck) }),
    drain: async () => {
      reads += 1;
      return { ok: true, running: SESSIONS };
    },
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(reads, 0);
  assert.equal(log.states.at(-1).status, 'done');
  assert.deepEqual(log.release, [SHA]);
});

for (const [name, mutate, needle] of [
  ['没有进度记录', () => null, /没有可重试的/],
  ['这一趟没停在卡住（已经做完）', (s) => ({ ...s, status: 'done', phase: 8 }), /没有可重试的/],
  ['卡住的不是第 3 步', (s) => ({ ...s, phase: 5 }), /没有可重试的/],
  ['目标换了', (s) => ({ ...s, target: { kind: 'sha', value: 'b'.repeat(40) } }), /不是卡住那一趟的目标/],
]) {
  test(`【故意造出的失败】重试被拒（${name}）：写原因，不动进度记录，不关引擎，不发版`, async () => {
    const stuck = await stuckState();
    const { io, log } = fakeIo({
      ...asRequest(reqOf('retry')),
      readState: () => ({ ok: true, state: mutate(clone(stuck)) }),
    });
    assertRefused(await runRequest(io), log, needle);
  });
}

test('【故意造出的失败】重试时那一趟的进程还活着（进度说在走）：拒', async () => {
  const stuck = await stuckState();
  const { io, log } = fakeIo({
    ...asRequest(reqOf('retry')),
    readState: () => ({ ok: true, state: { ...clone(stuck), status: 'running', pid: 999 } }),
    pidAlive: () => true,
  });
  assertRefused(await runRequest(io), log, /没有可重试的/);
});

test('【故意造出的失败】重试时 CI 不绿：拒，不当成绿', async () => {
  const stuck = await stuckState();
  const { io, log } = fakeIo({
    ...asRequest(reqOf('retry')),
    readState: () => ({ ok: true, state: clone(stuck) }),
    ciRuns: async () => ({ status: 200, body: ciBody({ conclusion: 'failure' }) }),
  });
  assertRefused(await runRequest(io), log, /CI 不是绿的/);
});

test('恢复引擎开关：发版已发出、恢复那一步没成（总开关关着）——点了只重做第 7 步：开回、核对开关，不再发版，原因写明是点「恢复引擎开关」', async () => {
  const failed = await restoreFailedState();
  assert.equal(failed.phase, 7);
  assert.equal(failed.status, 'failed');
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('restore')),
    readState: () => ({ ok: true, state: clone(failed) }),
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [], '没有再发版');
  assert.equal(engineOffs(log).length, 0);
  const ons = engineOns(log);
  assert.equal(ons.length, 1);
  assert.match(ons[0], /驾驶舱点击恢复引擎开关，创始人/, '原因写进 fleet-api 的操作记录');
  const last = log.states.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.check.ok, true);
  assert.ok(last.check.items.some((x) => x.name === '引擎总开关和发版前一致' && x.ok));
  assert.deepEqual(last.resumes, [{ kind: 'restore', by: '创始人', at: REQ_AT }]);
  assert.equal(log.lasts.at(-1).kind, 'restore');
  assert.deepEqual(log.notes, [], '恢复引擎开关不写通知');
});

test('【故意造出的失败】恢复引擎开关时 engine on 还是失败：再记一次没成，退出码 2，不当成成功', async () => {
  const failed = await restoreFailedState();
  const { io, log, setMaster } = fakeIo(
    { ...asRequest(reqOf('restore')), readState: () => ({ ok: true, state: clone(failed) }) },
    { onFails: true },
  );
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.failed);
  assert.equal(log.states.at(-1).status, 'failed');
  assert.match(log.states.at(-1).why, /恢复没成/);
});

for (const [name, mutate, needle] of [
  ['没有进度记录', () => null, /没有可恢复引擎开关的/],
  ['这一趟不是没成（卡住）', (s) => ({ ...s, status: 'blocked' }), /没有可恢复引擎开关的/],
  ['没成的不是恢复那一步', (s) => ({ ...s, phase: 5 }), /没有可恢复引擎开关的/],
  [
    '发版前总开关就是关着',
    (s) => ({ ...s, before: { ...s.before, master: false } }),
    /发版前引擎总开关就是关着/,
  ],
  ['没记下发版前的状态', (s) => ({ ...s, before: null }), /发版前引擎总开关就是关着/],
  ['这一趟没关过总开关（新版本）', (s) => ({ ...s, pausedMaster: false }), /这一趟没关过引擎总开关/],
]) {
  test(`【故意造出的失败】恢复引擎开关被拒（${name}）：写原因，不开引擎`, async () => {
    const failed = await restoreFailedState();
    const { io, log } = fakeIo({
      ...asRequest(reqOf('restore')),
      readState: () => ({ ok: true, state: mutate(clone(failed)) }),
    });
    assertRefused(await runRequest(io), log, needle);
    assert.deepEqual(engineOns(log), []);
  });
}

test('撤掉暂停：只剩暂停标记、没有进度记录——只清标记，引擎总开关不动', async () => {
  const { io, log } = fakeIo({ ...asRequest(reqOf('abort')), markerExists: () => true });
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(log.cleared, 1);
  assert.equal(log.fleetApi.length, 0, '没碰引擎');
  assert.equal(log.states.length, 0, '没写进度记录');
  assert.equal(log.lasts.at(-1).outcome, 'aborted');
  assert.equal(log.lasts.at(-1).kind, 'abort');
  assert.deepEqual(log.notes, [], '撤掉暂停不写通知');
  assert.deepEqual(log.pushes, []);
});

test('撤掉暂停：卡住在等收尾（还没动手发版、发版前开着）——清标记、把引擎总开关开回暂停前的样子，状态记 aborted', async () => {
  const stuck = await stuckState();
  assert.equal(stuck.release.started ?? false, false);
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('abort')),
    readState: () => ({ ok: true, state: clone(stuck) }),
    markerExists: () => true,
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOns(log).length, 1);
  assert.match(engineOns(log)[0], /驾驶舱点击撤掉暂停，创始人/);
  assert.equal(log.cleared, 1);
  assert.equal(log.states.at(-1).status, 'aborted');
  assert.equal(log.states.at(-1).marker, false);
  assert.deepEqual(log.release, []);
});

test('撤掉暂停：已经动手发过版（没成在恢复）——保持关，不开引擎，只清标记、状态记 aborted（同命令行 abort）', async () => {
  const failed = await restoreFailedState();
  assert.equal(failed.release.started, true);
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('abort')),
    readState: () => ({ ok: true, state: clone(failed) }),
    markerExists: () => true,
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(engineOns(log), [], '已动手发过版：不开');
  assert.equal(log.cleared, 1);
  assert.equal(log.states.at(-1).status, 'aborted');
  assert.match(log.states.at(-1).why, /保持关/);
});

test('【故意造出的失败】撤掉暂停时 engine on 失败：不记成撤销，暂停标记还留着，退出码 2', async () => {
  const stuck = await stuckState();
  const { io, log, setMaster } = fakeIo(
    {
      ...asRequest(reqOf('abort')),
      readState: () => ({ ok: true, state: clone(stuck) }),
      markerExists: () => true,
    },
    { onFails: true },
  );
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.failed);
  assert.equal(log.cleared, 0, '标记还留着，能再点');
  assert.notEqual(log.states.at(-1).status, 'aborted');
  assert.match(log.states.at(-1).why, /撤掉暂停没成/);
  assert.equal(log.lasts.at(-1).outcome, 'failed');
});

test('【故意造出的失败】撤掉暂停被拒：没有标记也没有没了结的一趟 / 发版还在走 / 发布锁被占着', async () => {
  const none = fakeIo(asRequest(reqOf('abort')));
  assertRefused(await runRequest(none.io), none.log, /没什么要撤的/);

  const stuck = await stuckState();
  const running = fakeIo({
    ...asRequest(reqOf('abort')),
    readState: () => ({ ok: true, state: { ...clone(stuck), status: 'running', pid: 999 } }),
    pidAlive: () => true,
    markerExists: () => true,
  });
  assertRefused(await runRequest(running.io), running.log, /发版还在走/);

  const busy = fakeIo({
    ...asRequest(reqOf('abort')),
    markerExists: () => true,
    releaseBusy: async () => true,
  });
  assertRefused(await runRequest(busy.io), busy.log, /发布锁被占着/);
  assert.equal(busy.log.cleared, 0);
});

test('恢复引擎开关：老版本没成在第 7 步的那一趟（记录里没有 pausedMaster、标记已被老版本清掉）——照样开回', async () => {
  const failed = await restoreFailedState();
  const old = clone(failed);
  delete old.pausedMaster;
  old.marker = false;
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('restore')),
    readState: () => ({ ok: true, state: clone(old) }),
  });
  setMaster('off');
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOns(log).length, 1);
  assert.equal(log.states.at(-1).check.ok, true);
});

test('撤掉暂停：新版本没关过总开关的一趟（没成在发版前）——不开引擎，只清标记、状态记 aborted', async () => {
  const { io: io0, log: log0 } = fakeIo({
    prepareCheckout: async () => ({ ok: false, why: '有没提交的改动' }),
  });
  assert.equal(await runRequest(io0), EXIT.failed);
  const fresh = clone(log0.states.at(-1));
  assert.equal(fresh.pausedMaster, false);
  const { io, log, setMaster } = fakeIo({
    ...asRequest(reqOf('abort')),
    readState: () => ({ ok: true, state: clone(fresh) }),
  });
  setMaster('off'); // 被人关了：不是我们关的，不替人开
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(engineOns(log), []);
  assert.equal(log.cleared, 1);
  assert.equal(log.states.at(-1).status, 'aborted');
  assert.match(log.states.at(-1).why, /这一趟没关过引擎总开关/);
});

// —— 读请求文件（真文件系统）——

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'release-request-'));
  const dir = join(root, 'req');
  mkdirSync(dir);
  return {
    root,
    dir,
    file: join(dir, 'request.json'),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('safeReadRequest：普通文件读出来并删掉；没有文件、没有目录回 none', () => {
  const s = scratch();
  try {
    assert.deepEqual(safeReadRequest(s.dir, s.file), { kind: 'none' });
    writeFileSync(s.file, goodRequest());
    const r = safeReadRequest(s.dir, s.file);
    assert.equal(r.kind, 'ok');
    assert.equal(parseRequest(r.text).ok, true);
    assert.equal(existsSync(s.file), false, '读完删掉，path 单元不会重复起');
    assert.deepEqual(safeReadRequest(join(s.root, 'nope'), join(s.root, 'nope', 'request.json')), {
      kind: 'none',
    });
  } finally {
    s.done();
  }
});

test('【故意造出的失败】safeReadRequest：请求文件是符号链接：不跟着读它指的东西，链接删掉', () => {
  const s = scratch();
  try {
    const secret = join(s.root, 'secret');
    writeFileSync(secret, goodRequest());
    symlinkSync(secret, s.file);
    const r = safeReadRequest(s.dir, s.file);
    assert.equal(r.kind, 'unsafe');
    assert.match(r.why, /符号链接/);
    assert.equal(existsSync(s.file), false);
    assert.equal(existsSync(secret), true, '它指的文件没被动');
  } finally {
    s.done();
  }
});

test('【故意造出的失败】safeReadRequest：请求目录是符号链接：不读', () => {
  const s = scratch();
  try {
    const other = join(s.root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'request.json'), goodRequest());
    const link = join(s.root, 'link');
    symlinkSync(other, link);
    const r = safeReadRequest(link, join(link, 'request.json'));
    assert.equal(r.kind, 'unsafe');
    assert.equal(existsSync(join(other, 'request.json')), true, '没读也没删');
  } finally {
    s.done();
  }
});

test('【故意造出的失败】safeReadRequest：超过上限、请求文件其实是目录：拒', () => {
  const s = scratch();
  try {
    writeFileSync(s.file, 'x'.repeat(MAX_REQUEST_BYTES + 1));
    const big = safeReadRequest(s.dir, s.file);
    assert.equal(big.kind, 'unsafe');
    assert.match(big.why, /超过/);
    assert.equal(existsSync(s.file), false);
    mkdirSync(s.file);
    assert.equal(safeReadRequest(s.dir, s.file).kind, 'unsafe');
  } finally {
    s.done();
  }
});

// —— 单元的路径和权限（读回仓里的文件）——

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const repoFile = (rel) => new URL(`../../${rel}`, import.meta.url);

test('path 单元盯的就是后端写的请求文件、拉起的是接活的 service；路径写死在单元里', () => {
  const p = read('france/fleet-release-request.path');
  assert.match(p, new RegExp(`^PathExists=${REQUEST_FILE.replaceAll('/', '\\/')}$`, 'm'));
  assert.match(p, /^Unit=fleet-release-request\.service$/m);
  assert.match(p, /^WantedBy=multi-user\.target$/m);
  assert.ok(REQUEST_FILE.startsWith(`${REQUEST_DIR}/`));
});

test('service 以 root 跑（不写 User=）、跑的是装机装进去的那份脚本、正常的拒绝和卡住不显示 failed', () => {
  const s = read('france/fleet-release-request.service');
  assert.doesNotMatch(s, /^User=/m, '要 root：起发布、停服务');
  assert.match(s, /^Type=oneshot$/m);
  assert.match(
    s,
    /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/fleet-dao\/release-request\/fleet-release-request\.mjs$/m,
  );
  assert.match(s, /^SuccessExitStatus=1 3$/m);
  assert.equal(EXIT.refused, 1);
  assert.equal(EXIT.blocked, 3);
});

test('service 的 TimeoutStartSec 比脚本各步的上限加起来还长（不然 systemd 先把它杀了）', () => {
  const m = /^TimeoutStartSec=(\d+)min$/m.exec(read('france/fleet-release-request.service'));
  assert.ok(m, '写了 TimeoutStartSec=N min');
  const need =
    (LIMITS.sessionsMs +
      LIMITS.releaseMs +
      LIMITS.deployMs +
      LIMITS.checkMs +
      LIMITS.verifyMs +
      8 * LIMITS.stepMs +
      5 * 60_000) /
    60_000;
  assert.ok(Number(m[1]) >= need, `TimeoutStartSec=${m[1]}min 要不小于 ${need} 分钟`);
});

test('装机：请求目录归 fleet、750；进度目录归 root、755；是人工档（human-tier.sh 里，不在自动档函数里）', () => {
  const human = read('lib/human-tier.sh');
  const france = read('france.sh');
  assert.match(human, /^setup_release_request\(\) \{/m);
  assert.match(human, /ensure_dir "\$RELEASE_REQUEST_DIR" fleet:fleet 750/);
  assert.match(human, /ensure_dir "\$TRAIN_DIR" root:root 755/);
  assert.match(france, /^RELEASE_REQUEST_DIR=\/var\/lib\/fleet-dao\/release-request$/m);
  assert.equal(`${REQUEST_DIR}`, '/var/lib/fleet-dao/release-request');
  assert.match(france, /^TRAIN_DIR=\$RELEASES_DIR\/\.train$/m);
  assert.equal(TRAIN_DIR, '/srv/fleet-dao-releases/.train');
  // 整套里调、读回里查；自动档三个函数里没有它
  assert.match(france, /^ {4}setup_release_request$/m);
  assert.match(france, /^ {2}readback_release_request$/m);
  const autoTier = /^setup_auto_tier\(\) \{\n([\s\S]*?)\n\}/m.exec(france)?.[1] ?? '';
  assert.ok(autoTier.length > 10);
  assert.doesNotMatch(autoTier, /release_request/, '发布按钮的接活不进自动档');
  // 读回查属主权限
  assert.match(human, /"\$RELEASE_REQUEST_DIR fleet:fleet 750" "\$TRAIN_DIR root:root 755"/);
});

test('人工档登记：接活的单元和脚本都在 HUMAN_TIER_PATHS 里（改了它，后端 /healthz 才标「装机脚本落后」）', () => {
  for (const f of [
    'deploy/france/fleet-release-request.service',
    'deploy/france/fleet-release-request.path',
    'deploy/france/release-request/lib.mjs',
    'deploy/france/release-request/session-wait.mjs',
    'deploy/france/release-request/fleet-release-request.mjs',
  ]) {
    assert.ok(HUMAN_TIER_PATHS.includes(f), `${f} 不在 HUMAN_TIER_PATHS`);
    assert.ok(existsSync(repoFile(f)), `${f} 登记了、仓里却没有`);
  }
});

test('驾驶舱后端的单元放行请求目录这一处可写，没有放行进度目录（它只读）', () => {
  const api = read('france/fleet-api.service');
  const line = /^ReadWritePaths=(.*)$/m.exec(api)?.[1] ?? '';
  assert.match(line, /-\/var\/lib\/fleet-dao\/release-request/);
  assert.doesNotMatch(line, /\.train/);
});

test('接活脚本不碰符号链接目录之外的东西：state、last、marker 都写在 root 的进度目录下', () => {
  assert.ok(STATE_FILE.startsWith(`${TRAIN_DIR}/`));
  assert.ok(LAST_FILE.startsWith(`${TRAIN_DIR}/`));
  assert.ok(RELEASE_SH.startsWith('/srv/fleet-dao/'));
  assert.match(FLEET_API, /fleet-api$/);
});

test('发版提醒走通知中心：接活脚本和 lib 不再读 engine.env 的飞书 webhook，真实 notify 写 notifications（值走 psql -v）', () => {
  const script = read('france/release-request/fleet-release-request.mjs');
  const lib = read('france/release-request/lib.mjs');
  assert.doesNotMatch(script + lib, /FEISHU_WEBHOOK/);
  assert.doesNotMatch(script, /open\.feishu\.cn|FEISHU_PREFIXES/);
  assert.match(script, /insert into notifications \(level, dedupe_key, title, body, link\)/);
  assert.match(script, /:'level'::notification_level, :'key', :'title', :'body'/);
  assert.match(script, /resolved_by = 'release-request'/);
  assert.match(script, /starts_with\(dedupe_key, 'release:'\) and level = 'decision'/);
  assert.doesNotMatch(script, /release:start:/);
  assert.doesNotMatch(script, /已撤：同一提交已发版成功/);
});
