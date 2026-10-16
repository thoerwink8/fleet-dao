// 自动发布单元（法国，root；fleet-auto-release.timer 每 5 分钟拉起一轮）：读数，加上「主线绿了就发」（决定 0088、#2039）。
// 发版本身仍只有一条路：驾驶舱按钮（或发版车）写请求文件、法国上的接活单元（deploy/france/release-request）核请求、走同一趟流程。
// 这个单元自己不调 release.sh：它到点写同样的请求文件（releaseStep），由接活单元去发。这个单元每一轮做的有：
//   读主线头和它自己那次 CI 的结论、读法国在用的提交、数落后几个，写进状态文件，后端的 /healthz（deploy_lag）和驾驶舱读它；
//   主线头落后在用的、在用之后有 CI 全绿的提交、没有发版在走也没有卡住的，就请求发其中最近绿的那个（头绿就是头；头的 CI
//   还在跑就发头之前最近绿的，#2676）（releaseStep；不再隔 1 小时，#2038、决定 0093）；
//   发版驱动中途死了留下的残局自动收：发版暂停的任务放久了没人发「继续」、老版驱动关了总开关没开回（recoverStep）；
//   发完版之后顺带把装机的自动档（france.sh --auto-tier）装上、把各家 AI 的规矩同步给会话用户；
//   拿法国 /etc/fleet-dao 下的环境文件跟在用那一版里的期望对账（#323，config.mjs）。
// 这里是判断和「跑一轮」的流程；和系统打交道的（git、GitHub 接口、库、装机脚本）都从 io 进来：真的在
// fleet-auto-release.mjs，测试换成假的（deploy/test/auto-release.test.mjs）。规矩和由来见 docs/ops.md 第九节「自动发布」。
// 改这里之前必须知道：
// - **这个单元不自己发版**：不调 release.sh、不看 `v<N>` 标记、不取 tag。要发只写请求文件（releaseStep），请求的核对（CI 绿、主线祖先、
//   没有发版在走）接活单元还会再做一遍。没有任何 tag 的仓上读数照常（测试：没有标记也照样写出主线头、在用、落后几个）。
// - 自动发版的闸（releaseGate 读来的事实交给 gateVerdict 判）：任何一项读不到、认不出都不发（原因写进状态的 auto.note），不当成可以发。
//   两次发版之间不设间隔（发版不再关总开关、只暂停在跑的任务，#2038）；只防同一个要发的提交 REQUEST_DEDUPE_MS 内重复请求。
// - 状态文件后端也读（packages/store/src/deploy-lag.ts 按 STATE_SCHEMA 认），指挥官的法国页也读（agents/skills/commander/scripts/
//   france-lib.mjs 的 autoReleaseProblem）；改字段几边一起改，那边的测试拿这里造的状态核对。
// - RULES_USERS 要和 deploy/france.sh 的 AGENT_RULES_USERS 一样；HUMAN_TIER_PATHS 要盖住人工档（deploy/lib/human-tier.sh）读的仓里文件（测试都核对）。
// - 驾驶舱按钮的接活脚本（deploy/france/release-request/lib.mjs）import 这里的 ciVerdict 判 CI：它是对外的发布闸，改判法要两边的测试一起看。
// - 读不到、认不出的一律记成「没查成」，不拿空、0 当没事（agents/shared-rules.md「底线」）。
import { createHash } from 'node:crypto';
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
 * 自动发版找「最近绿的」也只看在用之后最近这么多个提交（greenStep）；GitHub 单页最多 100，所以不再翻页。
 */
export const CI_RUNS_PAGE = 100;
/** 提交落到主线这么久还查不到它的 CI 记录：不再当「还没开跑」，记没查成。 */
export const CI_NO_RUN_MS = 30 * 60_000;
/** 规矩同步给谁：和 deploy/france.sh 的 AGENT_RULES_USERS 同一份（会话用户、创始人的登录用户）。 */
export const RULES_USERS = ['fleet-agent-carpool', 'pilot'];
/**
 * 其中同步时带 --no-skills 的（家里不装 skill）：会话用户，引擎的一次性会话跑在他家里，会话照单子干活，通用 skill 各家 CLI
 * 一启动就去读（决定 0093）。和 deploy/france.sh 的 agent_rules_sync（按 SESSION_USERS 判）同一份，测试核对。
 */
export const NO_SKILLS_USERS = ['fleet-agent-carpool'];
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
  // 驾驶舱「发布到法国」按钮的接活（setup_release_request）：一个由 fleet 写的文件触发 root 发版的口子，装它要人跑整套。
  // 只有单元和目录是人工档；接活脚本（release-request/*.mjs）是自动档，发完版由 france.sh --auto-tier 换上（#2728）
  'deploy/france/fleet-release-request.service',
  'deploy/france/fleet-release-request.path',
  // sshd 抗扫描和 fail2ban 的 sshd jail（#1348，setup_sshd_hardening、setup_fail2ban_sshd）：改的是登录入口，配错了连 root 都登不上，要人跑整套
  'deploy/france/sshd-hardening.conf',
  'deploy/france/fail2ban-sshd.jail',
  // 会话用户的登录口子收口（#1785，setup_session_ssh）：sshd 的 Match User 段 + 动会话用户家里的钥匙；出站 22 的拒绝在上面的 fleet-dao.nft
  'deploy/france/sshd-session-user.conf',
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
/**
 * 真失败才用这个间隔：单元没起来、文件对不上、读回红了且不是 Mirasim 冷启动。同一个提交最快隔这么久再试一次
 * （脚本幂等，网络、单元一时起不来的多半过会儿就好）。
 * 发版重启 fleet-mirasim-session 后 4318 还没 listen（curl 退出 7）走 TIER_BOOT_MS，不落 failed，也不干等这 30 分钟。
 */
export const TIER_RETRY_MS = 30 * 60_000;
/**
 * 冷启动窗口。发版会停再起 fleet-mirasim-session：ActiveEnter 之后 Mirasim 还要十几秒到一分多钟才 listen
 * 127.0.0.1:4318（2026-10-16 实测 boot 约 19 秒、另一次约 66 秒）。这段里对 /api/health 的 curl 退出 7 是「还在起」，
 * 不是装机步骤坏了。窗口从 ActiveEnter 起算（读不到就从第一次看见这次退出 7 起算）；窗口内隔几秒再跑自动档，
 * 健康口回了含 ok:true 的 JSON 就写成 ok。超过窗口仍连不上才落 failed，之后才套 TIER_RETRY_MS。
 * france.sh 读回自己也会等约 90 秒（MIRASIM_HEALTH_TRIES）；等满仍是退出 7 时，靠这个窗口接着探，而不是立刻记失败。
 */
