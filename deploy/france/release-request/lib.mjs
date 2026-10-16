// 驾驶舱「发布到法国」按钮的接活（法国，root）：驾驶舱后端（fleet，没有 root）只往 /var/lib/fleet-dao/release-request/request.json 写一份请求，
// root 的 fleet-release-request.path 盯着它，起 fleet-release-request.service 跑这里：核请求 → 走一趟和 release-train 同样的九步
// （记发版前开关和异常基线、release.sh <提交>、验证、核对开关和发版前一致）→ 进度写进 /srv/fleet-dao-releases/.train/release-train.json
// （和 agents/skills/commander/scripts/release-train-lib.mjs 同一个格式，驾驶舱的 /france 页读它）。
// 发版不关引擎总开关（#2038、决定 0093）：release.sh 切版本前自己给在跑的任务发暂停（暂停人「发版」）、只等不可暂停的几段，
// 发完对这批发「继续」（deploy/release.sh 的 pause_tasks/resume_tasks）。所以这里第 2 步只读开关记下发版前的样子、第 3 步不再等收尾，
// 第 7 步只核对；只有老版本关过的（进度里 marker 为真、pausedMaster 不是 false）才把总开关开回。
// 这是人工档（deploy/lib/human-tier.sh）：装一次要创始人在法国以 root 跑 france.sh。deploy/france.sh 把本目录装到
// /usr/local/lib/fleet-dao/release-request/（装的是副本；这里依赖同级的 ../auto-release/lib.mjs 判 CI，它由自动档装在 /usr/local/lib/fleet-dao/auto-release/）。
// 改这里之前必须知道：
// - 请求文件归 fleet（后端能写、被入侵了也能写），root 只当数据读：不是普通文件、是符号链接、超 MAX_REQUEST_BYTES、键不对、
//   提交号不是完整 40 位小写十六进制，一律拒（safeReadRequest）。读完马上删掉请求文件，之后只用读到的值，不再回头开它。
// - 每一个拒绝都记进 last-request.json（outcome: refused + 原因，页面读它显示），不动 release-train.json（别人的进度不能被一次被拒的点击盖掉）：
//   不是完整 40 位、不是主线祖先、已有发版在走（进度记录说在走且进程还活着，或 release.sh 的发布锁被占着）、CI 不绿或读不到。
//   读不到的一律按拒绝，不当成「没问题」。
// - 输出和记下来的字不带令牌；请求里的「谁点的」只收字母数字和 _.@ -，最长 64。
// - 所有真的起进程、读文件、连网、睡觉都经 io：deploy/test/release-request.test.mjs 换成假的，一条拒绝路径一条故意造出失败的测试。
// - 退出码：0 做完了、发后体检通过；1 被拒（或没有请求）；2 没做成（命令失败）；3 卡住（发完了，但发后体检没通过；
//   老版本留下的「停在第 3 步等收尾」的一趟也是 3，点「重试」从第 3 步接着走）。
// - 发后体检（#2026）：第 0 步记发版前异常基线（开着的卡住报警、/healthz 不好的项）、第 2 步记总开关和各仓接活开关；第 6 步核目标在用、/healthz、
//   没有和这次发版有关的新异常（RELEASE_ALERT_PREFIXES；重启打断的几类 15 分钟内重试；无关的只列出不拦）、再跑一遍预检（已是最新）；
//   第 7 步核引擎总开关和各仓接活开关和发版前一致（被人动过的照实报不一致，不替人改回）。
//   结论写进 release-train.json 的 check 和 last-request.json；开始、成功、卡住、失败各记一条提醒进通知中心（notifications，键 release:…）：
//   卡住、失败是「要你拍」，由驾驶舱后端用飞书应用机器人立刻推进团队群（packages/api/src/feishu-push.ts）；开始、成功等不写通知，只写进度记录（#2368）。
// - 请求的种类（#2027，请求文件的 kind，没写就是 release 发布，老后端照常）：retry 从停在第 3 步「等收尾」的那一趟接着走（老版本留下的）、
//   restore 从没成在第 7 步「恢复」的那一趟把引擎总开关开回（只认我们关过的：发版前开着、pausedMaster 不是 false）、abort 撤掉暂停（等价 release-train abort：
//   我们关过的、还没动手发版就开回暂停前的样子，已动手发过版保持关）；不认识的 kind 拒绝并写原因，不当成发布。各种都落 last-request.json（kind、by）。
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { ciVerdict } from '../auto-release/lib.mjs';
import { SESSION_WAIT_MS } from './session-wait.mjs';

export const REQUEST_DIR = '/var/lib/fleet-dao/release-request';
export const REQUEST_FILE = `${REQUEST_DIR}/request.json`;
export const RELEASES = '/srv/fleet-dao-releases';
export const TRAIN_DIR = `${RELEASES}/.train`;
/** 进度：和 release-train-lib.mjs 的 ~/.fleet-dao/release-train.json 同一个格式。 */
export const STATE_FILE = `${TRAIN_DIR}/release-train.json`;
/** 最近一次请求的结果（被拒的原因）：驾驶舱读它告诉点的人。 */
export const LAST_FILE = `${TRAIN_DIR}/last-request.json`;
export const MARKER_FILE = `${TRAIN_DIR}/release-train.paused`;
export const CHECKOUT = '/srv/fleet-dao';
export const FLEET_API = `bash ${RELEASES}/current/packages/api/bin/fleet-api`;
export const RELEASE_SH = `${CHECKOUT}/deploy/release.sh`;
export const ENGINE_ENV = '/etc/fleet-dao/engine.env';
/** 引擎写排空状态（drain.json）的地方：engine.env 的 FLEET_ENGINE_STATE_DIR，没写取它（同 release.sh 的 ENGINE_STATE_DEFAULT）。 */
export const ENGINE_STATE_DEFAULT = '/var/lib/fleet-dao/engine';
export const ENGINE_SERVICE = 'fleet-engine.service';
export const HISTORY_FILE = `${RELEASES}/.history`;
export const MAX_REQUEST_BYTES = 1024;
/** 页面和火车的第几步（同 release-train-lib.mjs 的 PHASES 数组下标）。 */
export const PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];
/** 写进 founderOk 的话：这一点击就是「对外发布」那一道人闸的同意（创始人 2026-10-07 同意这个设计）。 */
export const FOUNDER_WORD = '驾驶舱点击发布（创始人）';
/** 各步上限（毫秒）；测试里整份换小。service 的 TimeoutStartSec 必须比这些加起来大（release-request.test.mjs 核对）。 */
export const LIMITS = {
  /** 老的「等收尾」上限：第 3 步已不再等（#2038），留着是因为发版确认框和 TimeoutStartSec 的核对还读同一个数。 */
  sessionsMs: SESSION_WAIT_MS,
  pollMs: 30_000,
  releaseMs: 30 * 60_000,
  deployMs: 3 * 60_000,
  checkMs: 5 * 60_000,
  stepMs: 2 * 60_000,
  /** 发后体检里「发布重启必然打断、条件会自己消失」的那几类（VERIFY_RETRY_PREFIXES、/healthz、读主线）最多重试多久（#2026）。 */
  verifyMs: 15 * 60_000,
};
/** 退出码：3 也用于「发完了、开关恢复了，但发后体检没通过」（要人看，单元不显示 failed）。 */
export const EXIT = { done: 0, refused: 1, failed: 2, blocked: 3 };

/**
 * 发后体检比「发版前异常基线」时，新出现的提醒里这几类是发布重启必然打断、条件过去就自己撤的：
 * 每小时对账等定时任务被重启打断（看门狗 watchdog:job:*）、看门狗没按期跑完（watchdog-down:*）、跟不上主线（deploy-lag:*）。
 * 在 LIMITS.verifyMs（15 分钟）里每 pollMs 重读一次，撤了就算过；到点还在才判没通过（指挥官版 2026-10-13 踩过：立刻判卡住是误报）。
 */
