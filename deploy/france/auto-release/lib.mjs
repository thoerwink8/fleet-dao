// 自动发布（法国，root；fleet-auto-release.timer 每 5 分钟拉起一轮）：主线上比在用的新、CI 全绿的最新一个提交（主线头的
// CI 还在跑、红了，就沿主线往回找），等引擎空闲后用 deploy/release.sh 发到本机，发完把各家 AI 的规矩同步给会话用户；
// 每一轮的读数写进状态文件，后端的 /healthz 读它现算「跟不跟得上主线」。规矩和由来见 docs/ops.md 第九节「自动发布」。
// 这里是判断和「跑一轮」的流程；和系统打交道的（git、GitHub 接口、会话、发布脚本、库）都从 io 进来：真的在
// fleet-auto-release.mjs，测试换成假的（deploy/test/auto-release.test.mjs）。
// 改这里之前必须知道：
// - 状态文件后端也读（packages/api/src/deploy-lag.ts 按 STATE_SCHEMA 认），改字段两边一起改，那边的测试拿这里造的状态核对。
// - RULES_USERS 要和 deploy/france.sh 的 AGENT_RULES_USERS 一样；INSTALL_PATHS 要盖住 france.sh 读的仓里文件（测试都核对）。
// - 读不到、认不出的一律记成「没查成」、不发，不拿空、0 当没事（AGENTS.md「底线」）。
// - 每一轮还拿法国 /etc/fleet-dao 下的环境文件跟在用那一版里的期望（deploy/france/desired-config.json）对账（#323，config.mjs）：
//   一项一条报警，线上的值不进报警和状态文件。
import { DESIRED_FILE, judgeConfig } from './config.mjs';

export const STATE_SCHEMA = 1;
export const RELEASES = '/srv/fleet-dao-releases';
export const AUTO_DIR = `${RELEASES}/.auto`;
export const STATE_FILE = `${AUTO_DIR}/state.json`;
/** deploy/france.sh 跑完没红时写：它装到了哪个提交（`commit=<提交号>`）。 */
export const APPLIED_FILE = `${AUTO_DIR}/france-applied`;
/** 部署脚本所在的检出（france.sh、release.sh 都从这里跑）：发之前快进到要发的那个提交。 */
export const CHECKOUT = '/srv/fleet-dao';
export const REPO = 'thoerwink8/fleet-dao';
/** 状态里留主线最近多少个提交（后端据此数落后几个）；在用的版本不在里面，后端报「落后太多」或「不在主线上」。 */
export const MAIN_HISTORY = 300;
/** 引擎有会话在跑时最多等这么久：到点照发（会话按编号续上，design 第四节「会话断了接着干」），不无限等。 */
export const IDLE_WAIT_MS = 60 * 60_000;
/** 只认这个工作流在 main 上那次 push 的结论（其余几个工作流看的是 GitHub 上的现状，不是这份代码好不好）。 */
export const CI_WORKFLOW = '.github/workflows/ci.yml';
/**
 * 一轮读一次主线最近这么多次 ci.yml 的运行（一次问完，候选都从这一份里判；不带凭据一个钟头只有 60 次）。
 * 比这更早的提交查不到结论，当没查成、跳过——落后这么多，后端早就报红了。
 */
export const CI_RUNS_PAGE = 100;
/** 提交落到主线这么久还查不到它的 CI 记录：不再当「还没开跑」，记没查成。 */
export const CI_NO_RUN_MS = 30 * 60_000;
/** 规矩同步给谁：和 deploy/france.sh 的 AGENT_RULES_USERS 同一份（会话用户、创始人的登录用户）。 */
export const RULES_USERS = ['fleet-agent-carpool', 'pilot'];
/**
 * 装机脚本（france.sh）管的仓里文件：主线上这些改了、france.sh 还没重跑，就是装机层落后。它碰防火墙、sudoers，不自动跑，
 * 只标出来。发布脚本自己从每一版里取的（两个应用单元、网关打包脚本）不算。
 */
export const INSTALL_PATHS = [
  'deploy/france.sh',
  'deploy/lib/',
  'deploy/france/',
  ':(exclude)deploy/france/fleet-engine.service',
  ':(exclude)deploy/france/fleet-api.service',
  ':(exclude)deploy/france/bundle-gateway.sh',
  // 配置的期望跟着版本走（对账拿在用那一版里的），改了它不用重跑 france.sh
  `:(exclude)${DESIRED_FILE}`,
];
/**
 * 这边发的报警都以它开头：发布没成 `auto-release:failed:<提交号>`，规矩同步没成 `auto-release:rules:<提交号>`，
 * 配置和期望不一致 `auto-release:config:<文件>:<键>`（一项一条），配置没查成 `auto-release:config-unchecked`。
 */