export const TIER_BOOT_MS = 3 * 60_000;
/** 冷启动窗口内两次自动档之间歇这么久。真等的大头在 france.sh 里那 90 秒探活，这里只是别空转。 */
const TIER_BOOT_POLL_MS = 5_000;
/** 一轮里最多再探这么多次，防止时钟不动或 ActiveEnter 被反复重启拨回时死循环。 */
const TIER_BOOT_POLLS = 40;
/**
 * 自动发版防重复：同一个主线头请求过之后这么久内不再写请求。不是间隔（换了头照发）：接活单元读走请求文件到写进发版进度之间
 * 有个空档，那时闸看着全过，不挡这一下会对同一个头再请求一次。
 */
export const REQUEST_DEDUPE_MS = 30 * 60_000;
/** release.sh 的 PAUSE_FILE：切版本前给在跑的任务发 hard 暂停的名单，发完由它用 fleet-api release continue 续上（#2038、决定 0093）。 */
export const PAUSE_FILE = `${RELEASES}/.release-paused.json`;
/** 暂停名单放了这么久、发布锁也空着：发版驱动没收尾（死在中途），这边替它发「继续」。 */
export const PAUSED_STALE_MS = 20 * 60_000;
/** 自动替发「继续」之后报一条（不自动撤，人看过手动解除）。 */
export const PAUSED_ALERT_KEY = `${ALERT_PREFIX}paused-tasks`;
/** 老版发版驱动（发版前关总开关的那版）的进度记录和暂停标记；路径同 release-request/lib.mjs。 */
export const TRAIN_STATE = `${RELEASES}/.train/release-train.json`;
export const TRAIN_MARKER = `${RELEASES}/.train/release-train.paused`;
/** 进度记录这么久没更新、驱动也不在了：当它死在中途，把它关掉的总开关开回去。 */
export const TRAIN_STALE_MS = 30 * 60_000;
/** 总开关开回（或没开回）的报警：不自动撤，进度记录的状态没改，要人看。 */
export const TRAIN_RESTORED_KEY = `${ALERT_PREFIX}train-restored`;
/** 残留暂停标记删不掉、或删了没记上操作记录的报警。 */
export const TRAIN_MARKER_KEY = `${ALERT_PREFIX}train-marker`;
/** 删残留暂停标记的操作记录：动作和原因（actor 是运维脚本，见 fleet-auto-release.mjs 的 audit）。 */
export const MARKER_CLEAR_ACTION = 'release.marker-cleared';
export const MARKER_CLEAR_REASON = '自动发布删掉残留的发版暂停标记（发版驱动没收尾）';
/** 开回总开关时写进操作记录的原因。 */
export const TRAIN_RESTORE_REASON = '发版驱动没收尾，自动发布恢复发版前开着的总开关';
/** 请求里「谁点的」：接活单元只收字母数字、汉字和 _.@ 空格 -（最长 64），发版进度和飞书里就显示这个。 */
export const AUTO_RELEASE_BY = '自动发版 决定0088';
/** 写不出发版请求时的报警（好了自己撤）。 */
export const AUTO_REQUEST_KEY = `${ALERT_PREFIX}request`;
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
/**
 * 发版还没动手（第 0–3 步没成、release.sh 没起，什么都还没动）的那一趟不挡自动发版：下一轮照常再请求同一个提交。
 * 同一个提交这样连败这么多趟才停，并开一张急修单（#2728）。计数记在发版进度记录（release-train.json 的 untouchedFails）里，
 * 由接活单元每趟写（release-request/lib.mjs 的 runRequest、runPhases），不靠哪个进程的内存。
 */
export const UNTOUCHED_FAIL_LIMIT = 3;
/** 急修单开没开成：没开成报这一条（每轮再试，开成了自己撤）。 */
export const EMERGENCY_KEY = `${ALERT_PREFIX}emergency-issue`;
/** 在用那一版的依赖（node_modules）发版后被动过：`auto-release:deps:<提交号>`，下一次发版（换了提交）自己撤。 */
export const DEPS_PREFIX = `${ALERT_PREFIX}deps:`;
/**
 * 装在 /usr/local/lib 下、以 root 跑的脚本副本：自动档（france.sh --auto-tier）照在用那一版装。每轮拿副本和在用那一版里的原件比哈希，
 * 不一致记进状态的 installed，后端 /healthz 的 deploy_lag 当轮就报（packages/store/src/deploy-lag.ts）。文件清单和 france.sh 的
 * AUTO_RELEASE_FILES、RELEASE_REQUEST_FILES 一样（测试核对）。
 */
export const INSTALLED_COPIES = [
  {
    dir: '/usr/local/lib/fleet-dao/auto-release',
    src: 'deploy/france/auto-release',
    files: ['lib.mjs', 'fleet-auto-release.mjs', 'config.mjs'],
  },
  {
    dir: '/usr/local/lib/fleet-dao/release-request',
    src: 'deploy/france/release-request',
    files: ['lib.mjs', 'session-wait.mjs', 'fleet-release-request.mjs'],
  },
];

export const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 12) : '（没有）');
const iso = (d) => new Date(d).toISOString();
const why = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 400);
const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));

/**
 * 认得出的关键行：Node 的模块找不到（`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x' imported from …`）、
 * 带错误码的那一行、`XxxError: …`、命令找不到。Node 崩的时候 stderr 最后几行是 `code: '…' / } / Node.js v22…`，
 * 只取尾几行会把缺的是哪个模块丢掉（#2728）。
 */
const KEY_LINE =
  /Cannot find (?:module|package)|\[ERR_[A-Z_]+\]|^(?:[A-Z][A-Za-z]*)?Error\b.*:|command not found|No such file or directory|permission denied/i;

/**
 * 失败原因：先放认得出的关键行（最多 2 行），再放尾 n 行（重复的不再放），用「 / 」连起来，最长 600 字。
 * 发版接活、自动发布记失败原因都用它，不只取尾几行。
 */
