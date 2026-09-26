// 自动发布（法国，root；fleet-auto-release.timer 每 5 分钟拉起一轮）：主线上 CI 全绿的新提交，等引擎空闲后用
// deploy/release.sh 发到本机，发完把各家 AI 的规矩同步给会话用户；每一轮的读数写进状态文件，后端的 /healthz 读它现算
// 「跟不跟得上主线」。规矩和由来见 docs/ops.md 第九节「自动发布」。
// 这里是判断和「跑一轮」的流程；和系统打交道的（git、GitHub 接口、会话、发布脚本、库）都从 io 进来：真的在
// fleet-auto-release.mjs，测试换成假的（deploy/test/auto-release.test.mjs）。
// 改这里之前必须知道：
// - 状态文件后端也读（packages/api/src/deploy-lag.ts 按 STATE_SCHEMA 认），改字段两边一起改，那边的测试拿这里造的状态核对。
// - RULES_USERS 要和 deploy/france.sh 的 AGENT_RULES_USERS 一样；INSTALL_PATHS 要盖住 france.sh 读的仓里文件（测试都核对）。
// - 读不到、认不出的一律记成「没查成」、不发，不拿空、0 当没事（AGENTS.md「底线」）。

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
];
/** 这边发的报警都以它开头：发布没成 `auto-release:failed:<提交号>`，规矩同步没成 `auto-release:rules:<提交号>`。 */
export const ALERT_PREFIX = 'auto-release:';
export const FAILED_PREFIX = `${ALERT_PREFIX}failed:`;
export const RULES_PREFIX = `${ALERT_PREFIX}rules:`;
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

/**
 * 人最近一次手动切的版本（不带 auto 的 release / rollback / auto-rollback）之后，主线上还没有更新的提交：不自动发——
 * 不跟人打架（手动退回了坏版本、合并前在真机上验）。主线出了新提交（修复、那个 PR 合进来）再接着自动发。
 * 对照：Argo CD 开着自动同步不许手动回滚，要先关自动同步；这里不用关，人切一下就算按住。
 */
export function manualHold(history, headAt) {
  let last = null;
  for (const h of history) if (!h.tags.includes('auto') && SWITCHES.has(h.event)) last = h;
  if (!last || Date.parse(headAt) > Date.parse(last.at)) return null;
  return { since: last.at, sha: last.sha, event: last.event, unmerged: last.tags.includes('unmerged') };
}

/** 这个提交在历史里最后一件事是「不健康」（发过、没过健康检查）：不自动再发，等新提交。 */
export function judgedUnhealthy(history, sha) {
  let last = '';
  for (const h of history) if (h.sha === sha) last = h.event;
  return last === 'unhealthy';
}

/**
 * GitHub「列出工作流运行」的回答（不带凭据，按 head_sha、event=push 过滤过）里，这个提交在 main 上那次 ci.yml 的结论：
 * green 全绿 / red 跑完了但不是 success / pending 还没跑完或还没开跑 / unknown 认不出、查不到。只有 green 能发。
 */
