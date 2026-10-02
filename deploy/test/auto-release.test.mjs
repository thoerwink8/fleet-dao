// 自动发布（deploy/france/auto-release/lib.mjs）每条路：按版本发（发的不是主线头，是版本号最大的 v<N> tag 指向的提交）、
// 标记缺失 / 读不到 / 不是主线上的提交都不发并报警、标记那一版 CI 红了/读不到就不发、发布没成记下报警不死循环、
// 引擎忙等空闲（到上限照发）、人手动切过不跟人打架、规矩同步没成报警不挡发布、库连不上报警留到下一轮、
// 发布四步（停派活→等收尾→部署→恢复派活）在引擎关着时照实写「跳过」不假装做过（决定 0011 第 3、4 条）。
// git、GitHub、会话、发布脚本、库都换成假的；真机上那一半（真定时器、真发布）合并后在法国装上验，记在引入本文件的 PR 里。
// 跑法：node --test deploy/test/auto-release.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
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
  ENGINE_UNKNOWN_KEY,
  EXIT_RELEASE_BUSY,
  EXIT_SESSIONS_BUSY,
  FAILED_PREFIX,
  IDLE_WAIT_MS,
  INSTALL_PATHS,
  manualHold,
  parseHistory,
  parseMainLog,
  parseVersionTags,
  pickVersionMarker,
  publishSequence,
  publishSequenceSummary,
  RULES_PREFIX,
  RULES_USERS,
  runOnce,
  STATE_SCHEMA,
  summary,
  VERSION_TAG_RE,
} from '../france/auto-release/lib.mjs';

const H0 = 'a'.repeat(40); // 在用的
const H1 = 'b'.repeat(40); // 主线头
const H2 = 'c'.repeat(40); // 后来又合进来的
const T0 = Date.parse('2026-09-27T08:00:00Z');
const T1 = '2026-09-27T07:35:00Z'; // 打 tag 的时刻
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

/** 一台假机器：主线两个提交（H1 在 07:30 合进来、CI 绿），在用 H0，引擎空闲，发布会成。
 *  默认的版本标记：v1 打在 H1 上（H1 在主线 = 是祖先）——这一轮就发 H1。 */
function machine() {
  const m = {
    t: T0,
    main: [
      [H1, '2026-09-27T07:30:00Z'],
      [H0, '2026-09-27T06:00:00Z'],
    ],
    mainError: null,
    current: H0,
    history: '2026-09-27T06:05:00Z aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa release\n',
    ci: runsBody(run(H1, 'completed', 'success')),
    ciThrow: null,
    releaseBusy: false,
    checkout: { ok: true },
    release: { code: 0, log: '/srv/fleet-dao-releases/.logs/x.log', detail: '' },
    rules: { code: 0, out: '  ✓ 一致' },
    checkoutHead: null, // null = 和在用的同一个
    dbDown: false,
    // 版本标记（决定 0011 第 3 条）：tag 列表原文，和「哪些提交在主线上」两个都换成假的。
    // tagsThrow = 读的时候就抛（git 没跑成）；mainAncestors = null 表示判祖先关系时抛。
    tags: `v1 ${H1}  ${T1}\n`, // 默认：v1 → H1（轻量 tag：git 的第三段是空的，所以名字和时间之间两个空格）
    tagsThrow: null,
    mainAncestors: [H1, H0], // 这些提交算「在 origin/main 上」
    mainAncestorsThrow: null,
    engineOnError: null,
    engineUp: false, // 法国现在 FLEET_SERVICES=fleet-api：引擎关着
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
    checkouts: [], // 部署检出每次快进到的提交
    alerts: [],
    resolved: [],
    resolvedKeys: [],
    saved: [],
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
      return m.current;
    },
    async readHistory() {
      return m.history;
    },
    // 版本标记：git for-each-ref 的原样输出；读不到就抛
    async readVersionTags() {
      m.calls.push('tags');
      if (m.tagsThrow) throw new Error(m.tagsThrow);
      return m.tags;
    },
    // 这个提交是不是 origin/main 的祖先：假的判法就是「在 m.mainAncestors 里」
    async isAncestorOfMain(commit) {
      m.calls.push(`ancestor ${commit[0]}`);
      if (m.mainAncestorsThrow) throw new Error(m.mainAncestorsThrow);
      return m.mainAncestors.includes(commit);
    },
    async engineOn() {
      if (m.engineOnError) throw new Error(m.engineOnError);
      return m.engineUp;
    },
    // 主线最近那些次 ci.yml 的运行（一次一整份，候选都从里面判）
    async ciRuns() {
      m.calls.push('ci');
      if (m.ciThrow) throw new Error(m.ciThrow);
      return m.ci;
    },
    async releaseBusy() {
      return m.releaseBusy;
    },
    async prepareCheckout(sha) {
      m.checkouts.push(sha);
      return m.checkout;
    },
    async runRelease(sha, busyOk) {
      m.calls.push(`release ${sha[0]}${busyOk ? ' busy-ok' : ''}`);
      if (m.release.code === 0 || m.release.code === 2) m.current = sha;
      return m.release;
    },
    async checkoutHead() {
      return m.checkoutHead ?? m.current;
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
  };
  /** 跑一轮，状态接着上一轮的；清掉这一轮之前的调用记录。 */
  m.round = async () => {
    m.calls = [];
    m.state = await runOnce(m.io, m.state ?? null);
    return m.state;
  };
  return m;
}
const releases = (m) => m.calls.filter((c) => c.startsWith('release'));

test('平常：主线头 CI 绿、引擎空闲 → 发，发完同步规矩；再一轮什么都不动', async () => {
  const m = machine();
  const st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.schema, STATE_SCHEMA);
  assert.equal(st.attempt.result, 'ok');
  assert.equal(st.last.action, 'released');
  assert.equal(m.saved.length, 1, '发之前先存一次状态：后端这时看得到「在发」');
  assert.equal(m.saved[0].attempt.result, 'running');
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    RULES_USERS.map((u) => `rules ${u}`),
  );
  assert.equal(st.rules.commit, H1);
  assert.equal(st.rules.result, 'ok');
  m.t += 5 * MIN;
  const again = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(again.last.action, 'up-to-date');
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
    '同一个提交规矩只同步一次',
  );
});