export function reasonOf(text, n = 3) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.slice(-n);
  const keys = lines.filter((l) => KEY_LINE.test(l) && !last.includes(l));
  return [...new Set(keys)].slice(0, 2).concat(last).join(' / ').slice(0, 600);
}

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
    /** 在用的之后到头这一段里最近一个 CI 全绿的提交 { sha, at, index（在主线里排第几，0 是头）, checkedAt }；每轮重算，没有是 null。老状态没有这个字段。 */
    ciGreen: null,
    rules: p.rules ?? null,
    tier: p.tier ?? null,
    system: p.system ?? null,
    config: null,
    /** 自动发版最近一次请求的提交和时间（带到下一轮，防同一个头 REQUEST_DEDUPE_MS 内重复请求）；note 是这一轮为什么发或没发。 */
    auto: p.auto ? { sha: p.auto.sha ?? null, at: p.auto.at ?? null, note: null } : null,
    /** 同一个提交发版还没动手就连败 UNTOUCHED_FAIL_LIMIT 趟、开的急修单：{ sha, number, url, at } 或没开成 { sha, number: null, error, at }。 */
    emergency: p.emergency ?? null,
    /** 已撤过失败卡的那一趟目标（被后来的发版取代，supersededStep；同一个只撤一次）。 */
    superseded: typeof p.superseded === 'string' ? p.superseded : null,
    /** 在用那一版依赖的指纹（发版后第一轮记下，之后每轮核对）：{ commit, fingerprint, prunedAt, recordedAt, result, detail, checkedAt }。 */
    deps: p.deps ?? null,
    /** /usr/local/lib 下脚本副本和在用那一版的原件对不对得上（每轮重算）：{ commit, checkedAt, result: ok|drift|unchecked, drift, detail }。 */
    installed: null,
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
  await recoverStep(io, st, now);
  if (current !== undefined) await releaseStep(io, st, now, current);
  if (current !== undefined) await tierStep(io, st, now, current);
  if (current !== undefined) await rulesStep(io, st, now, current);
  if (current !== undefined) await supersededStep(io, st, current);
  if (current) await installedStep(io, st, io.now(), current);
  if (current) await depsStep(io, st, io.now(), current);
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
  const ci = await ciStep(io, st, now, head);

  let current;
  try {
    current = await io.readCurrent();
  } catch (e) {
    act(st, now, 'current-unreadable', why(e));
    return undefined;
  }
  st.current = current;
  greenStep(st, now, commits, current, ci);

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
  if (st.ci?.sha === head.sha && st.ci.verdict === 'green') return { skipped: true, body: null, unread: '' };
  const { body, unread } = await readCiBody(io);
  if (unread) {
    st.ci = { sha: head.sha, verdict: 'unknown', detail: unread, checkedAt: iso(now) };
    return { skipped: false, body: null, unread };
  }
  const v = ciVerdict(body, head.sha, head.at, Number(now));
  st.ci = { sha: head.sha, verdict: v.verdict, detail: v.detail, checkedAt: iso(now) };
  return { skipped: false, body, unread: '' };
}

/**
 * 在用的之后到主线头这一段（不含在用的），从新到旧找第一个 CI 全绿的提交，记进 st.ciGreen（#2676）：自动发版发它，不只认头。
 * 同一份运行列表（ciStep 刚问的那一次，不再多问）对每个候选算 ciVerdict。只看最近 CI_RUNS_PAGE 个候选：运行列表就这么长，更早的查不到结论。
 * 头已经读到全绿（ciStep 没再问）就是头。读不到运行列表、没有在用的、没落后：st.ciGreen 是 null。
 * st.ciGreen 每轮重算，不带到下一轮（只有 st.ci 带着，用来省掉对已绿的头重复问）。
 */