export const ALERT_PREFIX = 'auto-release:';
export const FAILED_PREFIX = `${ALERT_PREFIX}failed:`;
export const RULES_PREFIX = `${ALERT_PREFIX}rules:`;
export const CONFIG_PREFIX = `${ALERT_PREFIX}config:`;
export const CONFIG_UNCHECKED_KEY = `${ALERT_PREFIX}config-unchecked`;
/** release.sh --auto 的两种「这次不发、什么都没动」：另一个发布在跑；切之前又看到会话在跑。 */
export const EXIT_RELEASE_BUSY = 75;
export const EXIT_SESSIONS_BUSY = 76;

const SHA = /^[0-9a-f]{40}$/;
const SWITCHES = new Set(['release', 'rollback', 'auto-rollback']);
const EVENTS = new Set([...SWITCHES, 'unhealthy', 'recovered']);

export const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 12) : '（没有）');
const iso = (d) => new Date(d).toISOString();
const why = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 400);
const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));

/** `git log --first-parent --format='%H %cI'`：新的在前。认不出一行就抛，不拿半截当全部。 */
export function parseMainLog(text) {
  const commits = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
    const at = m ? Date.parse(m[2]) : Number.NaN;
    if (!m || Number.isNaN(at)) throw new Error(`主线的提交列表里有认不出的一行：${line.slice(0, 80)}`);
    commits.push({ sha: m[1], at: iso(at) });
  }
  if (commits.length === 0) throw new Error('主线的提交列表是空的');
  return commits;
}

/** 发布历史（release.sh 的 .history）：一行「时间 提交号 事件 [unmerged] [auto]」。认不出的行抛：拿不准人动没动过手。 */
export function parseHistory(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const [at = '', sha = '', event = '', ...tags] = line.split(/\s+/);
    if (Number.isNaN(Date.parse(at)) || !SHA.test(sha) || !EVENTS.has(event)) {
      throw new Error(`发布历史里有认不出的一行：${line.slice(0, 100)}`);
    }
    out.push({ at: iso(Date.parse(at)), sha, event, tags });
  }
  return out;
}

/** 人最近一次手动切的版本（不带 auto 的 release / rollback / auto-rollback）；没有就是 null。 */
export function lastManualSwitch(history) {
  let last = null;
  for (const h of history) if (!h.tags.includes('auto') && SWITCHES.has(h.event)) last = h;
  if (!last) return null;
  return { since: last.at, sha: last.sha, event: last.event, unmerged: last.tags.includes('unmerged') };
}

/**
 * 人最近一次手动切的版本之后，主线上还没有更新的提交：不自动发——不跟人打架（手动退回了坏版本、合并前在真机上验）。
 * 主线出了新提交（修复、那个 PR 合进来）再接着自动发，那之前合进来的（含人退回掉的那个）一律不自动发（releasable）。
 * 对照：Argo CD 开着自动同步不许手动回滚，要先关自动同步；这里不用关，人切一下就算按住。
 */
export function manualHold(history, headAt) {
  const last = lastManualSwitch(history);
  if (!last || Date.parse(headAt) > Date.parse(last.since)) return null;
  return last;
}

/** 这个提交在历史里最后一件事是「不健康」（发过、没过健康检查）：不自动再发，等新提交。 */
export function judgedUnhealthy(history, sha) {
  let last = '';
  for (const h of history) if (h.sha === sha) last = h.event;
  return last === 'unhealthy';
}

/**
 * 这一轮能发的提交 candidates（新的在前，有的话第一个就是主线头）。hold：人按住了、主线头也在按住之前（这时 candidates
 * 是空的）；failed：往回找停在了哪个发过没成的提交上（它是主线头时 candidates 是空的）；stop：停在人按住、发过没成那儿时
 * 人看的一句（停在在用的那儿不用说）。只往前走，往回找到下面三处里最近的一处就停：
 * - 在用的：主线按 --first-parent 排，排在它前面的都是它的后代。在用的不在主线最近的提交里（还没发布过、落后太多、
 *   没合进主线的），主线上的都算比它新——没合进主线的是人手动发的，由下一条管住。
 * - 人最近一次手动切版本那一刻：那之前合进主线的（含人退回掉的那个）一律不自动发（manualHold）。
 * - 发过没成的：自动发布没成（attempt）、发过没过健康检查（历史里最后是 unhealthy，状态文件丢了也认得）——它和比它旧的
 *   都不再自动试，等主线出比它新的全绿提交。不往回挑它前面没试过的：没成的原因可能在机器上（香港不通、配置坏了），
 *   往回一个个试就是一轮轮重启服务、一条条报警。
 */
