// 自动发布单元（法国，root；fleet-auto-release.timer 每 5 分钟拉起一轮）现在只剩读数，不再发版（决定 0032 第 5 条、#1258）。
// 发布只由驾驶舱「发布到法国」按钮（或发版车，同一趟流程）发；这个单元每一轮做的只有：
//   读主线头和它自己那次 CI 的结论、读法国在用的提交、数落后几个，写进状态文件，后端的 /healthz（deploy_lag）和驾驶舱读它；
//   发完版之后顺带把装机的自动档（france.sh --auto-tier）装上、把各家 AI 的规矩同步给会话用户；
//   拿法国 /etc/fleet-dao 下的环境文件跟在用那一版里的期望对账（#323，config.mjs）。
// 这里是判断和「跑一轮」的流程；和系统打交道的（git、GitHub 接口、库、装机脚本）都从 io 进来：真的在
// fleet-auto-release.mjs，测试换成假的（deploy/test/auto-release.test.mjs）。规矩和由来见 docs/ops.md 第九节「自动发布」。
// 改这里之前必须知道：
// - **这个单元不发版**：不调 release.sh、不看 `v<N>` 标记、不按人手动切过版本或发过没成去拦谁。没有任何 tag 的仓上读数照常
//   （测试：没有标记也照样写出主线头、在用、落后几个）。要发版，走驾驶舱按钮。
// - 状态文件后端也读（packages/store/src/deploy-lag.ts 按 STATE_SCHEMA 认），指挥官的法国页也读（agents/skills/commander/scripts/
//   france-lib.mjs 的 autoReleaseProblem）；改字段几边一起改，那边的测试拿这里造的状态核对。
// - RULES_USERS 要和 deploy/france.sh 的 AGENT_RULES_USERS 一样；HUMAN_TIER_PATHS 要盖住人工档（deploy/lib/human-tier.sh）读的仓里文件（测试都核对）。
// - 驾驶舱按钮的接活脚本（deploy/france/release-request/lib.mjs）import 这里的 ciVerdict 判 CI：它是对外的发布闸，改判法要两边的测试一起看。
// - 读不到、认不出的一律记成「没查成」，不拿空、0 当没事（AGENTS.md「底线」）。
import { DESIRED_FILE, judgeConfig } from './config.mjs';

export const STATE_SCHEMA = 1;
export const RELEASES = '/srv/fleet-dao-releases';
export const AUTO_DIR = `${RELEASES}/.auto`;
export const STATE_FILE = `${AUTO_DIR}/state.json`;
/** deploy/france.sh 跑完没红时写：它装到了哪个提交（`commit=<提交号>`）。 */
export const APPLIED_FILE = `${AUTO_DIR}/france-applied`;
/** 部署脚本所在的检出（france.sh、release.sh 都从这里跑；发版时由发布的那一趟快进）。 */
export const CHECKOUT = '/srv/fleet-dao';
export const REPO = 'thoerwink8/fleet-dao';
/** 状态里留主线最近多少个提交（后端据此数落后几个）；在用的版本不在里面，后端报「落后太多」或「不在主线上」。 */
export const MAIN_HISTORY = 300;
/** 只认这个工作流在 main 上那次 push 的结论（其余几个工作流看的是 GitHub 上的现状，不是这份代码好不好）。 */
export const CI_WORKFLOW = '.github/workflows/ci.yml';
/**
 * 一轮读一次主线最近这么多次 ci.yml 的运行（一次问完；不带凭据一个钟头只有 60 次）。
 * 比这更早的提交查不到结论，当没查成——落后这么多，驾驶舱早就标出来了。
 */