function greenStep(st, now, commits, current, ci) {
  st.ciGreen = null;
  const idx = commits.findIndex((c) => c.sha === current);
  if (current === null || idx <= 0) return;
  const head = commits[0];
  const found = (c, n) => ({ sha: c.sha, at: c.at, index: n, checkedAt: iso(now) });
  if (ci.skipped) {
    st.ciGreen = found(head, 0);
    return;
  }
  if (!ci.body) return;
  const span = commits.slice(0, Math.min(idx, CI_RUNS_PAGE));
  for (const [n, c] of span.entries()) {
    if (ciVerdict(ci.body, c.sha, c.at, Number(now)).verdict === 'green') {
      st.ciGreen = found(c, n);
      return;
    }
  }
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

/**
 * 旧的 failed 进度还挡不挡自动发版。
 * 判据：current 的提交号等于这份失败记录里的 target，或在 mainline（从新到旧）里排在它前面（新于它）。
 * current 已经追上或超过那一趟的目标时，不得再因这份 failed 回「上一趟 failed 要人看」。
 * 比不出先后（current 没有、target 不是提交号、两边不都在 mainline 里）仍挡，不猜成可以发。
 * 只认 status=failed；running 由调用方先挡掉，不拿这条把正在走的一趟放过去。
 */
export function trainFailureSuperseded(train, current, mainline) {
  if (!train || typeof train !== 'object' || train.status !== 'failed') return false;
  const raw = train.target && typeof train.target === 'object' ? train.target.value : '';
  if (typeof raw !== 'string' || typeof current !== 'string') return false;
  if (!/^[0-9a-f]{7,40}$/.test(raw) || !/^[0-9a-f]{7,40}$/.test(current)) return false;
  const same = (a, b) => a === b || a.startsWith(b) || b.startsWith(a);
  if (same(current, raw)) return true;
  if (!Array.isArray(mainline)) return false;
  const at = (sha) => mainline.findIndex((s) => typeof s === 'string' && same(s, sha));
  const ci = at(current);
  const ti = at(raw);
  if (ci < 0 || ti < 0) return false;
  return ci < ti;
}

/**
 * 这一趟是不是「发版还没动手就没成」、同一个提交连着这样几趟了（#2728）：状态 failed、release.sh 没起（release.started 不为真）、
 * 停在第 0–3 步。是的话回连败趟数（进度记录的 untouchedFails；老记录没有这个键算 1 趟），不是回 0。
 */
export function untouchedFails(train) {
  if (!train || typeof train !== 'object' || train.status !== 'failed') return 0;
  if (train.release && typeof train.release === 'object' && train.release.started === true) return 0;
  if (!Number.isInteger(train.phase) || train.phase < 0 || train.phase > 3) return 0;
  return Number.isInteger(train.untouchedFails) && train.untouchedFails > 0 ? train.untouchedFails : 1;
}

/** 进度记录原文 → 对象；不在、认不出回 null（gateVerdict 自己会把认不出当原因）。 */
function parseTrain(text) {
  if (text === null || text === undefined) return null;
  try {
    const t = JSON.parse(String(text));
    return t !== null && typeof t === 'object' && typeof t.status === 'string' ? t : null;
  } catch {
    return null;
  }
}

const trainTarget = (t) => (t?.target && typeof t.target === 'object' ? t.target.value : '');

/**
 * 自动发版的闸：releaseGate 读来的事实 → 回 null（可以发）或不发的原因。读不到、认不出的一律是原因，不当成可以发。
 * facts：{ missing: 缺的接活文件（数组，空 = 装了）, requestPending: 上一份请求还没被接走, marker: 有暂停标记,
 * trainText: 发版进度文件原文（不在是 null）, lockBusy: 发布锁被占着,
 * current: 法国 current 的提交号（没有是 null）, mainline: 主线提交号，从新到旧, target: 这一轮要发的提交 }。
 * failed 记录：current 已等于或新于它所记 target 时不挡（trainFailureSuperseded）；发版还没动手就没成的（untouchedFails）
 * 不挡，下一轮照常重试——同一个提交连败 UNTOUCHED_FAIL_LIMIT 趟才挡（换了要发的提交不挡：修好的新提交要能发上来）。
 */
export function gateVerdict(facts) {
  if (!facts || typeof facts !== 'object') return '发版闸的事实没读到';
  if (!Array.isArray(facts.missing)) return '发版接活单元装没装没读到';
  if (facts.missing.length > 0) return `发版接活单元没装（缺 ${facts.missing.join('、')}）`;
  if (facts.requestPending) return '上一份发布请求还没被接走';
  if (facts.marker) return '有发版暂停标记（上一趟没收尾或发版车停着）';
  if (facts.lockBusy) return '发布锁被占着（有发布在跑）';
  if (facts.trainText !== null && facts.trainText !== undefined) {
    let t;
    try {
      t = JSON.parse(String(facts.trainText));
    } catch {
      return '发版进度记录认不出（不是 JSON），不敢覆盖';
    }
    if (t === null || typeof t !== 'object' || typeof t.status !== 'string') {
      return '发版进度记录认不出（没有 status），不敢覆盖';
    }
    // 正常在走：等它收尾，不叫人看。收了尾没成（failed、blocked……）才要人看。done / aborted 不挡。
    if (t.status === 'running') {
      const raw = t.target && typeof t.target === 'object' ? t.target.value : '';
      const sha = typeof raw === 'string' && raw ? short(raw) : '进度记录没写提交';
      return `有一趟发版在跑（${sha}），等它收尾`;
    }
    // 判据在 trainFailureSuperseded：current 已等于或新于失败记录的 target，旧 failed 不再要人看。
    if (
      t.status !== 'done' &&
      t.status !== 'aborted' &&
      !trainFailureSuperseded(t, facts.current, facts.mainline)
    ) {
      const n = untouchedFails(t);
      if (n === 0) return `上一趟发版是「${t.status}」状态，要人看，不自动再发`;
      const sameTarget = typeof facts.target !== 'string' || facts.target === trainTarget(t);
      if (n >= UNTOUCHED_FAIL_LIMIT && sameTarget) {
        return `${short(trainTarget(t))} 发版还没动手就连败 ${n} 趟（第 ${t.phase} 步：${why(t.why ?? '没写原因')}），不再自动发，等急修`;
      }
    }
  }
  return null;
}

/**
 * 自动发版（决定 0088 第 1 条；#2038、决定 0093 起不再隔 1 小时）：法国在用的落后主线头、闸全过，
 * 就请求发「在用的之后最近一个 CI 全绿的提交」（st.ciGreen，greenStep 算；写和驾驶舱按钮一样的请求文件）。
 * 合得勤时头的 CI 总在跑，只认头就永远发不出去（#2676）；头绿就是发头，头不绿发头之前最近绿的，都不绿才等。
 * 只往前走：要发的必须比在用的新，在用的自己和比它旧的不发。发版不再关总开关、只暂停在跑的任务，攒着发没有好处，绿了就发。
 * 只防一件事：同一个要发的提交 REQUEST_DEDUPE_MS 内请求过就不再写（接活单元读走请求到写进度之间的空档，闸看着全过）。
 * 不过的把原因记进 st.auto.note（journal 和状态里看得到）；发的不是头时 note 写明头的 CI 怎么了、发的是哪个。写不出请求就报警，写成了撤。
 */
async function releaseStep(io, st, now, current) {
  const note = (text) => {
    st.auto = { sha: st.auto?.sha ?? null, at: st.auto?.at ?? null, note: text };
  };
  if (typeof io.requestRelease !== 'function') return note('这台没接上自动发版');
  if (current === null) return note('法国还没发布过，第一次发版走驾驶舱按钮');
  const head = st.main.head;
  const idx = st.main.commits.findIndex(([sha]) => sha === current);
  if (idx === 0) return note('在用的就是主线头，没有要发的');
  if (idx < 0) return note('在用的不在主线最近的提交里，不自动发');
  const headCi = st.ci?.sha === head ? st.ci.verdict : '没查';
  const green = st.ciGreen;
  if (!green) {
    const span = Math.min(idx, CI_RUNS_PAGE);
    return note(
      `主线头 ${short(head)} 的 CI 不是绿的（${headCi}），在用的之后最近 ${span} 个提交里也没有 CI 全绿的，等绿`,
    );
  }
  // 只往前走：要发的必须比在用的新（green.index 是它在主线里排第几，在用的排 idx）
  const target = st.main.commits[green.index]?.[0];
  if (target !== green.sha || green.index >= idx) {
    return note(`最近绿的 ${short(green.sha)} 不比在用的 ${short(current)} 新，不发`);
  }
  // 为什么发的不是头：写进 note 和 summary
  const reason =
    green.index === 0
      ? ''
      : `；头 ${short(head)} 的 CI ${headCi === 'pending' ? '还在跑' : `不是绿的（${headCi}）`}，发最近绿的 ${short(target)}，比在用的新 ${idx - green.index} 个`;
  let gateFacts = null;
  let blocked = null;
  try {
    gateFacts = await io.releaseGate();
  } catch (e) {
    blocked = `发版闸读不到：${why(e)}`;
  }
  const train = parseTrain(gateFacts?.trainText);
  // 防重复只管「请求写了、接活单元还没写进度」那个空档：进度记录里已经有这次请求之后起的一趟（比如第 0 步没成），就不算刚请求过
  const askedAt = st.auto?.sha === target ? Date.parse(st.auto.at ?? '') : Number.NaN;
  const pickedUp = trainTarget(train) === target && Date.parse(String(train?.startedAt ?? '')) >= askedAt;
  if (!Number.isNaN(askedAt) && Number(now) - askedAt < REQUEST_DEDUPE_MS && !pickedUp) {
    return note(`刚请求过 ${short(target)}，等接活单元发${reason}`);
  }
  blocked ??= gateVerdict({
    ...gateFacts,
    current,
    target,
    mainline: Array.isArray(st.main?.commits) ? st.main.commits.map((row) => row[0]) : [],
  });
  if (blocked) {
    const n = untouchedFails(train);
    if (n >= UNTOUCHED_FAIL_LIMIT && trainTarget(train) === target) {
      return note(`现在不发：${blocked}；${await emergencyStep(io, st, now, train, n)}${reason}`);
    }
    return note(`现在不发：${blocked}${reason}`);
  }
  try {
    await io.requestRelease({ sha: target, at: iso(now), by: AUTO_RELEASE_BY });
  } catch (e) {
    note(`发版请求没写成：${why(e)}${reason}`);
    raise(
      st,
      AUTO_REQUEST_KEY,
      `自动发版的请求没写出去（${short(target)}）`,
      `${why(e)}。下一轮自动再试；要马上发可以点驾驶舱「发布到法国」。`,
    );
    return;
  }
  resolveKeyLater(st, AUTO_REQUEST_KEY);
  // 连败停下的那个提交被挡着，能写出请求说明要发的已经换了（修好的新提交）：急修单没开成的那条报警不用再挂
  resolveKeyLater(st, EMERGENCY_KEY);
  st.auto = {
    sha: target,
    at: iso(now),
    note: `已请求自动发版 ${short(target)}（在用 ${short(current)}，落后 ${idx} 个提交${reason}）`,
  };
  act(st, now, 'auto-release-requested', `请求发 ${short(target)}`);
}

const PHASE_NAMES = ['预检', '暂停本机', '暂停法国', '等收尾'];

/**
 * 连败停下时开的急修单（引擎能接的四节单，贴「缺陷」、进当前版本；不是要人拍的卡）。key 按提交，同一个提交只开一张
 * （fleet-api emergency-issue 按 key 幂等）。「怎么算做完」只写 diff 里看得见的。
 */
export function emergencyIssue(train, n) {
  const sha = trainTarget(train);
  const phase = Number.isInteger(train?.phase) ? train.phase : 0;
  const step = `第 ${phase} 步「${PHASE_NAMES[phase] ?? '?'}」`;
  const reason = why(train?.why ?? '进度记录没写原因');
  return {
    key: `release-untouched:${sha}`,
    title: `急修：法国自动发版 ${short(sha)} 在${step}连败 ${n} 趟，已停`,
    body: [
      '## 场景',
      '',
      `法国自动发版请求发 \`${sha}\`，接活单元（fleet-release-request）在${step}就没成、什么都还没动；同一个提交连着 ${n} 趟都这样，` +
        '自动发版停下、不再请求这个提交（主线上新的提交照常发）。',
      '',
      `最后一趟的原因：${reason}`,
      '',
      '现场（只读）：`journalctl -u fleet-release-request -n 100`；进度 `/srv/fleet-dao-releases/.train/release-train.json`；' +
        '自动发布的读数 `journalctl -u fleet-auto-release -n 30`。',
      '',
      '## 原话',
      '',
      '无（AI 发现：法国自动发布单元在同一个提交发版连败时开的急修单，#2728）。',
      '',
      '## 已知的模块',
      '',
      '- `deploy/france/release-request/lib.mjs`',
      '- `deploy/france/release-request/fleet-release-request.mjs`',
      '- `deploy/france/auto-release/lib.mjs`',
      '',
      '## 怎么算做完',
      '',
      `- 找到${step}没成的根因，修在必经的那一步；测试里造出同样的失败，改前红、改后绿。`,
      '- 失败原因里写得出是哪一样没成（模块名、命令、文件），不是只有尾几行。',
    ].join('\n'),
  };
}

/**
 * 同一个提交连败 UNTOUCHED_FAIL_LIMIT 趟、自动发版停下：开急修单（io.fileIssue，真的是 current 那一版的 fleet-api emergency-issue）。
 * 开成了记进 st.emergency，不再开；没开成（fleet-api 本身坏了、GitHub 不通）报 EMERGENCY_KEY、每轮再试。回一句写进 note 的话。
 */
async function emergencyStep(io, st, now, train, n) {
  const sha = trainTarget(train);
  if (st.emergency?.sha === sha && Number.isInteger(st.emergency.number)) {
    return `已开急修单 #${st.emergency.number}，等修好的新提交`;
  }
  const issue = emergencyIssue(train, n);
  let got;
  try {
    if (typeof io.fileIssue !== 'function') throw new Error('这台没接上开单（io.fileIssue）');
    got = await io.fileIssue(issue);
    if (!got || !Number.isInteger(got.number)) throw new Error('开单的回话里没有单号');
  } catch (e) {
    st.emergency = { sha, number: null, error: why(e), at: iso(now) };
    keepRaised(
      st,
      EMERGENCY_KEY,
      `自动发版 ${short(sha)} 连败 ${n} 趟停了，急修单没开成`,
      `${issue.title}。开急修单没成：${why(e)}。每轮自动再试；最后一趟的原因：${why(train?.why ?? '没写')}。`,
    );
    act(st, now, 'emergency-issue-failed', why(e));
    return `急修单没开成（${why(e)}），下一轮再开`;
  }
  st.emergency = { sha, number: got.number, url: got.url ?? null, at: iso(now) };
  resolveKeyLater(st, EMERGENCY_KEY);
  act(st, now, 'emergency-issue', `开了急修单 #${got.number}`);
  return `已开急修单 #${got.number}，等修好的新提交`;
}

/**
 * fleet-api engine status 的回话 → { ok, on } 或 { ok: false, why }（真 io 用它解析；判法同 release-request/lib.mjs 的 engineRead）。
 * 认不出、退出码不是 0（含老版没有 engine 命令）都是读不到，不当成关着。
 */
export function parseEngineStatus(code, stdout) {
  if (code !== 0) return { ok: false, why: `fleet-api engine status 退出码 ${code}：${why(stdout)}` };
  const m = /引擎总开关：(开着|关着)/.exec(String(stdout));
  if (!m) return { ok: false, why: `总开关的回话认不出：${why(stdout)}` };
  return { ok: true, on: m[1] === '开着' };
}

/**
 * 发版驱动（release.sh 或接活单元）中途死了留下的残局，这一轮自动收（#2038、决定 0093）。两件，各自独立：
 * - 暂停名单遗留（recoverPaused）：release.sh 切版本前给在跑的任务发了 hard 暂停、名单落在 PAUSE_FILE，正常由它收尾时发「继续」；
 *   它死在中途（被杀、机器重启），那些任务就一直停着没人管。
 * - 老版驱动关了总开关没开回（recoverTrain）：发版前关总开关的那版驱动死在中途，留下暂停标记，引擎一直不接活，
 *   而且暂停标记还挡着自动发版（gateVerdict），新版就永远发不上来。
 * io 没接这几个口子（老测试、没装好的机器）就跳过，不当成没有残局。
 */
async function recoverStep(io, st, now) {
  await recoverPaused(io, st, now);
  await recoverTrain(io, st, now);
}

/** 继续的结果（fleet-api release continue 打到标准输出最后一行的名单 JSON）：认不出回 null。 */
function parseContinueResult(out) {
  const lines = String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const l = JSON.parse(line);
      if (l && Array.isArray(l.entries)) return l;
    } catch {
      // 下一行
    }
  }
  return null;
}