test('CI 红：不发，记 ci-red；下一轮再问一次（一轮最多一次），重跑绿了就发', async () => {
  const m = machine();
  m.ci = runsBody(run(H1, 'completed', 'failure'));
  let st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'ci-red');
  assert.equal(st.ci.verdict, 'red');
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('ci')),
    ['ci'],
  );
  assert.equal(st.last.action, 'ci-red');
  // 有人在 GitHub 上重跑了这次 CI、过了
  m.ci = runsBody(run(H1, 'completed', 'success', { run_attempt: 2 }));
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(releases(m), ['release b']);
});

test('主线头全绿记下：等引擎空闲的那几轮不再问 GitHub', async () => {
  const m = machine();
  m.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  await m.round();
  m.t += 5 * MIN;
  const st = await m.round();
  assert.equal(st.last.action, 'wait-idle');
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('ci')),
    [],
  );
});

test('CI 结论读不到（限流、回的不是 JSON、连不上、半小时还查不到这次 CI）：不发，记没查成，下一轮再问', async () => {
  for (const [why, setup] of [
    [
      '限流',
      (m) =>
        (m.ci = { status: 403, body: '{"message":"API rate limit exceeded"}', rate: '这个钟头还剩 0 次' }),
    ],
    ['不是 JSON', (m) => (m.ci = { status: 200, body: '<html>502</html>' })],
    ['连不上', (m) => (m.ciThrow = 'getaddrinfo EAI_AGAIN api.github.com')],
    ['查不到这次 CI', (m) => (m.ci = runsBody())],
  ]) {
    const m = machine();
    setup(m);
    const st = await m.round();
    assert.deepEqual(releases(m), [], why);
    assert.equal(st.last.action, 'ci-unknown', why);
    assert.equal(st.ci.verdict, 'unknown', why);
    m.t += 5 * MIN;
    await m.round();
    assert.ok(
      m.calls.some((c) => c.startsWith('ci')),
      `${why}：没查成的不记住，下一轮再问`,
    );
  }
});

test('刚合进来、CI 还没开跑或还在跑：等，不发', async () => {
  const m = machine();
  m.t = Date.parse('2026-09-27T07:35:00Z');
  m.ci = runsBody();
  assert.equal((await m.round()).last.action, 'ci-pending');
  m.ci = runsBody(run(H1, 'in_progress', null));
  assert.equal((await m.round()).last.action, 'ci-pending');
  assert.deepEqual(releases(m), []);
});

// ── 按版本发（决定 0011 第 3 条）：发的是版本号最大的 v<N> tag 指向的那个提交，不是主线头 ──

const H3 = 'e'.repeat(40); // 再后来合进来的
const _ciCalls = (m) => m.calls.filter((c) => c.startsWith('ci'));
/**
 * git for-each-ref 的一行真样子：轻量 tag 的第三段（指向的对象）是空的，所以名字和时间之间两个空格；annotated tag 第二段是
 * tag 对象号、第三段才是提交号。早先的写法（只有一个空格）不是 git 真会吐出来的，把「轻量 tag 解析不了」这个洞盖住了。
 */
const tagLine = (tag, sha, at = T1, object = '') =>
  object === '' ? `${tag} ${sha}  ${at}\n` : `${tag} ${object} ${sha} ${at}\n`;

test('【故意造出的失败】主线头比版本标记新：发标记那一版，不发主线头（旧的「发主线头」就是这个切片要废掉的）', async () => {
  const m = machine();
  // 主线：H2（发布之后又合进来的普通 PR）、H1（v1 打在这里）、H0（在用）
  m.main.unshift([H2, '2026-09-27T07:58:00Z']);
  m.tags = tagLine('v1', H1);
  m.ci = runsBody(run(H1, 'completed', 'success'), run(H2, 'completed', 'success'));
  let st = await m.round();
  assert.deepEqual(releases(m), ['release b'], '发的是 v1 指着的 H1');
  assert.deepEqual(m.checkouts, [H1], '部署检出快进到标记那一版，不是主线头');
  assert.equal(st.attempt.sha, H1);
  assert.equal(st.attempt.result, 'ok');
  assert.equal(st.last.action, 'released');
  assert.equal(st.marker.tag, 'v1');
  assert.equal(st.marker.commit, H1);
  assert.equal(st.ci.sha, H1, 'CI 结论记的是标记那一版，不是主线头');
  assert.equal(st.rules.commit, H1, '规矩同步跟着发出去的那个提交走');
  // 主线头又变绿了也不发：没有新的版本标记，这一版已经上过线了
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'up-to-date');
});

test('【故意造出的失败】marker 缺失：一个 v<N> tag 都没有 → 明确失败、报警、绝不发主线头', async () => {
  const m = machine();
  m.tags = '';
  const st = await m.round();
  assert.deepEqual(releases(m), [], '没有版本标记就什么都不发');
  assert.deepEqual(m.checkouts, [], '连检出都不动');
  assert.equal(st.last.action, 'marker-none');
  assert.equal(st.marker, null);
  assert.equal(st.markerError.kind, 'none');
  assert.match(st.markerError.why, /一个 v<N> 版本标记都没有/);
  assert.equal(m.alerts.length, 1, '报警一条');
  assert.equal(m.alerts[0].key, 'auto-release:marker-unreadable');
  assert.match(m.alerts[0].body, /没有版本标记就不发主线头/);
  // 置回标记：报警自己撤
  m.tags = tagLine('v1', H1);
  m.t += 5 * MIN;
  const again = await m.round();
  assert.equal(again.last.action, 'released');
  assert.ok(!again.alerts.some((a) => a.key === 'auto-release:marker-unreadable'), '查成了不留着');
});