export const CI_RUNS_PAGE = 100;
/** 提交落到主线这么久还查不到它的 CI 记录：不再当「还没开跑」，记没查成。 */
export const CI_NO_RUN_MS = 30 * 60_000;
/** 规矩同步给谁：和 deploy/france.sh 的 AGENT_RULES_USERS 同一份（会话用户、创始人的登录用户）。 */
export const RULES_USERS = ['fleet-agent-carpool', 'pilot'];
/**
 * 装机脚本（france.sh）的「人工档」：碰防火墙、sudoers、建用户的那几个文件。主线上这些改了、france.sh 整套还没重跑，
 * 才是装机层落后（要人以 root 重跑，不自动）。其余的（自动发布脚本副本、systemd 单元、fleet-agents.slice、清老单元）
 * 是「自动档」：发完版后由 tierStep 以 root 跑 `france.sh --auto-tier` 顺带装上，改了不算落后。
 * 新加碰防火墙 / sudoers / 建用户的步骤，写进 deploy/lib/human-tier.sh，它用到的仓里文件加到这里（测试核对：那个文件
 * 和 france.sh 引用的每个仓里文件，要么在这里、要么在测试里登记的自动档清单里）。
 */
export const HUMAN_TIER_PATHS = [
  'deploy/lib/human-tier.sh',
  'deploy/france/fleet-dao.nft',
  'deploy/france/fleet-firewall.service',
  'deploy/france/sudoers-fleet-dao',
  // sudoers 放行的那个 root 脚本
  'deploy/france/fleet-agent-scope.sh',
  // 建用户（会话用户、创始人的登录用户）和防火墙读回、收旧连接用的
  'deploy/lib/session-user.sh',
  'deploy/lib/login-user.sh',
  'deploy/lib/session-ports.sh',
  // 驾驶舱「发布到法国」按钮的接活（setup_release_request）：一个由 fleet 写的文件触发 root 发版的口子，装它要人跑整套
  'deploy/france/fleet-release-request.service',
  'deploy/france/fleet-release-request.path',
  'deploy/france/release-request/lib.mjs',
  'deploy/france/release-request/fleet-release-request.mjs',
  // sshd 抗扫描和 fail2ban 的 sshd jail（#1348，setup_sshd_hardening、setup_fail2ban_sshd）：改的是登录入口，配错了连 root 都登不上，要人跑整套
  'deploy/france/sshd-hardening.conf',
  'deploy/france/fail2ban-sshd.jail',
];
/**
 * 这边发的报警都以它开头：规矩同步没成 `auto-release:rules:<提交号>`，装机自动档没装成 `auto-release:tier:<提交号>`，
 * 配置和期望不一致 `auto-release:config:<文件>:<键>`（一项一条），配置没查成 `auto-release:config-unchecked`，
 * 状态文件读不出 `auto-release:state-unreadable`。
 */
export const ALERT_PREFIX = 'auto-release:';
/**
 * 状态文件读不出、认不出（审查 S4）：里面有没发出去的报警队列，从空的起会丢掉它们。所以这一轮什么都不做、不覆盖它（留着现场），
 * 报这一条；挪走它（下一轮从空的起）时自己撤，修好了手动撤。
 */
export const STATE_UNREADABLE_KEY = `${ALERT_PREFIX}state-unreadable`;
export const RULES_PREFIX = `${ALERT_PREFIX}rules:`;
/** 装机的自动档（france.sh --auto-tier）没装成：一个提交一条，装成了自己撤。 */
export const TIER_PREFIX = `${ALERT_PREFIX}tier:`;
/** 自动档没装成，同一个提交最快隔这么久再试一次（脚本幂等，网络、单元一时起不来的多半过会儿就好）。 */
export const TIER_RETRY_MS = 30 * 60_000;
export const CONFIG_PREFIX = `${ALERT_PREFIX}config:`;
export const CONFIG_UNCHECKED_KEY = `${ALERT_PREFIX}config-unchecked`;
/**
 * 单元还会发版那会儿开的报警（#1258 起不再有人开、也没人撤）：发布没成、有待配、后置关没成、版本标记读不到、不是主线上的提交、
 * 查不出引擎开没开着。不清掉，库里开着的这几条会永远挂在驾驶舱上。新版第一次跑那一轮把它们全撤一遍（retiredCleared 记下做过了，
 * 撤不成下一轮接着撤）；`auto-release:marker-unreadable` 是整个键，别的是前缀。
 */