const entryName = (e) =>
  e && typeof e.repo === 'string' && Number.isInteger(e.issueNumber)
    ? `${e.repo}#${e.issueNumber}`
    : `任务 ${String(e?.taskId ?? '？')}`;

/**
 * 暂停名单遗留：名单在、发布锁空着（有发布在跑时名单是那一趟的，不碰）、放了 PAUSED_STALE_MS 以上，就是驱动没收尾。
 * 用 current 那一版的 fleet-api release continue 替它发「继续」（只动发版暂停的，人手暂停的它自己认得出不动）。
 * 不管成没成都把名单改名成 .handled-<时间>：继续不幂等地重试会每 5 分钟发一次、报一次，没成的列进报警要人看就够了。
 * 名单读不到、认不出照实记下，不当成没有。
 */
async function recoverPaused(io, st, now) {
  if ([io.pausedLeftover, io.resumePaused, io.retirePaused].some((fn) => typeof fn !== 'function')) return;
  let f;
  try {
    f = await io.pausedLeftover();
  } catch (e) {
    act(st, now, 'paused-unreadable', `发版暂停名单 ${PAUSE_FILE} 在不在读不到：${why(e)}`);
    return;
  }
  if (!f || typeof f !== 'object' || typeof f.exists !== 'boolean') {
    act(st, now, 'paused-unreadable', `发版暂停名单 ${PAUSE_FILE} 在不在认不出`);
    return;
  }
  if (!f.exists) return;
  if (f.lockBusy !== false) return; // 有发布在跑（或锁读不到）：名单是那一趟的，由它收尾
  if (!Number.isFinite(f.ageMs)) {
    act(st, now, 'paused-unreadable', `发版暂停名单 ${PAUSE_FILE} 放了多久读不到`);
    return;
  }
  if (f.ageMs < PAUSED_STALE_MS) return;
  let r;
  try {
    r = await io.resumePaused();
  } catch (e) {
    r = { code: -1, out: why(e) };
  }
  const handled = `${PAUSE_FILE}.handled-${iso(now).replace(/[:.]/g, '-')}`;
  let moved = '';
  try {
    await io.retirePaused(handled);
  } catch (e) {
    moved = `名单没改成 ${handled}（${why(e)}），下一轮还会再发一次「继续」；`;
  }
  const list = parseContinueResult(r?.out);
  const tried = list ? list.entries.filter((e) => e?.pausedOk) : null;
  const done = tried ? tried.filter((e) => e.result === 'continued') : [];
  const bad = tried ? tried.filter((e) => e.result === 'failed') : [];
  const n = tried ? tried.length : '名单上';
  const result = tried
    ? `继续了 ${done.length} 个；` +
      (bad.length
        ? `没继续上 ${bad.length} 个，要人看：${bad.map((e) => `${entryName(e)}${e.why ? `（${e.why}）` : ''}`).join('、')}；`
        : '')
    : `结果认不出：${why(r?.out)}；`;
  raise(
    st,
    PAUSED_ALERT_KEY,
    `发版驱动没收尾，自动给 ${n} 个发版暂停的任务发了继续`,
    `发版暂停名单 ${PAUSE_FILE} 放了 ${minutes(f.ageMs)} 分钟、发布锁空着：发版驱动死在中途、没发「继续」。` +
      `已用 current 那一版的 fleet-api release continue 替它发了：${result}退出码 ${r?.code ?? '？'}。` +
      `${moved}名单${moved ? '' : `已改名成 ${handled}，`}不再重试。看过了手动解除这条。`,
  );
  act(st, now, 'paused-resumed', `替没收尾的发版发了「继续」：退出码 ${r?.code ?? '？'}`);
}