test('【故意造出的失败】marker 指向的提交不是 origin/main 的祖先 → 明确失败、报警、不发主线头、也不往回发旧的', async () => {
  const m = machine();
  // v2 打在别的分支上的提交（H2 不在 m.mainAncestors 里），v1 还在 H1 上
  m.tags = tagLine('v2', H2, '2026-09-27T07:58:00Z') + tagLine('v1', H1);
  const st = await m.round();
  assert.deepEqual(releases(m), [], 'v2 不是主线上的提交：不发');
  assert.equal(st.marker, null);
  assert.equal(st.markerError.kind, 'not-ancestor');
  assert.match(st.markerError.why, /不是 origin\/main 的祖先/);
  assert.equal(m.alerts.length, 1);
  assert.equal(m.alerts[0].key, 'auto-release:marker:v2');
  assert.match(m.alerts[0].title, /v2 不是主线上的提交/);
  // v3 打在主线上的新提交：换成它、报警自己撤
  m.main.unshift([H3, '2026-09-27T08:20:00Z']);
  m.mainAncestors = [H3, H1, H0];
  m.tags =
    tagLine('v3', H3, '2026-09-27T08:21:00Z') + tagLine('v2', H2, '2026-09-27T07:58:00Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H3, 'completed', 'success'), run(H1, 'completed', 'success'));
  m.t += 5 * MIN;
  const again = await m.round();
  assert.deepEqual(releases(m), ['release e']);
  assert.ok(!again.alerts.some((a) => a.key === 'auto-release:marker:v2'), '不是祖先的报警撤掉');
});

test('【故意造出的失败】判祖先关系时 git 没跑成 → 明确失败、不当成「不是祖先」也不当成绿', async () => {
  const m = machine();
  m.mainAncestorsThrow = 'git merge-base 退出码 128';
  const st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.marker, null);
  assert.equal(st.markerError.kind, 'unchecked');
  assert.match(st.markerError.why, /没查成/);
  assert.equal(m.alerts[0]?.key, 'auto-release:marker-unreadable');
});

test('【故意造出的失败】读 tag 列表本身没跑成 → 明确失败、不发', async () => {
  const m = machine();
  m.tagsThrow = 'git for-each-ref 退出码 128：not a git repository';
  const st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.marker, null);
  assert.equal(st.markerError.kind, 'unreadable');
  assert.equal(m.alerts[0]?.key, 'auto-release:marker-unreadable');
});

test('版本号按数字排，不按字符串：v10 > v9（字符串排会把 v9 当最新）', async () => {
  const m = machine();
  m.main.unshift([H3, '2026-09-27T08:20:00Z'], [H2, '2026-09-27T07:50:00Z']);
  m.mainAncestors = [H3, H2, H1, H0];
  // 故意把 v10 排在 v9 后面：按字符串排 v9 会胜出
  m.tags = tagLine('v9', H2, '2026-09-27T07:51:00Z') + tagLine('v10', H3, '2026-09-27T08:21:00Z');
  m.ci = runsBody(run(H3, 'completed', 'success'), run(H2, 'completed', 'success'));
  const st = await m.round();
  assert.equal(st.marker.tag, 'v10', 'v10 才是最新的');
  assert.equal(st.marker.commit, H3);
  assert.deepEqual(releases(m), ['release e']);
});

test('标记那一版的 CI 还在跑：等它（不往回找更旧的全绿提交，也不发主线头）', async () => {
  const m = machine();
  m.main.unshift([H2, '2026-09-27T07:58:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T07:58:00Z');
  m.ci = runsBody(run(H2, 'in_progress', null, { run_number: 11 }), run(H1, 'completed', 'success'));
  let st = await m.round();
  assert.deepEqual(releases(m), [], '标记那一版还没绿：不发（H1 绿也不发它）');
  assert.equal(st.last.action, 'ci-pending');
  assert.equal(st.ci.sha, H2);
  assert.equal(st.ci.verdict, 'pending');
  // 那一版绿了：发它
  m.ci = runsBody(run(H2, 'completed', 'success', { run_number: 11 }), run(H1, 'completed', 'success'));
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c']);
  assert.equal(st.rules.commit, H2);
});

test('标记那一版的 CI 红了：报 ci-red，等它（人不修就发不出去，不会退回发别的）', async () => {
  const m = machine();
  m.main.unshift([H2, '2026-09-27T07:50:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T07:50:00Z');
  m.ci = runsBody(run(H2, 'completed', 'failure', { run_number: 11 }), run(H1, 'completed', 'success'));
  let st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'ci-red');
  assert.match(st.last.detail, /v2（cccccccccccc）的 CI 结论是 failure/);
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'ci-red');
  assert.equal(st.waitingSince, null);
});

test('标记那一版的 CI 读不到（限流、连不上、回的认不出、HTTP 出错）：这一轮不发、写明没查成', async () => {
  for (const [why, setup] of [
    ['限流', (m) => (m.ci = { status: 403, body: '{"message":"API rate limit exceeded"}', rate: '' })],
    ['连不上', (m) => (m.ciThrow = 'getaddrinfo EAI_AGAIN api.github.com')],
    ['回的不是运行列表', (m) => (m.ci = { status: 200, body: '{"message":"Not Found"}' })],
    ['HTTP 502', (m) => (m.ci = { status: 502, body: '' })],
  ]) {
    const m = machine();
    m.main.unshift([H2, '2026-09-27T07:58:00Z']);
    m.mainAncestors = [H2, H1, H0];
    m.tags = tagLine('v2', H2, '2026-09-27T07:58:00Z');
    setup(m);
    const st = await m.round();
    assert.deepEqual(releases(m), [], why);
    assert.equal(st.last.action, 'ci-unknown', why);
    assert.match(st.last.detail, /没查成/, why);
    assert.equal(st.ci.sha, H2, why);
    assert.equal(st.ci.verdict, 'unknown', why);
  }
});