export const VERIFY_RETRY_PREFIXES = ['watchdog:job:', 'watchdog-down:', 'deploy-lag:'];

/**
 * 发后体检「没有新异常」只拦和这次发版有关的新提醒（键前缀），再加上 VERIFY_RETRY_PREFIXES 那几类（照旧在窗口里重试）：
 * - auto-release:      自动发布单元（fleet-auto-release）出的事
 * - engine-drain       引擎排空（切版本那一段的排空请求、drain.json）
 * - engine-session-io  会话 IO 目录（切版本前后会话的输入输出目录）
 * - cli-upgrade:       命令行升级（发版时顺带升级的 claude 等命令行）
 * - retired-schedule:  退役定时（发版时撤掉的旧定时任务）
 * 别的新提醒（任务失败 wf:failure:、对账 reconcile: 等）是引擎照常干活的结果，和这次发版无关：列进说明文字，不让体检没通过。
 */
export const RELEASE_ALERT_PREFIXES = [
  'auto-release:',
  'engine-drain',
  'engine-session-io',
  'cli-upgrade:',
  'retired-schedule:',
];

/**
 * 不算「新异常」的提醒：不是卡住报警这一级的（要你拍、日报）、任务自己挂起的（<工作流>:park:<n>，引擎照常干活的结果，
 * 同指挥官版的 KIND_TASK_PARK）、旧提醒的再提醒（remind:*，原提醒在基线里就在）。
 */
export function ignoredAlert(a) {
  return a.level !== 'alert' || /:park:/.test(a.key) || a.key.startsWith('remind:');
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const WHO = /^[\p{L}\p{N}_.@ -]{1,64}$/u;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const tail = (text, n = 3) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' / ')
    .slice(0, 400);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const minutes = (ms) => Math.round(ms / 60_000);

// —— 读请求（真文件）——

/**
 * 读请求文件并删掉它：目录或文件是符号链接、不是普通文件、超过 MAX_REQUEST_BYTES 都拒（不跟链接、不读超长的）。
 * 回 { kind: 'none' } | { kind: 'unsafe', why } | { kind: 'ok', text }。dir、file 可换（测试用临时目录）。
 */
