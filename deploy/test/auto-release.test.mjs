// 自动发布（deploy/france/auto-release/lib.mjs）每条路：CI 红不发、CI 结论读不到不发并记没查成、发布没成记下报警不死循环、
// 引擎忙等空闲（到上限照发）、人手动切过不跟人打架、主线头读不到、规矩同步没成报警不挡发布、库连不上报警留到下一轮。
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
  EXIT_RELEASE_BUSY,
  EXIT_SESSIONS_BUSY,
  FAILED_PREFIX,
  IDLE_WAIT_MS,
  INSTALL_PATHS,
  manualHold,
  parseHistory,
  parseMainLog,
  parseScopes,
  RULES_PREFIX,
  RULES_USERS,
  runOnce,
  STATE_SCHEMA,
  summary,
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

/** 一台假机器：主线两个提交（H1 在 07:30 合进来、CI 绿），在用 H0，引擎空闲，发布会成。 */
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
    sessions: '',
    sessionsThrow: null,
    releaseBusy: false,
    checkout: { ok: true },
    release: { code: 0, log: '/srv/fleet-dao-releases/.logs/x.log', detail: '' },
    rules: { code: 0, out: '  ✓ 一致' },
    checkoutHead: null, // null = 和在用的同一个
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
    async ciRuns(sha) {
      m.calls.push(`ci ${sha[0]}`);
      if (m.ciThrow) throw new Error(m.ciThrow);
      return m.ci;
    },
    async releaseBusy() {
      return m.releaseBusy;
    },
    async prepareCheckout() {
      return m.checkout;
    },
    async sessions() {
      if (m.sessionsThrow) throw new Error(m.sessionsThrow);
      return m.sessions;
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

test('CI 红：不发，记 ci-red；结论按提交号记住，下一轮不再问 GitHub', async () => {
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
    [],
  );
  assert.equal(st.last.action, 'ci-red');
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

test('发布没成：记下、报警一次；同一个提交不再试（不死循环），主线出了新提交再发；跟上后报警解除', async () => {
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
  // 修复合进来
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
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

test('引擎有会话在跑：等空闲、记下从何时等；空了就发；等满 60 分钟照发（带 --busy-ok）', async () => {
  const m = machine();
  m.sessions = '17 active\n18 inactive\n';
  let st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'wait-idle');
  assert.equal(st.waitingSince, new Date(T0).toISOString());
  assert.equal(st.busy, '17');
  // 新提交来了也接着算，不从头等
  m.main.unshift([H2, '2026-09-27T08:10:00Z']);
  m.ci = runsBody(run(H2, 'completed', 'success'));
  m.t += 30 * MIN;
  st = await m.round();
  assert.equal(st.last.action, 'wait-idle');
  assert.equal(st.waitingSince, new Date(T0).toISOString());
  m.t = T0 + IDLE_WAIT_MS;
  st = await m.round();
  assert.deepEqual(releases(m), ['release c busy-ok']);
  assert.equal(st.attempt.busyOk, true);
  assert.equal(st.waitingSince, null);

  const idle = machine();
  idle.sessions = '17 active\n';
  await idle.round();
  idle.sessions = '17 inactive\n';
  idle.t += 5 * MIN;
  await idle.round();
  assert.deepEqual(releases(idle), ['release b'], '空了就发，不带 --busy-ok');
});

test('会话列表读不到、认不出：按在跑算，不发', async () => {
  for (const setup of [
    (m) => (m.sessionsThrow = 'fleet-agent-scope list 退出码 1'),
    (m) => (m.sessions = '没有空格的一行\n'),
  ]) {
    const m = machine();
    setup(m);
    const st = await m.round();
    assert.deepEqual(releases(m), []);
    assert.equal(st.last.action, 'wait-idle');
    assert.match(st.busy, /没查成/);
  }
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

test('人手动退回过：主线上没有比那次更新的提交就不自动发（不跟人打架），修复合进来再发', async () => {
  const m = machine();
  m.history +=
    '2026-09-27T07:40:00Z bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb release auto\n' +
    '2026-09-27T07:50:00Z aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rollback\n';
  let st = await m.round();
  assert.deepEqual(releases(m), []);
  assert.equal(st.last.action, 'hold');
  assert.equal(st.hold.event, 'rollback');
  m.main.unshift([H2, '2026-09-27T08:10:00Z']);
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
  // 下一个提交发了、同步成了：解除
  m.main.unshift([H2, '2026-09-27T08:20:00Z']);
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
  m.sessions = '17 active\n';
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

test('读数：一行人看的，写明主线头、落后几个、这一轮干了什么、规矩和装机层到哪', async () => {
  const m = machine();
  m.ci = runsBody(run(H1, 'completed', 'failure'));
  const line = summary(await m.round());
  assert.match(line, /主线头 bbbbbbbbbbbb，CI red；在用 aaaaaaaaaaaa，落后 1 个提交/);
  assert.match(line, /这轮：ci-red/);
  assert.match(line, /规矩同步到/);
  assert.match(line, /装机脚本装到 aaaaaaaaaaaa，之后相关提交 0 个/);
  assert.match(line, /配置和期望一致/);
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

test('解析：主线列表、发布历史、会话列表认不出就抛，不拿半截当全部', () => {
  assert.throws(() => parseMainLog(''), /空/);
  assert.throws(() => parseMainLog(`${H1} 不是时间`), /认不出/);
  assert.equal(parseMainLog(`${H1} 2026-09-27T07:30:00+02:00\n`)[0].at, '2026-09-27T05:30:00.000Z');
  assert.throws(() => parseHistory(`2026-09-27T07:30:00Z ${H1} 发布`), /认不出/);
  assert.deepEqual(parseHistory(`2026-09-27T07:30:00Z ${H1} release unmerged auto`)[0].tags, [
    'unmerged',
    'auto',
  ]);
  assert.deepEqual(parseScopes('1 active\n2 deactivating\n3 inactive\n4 failed\n'), ['1', '2']);
  assert.throws(() => parseScopes('坏行'), /认不出/);
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