export const RETIRED_ALERT_PREFIXES = [
  `${ALERT_PREFIX}failed:`,
  `${ALERT_PREFIX}pending:`,
  `${ALERT_PREFIX}post-off:`,
  `${ALERT_PREFIX}marker:`,
  `${ALERT_PREFIX}marker-unreadable`,
  `${ALERT_PREFIX}engine-unknown`,
];
/** france.sh 的退出码 2（deploy/lib/common.sh 的 finish）：没有红，但有待配或没查成。自动档这样退出算装上了。 */
export const EXIT_PENDING = 2;

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

/**
 * GitHub「列出工作流运行」的回答（不带凭据：主线上 ci.yml 最近那些次 push 触发的运行）里，这个提交在 main 上那次 ci.yml
 * 的结论：green 全绿 / red 跑完了但不是 success（含被后面的推送挤掉的 cancelled）/ pending 还没跑完或还没开跑 /
 * unknown 认不出、查不到。at 是这个提交落到主线的时间（刚合进来查不到算还没开跑）。
 * 单元自己只拿它当读数；驾驶舱按钮的接活脚本（release-request/lib.mjs）拿它当发布闸，只有 green 能发。
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

/** 上一轮留下的状态里，这一轮接着用的几样；认不出（第一次跑、版本不对）就从空的起。 */
export function carryOver(prev) {
  const p = typeof prev === 'object' && prev !== null && prev.schema === STATE_SCHEMA ? prev : {};
  const retired = (key) => RETIRED_ALERT_PREFIXES.some((r) => key.startsWith(r));
  return {
    schema: STATE_SCHEMA,
    ranAt: null,
    main: p.main ?? null,
    mainError: null,
    current: p.current ?? null,
    /** 主线头那次 CI 的结论（verdict 是 green / red / pending / unknown）；只是读数，没人拿它去拦谁。 */
    ci: p.ci ?? null,
    rules: p.rules ?? null,
    tier: p.tier ?? null,
    system: p.system ?? null,
    config: null,
    /** 单元还会发版时开的那几类报警撤过了没有（RETIRED_ALERT_PREFIXES）。 */
    retiredCleared: p.retiredCleared === true,
    // 老状态里没发出去的、已经不归这个单元管的报警（发布没成之类）不再发
    alerts: Array.isArray(p.alerts) ? p.alerts.filter((a) => !retired(String(a?.key))) : [],
    resolve: Array.isArray(p.resolve) ? p.resolve : [],
    resolveKeys: Array.isArray(p.resolveKeys) ? p.resolveKeys : [],
    last: null,
  };
}

/**
 * 跑一轮。io 见 fleet-auto-release.mjs 的 realIo（测试给假的）。返回这一轮的状态（调用方写文件）；中途要人看的写进 alerts，
 * 最后统一发、发不成下一轮再发。
 */
export async function runOnce(io, prev) {
  const now = io.now();
  const st = carryOver(prev);
  st.ranAt = iso(now);
  if (!st.retiredCleared) {
    for (const p of RETIRED_ALERT_PREFIXES) if (!st.resolve.includes(p)) st.resolve.push(p);
    st.retiredCleared = true;
  }
  const current = await readStep(io, st, now);
  if (current !== undefined) await tierStep(io, st, now, current);
  if (current !== undefined) await rulesStep(io, st, now, current);
  await configStep(io, st, io.now());
  await flushAlerts(io, st);
  return st;
}

/**
 * 上一轮的状态文件原文 → 接着用的状态。text 为 null 是文件不在（第一次跑、人挪走了）：从空的起。
 * 不是 JSON、不是对象、格式版本不对：返回 { ok: false, why }——**不从空的起**（从空的起会丢掉没发出去的报警队列），
 * 调用方这一轮什么都不做、报警。
 */