test('要发的版本标记也要等引擎空闲：读数写明要发哪个', async () => {
  const m = machine();
  m.main.unshift([H2, '2026-09-27T07:58:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T07:58:00Z');
  m.ci = runsBody(run(H2, 'completed', 'success', { run_number: 11 }), run(H1, 'completed', 'success'));
  m.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  let st = await m.round();
  assert.equal(st.last.action, 'wait-idle');
  assert.match(st.last.detail, /要发的是 cccccccccccc/);
  m.release = { code: 0, log: '', detail: '' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c']);
});

test('标记指向的提交比在用的旧（人退回过、又打了老 tag）：不发——不往回退版本', async () => {
  const m = machine();
  // 在用的 H2（比 H1 新），标记还指着 H1
  m.current = H2;
  m.main.unshift([H2, '2026-09-27T07:58:00Z']);
  m.tags = tagLine('v1', H1);
  const st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.deepEqual(m.checkouts, []);
  assert.match(st.last.action, /failed-before|up-to-date/);
});

test('【故意造出的失败】标记比在用的旧、主线上却还有更新的提交：不发——不降级（候选里没有标记指的那个提交就不发）', async () => {
  const m = machine();
  // 主线新到旧 H3 H2 H1 H0；在用的是 H1（人手动发过）；版本标记 v1 还指着更旧的 H0
  m.main = [
    [H3, '2026-09-27T07:50:00Z'],
    [H2, '2026-09-27T07:40:00Z'],
    [H1, '2026-09-27T07:30:00Z'],
    [H0, '2026-09-27T06:00:00Z'],
  ];
  m.mainAncestors = [H3, H2, H1, H0];
  m.current = H1;
  m.tags = tagLine('v1', H0);
  m.ci = runsBody(run(H0, 'completed', 'success'));
  const st = await m.round();
  assert.deepEqual(releases(m), [], '标记指的 H0 比在用的 H1 旧：发它就是降级');
  assert.deepEqual(m.checkouts, []);
  assert.equal(st.last.action, 'marker-not-newer');
  assert.equal(st.attempt, null, '什么都没发：不留「发过」的记录');
});

test('读数（journal、release.sh --check）：新状态按版本标记说，老状态（没有 marker 字段）照老样子按主线头说', () => {
  const base = {
    schema: STATE_SCHEMA,
    ranAt: '2026-09-27T08:00:00.000Z',
    main: {
      checkedAt: '2026-09-27T08:00:00.000Z',
      head: H2,
      headAt: '2026-09-27T07:50:00.000Z',
      commits: [
        [H2, '2026-09-27T07:50:00.000Z'],
        [H1, '2026-09-27T07:30:00.000Z'],
        [H0, '2026-09-27T06:00:00.000Z'],
      ],
    },
    current: H0,
    ci: { sha: H1, verdict: 'green', detail: '', checkedAt: '2026-09-27T08:00:00.000Z' },
    last: null,
    rules: null,
    system: null,
    config: null,
  };
  const lines = (st) => summary(st).split('；');
  // 新状态：标记指着 H1，在用 H0（落后标记 1 个提交）；主线头 H2 只作参考，不算落后
  const marker = {
    tag: 'v3',
    commit: H1,
    at: '2026-09-27T07:30:00.000Z',
    checkedAt: '2026-09-27T08:00:00.000Z',
  };
  const now = lines({ ...base, marker });
  assert.ok(now.includes('版本标记 v3（bbbbbbbbbbbb），CI green'), now.join(' | '));
  assert.ok(now.includes('在用 aaaaaaaaaaaa，落后版本标记 1 个提交'), now.join(' | '));
  assert.ok(
    now.some((l) => l.startsWith('主线头 cccccccccccc（只作参考')),
    now.join(' | '),
  );
  // 在用的就是标记那一版 / 比标记还新（人手动发过更新的）
  assert.ok(lines({ ...base, marker, current: H1 }).includes('在用 bbbbbbbbbbbb，跟上了版本标记'));
  assert.ok(lines({ ...base, marker, current: H2 }).includes('在用 cccccccccccc，比版本标记新'));
  // 标记没查成（null）：写明原因，不拿主线头充数说「落后几个」
  const none = lines({
    ...base,
    marker: null,
    markerError: { kind: 'none', why: '一个 v<N> 版本标记都没有', at: '2026-09-27T08:00:00.000Z' },
  });
  assert.ok(none.includes('版本标记没有（一个 v<N> 版本标记都没有）'), none.join(' | '));
  assert.ok(none.includes('在用 aaaaaaaaaaaa，没有版本标记可比'), none.join(' | '));
  // 老状态：没有 marker 这个字段，读数和改之前一模一样（release-flow.test.sh 的断言就拿它）
  const legacy = lines(base);
  assert.ok(legacy.includes('主线头 cccccccccccc'), legacy.join(' | '));
  assert.ok(legacy.includes('在用 aaaaaaaaaaaa，落后 2 个提交'), legacy.join(' | '));
});

test('发过没成的版本标记：不再自动试（不往回挑更旧的标记），等下一个版本标记', async () => {
  for (const [what, setup, said] of [
    [
      '自动发过、没成（记在状态里）',
      (m) =>
        (m.state = {
          schema: STATE_SCHEMA,
          attempt: {
            sha: H2,
            startedAt: '2026-09-27T07:52:00Z',
            endedAt: '2026-09-27T07:56:00Z',
            result: 'failed',
          },
          alerts: [],
          resolve: [],
        }),
      /v2 指向的提交自动发过、没成/,
    ],
    [
      '发过、没过健康检查（记在发布历史里，状态文件丢了也认得）',
      (m) =>
        (m.history +=
          `2026-09-27T07:52:00Z ${H2} release auto\n` +
          `2026-09-27T07:55:00Z ${H2} unhealthy auto\n` +
          `2026-09-27T07:55:30Z ${H0} auto-rollback auto\n`),
      /v2 指向的提交发过、没过健康检查/,
    ],
  ]) {
    const m = machine();
    // 主线：H3（发布之后合进来的）、H2（v2 打在这里，发过没成）、H1（v1，从没被发过）、H0（在用）
    m.main.unshift([H3, '2026-09-27T07:58:00Z'], [H2, '2026-09-27T07:50:00Z']);
    m.mainAncestors = [H3, H2, H1, H0];
    m.tags = tagLine('v2', H2, '2026-09-27T07:50:00Z') + tagLine('v1', H1);
    m.ci = runsBody(run(H2, 'completed', 'success', { run_number: 11 }), run(H1, 'completed', 'success'));
    setup(m);
    let st = await m.round();
    assert.deepEqual(releases(m), [], what);
    assert.equal(st.last.action, 'failed-before', what);
    assert.match(st.last.detail, said, what);
    // 下一个版本标记（v3 打在 H3 上）：照发新的，不回头试 v1
    m.tags = `${tagLine('v3', H3, '2026-09-27T07:58:00Z')}${tagLine('v2', H2, '2026-09-27T07:50:00Z')}${tagLine('v1', H1)}`;
    m.ci = runsBody(run(H3, 'completed', 'success', { run_number: 12 }));
    m.t += 5 * MIN;
    st = await m.round();
    assert.deepEqual(releases(m), ['release e'], what);
  }
});

test('某一版发布没成：报警记它；它不再试，下一个版本标记照发，报警解除', async () => {
  const m = machine();
  m.release = { code: 1, log: '/srv/fleet-dao-releases/.logs/z.log', detail: '迁移失败' };
  let st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.attempt.result, 'failed');
  assert.deepEqual(
    m.alerts.map((a) => a.key),
    [`${FAILED_PREFIX}${H1}`],
  );
  assert.match(m.alerts[0].title, /自动发布 v1/);
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), [], '没成的不再试');
  assert.equal(st.last.action, 'failed-before');
  // 下一个版本标记（v2 打在 H2 上）：照发新的
  m.main.unshift([H2, '2026-09-27T07:58:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T07:58:00Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H2, 'completed', 'success', { run_number: 11 }));
  m.release = { code: 0, log: '', detail: '' };
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(releases(m), ['release c']);
  assert.deepEqual(m.resolved, [FAILED_PREFIX]);
});

test('人手动退回过：退回到那一刻之前打的版本标记不发（不跟人打架），下一个版本标记照发', async () => {
  const m = machine();
  // H1 自动发过，人 07:50 手动退回 H0；标记还停在 H1（打在退回之前）
  m.history += `2026-09-27T07:40:00Z ${H1} release auto\n2026-09-27T07:50:00Z ${H0} rollback\n`;
  let st = await m.round();
  assert.deepEqual(releases(m), [], '人按住着：标记那一版不发');
  assert.equal(st.last.action, 'hold');
  assert.equal(st.hold.sha, H0);
  // 人又发了一版（下一个版本标记 v2 打在 H2 上）：照发，不再跟人打架
  m.main.unshift([H2, '2026-09-27T07:55:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T07:55:30Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H2, 'completed', 'success', { run_number: 11 }));
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c']);
  assert.equal(st.hold, null, '主线上有了退回之后合进来的提交，就不算按住');
});

test('发布没成：记下、报警一次；同一版不再试（不死循环），下一个版本标记照发；跟上后报警解除', async () => {
  const m = machine();
  m.release = {
    code: 1,
    log: '/srv/fleet-dao-releases/.logs/y.log',
    detail: 'fleet-api：/healthz 回的不是健康报告',
  };
  let st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.attempt.result, 'failed');
  assert.equal(st.last.action, 'release-failed');
  assert.equal(m.alerts.length, 1);
  assert.equal(m.alerts[0].key, `${FAILED_PREFIX}${H1}`);
  assert.match(m.alerts[0].body, /健康报告.*y\.log/);
  for (let i = 0; i < 3; i++) {
    m.t += 5 * MIN;
    st = await m.round();
    assert.deepEqual(releases(m), [], '同一个提交不再试');
    assert.equal(st.last.action, 'failed-before');
  }
  assert.equal(m.alerts.length, 1, '报警只发一次');
  // 修复合进来、打下一个版本标记
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T08:20:30Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.release = { code: 0, log: '', detail: '' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c']);
  assert.deepEqual(m.resolved, [FAILED_PREFIX]);
});

test('发布脚本起不来（抛错）：当成没成，照样记下、报警', async () => {
  const m = machine();
  m.io.runRelease = async () => {
    throw new Error('spawn bash ENOENT');
  };
  const st = await m.round();
  assert.equal(st.attempt.result, 'failed');
  assert.match(st.attempt.detail, /ENOENT/);
  assert.equal(m.alerts.length, 1);
});

test('有要发的就马上交给发布脚本（它先排空引擎），不先看有没有会话在跑、不干等空闲', async () => {
  const m = machine();
  const st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.attempt.busyOk, false);
  assert.equal(st.waitingSince, null);
});

test('引擎不会排空（发布脚本退出 76）：等空闲、记下从何时等；空了就发；等满 60 分钟照发（带 --busy-ok）', async () => {
  const m = machine();
  m.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  let st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.last.action, 'wait-idle');
  assert.equal(st.waitingSince, new Date(T0).toISOString());
  assert.equal(st.attempt, null);
  // 主线又有提交合进来（不是版本标记）：接着算等空闲的钟，不从头等，也不去发它
  m.main.unshift([H2, '2026-09-27T08:10:00Z']);
  m.t += 30 * MIN;
  st = await m.round();
  assert.equal(st.last.action, 'wait-idle');
  assert.equal(st.waitingSince, new Date(T0).toISOString());
  m.release = { code: 0, log: '', detail: '' };
  m.t = T0 + IDLE_WAIT_MS;
  st = await m.round();
  assert.deepEqual(releases(m), ['release b busy-ok'], '要发的还是 v1 那一版（H2 上没有版本标记）');
  assert.equal(st.attempt.busyOk, true);
  assert.equal(st.waitingSince, null);

  const idle = machine();
  idle.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  await idle.round();
  idle.release = { code: 0, log: '', detail: '' };
  idle.t += 5 * MIN;
  await idle.round();
  assert.deepEqual(releases(idle), ['release b'], '空了就发，不带 --busy-ok');
});

test('切之前又看到会话在跑（发布脚本退出 76）、另一个发布在跑（75）：什么都没动，不算没成、不报警', async () => {
  const m = machine();
  m.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  let st = await m.round();
  assert.equal(st.last.action, 'wait-idle');
  assert.equal(st.attempt, null);
  assert.ok(st.waitingSince);
  m.release = { code: EXIT_RELEASE_BUSY, log: '', detail: '' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.last.action, 'release-busy');
  assert.equal(st.attempt, null);
  assert.equal(m.alerts.length, 0);
  m.release = { code: 0, log: '', detail: '' };
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(releases(m), ['release b'], '下一轮照常再来');
});

test('另一个发布在跑、部署检出有改动或分叉：不发', async () => {
  const m = machine();
  m.releaseBusy = true;
  assert.equal((await m.round()).last.action, 'release-busy');
  m.releaseBusy = false;
  m.checkout = { ok: false, why: '部署检出 /srv/fleet-dao 有没提交的改动：M deploy/release.sh' };
  const st = await m.round();
  assert.equal(st.last.action, 'checkout-blocked');
  assert.match(st.last.detail, /没提交的改动/);
  assert.deepEqual(releases(m), []);
});

test('人手动退回过：下一个版本标记打在退回之后，照发（不跟人打架）', async () => {
  const m = machine();
  m.history +=
    '2026-09-27T07:40:00Z bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb release auto\n' +
    '2026-09-27T07:50:00Z aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rollback\n';
  let st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'hold');
  assert.equal(st.hold.event, 'rollback');
  // 下一个版本标记（v2 打在 H2 上）：照发
  m.main.unshift([H2, '2026-09-27T08:10:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T08:10:30Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.t += 15 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c']);
  assert.equal(st.hold, null);
});