export function releasable(commits, current, history, attempt) {
  const at = commits.findIndex((c) => c.sha === current);
  let end = at >= 0 ? at : commits.length;
  let hold = null;
  let stop = '';
  const manual = lastManualSwitch(history);
  if (manual) {
    const i = commits.findIndex((c) => Date.parse(c.at) <= Date.parse(manual.since));
    if (i >= 0 && i < end) {
      end = i;
      if (i === 0) hold = manual;
      stop = `人 ${manual.since} 手动${manual.event === 'rollback' ? '退回' : '切'}版本之前合进来的不自动发`;
    }
  }
  let failed = null;
  for (let i = 0; i < end; i++) {
    const { sha } = commits[i];
    if (attempt?.sha === sha && attempt.result === 'failed') {
      failed = { sha, why: `自动发过、没成（${attempt.endedAt ?? attempt.startedAt}）` };
    } else if (judgedUnhealthy(history, sha)) {
      failed = { sha, why: '发过、没过健康检查' };
    } else continue;
    end = i;
    stop = `${short(sha)} ${failed.why}，它和比它旧的不再自动发`;
    break;
  }
  return { candidates: commits.slice(0, end), hold, failed, stop };
}

/**
 * GitHub「列出工作流运行」的回答（不带凭据：主线上 ci.yml 最近那些次 push 触发的运行）里，这个提交在 main 上那次 ci.yml
 * 的结论：green 全绿 / red 跑完了但不是 success（含被后面的推送挤掉的 cancelled）/ pending 还没跑完或还没开跑 /
 * unknown 认不出、查不到。只有 green 能发。at 是这个提交落到主线的时间（刚合进来查不到算还没开跑）。
 */
export function ciVerdict(body, sha, at, now) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.workflow_runs)) {
    return { verdict: 'unknown', detail: 'GitHub 回的不是运行列表' };
  }
  const runs = body.workflow_runs.filter(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      r.head_sha === sha &&
      r.event === 'push' &&
      r.head_branch === 'main' &&
      typeof r.path === 'string' &&
      (r.path === CI_WORKFLOW || r.path.startsWith(`${CI_WORKFLOW}@`)),
  );
  if (runs.length === 0) {
    if (now - Date.parse(at) < CI_NO_RUN_MS) return { verdict: 'pending', detail: 'CI 还没开跑' };
    return {
      verdict: 'unknown',
      detail: `CI 查不到（落到主线 ${minutes(now - Date.parse(at))} 分钟了还没有它的运行记录）`,
    };
  }
  const n = (v) => (Number.isFinite(v) ? v : -1);
  runs.sort(
    (a, b) =>
      n(b.run_number) - n(a.run_number) ||
      n(b.run_attempt) - n(a.run_attempt) ||
      String(b.created_at).localeCompare(String(a.created_at)),
  );
  const run = runs[0];
  if (run.status !== 'completed') return { verdict: 'pending', detail: `CI 在跑（${run.status}）` };
  if (run.conclusion === 'success') return { verdict: 'green', detail: `CI 全绿（第 ${run.run_number} 次）` };
  return { verdict: 'red', detail: `CI 结论是 ${run.conclusion ?? '空'}（第 ${run.run_number} 次）` };
}

/** fleet-agent-scope list 的输出：一行「编号 状态」。返回还没停的会话编号；认不出一行就抛（调用方按忙算）。 */
export function parseScopes(text) {
  const busy = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^(\S+) (\S+)$/.exec(line);
    if (!m) throw new Error(`会话列表里有认不出的一行：${line.slice(0, 80)}`);
    if (m[2] !== 'inactive' && m[2] !== 'failed') busy.push(m[1]);
  }
  return busy;
}

