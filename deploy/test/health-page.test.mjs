// 健康页的判定（deploy/web/health/health.js）：只有后端明说在线的项才绿，其余每一种「没查成」都要报红。
// 跑法：node --test deploy/test/health-page.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFranceLink,
  fetchFranceLink,
  fetchHealth,
  franceLinkLine,
  judge,
  REQUIRED,
} from '../web/health/health.js';

const report = (ok, checks) => JSON.stringify({ ok, checks });
const allOk = { database: { ok: true }, temporal: { ok: true }, engine: { ok: true } };
const byKey = (verdict) => Object.fromEntries(verdict.rows.map((r) => [r.key, r]));

test('三项都明说在线、HTTP 200：全绿', () => {
  const v = judge({ status: 200, body: report(true, allOk) });
  assert.equal(v.ok, true);
  assert.equal(v.summary, '全部在线');
  assert.deepEqual(
    v.rows.map((r) => [r.key, r.ok]),
    [
      ['database', true],
      ['temporal', true],
      ['engine', true],
    ],
  );
});

test('「未接」的项：不算不在线，整体照样绿，写明未接和单号', () => {
  const checks = {
    ...allOk,
    watchdog: { ok: true, status: 'not_wired', message: '这台机器不跑看门狗（#203）' },
  };
  const v = judge({ status: 200, body: report(true, checks) });
  assert.equal(v.ok, true);
  assert.equal(v.summary, '全部在线（1 项还没接上）');
  const row = byKey(v).watchdog;
  assert.equal(row.label, '看门狗');
  assert.equal(row.ok, true);
  assert.equal(row.notWired, true);
  assert.equal(row.reason, '未接：这台机器不跑看门狗（#203）');
  // 「未接」样子不完整（缺原因、原因是空的、status 认不出）：不算绿
  for (const bad of [
    { ok: true, status: 'not_wired' },
    { ok: true, status: 'not_wired', message: ' ' },
    { ok: true, status: 'someday', message: '还没做' },
  ]) {
    const u = judge({ status: 200, body: report(true, { ...allOk, watchdog: bad }) });
    assert.equal(u.ok, false, JSON.stringify(bad));
    assert.equal(byKey(u).watchdog.ok, false);
    assert.equal(byKey(u).watchdog.reason, '这一项的格式认不出');
  }
  // 接上以后出错：照样红
  const broken = { ...allOk, watchdog: { ok: false, code: 'unreachable', message: '连不上' } };
  const w = judge({ status: 503, body: report(false, broken) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).watchdog.ok, false);
});

test('「警告」的项（某个仓没装机器人）：不算不在线，整体照样绿，但显示成警告、总结里数出来；格式不全不算绿', () => {
  const warn = {
    ok: true,
    status: 'warning',
    code: 'github_app_not_installed',
    message: '有仓还没装好 GitHub 机器人（待处理）',
  };
  const v = judge({ status: 200, body: report(true, { ...allOk, github_app: warn }) });
  assert.equal(v.ok, true);
  assert.equal(v.summary, '全部在线（1 项警告要人看）');
  const row = byKey(v).github_app;
  assert.equal(row.ok, true);
  assert.equal(row.warning, true);
  assert.equal(row.reason, '警告：有仓还没装好 GitHub 机器人（待处理）');
  // 没有原因的警告：认不出，不算绿
  const u = judge({
    status: 200,
    body: report(true, { ...allOk, github_app: { ok: true, status: 'warning' } }),
  });
  assert.equal(u.ok, false);
  // 真故障（权限不对）照样红
  const bad = { ok: false, code: 'github_app', message: 'GitHub 机器人的权限有要人看的问题' };
  const w = judge({ status: 503, body: report(false, { ...allOk, github_app: bad }) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).github_app.warning, undefined);
});

test('判断题（judge）：显示成「判断题」；没配是「未接」不算坏，调用没成照实报红', () => {
  const notWired = { ok: true, status: 'not_wired', message: '这台机器没配判断题' };
  const v = judge({ status: 200, body: report(true, { ...allOk, judge: notWired }) });
  assert.equal(v.ok, true);
  assert.equal(byKey(v).judge.label, '判断题');
  assert.equal(byKey(v).judge.reason, '未接：这台机器没配判断题');
  const failing = { ok: false, code: 'judge_failing', message: '判断题最近一次调用没成' };
  const w = judge({ status: 503, body: report(false, { ...allOk, judge: failing }) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).judge.reason, '判断题最近一次调用没成（judge_failing）');
});

