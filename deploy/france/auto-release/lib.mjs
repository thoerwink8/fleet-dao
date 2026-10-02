// 自动发布（法国，root；fleet-auto-release.timer 每 5 分钟拉起一轮）：发的不是主线头，是**版本标记**——版本号最新的那个
// `v<N>` tag 指向的提交，且它得是 origin/main 的祖先（`git merge-base --is-ancestor`），CI 全绿才发，用 deploy/release.sh
// 发到本机（发布脚本先排空引擎：不起新会话，在跑的最多再做 10 分钟，到点停下、按编号续上），发完把各家 AI 的规矩同步给会话用户；
// 每一轮的读数写进状态文件，后端的 /healthz 读它现算「跟不跟得上主线」。规矩和由来见 docs/ops.md 第九节「自动发布」。
// 这里是判断和「跑一轮」的流程；和系统打交道的（git、GitHub 接口、会话、发布脚本、库）都从 io 进来：真的在
// fleet-auto-release.mjs，测试换成假的（deploy/test/auto-release.test.mjs）。
// 改这里之前必须知道：
// - **主线合并本身不再触发发布**（决定 0011 第 3 条）：只有带版本标记（`v<N>` tag，由「发布 vN」PR 合并时 release.yml 打上）
//   的提交才发。没有标记、标记读不出、标记指向的提交不是 origin/main 的祖先，一律**明确失败并报警**（下面 markerError），
//   绝不退回发主线头——这条是这个切片的全部意义（否则一次误打 tag 或一次 fetch 不对，就又把没确认的提交发上线了）。
// - 版本号按**数字**排（v10 > v9），不许按字符串排（'v10' < 'v9'）；判定和 packages/conventions/src/publish-release-logic.ts
//   的 isVersionTag 同一套，测试核对两边写法一致（VERSION_PATTERN_VS_CONVENTIONS）。
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
/**
 * 只对不会排空的引擎（这一版之前的）：发布脚本看到会话在跑退出 76，最多等这么久空闲，到点带 --busy-ok 照发（会话按编号续上）。
 * 会排空的引擎不等空闲：引擎一直起新会话，60 分钟也等不到（2026-09-27 夜里法国落后主线 9 个提交），排空由发布脚本做。
 */
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
/**
 * 版本标记（release.yml 在「发布 vN」PR 合并时打在 main 上的那个提交）：`v<N>`，版本号是十进制整数。
 * 和 packages/conventions/src/publish-release-logic.ts 的 isVersionTag 同一个模样——那边是那条工作流的判定、
 * 这里是法国这一侧的判定，谁改了都要两边一起改（deploy/test/auto-release.test.mjs 有一条约住两边写法的测试）。
 */
export const VERSION_TAG_RE = /^v\d+$/;
/** 认版本号里那一串数字（VERSION_TAG_RE 是「是不是版本标记」，这个是「是第几版」）。 */
export const VERSION_NUMBER_RE = /^v(\d+)$/;
/** 读版本标记的 git 命令（fleet-auto-release.mjs 的 realIo.readVersionTags 用）：名字、提交号、提交时间，一次问完。 */
export const VERSION_TAGS_ARGS = [
  'for-each-ref',
  '--format=%(refname:short) %(objectname) %(*objectname) %(creatordate:iso-strict)',
  'refs/tags',
];
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
 * 配置和期望不一致 `auto-release:config:<文件>:<键>`（一项一条），配置没查成 `auto-release:config-unchecked`，
 * 版本标记读不到 / 不是主线上的提交 `auto-release:marker-unreadable`、`auto-release:marker:<tag>`（决定 0011 第 3 条）。
 */
export const ALERT_PREFIX = 'auto-release:';
export const FAILED_PREFIX = `${ALERT_PREFIX}failed:`;
export const RULES_PREFIX = `${ALERT_PREFIX}rules:`;
export const CONFIG_PREFIX = `${ALERT_PREFIX}config:`;
export const CONFIG_UNCHECKED_KEY = `${ALERT_PREFIX}config-unchecked`;
/** 版本标记读不到 / 认不出（git 没跑成、一行认不出、一个 `v<N>` tag 都没有）：这一轮不发，报警等下一轮查成自己撤。 */
export const MARKER_UNREADABLE_KEY = `${ALERT_PREFIX}marker-unreadable`;
/** 版本标记指向的提交不是 origin/main 的祖先（tag 打在别的分支、或主线被强推过）：一件一条，人看了手动处理。 */
export const MARKER_PREFIX = `${ALERT_PREFIX}marker:`;
/** release.sh --auto 的两种「这次不发、什么都没动」：另一个发布在跑；引擎不会排空、切之前看到会话在跑。 */
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