test('合并前在真机上验（--unmerged 手动发的）：主线出新提交之前不动它', async () => {
  const m = machine();
  const pr = 'd'.repeat(40);
  m.current = pr;
  m.history += `2026-09-27T07:45:00Z ${pr} release unmerged\n`;
  const st = await m.round();
  assert.equal(st.last.action, 'hold');
  assert.equal(st.hold.unmerged, true);
  assert.deepEqual(releases(m), []);
});

test('发过、判过不健康的提交（状态文件丢了也认得）：不自动再发', async () => {
  const m = machine();
  m.history +=
    '2026-09-27T07:40:00Z bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb release auto\n' +
    '2026-09-27T07:41:00Z bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb unhealthy auto\n' +
    '2026-09-27T07:42:00Z aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa auto-rollback auto\n';
  const st = await m.round();
  assert.equal(st.last.action, 'failed-before');
  assert.deepEqual(releases(m), []);
});

test('发布历史认不出：拿不准人动没动过手，不发、记没查成', async () => {
  const m = machine();
  m.history = '这不是一行历史\n';
  const st = await m.round();
  assert.equal(st.last.action, 'history-unreadable');
  assert.deepEqual(releases(m), []);
});

test('主线头读不到：记没查成（原因留着），上一次的主线读数不丢，不发、不同步规矩', async () => {
  const m = machine();
  await m.round();
  const seen = m.state.main;
  m.mainError = '从 GitHub 取主线失败（git 退出码 128）：Could not resolve host';
  m.t += 5 * MIN;
  const st = await m.round();
  assert.equal(st.last.action, 'main-unreadable');
  assert.match(st.mainError, /Could not resolve host/);
  assert.deepEqual(st.main, seen);
  assert.deepEqual(m.calls, ['main']);
});