export function parseState(text) {
  if (text === null) return { ok: true, prev: null };
  let prev;
  try {
    prev = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `不是 JSON：${why(e)}` };
  }
  if (typeof prev !== 'object' || prev === null || Array.isArray(prev)) {
    return { ok: false, why: '不是一个对象' };
  }
  if (prev.schema !== STATE_SCHEMA) {
    return { ok: false, why: `格式版本是 ${JSON.stringify(prev.schema)}，只认 ${STATE_SCHEMA}` };
  }
  return { ok: true, prev };
}

/**
 * 跑一轮（入口 fleet-auto-release.mjs 的 main 调它）：读上一轮的状态（io.readState：原文；文件不在回 null；读不了就抛）→ runOnce → 存。
 * 状态文件读不出、认不出：这一轮什么都不做、不碰状态文件（留着现场，下一轮照样停着），直接报 STATE_UNREADABLE_KEY；
 * 文件不在（第一次跑，或人照报警把坏的挪走了）：从空的起，顺手撤掉这条报警。
 * 返回 { ok, line, alertLost }：line 进 journal；alertLost 为 true 是状态读不出、报警也没发出去（入口据此退出非 0）。
 */
export async function runRound(io) {
  let parsed;
  try {
    parsed = parseState(await io.readState());
  } catch (e) {
    parsed = { ok: false, why: `读不了：${why(e)}` };
  }
  if (!parsed.ok) return stateUnreadable(io, parsed.why);
  const prev = parsed.prev ?? { schema: STATE_SCHEMA, resolveKeys: [STATE_UNREADABLE_KEY] };
  const st = await runOnce(io, prev);
  await io.save(st);
  return { ok: true, line: summary(st), alertLost: false };
}

