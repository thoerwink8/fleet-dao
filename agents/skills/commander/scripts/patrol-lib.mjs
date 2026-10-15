// 法国只读巡查（决定 0034，#1372）：无人值守时指挥官每个监控周期跑一次 patrol.mjs，只读最后一行 VERDICT。
// 监控的主体是这份脚本，不是模型：采集、比基线、判不变量、沉默告警都在这里判；模型只在 ALERT 且有变化时才被叫来摘证据。
// 复用 france-lib.mjs 的 ssh 名字读法（readTarget）、ssh 参数（sshArgs）、起 ssh 收输出（runRemote）、抹字（scrubText）。
// 改这里之前必须知道：
// - 只读：法国上跑的是一段 sh（REMOTE_SCRIPT，从标准输入喂给 `sh -s`），库连接带 default_transaction_read_only=on，
//   agents/test/patrol.test.ts 扫这段脚本钉住不写库、不改文件。
// - 读不成一律 BROKEN，不当 OK：ssh 连不上、输出是空的、少了哪一块、有认不出的行、库查询报错、采集时间和本机差超过
//   STALE_MINUTES 分钟。
// - 发版和健康页也读（2026-10-14 法国发版失败，巡检还报 OK 近一小时）：/healthz 非 200、最近一次发版是 unhealthy / auto-rollback、发版进度记录停在
//   failed / blocked 这类收了尾却没成的状态或 running 超过 LIMITS.trainStuckMinutes（trainReason）、自动发布状态里写着「要人看」，一律 BROKEN（列出红的检查）；
//   running 没超时是一趟正常发版在走（自动发版每 5 分钟一班），不报。闸在 running 时写「有一趟发版在跑，等它收尾」，不含「要人看」；在用版本落后主线超过 LIMITS.lagCommits 个提交
//   且最老的那个落下超过 LIMITS.lagMinutes 分钟是 ALERT；这几块读不到、认不出也是 BROKEN。
// - 飞书推送通不通（push 那一块）：判法照 packages/db/src/queries/feishu-push.ts 的 feishuPushProblem 写（这份脚本在仓外跑、
//   引不了那边的代码，改那边要一起改这里的 SQL）。推送渠道自己坏了靠推送报不出来，这里每次巡查都看一次，不只靠「新通知」。
// - 今天的每日简报送到没（brief 那一块）：判法照 packages/db/src/queries/daily-brief.ts 的 dailyBriefProblem 写（09:00 以后没跑、没做成、
//   没建、没推到飞书都是 ALERT），同样改那边要一起改这里。
// - 基线只由这份脚本写（模型不写）：OK、ALERT 都把这一次的读数写成新基线，BROKEN 不写（不拿坏读数盖掉好基线）。
// - 读不到法国（ssh 没读成、输出空、解析失败、采集时间和本机差太多，facts 是空的）：VERDICT 前多一行显眼中文，
//   写明读不到的原因，并指向香港状态页（上面有「法国失联自 xx:xx」）。法国答了、只是盘面不对（healthz 503、发版 unhealthy）不加这一行。
// - 最后一行永远是 `VERDICT: OK`、`VERDICT: ALERT <条数>` 或 `VERDICT: BROKEN`；退出码 0、1、2 与之对应。
import { readTarget, runRemote, scrubText, sshArgs } from './france-lib.mjs';

/** @typedef {{ ok: false, kind: string, why: string }} Failure 没做成：kind 同 france-lib；why 给人看 */
/** @typedef {{ n: number, repo: string, state: string, phase: string, minutes: number, doing: string }} TaskFact 一张没做完的单 */
/** @typedef {{ job: string, outcome: string, minutes: number, why: string }} JobFact 最近一次跑完不是 ok 的定时任务 */
/** @typedef {{ key: string, title: string, level?: string }} NoteFact 一条开着的通知（不含提醒类）；level 是 decision | alert | daily（老基线里没有） */
/** @typedef {{ code: number, red: string[] }} HealthzFact /healthz 的状态码（连不上是 0）和红的检查名 */
/** @typedef {{ at: string, sha: string, event: string }} HistoryFact 发布历史（.history）的一条 */
/** @typedef {{ known: boolean, behind: number, minutes: number }} LagFact 在用版本落后主线几个提交、最老的落下几分钟（known=false：在用的不在主线最近的提交里） */
/**
 * 飞书推送：status 是后端记的推送状态（none 没记过、on 配好了、off 没配）；why 是没配的原因；staleMinutes 是该推还没送到的最老一条
 * 到点了多少分钟（没有是 -1）；undelivered 该推没送到几条；lastOkMinutes 最近一次送到是多少分钟前（从没送到过是 -1）。
 * @typedef {{ status: 'none' | 'on' | 'off', why: string, staleMinutes: number, undelivered: number, lastOkMinutes: number }} PushFact
 */
/**
 * 每日简报：day 是北京日期；minutes 是离今天 08:30（北京时间）过了几分钟（没到是负数）；outcome 是今天最近一轮的结局
 * （none 一轮都没起、running 还在跑）；made 今天那一行建了没有；delivered 推到飞书没有；attempts 试了几次；why 没做成的原因。
 * @typedef {{ day: string, minutes: number, outcome: string, made: boolean, delivered: boolean, attempts: number, why: string }} BriefFact
 */
/**
 * 一次巡查读到的。at 是法国的采集时间（ISO）。
 * healthz、history、trainStatus、trainSince、trainSha、autoNote、lag 是发版和健康页（老基线里没有这几项，只有判当前读数用到）。
 * trainSince 是这一趟的起点（进度记录的 startedAt，没有用 updatedAt；老格式都没有是 ''），trainSha 是这一趟发的提交（target.value，没有是 ''）；
 * currentSha 是法国 current 指向的完整提交号（读不到是 ''）。
 * @typedef {{ at: string, release: string, healthz: HealthzFact, history: HistoryFact[], trainStatus: string, trainSince?: string, trainSha?: string, currentSha?: string, autoNote: string, lag: LagFact, services: Record<string, string>, diskPct: number, memMb: number, load: number, master: string, tasks: TaskFact[], jobs: JobFact[], notesOpen: number, notes: NoteFact[], push: PushFact, brief: BriefFact }} Facts
 */
/** @typedef {'OK' | 'ALERT' | 'BROKEN'} Verdict */
/** @typedef {{ verdict: Verdict, facts: Facts | null, alerts: string[], delta: string[], broken: string | null, notes: string[] }} Report */

