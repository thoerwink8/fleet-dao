// 驾驶舱「发布到法国」按钮的接活（法国，root）：驾驶舱后端（fleet，没有 root）只往 /var/lib/fleet-dao/release-request/request.json 写一份请求，
// root 的 fleet-release-request.path 盯着它，起 fleet-release-request.service 跑这里：核请求 → 走一趟和 release-train 同样的发版
// （暂停法国引擎总开关、等在跑的会话收尾、release.sh <提交>、验证、发完保持关）→ 进度写进 /srv/fleet-dao-releases/.train/release-train.json
// （和 agents/skills/commander/scripts/release-train-lib.mjs 同一个格式，驾驶舱的 /france 页读它）。
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
// - 退出码：0 做完了；1 被拒（或没有请求）；2 没做成（命令失败）；3 卡住（等收尾到点还有会话在跑，再点一次从头走，现场没动）。
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { ciVerdict } from '../auto-release/lib.mjs';

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
export const AGENT_SCOPE = '/usr/local/sbin/fleet-agent-scope';
export const HISTORY_FILE = `${RELEASES}/.history`;
export const MAX_REQUEST_BYTES = 1024;
/** 页面和火车的第几步（同 release-train-lib.mjs 的 PHASES 数组下标）。 */
export const PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];
/** 写进 founderOk 的话：这一点击就是「对外发布」那一道人闸的同意（创始人 2026-10-07 同意这个设计）。 */
export const FOUNDER_WORD = '驾驶舱点击发布（创始人）';
/** 各步上限（毫秒）；测试里整份换小。service 的 TimeoutStartSec 必须比这些加起来大（release-request.test.mjs 核对）。 */
export const LIMITS = {
  sessionsMs: 13 * 60_000,
  pollMs: 30_000,
  releaseMs: 30 * 60_000,
  deployMs: 3 * 60_000,
  checkMs: 5 * 60_000,
  stepMs: 2 * 60_000,
};
export const EXIT = { done: 0, refused: 1, failed: 2, blocked: 3 };

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

/** 请求文件的内容：后端 JSON.stringify({ v, sha, at, by }) 写的，键和样子都固定；认不出一律 { ok: false, why }。 */
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
  if (keys !== 'at,by,sha,v') return { ok: false, why: `请求文件的键不对（${keys.slice(0, 60)}）`, sha, by };
  if (o.v !== 1) return { ok: false, why: '请求文件的版本不是 1', sha, by };
  if (sha === null) return { ok: false, why: '提交号不是完整的 40 位小写十六进制', sha, by };
  if (by === null) return { ok: false, why: '「谁点的」不合格（只收字母数字和 _.@ -，最长 64）', sha, by };
  if (typeof o.at !== 'string' || !AT.test(o.at) || Number.isNaN(Date.parse(o.at))) {
    return { ok: false, why: '请求里的时间不是 UTC 的 ISO 时间', sha, by };
  }
  return { ok: true, sha, at: o.at, by };
}

// —— 一次请求 ——

const iso = (io) => io.now().toISOString();

async function refuse(io, req, why) {
  const sha = req?.sha ?? null;
  io.err(`拒绝：${why}`);
  try {
    io.writeLast({ v: 1, at: iso(io), outcome: 'refused', sha, by: req?.by ?? null, why });
  } catch (e) {
    io.err(`拒绝的原因也没写进 ${LAST_FILE}：${e instanceof Error ? e.message : String(e)}`);
  }
  return EXIT.refused;
}

/** 核请求本身（只读）：回 null 通过，或拒绝的原因。各条一条故意造出失败的测试。 */
async function preflight(io, req) {
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
    restore: false,
    before: null,
    baseline: null,
    marker: false,
    laggards: [],
    release: {},
    why: null,
    via: 'cockpit',
    requestedBy: req.by,
    requestedAt: req.at,
    pid: io.pid,
  };
}

const failed = (why) => ({ ok: false, kind: 'failed', why });
const blocked = (why, laggards = []) => ({ ok: false, kind: 'blocked', why, laggards });

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

async function engineOff(io, reason) {
  const r = await io.fleetApi(`engine off --reason ${shq(reason)}`, io.limits.stepMs);
  if (r.status !== 0) return { ok: false, why: `fleet-api engine off 没成：${tail(r.stderr || r.stdout)}` };
  const back = await engineRead(io);
  if (!back.ok) return { ok: false, why: `关完读回失败：${back.why}` };
  if (back.on) return { ok: false, why: 'engine off 说成了，读回来总开关还是开着：不往下走' };
  return { ok: true };
}

const say = (io, text) => io.out(text);

async function phasePauseLocal(io) {
  say(io, '暂停本机：跳过（法国上没有指挥官本机的工人，本机暂停标记不适用）');
  return { ok: true };
}

async function phasePauseFrance(io, state) {
  const now = await engineRead(io);
  if (!now.ok) return failed(now.why);
  if (!now.on) {
    state.before = { master: false, repos: null, recordedAt: iso(io) };
    io.writeState(state);
    say(io, '暂停法国：跳过（引擎总开关本来就关着，没什么要暂停的）');
    return { ok: true };
  }
  state.before = { master: true, repos: null, recordedAt: iso(io) };
  io.writeState(state);
  const off = await engineOff(io, `发版前暂停（驾驶舱点击发布，目标 ${state.target.value.slice(0, 12)}）`);
  if (!off.ok) return failed(off.why);
  io.writeMarker({ since: iso(io), target: state.target.value.slice(0, 12), by: 'release-request' });
  state.marker = true;
  io.writeState(state);
  say(io, '暂停法国：总开关已关（暂停前开着）');
  return { ok: true };
}