/** 上一轮留下的状态里，这一轮接着用的几样；认不出（第一次跑、版本不对）就从空的起。 */
export function carryOver(prev) {
  const p = typeof prev === 'object' && prev !== null && prev.schema === STATE_SCHEMA ? prev : {};
  return {
    schema: STATE_SCHEMA,
    ranAt: null,
    main: p.main ?? null,
    mainError: null,
    current: p.current ?? null,
    ci: p.ci ?? null,
    hold: null,
    waitingSince: p.waitingSince ?? null,
    busy: null,
    attempt: p.attempt ?? null,
    rules: p.rules ?? null,
    system: p.system ?? null,
    config: null,
    alerts: Array.isArray(p.alerts) ? p.alerts : [],
    resolve: Array.isArray(p.resolve) ? p.resolve : [],
    resolveKeys: Array.isArray(p.resolveKeys) ? p.resolveKeys : [],
    last: null,
  };
}

/**
 * 跑一轮。io 见 fleet-auto-release.mjs 的 realIo（测试给假的）。返回这一轮的状态（调用方写文件）；中途要人看的写进 alerts，
 * 最后统一发、发不成下一轮再发。发布跑起来之前先存一次状态，后端这时看得到「在发」。
 */
export async function runOnce(io, prev) {
  const now = io.now();
  const st = carryOver(prev);
  st.ranAt = iso(now);
  const current = await deployStep(io, st, now);
  if (current !== undefined) await rulesStep(io, st, now, current);
  await configStep(io, st, io.now());
  await flushAlerts(io, st);
  return st;
}

function act(st, now, action, detail = '') {
  st.last = { action, detail, at: iso(now) };
}

/** 记一条要发的报警（同一个 key 只留最新的一条）；真发在 flushAlerts，发不成下一轮再发。 */
function raise(st, key, title, body) {
  st.alerts = st.alerts.filter((a) => a.key !== key);
  st.alerts.push({ key, title, body, raised: false });
}

/** 事情好了：这个前缀下还没发出去的不发了；发出去了的记下来解除（没发过的不去碰库）。 */
function resolveLater(st, prefix) {
  const mine = st.alerts.filter((a) => a.key.startsWith(prefix));
  if (mine.length === 0) return;
  st.alerts = st.alerts.filter((a) => !a.key.startsWith(prefix));
  if (mine.some((a) => a.raised) && !st.resolve.includes(prefix)) st.resolve.push(prefix);
}

/** 一直在的报警（配置对账那种，每一轮都判一次）：和上一轮一模一样就不动（不每 5 分钟重发一次），变了才重发。 */
function keepRaised(st, key, title, body) {
  const had = st.alerts.find((a) => a.key === key);
  if (had && had.title === title && had.body === body) return;
  raise(st, key, title, body);
}

/** 按整个键解除一条（配置对账一项一条，键之间可能是前缀关系，不能按前缀解除）。 */
function resolveKeyLater(st, key) {
  const had = st.alerts.find((a) => a.key === key);
  if (!had) return;
  st.alerts = st.alerts.filter((a) => a.key !== key);
  if (had.raised && !st.resolveKeys.includes(key)) st.resolveKeys.push(key);
}