/** 采集时间和本机差超过这么多分钟：当成没读成（沉默告警）。 */
export const STALE_MINUTES = 15;
/** 不变量的线。 */
export const LIMITS = {
  /** 根分区用到这个百分比以上 */
  diskPct: 85,
  /** 可用内存少于这么多 MB */
  memMinMb: 1024,
  /** 单卡住（stalled）或停下等人（phase=parked）超过这么多分钟 */
  stuckMinutes: 30,
  /** 在用版本落后主线超过这么多个提交…… */
  lagCommits: 5,
  /** ……而且最老的那个没发的提交落下超过这么多分钟，才报（刚合进去的几个不算落后）。 */
  lagMinutes: 60,
  /** 该推的到点超过这么多分钟没送到、这段时间里一条都没送成：飞书推送不通（同 feishu-push.ts 的 FEISHU_PUSH_STALE_MS） */
  pushStaleMinutes: 60,
  /** 今天的每日简报到 08:30 以后过这么多分钟还没送到才报（同 daily-brief.ts 的 DAILY_BRIEF_GRACE_MINUTES） */
  briefGraceMinutes: 30,
  /**
   * 发版进度记录停在 running 超过这么多分钟（从 startedAt 算）才算卡住。和引擎看门狗同一个数、同一判法：
   * packages/engine/src/jobs/release-watch.ts 的 TRAIN_STUCK_MS / trainVerdict（依据写在那边：发版接活脚本各步上限加起来 69 分钟，
   * 到上限它自己写成没成；过了还 running 只能是驱动没了）。这份在仓外跑、引不了那边；两边的测试各自钉它落在 LIMITS 各步加起来到多 5 分钟之间。
   */
  trainStuckMinutes: 70,
};
/** 发布历史最近一条是这些事件：这一版没发成，或退回了。 */
export const BAD_RELEASE_EVENTS = ['unhealthy', 'auto-rollback'];
/** 驾驶舱接口（deploy/release.sh 的 COCKPIT）。 */
export const COCKPIT_HEALTHZ = 'http://10.99.0.2:8787/healthz';
/** 发布目录（法国）。 */
const RELEASES = '/srv/fleet-dao-releases';
/** 要 active 的服务。 */
export const SERVICES = ['fleet-api', 'fleet-engine'];
/** 库查询那几块：每块跑完打 ok|<块>，报错打 ERR|<块>|<原因>。 */
/** notifications.level 的取值（packages/db/src/schema/enums.ts notificationLevel）。 */
const NOTE_LEVELS = new Set(['decision', 'alert', 'daily']);

export const DB_BLOCKS = ['master', 'tasks', 'jobs', 'notecount', 'notes', 'push', 'brief'];
/** 远端命令：脚本从标准输入喂。 */
export const PATROL_REMOTE_COMMAND = 'sh -s';
/** 基线默认放在仓根 _tmp/（指挥官在主检出里跑）。 */
export const DEFAULT_BASELINE = '_tmp/patrol-baseline.json';
export const BASELINE_SCHEMA = 1;

const NO_NEWLINE = "E'\\n'";
/**
 * 「该推」的 SQL（同 feishu-push.ts 的 pushableSince）：没处理、24 小时内建的；要你拍、每日简报（feishu:brief:）、推送测试（feishu:test:）马上推；
 * 卡住报警（再提醒 remind:、路由疑似降智 probe-iq: 除外）开满 120 分钟、主线红（feishu:main-red:）开满 60 分钟没撤才推；
 * 主线已恢复只在它之前 24 小时内真推出去过主线红才推；
 * 其余不推。值是从什么时候起该推，不该推是 null。
 */
const PUSHABLE_SINCE = [
  'case',
  "when starts_with(n.dedupe_key, 'feishu:brief:') or starts_with(n.dedupe_key, 'feishu:test:') then n.created_at",
  "when n.level = 'decision' then n.created_at",
  "when starts_with(n.dedupe_key, 'feishu:main-red:') then n.created_at + interval '60 minutes'",
  "when starts_with(n.dedupe_key, 'feishu:main-recovered:') then case when exists (select 1 from notifications red join notification_deliveries rd on rd.notification_id = red.id and rd.channel = 'feishu' and rd.delivered_at is not null where starts_with(red.dedupe_key, 'feishu:main-red:') and red.created_at < n.created_at and red.created_at >= n.created_at - interval '24 hours') then n.created_at else null end",
  "when n.level = 'alert' and not starts_with(n.dedupe_key, 'remind:') and not starts_with(n.dedupe_key, 'probe-iq:') then n.created_at + interval '120 minutes'",
  'else null end',
].join(' ');
/** 推送那一块：一行 push|状态|没配的原因|最老一条到点几分钟|该推没送到几条|最近一次送到几分钟前。 */
const PUSH_SQL = [
  "select 'push',",
  "coalesce((select case when (value->>'configured')::boolean then 'on' else 'off' end from settings where key = 'feishu.push'), 'none'),",
  `replace(replace(coalesce((select value->>'why' from settings where key = 'feishu.push'), ''), '|', '/'), ${NO_NEWLINE}, ' '),`,
  'coalesce(floor(extract(epoch from now() - min(s.since)) / 60)::int, -1),',
  'count(s.since),',
  "coalesce((select floor(extract(epoch from now() - max(d.delivered_at)) / 60)::int from notification_deliveries d where d.channel = 'feishu' and d.delivered_at is not null), -1)",
  `from (select ${PUSHABLE_SINCE} as since from notifications n`,
  "left join notification_deliveries d on d.notification_id = n.id and d.channel = 'feishu' and d.target = 'team'",
  "where n.resolved_at is null and n.created_at >= now() - interval '24 hours' and d.delivered_at is null) s",
  'where s.since is not null and s.since <= now()',
].join(' ');
/** 北京时间今天零点（timestamptz）。 */
const BJ_TODAY = "((now() at time zone 'Asia/Shanghai')::date::timestamp at time zone 'Asia/Shanghai')";
/** 简报那一块：一行 brief|北京日期|离 08:30 几分钟|今天最近一轮结局|建了没有|送到没有|试了几次|没做成的原因。 */
const BRIEF_SQL = [
  "select 'brief', (now() at time zone 'Asia/Shanghai')::date,",
  `floor(extract(epoch from now() - (${BJ_TODAY} + interval '8 hours 30 minutes')) / 60)::int,`,
  `coalesce((select coalesce(r.outcome::text, 'running') from schedule_runs r where r.job = 'daily-brief' and r.started_at >= ${BJ_TODAY} order by r.started_at desc, r.id desc limit 1), 'none'),`,
  'case when b.id is null then 0 else 1 end, case when d.delivered_at is null then 0 else 1 end, coalesce(d.attempts, 0),',
  `replace(replace(left(coalesce((select r.why from schedule_runs r where r.job = 'daily-brief' and r.started_at >= ${BJ_TODAY} order by r.started_at desc, r.id desc limit 1), ''), 200), '|', '/'), ${NO_NEWLINE}, ' ')`,
  "from (select 1) one left join notifications b on b.dedupe_key = 'feishu:brief:' || ((now() at time zone 'Asia/Shanghai')::date)::text",
  "left join notification_deliveries d on d.notification_id = b.id and d.channel = 'feishu' and d.target = 'team'",
].join(' ');
/**
 * 在法国上跑的那段 sh。每行一项，用「|」分隔；最后一行是 end（没有 end 就是被截断了）。
 * 只读：systemctl is-active、df、free、/proc/loadavg、只读事务里的 select。
 */