test('跟上主线（deploy_lag）：显示成「跟上主线」；落后照实报红、写明原因', () => {
  const lag = { ok: false, code: 'behind', message: '落后主线 2 个提交、1 小时 40 分钟（在等引擎空闲）' };
  const v = judge({ status: 503, body: report(false, { ...allOk, deploy_lag: lag }) });
  assert.equal(v.ok, false);
  assert.equal(byKey(v).deploy_lag.label, '跟上主线');
  assert.equal(byKey(v).deploy_lag.reason, '落后主线 2 个提交、1 小时 40 分钟（在等引擎空闲）（behind）');
});

test('看门狗（watchdog）：好的项带说明写在「在线」后面、说明空白不写半截；不好的项带上代码照实报红', () => {
  const fresh = { ok: true, message: '最近一轮 12 秒前跑完' };
  const v = judge({ status: 200, body: report(true, { ...allOk, watchdog: fresh }) });
  assert.equal(v.ok, true);
  assert.equal(v.summary, '全部在线');
  assert.equal(byKey(v).watchdog.label, '看门狗');
  assert.equal(byKey(v).watchdog.reason, '在线：最近一轮 12 秒前跑完');
  // 说明是空的：照样在线，不写半截
  const blank = judge({
    status: 200,
    body: report(true, { ...allOk, watchdog: { ok: true, message: ' ' } }),
  });
  assert.equal(byKey(blank).watchdog.reason, '在线');
  for (const [bad, reason] of [
    [
      { ok: false, code: 'silent', message: '最近一轮 7 分钟前就该跑完了' },
      '最近一轮 7 分钟前就该跑完了（silent）',
    ],
    [
      {
        ok: false,
        code: 'unchecked',
        message: '没查成：后端起来才 12 秒，还没跑过一轮',
      },
      '没查成：后端起来才 12 秒，还没跑过一轮（unchecked）',
    ],
  ]) {
    const w = judge({ status: 503, body: report(false, { ...allOk, watchdog: bad }) });
    assert.equal(w.ok, false);
    assert.equal(byKey(w).watchdog.ok, false);
    assert.equal(byKey(w).watchdog.reason, reason);
  }
});

test('会话账号切换（session_org）：显示成「会话账号切换」；有要人看的问题照实报红', () => {
  const v = judge({ status: 200, body: report(true, { ...allOk, session_org: { ok: true } }) });
  assert.equal(v.ok, true);
  assert.equal(byKey(v).session_org.label, '会话账号切换');
  assert.equal(byKey(v).session_org.reason, '在线');
  const bad = { ok: false, code: 'session_org', message: '会话账号切换有要人看的问题' };
  const w = judge({ status: 503, body: report(false, { ...allOk, session_org: bad }) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).session_org.reason, '会话账号切换有要人看的问题（session_org）');
});

test('GitHub 机器人权限（github_app）：显示成「GitHub 机器人权限」；有要人看的问题照实报红', () => {
  const v = judge({ status: 200, body: report(true, { ...allOk, github_app: { ok: true } }) });
  assert.equal(v.ok, true);
  assert.equal(byKey(v).github_app.label, 'GitHub 机器人权限');
  assert.equal(byKey(v).github_app.reason, '在线');
  const bad = { ok: false, code: 'github_app', message: 'GitHub 机器人的权限有要人看的问题' };
  const w = judge({ status: 503, body: report(false, { ...allOk, github_app: bad }) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).github_app.reason, 'GitHub 机器人的权限有要人看的问题（github_app）');
});

test('看门狗（watchdog）：显示成「看门狗」；跑完一轮写明几点、查了几个，停了照实报红、写明上次几点跑完', () => {
  const fine = { ok: true, message: '最近一轮 09-27 20:26 跑完：查了 7 个定时任务，都按期跑成' };
  const v = judge({ status: 200, body: report(true, { ...allOk, watchdog: fine }) });
  assert.equal(v.ok, true);
  assert.equal(byKey(v).watchdog.label, '看门狗');
  assert.equal(byKey(v).watchdog.reason, '在线：最近一轮 09-27 20:26 跑完：查了 7 个定时任务，都按期跑成');
  const stale = {
    ok: false,
    code: 'watchdog_stale',
    message: '看门狗 09-27 20:10 之后超过 15 分钟没跑完一轮',
  };
  const w = judge({ status: 503, body: report(false, { ...allOk, watchdog: stale }) });
  assert.equal(w.ok, false);
  assert.equal(byKey(w).watchdog.reason, '看门狗 09-27 20:10 之后超过 15 分钟没跑完一轮（watchdog_stale）');
});