/** 发布那一半：返回在用的提交号（读到了，含「还没发布过」的 null），读不到返回 undefined（规矩那一半也不做）。 */
async function deployStep(io, st, now) {
  let commits;
  try {
    commits = parseMainLog(await io.readMain());
  } catch (e) {
    st.mainError = why(e);
    act(st, now, 'main-unreadable', st.mainError);
    return undefined;
  }
  const head = commits[0];
  st.main = {
    checkedAt: iso(now),
    head: head.sha,
    headAt: head.at,
    commits: commits.slice(0, MAIN_HISTORY).map((c) => [c.sha, c.at]),
  };
  st.system = await systemLayer(io, head.sha);

  let current;
  try {
    current = await io.readCurrent();
  } catch (e) {
    act(st, now, 'current-unreadable', why(e));
    return undefined;
  }
  st.current = current;
  if (st.attempt?.result === 'running') {
    // 上一轮的发布没收到结果（那一轮被杀了、机器重启了）：发布锁还占着就接着等，空了按现在在用的是谁定成败
    let still;
    try {
      still = await io.releaseBusy();
    } catch (e) {
      act(st, now, 'release-busy', `上一轮的自动发布还在不在跑没查成：${why(e)}`);
      return current;
    }
    if (still) {
      act(st, now, 'release-busy', `上一轮的自动发布（${short(st.attempt.sha)}）还在跑`);
      return current;
    }
    settleDangling(st, now, current);
  }

  if (current === head.sha) {
    st.waitingSince = null;
    resolveLater(st, FAILED_PREFIX);
    act(st, now, 'up-to-date');
    return current;
  }

  let history;
  try {
    history = parseHistory(await io.readHistory());
  } catch (e) {
    act(st, now, 'history-unreadable', why(e));
    return current;
  }
  const { candidates, hold, failed, stop } = releasable(commits, current, history, st.attempt);
  if (candidates.length === 0) {
    // 这几种「主线头不发」：之前等空闲的钟不接着走，下一个要发的从头等
    st.waitingSince = null;
    if (hold) {
      st.hold = hold;
      act(
        st,
        now,
        'hold',
        `人 ${hold.since} 手动${hold.event === 'rollback' ? '退回' : '切'}到 ${short(hold.sha)}${hold.unmerged ? '（没合进主线的提交）' : ''}，主线上还没有更新的提交`,
      );
    } else {
      act(st, now, 'failed-before', `这个提交${failed?.why ?? '找不到能发的'}，等主线出新提交`);
    }
    return current;
  }

  const pick = await pickTarget(io, st, now, candidates, stop);
  if (!pick.target) {
    if (pick.verdict === 'red') st.waitingSince = null;
    act(st, now, `ci-${pick.verdict}`, pick.detail);
    return current;
  }
  // 要发的：主线头全绿就是它；不然是往回找到的最新全绿提交（via 说为什么不是主线头）
  const target = pick.target.sha;
  const via = pick.via ? `：${pick.via}` : '';

  let releaseBusy;
  try {
    releaseBusy = await io.releaseBusy();
  } catch (e) {
    act(st, now, 'release-busy', `另一个发布在不在跑没查成：${why(e)}`);
    return current;
  }
  if (releaseBusy) {
    act(st, now, 'release-busy', '另一个发布在跑');
    return current;
  }

  let checkout;
  try {
    checkout = await io.prepareCheckout(target);
  } catch (e) {
    checkout = { ok: false, why: why(e) };
  }
  if (!checkout.ok) {
    act(st, now, 'checkout-blocked', checkout.why);
    return current;
  }

  const waited = st.waitingSince ? now - Date.parse(st.waitingSince) : 0;
  const busyOk = st.waitingSince !== null && waited >= IDLE_WAIT_MS;
  if (!busyOk) {
    let busy;
    try {
      busy = parseScopes(await io.sessions());
    } catch (e) {
      busy = [`（会话在不在跑没查成：${why(e)}）`];
    }
    if (busy.length > 0) {
      st.waitingSince ??= iso(now);
      st.busy = busy.join(' ');
      act(
        st,
        now,
        'wait-idle',
        `引擎有会话在跑（${st.busy}），等空闲，最多等到 ${iso(Date.parse(st.waitingSince) + IDLE_WAIT_MS)}；要发的是 ${short(target)}${via}`,
      );
      return current;
    }
  }

  const before = st.attempt;
  st.attempt = {
    sha: target,
    startedAt: iso(now),
    endedAt: null,
    result: 'running',
    busyOk,
    code: null,
    detail: '',
    log: '',
  };
  act(
    st,
    now,
    'releasing',
    `${busyOk ? `等空闲等了 ${minutes(waited)} 分钟，照发；` : ''}发 ${short(target)}${via}`,
  );
  try {
    await io.save(st);
  } catch (e) {
    // 记不下「在发」就不发：发到一半这一轮没了，下一轮连发过什么都不知道
    st.attempt = before;
    act(st, now, 'state-unwritable', `状态文件写不进去，这轮不发：${why(e)}`);
    return current;
  }
  let r;
  try {
    r = await io.runRelease(target, busyOk);
  } catch (e) {
    r = { code: -1, detail: `发布脚本起不来：${why(e)}`, log: '' };
  }
  const end = io.now();
  if (r.code === EXIT_RELEASE_BUSY || r.code === EXIT_SESSIONS_BUSY) {
    // 什么都没动：退回发之前的样子，下一轮再来
    st.attempt = before;
    if (r.code === EXIT_SESSIONS_BUSY) {
      st.waitingSince ??= iso(now);
      act(st, end, 'wait-idle', '切版本之前又看到会话在跑，这轮不切（构建留着，下轮直接用）');
    } else {
      act(st, end, 'release-busy', '另一个发布在跑');
    }
    return current;
  }
  let after = current;
  try {
    after = await io.readCurrent();
  } catch {
    // 读不到就照发之前的说
  }
  st.current = after;
  st.attempt = {
    ...st.attempt,
    endedAt: iso(end),
    code: r.code,
    log: r.log ?? '',
    result: r.code === 0 || r.code === 2 ? 'ok' : 'failed',
    detail: r.detail ?? '',
  };
  st.waitingSince = null;
  if (st.attempt.result === 'ok') {
    resolveLater(st, FAILED_PREFIX);
    act(st, end, 'released', `发了 ${short(target)}（退出码 ${r.code}）${via}`);
    return after;
  }
  const where =
    after === target ? `停在新版 ${short(target)}（没退回：见日志里的红）` : `在用的还是 ${short(after)}`;
  raise(
    st,
    `${FAILED_PREFIX}${target}`,
    `自动发布 ${short(target)} 没成`,
    `release.sh 退出码 ${r.code}：${r.detail || '没给原因'}。${where}。日志：${r.log || '（没拿到路径）'}。` +
      '这个提交和比它旧的不再自动试，主线出了比它新的全绿提交再发；要现在重试，在法国以 root 跑 ' +
      `bash ${CHECKOUT}/deploy/release.sh ${target}`,
  );
  act(st, end, 'release-failed', `${short(target)} 退出码 ${r.code}：${r.detail}`);
  return after;
}