export const REMOTE_SCRIPT = [
  'set -u',
  `CONN="dbname=fleet options='-c default_transaction_read_only=on'"`,
  'q() {',
  `  if out=$(runuser -u fleet -- psql "$CONN" -X -q -At -F '|' -v ON_ERROR_STOP=1 -c "$2" 2>&1); then`,
  `    [ -n "$out" ] && printf '%s\\n' "$out"`,
  '    echo "ok|$1"',
  '  else',
  `    echo "ERR|$1|$(printf '%s' "$out" | tail -n 1 | tr '|' '/')"`,
  '  fi',
  '}',
  'echo "at|$(date +%s)"',
  // 发版和健康页（只读：curl 一个 GET、读发布目录里的几个文件）
  `hz=$(curl -s -m 10 -w '\\n%{http_code}' ${COCKPIT_HEALTHZ} 2>&1)`,
  `hzcode=$(printf '%s' "$hz" | tail -n 1 | tr -cd '0-9')`,
  `hzred=$(printf '%s' "$hz" | grep -o '"[A-Za-z0-9_]*":{"ok":false' | cut -d'"' -f2 | paste -sd, -)`,
  'echo "healthz|${hzcode:-000}|$hzred"',
  `echo "cur|$(basename "$(readlink -f ${RELEASES}/current)")"`,
  `if [ -r ${RELEASES}/.history ]; then tail -n 3 ${RELEASES}/.history | while read -r a b c rest; do echo "hist|$a|$b|$c"; done; else echo "hist|-|-|-"; fi`,
  `if [ -r ${RELEASES}/.train/release-train.json ]; then printf 'train|%s\\n' "$(tr -d '[:space:]' < ${RELEASES}/.train/release-train.json)"; else echo "train|-"; fi`,
  `if [ -r ${RELEASES}/.auto/state.json ]; then printf 'state|%s\\n' "$(tr -d '[:space:]' < ${RELEASES}/.auto/state.json)"; else echo "state|-"; fi`,
  'echo "release|$(basename "$(readlink -f /srv/fleet-dao-releases/current)" | cut -c1-8)"',
  `for u in ${SERVICES.join(' ')}; do echo "svc|$u|$(systemctl is-active "$u")"; done`,
  `echo "disk|$(df -P / | awk 'NR==2{sub("%","",$5); print $5}')"`,
  `echo "mem|$(free -m | awk 'NR==2{print $7}')"`,
  `echo "load|$(cut -d' ' -f1 /proc/loadavg)"`,
  `q master "select 'master', coalesce((select value::text from settings where key = 'engine.master'), 'none')"`,
  `q tasks "select 'task', t.issue_number, r.name, t.state, coalesce(t.phase, ''), floor(extract(epoch from now() - coalesce(t.updated_at, t.created_at)) / 60)::int, replace(left(coalesce(t.doing, ''), 80), ${NO_NEWLINE}, ' ') from tasks t join repos r on r.id = t.repo_id where t.state not in ('done', 'stopped', 'failed', 'queued') order by t.issue_number"`,
  `q jobs "select 'job', r.job, r.outcome, floor(extract(epoch from now() - coalesce(r.ended_at, r.started_at)) / 60)::int, replace(left(coalesce(r.why, ''), 100), ${NO_NEWLINE}, ' ') from schedule_runs r join scheduled_jobs j on j.id = r.job and j.removed_at is null where r.id in (select max(id) from schedule_runs where outcome is not null group by job) and r.outcome not in ('ok', 'partial') order by r.job"`,
  `q notecount "select 'notes', count(*) from notifications where resolved_at is null and dedupe_key not like 'remind:%'"`,
  `q notes "select 'note', level, left(dedupe_key, 80), replace(left(title, 100), ${NO_NEWLINE}, ' ') from notifications where resolved_at is null and dedupe_key not like 'remind:%' order by id desc limit 50"`,
  `q push "${PUSH_SQL}"`,
  `q brief "${BRIEF_SQL}"`,
  'echo end',
  '',
].join('\n');

/** @param {string} s */
const isInt = (s) => /^-?\d+$/.test(s);
/** @param {string} s */
const isNum = (s) => /^-?\d+(?:\.\d+)?$/.test(s);
/** @param {string} line */
const shown = (line) => scrubText(line.length > 80 ? `${line.slice(0, 80)}…` : line);

/**
 * 发版进度记录、自动发布状态（法国打回来的是去掉空白的原 JSON；不在是 '-'）→ 进度状态、自动发布的话、落后几个提交。
 * 进度记录在但认不出、状态文件不在或认不出（拿不到主线提交，落后算不出）都回失败，不拿空顶。
 * @param {string} train
 * @param {string} state
 * @param {string} cur 在用的完整提交号
 * @param {string} at 法国采集时间（ISO）
 * @returns {{ ok: true, trainStatus: string, trainSince: string, trainSha: string, autoNote: string, lag: LagFact } | { ok: false, why: string }}
 */
function releaseFacts(train, state, cur, at) {
  let trainStatus = '';
  let trainSince = '';
  let trainSha = '';
  if (train !== '-') {
    try {
      const t = JSON.parse(train);
      if (typeof t?.status !== 'string')
        return { ok: false, why: '发版进度记录（release-train.json）认不出：没有 status' };
      trainStatus = t.status;
      // 同 packages/engine/src/real/watchdog.ts 的 readReleaseFacts：startedAt，没有用 updatedAt；老格式缺着是 ''
      const since = typeof t.startedAt === 'string' ? t.startedAt : t.updatedAt;
      trainSince = typeof since === 'string' ? since : '';
      trainSha = typeof t.target?.value === 'string' ? t.target.value : '';
    } catch (e) {
      return {
        ok: false,
        why: `发版进度记录（release-train.json）不是 JSON：${shown(String(e instanceof Error ? e.message : e))}`,
      };
    }
  }
  if (state === '-')
    return { ok: false, why: '自动发布的状态文件（.auto/state.json）读不到：落后主线几个提交算不出' };
  let st;
  try {
    st = JSON.parse(state);
  } catch (e) {
    return {
      ok: false,
      why: `自动发布的状态文件不是 JSON：${shown(String(e instanceof Error ? e.message : e))}`,
    };
  }
  const commits = st?.main?.commits;
  if (
    !Array.isArray(commits) ||
    commits.length === 0 ||
    !commits.every((c) => Array.isArray(c) && typeof c[0] === 'string' && !Number.isNaN(Date.parse(c[1])))
  )
    return { ok: false, why: '自动发布的状态文件里没有主线提交列表（main.commits）：落后主线几个提交算不出' };
  const autoNote = typeof st?.auto?.note === 'string' ? scrubText(st.auto.note) : '';
  const idx = commits.findIndex((c) => c[0] === cur);
  if (idx < 0)
    return {
      ok: true,
      trainStatus,
      trainSince,
      trainSha,
      autoNote,
      lag: { known: false, behind: commits.length, minutes: 0 },
    };
  const minutes =
    idx === 0 ? 0 : Math.max(0, Math.floor((Date.parse(at) - Date.parse(commits[idx - 1][1])) / 60_000));
  return {
    ok: true,
    trainStatus,
    trainSince,
    trainSha,
    autoNote,
    lag: { known: true, behind: idx, minutes },
  };
}