test('连不上后端：三项都红，说出原因', () => {
  const v = judge({ error: 'Failed to fetch' });
  assert.equal(v.ok, false);
  assert.equal(v.summary, '连不上后端：Failed to fetch');
  assert.deepEqual(
    v.rows.map((r) => [r.key, r.ok, r.reason]),
    REQUIRED.map((r) => [r.key, false, '没拿到健康报告']),
  );
});

test('香港转不到法国（502、504）、后端没有这个接口（404）、别的状态码：都红', () => {
  assert.match(judge({ status: 502, body: '<html>Bad Gateway</html>' }).summary, /^HTTP 502：香港连不上法国/);
  assert.match(judge({ status: 504, body: '' }).summary, /^HTTP 504：香港等法国/);
  assert.match(
    judge({ status: 404, body: '{"error":"not_found"}' }).summary,
    /^HTTP 404：后端还没有健康检查接口/,
  );
  const limited = judge({ status: 429, body: '<html>Too Many Requests</html>' });
  assert.equal(limited.ok, false);
  assert.match(limited.summary, /^HTTP 429：这个地址刷得太勤/);
  const v = judge({ status: 500, body: report(true, allOk) });
  assert.equal(v.ok, false);
  assert.equal(v.summary, '后端回了 HTTP 500');
});

test('回的不是 JSON、或不是健康报告的样子：都红', () => {
  assert.equal(judge({ status: 200, body: '<html>ok</html>' }).summary, 'HTTP 200，但回的不是 JSON');
  for (const body of [
    '{}',
    '[]',
    'null',
    '{"ok":true}',
    '{"ok":"true","checks":{}}',
    '{"ok":true,"checks":[]}',
  ]) {
    const v = judge({ status: 200, body });
    assert.equal(v.ok, false, body);
    assert.equal(v.summary, 'HTTP 200，但回的不是健康报告（缺 ok 或 checks）', body);
  }
});

test('后端没报引擎工人（接真库那版的 /healthz 就是这样）：引擎工人红，其余照实显示', () => {
  const checks = {
    database: { ok: true },
    realtime: { ok: true },
    temporal: { ok: false, code: 'not_connected', message: 'Temporal 客户端还没接上' },
    github_events: { ok: true },
  };
  const v = judge({ status: 503, body: report(false, checks) });
  assert.equal(v.ok, false);
  assert.equal(v.summary, '2 项不在线');
  const rows = byKey(v);
  assert.equal(rows.database.ok, true);
  assert.equal(rows.temporal.reason, 'Temporal 客户端还没接上（not_connected）');
  assert.equal(rows.engine.ok, false);
  assert.equal(rows.engine.reason, '后端没报这一项');
  assert.equal(rows.realtime.label, '实时推送');
  assert.equal(rows.github_events.label, 'GitHub 事件');
});

test('开发模式的空报告（checks 为空）：三项都红，不因为 ok:true 就绿', () => {
  const v = judge({ status: 200, body: report(true, {}) });
  assert.equal(v.ok, false);
  assert.equal(v.summary, '3 项不在线');
  assert.deepEqual(
    v.rows.map((r) => r.reason),
    ['后端没报这一项', '后端没报这一项', '后端没报这一项'],
  );
});

test('单项的 ok 不是布尔值、或整项不是对象：认不出，报红', () => {
  const v = judge({
    status: 503,
    body: report(false, { database: { ok: 'true' }, temporal: 'up', engine: { ok: true } }),
  });
  const rows = byKey(v);
  assert.equal(rows.database.reason, '这一项的格式认不出');
  assert.equal(rows.temporal.reason, '这一项的格式认不出');
  assert.equal(rows.engine.ok, true);
  assert.equal(v.ok, false);
});

test('单项不好但没给原因：照样红，写明没给原因', () => {
  const v = judge({ status: 503, body: report(false, { ...allOk, database: { ok: false } }) });
  assert.equal(byKey(v).database.reason, '不在线（后端没给原因）');
});

test('自相矛盾的报告整体报红：200 却说不好、503 却说全好、总结论和逐项对不上', () => {
  const a = judge({
    status: 200,
    body: report(false, { ...allOk, temporal: { ok: false, code: 'x', message: 'y' } }),
  });
  assert.equal(a.ok, false);
  assert.match(a.summary, /^后端的报告自相矛盾：HTTP 200 却说不好/);

  const b = judge({ status: 503, body: report(true, allOk) });
  assert.equal(b.ok, false);
  assert.match(b.summary, /HTTP 503 却说全好/);

  const c = judge({
    status: 200,
    body: report(true, { ...allOk, database: { ok: false, code: 'down', message: '连不上' } }),
  });
  assert.equal(c.ok, false);
  assert.match(c.summary, /总结论是「全好」，逐项却有不好的/);
});