export function safeReadRequest(dir = REQUEST_DIR, file = REQUEST_FILE) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unsafe', why: `请求目录 ${dir} 读不了（${e.code ?? e.message}）` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { kind: 'unsafe', why: `请求目录 ${dir} 是符号链接或不是目录：不读` };
  }
  try {
    st = lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unsafe', why: `请求文件读不了（${e.code ?? e.message}）` };
  }
  const drop = () => {
    try {
      unlinkSync(file); // 删的是链接本身，不是它指的东西
    } catch {
      /* 删不掉也不影响拒绝；下一次同样会被拒 */
    }
  };
  if (st.isSymbolicLink() || !st.isFile()) {
    drop();
    return { kind: 'unsafe', why: '请求文件是符号链接或不是普通文件：不读，已删掉' };
  }
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(fd).size;
    if (size > MAX_REQUEST_BYTES) {
      drop();
      return { kind: 'unsafe', why: `请求文件 ${size} 字节，超过 ${MAX_REQUEST_BYTES}：不读，已删掉` };
    }
    const buf = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_REQUEST_BYTES) {
      drop();
      return { kind: 'unsafe', why: `请求文件超过 ${MAX_REQUEST_BYTES} 字节：不读，已删掉` };
    }
    const text = buf.subarray(0, n).toString('utf8');
    drop();
    return { kind: 'ok', text };
  } catch (e) {
    drop();
    return { kind: 'unsafe', why: `请求文件打不开（${e.code ?? e.message}）：已删掉` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 请求的种类（#2027）：没写 kind 的老请求就是 release（发布）；认不出的种类拒绝，不静默当发布。 */
export const REQUEST_KINDS = ['release', 'retry', 'restore', 'abort'];
/** 各种类请求文件的键（排序后）：release 带 kind 与否都认（老后端不写）；restore、abort 不带提交号。 */
const KEYS_OF = {
  release: ['at,by,sha,v', 'at,by,kind,sha,v'],
  retry: ['at,by,kind,sha,v'],
  restore: ['at,by,kind,v'],
  abort: ['at,by,kind,v'],
};

/**
 * 请求文件的内容：后端 JSON.stringify 写的，键和样子都固定；认不出一律 { ok: false, why }。
 * 发布：{ v, sha, at, by }（老样子，不带 kind）；#2027 加三种：{ v, kind: 'retry', sha, at, by }（从卡住那一步接着走）、
 * { v, kind: 'restore', at, by }（恢复引擎总开关）、{ v, kind: 'abort', at, by }（撤掉暂停）。
 */
export function parseRequest(text) {
  let o;
  try {
    o = JSON.parse(String(text).trim());
  } catch {
    return { ok: false, why: '请求文件不是 JSON', sha: null, by: null };
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, why: '请求文件不是一个对象', sha: null, by: null };
  }
  const keys = Object.keys(o).sort().join(',');
  const sha = typeof o.sha === 'string' && FULL_SHA.test(o.sha) ? o.sha : null;
  const by = typeof o.by === 'string' && WHO.test(o.by) ? o.by : null;
  const kind = o.kind === undefined ? 'release' : o.kind;
  if (typeof kind !== 'string' || !REQUEST_KINDS.includes(kind)) {
    return {
      ok: false,
      why: `请求的种类认不出（${JSON.stringify(o.kind)?.slice(0, 30)}）：不当成发布，现场没动`,
      sha,
      by,
    };
  }
  if (!KEYS_OF[kind].includes(keys)) {
    return { ok: false, why: `请求文件的键不对（${keys.slice(0, 60)}）`, sha, by };
  }
  if (o.v !== 1) return { ok: false, why: '请求文件的版本不是 1', sha, by };
  const needSha = kind === 'release' || kind === 'retry';
  if (needSha && sha === null) return { ok: false, why: '提交号不是完整的 40 位小写十六进制', sha, by };
  if (by === null) return { ok: false, why: '「谁点的」不合格（只收字母数字和 _.@ -，最长 64）', sha, by };
  if (typeof o.at !== 'string' || !AT.test(o.at) || Number.isNaN(Date.parse(o.at))) {
    return { ok: false, why: '请求里的时间不是 UTC 的 ISO 时间', sha, by };
  }
  return { ok: true, kind, sha: needSha ? sha : null, at: o.at, by };
}

/**
 * 引擎手上有哪些会话在干（权威口径，同 release.sh 的 engine_drain_status）：读引擎写的排空状态 drain.json
 * （packages/engine/src/drain.ts 的 drainStatus）。起会话过了闸才登记（track），额度探针、session-org 这类辅助命令
 * 根本不登记 —— 所以这里数的就是「真在干的活」，常驻的探针 scope 数不进来（#2002）。
 * 就收 pid 对得上的那份：pid 对不上就是上一个进程留下的旧文件，不信（同 drain.ts 的头注释）。
 * 回 { ok: true, running } | { ok: false, engineDown, why }：看不到的照实说，不当成 0 个。
 * @param {string | null} text drain.json 的内容（读不到给 null）
 * @param {string} enginePid systemd 的 fleet-engine.service MainPID
 * @param {number | null} serviceActive 引擎在不在跑：false = 没在跑（没法排队、也没有会话在跑），null = 读不到
 */
export function parseDrain(text, enginePid, serviceActive) {
  // 引擎根本没在跑：手上没有会话，也没什么要等（同 release.sh：引擎不在就跳过排空）。读不到状态（null）不当成「没在跑」。
  if (serviceActive === false) return { ok: true, engineDown: true, running: [] };
  if (text === null || text === undefined) return { ok: false, engineDown: false, why: 'drain.json 读不到' };
  let st;
  try {
    st = JSON.parse(String(text));
  } catch (e) {
    return {
      ok: false,
      engineDown: false,
      why: `drain.json 认不出：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (st === null || typeof st !== 'object' || st.schema !== 2) {
    return {
      ok: false,
      engineDown: false,
      why: `drain.json 的 schema 不是 2（${JSON.stringify(st?.schema)}）`,
    };
  }
  if (String(st.pid) !== String(enginePid)) {
    return {
      ok: false,
      engineDown: false,
      why: `drain.json 是上一个进程（${st.pid}）留下的，在跑的是 ${enginePid}`,
    };
  }
  const list = Array.isArray(st.sessions) ? st.sessions : [];
  const running = list.map((x) => ({
    runId: x && typeof x.runId === 'string' ? x.runId : '',
    stage: x && typeof x.stage === 'string' ? x.stage : '',
  }));
  return { ok: true, engineDown: false, running };
}

/** 报「在跑谁」的写法（老的等收尾用过；第 3 步已不再等）：和 release.sh 的 engine_drain_status 一致，环节（编号前 8 位）。 */
export const sessionName = (s) => `${s.stage || '会话'}(${(s.runId || '').slice(0, 8)})`;

/**
 * `fleet-api alert show --json` 的输出（packages/api/src/alert-cli.ts 的 show：{ alerts: [{ id, key, level, title }], truncated }）。
 * 认不出回 { ok: false, why }，不当成「没有提醒」。
 */
export function parseAlerts(r) {
  if (r.error || r.status !== 0) {
    return { ok: false, why: `fleet-api alert show 没跑成：${tail(r.error ?? (r.stderr || r.stdout))}` };
  }
  let o;
  try {
    o = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '');
  } catch {
    return { ok: false, why: `fleet-api alert show --json 的输出不是 JSON：${tail(r.stdout)}` };
  }
  if (o === null || typeof o !== 'object' || !Array.isArray(o.alerts)) {
    return { ok: false, why: 'fleet-api alert show --json 的输出里没有 alerts 列表' };
  }
  const alerts = [];
  for (const a of o.alerts) {
    if (!a || typeof a.key !== 'string' || typeof a.level !== 'string') {
      return { ok: false, why: 'fleet-api alert show --json 里有一条提醒认不出（缺 key 或 level）' };
    }
    alerts.push({ key: a.key, level: a.level, title: typeof a.title === 'string' ? a.title : a.key });
  }
  return { ok: true, alerts, truncated: o.truncated === true };
}

/**
 * 后端 /healthz 的回话（packages/api/src/health.ts：{ ok, checks: { 名字: { ok, message? } } }，全好 200、有项不好 503；
 * 同 release.sh 的 report_items）。回 { ok: true, bad: [{ name, why }] } 或读不到 { ok: false, why }。
 */
export function parseHealthz(r) {
  if (r.error) return { ok: false, why: `/healthz 连不上：${tail(r.error)}` };
  if (r.status !== 200 && r.status !== 503)
    return { ok: false, why: `/healthz 回 HTTP ${r.status}，不是健康报告` };
  let o;
  try {
    o = JSON.parse(String(r.body));
  } catch {
    return { ok: false, why: '/healthz 回的不是 JSON' };
  }
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(o) || typeof o.ok !== 'boolean' || !isObj(o.checks)) {
    return { ok: false, why: '/healthz 回的不是健康报告（缺 ok 或 checks）' };
  }
  const bad = [];
  for (const [name, v] of Object.entries(o.checks)) {
    if (isObj(v) && v.ok === true) continue;
    bad.push({ name, why: isObj(v) && typeof v.message === 'string' && v.message ? v.message : '没给原因' });
  }
  return { ok: true, bad };
}

/** 各仓「让 AI 接活」开关的读数（psql -tA 的「owner/name|since」一行一个仓，since 空＝关着）→ { 仓: since | null }。 */
export function parseRepoSwitches(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.lastIndexOf('|');
    if (at <= 0) return { ok: false, why: `接活开关的读数认不出：${line.slice(0, 80)}` };
    const repo = line.slice(0, at);
    const since = line.slice(at + 1).trim();
    out[repo] = since === '' ? null : since;
  }
  return { ok: true, repos: out };
}

/** 两份接活开关读数哪几个仓不一样（同一时刻不同写法算同一个；关着只等于关着）。 */
export function repoSwitchDiff(before, now) {
  const same = (a, b) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
  const text = (v) => (v === null ? '关着' : '开着');
  const diff = [];
  for (const repo of new Set([...Object.keys(before), ...Object.keys(now)])) {
    if (!(repo in now)) diff.push(`${repo}（发版前${text(before[repo])}，现在库里没有了）`);
    else if (!(repo in before)) diff.push(`${repo}（发版前没有，现在${text(now[repo])}）`);
    else if (!same(before[repo], now[repo]))
      diff.push(`${repo}（发版前${text(before[repo])}，现在${text(now[repo])}）`);
  }
  return diff;
}

// —— 一次请求 ——

const iso = (io) => io.now().toISOString();

async function refuse(io, req, why) {
  const sha = req?.sha ?? null;
  io.err(`拒绝：${why}`);
  try {
    io.writeLast({
      v: 1,
      at: iso(io),
      outcome: 'refused',
      sha,
      by: req?.by ?? null,
      ...(req?.kind && req.kind !== 'release' ? { kind: req.kind } : {}),
      why,
    });
  } catch (e) {
    io.err(`拒绝的原因也没写进 ${LAST_FILE}：${e instanceof Error ? e.message : String(e)}`);
  }
  return EXIT.refused;
}

/** 核请求本身（只读）：回 null 通过，或拒绝的原因。各条一条故意造出失败的测试。checkSha=false（恢复引擎开关）只核「没有发版在走」，不核提交和 CI。 */
async function preflight(io, req, checkSha = true) {
  // 已有发版在走：进度记录说在走且那个进程还活着；或 release.sh 的发布锁被占着
  const read = io.readState();
  if (!read.ok) return `进度记录读不了，不敢覆盖它：${read.why}`;
  const prev = read.state;
  if (prev && prev.status === 'running') {
    if (Number.isInteger(prev.pid) && prev.pid !== io.pid && io.pidAlive(prev.pid)) {
      return `已有发版在走（目标 ${String(prev.target?.value ?? '').slice(0, 12)}，第 ${prev.phase} 步，进程 ${prev.pid}）`;
    }
  }
  let busy;
  try {
    busy = await io.releaseBusy();
  } catch (e) {
    return `看发布锁没成（${e instanceof Error ? e.message : String(e)}），按有发布在跑算`;
  }
  if (busy) return '已有发布在跑（发布锁被占着：自动发布或人手动在发）';
  if (!checkSha) return null;

  // 必须是主线上的提交：先取最新主线，再比祖先
  const main = await io.mainline(req.sha);
  if (!main.ok) return main.why;
  if (!main.onMain) return `提交 ${req.sha.slice(0, 12)} 不是主线的祖先提交：只发主线上的提交`;

  // CI 必须绿
  let ci;
  try {
    ci = await io.ciRuns();
  } catch (e) {
    return `主线 CI 读不到（${e instanceof Error ? e.message : String(e)}），不当成绿`;
  }
  if (ci.status !== 200) return `主线 CI 读不到（GitHub 回 ${ci.status}），不当成绿`;
  let body;
  try {
    body = JSON.parse(ci.body);
  } catch {
    return '主线 CI 的回话不是 JSON，不当成绿';
  }
  const v = ciVerdict(body, req.sha, main.at, io.now().getTime());
  if (v.verdict !== 'green') return `这个提交的 CI 不是绿的（${v.verdict}）：${v.detail}`;
  return null;
}

/** 状态记录：和 release-train-lib.mjs 的 state 同形（多几个 via、requestedBy、pid，页面不读）。 */
function newState(io, req) {
  return {
    schema: 1,
    status: 'running',
    phase: 0,
    startedAt: iso(io),
    updatedAt: iso(io),
    target: { kind: 'sha', value: req.sha },
    founderOk: `${FOUNDER_WORD} ${req.at} ${req.by}`,
    restore: true, // 发完核对开关和发版前一致；这一趟不关总开关（决定 0093），只有老版本关过的才开回
    before: null,
    baseline: null,
    marker: false,
    /** 这一趟有没有关过引擎总开关：新版本恒为 false（老现场带过来的那一支记 true）；老版本的进度记录没有这个键＝关过。 */
    pausedMaster: false,
    laggards: [],
    release: {},
    why: null,
    /** 每一步从什么时候开始（下标同 PHASES；没走到的是 null）：驾驶舱的九步时间线读它（#2026）。 */
    steps: PHASES.map(() => null),
    /** 这一步此刻在等什么（一句话；不在等的是 null）：驾驶舱时间线「在等什么」。 */
    waiting: null,
    /** 发后体检（第 6 步验证 + 第 7 步恢复后的开关核对）：{ ok, items: [{ name, ok, text }], at }；还没体检是 null。 */
    check: null,
    /** 推过的飞书（开始、成功、卡住、失败）：{ kind, ok, why? }。 */
    pushes: [],
    via: 'cockpit',
    requestedBy: req.by,
    requestedAt: req.at,
    pid: io.pid,
  };
}

const failed = (why) => ({ ok: false, kind: 'failed', why });

async function engineRead(io) {
  const r = await io.fleetApi('engine status', io.limits.stepMs);
  if (r.status !== 0 && /用法：fleet-api/.test(`${r.stdout}\n${r.stderr}`)) {
    return { ok: true, on: false, legacy: true };
  }
  if (r.status !== 0) return { ok: false, why: `法国引擎总开关读不到：${tail(r.stderr || r.stdout)}` };
  const m = /引擎总开关：(开着|关着)/.exec(String(r.stdout));
  if (!m) return { ok: false, why: `法国引擎总开关的回话认不出：${tail(r.stdout)}` };
  return { ok: true, on: m[1] === '开着' };
}

async function engineOn(io, reason) {
  const r = await io.fleetApi(`engine on --reason ${shq(reason)}`, io.limits.stepMs);
  if (r.status !== 0) return { ok: false, why: `fleet-api engine on 没成：${tail(r.stderr || r.stdout)}` };
  const back = await engineRead(io);
  if (!back.ok) return { ok: false, why: `开回去之后读不回总开关：${back.why}` };
  if (!back.on) return { ok: false, why: 'engine on 说成了，读回来总开关还是关着' };
  return { ok: true };
}

const say = (io, text) => io.out(text);

/** 此刻在等什么：写进进度（页面时间线读），同一句不重复写。 */
function waitOn(io, state, text) {
  if (state.waiting === text) return;
  state.waiting = text;
  io.writeState(state);
}

async function readAlerts(io) {
  const r = await io.fleetApi('alert show --json', io.limits.stepMs);
  return parseAlerts(r);
}

/**
 * 0 预检：请求本身在进来之前已经核过（preflight）。这里记「发版前异常基线」：开着的提醒的键、/healthz 里不好的项，
 * 第 6 步只拦基线里没有的（同指挥官版比 key 的集合，#1740）。提醒读不到就没法比：没成（什么都还没动）。
 * /healthz 读不到不拦（后端可能正是要靠这次发版修），记下原因，第 6 步对它按「之前全没好过」比：之后哪项不好都算新的。
 */
async function phasePreflight(io, state) {
  const alerts = await readAlerts(io);
  if (!alerts.ok) return failed(`发版前异常基线读不到（什么都还没动）：${alerts.why}`);
  let health;
  try {
    health = parseHealthz(await io.healthz());
  } catch (e) {
    health = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  state.baseline = {
    at: iso(io),
    alerts: alerts.alerts.filter((a) => !ignoredAlert(a)).map((a) => a.key),
    health: health.ok ? health.bad.map((b) => b.name) : [],
    healthWhy: health.ok ? null : health.why,
  };
  io.writeState(state);
  say(
    io,
    `预检：发版前开着的卡住报警 ${state.baseline.alerts.length} 条、/healthz 不好的 ${health.ok ? `${health.bad.length} 项` : `读不到（${health.why}）`}（记作基线，发后体检只拦新增）`,
  );
  return { ok: true };
}

async function phasePauseLocal(io) {
  say(io, '暂停本机：跳过（法国上没有指挥官本机的工人，本机暂停标记不适用）');
  return { ok: true };
}

/**
 * 各仓「让 AI 接活」开关发版前的样子：这个脚本和 release.sh 都不动它们，发后体检核对「没被动过」。
 * 上一回停下时记过的带过来（那时才是真的发版前）；读不到就没法核对：没成（只读过，什么都还没动）。
 */
async function recordRepos(io, state) {
  if (state.before?.repos && typeof state.before.repos === 'object')
    return { ok: true, repos: state.before.repos };
  let r;
  try {
    r = await io.repoSwitches();
  } catch (e) {
    r = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) return { ok: false, why: `各仓接活开关发版前的样子读不到（发后没法核对，没往下走）：${r.why}` };
  return r;
}

/**
 * 2 暂停法国：不关总开关（#2038、决定 0093）。release.sh 切版本前自己给在跑的任务发暂停、发完发继续；
 * 这里只读总开关和各仓接活开关，记下发版前的样子（第 7 步核对用），什么都不改。
 * 兼容老现场：上一回老版本停在「卡住」或「没成」、总开关是老版本关的（runRequest 带过来 before.master 为真、现在关着），
 * 别拿现在的「关着」盖掉发版前的「开着」，照旧记暂停标记，第 7 步知道是我们关的、要开回。
 */
async function phasePauseFrance(io, state) {
  const now = await engineRead(io);
  if (!now.ok) return failed(now.why);
  const repos = await recordRepos(io, state);
  if (!repos.ok) return failed(repos.why);
  if (state.before?.master === true && !now.on) {
    state.before = { ...state.before, repos: repos.repos };
    io.writeMarker({ since: iso(io), target: state.target.value.slice(0, 12), by: 'release-request' });
    state.marker = true;
    state.pausedMaster = true;
    io.writeState(state);
    say(io, '暂停法国：总开关是上一回老版本发版时关的（发版前开着，已记），发完开回');
    return { ok: true };
  }
  state.before = { master: now.on, repos: repos.repos, recordedAt: iso(io) };
  state.pausedMaster = false;
  io.writeState(state);
  say(
    io,
    `暂停法国：不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）；发版前总开关${now.on ? '开着' : '关着'}，已记`,
  );
  return { ok: true };
}

/**
 * 3 等收尾：不再等（#2038）。release.sh 切版本前自己给在跑的任务发 hard 暂停、只等不可暂停的几段最多 2 分钟。
 * io.drain 保留在接口里（老测试、以后要看排空时用），这一步不读它。老版本留下的「停在第 3 步」的一趟点「重试」从这里接着走，直接过。
 */
async function phaseWait(io) {
  say(io, '等收尾：跳过（release.sh 切版本前自己暂停在跑的任务，#2038）');
  return { ok: true };
}

async function phaseRelease(io, state) {
  if (typeof state.founderOk !== 'string' || state.founderOk.trim() === '') {
    return failed('发版是对外发布，必须有创始人的同意（founderOk）：没有，不发');
  }
  const sha = state.target.value;
  state.release = { ...(state.release ?? {}), started: true };
  io.writeState(state);
  waitOn(io, state, `部署检出快进到 ${sha.slice(0, 12)}`);
  const prep = await io.prepareCheckout(sha);
  if (!prep.ok) return failed(`部署检出没准备好：${prep.why}`);
  say(io, `发版：跑 release.sh ${sha.slice(0, 12)}（${state.founderOk}）`);
  waitOn(io, state, `release.sh ${sha.slice(0, 12)} 在跑（最多 ${minutes(io.limits.releaseMs)} 分钟）`);
  const r = await io.runRelease(sha, io.limits.releaseMs);
  state.target.sha = sha;
  if (r.error || r.status === null) {
    return failed(
      `release.sh 没跑完整（${tail(r.error ?? r.stderr)}）：不知道发出去没有，看 ${HISTORY_FILE}，再点一次（同一个提交重发什么都不变）`,
    );
  }
  if (r.status === 0) return { ok: true };
  if (r.status === 2) {
    say(io, 'release.sh 退出码 2：没有红，但有待配事项（验证那一步会再看）');
    return { ok: true };
  }
  return failed(`release.sh 退出码 ${r.status}（有红或已退回）：${tail(r.stderr || r.stdout, 5)}`);
}

async function phaseDeploy(io, state) {
  const sha = state.target.value;
  const started = io.now().getTime();
  waitOn(io, state, `等法国在用的切到 ${sha.slice(0, 12)}`);
  for (;;) {
    const h = await io.historyLast();
    if (!h.ok) return failed(`法国发布历史读不到：${h.why}`);
    const [, got, event] = h.line.trim().split(/\s+/);
    if (!got || !event) return failed('法国发布历史末行认不出');
    if (got === sha) {
      if (event === 'release' || event === 'recovered') break;
      if (event === 'unhealthy' || event === 'auto-rollback' || event === 'rollback') {
        return failed(`目标 ${sha.slice(0, 12)} 的历史末行是 ${event}：没过健康检查或已退回`);
      }
    }
    if (io.now().getTime() - started >= io.limits.deployMs) {
      return failed(
        `等了 ${minutes(io.limits.deployMs)} 分钟，在用的还不是目标 ${sha.slice(0, 12)}（历史末行：${tail(h.line, 1)}）`,
      );
    }
    await io.sleep(io.limits.pollMs);
  }
  waitOn(io, state, 'release.sh --check 在跑');
  const chk = await io.releaseCheck(io.limits.checkMs);
  if (chk.error || chk.status === null)
    return failed(`release.sh --check 没跑成：${tail(chk.error ?? chk.stderr)}`);
  if (chk.status === 1) return failed(`release.sh --check 有红：${tail(chk.stderr || chk.stdout, 5)}`);
  return { ok: true };
}

/** 体检的一项：name 是页面上「没通过：哪几项」列的名字；retry＝发布重启必然打断、过一会儿会自己好的，在窗口里重试。 */
const item = (name, ok, text, retry = false) => ({ name, ok, text, retry });

/** 发后体检第一段（第 6 步，引擎还关着时）：目标在用、/healthz、异常基线、再跑一遍预检。每一项读不到都算没通过，不当成没事。 */
async function verifyOnce(io, state) {
  const sha = state.target.value;
  const items = [];

  // ① 目标提交已在用（发布目录的 current 链接）
  let cur;
  try {
    cur = await io.currentRelease();
  } catch (e) {
    cur = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!cur.ok) items.push(item('目标提交在用', false, `法国在用的提交读不到：${cur.why}`));
  else if (cur.sha !== sha)
    items.push(
      item(
        '目标提交在用',
        false,
        `法国在用的是 ${String(cur.sha).slice(0, 12)}，不是目标 ${sha.slice(0, 12)}`,
      ),
    );
  else items.push(item('目标提交在用', true, `法国在用的就是 ${sha.slice(0, 12)}`));

  // ② /healthz：读得到，且没有发版前没坏、现在坏了的项
  let h;
  try {
    h = parseHealthz(await io.healthz());
  } catch (e) {
    h = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!h.ok) items.push(item('/healthz', false, h.why, true));
  else {
    const known = new Set(state.baseline?.health ?? []);
    const fresh = h.bad.filter((b) => !known.has(b.name));
    items.push(
      fresh.length === 0
        ? item(
            '/healthz',
            true,
            h.bad.length === 0 ? '全好' : `没有新坏的项（发版前就不好的 ${h.bad.length} 项照旧）`,
          )
        : item(
            '/healthz',
            false,
            `发版后新坏了：${fresh.map((b) => `${b.name}（${b.why}）`).join('；')}`,
            true,
          ),
    );
  }

  // ③ 异常基线：开着的卡住报警，基线里没有的就是新出现的；只拦和这次发版有关的（RELEASE_ALERT_PREFIXES），
  //   重启必然打断的那几类（VERIFY_RETRY_PREFIXES）在窗口里重试；别的新提醒列出来，不拦
  const a = await readAlerts(io);
  if (!a.ok) items.push(item('没有新异常', false, `开着的提醒读不到：${a.why}`, true));
  else {
    const known = new Set(state.baseline?.alerts ?? []);
    const fresh = a.alerts.filter((x) => !ignoredAlert(x) && !known.has(x.key));
    const has = (prefixes) => (x) => prefixes.some((p) => x.key.startsWith(p));
    const transient = fresh.filter(has(VERIFY_RETRY_PREFIXES));
    const hard = fresh.filter((x) => !transient.includes(x) && has(RELEASE_ALERT_PREFIXES)(x));
    const unrelated = fresh.filter((x) => !transient.includes(x) && !hard.includes(x));
    const list = (xs) =>
      xs
        .slice(0, 8)
        .map((x) => `${x.title}（${x.key}）`)
        .join('；');
    const note =
      unrelated.length > 0
        ? `；发版后新出现 ${unrelated.length} 条和这次发版无关的提醒，不拦：${list(unrelated)}`
        : '';
    if (hard.length > 0)
      items.push(
        item(
          '没有新异常',
          false,
          `发版后新出现 ${hard.length} 条和这次发版有关的卡住报警：${list(hard)}${note}`,
        ),
      );
    else if (transient.length > 0)
      items.push(
        item(
          '没有新异常',
          false,
          `发布重启打断的 ${transient.length} 条还没撤（${minutes(io.limits.verifyMs)} 分钟内重试）：${list(transient)}${note}`,
          true,
        ),
      );
    else
      items.push(
        item(
          '没有新异常',
          true,
          `比发版前没有和这次发版有关的新卡住报警（开着的 ${a.alerts.length} 条）${note}`,
        ),
      );
  }

  // ④ 再跑一遍预检：主线头应就是刚发的（已是最新、没有要发的）；发版期间又合进来的只提一句，不算这次发版的问题
  let m;
  try {
    m = await io.mainHead(sha);
  } catch (e) {
    m = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!m.ok) items.push(item('再跑一遍预检', false, `主线头读不到：${m.why}`, true));
  else if (m.sha === sha) items.push(item('再跑一遍预检', true, '已是最新、没有要发的'));
  else if (m.behind > 0)
    items.push(
      item(
        '再跑一遍预检',
        true,
        `这次要发的已在用；发版期间主线又合进了 ${m.behind} 个提交（主线头 ${m.sha.slice(0, 12)}），下一次再发`,
      ),
    );
  else
    items.push(
      item(
        '再跑一遍预检',
        false,
        `主线头 ${String(m.sha).slice(0, 12)} 和刚发的 ${sha.slice(0, 12)} 不是前后关系`,
      ),
    );
  return items;
}

/**
 * 6 验证（发后体检第一段）：verifyOnce 不全过、且没过的都是 retry 类时，每 pollMs 再查一次，最多 LIMITS.verifyMs；
 * 到点还没过的照实记进 state.check。这一步自己不拦流程：版本已经发出去了，恢复（第 7 步）照走，开关不因体检没过留在关；
 * 体检结论在最后汇总（runRequest），没通过推飞书「卡住」、退出码 3。
 */
async function phaseVerify(io, state) {
  const started = io.now().getTime();
  let items;
  for (;;) {
    items = await verifyOnce(io, state);
    const bad = items.filter((x) => !x.ok);
    if (bad.length === 0 || bad.some((x) => !x.retry)) break;
    const waited = io.now().getTime() - started;
    if (waited >= io.limits.verifyMs) break;
    waitOn(
      io,
      state,
      `发后体检重试（重启打断的，已等 ${minutes(waited)} 分钟，最多 ${minutes(io.limits.verifyMs)} 分钟）：${bad.map((x) => x.name).join('、')}`,
    );
    await io.sleep(io.limits.pollMs);
  }
  state.check = { ok: items.every((x) => x.ok), items: items.map(({ retry, ...x }) => x), at: iso(io) };
  io.writeState(state);
  for (const x of items) say(io, `体检：${x.ok ? '[通过]' : '[没过]'} ${x.name}：${x.text}`);
  return { ok: true };
}

/** 发后体检第二段（恢复之后）：引擎总开关、各仓接活开关和发版前一致。读不到算没通过。 */
async function checkSwitches(io, state) {
  const before = state.before ?? {};
  const items = [];
  const eng = await engineRead(io);
  if (!eng.ok) items.push(item('引擎总开关和发版前一致', false, `读不到：${eng.why}`));
  else if (eng.on !== before.master)
    items.push(
      item(
        '引擎总开关和发版前一致',
        false,
        `发版前${before.master ? '开着' : '关着'}，现在${eng.on ? '开着' : '关着'}`,
      ),
    );
  else items.push(item('引擎总开关和发版前一致', true, `发版前${before.master ? '开着' : '关着'}，现在一样`));

  let r;
  try {
    r = await io.repoSwitches();
  } catch (e) {
    r = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!before.repos || typeof before.repos !== 'object')
    items.push(item('各仓接活开关没被动过', false, '发版前没记下各仓接活开关，没法核对'));
  else if (!r.ok) items.push(item('各仓接活开关没被动过', false, `现在读不到：${r.why}`));
  else {
    const diff = repoSwitchDiff(before.repos, r.repos);
    const n = Object.keys(r.repos).length;
    items.push(
      diff.length === 0
        ? item('各仓接活开关没被动过', true, `${n} 个仓和发版前一样（发版不动它们）`)
        : item('各仓接活开关没被动过', false, `和发版前不一样：${diff.join('；')}`),
    );
  }
  const prev = state.check ?? { items: [] };
  const all = [...prev.items, ...items.map(({ retry, ...x }) => x)];
  state.check = { ok: all.every((x) => x.ok), items: all, at: iso(io) };
  io.writeState(state);
  for (const x of items) say(io, `体检：${x.ok ? '[通过]' : '[没过]'} ${x.name}：${x.text}`);
}

/**
 * 7 恢复（现在是核对）：清暂停标记；这一趟不关总开关（决定 0093），所以只有我们关过的才开回——进这一步时 state.marker 为真：
 * 老现场那一支（第 2 步见上一回老版本关的、记了标记），或 restore 请求从老版本没成在这一步的那一趟接着走（runResume 置上）。
 * 开回去经 fleet-api engine on（写操作记录，原因写明是发版后恢复）。没开回成（读不到、开不回去、读回来还是关着）是「没成」：
 * 状态记 failed、页面上红、退出码 2，不当成成功；发版已经发出去了，到「法国」页点「恢复引擎开关」或环境页点开。
 * 不是我们关的就不碰总开关：发版前开着、现在被人关了也不开（checkSwitches 照实报不一致，要人看）。
 * 各仓「让 AI 接活」开关这个脚本和 release.sh 都不动：第 2 步记下发版前的样子（before.repos），
 * 由 checkSwitches 核对总开关和它们都和发版前一致（发后体检第二段，#2026）。
 */
async function phaseRestore(io, state) {
  const r = await restoreMaster(io, state);
  if (r.ok) await checkSwitches(io, state);
  return r;
}

async function restoreMaster(io, state) {
  const ours = state.marker === true;
  io.clearMarker();
  state.marker = false;
  waitOn(io, state, ours ? '把引擎总开关恢复到发版前' : '核对引擎总开关');
  const before = state.before;
  if (before === null || before === undefined || typeof before.master !== 'boolean') {
    return failed(
      '恢复没成：第 2 步没记下发版前的总开关状态（before 缺），不敢猜着开或关；发版已经发出去了，到驾驶舱环境页核对总开关',
    );
  }
  const eng = await engineRead(io);
  if (!eng.ok) return failed(`恢复没成（发版已经发出去了）：${eng.why}`);
  if (!ours) {
    const same = eng.on === before.master;
    say(
      io,
      `恢复：这一趟没关过引擎总开关，不碰它（发版前${before.master ? '开着' : '关着'}，现在${eng.on ? '开着' : '关着'}${same ? '' : '：发版期间有人动了，没替人改回，体检报不一致'}）`,
    );
    return { ok: true };
  }
  if (!before.master) {
    say(
      io,
      `恢复：法国引擎总开关发版前就关着，保持关${eng.on ? '（现在是开着的：发版期间有人开了，没动）' : ''}`,
    );
    return { ok: true };
  }
  if (!eng.on) {
    const resumed = state.resumes?.at(-1);
    const how = resumed?.kind === 'restore' ? `驾驶舱点击恢复引擎开关，${resumed.by}` : '驾驶舱点击发布';
    const on = await engineOn(
      io,
      `发版后恢复发版前的状态（${how}，目标 ${state.target.value.slice(0, 12)}）`,
    );
    if (!on.ok) {
      return failed(
        `恢复没成：发版已经发出去了，但发版前开着的引擎总开关没能开回：${on.why}。到驾驶舱「法国」页发版卡点「恢复引擎开关」（或环境页点开、fleet-api engine on）`,
      );
    }
  }
  say(io, '恢复：法国引擎总开关已开回（发版前开着）');
  return { ok: true };
}

async function phaseList(io, state) {
  state.result = { note: '驾驶舱点击发布不派清单；当前版本的清单到驾驶舱和 pnpm plan 看' };
  say(io, '派清单：跳过');
  return { ok: true };
}

const PHASE_FUNCS = [
  phasePreflight, // 0 预检：请求进来之前 preflight 已经核过；这里记发版前异常基线
  phasePauseLocal,
  phasePauseFrance,
  phaseWait,
  phaseRelease,
  phaseDeploy,
  phaseVerify,
  phaseRestore,
  phaseList,
];

/** 飞书上要点哪个按钮（一句话）：按停在哪一步、为什么停。 */
function buttonHint(state, kind) {
  if (kind === 'start') return '不用点什么，进度看驾驶舱「法国」页的发版卡';
  if (kind === 'done' || kind === 'retry' || kind === 'restore' || kind === 'aborted') return '不用点什么';
  if (kind === 'check') return '到驾驶舱「法国」页看发版卡里「发后体检」没通过的那几项';
  if (state.phase === 3)
    return '到驾驶舱「法国」页发版卡点「重试」（从第 3 步接着走，release.sh 切版本前自己暂停在跑的任务）；不走了点「撤掉暂停」';
  if (state.phase === 7 && state.pausedMaster !== false)
    return '版本已经发出去了，到驾驶舱「法国」页发版卡点「恢复引擎开关」';
  if (state.phase === 7)
    return '版本已经发出去了，到驾驶舱「法国」页看发版卡写的原因（这一趟没关过引擎总开关）';
  if (state.phase <= 3) return '到驾驶舱「法国」页看发版卡写的原因，处理好再点「发布到法国」（版本还没发）';
  return '到驾驶舱「法国」页看发版卡写的原因（版本可能已经发出去了）';
}

/**
 * 推给飞书的一句话（#2026）：目标提交、结果、要点哪个按钮。kind：start 开始、done 成功、check 发完但体检没通过（算卡住）、
 * blocked 卡住、failed 失败。
 */
export function releaseMessage(kind, state) {
  const sha = String(state.target?.value ?? '').slice(0, 12);
  const step = `第 ${state.phase} 步「${PHASES[state.phase] ?? '?'}」`;
  const bad = (state.check?.items ?? []).filter((x) => !x.ok).map((x) => x.name);
  const text = {
    start: `【发版开始】法国开始发 ${sha}（${state.requestedBy ?? '?'} 在驾驶舱点的）`,
    done: `【发版成功】法国已在用 ${sha}，发后体检通过，引擎总开关和各仓接活开关和发版前一致`,
    check: `【发版卡住】法国已在用 ${sha}，但发后体检没通过：${bad.join('、')}`,
    retry: `【发版重试】${sha} 从${step}接着走（${state.resumes?.at(-1)?.by ?? '?'} 在驾驶舱点的「重试」）`,
    restore: `【恢复引擎开关】${sha} 已发出，${state.resumes?.at(-1)?.by ?? '?'} 在驾驶舱点了「恢复引擎开关」，从第 7 步「恢复」接着走`,
    aborted: `【撤掉暂停】${sha ? `${sha} 那一趟` : '暂停标记'}已撤销：${state.why ?? ''}`,
    blocked: `【发版卡住】${sha} 停在${step}：${state.why ?? ''}`,
    failed: `【发版失败】${sha} ${step}没成：${state.why ?? ''}`,
  }[kind];
  return `${text}。${buttonHint(state, kind)}。`.replace(/\s+/g, ' ').slice(0, 900);
}

/** 哪几种要人看：进「要你拍」，后端马上推飞书；其余（开始、成功、重试、恢复、撤暂停）不写通知（level 为 null），只写进度记录。 */
export const RELEASE_ALERT_KINDS = ['check', 'blocked', 'failed'];
/** 发版提醒的键前缀（简报按它认「发版」这一类）。 */
export const RELEASE_NOTE_PREFIX = 'release:';

/** 这一条提醒怎么记：级别、键（同一趟同一种只一行；不同趟时刻不同）、标题（第一句）。 */
export function releaseNote(kind, state, text, now) {
  const sha = String(state.target?.value ?? '').slice(0, 12);
  return {
    kind,
    level: RELEASE_ALERT_KINDS.includes(kind) ? 'decision' : null,
    key: `${RELEASE_NOTE_PREFIX}${kind}:${sha}:${Math.floor(now.getTime() / 1000)}`,
    title: text.split('。')[0].slice(0, 200),
  };
}

/** 记一条发版提醒；记不进去只记下来（stderr、进度里的 pushes），不拦发版、不当成记过。 */
async function push(io, state, kind, persist = true) {
  const text = releaseMessage(kind, state);
  try {
    await io.notify(text, releaseNote(kind, state, text, io.now()));
    state.pushes.push({ kind, ok: true });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    state.pushes.push({ kind, ok: false, why });
    io.err(`发版提醒没记下（${kind}）：${why}`);
  }
  if (persist) io.writeState(state);
}

/** 这一趟的结局写进 last-request.json（驾驶舱读：发后体检结论）；写不进只记 stderr，进度记录里也有同一份。 */
function writeOutcome(io, state, req, outcome) {
  try {
    io.writeLast({
      v: 1,
      at: iso(io),
      outcome,
      sha: state.target?.value ?? req.sha,
      by: req.by,
      ...(req.kind !== 'release' ? { kind: req.kind } : {}),
      why: state.why,
      phase: state.phase,
      check: state.check,
      pushes: state.pushes,
    });
  } catch (e) {
    io.err(`结局没写进 ${LAST_FILE}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 入口：读一份请求、核、走一趟。io = {
 *   now(), sleep(ms), pid, pidAlive(pid), limits, out(text), err(text),
 *   readRequest() → safeReadRequest 的返回, readState() → { ok, state|null } | { ok: false, why }, writeState(state), writeLast(obj),
 *   writeMarker(obj), clearMarker(), releaseBusy() → Promise<boolean>（抛 = 没查成）,
 *   mainline(sha) → Promise<{ ok: true, onMain, at } | { ok: false, why }>（取最新主线、比祖先、给提交时间）,
 *   ciRuns() → Promise<{ status, body }>, fleetApi(args, timeoutMs) → Promise<{ status, stdout, stderr }>,
 *   drain() → Promise<{ ok: true, engineDown: boolean, running: {runId, stage}[] } | { ok: false, engineDown: boolean, why }>
 *     （引擎权威口径 drain.json，同 release.sh；第 3 步已不再读它（#2038），接口保留），
 *   prepareCheckout(sha) → Promise<{ ok, why? }>,
 *   runRelease(sha, timeoutMs) / releaseCheck(timeoutMs) → Promise<{ status, stdout, stderr, error? }>, historyLast() → Promise<{ ok, line? , why? }>,
 *   发后体检（#2026）：currentRelease() → Promise<{ ok, sha } | { ok: false, why }>（current 链接）、
 *   healthz() → Promise<{ status, body, error? }>（后端 /healthz）、mainHead(sha) → Promise<{ ok, sha, behind } | { ok: false, why }>
 *   （取最新主线，主线头和它比 sha 多几个提交）、repoSwitches() → Promise<{ ok, repos: { 仓: since|null } } | { ok: false, why }>，
 *   notify(text, note) → Promise<void>（记一条提醒进通知中心，note = releaseNote 的返回；记不进去就抛）,
 * }。返回退出码。
 */
export async function runRequest(io) {
  io = { ...io, limits: { ...LIMITS, ...(io.limits ?? {}) } };
  const raw = io.readRequest();
  if (raw.kind === 'none') {
    say(io, '没有发布请求');
    return EXIT.refused;
  }
  if (raw.kind === 'unsafe') return refuse(io, null, raw.why);
  const req = parseRequest(raw.text);
  if (!req.ok) return refuse(io, req, req.why);
  if (req.kind === 'abort') return runAbort(io, req);
  if (req.kind === 'retry' || req.kind === 'restore') return runResume(io, req);

  const why = await preflight(io, req);
  if (why !== null) return refuse(io, req, why);

  const state = newState(io, req);
  // 老现场：上一回停在「卡住」「没成」、发版前总开关开着、且那一趟关过总开关（老版本的记录没有 pausedMaster＝关过）：
  // 带过来（见 phasePauseFrance）；新版本那一趟没关过的、做完的、撤销的不带，这一回重新读
  const prevRead = io.readState();
  const prev = prevRead.ok ? prevRead.state : null;
  if (
    (prev?.status === 'blocked' || prev?.status === 'failed') &&
    prev.before?.master === true &&
    prev.pausedMaster !== false
  ) {
    state.before = prev.before;
  }
  io.writeLast({ v: 1, at: iso(io), outcome: 'accepted', sha: req.sha, by: req.by, why: null });
  say(io, `收到驾驶舱的发布请求：${req.sha.slice(0, 12)}，${req.by} 在 ${req.at} 点的`);
  await push(io, state, 'start');
  return runPhases(io, state, req, 0);
}

/** 从第 from 步起把九步走完；停下（卡住、没成）或做完都写结局、推飞书，回退出码。 */
async function runPhases(io, state, req, from) {
  for (let p = from; p < PHASE_FUNCS.length; p++) {
    state.phase = p;
    state.status = 'running';
    state.laggards = [];
    state.waiting = null;
    state.steps[p] = iso(io);
    io.writeState(state);
    say(io, `—— 第 ${p} 步「${PHASES[p]}」——`);
    let r;
    try {
      r = await PHASE_FUNCS[p](io, state);
    } catch (e) {
      r = failed(`这一步出错：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!r.ok) {
      state.status = r.kind === 'blocked' ? 'blocked' : 'failed';
      state.why = r.why;
      state.laggards = r.laggards ?? [];
      state.waiting = null;
      io.writeState(state);
      io.err(`第 ${p} 步「${PHASES[p]}」${r.kind === 'blocked' ? '卡住了' : '没成'}：${r.why}`);
      await push(io, state, state.status);
      writeOutcome(io, state, req, state.status);
      return r.kind === 'blocked' ? EXIT.blocked : EXIT.failed;
    }
  }
  state.status = 'done';
  state.why = null;
  state.waiting = null;
  io.writeState(state);
  const passed = state.check?.ok === true;
  say(io, passed ? '这一趟做完了，发后体检通过。' : '这一趟发完了，但发后体检没通过（看上面的 [没过]）。');
  await push(io, state, passed ? 'done' : 'check');
  writeOutcome(io, state, req, 'done');
  return passed ? EXIT.done : EXIT.blocked;
}

/**
 * 重试 / 恢复引擎开关（#2027）：接着上一趟停下的进度记录往下走，不从头暂停一遍。
 * - retry：只接「卡住在第 3 步等收尾」（老版本留下的）、目标就是请求里的提交；没发版，从第 3 步接着走（这一步现在直接过），往后照走；
 * - restore：只接「没成在第 7 步恢复」、发版前总开关是开着的、且那一趟关过总开关（pausedMaster 不是 false；老版本在这一步没成前
 *   已清了标记，这里置回 state.marker，第 7 步才知道要开回）；发版已经发出去了，从第 7 步重新把总开关开回、核对开关，再收尾。
 * 都核「没有发版在走、发布锁没被占」；retry 还核目标仍是主线祖先、CI 绿（同发布）。每一条拒绝都写原因，不动进度记录。
 */
async function runResume(io, req) {
  const retry = req.kind === 'retry';
  const word = retry ? '重试' : '恢复引擎开关';
  const read = io.readState();
  if (!read.ok) return refuse(io, req, `进度记录读不了，不敢接着走：${read.why}`);
  const prev = read.state;
  const want = retry ? { status: 'blocked', phase: 3 } : { status: 'failed', phase: 7 };
  if (!prev || prev.status !== want.status || prev.phase !== want.phase) {
    const at = prev
      ? `现在是「${prev.status}」，停在第 ${prev.phase} 步「${PHASES[prev.phase] ?? '?'}」`
      : '没有进度记录';
    return refuse(
      io,
      req,
      `没有可${word}的：只有停在第 ${want.phase} 步「${PHASES[want.phase]}」且状态是${retry ? '卡住' : '没成'}的一趟才行（${at}）`,
    );
  }
  if (retry && prev.target?.value !== req.sha) {
    return refuse(
      io,
      req,
      `重试的提交（${req.sha.slice(0, 12)}）不是卡住那一趟的目标（${String(prev.target?.value ?? '').slice(0, 12)}）：刷新页面再看`,
    );
  }
  if (!retry && prev.before?.master !== true) {
    return refuse(
      io,
      req,
      '发版前引擎总开关就是关着（或没记下）：没有要恢复的，不替人开引擎；要开到环境页点开',
    );
  }
  if (!retry && prev.pausedMaster === false) {
    return refuse(
      io,
      req,
      '这一趟没关过引擎总开关（决定 0093）：没有要恢复的，不替人开引擎；要开到环境页点开',
    );
  }
  const why = await preflight(io, retry ? req : { ...req, sha: prev.target?.value }, retry);
  if (why !== null) return refuse(io, req, why);

  const state = prev;
  state.status = 'running';
  state.why = null;
  state.laggards = [];
  state.waiting = null;
  state.via = 'cockpit';
  state.pid = io.pid;
  state.resumes = [
    ...(Array.isArray(prev.resumes) ? prev.resumes : []),
    { kind: req.kind, by: req.by, at: req.at },
  ];
  if (!Array.isArray(state.pushes)) state.pushes = [];
  if (!retry) state.marker = true; // 上面核过：这一趟关过总开关，第 7 步要开回
  io.writeLast({
    v: 1,
    at: iso(io),
    outcome: 'accepted',
    sha: state.target.value,
    by: req.by,
    kind: req.kind,
    why: null,
  });
  say(
    io,
    `收到驾驶舱的「${word}」请求：${req.by} 在 ${req.at} 点的；从第 ${want.phase} 步「${PHASES[want.phase]}」接着走`,
  );
  await push(io, state, req.kind);
  return runPhases(io, state, req, want.phase);
}

function writeAbortOutcome(io, req, sha, why, outcome = 'aborted') {
  try {
    io.writeLast({ v: 1, at: iso(io), outcome, sha, by: req.by, kind: 'abort', why });
  } catch (e) {
    io.err(`结局没写进 ${LAST_FILE}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 撤掉暂停（#2027，等价命令行 release-train abort）：清暂停标记；卡住或没成的一趟、总开关是我们关的（老版本），还没动手发版就开回暂停前的样子，
 * 已经动手发过版（release.started）就保持关（不知道发成没有、健康没确认），状态记 aborted；没有进度记录、只剩标记的，只清标记。
 * 发版在走（进程还活着）、发布锁被占着不动手；没有标记也没有没了结的一趟就拒（没什么可撤）。
 */
async function runAbort(io, req) {
  const read = io.readState();
  if (!read.ok) return refuse(io, req, `进度记录读不了，不敢动它：${read.why}`);
  const s = read.state;
  if (s?.status === 'running' && Number.isInteger(s.pid) && s.pid !== io.pid && io.pidAlive(s.pid)) {
    return refuse(io, req, `发版还在走（进程 ${s.pid}，第 ${s.phase} 步）：不能撤，等它停下`);
  }
  let busy;
  try {
    busy = await io.releaseBusy();
  } catch (e) {
    return refuse(io, req, `看发布锁没成（${e instanceof Error ? e.message : String(e)}），按有发布在跑算`);
  }
  if (busy) return refuse(io, req, '已有发布在跑（发布锁被占着）：不动');
  const open = s !== null && s !== undefined && s.status !== 'done' && s.status !== 'aborted';
  if (!open && !io.markerExists()) {
    return refuse(io, req, '没有暂停标记，也没有没了结的一趟：没什么要撤的');
  }
  io.writeLast({
    v: 1,
    at: iso(io),
    outcome: 'accepted',
    sha: s?.target?.value ?? null,
    by: req.by,
    kind: 'abort',
    why: null,
  });
  say(io, `收到驾驶舱的「撤掉暂停」请求：${req.by} 在 ${req.at} 点的`);
  if (!open) {
    io.clearMarker();
    const why = '没有在走的一趟：暂停标记是留下来的，已清；引擎总开关没动';
    say(io, why);
    await push(
      io,
      { target: { value: s?.target?.value ?? '' }, phase: 0, why, pushes: [] },
      'aborted',
      false,
    );
    writeAbortOutcome(io, req, s?.target?.value ?? null, why);
    return EXIT.done;
  }
  const target = String(s.target?.value ?? '').slice(0, 12);
  let note;
  const paused = s.before?.master === true && s.pausedMaster !== false;
  if (s.pausedMaster === false) {
    note = '这一趟没关过引擎总开关（决定 0093），没动';
  } else if (paused && !s.release?.started) {
    const on = await engineOn(
      io,
      `撤销发版暂停，恢复暂停前的样子（驾驶舱点击撤掉暂停，${req.by}，目标 ${target}）`,
    );
    if (!on.ok) {
      s.why = `撤掉暂停没成：总开关没能开回去（${on.why}）；暂停标记还留着，再点一次，或到环境页点开`;
      io.writeState(s);
      io.err(s.why);
      writeAbortOutcome(io, req, s.target?.value ?? null, s.why, 'failed');
      return EXIT.failed;
    }
    note = '还没动手发版：引擎总开关已开回暂停前的样子（开着）；各仓「让 AI 接活」开关暂停期间没动过';
  } else if (s.release?.started) {
    note = paused
      ? '已经动手发过版：不知道发成没有、健康没确认，引擎总开关保持关（发版前是开着的）；确认没事后到环境页点开'
      : '已经动手发过版：引擎总开关发版前就是关着的，保持关';
  } else {
    note = '引擎总开关暂停前就是关着的（或还没暂停），没动';
  }
  io.clearMarker();
  s.status = 'aborted';
  s.marker = false;
  s.why = `驾驶舱撤销（${req.by}）：${note}`;
  s.waiting = null;
  io.writeState(s);
  say(io, `撤掉暂停（目标 ${target}，停在第 ${s.phase} 步）：${note}`);
  await push(io, s, 'aborted');
  writeAbortOutcome(io, req, s.target?.value ?? null, s.why);
  return EXIT.done;
}

/** 起 fleet-api 的参数（真 io 和测试都用同一份写法）。 */
export const fleetApiCommand = (args) => `${FLEET_API} ${args}`;