/**
 * 认法国回来的那一屏。成功 { ok: true, facts }；认不出、少了块、库查询报错都回 { ok: false, why }，不拿空顶。
 * @param {string} text
 * @returns {{ ok: true, facts: Facts } | { ok: false, why: string }}
 */
export function parseRaw(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return { ok: false, why: '法国回来的是空的（ssh 没打出任何东西）' };
  if (lines[lines.length - 1] !== 'end')
    return { ok: false, why: '法国回来的没有结尾那行 end（被截断了，或脚本中途停了）' };
  /** @type {Record<string, string>} */
  const services = {};
  /** @type {TaskFact[]} */
  const tasks = [];
  /** @type {JobFact[]} */
  const jobs = [];
  /** @type {NoteFact[]} */
  const notes = [];
  /** @type {Set<string>} */
  const blocksOk = new Set();
  /** @type {{ at?: string, release?: string, diskPct?: number, memMb?: number, load?: number, master?: string, notesOpen?: number, healthz?: HealthzFact, cur?: string, train?: string, state?: string, push?: PushFact, brief?: BriefFact }} */
  const one = {};
  /** @type {HistoryFact[]} */
  const history = [];
  let histMissing = false;
  for (const line of lines.slice(0, -1)) {
    const p = line.split('|');
    const kind = p[0];
    // 整行后半是一整块原文（可能带「|」）的几种：只按第一个「|」切
    const rest = line.slice(line.indexOf('|') + 1);
    if (kind === 'ERR')
      return { ok: false, why: `库查询「${p[1] ?? '?'}」报错：${shown(p.slice(2).join('|'))}` };
    if (kind === 'ok' && p.length === 2 && DB_BLOCKS.includes(p[1] ?? '')) blocksOk.add(p[1] ?? '');
    else if (kind === 'at' && p.length === 2 && isInt(p[1] ?? ''))
      one.at = new Date(Number(p[1]) * 1000).toISOString();
    else if (kind === 'release' && p.length === 2) one.release = p[1] ?? '';
    else if (kind === 'svc' && p.length === 3) services[p[1] ?? ''] = p[2] ?? '';
    else if (kind === 'disk' && p.length === 2 && isInt(p[1] ?? '')) one.diskPct = Number(p[1]);
    else if (kind === 'mem' && p.length === 2 && isInt(p[1] ?? '')) one.memMb = Number(p[1]);
    else if (kind === 'load' && p.length === 2 && isNum(p[1] ?? '')) one.load = Number(p[1]);
    else if (kind === 'healthz' && p.length === 3 && isInt(p[1] ?? ''))
      one.healthz = { code: Number(p[1]), red: (p[2] ?? '').split(',').filter((x) => x !== '') };
    else if (kind === 'cur' && p.length === 2) one.cur = p[1] ?? '';
    else if (kind === 'hist' && p.length === 4) {
      if (p[1] === '-') histMissing = true;
      else history.push({ at: p[1] ?? '', sha: p[2] ?? '', event: p[3] ?? '' });
    } else if (kind === 'train' && line.includes('|')) one.train = rest;
    else if (kind === 'state' && line.includes('|')) one.state = rest;
    else if (kind === 'master' && p.length === 2) one.master = p[1] ?? '';
    else if (kind === 'notes' && p.length === 2 && isInt(p[1] ?? '')) one.notesOpen = Number(p[1]);
    else if (kind === 'task' && p.length >= 7 && isInt(p[1] ?? '') && isInt(p[5] ?? ''))
      tasks.push({
        n: Number(p[1]),
        repo: p[2] ?? '',
        state: p[3] ?? '',
        phase: p[4] ?? '',
        minutes: Number(p[5]),
        doing: scrubText(p.slice(6).join('|')),
      });
    else if (kind === 'job' && p.length >= 5 && isInt(p[3] ?? ''))
      jobs.push({
        job: p[1] ?? '',
        outcome: p[2] ?? '',
        minutes: Number(p[3]),
        why: scrubText(p.slice(4).join('|')),
      });
    else if (
      kind === 'push' &&
      p.length === 6 &&
      ['none', 'on', 'off'].includes(p[1] ?? '') &&
      isInt(p[3] ?? '') &&
      isInt(p[4] ?? '') &&
      isInt(p[5] ?? '')
    )
      one.push = {
        status: /** @type {PushFact['status']} */ (p[1]),
        why: scrubText(p[2] ?? ''),
        staleMinutes: Number(p[3]),
        undelivered: Number(p[4]),
        lastOkMinutes: Number(p[5]),
      };
    else if (
      kind === 'brief' &&
      p.length >= 8 &&
      /^\d{4}-\d{2}-\d{2}$/.test(p[1] ?? '') &&
      /^-?\d+$/.test(p[2] ?? '') &&
      ['0', '1'].includes(p[4] ?? '') &&
      ['0', '1'].includes(p[5] ?? '') &&
      isInt(p[6] ?? '')
    )
      one.brief = {
        day: p[1] ?? '',
        minutes: Number(p[2]),
        outcome: p[3] ?? '',
        made: p[4] === '1',
        delivered: p[5] === '1',
        attempts: Number(p[6]),
        why: scrubText(p.slice(7).join('|')),
      };
    else if (kind === 'note' && p.length >= 4 && NOTE_LEVELS.has(p[1] ?? ''))
      notes.push({ level: p[1] ?? '', key: scrubText(p[2] ?? ''), title: scrubText(p.slice(3).join('|')) });
    else return { ok: false, why: `认不出这一行：${shown(line)}` };
  }
  /** @type {string[]} */
  const missing = [];
  for (const k of [
    'at',
    'release',
    'diskPct',
    'memMb',
    'load',
    'master',
    'notesOpen',
    'healthz',
    'cur',
    'train',
    'state',
    'push',
    'brief',
  ])
    if (!(k in one)) missing.push(k);
  if (histMissing || history.length === 0) missing.push('发布历史 .history（读不到或是空的）');
  for (const u of SERVICES) if (!(u in services)) missing.push(`svc ${u}`);
  for (const b of DB_BLOCKS) if (!blocksOk.has(b)) missing.push(`库查询 ${b}`);
  if (missing.length > 0) return { ok: false, why: `法国回来的少了：${missing.join('、')}` };
  const rel = releaseFacts(one.train ?? '-', one.state ?? '-', one.cur ?? '', one.at ?? '');
  if (!rel.ok) return { ok: false, why: rel.why };
  return {
    ok: true,
    facts: {
      at: one.at ?? '',
      release: one.release ?? '',
      healthz: one.healthz ?? { code: 0, red: [] },
      history: history.slice(-3),
      trainStatus: rel.trainStatus,
      trainSince: rel.trainSince,
      trainSha: rel.trainSha,
      currentSha: one.cur ?? '',
      autoNote: rel.autoNote,
      lag: rel.lag,
      services,
      diskPct: one.diskPct ?? 0,
      memMb: one.memMb ?? 0,
      load: one.load ?? 0,
      master: one.master ?? '',
      tasks,
      jobs,
      notesOpen: one.notesOpen ?? 0,
      notes,
      push: one.push ?? { status: 'none', why: '', staleMinutes: -1, undelivered: 0, lastOkMinutes: -1 },
      brief: one.brief ?? {
        day: '',
        minutes: -1,
        outcome: 'none',
        made: false,
        delivered: false,
        attempts: 0,
        why: '',
      },
    },
  };
}