/** 上一轮的发布没收到结果、发布锁也空了：按现在在用的是谁定成败（没成的照样不再试）。 */
function settleDangling(st, now, current) {
  const a = st.attempt;
  const ok = current === a.sha;
  st.attempt = {
    ...a,
    endedAt: iso(now),
    result: ok ? 'ok' : 'failed',
    detail: ok ? '上一轮没等到结果，现在在用的就是它' : '上一轮的自动发布没等到结果，现在在用的不是它',
  };
  if (!ok) {
    raise(
      st,
      `${FAILED_PREFIX}${a.sha}`,
      `自动发布 ${short(a.sha)} 没等到结果`,
      `上一轮跑到一半没了（被杀、机器重启），发布锁已空，在用的是 ${short(current)}、不是它。` +
        `这个提交和比它旧的不再自动试；日志在 ${RELEASES}/.logs/。要现在重试，在法国以 root 跑 bash ${CHECKOUT}/deploy/release.sh ${a.sha}`,
    );
  }
}

/**
 * 要发哪个：候选（新的在前，candidates[0] 是主线头）里第一个 CI 全绿的——持续交付「发最新的绿构建」（Google SRE 书
 * 「Release Engineering」：在最近一次全部测试都过了的那个修订上出版本；Chromium 的 LKGR）。主线头的 CI 还在跑、红了、
 * 被后面的推送挤掉了，都往回找，不等它：合并一密（主线全量 CI 要 3–4 分钟），只看主线头就一轮轮跳过，一直发不出去。
 * GitHub 一轮最多问一次：一次读回主线最近 CI_RUNS_PAGE 次 ci.yml 的运行，候选都从这一份里判；主线头全绿了记下，等空闲的
 * 那几轮不再问。整份读不到（限流、连不上、回的认不出）这一轮一个都不发、写明没查成，不当成绿；单个提交查不到它的运行，
 * 那一个跳过（刚合进来的当还没开跑）。st.ci 记主线头的结论（读数、后端用）。
 * 找到了返回 { target, via }（via：发的不是主线头时，写明主线头和跳过的那几个怎么了）；没找到返回
 * { target: null, verdict（主线头的结论）, detail }。stop：往回找停在哪（人按住、发过没成），写进读数。
 */