test('上一轮的发布没收到结果（那一轮被杀了）：锁还占着就等；空了按在用的是谁定成败，没成照样报警', async () => {
  const m = machine();
  m.state = {
    schema: STATE_SCHEMA,
    attempt: { sha: H1, startedAt: '2026-09-27T07:40:00Z', result: 'running' },
    alerts: [],
    resolve: [],
  };
  m.releaseBusy = true;
  let st = await m.round();
  assert.equal(st.last.action, 'release-busy');
  assert.equal(st.attempt.result, 'running');
  m.releaseBusy = false;
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.attempt.result, 'failed');
  assert.equal(st.last.action, 'failed-before');
  assert.equal(m.alerts.length, 1);
  assert.match(m.alerts[0].title, /没等到结果/);
});

test('规矩同步没成：记下、报警，不挡发布；同一个提交不重跑；检出和在用的对不上就不同步', async () => {
  const m = machine();
  m.rules = { code: 1, out: '  ✗ ~/.claude/CLAUDE.md 写不进去\n' };
  let st = await m.round();
  assert.equal(st.attempt.result, 'ok', '规矩没成不挡发布');
  assert.equal(st.rules.result, 'failed');
  assert.match(st.rules.detail, /写不进去/);
  assert.equal(m.alerts.length, 1);
  assert.equal(m.alerts[0].key, `${RULES_PREFIX}${H1}`);
  m.t += 5 * MIN;
  await m.round();
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith('rules')),
    [],
    '同一个提交不重跑',
  );
  // 下一个版本标记发了、同步成了：解除
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
  m.mainAncestors = [H2, H1, H0];
  m.tags = tagLine('v2', H2, '2026-09-27T08:20:30Z') + tagLine('v1', H1);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.rules = { code: 0, out: '  ✓ 一致' };
  m.t += 5 * MIN;
  st = await m.round();
  assert.equal(st.rules.result, 'ok');
  assert.deepEqual(m.resolved, [RULES_PREFIX]);

  const off = machine();
  off.checkoutHead = H2;
  await off.round();
  assert.deepEqual(
    off.calls.filter((c) => c.startsWith('rules')),
    [],
    '检出不在在用的那个提交上：规矩不跟着乱动',
  );
});

test('发之前状态文件写不进去：不发（发到一半这一轮没了，下一轮连发过什么都不知道）', async () => {
  const m = machine();
  m.io.save = async () => {
    throw new Error('ENOSPC');
  };
  const st = await m.round();
  assert.equal(st.last.action, 'state-unwritable');
  assert.deepEqual(releases(m), []);
  assert.equal(st.attempt, null);
});

test('人手动退回、CI 红：之前等空闲的钟不接着走，下一个头从头等', async () => {
  const m = machine();
  m.release = { code: EXIT_SESSIONS_BUSY, log: '', detail: '' };
  await m.round();
  assert.ok(m.state.waitingSince);
  m.ci = runsBody(run(H1, 'completed', 'failure'));
  m.state.ci = null;
  m.t += 5 * MIN;
  const st = await m.round();
  assert.equal(st.last.action, 'ci-red');
  assert.equal(st.waitingSince, null);
});

