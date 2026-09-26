// 健康页的取数与判定（浏览器里的页面和 deploy/test/health-page.test.mjs 用的是这同一份）。
// 规矩：只有后端明说 ok 的项才算在线；连不上、超时、回的不是健康报告、缺项、结论和逐项对不上，一律报红，并说出是哪一种。
// /healthz 的样子（packages/api 的 health.ts）：{ ok, checks: { <项>: { ok: true } | { ok: true, status: 'not_wired', message }
// | { ok: false, code, message } } }。「未接」是功能还没做，不算不在线，照样显示出来（写明未接和原因），
// 全好回 200，有一项不好回 503。香港 nginx 把 /healthz 经隧道转给法国的驾驶舱后端（deploy/hk/nginx-https.conf）。

/** P0 验收要看到的三项：法国的数据库、Temporal、引擎工人。后端没报的项照样列出来、报红。 */
export const REQUIRED = [
  { key: 'database', label: '数据库' },
  { key: 'temporal', label: 'Temporal' },
  { key: 'engine', label: '引擎工人' },
];

/** 后端多报的项用这些名字显示；认不出的照原名。 */
const EXTRA_LABELS = {
  realtime: '实时推送',
  github_events: 'GitHub 事件',
  draft_opener: '飞书草稿开单',
  draft_backlog: '待开单积压',
};

export const HEALTH_URL = '/healthz';
export const TIMEOUT_MS = 8000;

/**
 * 取一次健康报告。网络层的失败（连不上、超时、读正文时断了）都变成 { error }，不抛。
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<{ error: string } | { status: number, body: string }>}
 */
export async function fetchHealth(fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetchImpl(HEALTH_URL, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return { error: `${timeoutMs / 1000} 秒没回应` };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 把取数结果判成红绿。ok 只在「HTTP 200、后端说全好、必看的三项都明说在线、没有自相矛盾」时为 true。
 * @param {{ error: string } | { status: number, body: string }} fetched
 * @returns {{ ok: boolean, summary: string, rows: { key: string, label: string, ok: boolean, reason: string }[] }}
 */
export function judge(fetched) {
  if ('error' in fetched) return allRed(`连不上后端：${fetched.error}`);
  const { status, body } = fetched;
  if (status !== 200 && status !== 503) return allRed(describeStatus(status));
  let report;
  try {
    report = JSON.parse(body);
  } catch {
    return allRed(`HTTP ${status}，但回的不是 JSON`);
  }
  if (!isReport(report)) return allRed(`HTTP ${status}，但回的不是健康报告（缺 ok 或 checks）`);

  const rows = REQUIRED.map(({ key, label }) => row(key, label, report.checks[key]));
  for (const key of Object.keys(report.checks)) {
    if (REQUIRED.some((r) => r.key === key)) continue;
    rows.push(row(key, EXTRA_LABELS[key] ?? key, report.checks[key]));
  }

  // 后端自己的结论要和状态码、和它报的逐项一致；不一致说明报告本身不可信，整体报红
  const reportedAllOk = Object.values(report.checks).every((c) => isObject(c) && c.ok === true);
  const contradictions = [];
  if ((status === 200) !== (report.ok === true)) {
    contradictions.push(`HTTP ${status} 却说${report.ok === true ? '全好' : '不好'}`);
  }
  if (report.ok !== reportedAllOk) {
    contradictions.push(
      `总结论是「${report.ok ? '全好' : '不好'}」，逐项却${reportedAllOk ? '全好' : '有不好的'}`,
    );
  }
  const bad = rows.filter((r) => !r.ok).length;
  if (contradictions.length > 0) {
    return { ok: false, summary: `后端的报告自相矛盾：${contradictions.join('；')}`, rows };
  }
  if (bad > 0) return { ok: false, summary: `${bad} 项不在线`, rows };
  const notWired = rows.filter((r) => r.notWired).length;
  return { ok: true, summary: notWired > 0 ? `全部在线（${notWired} 项还没接上）` : '全部在线', rows };
}

function describeStatus(status) {
  if (status === 502) return 'HTTP 502：香港连不上法国的驾驶舱后端（后端没起，或隧道断了）';
  if (status === 504) return 'HTTP 504：香港等法国的驾驶舱后端超时（隧道断了，或后端卡住）';
  if (status === 404) return 'HTTP 404：后端还没有健康检查接口';
  if (status === 429) return 'HTTP 429：这个地址刷得太勤，香港限了流，稍后自动再查';
  return `后端回了 HTTP ${status}`;
}

function allRed(summary) {
  return {
    ok: false,
    summary,
    rows: REQUIRED.map(({ key, label }) => ({ key, label, ok: false, reason: '没拿到健康报告' })),
  };
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isReport(v) {
  return isObject(v) && typeof v.ok === 'boolean' && isObject(v.checks);
}

function row(key, label, check) {
  if (check === undefined) return { key, label, ok: false, reason: '后端没报这一项' };
  if (!isObject(check) || typeof check.ok !== 'boolean') {
    return { key, label, ok: false, reason: '这一项的格式认不出' };
  }
  if (check.ok === true && check.status === 'not_wired') {
    const why = typeof check.message === 'string' && check.message ? check.message : '后端没给原因';
    return { key, label, ok: true, notWired: true, reason: `未接：${why}` };
  }
  if (check.ok === true) return { key, label, ok: true, reason: '在线' };
  const message =
    typeof check.message === 'string' && check.message ? check.message : '不在线（后端没给原因）';
  const code = typeof check.code === 'string' && check.code ? `（${check.code}）` : '';
  return { key, label, ok: false, reason: `${message}${code}` };
}