/**
 * 飞书推送不通（同 feishu-push.ts 的 feishuPushProblem）：后端记了没配；或该推的到点超过 60 分钟没送到、最近 60 分钟一条都没送成。
 * 比那边多一条：后端从没记过推送状态也报（巡查只看法国这一台正式环境；引擎的看门狗各环境都跑，开发环境不推，那边不报这条）。
 * 回一句话，通着回 null。
 * @param {PushFact} p
 */
export function pushProblem(p) {
  if (p.status === 'off') return `飞书推送没配：${p.why || '后端没说缺什么'}`;
  // 法国是正式环境，后端起来就记推送状态；一直没有这一行 = 后端没在推（2026-10-05 推送整条被删就是这个样子，断了 9 天）
  if (p.status === 'none') return '飞书推送没在跑：后端从没记过推送状态（设置 feishu.push 没有）';
  if (p.staleMinutes < LIMITS.pushStaleMinutes) return null;
  if (p.lastOkMinutes >= 0 && p.lastOkMinutes < LIMITS.pushStaleMinutes) return null;
  const last = p.lastOkMinutes < 0 ? '从没送到过' : `最近一次送到是 ${p.lastOkMinutes} 分钟前`;
  return `飞书推送不通：${p.undelivered} 条该推的没送到，最老的到点 ${p.staleMinutes} 分钟了，${last}`;
}

/**
 * 今天的每日简报没送到（同 daily-brief.ts 的 dailyBriefProblem）：08:30 过了 30 分钟以后，今天一轮都没起、没做成、那一行没建、没推到飞书。
 * 回一句话，好着或还没到点回 null。
 * @param {BriefFact} b
 */
export function briefProblem(b) {
  if (b.minutes < LIMITS.briefGraceMinutes) return null;
  if (b.outcome === 'none')
    return `今天（${b.day}）08:30 的每日简报没跑：定时任务 daily-brief 今天一轮都没起`;
  if (b.outcome === 'running') return null;
  if (b.outcome === 'failed') return `今天（${b.day}）的每日简报没做成：${b.why || '没写原因'}`;
  if (!b.made) return `今天（${b.day}）的每日简报没建出来`;
  if (!b.delivered) return `今天（${b.day}）的每日简报没推到飞书：试了 ${b.attempts} 次`;
  return null;
}

/** @param {TaskFact} t */
const isStuck = (t) => (t.state === 'stalled' || t.phase === 'parked') && t.minutes > LIMITS.stuckMinutes;
/** @param {TaskFact} t */
const taskWord = (t) => `#${t.n}（${t.repo}）${t.state}${t.phase ? `/${t.phase}` : ''}`;

/** 发布历史里的一条，给人看。 */
const historyWord = (/** @type {HistoryFact} */ h) => `${h.event}（${h.sha.slice(0, 8)} ${h.at}）`;

/**
 * 发版进度记录这一项：'none' 没有或收尾成了（done / aborted）；'running' 正常在走（没到 LIMITS.trainStuckMinutes）；
 * 'stuck' 在走超时，或 running 却没有时间判不了多久（老格式，照旧算）；'stopped' 收了尾却没成（failed、blocked……）。
 * 「此刻」用法国的采集时间 f.at（和进度记录同一台机器的钟）。同 packages/engine/src/jobs/release-watch.ts 的 trainVerdict。
 * @param {Facts} f
 * @returns {'none' | 'running' | 'stuck' | 'stopped'}
 */
export function trainKind(f) {
  const s = f.trainStatus;
  if (s === '' || s === 'done' || s === 'aborted') return 'none';
  if (s !== 'running') return 'stopped';
  const since = Date.parse(f.trainSince ?? '');
  if (!Number.isFinite(since)) return 'stuck';
  return Date.parse(f.at) - since > LIMITS.trainStuckMinutes * 60_000 ? 'stuck' : 'running';
}

/**
 * 进度记录要人看的那一句（写明这一趟发的是哪个提交，不挂在上一版身上）；不用看是 null。
 * @param {Facts} f
 * @returns {string | null}
 */
export function trainReason(f) {
  const kind = trainKind(f);
  const sha = f.trainSha ? f.trainSha.slice(0, 12) : '（进度记录没写提交）';
  if (kind === 'stopped') return `发版进度记录停在「${f.trainStatus}」（这一趟发的是 ${sha}）`;
  if (kind !== 'stuck') return null;
  if (!Number.isFinite(Date.parse(f.trainSince ?? '')))
    return `发版进度记录停在「running」（这一趟发的是 ${sha}），记录里没有起止时间（老格式），判不了是不是还在正常走`;
  return `正在发 ${sha} 的这一趟从 ${f.trainSince} 起停在「running」，超过 ${LIMITS.trainStuckMinutes} 分钟没收尾（多半是驱动没了）`;
}

/**
 * 两个提交号是同一个（一边是另一边的前缀也算，至少 7 位）。同 packages/engine/src/jobs/release-watch.ts 的 sameCommit。
 * @param {string | undefined} a
 * @param {string | undefined} b
 */
function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * 这一趟已经落地：进度 done、法国 current 就是这一趟的目标提交。同 release-watch.ts 的 trainLanded。
 * @param {Facts} f
 */
export function trainLanded(f) {
  return f.trainStatus === 'done' && sameCommit(f.currentSha, f.trainSha);
}

/**
 * 判 BROKEN 的几条（出事了，不是「要留意」）：健康页不是 200（列出红的检查）、最近一次发版是 unhealthy / auto-rollback、
 * 发版进度记录收了尾却没成或 running 超时（trainReason）、自动发布的话里写着「要人看」。命中一条记一行；没有回空。
 * @param {Facts} f
 */
export function brokenReasons(f) {
  /** @type {string[]} */
  const out = [];
  if (f.healthz.code !== 200) {
    const reds = f.healthz.red.length > 0 ? `，红的检查：${f.healthz.red.join('、')}` : '';
    out.push(`/healthz 回 ${f.healthz.code === 0 ? '不出来（连不上）' : f.healthz.code}${reds}`);
  }
  const last = f.history.at(-1);
  // 末行「健康检查没过」说的就是已经落地的这个提交（没退回、停在这一版，接活脚本的发后体检过了）：旧话，不算（#2207）。
  // 同 release-watch.ts 的 badHistoryTail；auto-rollback 的末行是退回去的上一版，current 也不是目标，照算
  const superseded = last?.event === 'unhealthy' && trainLanded(f) && sameCommit(last.sha, f.currentSha);
  if (last && BAD_RELEASE_EVENTS.includes(last.event) && !superseded)
    out.push(`最近一次发版是 ${historyWord(last)}`);
  const train = trainReason(f);
  if (train) out.push(train);
  // 正文里写了「要人看」才算。闸在 running 时写的是「有一趟发版在跑，等它收尾」。
  if (f.autoNote.includes('要人看')) out.push(`自动发布处于「要人看」：${f.autoNote}`);
  return out;
}