async function stateUnreadable(io, whyText) {
  const said = `自动发布的状态文件 ${STATE_FILE} ${whyText}`;
  const alert = {
    key: STATE_UNREADABLE_KEY,
    title: '自动发布的状态文件读不出，这一轮什么都没做',
    body:
      `${said}。里面记着没发出去的报警，从空的起会把它们丢掉，所以每一轮都不动、也不覆盖它。` +
      `在法国以 root 看一眼：能修好就修好（这条手动解除）；修不好就挪走（mv ${STATE_FILE} ${STATE_FILE}.bad），` +
      '下一轮从空的起、这条自己撤。',
  };
  try {
    await io.alert(alert);
  } catch (e) {
    return {
      ok: false,
      line: `${said}：这一轮什么都没做、没动状态文件；报警也没发出去：${why(e)}`,
      alertLost: true,
    };
  }
  return { ok: false, line: `${said}：这一轮什么都没做、没动状态文件，已报警`, alertLost: false };
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

/**
 * 读数那一半：主线头和最近的提交、主线头那次 CI 的结论、法国在用的提交、落后几个、装机层到哪。只读，不发版、不拦谁。
 * 返回在用的提交号（读到了，含「还没发布过」的 null），主线或在用的读不到返回 undefined（装机自动档和规矩那两步这一轮不做）。
 */
async function readStep(io, st, now) {
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
  await ciStep(io, st, now, head);

  let current;
  try {
    current = await io.readCurrent();
  } catch (e) {
    act(st, now, 'current-unreadable', why(e));
    return undefined;
  }
  st.current = current;

  const at = commits.findIndex((c) => c.sha === current);
  if (current === null) act(st, now, 'not-released', '法国还没发布过');
  else if (at === 0) act(st, now, 'up-to-date', `在用的 ${short(current)} 就是主线头`);
  else if (at > 0) act(st, now, 'behind', `在用的 ${short(current)} 落后主线 ${at} 个提交`);
  else act(st, now, 'not-in-recent', `在用的 ${short(current)} 不在主线最近 ${commits.length} 个提交里`);
  return current;
}

/**
 * 主线头那次 CI 的结论，记进 st.ci（读数；单元不拿它去拦谁）。一轮最多问一次 GitHub；上一轮已经读出这个头全绿，就不再问。
 * 读不到（限流、连不上、回的认不出）记 unknown 和原因，不当成绿。
 */
async function ciStep(io, st, now, head) {
  if (st.ci?.sha === head.sha && st.ci.verdict === 'green') return;
  const { body, unread } = await readCiBody(io);
  if (unread) {
    st.ci = { sha: head.sha, verdict: 'unknown', detail: unread, checkedAt: iso(now) };
    return;
  }
  const v = ciVerdict(body, head.sha, head.at, Number(now));
  st.ci = { sha: head.sha, verdict: v.verdict, detail: v.detail, checkedAt: iso(now) };
}

/** 问一次 GitHub 要主线上 ci.yml 最近的运行：{ body }（认得出的运行列表）或 { unread }（读不到的原因：限流、回的认不出、连不上）。 */
async function readCiBody(io) {
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
  return { body, unread };
}

/** 装机层：france.sh 装到哪个提交、那之后主线上它管的文件改过几次。读不到记 error。 */
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
 * 检出和在用的版本对上：规矩同步、装机自动档用的脚本都在检出（CHECKOUT）里，要和在用的是同一个提交。
 * 检出落后（人手动 release.sh <提交> 发的、没走按钮，检出没人快进；#1672）：这里自己快进到在用的提交，不等人 pull。
 * 返回 { ok: true }；检出读不到、快进没成回 { ok: false, why }（调用方记下、报警）；检出比在用的还新（pull 了没发）回
 * { ok: false, ahead: true }，不跟着乱动，等两边对上。
 */
async function alignCheckout(io, current) {
  let head;
  try {
    head = await io.checkoutHead();
  } catch (e) {
    return { ok: false, why: `检出在哪个提交没读到：${why(e)}` };
  }
  if (head === current) return { ok: true };
  if (typeof io.fastForwardCheckout !== 'function') return { ok: false, ahead: true };
  try {
    return await io.fastForwardCheckout(current);
  } catch (e) {
    return { ok: false, why: `检出快进到 ${short(current)} 没成：${why(e)}` };
  }
}

/**
 * 装机的自动档（决定见 docs/ops.md 第九节「装机层」）：在用的版本和检出是同一个提交、这个提交还没装过，就以 root 跑
 * `france.sh --auto-tier`（自动发布脚本副本、systemd 单元、fleet-agents.slice、清掉已删的老单元；不碰防火墙、sudoers、用户、钥匙）。
 * 发一版（驾驶舱按钮）之后检出和在用的对上，下一轮就装。没成记下、报警；成了的提交不重跑，没成的最快隔 TIER_RETRY_MS 再试。
 * 退出码 2（没红、有待配）算装上了。先于规矩那一步：规矩同步用的是检出里的脚本，和这里无关，但装机脚本要先到位。
 */
async function tierStep(io, st, now, current) {
  if (!current || typeof io.applyAutoTier !== 'function') return;
  if (st.tier?.commit === current) {
    if (st.tier.result === 'ok') return;
    if (now - Date.parse(st.tier.at) < TIER_RETRY_MS) return;
  }
  const al = await alignCheckout(io, current);
  if (!al.ok) {
    if (al.ahead) return; // 检出比在用的新：脚本不跟着乱装，等两边对上
    st.tier = { commit: current, at: iso(now), result: 'failed', detail: al.why };
    raise(
      st,
      `${TIER_PREFIX}${current}`,
      `装机的自动档没装成（${short(current)}）`,
      `${al.why}。每隔 30 分钟自动再试，好了这条自己撤。`,
    );
    return;
  }
  let r;
  try {
    r = await io.applyAutoTier();
  } catch (e) {
    r = { code: -1, out: why(e) };
  }
  if (r.code === 0 || r.code === EXIT_PENDING) {
    st.tier = { commit: current, at: iso(now), result: 'ok', detail: '' };
    resolveLater(st, TIER_PREFIX);
    return;
  }
  const lines = String(r.out)
    .split('\n')
    .filter((l) => /^\s*[✗…]/.test(l))
    .slice(0, 3)
    .map((l) => l.trim());
  const detail = `退出码 ${r.code}${lines.length ? `，${lines.join('；')}` : `，${why(r.out)}`}`;
  st.tier = { commit: current, at: iso(now), result: 'failed', detail };
  raise(
    st,
    `${TIER_PREFIX}${current}`,
    `装机的自动档没装成（${short(current)}）`,
    `france.sh --auto-tier 没做成：${detail}。每隔 30 分钟自动再试，好了这条自己撤。` +
      `手动：在法国以 root 跑 bash ${CHECKOUT}/deploy/france.sh --auto-tier`,
  );
}

/**
 * 规矩那一半：在用的版本和检出是同一个提交、这个提交还没同步过，就以 root 替 RULES_USERS 各跑一遍
 * agents-sync --apply（和 france.sh 最后那步同一条）。没成记下、报警；同一个提交不重跑，检出动了再来。
 */
async function rulesStep(io, st, now, current) {
  if (!current || st.rules?.commit === current) return;
  const al = await alignCheckout(io, current);
  if (!al.ok) {
    if (al.ahead) return; // 检出比在用的新：规矩不跟着乱动，等两边对上
    // 不记成这个提交的结果：下一轮接着试快进，成了才同步
    st.rules = { ...(st.rules ?? {}), result: 'failed', detail: al.why, at: iso(now) };
    raise(
      st,
      `${RULES_PREFIX}${current}`,
      `规矩同步到法国没成（${short(current)}）`,
      `${al.why}。每轮自动再试，好了这条自己撤。`,
    );
    return;
  }
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
    `agents-sync --apply 没做成：${st.rules.detail}。这个提交不再重跑，检出动了再同步。` +
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

/** 在用的相对主线在哪儿（和后端 versionFact、驾驶舱「落后主线 N 个提交」同一个口径：在用的在主线最近提交里排第几）。 */
function lagText(st) {
  if (!st.main) return '主线没读到，数不了落后几个';
  if (!st.current) return '还没发布过';
  const idx = st.main.commits.findIndex(([sha]) => sha === st.current);
  if (idx === 0) return '跟上了主线';
  if (idx > 0) return `落后主线 ${idx} 个提交`;
  return '不在主线最近的提交里';
}

/**
 * 一行人看的读数（进 journal、release.sh --check）：主线头和它的 CI、在用、落后几个、这一轮读到了什么、规矩和装机层到哪了。
 * 发布不归这个单元：发布走驾驶舱按钮。
 */
export function summary(st) {
  const parts = [];
  if (st.main) {
    const ci = st.ci?.sha === st.main.head ? `，CI ${st.ci.verdict}` : '';
    parts.push(`主线头 ${short(st.main.head)}${ci}`);
  } else {
    parts.push('主线头没读到过');
  }
  parts.push(`在用 ${short(st.current)}，${lagText(st)}`);
  parts.push('只读：发布走驾驶舱按钮');
  if (st.mainError) parts.push(`这轮主线没读到：${st.mainError}`);
  if (st.last) parts.push(`这轮：${st.last.action}${st.last.detail ? `（${st.last.detail}）` : ''}`);
  parts.push(
    st.rules
      ? `规矩同步到 ${short(st.rules.commit)}（${st.rules.result}${st.rules.detail ? `：${st.rules.detail}` : ''}）`
      : '规矩还没同步过',
  );
  if (st.tier) {
    parts.push(
      `装机自动档装到 ${short(st.tier.commit)}（${st.tier.result}${st.tier.detail ? `：${st.tier.detail}` : ''}）`,
    );
  }
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