test('库连不上：报警留到下一轮再发，不丢', async () => {
  const m = machine();
  m.release = { code: 1, log: '', detail: '迁移失败' };
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

test('读数：一行人看的，写明版本标记、落后几个、这一轮干了什么、规矩和装机层到哪', async () => {
  const m = machine();
  m.ci = runsBody(run(H1, 'completed', 'failure'));
  const line = summary(await m.round());
  assert.match(line, /版本标记 v1（bbbbbbbbbbbb）/);
  assert.match(line, /在用 aaaaaaaaaaaa，落后版本标记 1 个提交/);
  assert.match(line, /这轮：ci-red/);
  assert.match(line, /规矩同步到/);
  assert.match(line, /装机脚本装到 aaaaaaaaaaaa，之后相关提交 0 个/);
  assert.match(line, /配置和期望一致/);
});

test('版本标记读不到时，读数里写明为什么（不是「主线头 ccc…」那种含糊话）', async () => {
  const m = machine();
  m.tags = '';
  const line = summary(await m.round());
  assert.match(line, /版本标记没有（一个 v<N> 版本标记都没有/);
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

test('解析：主线列表、发布历史认不出就抛，不拿半截当全部', () => {
  assert.throws(() => parseMainLog(''), /空/);
  assert.throws(() => parseMainLog(`${H1} 不是时间`), /认不出/);
  assert.equal(parseMainLog(`${H1} 2026-09-27T07:30:00+02:00\n`)[0].at, '2026-09-27T05:30:00.000Z');
  assert.throws(() => parseHistory(`2026-09-27T07:30:00Z ${H1} 发布`), /认不出/);
  assert.deepEqual(parseHistory(`2026-09-27T07:30:00Z ${H1} release unmerged auto`)[0].tags, [
    'unmerged',
    'auto',
  ]);
});

test('人手动切的才算按住：带 auto 的不算；主线头比那次新就不按住', () => {
  const h = parseHistory(`2026-09-27T07:00:00Z ${H0} release\n2026-09-27T07:40:00Z ${H1} release auto\n`);
  assert.equal(manualHold(h, '2026-09-27T07:30:00Z'), null);
  assert.equal(manualHold(h, '2026-09-27T06:30:00Z').sha, H0);
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

test('装机层落后的路径盖住了 france.sh 从仓里读的每个文件', () => {
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const refs = [...france.matchAll(/\$DEPLOY_DIR\/([A-Za-z0-9_./-]+)/g)].map((m) => `deploy/${m[1]}`);
  const inside = refs.filter((r) => !r.startsWith('deploy/..') && !r.endsWith('/'));
  assert.ok(inside.length > 10, `读到了 france.sh 引用的文件（${inside.length} 个）`);
  const include = INSTALL_PATHS.filter((p) => !p.startsWith(':('));
  const exclude = INSTALL_PATHS.filter((p) => p.startsWith(':(exclude)')).map((p) => p.slice(10));
  for (const r of inside) {
    const covered =
      include.some((p) => (p.endsWith('/') ? r.startsWith(p) : r === p)) && !exclude.includes(r);
    assert.ok(covered, `${r} 没被 INSTALL_PATHS 盖住：它改了 france.sh 要重跑，后端却不会标落后`);
  }
});

// ── 版本标记的解析和挑选（决定 0011 第 3 条）：纯判定，单独测 ──

const H4 = 'f'.repeat(40);

test('【故意造出的失败】解析 tag 列表：非版本 tag 跳过、版本号按数字排、认不出的行抛（不拿半截当全部）', () => {
  const parsed = parseVersionTags(
    [
      tagLine('nightly', H0, '2026-09-27T06:00:00Z'),
      tagLine('v9', H2, '2026-09-27T07:00:00Z'),
      tagLine('v10', H1, '2026-09-27T07:30:00Z'),
      tagLine('v1', H0, '2026-09-27T06:00:00Z'),
    ].join(''),
  );
  assert.deepEqual(
    parsed.map((t) => t.tag),
    ['v10', 'v9', 'v1'],
    '版本号按数字排：v10 在 v9 前面（字符串排会把 v9 当最新）',
  );
  assert.equal(parsed[0].commit, H1);
  assert.equal(parsed[0].n, 10);
  assert.deepEqual(parseVersionTags(''), [], '一个 tag 都没有就是空数组（上层记「标记缺失」）');
  assert.deepEqual(parseVersionTags(tagLine('nightly', H0, '2026-09-27T06:00:00Z')), [], '只有非版本 tag');
  // annotated tag：第一个 40 位是 tag 对象、第二个才是它指的提交，要取第二个
  assert.equal(
    parseVersionTags(tagLine('v7', H1, '2026-09-27T07:30:00Z', H4))[0].commit,
    H1,
    'annotated tag 取它指的那个提交（*objectname）',
  );
  assert.throws(() => parseVersionTags('v1 不是提交号  2026-09-27T07:30:00Z'), /认不出/);
  assert.throws(() => parseVersionTags(`v1 ${H1}  不是时间`), /认不出/);
  assert.throws(
    () => parseVersionTags(`v1 ${H1} 2026-09-27T07:30:00Z`),
    /认不出/,
    '只有三段：不是 git 吐出来的样子',
  );
  assert.throws(
    () => parseVersionTags(`v1 ${H1} 不是提交  2026-09-27T07:30:00Z`),
    /认不出/,
    '第三段既不空也不是提交号',
  );
});

test('【故意造出的失败】轻量 tag（git 的第三段是空的、两个空格）也认得；人手打的非版本轻量 tag 夹在里面不连累整份列表', () => {
  // git for-each-ref 对轻量 tag 的真输出：`v1 <提交号>  <时间>`。早先的写法只认单个空格，一条轻量 tag 就让整份列表「认不出」，
  // 版本标记读不到，法国从此不发——哪怕那条根本不是版本标记（比如人手打了个 `latest`）。
  const text = [
    `latest ${H0}  2026-09-27T05:00:00Z`,
    `v2 ${H2}  2026-09-27T07:58:00Z`,
    `v1 ${H4} ${H1} 2026-09-27T07:30:00Z`,
  ].join('\n');
  const parsed = parseVersionTags(text);
  assert.deepEqual(
    parsed.map((t) => [t.tag, t.commit]),
    [
      ['v2', H2],
      ['v1', H1],
    ],
  );
});

test('【故意造出的失败】挑标记：最新的那个不是主线上的提交 → 明确失败（kind=not-ancestor），不往回退而求其次', async () => {
  const tags = parseVersionTags(
    [tagLine('v2', H2, '2026-09-27T07:58:00Z'), tagLine('v1', H1, '2026-09-27T07:30:00Z')].join(''),
  );
  const only = [H1, H0]; // H2 不在主线上
  const r = await pickVersionMarker(tags, async (c) => only.includes(c));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not-ancestor');
  assert.equal(r.tag.tag, 'v2');
  assert.match(r.why, /不是 origin\/main 的祖先/);
});

test('【故意造出的失败】挑标记：一个都没有 → kind=none；判祖先抛了 → kind=unchecked（不当成「不是祖先」）', async () => {
  const none = await pickVersionMarker([], async () => true);
  assert.equal(none.kind, 'none');
  assert.match(none.why, /一个 v<N> 版本标记都没有/);
  const tags = parseVersionTags(tagLine('v1', H1, '2026-09-27T07:30:00Z'));
  const bad = await pickVersionMarker(tags, async () => {
    throw new Error('git merge-base 退出码 128');
  });
  assert.equal(bad.kind, 'unchecked');
  assert.match(bad.why, /没查成/);
});

test('挑标记：最新的那个在主线上就用它（只判最新的一个，不问更旧的）', async () => {
  const tags = parseVersionTags(
    [
      tagLine('v3', H2, '2026-09-27T07:58:00Z'),
      tagLine('v2', H1, '2026-09-27T07:30:00Z'),
      tagLine('v1', H0, '2026-09-27T06:00:00Z'),
    ].join(''),
  );
  const asked = [];
  const r = await pickVersionMarker(tags, async (c) => {
    asked.push(c);
    return true;
  });
  assert.equal(r.ok, true);
  assert.equal(r.tag.tag, 'v3');
  assert.deepEqual(asked, [H2], '只问最新那一个');
});

test('版本标记的写法要和 packages/conventions 那边（release.yml 用的 isVersionTag）一致', () => {
  // 两边一个判定「打不打 tag、叫什么名」，一个判定「法国发哪一版」：写法漂了就会一边认一边不认。
  const src = readFileSync(
    new URL('../../packages/conventions/src/publish-release-logic.ts', import.meta.url),
    'utf8',
  );
  const m = /export function isVersionTag\(s: string\)[\s\S]*?return (\/.*?\/)\.test\(s\);/.exec(src);
  assert.ok(m, '读到了 publish-release-logic.ts 里 isVersionTag 的正则');
  assert.equal(
    VERSION_TAG_RE.source,
    m[1].slice(1, -1),
    '两边的正则源码要一模一样（改了那边就要改这边，VERSION_TAG_RE 上面那段注释写着）',
  );
});

// ── 发布四步（决定 0011 第 4 条）：停派活 → 等在跑的收尾 → 部署 → 恢复派活 ──

test('【故意造出的失败】引擎关着：四步照实写「跳过」，绝不假装做过', () => {
  const seq = publishSequence({ engineOn: false, target: H1, tag: 'v1' });
  assert.equal(seq.engineOn, false);
  assert.deepEqual(
    seq.steps.map((s) => [s.name, s.state]),
    [
      ['停派活', 'skipped-engine-off'],
      ['等在跑的收尾', 'skipped-engine-off'],
      ['部署', 'delegated'],
      ['恢复派活', 'skipped-engine-off'],
    ],
  );
  for (const s of seq.steps.filter((x) => x.state === 'skipped-engine-off')) {
    assert.match(s.detail, /引擎关着/, `${s.name}：要说清是关着才没做`);
  }
  const line = publishSequenceSummary(seq);
  assert.match(line, /停派活：跳过（引擎关着）/);
  assert.match(line, /恢复派活：跳过（引擎关着）/);
  assert.ok(!/停派活：做了/.test(line), '没做的不许写成做了');
});

test('引擎开着：四步交给 release.sh 的排空协议做（不新加开关、不加库里的列），排空靠 .drain-request', () => {
  const seq = publishSequence({ engineOn: true, target: H1, tag: 'v1' });
  assert.equal(seq.engineOn, true);
  assert.deepEqual(
    seq.steps.map((s) => s.name),
    ['停派活', '等在跑的收尾', '部署', '恢复派活'],
  );
  const text = seq.steps.map((s) => s.detail).join('\n');
  assert.match(text, /\.drain-request/, '停派活 = 写排空请求（已有的协议）');
  assert.match(text, /drain\.json/, '等收尾 = 读引擎的 drain.json 数会话');
  assert.ok(!/engine_dispatch_paused/.test(text), '不引入库里的新开关');
});

test('【故意造出的失败】引擎关着时发一版：状态里四步都记「跳过」，读数照实写', async () => {
  const m = machine();
  m.engineUp = false;
  const st = await m.round();
  assert.deepEqual(releases(m), ['release b'], '引擎关着照样发（发布不靠引擎）');
  assert.equal(st.sequence.engineOn, false);
  assert.deepEqual(
    st.sequence.steps.map((s) => s.state),
    ['skipped-engine-off', 'skipped-engine-off', 'delegated', 'skipped-engine-off'],
  );
  const line = summary(st);
  assert.match(line, /发布四步（引擎关着）/);
  assert.match(line, /停派活：跳过（引擎关着）/);
});

test('引擎开着时发一版：状态里四步记「交给发布脚本」，不是「跳过」', async () => {
  const m = machine();
  m.engineUp = true;
  const st = await m.round();
  assert.equal(st.sequence.engineOn, true);
  assert.deepEqual(
    st.sequence.steps.map((s) => s.state),
    ['delegated', 'delegated', 'delegated', 'delegated'],
  );
  assert.match(summary(st), /发布四步（引擎开着）/);
});

test('【故意造出的失败】引擎开没开着没查成：这一轮不发、不动部署检出、报警，不拿「关着」冒充；下一轮查成了就发并撤警', async () => {
  const m = machine();
  m.engineOnError = 'systemctl 没跑成';
  let st = await m.round();
  assert.deepEqual(releases(m), [], '不知道引擎开没开着：发布脚本会不会去排空它、四步该记什么都说不准，不发');
  assert.deepEqual(m.checkouts, [], '连部署检出都没动');
  assert.equal(st.last.action, 'engine-unknown');
  assert.equal(st.sequence, null, '没把四步写成「跳过（引擎关着）」');
  assert.match(st.sequenceError, /没查成/);
  assert.match(summary(st), /四步没查成/);
  assert.equal(st.attempt, null, '什么都没发：不留「发过」的记录');
  assert.ok(
    m.alerts.some((a) => a.key === ENGINE_UNKNOWN_KEY),
    '报一条，别让它一直悄悄停着',
  );
  // 下一轮问得出来了（关着）：发，并把那条警撤掉
  m.engineOnError = null;
  m.t += 5 * MIN;
  st = await m.round();
  assert.deepEqual(releases(m), ['release b']);
  assert.equal(st.sequenceError, null);
  assert.equal(st.sequence.engineOn, false);
  assert.ok(m.resolvedKeys.includes(ENGINE_UNKNOWN_KEY), '查成了那条警自己撤');
});

test('真机上那半边：systemctl 说引擎活着才算开着，认不出的回要抛（不当成关着也不当成开着）', () => {
  const src = readFileSync(new URL('../france/auto-release/fleet-auto-release.mjs', import.meta.url), 'utf8');
  assert.match(src, /'is-active', 'fleet-engine\.service'/, '和 release.sh 同一个判法');
  assert.match(src, /回的认不出/, '认不出的回要抛，不猜');
});