test('取数：网络错误、超时、读正文时断了，都变成 error，不抛', async () => {
  const refused = await fetchHealth(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.deepEqual(refused, { error: 'Failed to fetch' });

  const slow = await fetchHealth(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout 的计时器不挡进程退出（Node 22 实测：测试没等到它就被判「还在等」）：另挂一个兜底计时器撑住
        const guard = setTimeout(() => reject(new Error('兜底：超时信号没来')), 2000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(guard);
          reject(init.signal.reason);
        });
      }),
    20,
  );
  assert.deepEqual(slow, { error: '0.02 秒没回应' });

  const cut = await fetchHealth(async () => ({
    status: 200,
    text: async () => {
      throw new Error('连接被重置');
    },
  }));
  assert.deepEqual(cut, { error: '连接被重置' });
});

test('法国失联：页顶写「法国失联自 HH:MM」，总灯改红，行首多一条法国隧道', () => {
  const link = franceLinkLine({ down: true, downSinceText: '10:38', downSince: '1' });
  assert.equal(link?.reason, '法国失联自 10:38');
  assert.equal(link?.label, '法国隧道');
  assert.equal(link?.ok, false);
  const health = judge({ status: 200, body: report(true, allOk) });
  const v = applyFranceLink(health, link);
  assert.equal(v.ok, false);
  assert.equal(v.summary.startsWith('法国失联自 10:38。'), true);
  assert.equal(v.summary, '法国失联自 10:38。全部在线');
  assert.equal(v.rows[0]?.label, '法国隧道');
  assert.equal(v.rows[0]?.reason, '法国失联自 10:38');
  assert.equal(v.rows[1]?.key, 'database');
});

test('法国失联的时刻：downSinceText 优先；没有就用 epoch 或 ISO，按北京时间', () => {
  const epoch = Date.parse('2026-10-15T02:38:00Z') / 1000;
  assert.equal(franceLinkLine({ down: true, downSince: String(epoch) })?.reason, '法国失联自 10:38');
  assert.equal(franceLinkLine({ down: true, downSince: epoch })?.reason, '法国失联自 10:38');
  assert.equal(franceLinkLine({ down: true, downSince: '2026-10-15T02:38:00Z' })?.reason, '法国失联自 10:38');
});

test('还没失联、时刻认不出、文件没有：不改「全部在线」', () => {
  const health = judge({ status: 200, body: report(true, allOk) });
  for (const data of [
    null,
    { down: false, downSinceText: '10:38' },
    { down: 'true', downSinceText: '10:38' },
    { down: true, downSinceText: 'abc' },
    { down: true, downSince: '' },
    { down: true },
  ]) {
    assert.equal(franceLinkLine(data), null, JSON.stringify(data));
    const v = applyFranceLink(health, franceLinkLine(data));
    assert.equal(v.ok, true, JSON.stringify(data));
    assert.equal(v.summary, '全部在线');
    assert.equal(v.rows.some((r) => r.label === '法国隧道'), false);
  }
});

test('探活状态取数：404、坏 JSON、网络失败都是 null，不抛', async () => {
  const missing = await fetchFranceLink(async () => ({ ok: false, status: 404, text: async () => '' }));
  assert.equal(missing, null);
  const bad = await fetchFranceLink(async () => ({ ok: true, status: 200, text: async () => 'not-json' }));
  assert.equal(bad, null);
  const down = await fetchFranceLink(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(down, null);
  let seen;
  const got = await fetchFranceLink(async (url, init) => {
    seen = { url, cache: init.cache };
    return { ok: true, status: 200, text: async () => JSON.stringify({ down: true, downSinceText: '10:38' }) };
  });
  assert.deepEqual(seen, { url: '/health/france-link.json', cache: 'no-store' });
  assert.equal(got?.reason, '法国失联自 10:38');
});

test('取数：拿到回应就原样交给判定，状态码和正文都带上', async () => {
  let seen;
  const got = await fetchHealth(async (url, init) => {
    seen = { url, cache: init.cache };
    return { status: 503, text: async () => 'body' };
  });
  assert.deepEqual(seen, { url: '/healthz', cache: 'no-store' });
  assert.deepEqual(got, { status: 503, body: 'body' });
});