export function ciVerdict(body, sha, headAt, now) {
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
    if (now - Date.parse(headAt) < CI_NO_RUN_MS) return { verdict: 'pending', detail: 'CI 还没开跑' };
    return {
      verdict: 'unknown',
      detail: `提交落到主线 ${minutes(now - Date.parse(headAt))} 分钟了还查不到它的 CI`,
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
  return { verdict: 'red', detail: `CI 的结论是 ${run.conclusion ?? '空'}（第 ${run.run_number} 次）` };
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
    alerts: Array.isArray(p.alerts) ? p.alerts : [],
    resolve: Array.isArray(p.resolve) ? p.resolve : [],
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
  const hold = manualHold(history, head.at);
  if (hold) {
    // 这几种「这个头不发」：之前等空闲的钟不接着走，下一个要发的头从头等
    st.waitingSince = null;
    st.hold = hold;
    act(
      st,
      now,
      'hold',
      `人 ${hold.since} 手动${hold.event === 'rollback' ? '退回' : '切'}到 ${short(hold.sha)}${hold.unmerged ? '（没合进主线的提交）' : ''}，主线上还没有更新的提交`,
    );
    return current;
  }
  if (st.attempt?.sha === head.sha && st.attempt.result === 'failed') {
    st.waitingSince = null;
    act(
      st,
      now,
      'failed-before',
      `这个提交自动发过、没成（${st.attempt.endedAt ?? st.attempt.startedAt}），等主线出新提交`,
    );
    return current;
  }
  if (judgedUnhealthy(history, head.sha)) {
    st.waitingSince = null;
    act(st, now, 'failed-before', '这个提交发过、没过健康检查，等主线出新提交');
    return current;
  }

  const ci = await ciFor(io, st, now, head);
  if (ci.verdict !== 'green') {
    if (ci.verdict === 'red') st.waitingSince = null;
    act(st, now, `ci-${ci.verdict}`, ci.detail);
    return current;
  }

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
    checkout = await io.prepareCheckout(head.sha);
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
        `引擎有会话在跑（${st.busy}），等空闲，最多等到 ${iso(Date.parse(st.waitingSince) + IDLE_WAIT_MS)}`,
      );
      return current;
    }
  }

  const before = st.attempt;
  st.attempt = {
    sha: head.sha,
    startedAt: iso(now),
    endedAt: null,
    result: 'running',
    busyOk,
    code: null,
    detail: '',
    log: '',
  };
  act(st, now, 'releasing', busyOk ? `等空闲等了 ${minutes(waited)} 分钟，照发` : '');
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
    r = await io.runRelease(head.sha, busyOk);
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
    act(st, end, 'released', `发了 ${short(head.sha)}（退出码 ${r.code}）`);
    return after;
  }
  const where =
    after === head.sha ? `停在新版 ${short(head.sha)}（没退回：见日志里的红）` : `在用的还是 ${short(after)}`;
  raise(
    st,
    `${FAILED_PREFIX}${head.sha}`,
    `自动发布 ${short(head.sha)} 没成`,
    `release.sh 退出码 ${r.code}：${r.detail || '没给原因'}。${where}。日志：${r.log || '（没拿到路径）'}。` +
      '这个提交不再自动试，主线出了新提交再发；要现在重试，在法国以 root 跑 ' +
      `bash ${CHECKOUT}/deploy/release.sh ${head.sha}`,
  );
  act(st, end, 'release-failed', `退出码 ${r.code}：${r.detail}`);
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
        `这个提交不再自动试；日志在 ${RELEASES}/.logs/。要现在重试，在法国以 root 跑 bash ${CHECKOUT}/deploy/release.sh ${a.sha}`,
    );
  }
}

async function ciFor(io, st, now, head) {
  if (st.ci?.sha === head.sha && (st.ci.verdict === 'green' || st.ci.verdict === 'red')) return st.ci;
  let v;
  try {
    const r = await io.ciRuns(head.sha);
    if (r.status === 200) {
      let body;
      try {
        body = JSON.parse(r.body);
      } catch {
        body = null;
      }
      v = ciVerdict(body, head.sha, head.at, now);
    } else if (r.status === 403 || r.status === 429) {
      v = { verdict: 'unknown', detail: `GitHub 限流（HTTP ${r.status}${r.rate ? `，${r.rate}` : ''}）` };
    } else {
      v = { verdict: 'unknown', detail: `GitHub 回 HTTP ${r.status}` };
    }
  } catch (e) {
    v = { verdict: 'unknown', detail: `连不上 GitHub：${why(e)}` };
  }
  st.ci = { sha: head.sha, verdict: v.verdict, detail: v.detail, checkedAt: iso(now) };
  return st.ci;
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
  return parts.join('；');
}
