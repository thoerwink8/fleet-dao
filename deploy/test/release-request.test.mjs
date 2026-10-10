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
  parseRequest,
  RELEASE_SH,
  REQUEST_DIR,
  REQUEST_FILE,
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

/** 假 io：记下每一次写和每一条命令；默认全部顺利。over 里的同名项盖掉默认。 */
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
  };
  let master = 'on';
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
    releaseBusy: async () => false,
    mainline: async () => ({ ok: true, onMain: true, at: '2026-10-07T11:00:00Z' }),
    ciRuns: async () => ({ status: 200, body: ciBody() }),
    fleetApi: async (args) => {
      log.fleetApi.push(args);
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
    sessions: async () => ({ ok: true, running: [] }),
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
    limits: { pollMs: 1000, sessionsMs: 5000, deployMs: 3000 },
    ...over,
  };
  return { io, log, setMaster: (m) => (master = m) };
}

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

test('顺利：九步各记一次进度，引擎先关、再 release.sh 发这个提交、验证、发完恢复到发版前（原来开着，开回），founderOk 带「驾驶舱点击发布」和点的人、时间', async () => {
  const { io, log } = fakeIo();
  assert.equal(await runRequest(io), EXIT.done);
  assert.deepEqual(log.release, [SHA]);
  assert.deepEqual(log.checkouts, [SHA]);
  assert.equal(log.check, 1);
  assert.equal(log.markers, 1);
  assert.equal(log.cleared, 1);
  assert.ok(log.fleetApi.some((a) => a.startsWith('engine off --reason')));
  assert.equal(engineOns(log).length, 1, '发完开回一次');
  assert.match(
    engineOns(log)[0],
    /engine on --reason '发版后恢复发版前的状态/,
    '原因写明是发版后恢复（进操作记录）',
  );
  assert.ok(log.fleetApi.indexOf(engineOns(log)[0]) > log.fleetApi.indexOf(engineOffs(log)[0]), '先关、后开');
  assert.equal(log.out.filter((l) => l.includes('总开关已开回')).length, 1);
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
  assert.equal(final.founderOk, `${FOUNDER_WORD} ${REQ_AT} 创始人`);
  assert.equal(final.release.started, true);
  assert.equal(log.lasts.at(-1).outcome, 'accepted');
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
    fleetApi: async (args) => {
      log.fleetApi.push(args);
      return { status: 1, stdout: '', stderr: '用法：fleet-api <命令>' };
    },
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
    fleetApi: async () => ({ status: 1, stdout: '', stderr: 'could not connect to database' }),
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.deepEqual(log.release, []);
  const last = log.states.at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.phase, 2);
  assert.match(last.why, /读不到/);
});

test('【故意造出的失败】关了引擎读回来还是开着：不往下走', async () => {
  const { io, log } = fakeIo({
    fleetApi: async (args) => {
      log.fleetApi.push(args);
      return { status: 0, stdout: '引擎总开关：开着\n', stderr: '' };
    },
  });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.match(log.states.at(-1).why, /还是开着/);
  assert.deepEqual(log.release, []);
});

test('【故意造出的失败】等了上限法国还有会话在跑：卡住（退出码 3），列出拖后腿的，没发版', async () => {
  const { io, log } = fakeIo({ sessions: async () => ({ ok: true, running: ['s1', 's2'] }) });
  assert.equal(await runRequest(io), EXIT.blocked);
  const last = log.states.at(-1);
  assert.equal(last.status, 'blocked');
  assert.equal(last.phase, 3);
  assert.deepEqual(last.laggards, ['会话 s1', '会话 s2']);
  assert.deepEqual(log.release, []);
  assert.ok(log.sleeps >= 4, '等过几轮');
});

test('【故意造出的失败】会话列表读不到：不当成 0 个，这一步没成', async () => {
  const { io, log } = fakeIo({ sessions: async () => ({ ok: false, why: '会话列表认不出' }) });
  assert.equal(await runRequest(io), EXIT.failed);
  assert.deepEqual(log.release, []);
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
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOffs(log).length, 0, '没有再关');
  assert.equal(engineOns(log).length, 0, '没有再开');
  assert.ok(log.out.some((l) => l.includes('发版期间有人开了')));
});

test('发版前开着、发布过程中被人先开回了：不重复开，算做完', async () => {
  const { io, log, setMaster } = fakeIo();
  const base = io.runRelease;
  io.runRelease = async (sha) => {
    const r = await base(sha);
    setMaster('on');
    return r;
  };
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOns(log).length, 0, '已经是开着，不再写一条重复的操作记录');
});

test('【故意造出的失败】发完恢复不成（engine on 失败）：没成，退出码 2，页面上是红的，写明发版已经发出去了、要到环境页点开，不当成成功', async () => {
  const { io, log } = fakeIo({}, { onFails: true });
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

test('【故意造出的失败】engine on 说成了、读回来总开关还是关着：恢复没成，不信「成了」', async () => {
  const { io, log } = fakeIo({}, { onSticks: true });
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

test('上一回点发布停在「卡住」（会话没收完、引擎是我们关的）：再点一次，发版前开着的带过来，发完照样开回，不当成「本来就关着」', async () => {
  const { io, log } = fakeIo({ sessions: async () => ({ ok: true, running: ['s1'] }) });
  assert.equal(await runRequest(io), EXIT.blocked);
  const stuck = JSON.parse(JSON.stringify(log.states.at(-1)));
  assert.equal(stuck.before.master, true);
  // 第二回：会话收完了；进度记录是上一回停下的那份；引擎还是关着（上一回关的）
  io.sessions = async () => ({ ok: true, running: [] });
  io.readState = () => ({ ok: true, state: stuck });
  log.fleetApi.length = 0;
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOffs(log).length, 0, '已经是关的，不再关');
  assert.equal(engineOns(log).length, 1, '发完开回');
  assert.equal(log.states.at(-1).before.master, true);
});

test('上一回进度还写 running、驱动进程已死、发版前开着（#1739）：再点一次带过来，发完开回，不当成「本来就关着」', async () => {
  const dead = {
    schema: 1,
    status: 'running',
    phase: 5,
    pid: 777,
    before: { master: true, repos: null, recordedAt: '2026-10-10T07:00:00.000Z' },
    target: { kind: 'sha', value: 'b'.repeat(40) },
  };
  const { io, log, setMaster } = fakeIo({
    readState: () => ({ ok: true, state: dead }),
    pidAlive: () => false,
  });
  setMaster('off'); // 上一回关的，还关着；若不带 before，会记成「本来就关着」发完保持关
  assert.equal(await runRequest(io), EXIT.done);
  assert.equal(engineOffs(log).length, 0, '已经是关的，不再关');
  assert.equal(engineOns(log).length, 1, '发完开回');
  assert.equal(log.states.at(-1).before.master, true);
  assert.ok(log.out.some((l) => l.includes('上一回停下时关的') || l.includes('总开关已开回')));
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
