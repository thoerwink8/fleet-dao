// 自动发布单元（deploy/france/auto-release/lib.mjs）每条路：读数 + 主线绿了请求发版（决定 0032 的只读，被 0088 加上自动发，#2039）。
// 每一轮读主线头、它的 CI、在用的提交、落后几个，没有任何 v<N> 标记的仓上也照常；绝不调发布脚本、不看版本标记；
// 发完版（驾驶舱按钮）之后顺带装机自动档、同步规矩，没成报警；配置对账；状态文件读不出就什么都不做；
// 单元还会发版那会儿开的报警新版第一次跑撤一遍。
// git、GitHub、发布脚本、库都换成假的；真机上那一半（真定时器）合并后在法国装上验，记在引入本文件的 PR 里。
// 跑法：node --test deploy/test/auto-release.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessRunningRelease as sharedJudge } from '../../packages/store/src/running-release.mjs';
import {
  DESIRED_FILE,
  FINGERPRINT_ALGORITHM,
  fingerprintOf,
  keyIdOf,
  parseFingerprintKey,
} from '../france/auto-release/config.mjs';
import { realIo, requestWriters } from '../france/auto-release/fleet-auto-release.mjs';
import {
  AUTO_RELEASE_BY,
  AUTO_REQUEST_KEY,
  batchVerdict,
  CI_RUNS_PAGE,
  CI_WORKFLOW,
  CONFIG_PREFIX,
  CONFIG_UNCHECKED_KEY,
  ciVerdict,
  DEPS_PREFIX,
  EMERGENCY_KEY,
  ENGINE_RESTART_GAP_MS,
  emergencyIssue,
  gateVerdict,
  HEALTH_RETRY_LIMIT,
  HEALTH_RETRY_MS,
  HELD_ALERT_MS,
  HELD_KEY,
  HUMAN_TIER_PATHS,
  INSTALLED_COPIES,
  MARKER_CLEAR_ACTION,
  NO_SKILLS_USERS,
  PAUSE_FILE,
  PAUSED_ALERT_KEY,
  PAUSED_STALE_MS,
  parseEngineStatus,
  parseMainLog,
  prunedAtOf,
  RETIRED_ALERT_PREFIXES,
  RULES_PREFIX,
  RULES_USERS,
  runOnce,
  runRound,
  STARTED_FAIL_LIMIT,
  STATE_SCHEMA,
  STATE_UNREADABLE_KEY,
  startedFails,
  summary,
  TIER_BOOT_MS,
  TIER_PREFIX,
  TIER_RETRY_MS,
  TRAIN_MARKER_KEY,
  TRAIN_RESTORE_REASON,
  TRAIN_RESTORED_KEY,
  TRAIN_STALE_MS,
  UNTOUCHED_FAIL_LIMIT,
  untouchedFails,
} from '../france/auto-release/lib.mjs';
import { assessRunningRelease, readRunningRelease } from '../france/auto-release/running-release.mjs';
import { parseRequest } from '../france/release-request/lib.mjs';

const H0 = 'a'.repeat(40); // 在用的
const H1 = 'b'.repeat(40); // 主线头
const H2 = 'c'.repeat(40); // 后来又合进来的
const T0 = Date.parse('2026-09-27T08:00:00Z');
const MIN = 60_000;

const run = (sha, status, conclusion, extra = {}) => ({
  head_sha: sha,
  event: 'push',
  head_branch: 'main',
  path: `${CI_WORKFLOW}@main`,
  status,
  conclusion,
  run_number: 10,
  run_attempt: 1,
  created_at: '2026-09-27T07:31:00Z',
  ...extra,
});
const runsBody = (...runs) => ({
  status: 200,
  body: JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
});

// 配置对账用的一台假机器上的配置：在用那一版里的期望、线上两份环境文件、指纹钥匙，默认和期望一致
const KEY_TEXT = `${'3c'.repeat(32)}\n`;
const KEY = parseFingerprintKey(KEY_TEXT);
const SECRET = 'cli_fake飞书密钥_7788'; // 带 fake：卫生检查认得出是编的
const DESIRED = JSON.stringify({
  formatVersion: 1,
  selfHeal: false,
  fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: keyIdOf(KEY) },
  files: {
    'engine.env': { FLEET_WORK_DIR: '/var/lib/fleet-work', FLEET_ENGINE_PORTS: 'real' },
    'api.env': { FEISHU_APP_SECRET: { private: fingerprintOf(KEY, 'api.env', 'FEISHU_APP_SECRET', SECRET) } },
    'release.env': {},
    'france.env': {},
  },
});
const ENGINE_ENV = 'FLEET_WORK_DIR=/var/lib/fleet-work\nFLEET_ENGINE_PORTS=real\n';
const API_ENV = `FEISHU_APP_SECRET=${SECRET}\n`;

/**
 * 一台假机器：主线两个提交（H1 在 07:30 合进来、CI 绿），在用 H0（落后 1 个），检出和在用的同一个，装机自动档和规矩同步都会成。
 * 仓上**没有任何 v<N> tag**（假 io 里就没有读 tag 的口子）。下面这几个是「单元还会发版时」用的口子，换成一碰就记账再抛：
 * 新单元碰一下就是回到了按标记发（m.forbidden 必须一直是空的）。
 */
function machine() {
  const m = {
    t: T0,
    main: [
      [H1, '2026-09-27T07:30:00Z'],
      [H0, '2026-09-27T06:00:00Z'],
    ],
    mainError: null,
    current: H0,
    currentThrow: null,
    ci: runsBody(run(H1, 'completed', 'success')),
    ciThrow: null,
    rules: { code: 0, out: '  ✓ 一致' },
    checkoutHead: null, // null = 和在用的同一个
    ff: { ok: false, ahead: true }, // 检出和在用的不一样时快进的结果：默认「检出比在用的新」，不动
    ffCalls: 0,
    tier: { code: 0, out: '  ✓ 自动档一致' }, // france.sh --auto-tier 的结果
    tierCalls: 0,
    dbDown: false,
    // 配置对账读到的：期望（在用那一版里的）、线上的环境文件、指纹钥匙；configThrow = 读的时候就抛
    config: {
      desired: { text: DESIRED },
      files: {
        'engine.env': { text: ENGINE_ENV },
        'api.env': { text: API_ENV },
        'release.env': { text: '' },
        'france.env': { text: '' },
      },
      key: { text: KEY_TEXT },
    },
    configThrow: null,
    calls: [],
    forbidden: [],
    alerts: [],
    resolved: [],
    resolvedKeys: [],
    saved: [],
    // 第一轮就撤旧报警的那一步另有测试；这里默认当「已经撤过了」，免得每条测试都多出几次撤销
    state: { schema: STATE_SCHEMA, retiredCleared: true },
  };
  const banned = (name) => async () => {
    m.forbidden.push(name);
    throw new Error(`新的自动发布单元不该碰 ${name}`);
  };
  m.io = {
    now: () => new Date(m.t),
    async readMain() {
      m.calls.push('main');
      if (m.mainError) throw new Error(m.mainError);
      return m.main.map(([s, a]) => `${s} ${a}`).join('\n');
    },
    async readSystem() {
      return { applied: H0, log: '' };
    },
    async readCurrent() {
      if (m.currentThrow) throw new Error(m.currentThrow);
      return m.current;
    },
    async checkDeps() {
      return { result: 'ok', detail: 'fleet 用户读得了依赖入口文件' };
    },
    // 主线最近那些次 ci.yml 的运行（一次一整份）
    async ciRuns() {
      m.calls.push('ci');
      if (m.ciThrow) throw new Error(m.ciThrow);
      return m.ci;
    },
    async checkoutHead() {
      return m.checkoutHead ?? m.current;
    },
    async fastForwardCheckout(sha) {
      m.ffCalls += 1;
      if (m.ff.ok) m.checkoutHead = sha;
      return m.ff;
    },
    async applyAutoTier() {
      m.tierCalls += 1;
      return m.tier;
    },
    async syncRules(user) {
      m.calls.push(`rules ${user}`);
      return m.rules;
    },
    async alert(a) {
      if (m.dbDown) throw new Error('库连不上');
      m.alerts.push(a);
    },
    async resolve(prefix) {
      if (m.dbDown) throw new Error('库连不上');
      m.resolved.push(prefix);
    },
    async resolveKey(key) {
      if (m.dbDown) throw new Error('库连不上');
      m.resolvedKeys.push(key);
    },
    async readConfig() {
      if (m.configThrow) throw new Error(m.configThrow);
      return { commit: m.current, ...structuredClone(m.config) };
    },
    async save(st) {
      m.saved.push(structuredClone(st));
    },
    // 发版和按标记发才用的口子：碰了就是回头路
    runRelease: banned('runRelease'),
    releaseBusy: banned('releaseBusy'),
    prepareCheckout: banned('prepareCheckout'),
    engineOn: banned('engineOn'),
    readVersionTags: banned('readVersionTags'),
    isAncestorOfMain: banned('isAncestorOfMain'),
    readHistory: banned('readHistory'),
  };
  /** 跑一轮，状态接着上一轮的；清掉这一轮之前的调用记录。 */
  m.round = async () => {
    m.calls = [];
    m.state = await runOnce(m.io, m.state);
    return m.state;
  };
  return m;
}
/** 一台机器上主线又合进来一个 H2、驾驶舱按钮把它发上去了（在用的和检出都到 H2）。 */
function buttonReleaseTo(m, sha, at) {
  m.main.unshift([sha, at]);
  m.current = sha;
  m.ci = runsBody(run(sha, 'completed', 'success'));
}

// ── 只读：每一轮读什么、写什么 ──

test('【故意造出的失败】没有任何 v<N> 标记的仓上读数照常：写出主线头、在用、落后几个，不写成「不发」，不碰发布脚本和标记', async () => {
  const m = machine();
  const st = await m.round();
  assert.deepEqual(m.forbidden, [], '一个发布、标记、历史的口子都没碰');
  assert.equal(st.schema, STATE_SCHEMA);
  assert.equal(st.main.head, H1);
  assert.equal(st.main.commits.length, 2);
  assert.equal(st.current, H0);
  assert.deepEqual({ sha: st.ci.sha, verdict: st.ci.verdict }, { sha: H1, verdict: 'green' });
  assert.equal(st.last.action, 'behind');
  assert.match(st.last.detail, /落后主线 1 个提交/);
  assert.equal(m.alerts.length, 0, '落后几个不是毛病，不报警');
  // 以前因为没有标记写出来的那些东西，一样都没有
  for (const k of ['marker', 'markerError', 'attempt', 'hold', 'waitingSince', 'sequence'])
    assert.ok(!(k in st), `状态里不该再有 ${k}`);
  const line = summary(st);
  assert.match(line, /主线头 bbbbbbbbbbbb，CI green/);
  assert.match(line, /在用 aaaaaaaaaaaa，落后主线 1 个提交/);
  assert.match(line, /自动发版：这台没接上自动发版/, '没接上自动发版的口子（老 io）就只读，原因写在读数里');
  assert.doesNotMatch(line, /标记/);
  assert.equal(m.saved.length, 0, '存状态归调用方（runRound），runOnce 自己不存');
});

test('跟上了、不在主线最近的提交里、还没发布过：各写各的，读数里说得清', async () => {
  const m = machine();
  m.current = H1;
  let st = await m.round();
  assert.equal(st.last.action, 'up-to-date');
  assert.match(summary(st), /跟上了主线/);
  m.current = 'd'.repeat(40);
  st = await m.round();
  assert.equal(st.last.action, 'not-in-recent');
  assert.match(summary(st), /不在主线最近的提交里/);
  m.current = null;
  st = await m.round();
  assert.equal(st.last.action, 'not-released');
  assert.match(summary(st), /还没发布过/);
  assert.deepEqual(m.forbidden, []);
});

/** 链接已是主线头，主进程 cwd 由 readRunning 给。发版闸仍看链接。 */
function cwdMachine(running) {
  const m = machine();
  m.main = [
    [H2, '2026-10-16T12:23:00Z'],
    [H1, '2026-10-16T12:21:00Z'],
  ];
  m.current = H2;
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.io.readRunning = async () => running;
  return m;
}

test('引用闭包免重启：只认绑定实际进程、目标和服务的发布凭据，坏凭据照实失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-runtime-match-'));
  try {
    mkdirSync(join(dir, H2));
    const file = join(dir, H2, '.runtime-fleet-engine');
    let proc = { sha: H1 };
    const read = () =>
      readRunningRelease(
        dir,
        { sha: H2 },
        {
          proofUid: process.getuid?.() ?? 0,
          readProc: (unit) => (unit === 'fleet-engine.service' ? proc : { sha: H2 }),
          diffNames: () => ['agents/hooks/plugin-loader.mjs'],
        },
      );
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'process_cwd');
    writeFileSync(file, `${H2} ${H1} fleet-engine\n`);
    const running = read();
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running }).problem, null);
    proc = { sha: H0 };
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'process_cwd');
    proc = { error: '主进程目录读不到' };
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
    proc = { sha: H1 };
    assert.equal(
      assessRunningRelease({ current: { sha: H0 }, running }).problem.code,
      'process_cwd',
      '旧凭据不能给另一个目标用',
    );
    for (const [text, code] of [
      [`${H2} ${H2} fleet-engine\n`, 'process_cwd'],
      [`${H1} ${H1} fleet-engine\n`, 'unchecked'],
      [`${H2} ${H1} fleet-api\n`, 'unchecked'],
      ['broken', 'unchecked'],
    ]) {
      writeFileSync(file, text);
      assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, code);
    }
    rmSync(file);
    mkdirSync(file);
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
    rmSync(file, { recursive: true });
    const valid = `${H2} ${H1} fleet-engine\n`;
    writeFileSync(join(dir, 'other'), valid);
    symlinkSync(join(dir, 'other'), file);
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
    rmSync(file);
    writeFileSync(file, valid);
    if (process.platform !== 'win32') {
      chmodSync(file, 0o666);
      assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
      chmodSync(file, 0o644);
      chmodSync(join(dir, H2), 0o777);
      assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
      chmodSync(join(dir, H2), 0o755);
      const wrongOwner = readRunningRelease(
        dir,
        { sha: H2 },
        {
          proofUid: (process.getuid?.() ?? 0) + 1,
          readProc: (unit) => (unit === 'fleet-engine.service' ? proc : { sha: H2 }),
          diffNames: () => ['agents/hooks/plugin-loader.mjs'],
        },
      );
      assert.equal(
        assessRunningRelease({ current: { sha: H2 }, running: wrongOwner }).problem.code,
        'unchecked',
      );
    }
    renameSync(join(dir, H2), join(dir, 'real-target'));
    symlinkSync(join(dir, 'real-target'), join(dir, H2), 'dir');
    assert.equal(assessRunningRelease({ current: { sha: H2 }, running: read() }).problem.code, 'unchecked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进程 cwd 落后 current：journal 的在用不标成新提交，和健康检查同一份判定', async () => {
  assert.equal(assessRunningRelease, sharedJudge);
  assert.equal(typeof realIo.readRunning, 'function');
  const running = {
    engine: { sha: H1 },
    api: { sha: H1 },
    diffs: { [H1]: ['packages/store/src/deploy-lag.ts'] },
  };
  const st = await cwdMachine(running).round();
  assert.equal(st.current, H2, '发版闸仍看链接');
  const line = summary(st);
  const view = assessRunningRelease({ current: { sha: H2 }, running: st.running });
  assert.equal(view.sha, H1);
  assert.match(line, new RegExp(`在用 ${H1.slice(0, 12)}`));
  assert.doesNotMatch(line, new RegExp(`在用 ${H2.slice(0, 12)}`));
  assert.doesNotMatch(line, new RegExp(`在用的 ${H2.slice(0, 12)}`));
  assert.match(line, new RegExp(`链接 ${H2.slice(0, 12)}`));
  assert.match(line, /进程还在旧 release 目录/);

  const docsLine = summary(
    await cwdMachine({
      engine: { sha: H1 },
      api: { sha: H1 },
      diffs: { [H1]: ['docs/only.md'] },
    }).round(),
  );
  assert.match(docsLine, new RegExp(`在用 ${H2.slice(0, 12)}`));
  assert.doesNotMatch(docsLine, /进程还在旧 release 目录/);

  const alignedLine = summary(await cwdMachine({ engine: { sha: H2 }, api: { sha: H2 } }).round());
  assert.match(alignedLine, new RegExp(`在用 ${H2.slice(0, 12)}`));
  assert.doesNotMatch(alignedLine, /进程还在旧 release 目录/);

  const blindLine = summary(await cwdMachine({ engine: { error: '读不了' } }).round());
  assert.match(blindLine, /没查成：读不到进程在哪一版/);
  assert.doesNotMatch(blindLine, new RegExp(`在用 ${H2.slice(0, 12)}`));
});