/** 等法国在跑的会话收尾（fleet-agent-scope list：每行「编号 状态」，状态不是 inactive、failed 的算在跑）。读不到不当成 0。 */
async function phaseWait(io) {
  const started = io.now().getTime();
  let last = '';
  for (;;) {
    const s = await io.sessions();
    if (!s.ok) return failed(`法国在跑几个会话读不到：${s.why}`);
    if (s.running.length === 0) {
      say(io, '等收尾：法国没有会话在跑');
      return { ok: true };
    }
    const line = `等收尾：法国在跑 ${s.running.length} 个会话（${s.running.join(' ')}）`;
    if (line !== last) say(io, line);
    last = line;
    const waited = io.now().getTime() - started;
    if (waited >= io.limits.sessionsMs) {
      const laggards = s.running.map((n) => `会话 ${n}`);
      return blocked(
        `等了 ${minutes(waited)} 分钟，法国还有 ${s.running.length} 个会话在跑（现场没动：引擎总开关已关、没发版；再点一次从头走）`,
        laggards,
      );
    }
    await io.sleep(io.limits.pollMs);
  }
}

async function phaseRelease(io, state) {
  if (typeof state.founderOk !== 'string' || state.founderOk.trim() === '') {
    return failed('发版是对外发布，必须有创始人的同意（founderOk）：没有，不发');
  }
  const sha = state.target.value;
  state.release = { ...(state.release ?? {}), started: true };
  io.writeState(state);
  const prep = await io.prepareCheckout(sha);
  if (!prep.ok) return failed(`部署检出没准备好：${prep.why}`);
  say(io, `发版：跑 release.sh ${sha.slice(0, 12)}（${state.founderOk}）`);
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
  const chk = await io.releaseCheck(io.limits.checkMs);
  if (chk.error || chk.status === null)
    return failed(`release.sh --check 没跑成：${tail(chk.error ?? chk.stderr)}`);
  if (chk.status === 1) return failed(`release.sh --check 有红：${tail(chk.stderr || chk.stdout, 5)}`);
  return { ok: true };
}

async function phaseVerify(io) {
  const eng = await engineRead(io);
  if (!eng.ok) return failed(eng.why);
  say(io, `验证：release.sh --check 没有红；法国引擎总开关${eng.on ? '开着' : '关着'}`);
  return { ok: true };
}

/** 7 恢复：清暂停标记；引擎总开关发完保持关（不替创始人开），开着就关回去。 */
async function phaseRestore(io, state) {
  io.clearMarker();
  state.marker = false;
  io.writeState(state);
  const eng = await engineRead(io);
  if (!eng.ok) return failed(eng.why);
  if (eng.on) {
    const off = await engineOff(
      io,
      `发版后默认保持关（驾驶舱点击发布，目标 ${state.target.value.slice(0, 12)}）`,
    );
    if (!off.ok) return failed(off.why);
  }
  say(io, '恢复：法国引擎总开关保持关，要开到驾驶舱环境页点开');
  return { ok: true };
}

async function phaseList(io, state) {
  state.result = { note: '驾驶舱点击发布不派清单；当前版本的清单到驾驶舱和 pnpm plan 看' };
  say(io, '派清单：跳过');
  return { ok: true };
}

const PHASE_FUNCS = [
  async () => ({ ok: true }), // 0 预检：进来之前 preflight 已经做完
  phasePauseLocal,
  phasePauseFrance,
  phaseWait,
  phaseRelease,
  phaseDeploy,
  phaseVerify,
  phaseRestore,
  phaseList,
];

/**
 * 入口：读一份请求、核、走一趟。io = {
 *   now(), sleep(ms), pid, pidAlive(pid), limits, out(text), err(text),
 *   readRequest() → safeReadRequest 的返回, readState() → { ok, state|null } | { ok: false, why }, writeState(state), writeLast(obj),
 *   writeMarker(obj), clearMarker(), releaseBusy() → Promise<boolean>（抛 = 没查成）,
 *   mainline(sha) → Promise<{ ok: true, onMain, at } | { ok: false, why }>（取最新主线、比祖先、给提交时间）,
 *   ciRuns() → Promise<{ status, body }>, fleetApi(args, timeoutMs) → Promise<{ status, stdout, stderr }>,
 *   sessions() → Promise<{ ok: true, running: string[] } | { ok: false, why }>, prepareCheckout(sha) → Promise<{ ok, why? }>,
 *   runRelease(sha, timeoutMs) / releaseCheck(timeoutMs) → Promise<{ status, stdout, stderr, error? }>, historyLast() → Promise<{ ok, line? , why? }>,
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

  const why = await preflight(io, req);
  if (why !== null) return refuse(io, req, why);

  const state = newState(io, req);
  io.writeLast({ v: 1, at: iso(io), outcome: 'accepted', sha: req.sha, by: req.by, why: null });
  say(io, `收到驾驶舱的发布请求：${req.sha.slice(0, 12)}，${req.by} 在 ${req.at} 点的`);
  for (let p = 0; p < PHASE_FUNCS.length; p++) {
    state.phase = p;
    state.status = 'running';
    state.laggards = [];
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
      io.writeState(state);
      io.err(`第 ${p} 步「${PHASES[p]}」${r.kind === 'blocked' ? '卡住了' : '没成'}：${r.why}`);
      return r.kind === 'blocked' ? EXIT.blocked : EXIT.failed;
    }
  }
  state.status = 'done';
  state.why = null;
  io.writeState(state);
  say(io, '这一趟做完了。');
  return EXIT.done;
}

/** 起 fleet-api 的参数（真 io 和测试都用同一份写法）。 */
export const fleetApiCommand = (args) => `${FLEET_API} ${args}`;
