// 健康页的判定（deploy/web/health/health.js）：只有后端明说在线的项才绿，其余每一种「没查成」都要报红。
// 跑法：node --test deploy/test/health-page.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchHealth, judge, REQUIRED } from '../web/health/health.js';

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

test('取数：拿到回应就原样交给判定，状态码和正文都带上', async () => {
  let seen;
  const got = await fetchHealth(async (url, init) => {
    seen = { url, cache: init.cache };
    return { status: 503, text: async () => 'body' };
  });
  assert.deepEqual(seen, { url: '/healthz', cache: 'no-store' });
  assert.deepEqual(got, { status: 503, body: 'body' });
});