/**
 * 不变量：命中一条记一行。新通知要有基线才判（没有基线的第一次只记基线），daily 级的只进变化不算命中。
 * @param {Facts} f
 * @param {Facts | null} base
 */
export function invariants(f, base) {
  /** @type {string[]} */
  const out = [];
  for (const u of SERVICES)
    if (f.services[u] !== 'active') out.push(`服务 ${u} 是 ${f.services[u] || '（空）'}`);
  if (!f.lag.known) out.push(`在用的版本不在主线最近 ${f.lag.behind} 个提交里（落后太多，或不是主线上的）`);
  else if (f.lag.behind > LIMITS.lagCommits && f.lag.minutes > LIMITS.lagMinutes)
    out.push(
      `在用的版本落后主线 ${f.lag.behind} 个提交，最老的没发的已落下 ${f.lag.minutes} 分钟（线：超过 ${LIMITS.lagCommits} 个且超过 ${LIMITS.lagMinutes} 分钟）`,
    );
  if (f.release === '') out.push('在用的版本没读到（/srv/fleet-dao-releases/current 指不到）');
  if (f.diskPct > LIMITS.diskPct) out.push(`磁盘 ${f.diskPct}% 超过 ${LIMITS.diskPct}%`);
  if (f.memMb < LIMITS.memMinMb) out.push(`可用内存 ${f.memMb}M 少于 ${LIMITS.memMinMb}M`);
  if (f.master !== 'true') out.push(`引擎总开关关着（engine.master 是 ${f.master}）`);
  for (const t of f.tasks.filter(isStuck))
    out.push(`单 ${taskWord(t)} 已 ${t.minutes} 分钟没动（超过 ${LIMITS.stuckMinutes}）：${t.doing}`);
  for (const j of f.jobs)
    out.push(`定时任务 ${j.job} 最近一次是 ${j.outcome}（${j.minutes} 分钟前）：${j.why}`);
  const push = pushProblem(f.push);
  if (push) out.push(push);
  const brief = briefProblem(f.brief);
  if (brief) out.push(brief);
  if (base) {
    const old = new Set(base.notes.map((n) => n.key));
    // daily（发版开始/成功、日报、新模型入目录）只进变化，不叫醒人：自动发版一晚十来班，算 ALERT 会把要人看的淹掉
    for (const n of f.notes)
      if (!old.has(n.key) && n.level !== 'daily') out.push(`新通知 ${n.key}：${n.title}`);
  }
  return out;
}

/**
 * 和基线比出变了什么（不比分钟数这类每次都变的）。没有基线回空。
 * @param {Facts} f
 * @param {Facts | null} base
 */
export function delta(f, base) {
  if (!base) return [];
  /** @type {string[]} */
  const out = [];
  if (f.release !== base.release) out.push(`~ 版本 ${base.release} → ${f.release}`);
  for (const u of SERVICES)
    if (f.services[u] !== base.services[u]) out.push(`~ 服务 ${u} ${base.services[u]} → ${f.services[u]}`);
  if (f.master !== base.master) out.push(`~ 总开关 ${base.master} → ${f.master}`);
  const oldTasks = new Map(base.tasks.map((t) => [t.n, t]));
  const newTasks = new Map(f.tasks.map((t) => [t.n, t]));
  for (const t of f.tasks) {
    const o = oldTasks.get(t.n);
    if (!o) out.push(`+ 单 ${taskWord(t)}`);
    else if (o.state !== t.state || o.phase !== t.phase)
      out.push(`~ 单 ${taskWord(o)} → ${t.state}${t.phase ? `/${t.phase}` : ''}`);
  }
  for (const o of base.tasks) if (!newTasks.has(o.n)) out.push(`- 单 ${taskWord(o)}`);
  const oldJobs = new Map(base.jobs.map((j) => [j.job, j]));
  const newJobs = new Set(f.jobs.map((j) => j.job));
  for (const j of f.jobs) {
    const o = oldJobs.get(j.job);
    if (!o) out.push(`+ 定时任务 ${j.job} ${j.outcome}`);
    else if (o.outcome !== j.outcome) out.push(`~ 定时任务 ${j.job} ${o.outcome} → ${j.outcome}`);
  }
  for (const o of base.jobs) if (!newJobs.has(o.job)) out.push(`- 定时任务 ${o.job}（恢复了）`);
  const oldNotes = new Set(base.notes.map((n) => n.key));
  const newNotes = new Set(f.notes.map((n) => n.key));
  for (const n of f.notes) if (!oldNotes.has(n.key)) out.push(`+ 通知 ${n.key}：${n.title}`);
  for (const n of base.notes) if (!newNotes.has(n.key)) out.push(`- 通知 ${n.key}`);
  return out;
}

/**
 * 判一次。raw 是 ssh 回来的结局；base 是上一次的基线（没有为 null）。
 * @param {{ raw: { ok: true, stdout: string } | Failure, now: Date, base: Facts | null }} input
 * @returns {Report}
 */
export function judge({ raw, now, base }) {
  /** @param {string} why @returns {Report} */
  const broken = (why) => ({ verdict: 'BROKEN', facts: null, alerts: [], delta: [], broken: why, notes: [] });
  if (!raw.ok) return broken(`ssh 没读成（${raw.kind}）：${raw.why}`);
  const parsed = parseRaw(raw.stdout);
  if (!parsed.ok) return broken(parsed.why);
  const f = parsed.facts;
  const skew = Math.abs(now.getTime() - Date.parse(f.at)) / 60_000;
  if (!(skew <= STALE_MINUTES))
    return broken(
      `采集时间 ${f.at} 和本机 ${now.toISOString()} 差 ${Math.round(skew)} 分钟，超过 ${STALE_MINUTES}`,
    );
  const alerts = invariants(f, base);
  const bad = brokenReasons(f);
  return {
    verdict: bad.length > 0 ? 'BROKEN' : alerts.length > 0 ? 'ALERT' : 'OK',
    facts: f,
    alerts,
    delta: delta(f, base),
    broken: bad.length > 0 ? bad.join('；') : null,
    notes: base ? [] : ['基线 没有：这一次的读数写成第一份基线，新通知从下一次起判'],
  };
}

/**
 * 读不到法国时插在 VERDICT 前的那一行。reason 用判出来的 broken。
 * @param {string} reason
 */
export function franceUnreadLine(reason) {
  return `！！！读不到法国：${reason}。法国上的看门狗、飞书推送、备份巡检和自动发布这时一起哑，不会有人来推。看香港状态页 https://<驾驶舱域名>/health/ ，有「法国失联自 xx:xx」就是隧道那头从那一刻起连不上。`;
}

/**
 * 打出来的样子：每项一行，带计数和采集时间；最后一行是 VERDICT。
 * 读不到法国（facts 是空的）时，VERDICT 前多一行显眼中文。
 * @param {Report} r
 * @returns {string[]}
 */