/**
 * 总开关开着、驱动不在、锁空着时的暂停标记是残留：删掉，再写一条操作记录（audit_log，actor 是运维脚本 ops:auto-release）。
 * 先删后记：操作记录写的是已经发生的事；先记后删，删没成就留下一条假的「删了」。记没写进去也不回头装回标记（它会一直挡发版），
 * 报一条说「删了、没记上」——报警本身就是这次动作的记录，不当成没事。
 */
async function clearLeftoverMarker(io, st, now, t) {
  const state = t === null ? '进度记录不在' : `进度记录是「${t.status}」（第 ${t.phase ?? '？'} 步）`;
  const reason = `${MARKER_CLEAR_REASON}：总开关开着、${state}、发布锁空着`;
  try {
    await io.clearTrainMarker();
  } catch (e) {
    keepRaised(
      st,
      TRAIN_MARKER_KEY,
      '残留的发版暂停标记没删掉，自动发版被它挡着',
      `${reason}，删 ${TRAIN_MARKER} 没成：${why(e)}。每轮自动再试；也可以在法国以 root 手动删。`,
    );
    act(st, now, 'marker-clear-failed', why(e));
    return;
  }
  try {
    await io.audit({
      action: MARKER_CLEAR_ACTION,
      target: `file:${TRAIN_MARKER}`,
      reason,
      before: { marker: true, train: t === null ? null : { status: t.status, phase: t.phase ?? null } },
      after: { marker: false },
    });
  } catch (e) {
    raise(
      st,
      TRAIN_MARKER_KEY,
      '删了残留的发版暂停标记，操作记录没写进去',
      `${reason}，已删 ${TRAIN_MARKER}；写操作记录（${MARKER_CLEAR_ACTION}）没成：${why(e)}。这条报警就是这次删除的记录，看过了手动解除。`,
    );
    act(st, now, 'marker-cleared-unaudited', `删了残留的发版暂停标记，操作记录没写进：${why(e)}`);
    return;
  }
  resolveKeyLater(st, TRAIN_MARKER_KEY);
  act(st, now, 'marker-cleared', '删了残留的发版暂停标记（总开关开着、驱动不在），已记操作记录');
}

/**
 * 老版发版驱动的残局：暂停标记在、驱动已经不在了（进度记录不在，或状态不是 running，或记的进程已经死了）、发布锁空着，
 * 再看总开关（读不到就什么都不碰）：
 * - 总开关开着：标记是残留（人开回了总开关、或驱动开回后没来得及删），删掉它，不然它一直挡自动发版（gateVerdict）；
 *   删了写一条操作记录（clearLeftoverMarker）。
 * - 总开关关着：发版前是开着的（before.master === true）、进度 TRAIN_STALE_MS 没更新，才开回去（少一项都可能是驱动还活着、
 *   或人有意关着，不碰）。开回去读回确认，成了删暂停标记。
 * 进度记录（release-train.json）一概不改：那一趟到底停在哪一步要人看，报一条。
 */