test('主线头 CI：绿记下，后面几轮不再问 GitHub；红、没跑完、读不到都只记结论，不拦谁、不报警', async () => {
  const m = machine();
  await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c === 'ci'),
    ['ci'],
  );
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c === 'ci'),
    [],
    '同一个头已经读到全绿：一轮都不再问',
  );
  // 红：每轮再问一次（一轮最多一次），重跑绿了就记绿
  const red = machine();
  red.ci = runsBody(run(H1, 'completed', 'failure'));
  let st = await red.round();
  assert.equal(st.ci.verdict, 'red');
  assert.match(summary(st), /CI red/);
  red.t += 5 * MIN;
  st = await red.round();
  assert.deepEqual(
    red.calls.filter((c) => c === 'ci'),
    ['ci'],
  );
  red.ci = runsBody(run(H1, 'completed', 'success', { run_attempt: 2 }));
  red.t += 5 * MIN;
  assert.equal((await red.round()).ci.verdict, 'green');
  assert.equal(red.alerts.length, 0, 'CI 红不报警（单元不拦谁，红了驾驶舱自己标）');
  assert.deepEqual(red.forbidden, []);
});

test('主线头 CI 读不到（限流、回的不是 JSON、连不上、半小时还查不到）：记没查成和原因，不当成绿，下一轮再问', async () => {
  for (const [why, setup, detail] of [
    [
      '限流',
      (m) =>
        (m.ci = { status: 403, body: '{"message":"API rate limit exceeded"}', rate: '这个钟头还剩 0 次' }),
      /限流.*还剩 0 次/,
    ],
    ['不是 JSON', (m) => (m.ci = { status: 200, body: '<html>502</html>' }), /不是运行列表/],
    ['连不上', (m) => (m.ciThrow = 'getaddrinfo EAI_AGAIN api.github.com'), /连不上 GitHub/],
    ['查不到这次 CI', (m) => (m.ci = runsBody()), /CI 查不到/],
  ]) {
    const m = machine();
    setup(m);
    const st = await m.round();
    assert.equal(st.ci.verdict, 'unknown', why);
    assert.match(st.ci.detail, detail, why);
    m.t += 5 * MIN;
    await m.round();
    assert.ok(m.calls.includes('ci'), `${why}：没查成的不记住，下一轮再问`);
  }
});

test('刚合进来、CI 还没开跑或还在跑：记 pending', async () => {
  const m = machine();
  m.t = Date.parse('2026-09-27T07:35:00Z');
  m.ci = runsBody();
  assert.equal((await m.round()).ci.verdict, 'pending');
  m.ci = runsBody(run(H1, 'in_progress', null));
  assert.equal((await m.round()).ci.verdict, 'pending');
});

test('主线头读不到：记没查成（原因留着），上一次的主线读数不丢，不碰装机自动档和规矩', async () => {
  const m = machine();
  await m.round();
  const seen = m.state.main;
  const tiers = m.tierCalls;
  m.mainError = '从 GitHub 取主线失败（git 退出码 128）：Could not resolve host';
  m.t += 5 * MIN;
  const st = await m.round();
  assert.equal(st.last.action, 'main-unreadable');
  assert.match(st.mainError, /Could not resolve host/);
  assert.deepEqual(st.main, seen);
  assert.deepEqual(m.calls, ['main']);
  assert.equal(m.tierCalls, tiers);
});

test('在用的读不到：记没查成，不拿上一次的当这一次的，装机自动档和规矩这一轮不做', async () => {
  const m = machine();
  m.currentThrow = 'EACCES: permission denied';
  const st = await m.round();
  assert.equal(st.last.action, 'current-unreadable');
  assert.match(st.last.detail, /EACCES/);
  assert.equal(m.tierCalls, 0);
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
  );
});

// ── 发完版之后：规矩同步、装机自动档（单元自己不发版，驾驶舱按钮发完检出和在用的对上，下一轮它们就跟上）──

test('规矩同步：检出和在用的对上才同步；同一个提交只同步一次；没成记下、报警，好了撤；检出对不上不同步', async () => {
  const m = machine();
  m.rules = { code: 1, out: '  ✗ ~/.claude/CLAUDE.md 写不进去\n' };
  let st = await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    RULES_USERS.map((u) => `rules ${u}`),
  );
  assert.equal(st.rules.result, 'failed');
  assert.match(st.rules.detail, /写不进去/);
  assert.equal(m.alerts.length, 1);
  assert.equal(m.alerts[0].key, `${RULES_PREFIX}${H0}`);
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
    '同一个提交不重跑',
  );
  // 驾驶舱按钮发了 H2、同步成了：解除
  buttonReleaseTo(m, H2, '2026-09-27T08:20:00Z');
  m.rules = { code: 0, out: '  ✓ 一致' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.rules.result, 'ok');
  assert.equal(st.rules.commit, H2);
  assert.deepEqual(m.resolved, [RULES_PREFIX]);

  const off = machine();
  off.checkoutHead = H2;
  await off.round();
  assert.deepEqual(
    off.calls.filter((c) => c.startsWith('rules')),
    [],
    '检出不在在用的那个提交上：规矩不跟着乱动',
  );
  assert.deepEqual(m.forbidden, []);
});

test('【故意造出的失败】规矩同步停在旧提交、在用的版本已换（人手动 release.sh 发的、检出没跟上）：这一轮把检出快进过去、同步并记新提交；同一个提交不重跑', async () => {
  const m = machine();
  let st = await m.round();
  assert.equal(st.rules.commit, H0);
  // 在用的换成 H2，检出还停在 H0
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.current = H2;
  m.checkoutHead = H0;
  m.ff = { ok: true };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(m.ffCalls, 1);
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    RULES_USERS.map((u) => `rules ${u}`),
  );
  assert.deepEqual({ commit: st.rules.commit, result: st.rules.result }, { commit: H2, result: 'ok' });
  assert.equal(m.tierCalls, 2, '装机自动档用同一个判法：也跟上');
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
    '在用的和上次同步的一样：不重跑',
  );
  assert.equal(m.ffCalls, 1);
  assert.deepEqual(m.forbidden, []);
});

test('【故意造出的失败】检出快进没成：规矩和自动档都报警、不记成功、不跑同步；下一轮接着试，成了撤警', async () => {
  const m = machine();
  await m.round();
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.current = H2;
  m.checkoutHead = H0;
  m.ff = { ok: false, why: '部署检出 /srv/fleet-dao 有没提交的改动：M x' };
  m.t += 5 * MIN;
  let st = await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
  );
  assert.equal(st.rules.result, 'failed');
  assert.equal(st.rules.commit, H0, '不把新提交记成已同步');
  assert.match(st.rules.detail, /没提交的改动/);
  assert.deepEqual(m.alerts.map((a) => a.key).sort(), [`${RULES_PREFIX}${H2}`, `${TIER_PREFIX}${H2}`].sort());
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.ffCalls, 3, '第一轮自动档和规矩各试一次，这一轮只剩规矩再试（自动档 30 分钟内不重试）');
  m.ff = { ok: true };
  m.t += TIER_RETRY_MS;
  st = await m.round();
  assert.deepEqual({ commit: st.rules.commit, result: st.rules.result }, { commit: H2, result: 'ok' });
  assert.ok(m.resolved.includes(RULES_PREFIX));
});

test('装机自动档：发完一版顺带装，成了的提交不重装；没成记下、报警，隔 30 分钟自动再试，成了撤警；检出对不上、脚本起不来', async () => {
  const m = machine();
  let st = await m.round();
  assert.equal(m.tierCalls, 1, '检出和在用的对上就装自动档');
  assert.deepEqual({ commit: st.tier.commit, result: st.tier.result }, { commit: H0, result: 'ok' });
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.tierCalls, 1, '同一个提交装成了不重装');
  assert.equal(m.alerts.length, 0);

  // 【故意造出的失败】驾驶舱按钮发了新版、自动档没装成：只报警；30 分钟内不重试
  buttonReleaseTo(m, H2, '2026-09-27T08:20:00Z');
  m.tier = { code: 1, out: '  ✗ fleet-auto-release.timer 没在跑\n' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.tier.result, 'failed');
  assert.match(st.tier.detail, /没在跑/);
  assert.deepEqual(
    m.alerts.map((a) => a.key),
    [`${TIER_PREFIX}${H2}`],
  );
  assert.equal(m.tierCalls, 2);
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.tierCalls, 2, '没成的 30 分钟内不重试');
  // 过了间隔、这回成了：重试，撤警
  m.tier = { code: 2, out: '待配 1 项' }; // 退出码 2 = 没红、有待配：算装上了
  m.t += TIER_RETRY_MS;
  st = await m.round();
  assert.equal(m.tierCalls, 3);
  assert.equal(st.tier.result, 'ok');
  assert.deepEqual(m.resolved, [TIER_PREFIX]);

  // 检出和在用的不是同一个提交：不乱装
  const off = machine();
  off.checkoutHead = H2;
  await off.round();
  assert.equal(off.tierCalls, 0);
  // 脚本起不来（抛）也是没成、不是装成了
  const boom = machine();
  boom.io.applyAutoTier = async () => {
    throw new Error('bash 起不来');
  };
  st = await boom.round();
  assert.equal(st.tier.result, 'failed');
  assert.match(st.tier.detail, /bash 起不来/);
  assert.deepEqual(m.forbidden, []);
});

// 发版重启 fleet-mirasim-session 后，4318 要十几秒到一分多钟才 listen。curl 退出 7 在冷启动窗口内不是真失败。
const MIRASIM_REFUSED = {
  code: 1,
  out: '  ✗ fleet-mirasim-session.service 在跑但 http://127.0.0.1:4318/api/health 连不上或没回（curl 退出 7）：Connection refused\n',
};

function bootMachine(activeEnterOffset) {
  const m = machine();
  m.activeEnter = m.t + activeEnterOffset;
  m.mirasimRetired = false;
  m.io.mirasimActiveEnter = async () => m.activeEnter;
  m.io.mirasimRetired = async () => m.mirasimRetired;
  m.io.sleep = async (ms) => {
    m.t += ms;
  };
  return m;
}

test('冷启动窗口：第一次探 4318 连不上、短时间后探通，最终 ok；超过窗口仍连不上才 failed', async () => {
  const up = bootMachine(0); // 刚 ActiveEnter
  let n = 0;
  up.io.applyAutoTier = async () => {
    up.tierCalls += 1;
    n += 1;
    if (n === 1) return MIRASIM_REFUSED;
    return {
      code: 0,
      out: '  ✓ fleet-mirasim-session.service 在跑，http://127.0.0.1:4318/api/health 回 ok:true\n',
    };
  };
  let st = await up.round();
  assert.equal(st.tier.result, 'ok');
  assert.ok(up.tierCalls >= 2, '第一次连不上之后还会再探');
  assert.ok(up.t - up.activeEnter < TIER_BOOT_MS);
  assert.ok(up.t - up.activeEnter < TIER_RETRY_MS, '改回 ok 不干等 30 分钟');
  assert.equal(up.alerts.filter((a) => String(a.key).startsWith(TIER_PREFIX)).length, 0);

  const stuck = bootMachine(0);
  stuck.io.applyAutoTier = async () => {
    stuck.tierCalls += 1;
    return MIRASIM_REFUSED;
  };
  st = await stuck.round();
  assert.equal(st.tier.result, 'failed');
  assert.ok(stuck.t - stuck.activeEnter >= TIER_BOOT_MS);
  assert.ok(stuck.t - stuck.activeEnter < TIER_RETRY_MS, '判失败走冷启动窗口，不干等 30 分钟');
  assert.match(st.tier.detail, /curl 退出 7/);
  assert.ok(stuck.alerts.some((a) => a.key === `${TIER_PREFIX}${H0}`));

  // ActiveEnter 已经超出窗口：第一次探就连不上，立刻算真失败，不再空探
  const late = bootMachine(-TIER_BOOT_MS);
  late.io.sleep = async () => {
    throw new Error('窗口已过不该再睡');
  };
  late.io.applyAutoTier = async () => {
    late.tierCalls += 1;
    return MIRASIM_REFUSED;
  };
  st = await late.round();
  assert.equal(st.tier.result, 'failed');
  assert.equal(late.tierCalls, 1);
});

test('Mirasim 已退役时 4318 没 listen 不留冷启动窗口，立即按真实失败处理', async () => {
  const m = bootMachine(0);
  m.mirasimRetired = true;
  m.io.applyAutoTier = async () => {
    m.tierCalls += 1;
    return MIRASIM_REFUSED;
  };
  const st = await m.round();
  assert.equal(st.tier.result, 'failed');
  assert.equal(m.tierCalls, 1, '退役后不为冷启动窗口再次探测');
  assert.equal(m.t, T0, '退役后不等待冷启动窗口');
  assert.match(st.tier.detail, /curl 退出 7/);
  assert.ok(st.alerts.some((a) => a.key === `${TIER_PREFIX}${H0}`));
});

test('库连不上：报警留到下一轮再发，不丢', async () => {
  const m = machine();
  m.tier = { code: 1, out: '  ✗ 没装成\n' };
  m.dbDown = true;
  let st = await m.round();
  assert.equal(m.alerts.length, 0);
  assert.equal(st.alerts[0].raised, false);
  m.dbDown = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(m.alerts.length, 1);
  assert.equal(st.alerts[0].raised, true);
});

// ── 单元还会发版那会儿开的报警：新版第一次跑撤一遍，不让它们永远挂在驾驶舱上 ──