export function render(r) {
  if (!r.facts) {
    const why = r.broken ?? '没说为什么';
    return ['PATROL 法国 没读成', `BROKEN ${why}`, franceUnreadLine(why), 'VERDICT: BROKEN'];
  }
  const f = r.facts;
  const last = f.history.at(-1);
  const at = `@${f.at}`;
  const active = SERVICES.filter((u) => f.services[u] === 'active').length;
  const lines = [
    `PATROL 法国 采集于 ${f.at} 版本 ${f.release || '（没读到）'}`,
    `服务 ${active}/${SERVICES.length} active ${at}`,
    `资源 磁盘 ${f.diskPct}% 可用内存 ${f.memMb}M 负载 ${f.load} ${at}`,
    `总开关 ${f.master === 'true' ? '开着' : `关着（${f.master}）`} ${at}`,
    `单 ${f.tasks.length} 张没做完，卡住或停下超过 ${LIMITS.stuckMinutes} 分钟的 ${f.tasks.filter(isStuck).length} 张 ${at}`,
    `定时任务 最近一次不是 ok 的 ${f.jobs.length} 个 ${at}`,
    `健康页 /healthz ${f.healthz.code === 200 ? '200' : `${f.healthz.code === 0 ? '连不上' : f.healthz.code}（红的：${f.healthz.red.join('、') || '没列出'}）`} ${at}`,
    `发版 最近一次 ${last ? historyWord(last) : '（没有）'}，进度记录 ${f.trainStatus || '无'}${f.trainSha ? `（${f.trainSha.slice(0, 12)}）` : ''}，落后主线 ${f.lag.known ? f.lag.behind : '?'} 个提交 ${at}`,
    `通知 开着 ${f.notesOpen} 条 ${at}`,
    `飞书推送 ${pushProblem(f.push) ? '不通' : '通着'}（该推没送到 ${f.push.undelivered} 条，最近一次送到${f.push.lastOkMinutes < 0 ? '：从没有' : ` ${f.push.lastOkMinutes} 分钟前`}） ${at}`,
    `每日简报 ${f.brief.day} ${f.brief.minutes < LIMITS.briefGraceMinutes ? '还没到点' : briefProblem(f.brief) ? '没送到' : '送到了'} ${at}`,
    ...r.notes,
    `DELTA ${r.delta.length}`,
    ...r.delta.map((d) => `  ${d}`),
    `ALERT ${r.alerts.length}`,
    ...r.alerts.map((a) => `  ${a}`),
    ...(r.verdict === 'BROKEN' ? [`BROKEN ${r.broken ?? ''}`] : []),
    r.verdict === 'BROKEN'
      ? 'VERDICT: BROKEN'
      : r.verdict === 'ALERT'
        ? `VERDICT: ALERT ${r.alerts.length}`
        : 'VERDICT: OK',
  ];
  return lines;
}

/**
 * 读基线文件的内容。没有文件传 null。认不出回 { ok: false, why }（调用方照「没有基线」办，并打一行说明）。
 * @param {string | null} text
 * @returns {{ ok: true, facts: Facts | null } | { ok: false, why: string }}
 */