async function pickTarget(io, st, now, candidates, stop) {
  const head = candidates[0];
  if (st.ci?.sha === head.sha && st.ci.verdict === 'green') return { target: head, via: '' };
  let body = null;
  let unread = '';
  try {
    const r = await io.ciRuns();
    if (r.status === 200) {
      try {
        body = JSON.parse(r.body);
      } catch {
        body = null;
      }
      if (typeof body !== 'object' || body === null || !Array.isArray(body.workflow_runs)) {
        unread = 'GitHub 回的不是运行列表';
      }
    } else if (r.status === 403 || r.status === 429) {
      unread = `GitHub 限流（HTTP ${r.status}${r.rate ? `，${r.rate}` : ''}）`;
    } else {
      unread = `GitHub 回 HTTP ${r.status}`;
    }
  } catch (e) {
    unread = `连不上 GitHub：${why(e)}`;
  }
  if (unread) {
    st.ci = { sha: head.sha, verdict: 'unknown', detail: unread, checkedAt: iso(now) };
    return { target: null, verdict: 'unknown', detail: `CI 的结论没查成：${unread}；这一轮不发` };
  }
  const seen = candidates.map((c) => ({ c, v: ciVerdict(body, c.sha, c.at, now) }));
  const top = seen[0].v;
  st.ci = { sha: head.sha, verdict: top.verdict, detail: top.detail, checkedAt: iso(now) };
  const at = seen.findIndex((s) => s.v.verdict === 'green');
  // 跳过的几个各一句：主线头打头，太多了只写前几个
  const told = (list) => {
    const said = list
      .slice(0, 4)
      .map((s) => `${s.c === head ? '主线头 ' : ''}${short(s.c.sha)} 的 ${s.v.detail}`);
    if (list.length > 4) said.push(`等 ${list.length} 个`);
    return said.join('、');
  };
  if (at === 0) return { target: head, via: '' };
  if (at > 0) {
    return { target: seen[at].c, via: `${told(seen.slice(0, at))}，往回找到最近全绿的是它` };
  }
  const lead = top.verdict === 'unknown' ? `没查成：${top.detail}` : top.detail;
  const rest = seen.length > 1 ? `；往回 ${seen.length - 1} 个也没全绿（${told(seen.slice(1))}）` : '';
  return { target: null, verdict: top.verdict, detail: `${lead}${rest}${stop ? `；${stop}` : ''}` };
}