test('【故意造出的失败】老状态里留着发布没成、版本标记、引擎没查成那些报警：第一轮全撤，没发出去的丢掉，老字段不带进新状态，撤过了不再撤', async () => {
  const m = machine();
  const old = {
    schema: STATE_SCHEMA,
    ranAt: '2026-10-07T10:00:00.000Z',
    marker: { tag: 'v9', commit: H1, at: '2026-09-27T07:30:00Z', checkedAt: '2026-10-07T10:00:00.000Z' },
    markerError: null,
    rules: { commit: H0, at: '2026-10-07T10:00:00.000Z', result: 'ok', detail: '' },
    attempt: { sha: H1, startedAt: '2026-10-07T09:00:00.000Z', result: 'failed' },
    hold: null,
    waitingSince: null,
    sequence: { engineOn: true, steps: [] },
    alerts: [
      { key: `auto-release:failed:${H1}`, title: '发布没成', body: 'x', raised: true },
      { key: 'auto-release:marker-unreadable', title: '读不到标记', body: 'x', raised: false },
      { key: `${RULES_PREFIX}${H0}`, title: '规矩没成', body: 'x', raised: true },
    ],
    resolve: [],
    resolveKeys: [],
  };
  m.state = old;
  const st = await m.round();
  assert.deepEqual(m.resolved.sort(), [...RETIRED_ALERT_PREFIXES].sort(), '每一类旧报警的前缀都撤了一遍');
  assert.deepEqual(
    st.alerts.map((a) => a.key),
    [`${RULES_PREFIX}${H0}`],
    '还归这个单元管的留着；发布没成、标记那几条不再有',
  );
  assert.equal(st.retiredCleared, true);
  for (const k of ['marker', 'markerError', 'attempt', 'hold', 'waitingSince', 'sequence'])
    assert.ok(!(k in st), `老字段 ${k} 不带进新状态`);
  assert.deepEqual(st.resolve, []);
  // 撤过了：下一轮不再撤
  m.resolved.length = 0;
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(m.resolved, []);
});

test('老报警撤的时候库连不上：留到下一轮接着撤，撤成了才算撤过', async () => {
  const m = machine();
  m.state = { schema: STATE_SCHEMA, alerts: [], resolve: [], resolveKeys: [] };
  m.dbDown = true;
  let st = await m.round();
  assert.deepEqual(m.resolved, []);
  assert.deepEqual(st.resolve.sort(), [...RETIRED_ALERT_PREFIXES].sort(), '没撤成的记着');
  m.dbDown = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(m.resolved.sort(), [...RETIRED_ALERT_PREFIXES].sort());
  assert.deepEqual(st.resolve, []);
});

// ── 配置对账（#323）：每一轮拿线上的环境文件跟在用那一版里的期望比 ──

const configAlerts = (m) =>
  m.alerts.filter((a) => a.key.startsWith(CONFIG_PREFIX) || a.key === CONFIG_UNCHECKED_KEY);

test('配置一致：不报警；状态里记一致', async () => {
  const m = machine();
  const st = await m.round();
  assert.equal(st.config.result, 'ok');
  assert.deepEqual(configAlerts(m), []);
});

test('线上配置被手改：下一轮报出偏离、指明哪一项，不每轮重发；改回去下一轮报警自己撤', async () => {
  const m = machine();
  await m.round();
  m.config.files['engine.env'].text = ENGINE_ENV.replace('/var/lib/fleet-work', '/tmp/手改');
  m.t += 5 * MIN;
  let st = await m.round();
  assert.equal(st.config.result, 'drift');
  assert.deepEqual(st.config.drift, [{ id: 'engine.env:FLEET_WORK_DIR', kind: 'value' }]);
  assert.deepEqual(
    configAlerts(m).map((a) => a.key),
    [`${CONFIG_PREFIX}engine.env:FLEET_WORK_DIR`],
  );
  assert.match(configAlerts(m)[0].title, /engine\.env 的 FLEET_WORK_DIR/);
  assert.match(summary(st), /配置有 1 项和期望不一致（engine\.env:FLEET_WORK_DIR）/);
  for (let i = 0; i < 2; i++) {
    m.t += 5 * MIN;
    await m.round();
  }
  assert.equal(configAlerts(m).length, 1, '一直没改：报警只发一次');
  m.config.files['engine.env'].text = ENGINE_ENV;
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.config.result, 'ok');
  assert.deepEqual(m.resolvedKeys, [`${CONFIG_PREFIX}engine.env:FLEET_WORK_DIR`], '按整个键解除，不按前缀');
  assert.deepEqual(m.resolved, [], '别的报警一条没碰');
});

test('私有值不一致：只报「不一致」，状态文件、报警、读数里都搜不到线上的值和原来的值', async () => {
  const m = machine();
  m.config.files['api.env'].text = 'FEISHU_APP_SECRET=cli_被人换掉的\n';
  const st = await m.round();
  assert.deepEqual(st.config.drift, [{ id: 'api.env:FEISHU_APP_SECRET', kind: 'private' }]);
  assert.match(configAlerts(m)[0].body, /私有值.*不打印/);
  const everything = JSON.stringify({ st, alerts: m.alerts, saved: m.saved, line: summary(st) });
  for (const v of ['cli_被人换掉的', SECRET]) assert.ok(!everything.includes(v), `出现了值「${v}」`);
});

test('期望读不到、认不出，钥匙不对，对账自己抛了：记没查成、报一条，不当成一致；查成了自己撤', async () => {
  for (const [what, setup, why] of [
    [
      '在用的版本没有期望文件',
      (m) => (m.config.desired = { error: '没有 …/desired-config.json' }),
      /读不到期望/,
    ],
    ['期望不是 JSON', (m) => (m.config.desired = { text: '{' }), /不是 JSON/],
    ['钥匙换了', (m) => (m.config.key = { text: `${'00'.repeat(32)}\n` }), /不是期望文件记的那一把/],
    ['读的时候抛了', (m) => (m.configThrow = 'EACCES'), /对账没跑成.*EACCES/],
  ]) {
    const m = machine();
    setup(m);
    const st = await m.round();
    assert.notEqual(st.config.result, 'ok', what);
    assert.match(st.config.unchecked.join('；'), why, what);
    assert.deepEqual(
      configAlerts(m).map((a) => a.key),
      [CONFIG_UNCHECKED_KEY],
      what,
    );
    assert.match(summary(st), /配置没查成/, what);
    const fresh = machine();
    m.config = fresh.config;
    m.configThrow = null;
    m.t += 5 * MIN;
    await m.round();
    assert.deepEqual(m.resolvedKeys, [CONFIG_UNCHECKED_KEY], `${what}：查成了自己撤`);
  }
});

test('配置报警库连不上：留到下一轮再发、再撤，不丢', async () => {
  const m = machine();
  m.config.files['engine.env'].text = ENGINE_ENV.replace('real', 'fake');
  m.dbDown = true;
  let st = await m.round();
  assert.equal(configAlerts(m).length, 0);
  assert.equal(st.alerts.find((a) => a.key.startsWith(CONFIG_PREFIX)).raised, false);
  m.dbDown = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(configAlerts(m).length, 1);
  m.config.files['engine.env'].text = ENGINE_ENV;
  m.dbDown = true;
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(m.resolvedKeys, []);
  assert.deepEqual(st.resolveKeys, [`${CONFIG_PREFIX}engine.env:FLEET_ENGINE_PORTS`], '解除留到下一轮');
  m.dbDown = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(m.resolvedKeys, [`${CONFIG_PREFIX}engine.env:FLEET_ENGINE_PORTS`]);
  assert.deepEqual(st.resolveKeys, []);
});

test('CI 结论：只认这个提交在 main 上那次 push 的 ci.yml，取最新一次', () => {
  const now = T0;
  const at = '2026-09-27T07:30:00Z';
  const v = (...runs) => ciVerdict({ workflow_runs: runs }, H1, at, now).verdict;
  assert.equal(
    v(run(H1, 'completed', 'success', { path: CI_WORKFLOW })),
    'green',
    '老版本接口的 path 不带 @main',
  );
  assert.equal(v(run(H1, 'completed', 'cancelled')), 'red');
  assert.equal(v(run(H1, 'completed', 'success', { head_branch: 'feature' })), 'unknown', '别的分支不算');
  assert.equal(v(run(H1, 'completed', 'success', { event: 'pull_request' })), 'unknown', '别的事件不算');
  assert.equal(
    v(run(H1, 'completed', 'success', { path: '.github/workflows/debt.yml@main' })),
    'unknown',
    '别的工作流不算',
  );
  assert.equal(v(run(H0, 'completed', 'success')), 'unknown', '别的提交不算');
  assert.equal(
    v(
      run(H1, 'completed', 'failure', { run_number: 9 }),
      run(H1, 'completed', 'success', { run_number: 10 }),
    ),
    'green',
  );
  assert.equal(
    v(run(H1, 'completed', 'success', { run_attempt: 1 }), run(H1, 'in_progress', null, { run_attempt: 2 })),
    'pending',
    '重跑的那次还没完',
  );
  assert.equal(ciVerdict({ nope: 1 }, H1, at, now).verdict, 'unknown');
  assert.equal(ciVerdict(null, H1, at, now).verdict, 'unknown');
});

test('解析：主线列表认不出就抛，不拿半截当全部', () => {
  assert.throws(() => parseMainLog(''), /空/);
  assert.throws(() => parseMainLog(`${H1} 不是时间`), /认不出/);
  assert.equal(parseMainLog(`${H1} 2026-09-27T07:30:00+02:00\n`)[0].at, '2026-09-27T05:30:00.000Z');
});

test('规矩同步给的人和 france.sh 的 AGENT_RULES_USERS 一样', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../lib/session-user.sh', import.meta.url), 'utf8');
  const sessionUser = /^SESSION_USER=(\S+)$/m.exec(session)?.[1];
  const pilot = /^PILOT_USER=(\S+)$/m.exec(france)?.[1];
  assert.ok(sessionUser && pilot, '读到了会话用户和 pilot');
  assert.match(france, /^AGENT_RULES_USERS=\("\$\{SESSION_USERS\[@\]\}" "\$PILOT_USER"\)$/m);
  assert.match(france, /^SESSION_USERS=\("\$SESSION_USER"\)$/m);
  assert.deepEqual(RULES_USERS, [sessionUser, pilot]);
  // 不装 skill 的是会话用户（france.sh 的 agent_rules_sync 按 SESSION_USERS 判，决定 0093）
  assert.deepEqual(NO_SKILLS_USERS, [sessionUser]);
  assert.match(france, /agent_rules_sync --apply "\$u"/);
  assert.match(france, /agent_rules_sync --check "\$u"/);
  assert.match(
    france,
    /for s in "\$\{SESSION_USERS\[@\]\}"; do\n[^\n]*\n\s+agents_sync "\$1" "\$2" --no-skills/,
  );
});

// 装机分两档（docs/ops.md 第九节「装机层」）：人工档（lib/human-tier.sh 里的函数，碰防火墙、sudoers、建用户）改了要人重跑、
// 才让 deploy_lag 红；自动档（下面这份清单）由自动发布顺带跑 france.sh --auto-tier。其余是整套装机才用的（装软件、钉版本），
// 不在两档里。新加一个被 france.sh 引用的仓里文件，必须在这里登记它属于哪一档，免得悄悄漏了。
const AUTO_TIER_FILES = [
  'deploy/france/fleet-agents.slice',
  // root 的 ssh 会话内存上限（#2842）
  'deploy/france/user-0-slice-memory.conf',
  'deploy/france/fleet-auto-release.service',
  'deploy/france/fleet-auto-release.timer',
  // 按目录量磁盘占用（#3456）：root 的 oneshot + 定时器 + 脚本和目录清单副本，自动档
  'deploy/france/fleet-footprint.service',
  'deploy/france/fleet-footprint.timer',
  'deploy/france/footprint/fleet-footprint.mjs',
  'deploy/france/footprint/dirs.json',
  // 新内核影子工人的出网关（#3803）：常驻单元加名单文件，不碰防火墙（防火墙表是人工档的 fleet2-shadow.*）
  'deploy/france/fleet2-egress.service',
  'deploy/france/fleet2-egress.allow',
  // 新内核进程（#3811）：常驻单元，令牌文件由人放；执行体前缀脚本跟着发布版本走、不装到别处
  'deploy/france/fleet2-kernel.service',
  // 新驾驶舱只读口（#3818）：常驻单元，只听隧道地址；端口对香港开（ufw）归人工档
  'deploy/france/fleet2-cockpit.service',
  // Mirasim 常驻单元（#1274）：只是个 systemd 单元，归自动档；它的函数在 lib/mirasim.sh，一并登记
  'deploy/france/fleet-mirasim-session.service',
  'deploy/france/mirasim-retired',
  'deploy/lib/mirasim.sh',
  // 它的健康检查（#1676）：setup_mirasim_session 顺带装，同属自动档
  'deploy/france/fleet-mirasim-liveness.service',
  'deploy/france/fleet-mirasim-liveness.timer',
  'deploy/lib/mirasim-liveness.sh',
  // 流写守卫：setup_mirasim_session 在重启单元前写上，同属自动档
  'deploy/lib/mirasim-stream-guard.cjs',
];
const FULL_RUN_ONLY_FILES = [
  // source 进来的库
  'deploy/lib/common.sh',
  'deploy/lib/snapshot.sh',
  'deploy/lib/root-exec-check.sh',
  'deploy/lib/session-proxy.sh',
  'deploy/lib/listen.sh',
  'deploy/lib/cli-tools.sh',
  'deploy/lib/cursor-agent.sh',
  'deploy/lib/cursor-key.sh',
  'deploy/lib/grok.sh',
  'deploy/lib/agents-sync.sh',
  'deploy/lib/app-config.sh',
  'deploy/lib/session-pnpm.sh',
  'deploy/lib/node-cache.sh',
  'deploy/lib/auto-release-state.sh',
  'deploy/lib/node-report-gate.sh',
  'deploy/lib/service-home.sh',
  // 整套装机才用的单元和配置样例
  'deploy/france/fleet-temporal.service',
  'deploy/france/temporal.yaml',
  'deploy/france/france.env.example',
  'deploy/france/fleet-temporal-cli.sh',
  'deploy/france/fleet-engine.service',
  'deploy/france/fleet-api.service',
];
const refsOf = (file) => {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...text.matchAll(/\$DEPLOY_DIR\/([A-Za-z0-9_./-]+)/g)]
    .map((m) => `deploy/${m[1]}`)
    .filter((r) => !r.startsWith('deploy/..') && !r.endsWith('/'));
};