/**
 * `git for-each-ref --format='%(refname:short) %(objectname) %(*objectname) %(creatordate:iso-strict)' refs/tags`：
 * 每一个 tag 一行。只认 `v<N>` 那种版本标记（别人的 tag 一概不看），返回 { tag, version, n, commit, at }，
 * 按 n 从大到小排（`v10` 在 `v9` 前面——版本号是数字，不许按字符串排）。
 * 认不出一行就抛（不拿半截当全部，免得漏掉最新的那个标记去发一个旧的）；非版本 tag 跳过不算认不出。
 * 注：annotated tag 的 `%(objectname)` 是 tag 对象、`%(*objectname)` 才是它指的提交；轻量 tag 反着来，两个都读。
 */
export function parseVersionTags(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^(\S+) ([0-9a-f]{40})(?: ([0-9a-f]{40}))? (\S+)$/.exec(line);
    const at = m ? Date.parse(m[4]) : Number.NaN;
    if (!m || Number.isNaN(at)) throw new Error(`tag 列表里有认不出的一行：${line.slice(0, 100)}`);
    const vm = VERSION_NUMBER_RE.exec(m[1]);
    if (!vm) continue;
    out.push({
      tag: m[1],
      version: `v${Number(vm[1])}`,
      n: Number(vm[1]),
      commit: m[3] ?? m[2],
      at: iso(at),
    });
  }
  return out.sort((a, b) => b.n - a.n || String(b.at).localeCompare(String(a.at)));
}

/**
 * 挑这一轮要发的版本标记：版本号最大、且它指向的提交是 origin/main 祖先的那个。
 * `isAncestor(commit)` 由调用方给（真机上是 `git merge-base --is-ancestor <commit> origin/main`），
 * 它是 async、可能抛（git 没跑成）——抛出来的当「没查成」，不悄悄当成「不是祖先」。
 * 返回：
 * - `{ ok: true, tag }`：tag 就是这一轮要发的标记；
 * - `{ ok: false, kind: 'none', why }`：一个版本标记都没有（还没发布过／tag 没取到）——**明确失败、不发主线**；
 * - `{ ok: false, kind: 'unchecked', tag, why }`：判祖先关系时 git 没跑成——**明确失败**，不猜；
 * - `{ ok: false, kind: 'not-ancestor', tag, why }`：最新的那个标记不是主线上的提交——**明确失败、不发主线**，
 *   也不往回找更旧的（那等于把一次没能生效的发布默默跳过去，人会以为这一版上线了）。
 */