async function recoverTrain(io, st, now) {
  const need = [io.trainLeftover, io.engineOn, io.clearTrainMarker, io.audit];
  if (need.some((fn) => typeof fn !== 'function')) return;
  let f;
  try {
    f = await io.trainLeftover();
  } catch (e) {
    act(st, now, 'train-unreadable', `老版发版驱动的残局读不到：${why(e)}`);
    return;
  }
  if (!f || typeof f !== 'object') {
    act(st, now, 'train-unreadable', '老版发版驱动的残局认不出');
    return;
  }
  if (!f.marker) return;
  let t = null;
  if (f.trainText !== null && f.trainText !== undefined) {
    try {
      t = JSON.parse(String(f.trainText));
    } catch {
      t = undefined;
    }
    if (t === null || typeof t !== 'object' || typeof t.status !== 'string') {
      act(st, now, 'train-unreadable', '有发版暂停标记，进度记录认不出：不碰标记和总开关');
      return;
    }
  }
  if (t !== null) {
    const alive = typeof f.pidAlive === 'function' ? f.pidAlive(t.pid) : f.pidAlive;
    const pidDead = Number.isInteger(t.pid) && alive === false;
    if (t.status === 'running' && !pidDead) return; // 驱动可能还在走
  }
  if (f.lockBusy !== false) return; // 有发布在跑（或锁读不到）
  if (!f.engine?.ok) {
    act(st, now, 'train-unreadable', `总开关读不到，不碰标记和总开关：${f.engine?.why ?? '没读'}`);
    return;
  }
  if (f.engine.on) {
    await clearLeftoverMarker(io, st, now, t);
    return;
  }
  if (t === null || t.before?.master !== true) return; // 没有进度记录、或发版前总开关就关着（没记下）：不猜着开
  const updated = Date.parse(String(t.updatedAt));
  if (Number.isNaN(updated)) {
    act(st, now, 'train-unreadable', '发版进度记录的 updatedAt 认不出：不自动开总开关');
    return;
  }
  if (Number(now) - updated < TRAIN_STALE_MS) return;
  let r;
  try {
    r = await io.engineOn(TRAIN_RESTORE_REASON);
  } catch (e) {
    r = { code: -1, out: why(e) };
  }
  let back = null;
  if (r?.code === 0) {
    try {
      back = (await io.trainLeftover())?.engine ?? null;
    } catch {
      back = null;
    }
  }
  // 写最后更新的时刻、不写「几分钟没更新」：没开回那条每轮都判，正文不变才不每 5 分钟重发（keepRaised）
  const stale = `发版进度记录（第 ${t.phase ?? '？'} 步、${t.status}）从 ${iso(updated)} 起没再更新`;
  if (r?.code !== 0 || !back?.ok || !back.on) {
    const whyNot =
      r?.code !== 0
        ? `fleet-api engine on 退出码 ${r?.code ?? '？'}：${why(r?.out)}`
        : back?.ok
          ? 'engine on 说成了，读回来还是关着'
          : '开完读不回总开关';
    keepRaised(
      st,
      TRAIN_RESTORED_KEY,
      '发版驱动没收尾，总开关没开回',
      `${stale}、驱动已经不在，发版前开着的总开关还关着。自动开回没成：${whyNot}。每轮自动再试；` +
        `也可以在驾驶舱环境页手动打开，再删掉 ${TRAIN_MARKER}。`,
    );
    act(st, now, 'train-restore-failed', whyNot);
    return;
  }
  let cleared = '';
  try {
    await io.clearTrainMarker();
  } catch (e) {
    cleared = `暂停标记 ${TRAIN_MARKER} 没删成（${why(e)}），它会一直挡着自动发版，要手动删；`;
  }
  raise(
    st,
    TRAIN_RESTORED_KEY,
    '发版驱动没收尾，自动开回了总开关',
    `${stale}、驱动已经不在：已把发版前开着的总开关开回去（读回是开着）。${cleared}` +
      `发版进度记录 ${TRAIN_STATE} 的状态没改，那一趟停在哪一步要人看；看过了手动解除这条。`,
  );
  act(st, now, 'train-restored', '发版驱动没收尾，开回了总开关');
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

/** france.sh --auto-tier 的红行（`  ✗ …`）。待配是 `…`，不算红。 */
function tierRedLines(out) {
  return String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('✗'));
}

/**
 * 唯一的红是「4318 的 /api/health 还连不上」（curl 退出 7）。服务刚 ActiveEnter、还没 listen 就是这样。
 * 旁边还有别的红（单元没起来、文件对不上）：那是真失败，不拿冷启动挡。
 */
function isMirasimBootRace(out) {
  const reds = tierRedLines(out);
  return reds.length > 0 && reds.every((l) => l.includes('curl 退出 7') && l.includes('/api/health'));
}

function tierDetail(r) {
  const lines = String(r.out)
    .split('\n')
    .filter((l) => /^\s*[✗…]/.test(l))
    .slice(0, 3)
    .map((l) => l.trim());
  return `退出码 ${r.code}${lines.length ? `，${lines.join('；')}` : `，${why(r.out)}`}`;
}