/** 装机层：france.sh 装到哪个提交、那之后主线上它管的文件改过几次。读不到记 error，不挡发布。 */
async function systemLayer(io, head) {
  try {
    const s = await io.readSystem(head);
    if (!s.applied) return { error: 'france.sh 装到哪个提交没记（跑一遍 france.sh 就有）' };
    const lag = s.log.trim() === '' ? [] : parseMainLog(s.log);
    return { appliedSha: s.applied, behind: lag.length, oldestAt: lag.at(-1)?.at ?? null };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * 规矩那一半：在用的版本和检出是同一个提交、这个提交还没同步过，就以 root 替 RULES_USERS 各跑一遍
 * agents-sync --apply（和 france.sh 最后那步同一条）。没成记下、报警，不挡发布；同一个提交不重跑，检出动了再来。
 */
async function rulesStep(io, st, now, current) {
  if (!current || st.rules?.commit === current) return;
  let head;
  try {
    head = await io.checkoutHead();
  } catch (e) {
    st.rules = {
      ...(st.rules ?? {}),
      result: 'unchecked',
      detail: `检出在哪个提交没读到：${why(e)}`,
      at: iso(now),
    };
    return;
  }
  // 检出和在用的不是同一个提交（发布没成停在别处、人手动发了别的）：规矩不跟着乱动，等两边对上
  if (head !== current) return;
  const bad = [];
  for (const user of RULES_USERS) {
    let r;
    try {
      r = await io.syncRules(user);
    } catch (e) {
      r = { code: -1, out: why(e) };
    }
    if (r.code !== 0) {
      const lines = String(r.out)
        .split('\n')
        .filter((l) => /^\s*[✗…]/.test(l))
        .slice(0, 3)
        .map((l) => l.trim());
      bad.push(`${user}：退出码 ${r.code}${lines.length ? `，${lines.join('；')}` : `，${why(r.out)}`}`);
    }
  }
  if (bad.length === 0) {
    st.rules = { commit: current, at: iso(now), result: 'ok', detail: '' };
    resolveLater(st, RULES_PREFIX);
    return;
  }
  st.rules = { commit: current, at: iso(now), result: 'failed', detail: bad.join('；') };
  raise(
    st,
    `${RULES_PREFIX}${current}`,
    `规矩同步到法国没成（${short(current)}）`,
    `agents-sync --apply 没做成：${st.rules.detail}。发布照常；这个提交不再重跑，检出动了再同步。` +
      `手动补：在法国以 root 跑 node ${CHECKOUT}/packages/agents-sync/bin/agents-sync --apply --user <用户>`,
  );
}

/**
 * 配置那一半（#323）：拿法国 /etc/fleet-dao 下的环境文件跟在用那一版里的期望比（config.mjs 的 judgeConfig）。
 * 不一致的一项一条报警（键 auto-release:config:<文件>:<键>），改回去了下一轮自己解除；读不到、认不出记「没查成」
 * （一条 auto-release:config-unchecked），不当成一致。只报警、不改回。线上的值不进状态、报警。
 */
async function configStep(io, st, now) {
  let r;
  let commit = null;
  try {
    const live = await io.readConfig();
    commit = live?.commit ?? null;
    r = judgeConfig(live ?? {});
  } catch (e) {
    r = { result: 'unchecked', drift: [], unchecked: [`对账没跑成：${why(e)}`], selfHeal: false };
  }
  st.config = {
    checkedAt: iso(now),
    commit,
    result: r.result,
    drift: r.drift.map((d) => ({ id: d.id, kind: d.kind })),
    unchecked: r.unchecked,
    selfHeal: r.selfHeal,
  };
  const want = new Set();
  for (const d of r.drift) {
    const key = `${CONFIG_PREFIX}${d.id}`;
    want.add(key);
    keepRaised(st, key, d.title, d.body);
  }
  for (const a of [...st.alerts]) {
    if (a.key.startsWith(CONFIG_PREFIX) && !want.has(a.key)) resolveKeyLater(st, a.key);
  }
  if (r.unchecked.length > 0) {
    keepRaised(
      st,
      CONFIG_UNCHECKED_KEY,
      '法国配置这一轮没对上账（没查成）',
      `${r.unchecked.join('；')}。没查成不当成一致：照原因补上（期望在在用那一版的 ${DESIRED_FILE}，` +
        '指纹钥匙是 /etc/fleet-dao/config-fingerprint.key），下一轮查成了自己撤。',
    );
  } else resolveKeyLater(st, CONFIG_UNCHECKED_KEY);
}

/** 要发的报警发出去、要解除的解除掉；库连不上就留到下一轮，不丢。 */
async function flushAlerts(io, st) {
  for (const prefix of [...st.resolve]) {
    try {
      await io.resolve(prefix);
      st.resolve = st.resolve.filter((p) => p !== prefix);
    } catch {
      // 下一轮再解除
    }
  }
  for (const key of [...st.resolveKeys]) {
    try {
      await io.resolveKey(key);
      st.resolveKeys = st.resolveKeys.filter((k) => k !== key);
    } catch {
      // 下一轮再解除
    }
  }
  for (const a of st.alerts) {
    if (a.raised) continue;
    try {
      await io.alert(a);
      a.raised = true;
    } catch {
      // 下一轮再发
    }
  }
}

/** 一行人看的读数（进 journal）：主线头、CI、在用、落后几个、这一轮干了什么、规矩和装机层到哪了。 */
export function summary(st) {
  const parts = [];
  if (st.main) {
    const idx = st.main.commits.findIndex(([sha]) => sha === st.current);
    const lag =
      st.current === st.main.head ? '跟上了' : idx > 0 ? `落后 ${idx} 个提交` : '不在主线最近的提交里';
    const ci = st.ci?.sha === st.main.head ? `，CI ${st.ci.verdict}` : '';
    parts.push(`主线头 ${short(st.main.head)}${ci}；在用 ${short(st.current)}，${lag}`);
  } else {
    parts.push('主线头没读到过');
  }
  if (st.mainError) parts.push(`这轮主线没读到：${st.mainError}`);
  if (st.last) parts.push(`这轮：${st.last.action}${st.last.detail ? `（${st.last.detail}）` : ''}`);
  parts.push(
    st.rules
      ? `规矩同步到 ${short(st.rules.commit)}（${st.rules.result}${st.rules.detail ? `：${st.rules.detail}` : ''}）`
      : '规矩还没同步过',
  );
  parts.push(
    st.system?.error
      ? `装机层没查成：${st.system.error}`
      : st.system
        ? `装机脚本装到 ${short(st.system.appliedSha)}，之后相关提交 ${st.system.behind} 个`
        : '装机层没查过',
  );
  parts.push(configSummary(st.config));
  return parts.join('；');
}

/** 配置对账的一句话：只有文件、键名和原因，没有值。 */
function configSummary(c) {
  if (!c) return '配置还没对过账';
  const drift = c.drift.length
    ? `配置有 ${c.drift.length} 项和期望不一致（${c.drift
        .slice(0, 5)
        .map((d) => d.id)
        .join('、')}${c.drift.length > 5 ? ' 等' : ''}）`
    : '';
  const unchecked = c.unchecked.length ? `配置没查成：${c.unchecked.join('；')}` : '';
  if (c.result === 'ok') return '配置和期望一致';
  return [drift, unchecked].filter(Boolean).join('；');
}