export async function pickVersionMarker(tags, isAncestor) {
  if (tags.length === 0) {
    return { ok: false, kind: 'none', why: '一个 v<N> 版本标记都没有（还没发布过，或 tag 没取回来）' };
  }
  const newest = tags[0];
  let ancestor;
  try {
    ancestor = await isAncestor(newest.commit);
  } catch (e) {
    return {
      ok: false,
      kind: 'unchecked',
      tag: newest,
      why: `拿 ${newest.tag} 指向的 ${short(newest.commit)} 判是不是主线上的提交没查成：${why(e)}`,
    };
  }
  if (!ancestor) {
    return {
      ok: false,
      kind: 'not-ancestor',
      tag: newest,
      why:
        `最新的版本标记 ${newest.tag} 指向 ${short(newest.commit)}，它不是 origin/main 的祖先` +
        '（tag 打在别的分支上、或主线被强推过）：不拿它发，也不退回发主线头',
    };
  }
  return { ok: true, tag: newest };
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
 * 这个版本标记指着的提交，能不能自动发。返回 candidates（比在用的新、且没被人按住/没被判过没成的那一段，新的在前）、
 * hold（人按住了）、failed（往回看停在哪个发过没成的提交上）。判定和下面三处里最近的一处对齐：
 * - 在用的：主线按 --first-parent 排，排在它前面的都是它的后代。在用的不在主线最近的提交里（还没发布过、落后太多、
 *   没合进主线的），主线上的都算比它新——没合进主线的是人手动发的，由下一条管住。
 * - 人最近一次手动切版本那一刻：那之前合进主线的（含人退回掉的那个）一律不自动发（manualHold）。
 * - 发过没成的：自动发布没成（attempt）、发过没过健康检查（历史里最后是 unhealthy，状态文件丢了也认得）——它和比它旧的
 *   都不再自动试，等下一个版本标记。不往回挑它前面没试过的：没成的原因可能在机器上（香港不通、配置坏了），
 *   往回一个个试就是一轮轮重启服务、一条条报警。
 * 调用方（deployStep）拿这三个分别判：hold 就记 hold；failed 正好是这个标记指着的提交就记 failed-before；
 * candidates 里没有标记指着的提交（比在用的旧、落后太多、读不到）记 marker-not-newer——都不发。
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
    /**
     * 这一轮要发的版本标记（版本号最大的那个 v<N> tag，且是主线上的提交）：要发的是它指向的提交。
     * 读不到、认不出、不是祖先时为 null，原因写在 markerError 里——**不发主线头**（决定 0011 第 3 条）。
     */
    marker: null,
    markerError: null,
    hold: null,
    waitingSince: p.waitingSince ?? null,
    busy: null,
    attempt: p.attempt ?? null,
    rules: p.rules ?? null,
    system: p.system ?? null,
    config: null,
    /** 发布那一刻四步（停派活/等收尾/部署/恢复派活）这一轮各是什么状态；见 publishSequence。 */
    sequence: p.sequence ?? null,
    sequenceError: null,
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

/** 这个提交在主线上是什么时候落的（不在读回来的那段历史里就是 null）。 */
function pickCommitAt(commits, sha) {
  return commits.find((c) => c.sha === sha)?.at ?? null;
}

/**
 * 版本标记那一半（决定 0011 第 3 条）：读 `v<N>` tag、挑出版本号最大且指向 origin/main 上提交的那个，写进 st.marker。
 * 读不到（git 没跑成、某一行认不出）、一个标记都没有、判不出祖先关系、最新的那个不是主线上的提交：
 * 都写进 st.markerError、报一条警、返回 null——**这一轮不发，绝不退回发主线头**。
 * 查成了：写 st.marker（{ tag, commit, at, ... }）、把之前那两条报警撤掉，返回它。
 */
async function markerStep(io, st, now, commits) {
  let tags;
  try {
    tags = parseVersionTags(await io.readVersionTags());
  } catch (e) {
    return markerFailed(st, now, 'unreadable', why(e));
  }
  const picked = await pickVersionMarker(tags, (commit) => io.isAncestorOfMain(commit));
  if (!picked.ok) {
    if (picked.kind === 'none') return markerFailed(st, now, 'none', picked.why);
    if (picked.kind === 'unchecked') return markerFailed(st, now, 'unchecked', picked.why);
    return markerFailed(st, now, 'not-ancestor', picked.why, picked.tag);
  }
  st.marker = {
    tag: picked.tag.tag,
    commit: picked.tag.commit,
    /**
     * 这个提交落到主线的时间（判 CI「还没开跑」用它；CI_NO_RUN_MS 那个宽限是按提交上主线的时刻算的）。
     * 它不在我们读回来的这段主线历史里（很老的标记）：退回用打 tag 的时刻——只影响「刚合进来还没开跑」
     * 这个宽限的起点，不影响发不发哪一版。
     */
    at: pickCommitAt(commits, picked.tag.commit) ?? picked.tag.at,
    taggedAt: picked.tag.at,
    checkedAt: iso(now),
  };
  // 查成了：这两类报警（读不到、不是主线上的提交）都不再成立
  resolveKeyLater(st, MARKER_UNREADABLE_KEY);
  for (const a of [...st.alerts]) {
    if (a.key.startsWith(MARKER_PREFIX)) resolveKeyLater(st, a.key);
  }
  return st.marker;
}

/** 版本标记没查成 / 认不出 / 不是主线上的提交：写状态、报警、返回 null（调用方这一轮不发）。 */
function markerFailed(st, now, kind, whyText, tag = null) {
  st.marker = null;
  st.markerError = { kind, why: whyText, at: iso(now) };
  if (kind === 'not-ancestor') {
    act(st, now, 'marker-not-ancestor', `${whyText}；这一轮不发（不发主线头）`);
    raise(
      st,
      `${MARKER_PREFIX}${tag?.tag ?? 'unknown'}`,
      `版本标记 ${tag?.tag ?? '（没有）'} 不是主线上的提交`,
      `${whyText}。这一版不会自动发到法国；要么在「发布 vN」PR 里重新合一次（release.yml 把 tag 打在 main 上那次 merge），` +
        `要么在法国以 root 手动发一次 bash ${CHECKOUT}/deploy/release.sh <提交号>（手动发之后自动发布按人按住算）。`,
    );
    return null;
  }
  act(st, now, kind === 'none' ? 'marker-none' : 'marker-unknown', `${whyText}；这一轮不发（不发主线头）`);
  keepRaised(
    st,
    MARKER_UNREADABLE_KEY,
    '自动发布读不到版本标记，停着不发',
    `${whyText}。没有版本标记就不发主线头（决定 0011 第 3 条：发布 = 创始人拍了「发布 vN」那一版）；` +
      `在 ${CHECKOUT} 检出里跑 git fetch --tags 看一眼，或确认「发布 vN」PR 合了、release.yml 把 tag 打上了；查成了这条自己撤。`,
  );
  return null;
}

/**
 * 发布那一半：返回在用的提交号（读到了，含「还没发布过」的 null），读不到返回 undefined（规矩那一半也不做）。
 * 发的不是主线头，是**版本标记**（版本号最大的那个 `v<N>` tag，且它指向的提交是 origin/main 的祖先；决定 0011 第 3 条）。
 * 标记读不到、认不出、不是祖先：明确失败 + 报警，不发主线头。
 */
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

  // 版本标记：这一轮发什么全看它。读不到 / 认不出 / 不是主线上的提交：报警、不发主线头（下面 markerStep 收尾）
  const marker = await markerStep(io, st, now, commits);
  if (!marker) return current;

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

  // 在用的就是这个标记指向的提交：这一版已经上过线了，收工
  if (current === marker.commit) {
    st.waitingSince = null;
    resolveLater(st, FAILED_PREFIX);
    act(st, now, 'up-to-date', `在用的 ${short(current)} 就是 ${marker.tag} 那一版`);
    return current;
  }

  let history;
  try {
    history = parseHistory(await io.readHistory());
  } catch (e) {
    act(st, now, 'history-unreadable', why(e));
    return current;
  }
  // 人按住 / 这个标记指向的提交被判过没成：都不自动发。两个闸先判，免得被下面的 CI 结论盖住原因。
  const { candidates, hold, failed, stop } = releasable(commits, current, history, st.attempt);
  if (hold) {
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
  if (failed && failed.sha === marker.commit) {
    st.waitingSince = null;
    act(st, now, 'failed-before', `${marker.tag} 指向的提交${failed.why}，等下一个版本标记`);
    return current;
  }
  if (candidates.length === 0) {
    // 没有别的能发的原因：标记指向的提交不在主线最近的提交里（落后太多、或读不到），等下一轮
    st.waitingSince = null;
    act(st, now, 'failed-before', `${marker.tag} 指向的提交${failed?.why ?? '找不到能发的'}，等主线出新提交`);
    return current;
  }
  // 要发的只能是「比在用的新、没被人按住、没被判过没成」的那一段里的提交（candidates）。标记指的不在里面——比在用的旧
  // （人手动发过更新的、或有人补打了老 tag）、或在最近这段主线之外——发它就是降级或发没人核过的：不发，照实记。
  if (!candidates.some((c) => c.sha === marker.commit)) {
    st.waitingSince = null;
    act(
      st,
      now,
      'marker-not-newer',
      `${marker.tag} 指向的 ${short(marker.commit)} 不比在用的 ${short(current)} 新（或落在最近这段主线之外）：不发，不降级`,
    );
    return current;
  }
  const pick = await pickTarget(io, st, now, marker, stop);
  if (!pick.target) {
    if (pick.verdict === 'red') st.waitingSince = null;
    act(st, now, `ci-${pick.verdict}`, pick.detail);
    return current;
  }
  // 要发的：版本标记指向的那个提交（它的 CI 全绿；不是主线头也照发，这正是「按版本发」的意思）
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

  // 不先看有没有会话在跑：发布脚本先排空引擎（不起新会话、宽限到点停下），不会排空的旧引擎由它退出 76、这里等空闲
  const waited = st.waitingSince ? now - Date.parse(st.waitingSince) : 0;
  const busyOk = st.waitingSince !== null && waited >= IDLE_WAIT_MS;

  // 停派活 → 等在跑的收尾 → 部署 → 恢复派活（决定 0011 第 4 条）：这几步由 release.sh 真做（排空协议），
  // 这里只把「引擎关着没做」照实记下来，不假装做过。
  let engineOn = false;
  try {
    engineOn = await io.engineOn();
  } catch (e) {
    engineOn = false;
    st.sequenceError = `引擎开没开着没查成（按关着算、照实说）：${why(e)}`;
  }
  st.sequence = publishSequence({ engineOn, target, tag: marker.tag });

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
      act(
        st,
        end,
        'wait-idle',
        `在跑的引擎不会排空、有会话在跑，这轮不切（构建留着，下轮直接用），等空闲，最多等到 ${iso(Date.parse(st.waitingSince) + IDLE_WAIT_MS)}；要发的是 ${short(target)}${via}`,
      );
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
  const which = marker.tag ? `${marker.tag}（${short(target)}）` : short(target);
  raise(
    st,
    `${FAILED_PREFIX}${target}`,
    `自动发布 ${which} 没成`,
    `release.sh 退出码 ${r.code}：${r.detail || '没给原因'}。${where}。日志：${r.log || '（没拿到路径）'}。` +
      '这个版本标记和比它旧的不再自动试，等下一个版本标记（或人在法国以 root 重试：' +
      `bash ${CHECKOUT}/deploy/release.sh ${target}）。`,
  );
  act(st, end, 'release-failed', `${which} 退出码 ${r.code}：${r.detail}`);
  return after;
}

/**
 * 发布那一刻的四步（决定 0011 第 4 条「github actions 通过后可以暂停派活，然后引擎手头活都干完后，自动部署到引擎，
 * 然后接着进行活和派活」）在法国这一侧各是什么状态。四步是：停派活 → 等在跑的收尾 → 部署 → 恢复派活。
 *
 * 复用**已有的排空协议**（packages/engine/src/drain-control.ts + deploy/release.sh 的 .drain-request），不新加全局开关、
 * 不加库里的列、不加迁移：排空请求的语义本来就是「别再起新会话，在跑的做到截止就停下」。所以
 * - 停派活 = release.sh 发布一开始写的排空请求（引擎每 5 秒看一眼，认了马上不起新会话）；
 * - 等在跑的收尾 = release.sh 的 drain_engine（读引擎的 drain.json 数还有几个会话，到上限照实报、不硬切）；
 * - 部署 = release.sh 迁移 + 切版本 + 健康检查（不过自动退回）；
 * - 恢复派活 = release.sh 切完撤掉排空请求（引擎下一眼就接着派）+ 新引擎起来接管在跑的会话。
 *
 * 引擎关着时（法国现在 FLEET_SERVICES=fleet-api，没有 fleet-engine；见 deploy/france/desired-config.json）这四步
 * **一步都没跑**：这里照实写「引擎关着，跳过」，返回 engineOn:false——绝不假装做过（AGENTS.md「底线」）。
 * 引擎开着时这四步由 release.sh 真做，结果在它的日志和退出码里（这里不重复判，只说明它在哪）。
 *
 * 返回 { engineOn, steps: [{ name, state, detail }] }；state 取 done / skipped-engine-off / delegated。
 */
export function publishSequence({ engineOn, target, tag }) {
  const which = tag ? `${tag}（${short(target)}）` : short(target);
  if (!engineOn) {
    return {
      engineOn: false,
      steps: [
        {
          name: '停派活',
          state: 'skipped-engine-off',
          detail: '引擎关着（FLEET_SERVICES 里没有 fleet-engine），没有派活可停',
        },
        { name: '等在跑的收尾', state: 'skipped-engine-off', detail: '引擎关着，没有在跑的会话可等' },
        {
          name: '部署',
          state: 'delegated',
          detail: `由 deploy/release.sh 发 ${which}（构建、迁移、切版本、健康检查都在它那里）`,
        },
        { name: '恢复派活', state: 'skipped-engine-off', detail: '引擎关着，没有派活可恢复；排空请求不会写' },
      ],
    };
  }
  return {
    engineOn: true,
    steps: [
      {
        name: '停派活',
        state: 'delegated',
        detail: `release.sh 发布一开始写排空请求 ${RELEASES}/.drain-request，引擎认了马上不起新会话`,
      },
      {
        name: '等在跑的收尾',
        state: 'delegated',
        detail: 'release.sh 读引擎的 drain.json 数还在跑的会话，等到截止；到点照实报、不硬切',
      },
      {
        name: '部署',
        state: 'delegated',
        detail: `由 deploy/release.sh 发 ${which}（构建、迁移、切版本、健康检查都在它那里）`,
      },
      {
        name: '恢复派活',
        state: 'delegated',
        detail: '切完撤掉排空请求，引擎下一眼就接着派；新引擎起来按编号续上停下的会话',
      },
    ],
  };
}

/** 四步的一行人话（进 journal / 状态文件 / --check 的读数；引擎关着时写「跳过」）。 */
export function publishSequenceSummary(seq) {
  if (!seq) return '';
  return seq.steps
    .map((s) => {
      const word =
        s.state === 'done' ? '做了' : s.state === 'skipped-engine-off' ? '跳过（引擎关着）' : '交给发布脚本';
      return `${s.name}：${word}`;
    })
    .join('；');
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
 * 要发的那个提交的 CI 是不是全绿：**只认版本标记指向的那个提交**，不往回找别的（决定 0011 第 3 条：发布的就是创始人
 * 拍的那一版；往回找一个更旧的全绿提交，等于把创始人拍的那一版默默换掉）。它在主线上那次 `ci.yml` 的运行结论：
 * 还没跑完 / 还没开跑 → pending 下一轮再看；红了 / cancelled → red，报警要人修（这一版发不出去）；查不到、整份读不到
 * （限流、连不上、回的认不出）→ unknown，记没查成、这一轮不发、也不当成绿。
 * GitHub 一轮最多问一次：一次读回主线最近 CI_RUNS_PAGE 次 ci.yml 的运行，结论从这一份里判；上一轮已经读出绿了、
 * 标记还是同一个，就不再问（等空闲的那几轮）。st.ci 记这个标记的结论（读数、后端用）。
 * 返回 { target, via }（via：标记指向的不是主线头时写明主线头是谁）或 { target: null, verdict, detail }。
 */
async function pickTarget(io, st, now, marker, stop) {
  if (st.ci?.sha === marker.commit && st.ci.verdict === 'green') {
    return { target: { sha: marker.commit, at: marker.at }, via: '' };
  }
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
    st.ci = { sha: marker.commit, verdict: 'unknown', detail: unread, checkedAt: iso(now) };
    return { target: null, verdict: 'unknown', detail: `CI 的结论没查成：${unread}；这一轮不发` };
  }
  const v = ciVerdict(body, marker.commit, marker.at, now);
  st.ci = { sha: marker.commit, verdict: v.verdict, detail: v.detail, checkedAt: iso(now) };
  if (v.verdict === 'green') {
    return { target: { sha: marker.commit, at: marker.at }, via: '' };
  }
  const lead = v.verdict === 'unknown' ? `没查成：${v.detail}` : v.detail;
  return {
    target: null,
    verdict: v.verdict,
    detail: `${marker.tag}（${short(marker.commit)}）的 ${lead}${stop ? `；${stop}` : ''}`,
  };
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
  if (st.marker) {
    parts.push(`版本标记 ${st.marker.tag}（${short(st.marker.commit)}）`);
  } else {
    parts.push(`版本标记没有${st.markerError?.why ? `（${st.markerError.why}）` : ''}`);
  }
  if (st.main) {
    const idx = st.main.commits.findIndex(([sha]) => sha === st.current);
    const lag =
      st.current === st.main.head
        ? '跟上了主线头'
        : idx > 0
          ? `落后主线头 ${idx} 个提交`
          : '不在主线最近的提交里';
    parts.push(`在用 ${short(st.current)}，${lag}`);
  } else {
    parts.push('主线头没读到过');
  }
  if (st.mainError) parts.push(`这轮主线没读到：${st.mainError}`);
  if (st.last) parts.push(`这轮：${st.last.action}${st.last.detail ? `（${st.last.detail}）` : ''}`);
  if (st.sequence) {
    parts.push(
      `发布四步（${st.sequence.engineOn ? '引擎开着' : '引擎关着'}）：${publishSequenceSummary(st.sequence)}`,
    );
  }
  if (st.sequenceError) parts.push(`四步没查成：${st.sequenceError}`);
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