export function readBaseline(text) {
  if (text === null) return { ok: true, facts: null };
  try {
    const v = JSON.parse(text);
    if (v?.schema !== BASELINE_SCHEMA || typeof v.facts !== 'object' || v.facts === null)
      return { ok: false, why: `基线文件认不出（schema 不是 ${BASELINE_SCHEMA}，或没有 facts）` };
    const f = v.facts;
    if (
      !Array.isArray(f.tasks) ||
      !Array.isArray(f.jobs) ||
      !Array.isArray(f.notes) ||
      typeof f.services !== 'object'
    )
      return { ok: false, why: '基线文件认不出（tasks、jobs、notes、services 少了一样）' };
    return { ok: true, facts: /** @type {Facts} */ (f) };
  } catch (e) {
    return { ok: false, why: `基线文件不是 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
}

/** @param {Facts} facts */
export const baselineText = (facts) => `${JSON.stringify({ schema: BASELINE_SCHEMA, facts }, null, 2)}\n`;

/**
 * 跑一次巡查：取、判、打、写基线。io 全部可换（测试不碰 ssh、不碰真文件）。
 * trainNote（可省）：总开关关着时现读发版车状态，回一句话接在那条 ALERT 后面（驱动死了、没人恢复要写明）。
 * @param {{ fetchRaw: () => Promise<{ ok: true, stdout: string } | Failure>, now: () => Date, loadBaseline: () => string | null, saveBaseline: (text: string) => void, trainNote?: () => string }} io
 * @returns {Promise<{ code: number, lines: string[], report: Report }>}
 */
export async function runPatrol(io) {
  /** @type {string[]} */
  const extra = [];
  let base = null;
  try {
    const b = readBaseline(io.loadBaseline());
    if (b.ok) base = b.facts;
    else extra.push(`基线 ${b.why}：这次照没有基线算，读数写成新基线`);
  } catch (e) {
    extra.push(`基线 读不了（${e instanceof Error ? e.message : String(e)}）：这次照没有基线算`);
  }
  const report = judge({ raw: await io.fetchRaw(), now: io.now(), base });
  if (report.facts && report.facts.master !== 'true' && io.trainNote) {
    let note;
    try {
      note = io.trainNote();
    } catch (e) {
      note = `发版车状态读不了（${e instanceof Error ? e.message : String(e)}）`;
    }
    report.alerts = report.alerts.map((a) => (a.startsWith('引擎总开关关着') ? `${a}；发版车：${note}` : a));
  }
  if (report.facts && report.verdict !== 'BROKEN') {
    try {
      io.saveBaseline(baselineText(report.facts));
    } catch (e) {
      extra.push(`基线 没写成（${e instanceof Error ? e.message : String(e)}）：下一次的 DELTA 不可信`);
    }
  }
  const body = render(report);
  const lines = [...body.slice(0, -1), ...extra, ...body.slice(-1)];
  return { code: report.verdict === 'OK' ? 0 : report.verdict === 'ALERT' ? 1 : 2, lines, report };
}

/**
 * 真去法国取：ssh 名字照 france-lib 的读法，远端换成 `sh -s`、把 REMOTE_SCRIPT 从标准输入喂过去；回来的字抹过 ssh 名字。
 * @param {{ home: string, env: Record<string, string | undefined>, readText: (file: string) => string, timeoutMs?: number, spawnImpl?: Parameters<typeof runRemote>[0]['spawnImpl'] }} opts
 * @returns {Promise<{ ok: true, stdout: string } | Failure>}
 */
export async function fetchFrance({ home, env, readText, timeoutMs = 55_000, spawnImpl }) {
  const target = readTarget({ env, home, readText });
  if (!target.ok) return target;
  const r = await runRemote({
    command: 'ssh',
    args: [...sshArgs(target.host).slice(0, -1), PATROL_REMOTE_COMMAND],
    script: REMOTE_SCRIPT,
    timeoutMs,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  if (!r.ok) return r;
  return { ok: true, stdout: r.stdout.split(target.host).join('<host>') };
}

// —— 自检：一份固定的假输出，验证 ALERT、BROKEN 的判法还灵 ——

/**
 * 造一份法国回来的样子（自检和测试用）。默认是一切正常；over 改哪项就坏哪项。
 * @param {{ at: Date, disk?: number, mem?: number, engine?: string, master?: string, tasks?: string[], jobs?: string[], notes?: string[], push?: string, brief?: string, noEnd?: boolean, err?: string, healthz?: number, healthRed?: string[], hist?: string[], noHist?: boolean, train?: string, trainRaw?: string, noState?: boolean, autoNote?: string, behind?: number, behindMinutes?: number }} o
 */
export function sampleRaw(o) {
  const notes = o.notes ?? ['note|alert|deploy-lag|发布落后'];
  const cur = `abcd1234${'0'.repeat(32)}`;
  const sha = (/** @type {number} */ i) => `${String(i).padStart(8, '0')}${'f'.repeat(32)}`;
  const behind = o.behind ?? 0;
  const oldest = o.behindMinutes ?? 5;
  // 主线最近的提交，新的在前：先是 behind 个没发的（最老的那个落下 oldest 分钟），再是在用的，再是几个更早的
  const commits = [
    ...Array.from({ length: behind }, (_, i) => [
      sha(i + 1),
      new Date(o.at.getTime() - Math.round((oldest * (i + 1)) / behind) * 60_000).toISOString(),
    ]),
    [cur, new Date(o.at.getTime() - (oldest + 30) * 60_000).toISOString()],
    [sha(900), new Date(o.at.getTime() - (oldest + 90) * 60_000).toISOString()],
  ];
  const state = JSON.stringify({
    schema: 1,
    main: { head: String(commits[0]?.[0]), commits },
    auto: { sha: null, at: null, note: o.autoNote ?? '在用的就是主线头，没有要发的' },
  });
  const hist = o.hist ?? [`2026-10-08T23:00:00Z ${cur} release`];
  const lines = [
    `at|${Math.floor(o.at.getTime() / 1000)}`,
    'release|abcd1234',
    `healthz|${o.healthz ?? 200}|${(o.healthRed ?? []).join(',')}`,
    `cur|${cur}`,
    ...(o.noHist ? ['hist|-|-|-'] : hist.map((h) => `hist|${h.trim().split(/ +/).slice(0, 3).join('|')}`)),
    `train|${o.trainRaw ?? (o.train ? JSON.stringify({ status: o.train }) : '-')}`,
    `state|${o.noState ? '-' : state}`,
    'svc|fleet-api|active',
    `svc|fleet-engine|${o.engine ?? 'active'}`,
    `disk|${o.disk ?? 40}`,
    `mem|${o.mem ?? 3000}`,
    'load|0.50',
    `master|${o.master ?? 'true'}`,
    'ok|master',
    ...(o.tasks ?? ['task|12|fleet-dao|running||3|在写代码']),
    'ok|tasks',
    ...(o.jobs ?? []),
    'ok|jobs',
    `notes|${notes.length}`,
    'ok|notecount',
    ...notes,
    o.err ?? 'ok|notes',
    o.push ?? 'push|on||-1|0|30',
    'ok|push',
    o.brief ?? 'brief|2026-10-09|120|ok|1|1|1|',
    'ok|brief',
    ...(o.noEnd ? [] : ['end']),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 自检：几份已知结局的假输出逐个过 judge，结局不对就算失败。回 { ok, lines }。
 * @param {Date} now
 */
export function selftest(now) {
  const good = parseRaw(sampleRaw({ at: now }));
  const base = good.ok ? good.facts : null;
  /** @type {[name: string, raw: { ok: true, stdout: string } | Failure, want: Verdict, alerts?: number][]} */
  const cases = [
    ['一切正常', { ok: true, stdout: sampleRaw({ at: now }) }, 'OK', 0],
    [
      '已知坏样本（引擎服务挂了、磁盘满、内存紧、总开关关、单卡住 45 分钟、定时任务失败、飞书推送不通、新通知）',
      {
        ok: true,
        stdout: sampleRaw({
          at: now,
          engine: 'failed',
          disk: 91,
          mem: 512,
          master: 'false',
          tasks: ['task|12|fleet-dao|stalled||45|等路由'],
          jobs: ['job|probe|failed|7|探针连不上'],
          notes: ['note|alert|deploy-lag|发布落后', 'note|alert|task-stuck:12|单卡住了'],
          push: 'push|on||95|3|12960',
        }),
      },
      'ALERT',
      8,
    ],
    [
      '2026-10-14 法国那次：/healthz 503、最近一次发版 unhealthy→auto-rollback→unhealthy、自动发布说要人看、落后 19 个提交',
      {
        ok: true,
        stdout: sampleRaw({
          at: now,
          healthz: 503,
          healthRed: ['db', 'temporal'],
          hist: [
            '2026-10-14T17:03:00Z abcd1234 release',
            '2026-10-14T17:05:00Z abcd1234 unhealthy',
            '2026-10-14T17:06:00Z 1111aaaa auto-rollback',
            '2026-10-14T17:08:00Z 1111aaaa unhealthy',
          ],
          train: 'failed',
          autoNote: '现在不发：上一趟发版是「failed」状态，要人看，不自动再发',
          behind: 19,
          behindMinutes: 90,
        }),
      },
      'BROKEN',
    ],
    [
      '落后 8 个提交、最老的落下 90 分钟',
      { ok: true, stdout: sampleRaw({ at: now, behind: 8, behindMinutes: 90 }) },
      'ALERT',
      1,
    ],
    ['空输出', { ok: true, stdout: '' }, 'BROKEN'],
    ['ssh 连不上', { ok: false, kind: 'ssh-failed', why: '假的：连不上' }, 'BROKEN'],
    ['没有结尾 end（截断）', { ok: true, stdout: sampleRaw({ at: now, noEnd: true }) }, 'BROKEN'],
    [
      '库查询报错',
      { ok: true, stdout: sampleRaw({ at: now, err: 'ERR|notes|permission denied' }) },
      'BROKEN',
    ],
    [
      '采集时间比现在早 20 分钟',
      { ok: true, stdout: sampleRaw({ at: new Date(now.getTime() - 20 * 60_000) }) },
      'BROKEN',
    ],
  ];
  /** @type {string[]} */
  const lines = [];
  let failed = 0;
  for (const [name, raw, want, alerts] of cases) {
    const r = judge({ raw, now, base });
    const okVerdict = r.verdict === want;
    const okCount = alerts === undefined || r.alerts.length === alerts;
    if (okVerdict && okCount)
      lines.push(`自检 过 ${name}：${r.verdict}${alerts ? ` ${r.alerts.length}` : ''}`);
    else {
      failed += 1;
      lines.push(
        `自检 没过 ${name}：要 ${want}${alerts !== undefined ? ` ${alerts}` : ''}，判成 ${r.verdict} ${r.alerts.length}`,
      );
    }
  }
  lines.push(failed === 0 ? 'SELFTEST: OK' : `SELFTEST: FAILED ${failed}`);
  return { ok: failed === 0, lines };
}