test('装机分档没漏没重：france.sh 和 human-tier.sh 引用的每个仓里文件都登记了档，人工档的文件都在 HUMAN_TIER_PATHS 里', () => {
  const human = refsOf('../lib/human-tier.sh');
  const all = new Set([...refsOf('../france.sh'), ...human]);
  assert.ok(all.size > 10, `读到了装机脚本引用的文件（${all.size} 个）`);
  assert.ok(human.includes('deploy/france/fleet-dao.nft'), '人工档里读得到防火墙规则');
  assert.ok(human.includes('deploy/france/sudoers-fleet-dao'), '人工档里读得到 sudoers');
  // france.env.example 只在新机器上建环境文件时读（之后归发布时照期望写），登记在「整套才用」，改它不用人重跑
  for (const r of human) {
    assert.ok(
      HUMAN_TIER_PATHS.includes(r) || FULL_RUN_ONLY_FILES.includes(r),
      `${r} 是人工档（human-tier.sh 引用）却不在 HUMAN_TIER_PATHS：它改了要人重跑，后端不会标落后`,
    );
  }
  const auto = new Set(AUTO_TIER_FILES);
  const full = new Set(FULL_RUN_ONLY_FILES);
  const humanSet = new Set(HUMAN_TIER_PATHS);
  for (const r of all) {
    if (r === DESIRED_FILE || /^deploy\/france\/auto-release\//.test(r)) continue; // 配置期望跟着版本走；自动发布副本归自动档
    const tiers = [humanSet.has(r), auto.has(r), full.has(r)].filter(Boolean).length;
    assert.equal(tiers, 1, `${r} 要恰好登记在一档里（人工 / 自动 / 整套才用），现在 ${tiers} 档`);
  }
  // 登记的文件都真在仓里（改名、删了没同步登记会红）
  for (const r of [...humanSet, ...auto, ...full]) {
    assert.ok(existsSync(new URL(`../../${r}`, import.meta.url)), `${r} 登记了档，仓里却没有这个文件`);
  }
  assert.ok(humanSet.has('deploy/lib/human-tier.sh'));
});

test('出网关单元（#3803）：不进影子 slice，听的口和名单路径跟 france.sh 的变量一样，enforce；名单不放 GitHub', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const unit = readFileSync(new URL('../france/fleet2-egress.service', import.meta.url), 'utf8');
  const v = (name) => new RegExp(`^${name}=(\\S+)`, 'm').exec(france)?.[1];
  assert.doesNotMatch(unit, /^Slice=/m, '它自己连外面 443，进了影子 slice 会被重定向回自己');
  const exec = /^ExecStart=(.+)$/m.exec(unit)?.[1] ?? '';
  assert.match(exec, new RegExp(`--port ${v('FLEET2_EGRESS_PORT')}(\\s|$)`));
  assert.match(exec, new RegExp(`--allowlist ${v('FLEET2_EGRESS_ALLOW')}(\\s|$)`));
  assert.match(exec, /--mode enforce(\s|$)/);
  assert.match(unit, new RegExp(`^ConditionPathExists=${v('FLEET2_EGRESS_ALLOW')}$`, 'm'));
  // 影子工人看得到 GitHub 就能翻到已合并的答案（#3776）
  const hosts = readFileSync(new URL('../france/fleet2-egress.allow', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(hosts.length > 0, 'enforce 下名单空着等于全断');
  for (const h of hosts) assert.doesNotMatch(h, /github|githubusercontent/i);
  // 读回：机器上的名单和仓里的逐字节比，不一样判红（enforce 下名单就是放行范围，手改过要看得出来）
  const readback = /^readback_fleet2_egress\(\) \{\n([\s\S]*?)\n\}/m.exec(france)?.[1] ?? '';
  assert.match(
    readback,
    /if ! cmp -s -- "\$FLEET2_EGRESS_ALLOW" "\$DEPLOY_DIR\/france\/fleet2-egress\.allow"; then\n\s+red /,
  );
});

test('新内核单元（#3811）：不进影子 slice、口和令牌文件跟 france.sh 的变量一样、以会话用户起工人', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const unit = readFileSync(new URL('../france/fleet2-kernel.service', import.meta.url), 'utf8');
  const v = (name) => new RegExp(`^${name}=(\\S+)`, 'm').exec(france)?.[1];
  assert.doesNotMatch(unit, /^Slice=/m, '它读 GitHub、拉镜像，进了影子 slice 会被重定向到出网关');
  assert.doesNotMatch(unit, /^NoNewPrivileges=yes/m, '影子工人经 sudo 起，不能禁提权');
  assert.match(unit, new RegExp(`FLEET2_API_PORT=${v('FLEET2_KERNEL_PORT')}(\\s|$)`, 'm'));
  assert.match(unit, new RegExp(`FLEET2_EGRESS_PORT=${v('FLEET2_EGRESS_PORT')}(\\s|$)`, 'm'));
  assert.doesNotMatch(unit, /^EnvironmentFile=/m, '不再有令牌文件，凭据来自 App json');
  assert.match(unit, new RegExp(`^Environment=FLEET2_GITHUB_APP_FILE=${v('ENGINE_APP_JSON')}$`, 'm'));
  assert.match(unit, new RegExp(`^ConditionPathExists=${v('ENGINE_APP_JSON')}$`, 'm'));
  assert.match(unit, /^Environment=FLEET2_SANDBOX=scope$/m);
  const cmd = /FLEET2_WORKER_COMMAND=(\[.*?\])'/.exec(unit)?.[1] ?? '';
  const [wrapper] = JSON.parse(cmd);
  assert.equal(wrapper, '/srv/fleet-dao-releases/current/deploy/france/fleet2-worker.sh');
  assert.ok(existsSync(new URL('../france/fleet2-worker.sh', import.meta.url)), '执行体前缀脚本要在仓里');
});

test('新驾驶舱只读口单元（#3818）：地址口和 france.sh 的变量一样、读旧后端的密钥文件、以 fleet 跑、不限重启次数', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const human = readFileSync(new URL('../lib/human-tier.sh', import.meta.url), 'utf8');
  const unit = readFileSync(new URL('../france/fleet2-cockpit.service', import.meta.url), 'utf8');
  const v = (name) => new RegExp(`^${name}=(\\S+)`, 'm').exec(france)?.[1];
  const wg = /^WG_ADDR=(\d+\.\d+\.\d+\.\d+)/m.exec(france)?.[1];
  assert.ok(wg, '读到了隧道地址');
  assert.match(unit, new RegExp(`FLEET2_COCKPIT_HOST=${wg.replaceAll('.', '\\.')}(\\s|$)`, 'm'));
  assert.match(unit, new RegExp(`FLEET2_COCKPIT_PORT=${v('FLEET2_COCKPIT_PORT')}(\\s|$)`, 'm'));
  assert.match(unit, new RegExp(`^EnvironmentFile=${v('FLEET2_COCKPIT_SECRET')}$`, 'm'));
  assert.match(unit, /^User=fleet$/m);
  assert.match(
    unit,
    /^Environment=PGHOST=\/var\/run\/postgresql PGUSER=fleet$/m,
    '库走 peer 认证，同 fleet2-kernel',
  );
  assert.match(unit, /^After=.*wg-quick@wg-fleet\.service/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(unit, /^Slice=/m);
  // 受保护端口和 ufw 规则（人工档）都带上它；自动档的函数里不碰防火墙
  assert.match(france, /^PROTECTED_PORTS=\(.*"\$FLEET2_COCKPIT_PORT"\)$/m);
  assert.match(human, /for port in "\$API_PORT" "\$FLEET2_COCKPIT_PORT"; do/);
  const body = (name) => new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(france)?.[1] ?? '';
  assert.ok(body('setup_fleet2_cockpit').length > 10);
  assert.ok(body('readback_fleet2_cockpit').length > 10);
  assert.match(body('readback_auto_tier'), /readback_fleet2_cockpit/);
  assert.match(/^readback\(\) \{\n([\s\S]*?)\n\}/m.exec(france)?.[1] ?? '', /readback_fleet2_cockpit/);
});

test('自动档不碰防火墙、sudoers、建用户：auto-tier 那几个函数里一个都没有', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const body = (name) => new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(france)?.[1] ?? '';
  for (const fn of [
    'setup_auto_tier',
    'setup_slice',
    'setup_user_slice_cap',
    'retire_old_units',
    'setup_auto_release',
    'setup_release_request_scripts',
    'setup_footprint',
    'setup_fleet2_egress',
    'setup_fleet2_kernel',
    'setup_fleet2_cockpit',
    'setup_mirasim_session',
  ]) {
    const text = body(fn);
    assert.ok(text.length > 10, `读到了 ${fn}`);
    assert.doesNotMatch(
      text,
      /setup_firewall|setup_sudoers|setup_identity|setup_pilot|ensure_service_user|sudoers|nft |useradd|visudo/,
      `${fn} 不许碰防火墙、sudoers、建用户`,
    );
  }
  // 自动档入口：接活脚本副本跟在自动发布之后（#2728）；_tmp 和帮手在 Mirasim 之前
  // （Mirasim 常驻单元仍放最后，#1274）；注释行不算
  assert.match(
    body('setup_auto_tier').replace(/^\s*#.*\n/gm, ''),
    /^\s*setup_slice\n\s*setup_user_slice_cap\n\s*retire_old_units\n\s*setup_auto_release\n\s*setup_release_request_scripts\n\s*setup_footprint\n\s*setup_fleet2_egress\n\s*setup_fleet2_kernel\n\s*setup_fleet2_cockpit\n\s*if declare -F install_scope_bin >\/dev\/null; then install_scope_bin; fi\n\s*if declare -F ensure_work_tmp >\/dev\/null; then ensure_work_tmp; fi\n\s*setup_mirasim_session\s*$/,
  );
  assert.match(body('readback_auto_tier'), /readback_work_tmp/);
  // 读回也读回它：缺了 MIRASIM_NO_AGENT_EGRESS=1 之类判红（check_mirasim_session_unit_file）
  const france2 = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  assert.match(
    /^readback_auto_tier\(\) \{\n([\s\S]*?)\n\}/m.exec(france2)?.[1] ?? '',
    /readback_mirasim_session_unit/,
  );
  // 反过来：人工档的函数都在 human-tier.sh，不在 france.sh 里
  for (const fn of ['setup_identity', 'setup_pilot', 'setup_sudoers', 'setup_firewall', 'render_firewall']) {
    assert.equal(body(fn), '', `${fn} 应当写在 deploy/lib/human-tier.sh`);
  }
});

test('发版在引擎起来之前换帮手并修好 _tmp', () => {
  const release = readFileSync(new URL('../release.sh', import.meta.url), 'utf8');
  assert.match(release, /source "\$DEPLOY_DIR\/lib\/human-tier\.sh"/);
  assert.match(release, /fix_work_tmp\(\) \{[\s\S]*?ensure_work_tmp/);
  const activate = /^activate\(\) \{.*\n([\s\S]*?)\n\}/m.exec(release)?.[1] ?? '';
  const install = activate.indexOf('install_scope_helper');
  const fix = activate.indexOf('fix_work_tmp');
  const restart = activate.indexOf('ensure_unit_running');
  assert.ok(
    install >= 0 && fix > install && restart > fix,
    `顺序不对：install=${install} fix=${fix} restart=${restart}`,
  );
});

test('【故意造出的失败】状态文件读不出（不是 JSON、格式版本不对、不是对象、读不了）：这一轮什么都不做、不覆盖、报警；挪走后从空的起、报警自己撤（审查 S4）', async () => {
  const bad = [
    ['不是 JSON', async () => '{"schema":1,"alerts":'],
    ['格式版本不对', async () => '{"schema":99}'],
    ['不是对象', async () => '[1]'],
    [
      '读不了',
      async () => {
        throw new Error('EACCES: permission denied');
      },
    ],
  ];
  for (const [what, read] of bad) {
    const m = machine();
    m.io.readState = read;
    const r = await runRound(m.io);
    assert.deepEqual(m.calls, [], `${what}：git、GitHub 都不碰`);
    assert.equal(m.tierCalls, 0, `${what}：装机自动档也不跑`);
    assert.equal(m.saved.length, 0, `${what}：不覆盖状态文件（留着现场，下一轮照样停着）`);
    const a = m.alerts.find((x) => x.key === STATE_UNREADABLE_KEY);
    assert.ok(a, `${what}：报警`);
    assert.match(a.body, /mv .*state\.json .*\.bad/, `${what}：报警里写怎么处理`);
    assert.equal(r.ok, false);
    assert.equal(r.alertLost, false);
    assert.match(r.line, /这一轮什么都没做/);
  }
  // 库也连不上：报警没发出去，照实返回（入口据此退出非 0）
  const down = machine();
  down.io.readState = async () => 'not json';
  down.dbDown = true;
  const r = await runRound(down.io);
  assert.equal(r.alertLost, true);
  assert.match(r.line, /报警也没发出去/);
  // 人照报警挪走了（文件不在）：从空的起、照常读一轮，撤掉这条
  const m = machine();
  m.io.readState = async () => null;
  const first = await runRound(m.io);
  assert.equal(first.ok, true);
  assert.deepEqual(m.forbidden, []);
  assert.ok(m.resolvedKeys.includes(STATE_UNREADABLE_KEY), '从空的起：撤掉「状态文件读不出」');
  assert.deepEqual(m.resolved.sort(), [...RETIRED_ALERT_PREFIXES].sort(), '从空的起也把旧发版报警撤一遍');
  assert.equal(m.saved.at(-1).last.action, 'behind', '这一轮存了');
  // 读得出：接着上一轮的
  m.calls = [];
  m.t += 5 * MIN;
  m.io.readState = async () => JSON.stringify(m.saved.at(-1));
  const second = await runRound(m.io);
  assert.equal(second.ok, true);
  assert.match(second.line, /behind/);
});

test('单元里已经没有发版的口子：入口不接发布脚本、不读标记、不取 tag（读真文件核对）', () => {
  const entry = readFileSync(
    new URL('../france/auto-release/fleet-auto-release.mjs', import.meta.url),
    'utf8',
  );
  const lib = readFileSync(new URL('../france/auto-release/lib.mjs', import.meta.url), 'utf8');
  for (const [name, text] of [
    ['入口', entry],
    ['lib', lib],
  ]) {
    assert.doesNotMatch(
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      /release\.sh|runRelease|VERSION_TAG|parseVersionTags|pickVersionMarker|readVersionTags|refs\/tags|for-each-ref/,
      `${name}不该再有按标记发、调发布脚本的代码`,
    );
  }
  assert.match(entry, /--no-tags/, '取主线时不取 tag');
  assert.doesNotMatch(entry, /spawn\(/, '没有起子进程发布的口子（只有 spawnSync 读 git、跑装机脚本）');
});

// ── 自动发版（决定 0088、#2039）：主线绿了就请求发，闸全过才写请求 ──

const GOOD_GATE = { missing: [], requestPending: false, marker: false, trainText: null, lockBusy: false };

/** 在 machine() 上接好自动发版的两个口子：闸全过、请求记账。 */
function autoMachine() {
  const m = machine();
  m.gate = { ...GOOD_GATE };
  m.gateThrow = null;
  m.requests = [];
  m.requestThrow = null;
  m.io.releaseGate = async () => {
    if (m.gateThrow) throw new Error(m.gateThrow);
    return structuredClone(m.gate);
  };
  m.io.requestRelease = async (req) => {
    if (m.requestThrow) throw new Error(m.requestThrow);
    m.requests.push(req);
  };
  return m;
}

test('CI 绿、闸全过就请求发主线头，请求里写明谁发的；同一个头 30 分钟内不重复请求；换了新头立刻发', async () => {
  const m = autoMachine();
  const st = await m.round();
  assert.match(m.requests[0].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    m.requests.map(({ requestId, ...request }) => request),
    [{ sha: H1, at: new Date(T0).toISOString(), by: AUTO_RELEASE_BY }],
  );
  assert.equal(st.auto.sha, H1);
  assert.equal(st.auto.at, new Date(T0).toISOString());
  assert.equal(st.last.action, 'auto-release-requested');
  assert.match(summary(st), /自动发版：已请求自动发版 bbbbbbbbbbbb/);
  assert.ok(/^[\p{L}\p{N}_.@ -]{1,64}$/u.test(AUTO_RELEASE_BY), '「谁发的」要过接活单元的字符规则');
  // 接活单元读走了请求、还没写进度（闸看着全过）：同一个头不再请求
  m.t += 5 * MIN;
  const second = await m.round();
  assert.equal(m.requests.length, 1);
  assert.match(second.auto.note, /刚请求过 bbbbbbbbbbbb，等接活单元发/);
  assert.equal(second.auto.sha, H1, '上一次请求的记录带到下一轮');
  m.t += 24 * MIN; // 距请求 29 分钟：还算刚请求过
  await m.round();
  assert.equal(m.requests.length, 1);
  // 换了新头（绿的）：不等 30 分钟，立刻发
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  await m.round();
  assert.equal(m.requests.length, 2);
  assert.equal(m.requests[1].sha, H2);
  // 同一个头满 30 分钟还没发上去（接活单元没接）：再请求一次
  m.t += 30 * MIN;
  await m.round();
  assert.equal(m.requests.length, 3);
  assert.equal(m.requests[2].sha, H2);
});

test('【故意造出的失败】上一次发版刚过几分钟、新头绿了照发：不再有两次发版之间的间隔', async () => {
  const m = autoMachine();
  // 上一轮刚请求发了 H0 之前的某个头（3 分钟前），现在在用 H0、主线头 H1 绿了
  m.state = {
    ...m.state,
    auto: { sha: 'f'.repeat(40), at: new Date(T0 - 3 * MIN).toISOString(), note: null },
  };
  const st = await m.round();
  assert.equal(m.requests.length, 1, '换了头就发，不等');
  assert.equal(m.requests[0].sha, H1);
  assert.equal(st.last.action, 'auto-release-requested');
});

test('【故意造出的失败】头的 CI 不是绿的（红、没跑完、没查、读不到）：不发，等绿；绿了的下一轮才发', async () => {
  for (const [what, ci] of [
    ['红', runsBody(run(H1, 'completed', 'failure'))],
    ['没跑完', runsBody(run(H1, 'in_progress', null))],
    ['读不到', { status: 500, body: '' }],
  ]) {
    const m = autoMachine();
    m.ci = ci;
    const st = await m.round();
    assert.equal(m.requests.length, 0, `CI ${what}不发`);
    assert.match(st.auto.note, /CI 不是绿的/);
  }
  const m = autoMachine();
  m.ci = runsBody(run(H1, 'in_progress', null));
  await m.round();
  m.ci = runsBody(run(H1, 'completed', 'success'));
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.requests.length, 1, '绿了就发');
});

// ── #2676：不只认头，发「在用之后最近一个 CI 全绿的提交」 ──

const H3 = 'd'.repeat(40); // 比 H2 更新的头
/** 主线 H3(头) H2 H1 | H0(在用)；各提交的运行记录由调用方显式给（没给的算查不到）。 */
function lagMachine(...runs) {
  const m = autoMachine();
  m.main = [
    [H3, '2026-09-27T07:50:00Z'],
    [H2, '2026-09-27T07:40:00Z'],
    [H1, '2026-09-27T07:30:00Z'],
    [H0, '2026-09-27T06:00:00Z'],
  ];
  m.ci = runsBody(...runs);
  return m;
}

test('【故意造出的失败】头 pending、头的前一个绿：请求发前一个，note 和读数写明发的是哪个、为什么不是头；一轮只问一次 GitHub', async () => {
  const m = lagMachine(
    run(H3, 'in_progress', null),
    run(H2, 'completed', 'success'),
    run(H1, 'completed', 'success'),
  );
  const st = await m.round();
  assert.deepEqual(
    m.requests.map(({ requestId, ...request }) => request),
    [{ sha: H2, at: new Date(T0).toISOString(), by: AUTO_RELEASE_BY }],
    '发最近绿的 H2，不是 H1 也不是头',
  );
  assert.equal(st.auto.sha, H2, '去重键是这次要发的提交');
  assert.deepEqual(
    m.calls.filter((c) => c === 'ci'),
    ['ci'],
  );
  assert.equal(st.ciGreen.sha, H2);
  assert.match(st.auto.note, /头 dddddddddddd 的 CI 还在跑，发最近绿的 cccccccccccc，比在用的新 2 个/);
  assert.match(summary(st), /自动发版：已请求自动发版 cccccccccccc.*头 dddddddddddd 的 CI 还在跑/);
  assert.equal(st.ci.sha, H3, '读数里 ci 仍是头的结论');
  assert.equal(st.ci.verdict, 'pending');
  // 去重：同一个要发的提交 30 分钟内不重复；头换了、要发的还是 H2，也不重复
  m.t += 5 * MIN;
  m.main.unshift(['e'.repeat(40), '2026-09-27T08:02:00Z']);
  m.ci = runsBody(
    run('e'.repeat(40), 'in_progress', null),
    run(H3, 'in_progress', null),
    run(H2, 'completed', 'success'),
  );
  const second = await m.round();
  assert.equal(m.requests.length, 1);
  assert.match(second.auto.note, /刚请求过 cccccccccccc/);
});

test('头红、前一个绿：请求发前一个；头绿：还是发头', async () => {
  const red = lagMachine(run(H3, 'completed', 'failure'), run(H2, 'completed', 'success'));
  const st = await red.round();
  assert.equal(red.requests[0].sha, H2);
  assert.match(st.auto.note, /头 dddddddddddd 的 CI 不是绿的（red），发最近绿的 cccccccccccc/);
  const green = lagMachine(run(H3, 'completed', 'success'), run(H2, 'completed', 'success'));
  const st2 = await green.round();
  assert.equal(green.requests[0].sha, H3);
  assert.doesNotMatch(st2.auto.note, /发最近绿的/);
});

test('在用之后到头全不绿（红、没跑完、查不到）：等，不发，note 说清；读不到运行列表也等', async () => {
  const m = lagMachine(run(H3, 'in_progress', null), run(H2, 'completed', 'failure'));
  m.t = Date.parse('2026-09-27T07:55:00Z'); // H1 刚合进来不久：没有运行记录算还没开跑
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.equal(st.ciGreen, null);
  assert.match(st.auto.note, /CI 不是绿的.*也没有 CI 全绿的，等绿/);
  const down = lagMachine();
  down.ci = { status: 500, body: '' };
  await down.round();
  assert.equal(down.requests.length, 0);
});

test('绿的那个就是在用的 / 比在用的旧：不发（只往前走）', async () => {
  const m = lagMachine(
    run(H3, 'in_progress', null),
    run(H2, 'completed', 'failure'),
    run(H1, 'completed', 'failure'),
    run(H0, 'completed', 'success'),
  );
  m.t = Date.parse('2026-09-27T08:00:00Z');
  const st = await m.round();
  assert.equal(m.requests.length, 0, '在用的 H0 自己绿，不算候选，更不会回头发');
  assert.equal(st.ciGreen, null);
  assert.equal(st.current, H0);
});

test('一页运行列表之外的提交不当候选：只看在用之后最近 CI_RUNS_PAGE 个，更早的绿也不发', async () => {
  const shas = Array.from({ length: CI_RUNS_PAGE + 5 }, (_, i) => i.toString(16).padStart(40, '0'));
  const m = autoMachine();
  const base = Date.parse('2026-09-27T07:50:00Z');
  m.main = [
    ...shas.map((s, i) => [s, new Date(base - i * 1000).toISOString()]),
    [H0, '2026-09-27T06:00:00Z'],
  ];
  // 最老的 5 个（候选之外）是绿的，前 CI_RUNS_PAGE 个都在跑
  m.ci = runsBody(
    ...shas.slice(0, CI_RUNS_PAGE).map((s) => run(s, 'in_progress', null)),
    ...shas.slice(CI_RUNS_PAGE).map((s) => run(s, 'completed', 'success')),
  );
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.match(st.auto.note, new RegExp(`最近 ${CI_RUNS_PAGE} 个提交里也没有`));
  // 绿的落在第 CI_RUNS_PAGE 个（最后一个候选）：能发
  const edge = autoMachine();
  edge.main = m.main;
  edge.ci = runsBody(
    ...shas.slice(0, CI_RUNS_PAGE - 1).map((s) => run(s, 'in_progress', null)),
    run(shas[CI_RUNS_PAGE - 1], 'completed', 'success'),
  );
  await edge.round();
  assert.equal(edge.requests[0].sha, shas[CI_RUNS_PAGE - 1]);
});

test('老状态文件（没有 ciGreen）读进来不炸：照常算出来', async () => {
  const m = lagMachine(run(H3, 'in_progress', null), run(H2, 'completed', 'success'));
  m.state = {
    schema: STATE_SCHEMA,
    retiredCleared: true,
    ci: null,
    auto: { sha: H0, at: '2026-09-27T00:00:00Z' },
  };
  const st = await m.round();
  assert.equal(st.ciGreen.sha, H2);
  assert.equal(m.requests[0].sha, H2);
});

test('【故意造出的失败】没有要发的 / 不该自动发的：在用的就是主线头、法国还没发布过、在用的不在最近主线里、读不到在用的', async () => {
  const same = autoMachine();
  same.current = H1;
  await same.round();
  assert.equal(same.requests.length, 0);
  assert.match(same.state.auto.note, /没有要发的/);

  const never = autoMachine();
  never.current = null;
  await never.round();
  assert.equal(never.requests.length, 0);
  assert.match(never.state.auto.note, /第一次发版走驾驶舱按钮/);

  const far = autoMachine();
  far.current = 'e'.repeat(40);
  await far.round();
  assert.equal(far.requests.length, 0);
  assert.match(far.state.auto.note, /不在主线最近的提交里/);

  const dead = autoMachine();
  dead.currentThrow = '读不到链接';
  await dead.round();
  assert.equal(dead.requests.length, 0, '在用的读不到，这一轮不判');
});

test('【故意造出的失败】发版闸：接活单元没装、上一份请求没被接走、有暂停标记、发布锁被占、进度是在走/卡住/没成/认不出：一律不发，原因写明', async () => {
  const cases = [
    [{ missing: ['/etc/systemd/system/fleet-release-request.path'] }, /接活单元没装/],
    [{ requestPending: true }, /还没被接走/],
    [{ marker: true }, /暂停标记/],
    [{ lockBusy: true }, /发布锁被占着/],
    [
      {
        trainText: JSON.stringify({
          status: 'running',
          target: { kind: 'sha', value: '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d' },
        }),
      },
      /有一趟发版在跑（2f5dc42f4636），等它收尾/,
    ],
    [{ trainText: JSON.stringify({ status: 'blocked' }) }, /「blocked」状态/],
    [{ trainText: JSON.stringify({ status: 'failed' }) }, /「failed」状态/],
    [{ trainText: 'not json' }, /认不出/],
    [{ trainText: JSON.stringify({ phase: 3 }) }, /没有 status/],
    [{ missing: undefined }, /没读到/],
  ];
  for (const [patch, want] of cases) {
    const m = autoMachine();
    m.gate = { ...GOOD_GATE, ...patch };
    const st = await m.round();
    assert.equal(m.requests.length, 0, JSON.stringify(patch));
    assert.match(st.auto.note, want);
  }
  // 闸读的时候就抛：同样不发
  const gt = autoMachine();
  gt.gateThrow = 'flock 退出码 9';
  assert.match((await gt.round()).auto.note, /发版闸读不到：flock 退出码 9/);
  assert.equal(gt.requests.length, 0);
  // 上一趟发完（done）或撤掉（aborted）的进度记录不挡
  for (const status of ['done', 'aborted']) {
    const ok = autoMachine();
    ok.gate = { ...GOOD_GATE, trainText: JSON.stringify({ status }) };
    await ok.round();
    assert.equal(ok.requests.length, 1, `进度是 ${status} 不挡`);
  }
});

test('发版请求写不出去：报警、下一轮再试，写成了撤警；请求被占着（EEXIST）也是同一条路', async () => {
  const m = autoMachine();
  m.requestThrow = 'EEXIST: file already exists';
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.match(st.auto.note, /发版请求没写成：EEXIST/);
  assert.equal(st.auto.at, null, '没写成不算请求过，不挡下一轮');
  assert.deepEqual(
    m.alerts.map((a) => a.key),
    [AUTO_REQUEST_KEY],
  );
  assert.match(m.alerts[0].body, /点驾驶舱「发布到法国」/);
  m.requestThrow = null;
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.requests.length, 1);
  assert.deepEqual(m.resolvedKeys, [AUTO_REQUEST_KEY], '写成了就撤警');
});

test('gateVerdict 单测：全过回 null；done/aborted 的进度不挡；事实不是对象一律不发', () => {
  assert.equal(gateVerdict(GOOD_GATE), null);
  assert.equal(gateVerdict({ ...GOOD_GATE, trainText: JSON.stringify({ status: 'done' }) }), null);
  assert.match(gateVerdict(undefined), /没读到/);
  assert.match(gateVerdict(null), /没读到/);
});

test('gateVerdict：进度是 running（一趟正常在走）不含「要人看」，写明在跑的提交、等它收尾', () => {
  const sha = '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d';
  const note = gateVerdict({
    ...GOOD_GATE,
    trainText: JSON.stringify({ status: 'running', target: { kind: 'sha', value: sha } }),
  });
  assert.equal(note, '有一趟发版在跑（2f5dc42f4636），等它收尾');
  assert.doesNotMatch(note, /要人看/);
  const bare = gateVerdict({ ...GOOD_GATE, trainText: JSON.stringify({ status: 'running' }) });
  assert.equal(bare, '有一趟发版在跑（进度记录没写提交），等它收尾');
  assert.doesNotMatch(bare, /要人看/);
});

test('gateVerdict：进度收了尾没成（failed、blocked）仍含「要人看」', () => {
  for (const status of ['failed', 'blocked']) {
    const note = gateVerdict({ ...GOOD_GATE, trainText: JSON.stringify({ status }) });
    assert.match(note, /要人看/);
    assert.match(note, new RegExp(`「${status}」状态`));
  }
});

test('gateVerdict：current 已等于或新于失败进度记的目标时，旧 failed 不再要人看', () => {
  const oldSha = 'b0ef012b26a1aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const newSha = '6999045b1d66bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const older = '1478b87a15f7cccccccccccccccccccccccccccc';
  const trainText = JSON.stringify({
    status: 'failed',
    phase: 4,
    target: { kind: 'sha', value: oldSha },
    why: '主进程跑的不是这一版 / 已退回 1478b87a15f7',
  });
  assert.equal(
    gateVerdict({ ...GOOD_GATE, current: newSha, mainline: [newSha, oldSha, older], trainText }),
    null,
    'current 新于失败目标：可发',
  );
  assert.equal(
    gateVerdict({ ...GOOD_GATE, current: oldSha, mainline: [oldSha, older], trainText }),
    null,
    'current 等于失败目标：可发',
  );
  assert.match(
    gateVerdict({ ...GOOD_GATE, current: older, mainline: [oldSha, older], trainText }),
    /同一个提交不自动重发/,
    'current 比失败目标旧（退回了）、不知道要发哪个：当同一个提交，不重发',
  );
  assert.match(gateVerdict({ ...GOOD_GATE, trainText }), /同一个提交不自动重发/, '比不出先后：不重发');
});

test('上一趟 failed 记的是更旧的提交，current 已经新于它：不写「要人看」，照常请求发主线头', async () => {
  const older = '1'.repeat(40);
  const m = autoMachine();
  m.main.push([older, '2026-09-27T05:00:00Z']);
  m.gate = {
    ...GOOD_GATE,
    trainText: JSON.stringify({
      status: 'failed',
      phase: 4,
      target: { kind: 'sha', value: older },
    }),
  };
  const st = await m.round();
  assert.equal(m.requests.length, 1);
  assert.equal(m.requests[0].sha, H1);
  assert.doesNotMatch(st.auto.note, /要人看/);
});

test('failed 的目标比 current 新（退回了还没追上）、要发的就是它：同一个提交不自动重发', async () => {
  const m = autoMachine();
  m.gate = {
    ...GOOD_GATE,
    trainText: JSON.stringify({
      status: 'failed',
      phase: 4,
      target: { kind: 'sha', value: H1 },
    }),
  };
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.match(st.auto.note, /同一个提交不自动重发，等主线上更新的绿提交/);
  assert.equal(st.last.action, 'auto-held');
});

// ── #3278：动手后没成、已退回的那一趟不再永久挡住自动发版 ──

/** 动手后没成的一趟（照 2026-10-19 828c9d47 的原样：第 4 步、release.sh 起了、已退回）。 */
const startedTrain = (sha, n = 1) => ({
  status: 'failed',
  phase: 4,
  target: { kind: 'sha', value: sha },
  release: { started: true },
  startedFails: n,
  why: 'release.sh 退出码 1（有红或已退回）：fleet-api：engine 切之前是好的，换了这一版不好了：引擎不在线',
});

test('【#3278 故意造出的失败】动手后没成、已退回，主线上来了更新的绿提交：照发新提交，不停在「要人看」', async () => {
  const m = autoMachine();
  // 主线 H2(头，绿) H1(发失败、已退回) H0(在用)
  m.main.unshift([H2, '2026-09-27T07:50:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.gate = { ...GOOD_GATE, trainText: JSON.stringify(startedTrain(H1)) };
  const st = await m.round();
  assert.deepEqual(
    m.requests.map((r) => r.sha),
    [H2],
  );
  assert.doesNotMatch(st.auto.note, /要人看/);
  assert.equal(st.last.action, 'auto-release-requested');
});

test('【#3278】闸：动手后没成的挡同一个提交、放更新的提交；发版历史里这个提交没过健康检查也不重发；连败满上限全挡', () => {
  const facts = (train, target, extra = {}) => ({
    ...GOOD_GATE,
    trainText: JSON.stringify(train),
    target,
    current: H0,
    mainline: [H2, H1, H0],
    ...extra,
  });
  assert.match(gateVerdict(facts(startedTrain(H1), H1)), /同一个提交不自动重发/);
  assert.equal(gateVerdict(facts(startedTrain(H1), H2)), null, '更新的提交照发');
  assert.match(
    gateVerdict(facts(startedTrain(H1), H2, { historyLast: `2026-09-27T07:55:00Z ${H2} unhealthy` })),
    /同一个提交不自动重发/,
    '要发的提交上次没过健康检查：不重发',
  );
  assert.equal(
    gateVerdict(facts(startedTrain(H1), H2, { historyLast: `2026-09-27T07:55:00Z ${H1} auto-rollback` })),
    null,
    '历史里退回的是别的提交：照发',
  );
  assert.match(
    gateVerdict(facts(startedTrain(H1, STARTED_FAIL_LIMIT), H2)),
    new RegExp(`动手发版已连败 ${STARTED_FAIL_LIMIT} 趟.*等急修`),
  );
  assert.equal(startedFails({ ...startedTrain(H1), startedFails: undefined }), 1, '老记录没有键算 1 趟');
  assert.equal(startedFails({ ...startedTrain(H1), status: 'done' }), 0);
  assert.equal(startedFails(untouchedTrain(H1, 1)), 0, '还没动手的不算');
});

test('【#3278】动手后连败满上限：不发、开急修单（动手后那一种），报 auto-release:held 等它', async () => {
  const m = autoMachine();
  m.main.unshift([H2, '2026-09-27T07:50:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.gate = { ...GOOD_GATE, trainText: JSON.stringify(startedTrain(H1, STARTED_FAIL_LIMIT)) };
  const issues = [];
  m.io.fileIssue = async (issue) => {
    issues.push(issue);
    return { number: 3300, url: 'https://github.com/o/r/issues/3300', created: true };
  };
  let st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, `release-started:${H1}`);
  assert.match(issues[0].title, /动手后连败 2 趟/);
  assert.match(st.auto.note, /已开急修单 #3300/);
  assert.equal(
    m.alerts.some((a) => a.key === HELD_KEY),
    false,
    '刚拦下不报',
  );
  m.t += HELD_ALERT_MS;
  st = await m.round();
  assert.equal(issues.length, 1, '同一个提交只开一张');
  const held = m.alerts.find((a) => a.key === HELD_KEY);
  assert.ok(held, '拦满 30 分钟报 auto-release:held');
  assert.match(held.body, /落后主线 2 个提交/);
  // 有人手动发成了（进度 done）：照常请求、撤掉拦下的报警
  m.gate = {
    ...GOOD_GATE,
    trainText: JSON.stringify({ ...startedTrain(H1), status: 'done', startedFails: 0 }),
  };
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(
    m.requests.map((r) => r.sha),
    [H2],
  );
  assert.ok(m.resolvedKeys.includes(HELD_KEY), '写出请求后撤掉');
  assert.equal(st.heldSince, undefined);
});

test('【#3278】版本切上了、健康没核实：隔 10 分钟自动请求只读复核，最多 3 次，之后开急修单', async () => {
  const m = autoMachine();
  // 在用的就是那一趟的目标 H1，主线又来了 H2
  m.current = H1;
  m.main = [
    [H2, '2026-09-27T07:50:00Z'],
    [H1, '2026-09-27T07:30:00Z'],
    [H0, '2026-09-27T06:00:00Z'],
  ];
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.gate = {
    ...GOOD_GATE,
    trainText: JSON.stringify({
      status: 'blocked',
      phase: 5,
      target: { kind: 'sha', value: H1 },
      release: { started: true, healthPending: { sha: H1, identity: 'x', before: H0 } },
      why: '目标版本已切上，健康尚未核实',
    }),
  };
  const retries = [];
  m.io.requestRetry = async (req) => retries.push(req);
  const issues = [];
  m.io.fileIssue = async (issue) => {
    issues.push(issue);
    return { number: 3301, url: null, created: true };
  };
  let st = await m.round();
  assert.equal(m.requests.length, 0, '健康没核实不发新的');
  assert.match(retries[0].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    retries.map(({ requestId, ...request }) => request),
    [{ sha: H1, at: new Date(m.t).toISOString(), by: AUTO_RELEASE_BY }],
  );
  assert.match(st.auto.note, /已请求第 1 次只读复核/);
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(retries.length, 1, '不到 10 分钟不再请求');
  for (let i = 0; i < HEALTH_RETRY_LIMIT; i++) {
    m.t += HEALTH_RETRY_MS;
    st = await m.round();
  }
  assert.equal(retries.length, HEALTH_RETRY_LIMIT, '最多 3 次');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, `release-health:${H1}`);
  assert.match(st.auto.note, /自动复核 3 次仍没核实；已开急修单 #3301/);
});

// ── 发版驱动死在中途的残局（#2038、决定 0093）：暂停名单没人发「继续」、老版驱动关了总开关没开回 ──

const pausedOut = (entries, code = 0) => ({
  code,
  out: `${entries.map((e) => `${e.result} ${e.repo}#${e.issueNumber}`).join('\n')}\n${JSON.stringify({
    schema: 1,
    by: '发版',
    reason: '发版 bbbbbbbbbbbb',
    pausedAt: '2026-09-27T07:40:00Z',
    continuedAt: '2026-09-27T08:00:00Z',
    entries,
  })}\n`,
});
const entry = (n, result, extra = {}) => ({
  taskId: `t${n}`,
  repo: 'o/r',
  issueNumber: n,
  workflowId: null,
  result,
  pausedOk: true,
  ...extra,
});
const TRAIN_RUNNING = {
  status: 'running',
  phase: 3,
  pid: 4242,
  updatedAt: new Date(T0 - 40 * MIN).toISOString(),
  before: { master: true, repos: {} },
};

/** autoMachine 上接好收残局的口子：默认在用的就是主线头（不发版，st.last 留给收残局那一步）、没有残局。 */
function recoverMachine() {
  const m = autoMachine();
  m.current = H1;
  m.paused = { exists: false, ageMs: null, lockBusy: false };
  m.pausedThrow = null;
  m.resume = pausedOut([entry(1, 'continued')]);
  m.resumeThrow = null;
  m.resumeCalls = 0;
  m.retired = [];
  m.retireThrow = null;
  m.io.pausedLeftover = async () => {
    if (m.pausedThrow) throw new Error(m.pausedThrow);
    return structuredClone(m.paused);
  };
  m.io.resumePaused = async () => {
    m.resumeCalls += 1;
    if (m.resumeThrow) throw new Error(m.resumeThrow);
    return m.resume;
  };
  m.io.retirePaused = async (to) => {
    if (m.retireThrow) throw new Error(m.retireThrow);
    m.retired.push(to);
    m.paused = { exists: false, ageMs: null, lockBusy: false };
  };
  m.train = { marker: false, trainText: null, lockBusy: false, engine: { ok: true, on: false } };
  m.alivePids = [];
  m.trainThrow = null;
  m.engineOnCalls = [];
  m.engineOnResult = { code: 0, out: '已打开：引擎总开关：开着' };
  m.engineStaysOff = false;
  m.markerCleared = 0;
  m.io.trainLeftover = async () => {
    if (m.trainThrow) throw new Error(m.trainThrow);
    return { ...structuredClone(m.train), pidAlive: (pid) => m.alivePids.includes(pid) };
  };
  m.io.engineOn = async (reason) => {
    m.engineOnCalls.push(reason);
    if (m.engineOnResult.code === 0 && !m.engineStaysOff) m.train.engine = { ok: true, on: true };
    return m.engineOnResult;
  };
  m.clearThrow = null;
  m.io.clearTrainMarker = async () => {
    if (m.clearThrow) throw new Error(m.clearThrow);
    m.markerCleared += 1;
    m.train.marker = false;
  };
  m.audits = [];
  m.auditThrow = null;
  m.io.audit = async (rec) => {
    if (m.auditThrow) throw new Error(m.auditThrow);
    m.audits.push(rec);
  };
  return m;
}

test('暂停名单放了 20 分钟以上、发布锁空着：替它发「继续」，名单改名不再试，报一条列出继续了几个、哪些没成', async () => {
  const m = recoverMachine();
  m.paused = { exists: true, ageMs: PAUSED_STALE_MS + 5 * MIN, lockBusy: false };
  m.resume = pausedOut(
    [
      entry(1, 'continued'),
      entry(2, 'failed', { why: '工作流不在了' }),
      entry(3, 'skipped', { pausedOk: false }),
    ],
    1,
  );
  const st = await m.round();
  assert.equal(m.resumeCalls, 1);
  assert.deepEqual(m.retired, [`${PAUSE_FILE}.handled-2026-09-27T08-00-00-000Z`]);
  const a = m.alerts.find((x) => x.key === PAUSED_ALERT_KEY);
  assert.ok(a, '报了一条');
  assert.equal(a.title, '发版驱动没收尾，自动给 2 个发版暂停的任务发了继续');
  assert.match(a.body, /继续了 1 个/);
  assert.match(a.body, /没继续上 1 个，要人看：o\/r#2（工作流不在了）/);
  assert.match(a.body, /退出码 1/);
  assert.match(a.body, /已改名成 .*\.handled-/);
  assert.equal(st.last.action, 'paused-resumed');
  // 名单挪走了：下一轮不再发
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.resumeCalls, 1);
});

test('暂停名单还新鲜（不到 20 分钟）、发布锁占着（有发布在跑）、名单不在：都不碰', async () => {
  for (const paused of [
    { exists: true, ageMs: PAUSED_STALE_MS - MIN, lockBusy: false },
    { exists: true, ageMs: PAUSED_STALE_MS + 60 * MIN, lockBusy: true },
    { exists: false, ageMs: null, lockBusy: false },
  ]) {
    const m = recoverMachine();
    m.paused = paused;
    await m.round();
    assert.equal(m.resumeCalls, 0, JSON.stringify(paused));
    assert.equal(m.retired.length, 0);
    assert.equal(
      m.alerts.some((a) => a.key === PAUSED_ALERT_KEY),
      false,
    );
  }
});

test('【故意造出的失败】暂停名单读不到、放了多久认不出、继续起不来、回话认不出、名单改不了名：照实记下，不当成没有', async () => {
  const unread = recoverMachine();
  unread.pausedThrow = 'EACCES';
  const st = await unread.round();
  assert.equal(st.last.action, 'paused-unreadable');
  assert.match(st.last.detail, /在不在读不到：EACCES/);
  assert.equal(unread.resumeCalls, 0);

  const noAge = recoverMachine();
  noAge.paused = { exists: true, ageMs: null, lockBusy: false };
  assert.match((await noAge.round()).last.detail, /放了多久读不到/);
  assert.equal(noAge.resumeCalls, 0);

  const crash = recoverMachine();
  crash.paused = { exists: true, ageMs: PAUSED_STALE_MS, lockBusy: false };
  crash.resumeThrow = 'bash 起不来或超时';
  crash.retireThrow = 'EROFS';
  await crash.round();
  const a = crash.alerts.find((x) => x.key === PAUSED_ALERT_KEY);
  assert.equal(a.title, '发版驱动没收尾，自动给 名单上 个发版暂停的任务发了继续');
  assert.match(a.body, /结果认不出：bash 起不来或超时/);
  assert.match(a.body, /退出码 -1/);
  assert.match(a.body, /名单没改成 .*EROFS.*下一轮还会再发一次/);

  const garbled = recoverMachine();
  garbled.paused = { exists: true, ageMs: PAUSED_STALE_MS, lockBusy: false };
  garbled.resume = { code: 2, out: '用法：fleet-api release pause|continue' };
  await garbled.round();
  const g = garbled.alerts.find((x) => x.key === PAUSED_ALERT_KEY);
  assert.match(g.body, /结果认不出：用法/);
  assert.match(g.body, /退出码 2/);
  assert.equal(garbled.retired.length, 1, '没成也改名，不每 5 分钟重试');
});

const STALE_TRAIN = () => ({
  marker: true,
  trainText: JSON.stringify(TRAIN_RUNNING),
  lockBusy: false,
  engine: { ok: true, on: false },
});

test('老版驱动关了总开关没开回（标记在、驱动死了、半小时没动、锁空、总开关关着）：开回去、删标记、报一条；进度记录不改', async () => {
  const m = recoverMachine();
  m.train = STALE_TRAIN();
  const st = await m.round();
  assert.deepEqual(m.engineOnCalls, [TRAIN_RESTORE_REASON]);
  assert.equal(m.markerCleared, 1);
  const a = m.alerts.find((x) => x.key === TRAIN_RESTORED_KEY);
  assert.equal(a.title, '发版驱动没收尾，自动开回了总开关');
  assert.match(a.body, /第 3 步、running/);
  assert.match(a.body, /状态没改，那一趟停在哪一步要人看/);
  assert.equal(st.last.action, 'train-restored');
  // 标记删了：下一轮不再开
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.engineOnCalls.length, 1);
  // 状态不是 running（卡住、没成）的，驱动进程号还活着也算没收尾
  const failed = recoverMachine();
  failed.alivePids = [4242];
  failed.train = { ...STALE_TRAIN(), trainText: JSON.stringify({ ...TRAIN_RUNNING, status: 'failed' }) };
  await failed.round();
  assert.equal(failed.engineOnCalls.length, 1);
});

test('老版驱动的残局对不全就不碰总开关：驱动还活着、不到半小时、在走没记进程号、锁占着、没有进度记录、发版前就关着、没有标记', async () => {
  const train = (patch) => JSON.stringify({ ...TRAIN_RUNNING, ...patch });
  const cases = [
    ['驱动还活着', {}, [4242]],
    ['不到半小时', { trainText: train({ updatedAt: new Date(T0 - (TRAIN_STALE_MS - MIN)).toISOString() }) }],
    ['在走没记进程号', { trainText: train({ pid: undefined }) }],
    ['锁占着', { lockBusy: true }],
    ['没有进度记录（不知道发版前开没开）', { trainText: null }],
    ['发版前就关着', { trainText: train({ before: { master: false } }) }],
    ['没有标记', { marker: false }],
  ];
  for (const [what, patch, alive = []] of cases) {
    const m = recoverMachine();
    m.train = { ...STALE_TRAIN(), ...patch };
    m.alivePids = alive;
    await m.round();
    assert.equal(m.engineOnCalls.length, 0, what);
    assert.equal(m.markerCleared, 0, what);
    assert.equal(
      m.alerts.some((a) => a.key === TRAIN_RESTORED_KEY),
      false,
      what,
    );
  }
});

test('【故意造出的失败】总开关开回没成（engine on 退出非 0、读回还是关着）、残局读不到、总开关读不到、进度认不出：不删标记，照实报或记', async () => {
  const exit1 = recoverMachine();
  exit1.train = STALE_TRAIN();
  exit1.engineOnResult = { code: 1, out: '没改成（什么都没改）：连不上库' };
  await exit1.round();
  const a = exit1.alerts.find((x) => x.key === TRAIN_RESTORED_KEY);
  assert.equal(a.title, '发版驱动没收尾，总开关没开回');
  assert.match(a.body, /engine on 退出码 1：没改成/);
  assert.equal(exit1.markerCleared, 0, '没开回不删标记');
  assert.equal(exit1.state.last.action, 'train-restore-failed');
  // 下一轮接着试；报警内容一样就不重发
  exit1.t += 5 * MIN;
  const sent = exit1.alerts.length;
  await exit1.round();
  assert.equal(exit1.engineOnCalls.length, 2);
  assert.equal(exit1.alerts.length, sent, '同样的报警不每 5 分钟重发');

  const stuck = recoverMachine();
  stuck.train = STALE_TRAIN();
  stuck.engineStaysOff = true;
  await stuck.round();
  assert.match(stuck.alerts.find((x) => x.key === TRAIN_RESTORED_KEY).body, /读回来还是关着/);
  assert.equal(stuck.markerCleared, 0);

  const unread = recoverMachine();
  unread.trainThrow = 'flock 退出码 9';
  assert.match((await unread.round()).last.detail, /残局读不到：flock 退出码 9/);

  const noEngine = recoverMachine();
  noEngine.train = { ...STALE_TRAIN(), engine: { ok: false, why: '总开关的回话认不出：x' } };
  assert.match((await noEngine.round()).last.detail, /总开关读不到，不碰标记和总开关：总开关的回话认不出/);
  assert.equal(noEngine.engineOnCalls.length, 0);

  const garbled = recoverMachine();
  garbled.train = { ...STALE_TRAIN(), trainText: 'not json' };
  assert.match((await garbled.round()).last.detail, /进度记录认不出：不碰标记和总开关/);
  assert.equal(garbled.engineOnCalls.length, 0);
});

test('parseEngineStatus：开着、关着认得出；退出非 0（含老版没有 engine 命令）、回话认不出都是读不到', () => {
  assert.deepEqual(parseEngineStatus(0, '引擎总开关：开着：引擎在接活'), { ok: true, on: true });
  assert.deepEqual(parseEngineStatus(0, '引擎总开关：关着（从没设过，默认关）'), { ok: true, on: false });
  assert.equal(parseEngineStatus(2, '用法：fleet-api ...').ok, false);
  assert.equal(parseEngineStatus(0, '').ok, false);
});

// ── 发版只认主线头那次 ci.yml 全绿（ciVerdict）：主线 CI 里的 E2E 不绿就不发 ──

/** key 这一行起、缩进比它深的那一块（空行、整行注释跳过）；找不到回 null。 */
function yamlBlock(lines, key, indent) {
  const pad = ' '.repeat(indent);
  const start = lines.findIndex((l) => l.startsWith(`${pad}${key}:`));
  if (start < 0) return null;
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

test('主线 CI（CI_WORKFLOW）推 main 时会跑，里面有跑 playwright 的 E2E job，汇总 check 的 needs 带着它（读真文件）', () => {
  const text = readFileSync(new URL(`../../${CI_WORKFLOW}`, import.meta.url), 'utf8');
  const lines = text.split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/\r$/, ''));
  // on：push 到 main 会触发（有 branches 过滤的话要列着 main）
  const on = yamlBlock(lines, 'on', 0);
  assert.ok(on, 'ci.yml 有 on:');
  const push = yamlBlock(on, 'push', 2);
  assert.ok(push || /\bpush\b/.test(on[0]), '推送会触发 ci.yml');
  if (push) {
    const p = push.join('\n');
    if (/branches:/.test(p)) {
      assert.match(
        p,
        /branches:\s*\[[^\]]*\bmain\b|branches:\s*\n\s*-\s*['"]?main\b/,
        'push 的 branches 里有 main',
      );
    }
    assert.doesNotMatch(p, /branches-ignore/, 'push 不排除分支');
  }
  // jobs：跑 playwright 的 job（名字不限，现在叫 e2e）
  const jobs = yamlBlock(lines, 'jobs', 0);
  assert.ok(jobs, 'ci.yml 有 jobs:');
  const names = jobs.map((l) => /^ {2}([\w-]+):\s*$/.exec(l)?.[1]).filter(Boolean);
  const e2e = names.filter((n) => yamlBlock(jobs, n, 2).some((l) => /\bplaywright\b/.test(l)));
  assert.ok(e2e.length > 0, `ci.yml 里有跑 playwright 的 job（现在的 job：${names.join('、')}）`);
  for (const n of e2e) {
    const own = yamlBlock(jobs, n, 2).find((l) => /^ {4}if:/.test(l)) ?? '';
    assert.doesNotMatch(
      own,
      /event_name\s*==\s*'pull_request'|event_name\s*!=\s*'push'/,
      `${n} 推主线时不能整个不跑`,
    );
  }
  // check（必过检查、汇总）的 needs 带着它
  const check = yamlBlock(jobs, 'check', 2);
  assert.ok(check, 'ci.yml 有 check job');
  const needsAt = check.findIndex((l) => /^ {4}needs:/.test(l));
  assert.ok(needsAt >= 0, 'check 有 needs');
  const inline = /needs:\s*\[([^\]]*)\]/.exec(check[needsAt]);
  const single = /needs:\s*([\w-]+)\s*$/.exec(check[needsAt]);
  const needs = inline ? inline[1].split(',').map((s) => s.trim()) : single ? [single[1]] : [];
  if (!inline && !single) {
    for (const l of check.slice(needsAt + 1)) {
      const m = /^ {6}-\s*([\w-]+)/.exec(l);
      if (!m) break;
      needs.push(m[1]);
    }
  }
  for (const n of e2e) assert.ok(needs.includes(n), `check 的 needs（${needs.join('、')}）要带 ${n}`);
});

test('总开关开着、驱动不在、锁空着：暂停标记是残留，删掉并记一条操作记录（运维脚本），自动发版不再被它挡', async () => {
  for (const [what, trainText, alive] of [
    ['进度记录不在', null, []],
    ['进度是 failed', JSON.stringify({ ...TRAIN_RUNNING, status: 'failed' }), [4242]],
    [
      '在走但进程死了，刚刚还在更新',
      JSON.stringify({ ...TRAIN_RUNNING, updatedAt: new Date(T0).toISOString() }),
      [],
    ],
  ]) {
    const m = recoverMachine();
    m.train = { ...STALE_TRAIN(), trainText, engine: { ok: true, on: true } };
    m.alivePids = alive;
    const st = await m.round();
    assert.equal(m.markerCleared, 1, what);
    assert.equal(m.engineOnCalls.length, 0, `${what}：总开关开着不再开`);
    assert.equal(m.audits.length, 1, what);
    assert.equal(m.audits[0].action, MARKER_CLEAR_ACTION);
    assert.match(m.audits[0].target, /release-train.paused$/);
    assert.match(m.audits[0].reason, /残留的发版暂停标记.*总开关开着/);
    assert.equal(st.last.action, 'marker-cleared', what);
    assert.equal(
      m.alerts.some((a) => a.key === TRAIN_MARKER_KEY),
      false,
    );
  }
  // 驱动还活着在走、锁占着、总开关读不到：标记不动
  for (const [what, patch, alive] of [
    ['驱动还活着在走', {}, [4242]],
    ['锁占着', { lockBusy: true }, []],
    ['总开关读不到', { engine: { ok: false, why: 'x' } }, []],
  ]) {
    const m = recoverMachine();
    m.train = { ...STALE_TRAIN(), engine: { ok: true, on: true }, ...patch };
    m.alivePids = alive;
    await m.round();
    assert.equal(m.markerCleared, 0, what);
    assert.equal(m.audits.length, 0, what);
  }
});

test('【故意造出的失败】删残留标记：操作记录写不进（先删后记：标记已删，报一条「删了、没记上」，不当成没事）；删不掉（报警、每轮再试、不写记录）', async () => {
  const noAudit = recoverMachine();
  noAudit.train = { ...STALE_TRAIN(), trainText: null, engine: { ok: true, on: true } };
  noAudit.auditThrow = '写库没成（psql 退出码 2）：invalid input value for enum actor_kind: "ops"';
  const st = await noAudit.round();
  assert.equal(noAudit.markerCleared, 1, '标记已经删了');
  const a = noAudit.alerts.find((x) => x.key === TRAIN_MARKER_KEY);
  assert.equal(a.title, '删了残留的发版暂停标记，操作记录没写进去');
  assert.match(a.body, /已删 .*release-train.paused；写操作记录（release.marker-cleared）没成：写库没成/);
  assert.equal(st.last.action, 'marker-cleared-unaudited');

  const stuck = recoverMachine();
  stuck.train = { ...STALE_TRAIN(), trainText: null, engine: { ok: true, on: true } };
  stuck.clearThrow = 'EROFS';
  await stuck.round();
  assert.equal(stuck.audits.length, 0, '没删成不写「删了」的记录');
  assert.match(stuck.alerts.find((x) => x.key === TRAIN_MARKER_KEY).body, /删 .* 没成：EROFS/);
  assert.equal(stuck.state.last.action, 'marker-clear-failed');
  // 下一轮删成了：记上、撤警
  stuck.clearThrow = null;
  stuck.t += 5 * MIN;
  await stuck.round();
  assert.equal(stuck.markerCleared, 1);
  assert.equal(stuck.audits.length, 1);
  assert.deepEqual(stuck.resolvedKeys, [TRAIN_MARKER_KEY]);
});

// ── #2728：发版还没动手就没成的那一趟不挡自动发版；同一个提交连败 3 趟才停、开急修单 ──

/** 接活单元写的进度：第 0 步预检没成（什么都还没动），同一个提交第 n 趟。 */
const untouchedTrain = (sha, n, at = new Date(T0 - 2 * MIN).toISOString()) => ({
  schema: 1,
  status: 'failed',
  phase: 0,
  startedAt: at,
  updatedAt: at,
  target: { kind: 'sha', value: sha },
  release: {},
  why: "发版前异常基线读不到（什么都还没动）：fleet-api alert show 没跑成：Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /x / Node.js v22",
  untouchedFails: n,
});

test('【#2728】untouchedFails：只认 failed、release.sh 没起、第 0–3 步；老记录没有计数算 1 趟', () => {
  assert.equal(untouchedFails(untouchedTrain(H1, 2)), 2);
  assert.equal(untouchedFails({ ...untouchedTrain(H1, 2), untouchedFails: undefined }), 1);
  assert.equal(untouchedFails({ ...untouchedTrain(H1, 2), phase: 4 }), 0);
  assert.equal(untouchedFails({ ...untouchedTrain(H1, 2), release: { started: true } }), 0);
  assert.equal(untouchedFails({ ...untouchedTrain(H1, 2), status: 'blocked' }), 0);
  assert.equal(untouchedFails(null), 0);
});

test('【#2728 故意造出的失败】第 0 步没成的那一趟不挡：下一轮照常再请求同一个提交（不等 30 分钟去重），连败 3 趟才停、开一张急修单，开过不再开', async () => {
  const m = autoMachine();
  m.issues = [];
  m.io.fileIssue = async (issue) => {
    m.issues.push(issue);
    return { number: 2799, url: 'https://github.com/o/r/issues/2799', created: true };
  };
  // 第 1 轮：请求发 H1
  await m.round();
  assert.equal(m.requests.length, 1);
  // 接活单元接走、第 0 步没成（第 1 趟）：5 分钟后的下一轮照常再请求，不当成「刚请求过」
  for (const n of [1, 2]) {
    m.t += 5 * MIN;
    m.gate = {
      ...GOOD_GATE,
      trainText: JSON.stringify(untouchedTrain(H1, n, new Date(m.t - MIN).toISOString())),
    };
    const st = await m.round();
    assert.equal(m.requests.length, n + 1, `第 ${n} 趟没成后照常重试`);
    assert.equal(st.last.action, 'auto-release-requested');
  }
  // 第 3 趟也没成：停下，开急修单
  m.t += 5 * MIN;
  m.gate = {
    ...GOOD_GATE,
    trainText: JSON.stringify(untouchedTrain(H1, 3, new Date(m.t - MIN).toISOString())),
  };
  let st = await m.round();
  assert.equal(m.requests.length, 3, '连败 3 趟不再请求');
  assert.match(st.auto.note, /发版还没动手就连败 3 趟.*Cannot find package 'zod'/);
  assert.match(st.auto.note, /已开急修单 #2799/);
  assert.equal(m.issues.length, 1);
  const issue = m.issues[0];
  assert.equal(issue.key, `release-untouched:${H1}`);
  assert.match(issue.title, /^急修：法国自动发版 bbbbbbbbbbbb 在第 0 步「预检」连败 3 趟，已停$/);
  for (const h of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
    assert.ok(issue.body.includes(h), h);
  assert.match(issue.body, /Cannot find package 'zod'/);
  assert.doesNotMatch(issue.body, /要你拍|处理好再点/);
  assert.deepEqual(st.emergency, {
    sha: H1,
    number: 2799,
    url: 'https://github.com/o/r/issues/2799',
    at: new Date(m.t).toISOString(),
  });
  assert.ok(!m.alerts.some((a) => a.key === EMERGENCY_KEY), '开成了不报「没开成」');
  // 下一轮：还挡着，不再开第二张
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(m.issues.length, 1, '同一个提交只开一张');
  assert.equal(m.requests.length, 3);
  assert.match(st.auto.note, /已开急修单 #2799/);
  // 修好的新提交合进来、绿了：换了要发的提交，不挡
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(m.requests.at(-1).sha, H2, '修好的新提交照常发');
  assert.equal(UNTOUCHED_FAIL_LIMIT, 3);
});

test('【#2728 故意造出的失败】急修单没开成（fleet-api 坏了）：报一条卡住报警，每轮再试，开成了撤', async () => {
  const m = autoMachine();
  let fail = true;
  m.io.fileIssue = async () => {
    if (fail)
      throw new Error(
        "fleet-api emergency-issue 退出码 1：Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'",
      );
    return { number: 2800, url: 'u', created: true };
  };
  m.gate = { ...GOOD_GATE, trainText: JSON.stringify(untouchedTrain(H1, 3)) };
  let st = await m.round();
  assert.equal(m.requests.length, 0);
  const a = m.alerts.find((x) => x.key === EMERGENCY_KEY);
  assert.ok(a, '报了没开成');
  assert.match(a.body, /Cannot find package 'zod'/);
  assert.equal(st.emergency.number, null);
  assert.match(st.auto.note, /急修单没开成/);
  fail = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.emergency.number, 2800);
  assert.ok(m.resolvedKeys.includes(EMERGENCY_KEY), '开成了撤掉那一条');
});

test('【#2728】闸：还没动手的失败不足 3 趟放行；满 3 趟挡同一个提交，不挡别的提交；动了手的失败不重发同一个提交', () => {
  const facts = (train, target = H1) => ({ ...GOOD_GATE, trainText: JSON.stringify(train), target });
  assert.equal(gateVerdict(facts(untouchedTrain(H1, 1))), null);
  assert.equal(gateVerdict(facts(untouchedTrain(H1, 2))), null);
  assert.match(gateVerdict(facts(untouchedTrain(H1, 3))), /连败 3 趟/);
  assert.equal(gateVerdict(facts(untouchedTrain(H1, 3), H2)), null, '换了要发的提交不挡');
  assert.match(
    gateVerdict({ ...facts(untouchedTrain(H1, 3)), target: undefined }),
    /连败/,
    '不知道要发哪个：挡',
  );
  assert.match(
    gateVerdict(facts({ ...untouchedTrain(H1, 1), phase: 5, release: { started: true } })),
    /同一个提交不自动重发/,
  );
});

// ── #2728：脚本副本和在用版本比哈希、依赖指纹 ──

test('【#2728 故意造出的失败】装着的接活脚本和在用那一版不一样：状态里记 drift、列出哪个；一样记 ok；读不到记 unchecked', async () => {
  const m = machine();
  const files = (over = {}) =>
    INSTALLED_COPIES.flatMap(({ dir, files: fs }) =>
      fs.map((f) => ({ name: `${dir}/${f}`, installed: 'x', release: 'x', ...(over[`${dir}/${f}`] ?? {}) })),
    );
  m.io.readInstalled = async () => files();
  let st = await m.round();
  assert.deepEqual(
    { commit: st.installed.commit, result: st.installed.result, drift: st.installed.drift },
    { commit: H0, result: 'ok', drift: [] },
  );
  const stale = '/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs';
  m.io.readInstalled = async () =>
    files({
      [stale]: { installed: '旧的' },
      '/usr/local/lib/fleet-dao/release-request/lib.mjs': { installed: null },
    });
  st = await m.round();
  assert.equal(st.installed.result, 'drift');
  assert.deepEqual(st.installed.drift, ['/usr/local/lib/fleet-dao/release-request/lib.mjs（没装）', stale]);
  assert.match(summary(st), /脚本副本和在用版本不一致/);
  m.io.readInstalled = async () => {
    throw new Error('EACCES');
  };
  st = await m.round();
  assert.equal(st.installed.result, 'unchecked');
  assert.match(st.installed.detail, /EACCES/);
});

const MODULES_YAML = (at) => `{\n  "hoistPattern": ["*"],\n  "prunedAt": "${at}",\n  "storeDir": "/x"\n}\n`;

test('【#2728】发版后在用那一版的依赖被重装：树完好降日报，树坏报警，核对读不出记 unchecked；换提交重新记、撤旧提醒', async () => {
  const m = machine();
  let yaml = MODULES_YAML('Fri, 16 Oct 2026 08:20:00 GMT');
  m.io.readDeps = async (sha) => {
    assert.equal(sha, m.current);
    return yaml;
  };
  let st = await m.round();
  assert.equal(st.deps.commit, H0);
  assert.equal(st.deps.prunedAt, 'Fri, 16 Oct 2026 08:20:00 GMT');
  assert.equal(st.deps.result, 'ok');
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.alerts.length, 0, '没变不报');
  yaml = MODULES_YAML('Fri, 16 Oct 2026 08:30:16 GMT');
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.deps.result, 'repaired');
  assert.equal(st.deps.detail, '重装过但树完好');
  const repaired = m.alerts.at(-1);
  assert.equal(repaired?.key, `${DEPS_PREFIX}${H0}`);
  assert.equal(repaired?.level, 'daily');
  assert.match(repaired?.body, /prunedAt Fri, 16 Oct 2026 08:20:00 GMT，现在 Fri, 16 Oct 2026 08:30:16 GMT/);
  // 下一轮还是一样：不重发
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.alerts.filter((x) => x.key === `${DEPS_PREFIX}${H0}`).length, 1);
  yaml = MODULES_YAML('Fri, 16 Oct 2026 08:40:16 GMT');
  m.io.checkDeps = async () => ({
    result: 'bad',
    detail: '链接 packages/api/node_modules/drizzle-orm 指到 /root',
  });
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.deps.result, 'changed');
  assert.match(st.deps.detail, /drizzle-orm 指到 \/root/);
  const broken = m.alerts.at(-1);
  assert.equal(broken?.level, 'alert');
  assert.match(broken?.body, /哪个链接坏了|drizzle-orm 指到 \/root/);
  yaml = MODULES_YAML('Fri, 16 Oct 2026 08:50:16 GMT');
  m.io.checkDeps = async () => ({ result: 'unchecked', detail: 'EACCES' });
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.deps.result, 'unchecked');
  assert.match(st.deps.detail, /EACCES/);
  assert.equal(m.alerts.at(-1)?.level, 'alert');
  // 发了新版：重新记，撤掉旧的
  buttonReleaseTo(m, H2, '2026-09-27T08:20:00Z');
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.deps.commit, H2);
  assert.equal(st.deps.result, 'ok');
  assert.ok(m.resolved.includes(DEPS_PREFIX));
  // 读不到：记没查成，不当成没变
  m.io.readDeps = async () => {
    throw new Error('ENOENT');
  };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.deps.result, 'unchecked');
  assert.equal(prunedAtOf('prunedAt: Fri, 16 Oct 2026 09:00:26 GMT\n'), 'Fri, 16 Oct 2026 09:00:26 GMT');
});

test('【#2728 故意造出的失败】一趟发版 --check 超时判了失败、后一趟发成功（在用的等于或新于失败那趟的目标）：自动撤掉那张 release:failed 卡，只撤一次；目标比在用的新不撤', async () => {
  const failedTrain = (sha) =>
    JSON.stringify({
      schema: 1,
      status: 'failed',
      phase: 5,
      target: { kind: 'sha', value: sha },
      release: { started: true },
    });
  // 失败那趟的目标 H0 就是在用的（切上去了，只是检查没过）
  const m = machine();
  m.io.readTrain = async () => failedTrain(H0);
  let st = await m.round();
  assert.ok(m.resolved.includes(`release:failed:${H0.slice(0, 12)}:`), '撤了失败卡');
  assert.equal(st.superseded, H0);
  m.resolved = [];
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(m.resolved, [], '同一个只撤一次');
  // 目标比在用的新（H1 没切上去）：不撤
  const n = machine();
  n.io.readTrain = async () => failedTrain(H1);
  await n.round();
  assert.ok(!n.resolved.some((p) => p.startsWith('release:failed:')), '没被取代的不撤');
  // 读不到：不撤，记一笔
  const r = machine();
  r.io.readTrain = async () => {
    throw new Error('EACCES');
  };
  st = await r.round();
  assert.ok(!r.resolved.some((p) => p.startsWith('release:failed:')));
});

test('【#2728】急修单正文：四节齐、原话写明 AI 发现、只列 diff 里看得见的做完条件', () => {
  const issue = emergencyIssue(untouchedTrain(H1, 3), 3);
  assert.match(issue.body, /^## 场景\n/);
  assert.match(issue.body, /## 原话\n\n无（AI 发现/);
  assert.doesNotMatch(issue.body, /截图|线上看到/);
});

// ── 攒着发（#2797）：要停引擎的版本离上次停引擎不到 30 分钟先不发；不停引擎的马上发；上一版退回过照发 ──

/** autoMachine 上再接「要不要停引擎」：restart 由用例定，记下问了几次；引擎 since 分钟前起来的。 */
function batchMachine({ restart, sinceMin, historyLast = null }) {
  const m = autoMachine();
  m.asked = [];
  m.restart = restart;
  m.io.engineRestart = async (current, target) => {
    m.asked.push([current, target]);
    if (m.restart instanceof Error) throw m.restart;
    return {
      restart: m.restart,
      why: m.restart
        ? '改了 引擎运行要读的文件：packages/engine/src/a.ts'
        : '改的 2 个文件都不在引擎的引用闭包里',
    };
  };
  m.gate.engineSince = sinceMin === null ? null : T0 - sinceMin * MIN;
  m.gate.historyLast = historyLast;
  return m;
}

test('间隔是 30 分钟（常量钉住）', () => {
  assert.equal(ENGINE_RESTART_GAP_MS, 30 * MIN);
});

test('要停引擎、上次停引擎才 10 分钟：先不发，写明攒到几点；到点发那时主线最新的绿提交（攒着的几版一次发）；同一对提交只判一次', async () => {
  const m = batchMachine({ restart: true, sinceMin: 10 });
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.match(
    st.auto.note,
    /要停引擎（改了 引擎运行要读的文件：packages\/engine\/src\/a\.ts），上次停引擎才 10 分钟（不到 30 分钟），攒到 \d\d:\d\dZ 再发/,
  );
  m.t += 5 * MIN;
  await m.round();
  assert.equal(m.requests.length, 0);
  assert.equal(m.asked.length, 1, '同一对提交不重算闭包');
  // 这期间又合了一版（也绿了）：到点发最新的 H2，不是 H1
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.t += 16 * MIN; // 距引擎起来 31 分钟
  const sent = await m.round();
  assert.deepEqual(
    m.requests.map((r) => r.sha),
    [H2],
  );
  assert.equal(sent.last.action, 'auto-release-requested');
});

test('不停引擎的版本：上次停引擎才 2 分钟也马上发，写明不停引擎', async () => {
  const m = batchMachine({ restart: false, sinceMin: 2 });
  const st = await m.round();
  assert.equal(m.requests.length, 1);
  assert.equal(m.requests[0].sha, H1);
  assert.match(st.auto.note, /不停引擎/);
});

test('例外照发：上一版没过健康检查、自动退回、手动退回过，要停引擎也不等', async () => {
  for (const event of ['unhealthy', 'auto-rollback', 'rollback']) {
    const m = batchMachine({
      restart: true,
      sinceMin: 3,
      historyLast: `2026-09-27T07:58:00Z ${H0} ${event}`,
    });
    await m.round();
    assert.equal(m.requests.length, 1, event);
  }
  // 上一版正常发完（release）：照样攒
  const m = batchMachine({ restart: true, sinceMin: 3, historyLast: `2026-09-27T07:58:00Z ${H0} release` });
  await m.round();
  assert.equal(m.requests.length, 0);
});

test('【故意造出的失败】判不了要不要停引擎（闭包没算成）：当要停，照样攒；读不到引擎什么时候起的：不拦，照发', async () => {
  const m = batchMachine({ restart: new Error('tsc 没跑成'), sinceMin: 5 });
  const st = await m.round();
  assert.equal(m.requests.length, 0);
  assert.match(st.auto.note, /要停引擎（判不了：tsc 没跑成）/);
  const blind = batchMachine({ restart: true, sinceMin: null });
  await blind.round();
  assert.equal(blind.requests.length, 1);
});

test('batchVerdict：纯函数的边界', () => {
  const now = T0;
  assert.equal(batchVerdict({ restart: false, why: '', engineSince: now, historyLast: null, now }), null);
  assert.equal(
    batchVerdict({
      restart: null,
      why: '',
      engineSince: now - ENGINE_RESTART_GAP_MS,
      historyLast: null,
      now,
    }),
    null,
  );
  assert.match(
    String(batchVerdict({ restart: null, why: '', engineSince: now - 1, historyLast: null, now })),
    /要停引擎/,
  );
});

test('#3409 真实 auto adapter 完整转发 requestId、supersedes 与 expectedAttempt，receiver 实际解析', async () => {
  const first = {
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'release',
    sha: H1,
    at: new Date(T0).toISOString(),
    by: 'commander',
  };
  const captured = [];
  const writer = requestWriters((request) => captured.push(request));
  await writer.requestRelease({
    sha: H1,
    at: new Date(T0).toISOString(),
    by: AUTO_RELEASE_BY,
    requestId: '22222222-2222-4222-8222-222222222222',
    supersedes: first,
  });
  await writer.requestRetry({
    sha: H1,
    at: new Date(T0).toISOString(),
    by: AUTO_RELEASE_BY,
    requestId: '33333333-3333-4333-8333-333333333333',
    expectedAttempt: first,
  });
  const release = parseRequest(JSON.stringify(captured[0]));
  const retry = parseRequest(JSON.stringify(captured[1]));
  assert.equal(release.ok, true);
  assert.equal(retry.ok, true);
  assert.deepEqual(release.supersedes, first);
  assert.deepEqual(retry.expectedAttempt, first);
  assert.notEqual(release.requestId, retry.requestId);
});

test('#3409 真实 gate 准许的未动手 failed 才生成显式后继；running 不写请求', async () => {
  const m = autoMachine();
  const identity = {
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'release',
    sha: H1,
    at: new Date(T0 - MIN).toISOString(),
    by: 'commander',
  };
  const train = {
    status: 'failed',
    phase: 0,
    target: { kind: 'sha', value: H1 },
    requestId: identity.requestId,
    rootRequestId: identity.requestId,
    requests: [{ identity, target: H1, parent: null, supersededBy: null, status: 'failed' }],
    untouchedFails: 1,
  };
  m.gate.trainText = JSON.stringify(train);
  await m.round();
  assert.equal(m.requests.length, 1);
  assert.deepEqual(m.requests[0].supersedes, identity);
  assert.notEqual(m.requests[0].requestId, identity.requestId);
  const running = autoMachine();
  running.gate.trainText = JSON.stringify({ ...train, status: 'running' });
  await running.round();
  assert.equal(running.requests.length, 0);
});