function tierFailed(st, now, current, detail) {
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
 * 冷启动从何时起算。读得到 ActiveEnter 用它（刚进入 active、端口还没开）。
 * 读不到：用这一提交上已经记下的 unchecked.at，没有就从这一轮看见退出 7 起算。不把「读不到」当成窗口已过。
 */
async function bootSince(io, st, now, current) {
  if (typeof io.mirasimActiveEnter === 'function') {
    try {
      const v = await io.mirasimActiveEnter();
      if (Number.isFinite(v) && v > 0) return v;
    } catch {
      // 落到下面：从第一次看见这次连不上起算
    }
  }
  if (st.tier?.commit === current && st.tier.result === 'unchecked') {
    const at = Date.parse(st.tier.at);
    if (!Number.isNaN(at)) return at;
  }
  return Number(now);
}

/**
 * 装机的自动档（决定见 docs/ops.md 第九节「装机层」）：在用的版本和检出是同一个提交、这个提交还没装过，就以 root 跑
 * `france.sh --auto-tier`（自动发布脚本副本、systemd 单元、fleet-agents.slice、清掉已删的老单元；不碰防火墙、sudoers、用户、钥匙）。
 * 发一版（驾驶舱按钮）之后检出和在用的对上，下一轮就装。真失败记下、报警，同一个提交最快隔 TIER_RETRY_MS 再试。
 * 冷启动（curl 退出 7，ActiveEnter 还在 TIER_BOOT_MS 内）本轮不落 failed：隔几秒再探，探到 ok 就写成 ok，不必干等 30 分钟。
 * 退出码 2（没红、有待配）算装上了。先于规矩那一步：规矩同步用的是检出里的脚本，和这里无关，但装机脚本要先到位。
 */
async function tierStep(io, st, now, current) {
  if (!current || typeof io.applyAutoTier !== 'function') return;
  if (st.tier?.commit === current) {
    if (st.tier.result === 'ok') return;
    // 只有真失败才套 30 分钟。unchecked 是冷启动窗口还开着，下一轮（或本轮接着探）就要再试。
    if (st.tier.result === 'failed' && now - Date.parse(st.tier.at) < TIER_RETRY_MS) return;
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
  for (let polls = 0; ; polls++) {
    let r;
    try {
      r = await io.applyAutoTier();
    } catch (e) {
      r = { code: -1, out: why(e) };
    }
    if (r.code === 0 || r.code === EXIT_PENDING) {
      st.tier = { commit: current, at: iso(io.now()), result: 'ok', detail: '' };
      resolveLater(st, TIER_PREFIX);
      return;
    }
    const detail = tierDetail(r);
    // 不是「刚重启、4318 还没 listen」：立刻落 failed，之后隔 TIER_RETRY_MS 再试。
    if (!isMirasimBootRace(r.out)) {
      tierFailed(st, io.now(), current, detail);
      return;
    }
    const tick = Number(io.now());
    const since = await bootSince(io, st, tick, current);
    if (tick - since >= TIER_BOOT_MS) {
      tierFailed(st, tick, current, detail);
      return;
    }
    // 窗口还开着：先记 unchecked（不报警、healthz 不报 tier_failed）。能睡就再探，探到 ok 或窗口关。
    st.tier = { commit: current, at: iso(since), result: 'unchecked', detail };
    if (polls >= TIER_BOOT_POLLS || typeof io.sleep !== 'function') return;
    const left = since + TIER_BOOT_MS - tick;
    const before = tick;
    await io.sleep(Math.min(TIER_BOOT_POLL_MS, left));
    // 时钟没往前走就停，免得空转把这一轮卡死；unchecked 留着，下一轮接着探。
    if (Number(io.now()) <= before) return;
  }
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

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

/** 发版接活单元记的提醒键前缀（release-request/lib.mjs 的 RELEASE_NOTE_PREFIX、releaseNote）。 */
const RELEASE_NOTE_PREFIX = 'release:';

/**
 * 被后来的发版取代了的失败卡自动撤（#2728）：进度记录是 failed、而在用的已经等于或新于那一趟的目标（trainFailureSuperseded），
 * 那一趟的 `release:failed:<前12位>:` 提醒就没有要处理的了（10-16 17:17 一趟 --check 网络超时判了失败，3 分钟后下一版发成功，那张卡一直开着）。
 * 撤走 flushAlerts 的按前缀解除（resolved_by auto-release）；同一个目标只撤一次（st.superseded 记下），撤不成下一轮接着撤（resolve 队列）。
 * io.readTrain() 回进度记录原文（不在回 null，读不了抛）；没接这个口子的跳过。读不了记一笔、不撤。
 */
async function supersededStep(io, st, current) {
  if (typeof io.readTrain !== 'function' || !st.main) return;
  let text;
  try {
    text = await io.readTrain();
  } catch (e) {
    act(st, io.now(), 'train-unreadable', `发版进度记录读不到，没核失败卡被取代没有：${why(e)}`);
    return;
  }
  const t = parseTrain(text);
  if (t?.status !== 'failed') return;
  const sha = trainTarget(t);
  if (!sha || st.superseded === sha) return;
  if (
    !trainFailureSuperseded(
      t,
      current,
      st.main.commits.map((row) => row[0]),
    )
  )
    return;
  const prefix = `${RELEASE_NOTE_PREFIX}failed:${short(sha)}:`;
  if (!st.resolve.includes(prefix)) st.resolve.push(prefix);
  st.superseded = sha;
}

/**
 * 脚本副本对账（#2728）：/usr/local/lib 下以 root 跑的副本（INSTALLED_COPIES）和在用那一版里的原件比哈希。不一致写进 st.installed
 * （result: drift，列出哪几个），后端 /healthz 的 deploy_lag 当轮就报，不等 24 小时；读不到记 unchecked，不当成一致。
 * io.readInstalled(current) 回 [{ name, installed: 原文|null（没装）, release: 原文|null }]，读不了抛。每轮重算、不带到下一轮。
 */
async function installedStep(io, st, now, current) {
  if (typeof io.readInstalled !== 'function') return;
  let files;
  try {
    files = await io.readInstalled(current);
    if (!Array.isArray(files) || files.length === 0) throw new Error('读回来的文件清单是空的');
  } catch (e) {
    st.installed = { commit: current, checkedAt: iso(now), result: 'unchecked', drift: [], detail: why(e) };
    return;
  }
  const drift = [];
  const unread = [];
  for (const f of files) {
    if (typeof f?.release !== 'string') unread.push(`${f?.name ?? '?'}（在用那一版里没有原件）`);
    else if (typeof f.installed !== 'string') drift.push(`${f.name}（没装）`);
    else if (sha256(f.installed) !== sha256(f.release)) drift.push(f.name);
  }
  const result = drift.length > 0 ? 'drift' : unread.length > 0 ? 'unchecked' : 'ok';
  st.installed = {
    commit: current,
    checkedAt: iso(now),
    result,
    drift,
    detail:
      result === 'ok'
        ? ''
        : [
            drift.length ? `和在用的 ${short(current)} 不一样：${drift.join('、')}` : '',
            unread.length ? `没查成：${unread.join('、')}` : '',
          ]
            .filter(Boolean)
            .join('；'),
  };
}

/** pnpm 的 node_modules/.modules.yaml 里的 prunedAt（上一次装依赖的时刻）；没有回 null。 */
export function prunedAtOf(text) {
  return /^\s*"?prunedAt"?\s*:\s*"?([^"\n]+?)"?\s*,?\s*$/m.exec(String(text ?? ''))?.[1] ?? null;
}

/**
 * 依赖指纹（#2728）：在用那一版的 node_modules/.modules.yaml（pnpm 每装一次都重写，含 prunedAt）。发版后第一轮记下指纹，
 * 之后每轮核对；变了（有人在发布目录里重装过依赖）当轮报警，正文写出前后两次的 prunedAt。换了在用的提交重新记、撤掉旧的报警。
 * 读不到记 unchecked（不当成没变）。io.readDeps(current) 回原文，读不了抛。
 */
async function depsStep(io, st, now, current) {
  if (typeof io.readDeps !== 'function') return;
  const key = `${DEPS_PREFIX}${current}`;
  let text;
  try {
    text = await io.readDeps(current);
  } catch (e) {
    st.deps = {
      ...(st.deps?.commit === current
        ? st.deps
        : { commit: current, fingerprint: null, prunedAt: null, recordedAt: null }),
      result: 'unchecked',
      detail: why(e),
      checkedAt: iso(now),
    };
    return;
  }
  const fingerprint = sha256(text);
  const prunedAt = prunedAtOf(text);
  if (st.deps?.commit !== current || typeof st.deps.fingerprint !== 'string') {
    if (st.deps?.commit !== current) resolveLater(st, DEPS_PREFIX);
    st.deps = {
      commit: current,
      fingerprint,
      prunedAt,
      recordedAt: iso(now),
      result: 'ok',
      detail: '',
      checkedAt: iso(now),
    };
    return;
  }
  if (fingerprint === st.deps.fingerprint) {
    st.deps = { ...st.deps, result: 'ok', detail: '', checkedAt: iso(now) };
    return;
  }
  const detail = `在用的 ${short(current)} 的依赖发版后被重装过：记下时 prunedAt ${st.deps.prunedAt ?? '（没有）'}，现在 ${prunedAt ?? '（没有）'}`;
  st.deps = { ...st.deps, result: 'changed', detail, checkedAt: iso(now) };
  keepRaised(
    st,
    key,
    `在用版本的依赖发版后被动过（${short(current)}）`,
    `${detail}（${RELEASES}/${current}/node_modules/.modules.yaml，指纹 ${st.deps.fingerprint.slice(0, 12)} → ${fingerprint.slice(0, 12)}）。` +
      '发布目录归 root、发完只读，不该有人再装；查是谁装的（journalctl、last、各会话的命令记录），下一次发版换了提交这条自己撤。',
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
  parts.push(`自动发版：${st.auto?.note ?? '这轮没判'}`);
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
  if (st.installed && st.installed.result !== 'ok') {
    parts.push(
      `脚本副本${st.installed.result === 'drift' ? '和在用版本不一致' : '没查成'}：${st.installed.detail}`,
    );
  }
  if (st.deps && st.deps.result !== 'ok') {
    parts.push(`依赖指纹${st.deps.result === 'changed' ? '变了' : '没查成'}：${st.deps.detail}`);
  }
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
