// 健康页的取数与判定（浏览器里的页面和 deploy/test/health-page.test.mjs 用的是这同一份）。
// 规矩：只有后端明说 ok 的项才算在线；连不上、超时、回的不是健康报告、缺项、结论和逐项对不上，一律报红，并说出是哪一种。
// /healthz 的样子（packages/api 的 health.ts）：{ ok, checks: { <项>: { ok: true } | { ok: true, message }
// | { ok: true, status: 'not_wired', message } | { ok: true, status: 'warning', code, message } | { ok: false, code, message } } }。
// 好的项可以带一句说明（看门狗几秒前跑过），写在「在线」后面；「未接」是功能还没做，不算不在线，照样显示出来（写明未接和原因）；
// 「警告」是要人去配的事（比如某个仓还没装 GitHub 机器人），不算不在线、不让总灯变红，但照样显示、总结里数出来；全好回 200，有一项不好回 503。香港 nginx 把 /healthz 经隧道转给法国的驾驶舱后端（deploy/hk/nginx-https.conf）。

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
  judge: '判断题',
  deploy_lag: '跟上主线',
  session_org: '会话账号切换',
  github_app: 'GitHub 机器人权限',
  watchdog: '看门狗',
};

export const HEALTH_URL = '/healthz';
/** 香港本机探法国的结果。文件没有、不是 JSON、或还没失联：不当成全站红。 */
export const FRANCE_LINK_URL = '/health/france-link.json';
export const TIMEOUT_MS = 8000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const warned = rows.filter((r) => r.warning).length;
  const notes = [
    ...(notWired > 0 ? [`${notWired} 项还没接上`] : []),
    ...(warned > 0 ? [`${warned} 项警告要人看`] : []),
  ];
  return { ok: true, summary: notes.length > 0 ? `全部在线（${notes.join('，')}）` : '全部在线', rows };
}

/**
 * 读香港本机的探活状态。404、坏 JSON、网络失败都返回 null，不抛：这一路坏了不能把健康页整页打红。
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<{ key: string, label: string, ok: false, reason: string } | null>}
 */
export async function fetchFranceLink(fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetchImpl(FRANCE_LINK_URL, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return franceLinkLine(JSON.parse(await res.text()));
  } catch {
    return null;
  }
}

/** 北京时间的 HH:MM。认不出返回 null。 */
function shanghaiHHMM(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hh = parts.find((p) => p.type === 'hour')?.value;
  const mm = parts.find((p) => p.type === 'minute')?.value;
  const text = hh && mm ? `${hh}:${mm}` : '';
  return HHMM.test(text) ? text : null;
}

/**
 * 状态文件里 down 不是 true、或时刻认不出：返回 null（页面不改）。
 * 时刻优先用 downSinceText（HH:MM）；否则 downSince 可以是 epoch 秒、epoch 毫秒，或 ISO 时间。
 * @param {unknown} data
 * @returns {{ key: string, label: string, ok: false, reason: string } | null}
 */
export function franceLinkLine(data) {
  if (!isObject(data) || data.down !== true) return null;
  let hhmm = null;
  if (typeof data.downSinceText === 'string' && HHMM.test(data.downSinceText)) hhmm = data.downSinceText;
  else if (typeof data.downSince === 'number' && data.downSince > 0) {
    hhmm = shanghaiHHMM(data.downSince > 1e12 ? data.downSince : data.downSince * 1000);
  } else if (typeof data.downSince === 'string' && data.downSince.trim()) {
    const raw = data.downSince.trim();
    if (/^[1-9][0-9]*$/.test(raw)) {
      const n = Number(raw);
      hhmm = shanghaiHHMM(n > 1e12 ? n : n * 1000);
    } else {
      hhmm = shanghaiHHMM(Date.parse(raw));
    }
  }
  if (!hhmm) return null;
  return { key: 'france_link', label: '法国隧道', ok: false, reason: `法国失联自 ${hhmm}` };
}

/**
 * 失联时总灯改红，总结前面加上「法国失联自 HH:MM。」，行首多一条「法国隧道」。
 * link 是 null 时原样返回（/healthz 自己的红绿不动）。
 * @param {{ ok: boolean, summary: string, rows: { key: string, label: string, ok: boolean, reason: string }[] }} verdict
 * @param {{ key: string, label: string, ok: false, reason: string } | null} link
 */
export function applyFranceLink(verdict, link) {
  if (!link) return verdict;
  return { ok: false, summary: `${link.reason}。${verdict.summary}`, rows: [link, ...verdict.rows] };
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
  // 「未接」必须样子完整（status 就是 not_wired、带一句原因）：带了 status 却认不出、缺原因，都不算绿
  if (check.ok === true && 'status' in check) {
    if (check.status === 'warning' && typeof check.message === 'string' && check.message.trim()) {
      return { key, label, ok: true, warning: true, reason: `警告：${check.message}` };
    }
    if (check.status !== 'not_wired' || typeof check.message !== 'string' || !check.message.trim()) {
      return { key, label, ok: false, reason: '这一项的格式认不出' };
    }
    return { key, label, ok: true, notWired: true, reason: `未接：${check.message}` };
  }
  if (check.ok === true) {
    const note = typeof check.message === 'string' ? check.message.trim() : '';
    return { key, label, ok: true, reason: note ? `在线：${note}` : '在线' };
  }
  const message =
    typeof check.message === 'string' && check.message ? check.message : '不在线（后端没给原因）';
  const code = typeof check.code === 'string' && check.code ? `（${check.code}）` : '';
  return { key, label, ok: false, reason: `${message}${code}` };
}
