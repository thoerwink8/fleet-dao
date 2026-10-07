// 自动发布单元（deploy/france/auto-release/lib.mjs）每条路：只读不发（决定 0032、#1258）。
// 每一轮读主线头、它的 CI、在用的提交、落后几个，没有任何 v<N> 标记的仓上也照常；绝不调发布脚本、不看版本标记；
// 发完版（驾驶舱按钮）之后顺带装机自动档、同步规矩，没成报警；配置对账；状态文件读不出就什么都不做；
// 单元还会发版那会儿开的报警新版第一次跑撤一遍。
// git、GitHub、发布脚本、库都换成假的；真机上那一半（真定时器）合并后在法国装上验，记在引入本文件的 PR 里。
// 跑法：node --test deploy/test/auto-release.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DESIRED_FILE,
  FINGERPRINT_ALGORITHM,
  fingerprintOf,
  keyIdOf,
  parseFingerprintKey,
} from '../france/auto-release/config.mjs';
import {
  CI_WORKFLOW,
  CONFIG_PREFIX,
  CONFIG_UNCHECKED_KEY,
  ciVerdict,
  HUMAN_TIER_PATHS,
  parseMainLog,
  RETIRED_ALERT_PREFIXES,
  RULES_PREFIX,
  RULES_USERS,
  runOnce,
  runRound,
  STATE_SCHEMA,
  STATE_UNREADABLE_KEY,
  summary,
  TIER_PREFIX,
  TIER_RETRY_MS,
} from '../france/auto-release/lib.mjs';

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
    // 主线最近那些次 ci.yml 的运行（一次一整份）
    async ciRuns() {
      m.calls.push('ci');
      if (m.ciThrow) throw new Error(m.ciThrow);
      return m.ci;
    },
    async checkoutHead() {
      return m.checkoutHead ?? m.current;
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
  assert.match(line, /发布走驾驶舱按钮/);
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
});

// 装机分两档（docs/ops.md 第九节「装机层」）：人工档（lib/human-tier.sh 里的函数，碰防火墙、sudoers、建用户）改了要人重跑、
// 才让 deploy_lag 红；自动档（下面这份清单）由自动发布顺带跑 france.sh --auto-tier。其余是整套装机才用的（装软件、钉版本），
// 不在两档里。新加一个被 france.sh 引用的仓里文件，必须在这里登记它属于哪一档，免得悄悄漏了。
const AUTO_TIER_FILES = [
  'deploy/france/fleet-agents.slice',
  'deploy/france/fleet-auto-release.service',
  'deploy/france/fleet-auto-release.timer',
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
  'deploy/lib/mirasim.sh',
  'deploy/lib/agents-sync.sh',
  'deploy/lib/app-config.sh',
  'deploy/lib/session-pnpm.sh',
  'deploy/lib/node-cache.sh',
  'deploy/lib/auto-release-state.sh',
  'deploy/lib/node-report-gate.sh',
  // 整套装机才用的单元和配置样例
  'deploy/france/fleet-temporal.service',
  'deploy/france/fleet-mirasim-session.service',
  'deploy/france/temporal.yaml',
  'deploy/france/france.env.example',
  'deploy/france/fleet-temporal-cli.sh',
  'deploy/france/fleet-engine.service',
  'deploy/france/fleet-api.service',
  'deploy/france/bundle-gateway.sh',
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

test('自动档不碰防火墙、sudoers、建用户：auto-tier 那几个函数里一个都没有', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const body = (name) => new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(france)?.[1] ?? '';
  for (const fn of ['setup_auto_tier', 'setup_slice', 'retire_old_units', 'setup_auto_release']) {
    const text = body(fn);
    assert.ok(text.length > 10, `读到了 ${fn}`);
    assert.doesNotMatch(
      text,
      /setup_firewall|setup_sudoers|setup_identity|setup_pilot|ensure_service_user|sudoers|nft |useradd|visudo/,
      `${fn} 不许碰防火墙、sudoers、建用户`,
    );
  }
  // 自动档入口只调这三个
  assert.match(body('setup_auto_tier'), /^\s*setup_slice\n\s*retire_old_units\n\s*setup_auto_release\s*$/);
  // 反过来：人工档的函数都在 human-tier.sh，不在 france.sh 里
  for (const fn of ['setup_identity', 'setup_pilot', 'setup_sudoers', 'setup_firewall', 'render_firewall']) {
    assert.equal(body(fn), '', `${fn} 应当写在 deploy/lib/human-tier.sh`);
  }
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
