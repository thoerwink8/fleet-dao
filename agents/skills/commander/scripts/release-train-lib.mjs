// 发版前先暂停手头的活（#618，「每次发版本时，尽量在感觉要发版本的时候，就先把手头的活暂停。等手头的工作都暂停完，
// 就可以开始发版本。之后按照最优的顺序，把当前的任务清单依次执行下去。」）。release-train.mjs 是外壳（真的 ssh/gh/git/pnpm/睡眠），
// 全部逻辑在这份 release-train-lib.mjs（io 全部注入）。node release-train.mjs 不带参数看用法。
// 改这里之前必须知道：
// - 这份文件里没有任何真的起进程、连网、睡觉的代码：一切经 io 进来，agents/test/release-train.test.ts 换成假 ssh、假 gh、假时钟。
//   真跑的代码路径不许在测试里碰真 ssh（那条路只在 release-train.mjs 外壳里）。
// - 阶段（方案 4.2，每阶段有上限，到点停下列出拖后腿的，不硬来）：0 预检（只读）→1 本机（占位）→2 暂停法国（只记总开关）→
//   3 等收尾（只等要发的提交的 CI）→4 发版（对外发布，必须带 --founder-ok）→5 等部署→6 验证→7 恢复（核对开关）→8 派清单。状态记在 ~/.fleet-dao/release-train.json，
//   停在「卡住」（blocked）或「没成」（failed）时再跑一次 start（同一个目标）从停下的那一步接着走；换目标要先 abort。
// - 驱动活着的证据（#1674）：每次落盘都把 driver { pid, host, heartbeatAt } 写进状态，等收尾、等部署、验证的轮询里每圈也落一次。
//   status、start 判「驱动死了」：同一台机器上 pid 不在，或心跳比该步上限（phaseBudgetMs）加余量（deadMarginMs）还老。
//   start 同一个目标遇到驱动已死的 running，当成「没成」从停下的那一步接着走；停在第 4 步的先读法国 .history 判发没发成。
//   巡查报总开关关着时读这份状态（trainAlertNote），写明是「发版车驱动死了没人恢复」还是别的（只剩老现场那一支会关着）。
// - 第 1 步「本机」是占位：脱离会话的工人一族已删（P5），本机没有要暂停的东西；步号不动，免得改状态文件里的 phase 和一键发版的哨兵字样。
// - 发版不关引擎总开关（#2038、决定 0093）：release.sh 切版本前自己给在跑的任务发 hard 暂停（暂停人「发版」）、
//   只等不可暂停的几段最多 2 分钟，切完对这一批发「继续」。所以第 2 步只读总开关记下发版前的样子（before，pausedMaster: false），
//   第 3 步只等要发的提交的 CI、不等法国会话收尾，第 7 步只核对总开关和发版前一致：不一致照实报，不替人开或关。
//   兼容老现场：上一回老版本发版车停在「卡住」「没成」时总开关是它关的（before.master 为真、记录里没有 pausedMaster、现在关着），
//   第 2 步认出来记 pausedMaster: true，第 7 步照老规矩开回总开关和记下的各仓接活开关，开不回去算没成（退出码 2）。
//   release.sh 发完不置关（决定 0032 第 4 条、#1256）；--restore 留着当「明写要开回」的写法，和默认一样。
// - 第 4 步发版不跑法国检出里的 release.sh（那份经常还是上一版）。ssh 的是 releaseBootCommand：
//   把同目录 release-boot.sh 送过去，解开目标提交的 deploy/ 再 exec 那一版（#1294）。没有或读不出就拒，不退回检出里那份。
//   --check 仍跑检出里那份。
// - 第 4 步不靠一条前台 ssh 撑完整个发布（#1995，连着两次 ssh 被重置、发布其实跑完了却报「没成」）：
//   releaseLaunchCommand（release-launch.sh）让法国用 systemd 临时服务 fleet-train-release-<前12位> 跑 release-boot.sh，
//   日志末行 fleet-dao-release-exit=<n> 是发布结果；本机每 pollMs 把同一条幂等命令再发一遍读现状（started/attached/finished/lost/busy），
//   ssh 断了只重连，总时限 releaseMs，到点才判没成。同一目标重跑 start：服务还在跑就接着看，不起第二个、不报锁冲突。
// - 第 6 步验证只拦「预检基线里没有的、跟新版有关的」异常，比 key 不比条数（#1740）。健康项（服务、健康检查、发布历史、定时任务、
//   探针这类）新出现就拦；提醒项（法国库里没处理的提醒，franceHealth 的 items 里 source 'alert'）只拦键前缀在 RELEASE_ALERT_PREFIXES
//   里的（和这次发版有关的），重启打断的那几类（VERIFY_RETRY_PREFIXES）在 verifyMs 里重试、撤了就过；别的新提醒列出来不拦。
//   任务自己停下（kind task-park）是引擎照常干活的结果，不算新版的问题：不拦，只列出来给人看。
// - 读不到就是读不到：读不到法国会话数（预检）、总开关、主线 CI 时不往下走（也不当成 0 或绿），回 { ok: false, why }。
// - 所有打出来和记下来的字过 scrubText（令牌、邮箱、IP、长串抹掉）；ssh 的名字不进输出。
// - 退出码：0 做完了（或 abort 做完了）；1 用法不对或被拒（没带 --founder-ok、已有一趟在走）；2 没做成（读不到、命令失败）；
//   3 卡住（到点还有拖后腿的，名单已列出；现场没动，要么再跑 start 再等，要么 abort）。
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  isNotificationIssue,
  KIND_ROUTE_STALE,
  KIND_TASK_IDLE,
  KIND_TASK_PARK,
  RELEASE_ALERT_PREFIXES,
  scrubText,
  VERIFY_RETRY_PREFIXES,
} from './france-lib.mjs';
import {
  DEFAULT_LIMITS,
  driverVerdict,
  PHASES,
  readState,
  STATE_REL,
  stateFile,
  trainAlertNote,
} from './train-state-lib.mjs';

export { DEFAULT_LIMITS, driverVerdict, PHASES, STATE_REL, trainAlertNote };

export const RELEASES = '/srv/fleet-dao-releases';
/** 法国上的管理命令入口和发布脚本（docs/ops.md 第九节）。 */
export const FLEET_API = `bash ${RELEASES}/current/packages/api/bin/fleet-api`;
/**
 * 法国部署检出上的 release.sh（/srv/fleet-dao，不是在用目录 current 里那份）。
 * 只给 --check 用。发版不跑这份（检出经常还停在上一版）：第 4 步走 releaseBootCommand，
 * 解开目标提交再 exec 那一版，改了 release.sh 的这一次就生效（#1294）。
 */
export const RELEASE_SH = '/srv/fleet-dao/deploy/release.sh';
/** 发版车 ssh 上去跑的自举脚本。整段随这条命令送过去，不读法国检出里的文件。 */
export const RELEASE_BOOT_SH = readFileSync(
  fileURLToPath(new URL('./release-boot.sh', import.meta.url)),
  'utf8',
);
/** 第 4 步真正 ssh 上去跑的入口（#1995）：起（或接着看）一个脱离 ssh 的发布服务，回现状。幂等，每个轮询周期再发一遍。 */
export const RELEASE_LAUNCH_SH = readFileSync(
  fileURLToPath(new URL('./release-launch.sh', import.meta.url)),
  'utf8',
);
export const HISTORY_FILE = `${RELEASES}/.history`;
export const LOCK_FILE = `${RELEASES}/.lock`;
/** flock -E：另一个发布占着锁时回这个码（75，是这里自己给 flock 指定的，release.sh 没有这个码）。 */
const BUSY = 75;

export const USAGE = `用法：node release-train.mjs <命令>（在项目仓的检出里跑；发版会等很久，用 run_in_background 起）
  start --sha <提交> --founder-ok "<创始人原话>" [--restore]
        发版：0 预检（只读：主线 CI 绿、没有别的发布在跑、法国能读、列出挂了自动合并的 PR）→ 1 本机（占位，没有要暂停的）
        → 2 暂停法国（不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）；这里只记下发版前总开关的样子）
        → 3 等收尾（只等要发的提交的 CI 绿，有上限，到点停下列出拖后腿的；不等法国会话；挂了自动合并没合的 PR 只提示、不等）
        → 4 发版 → 5 等部署 → 6 验证 → 7 恢复（核对总开关和发版前一致）→ 8 按最优顺序打印当前版本的清单
        --sha：ssh 到法国，用目标提交自带的 release.sh 发（release-boot.sh 先解开那一版的包再 exec，不跑检出里还停着的旧脚本；决定 0032，#1294）；
              发布在法国的 systemd 临时服务里跑，ssh 断了不影响，本机轮询到发完（最长 releaseMs），不当成失败（#1995）
        --founder-ok：发版是对外发布，必须带创始人原话，没带就拒（什么都不做）
        第 7 步：这一趟没关总开关，只核对和发版前一致，不一致照实报（不替人开或关）；只有上一回老版本发版车关过的（老现场）才开回
        总开关和记下的各仓接活开关（写操作记录；开不回去算没成、退出码 2）
        --restore：明写「发完开回去」，和不给一样
        停在「卡住」或「没成」时，同一个目标再跑一次 start 从停下的那一步接着走（恢复没成也是这样重试）
  status          看这一趟走到哪、拖后腿的是谁（只读）
  abort           撤掉这一趟：这一趟不关总开关，没什么要开回的；老现场（老版本关过总开关）还没发版就开回发版前的样子，已经动手发过版
                  就保持关（不知道发成没有、健康没确认；确认没事后自己到环境页或 fleet-api engine on 开）
退出码：0 做完了；1 用法不对或被拒；2 没做成（读不到、命令失败）；3 卡住（到点还有拖后腿的，名单已列出）。`;

class UsageError extends Error {}

// —— 小工具 ——

const sayTo = (io, text) => io.out(scrubText(text));
const warnTo = (io, text) => io.err(scrubText(text));
const iso = (io) => io.now().toISOString();
const tailOf = (r, n = 3) =>
  scrubText(
    String(r.stderr || r.stdout || r.error || `退出码 ${r.status}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-n)
      .join(' / '),
  );
/** 第 4 步 ssh 命令的字数上限（#2015）：Windows 一条命令行约 8191 字符，再留 ssh 自己的参数和余量。 */
export const LAUNCH_COMMAND_MAX = 7500;
/** 单引号包起来交给法国的 shell：里面的单引号写成 '\'' */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 第 4 步 ssh 的命令（#1294）。不执行部署检出里的 release.sh。
 * 把 release-boot.sh 整段送过去：收下目标提交的 deploy/，exec 那一版自带的 release.sh。
 * 那一版没有、读不出：命令非 0，不改跑检出里那份。--check 仍用 RELEASE_SH。
 */
export function releaseBootCommand(sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`自举不接受这个提交号：${sha}`);
  return `bash -c ${shq(RELEASE_BOOT_SH)} fleet-release-boot ${sha}`;
}
/**
 * 第 4 步每个轮询周期 ssh 上去的命令（#1995）：release-launch.sh 整段 + 提交号 + 本趟令牌 + release-boot.sh（gzip 后 base64）。
 * 法国上由 systemd 临时服务跑 release-boot.sh（它再 exec 目标提交自带的 release.sh），ssh 断了发布照跑。
 * 令牌让同一趟里重发这条命令不会起第二个；换一趟（新的令牌）遇到服务还在跑就接着看，不起第二个。
 */
export function releaseLaunchCommand(sha, token) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`发版不接受这个提交号：${sha}`);
  if (!/^[A-Za-z0-9]{1,40}$/.test(token)) throw new Error(`发版令牌不合格式：${token}`);
  const b64 = gzipSync(Buffer.from(RELEASE_BOOT_SH, 'utf8'), { level: 9 }).toString('base64');
  const command = `bash -c ${shq(RELEASE_LAUNCH_SH)} fleet-release-launch ${sha} ${token} ${b64}`;
  // Windows 一条命令行约 8191 字符封顶，超了 ssh 收到的是被截断的（#2015）。留余量，超了当场报错，不悄悄送半截。
  if (command.length > LAUNCH_COMMAND_MAX)
    throw new Error(
      `发版命令 ${command.length} 字，超过 ${LAUNCH_COMMAND_MAX}（Windows 命令行约 8191 字符，超了会被截断）：release-launch.sh 或 release-boot.sh 太长了，要改成走标准输入送`,
    );
  return command;
}

/**
 * release-launch.sh 的回话 → { state, exit: 数字|null, log, tail } ；认不出回 null（当成没读到，不当成成功）。
 * state 取 started | attached | finished | lost | busy | refused。
 */
export function parseLaunchReport(stdout) {
  const text = String(stdout ?? '');
  const head = text.split(/\r?\n---\r?\n?/, 1)[0] ?? '';
  const kv = new Map();
  for (const line of head.split(/\r?\n/)) {
    const m = /^(state|exit|log)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1], m[2]);
  }
  const state = kv.get('state');
  if (!['started', 'attached', 'finished', 'lost', 'busy', 'refused'].includes(state ?? '')) return null;
  const exitText = kv.get('exit') ?? 'none';
  if (exitText !== 'none' && !/^\d+$/.test(exitText)) return null;
  const rest = text.includes('\n---') ? text.slice(text.indexOf('\n---') + 4) : '';
  return {
    state,
    exit: exitText === 'none' ? null : Number(exitText),
    log: kv.get('log') ?? '',
    tail: scrubText(
      rest
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-5)
        .join(' / '),
    ),
  };
}
/** 命令（run/ssh）没跑成：起不来、被超时杀、ssh 自己连不上。 */
const didNotRun = (r) => r.error || r.status === null || r.status === 255;
const minutes = (ms) => Math.round(ms / 60_000);

// —— 状态文件 ——

/** 落盘：先写临时文件再换名，半截的文件不会留下。 */
function saveState(io, state) {
  state.updatedAt = iso(io);
  if (Number.isInteger(io.pid))
    state.driver = { pid: io.pid, ...(io.host ? { host: io.host } : {}), heartbeatAt: state.updatedAt };
  const file = stateFile(io.home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 老状态文件（决定 0032 之前）可能记着 kind 'tag'：status、abort 照样能显示它，start 不会再接它。 */
function targetText(t) {
  return t.kind === 'sha' ? `${t.value.slice(0, 12)}` : t.value;
}

// —— 驱动死活（判法在 train-state-lib.mjs） ——

const verdictOf = (io, s) =>
  driverVerdict(s, { now: io.now(), isAlive: io.isAlive, host: io.host, limits: io.limits });

/** 同一个目标：种类相同，提交号一个是另一个的前缀（接着走的命令只写前 12 位，状态里可能是整串 40 位）。 */
const sameTarget = (a, b) =>
  a.kind === b.kind && (a.value.startsWith(b.value) || b.value.startsWith(a.value));
/** 接着走时目标取两边较长的那个提交号，不把整串换成短的。 */
const mergedTarget = (prev, target) => ({
  ...prev,
  value: target.value.length > prev.value.length ? target.value : prev.value,
});

/** 接着走的命令（原话用上一趟记下的，换成要的话自己改；提交号只写前 12 位，整串 40 位会被 scrubText 抹成「长串」）。 */
const resumeCommand = (s) =>
  `node release-train.mjs start --sha ${s.target.value.slice(0, 12)} --founder-ok "${scrubText(String(s.founderOk ?? '<创始人原话>')).replace(/"/g, "'")}"`;

// —— 命令行参数 ——

function parseArgs(argv, valueOptions, flagNames = []) {
  const options = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`多出来的参数「${arg}」\n${USAGE}`);
    const name = arg.slice(2);
    if (flagNames.includes(name)) flags.add(name);
    else if (valueOptions.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} 后面要跟值`);
      if (options.has(name)) throw new UsageError(`--${name} 只能给一次`);
      options.set(name, v);
      i++;
    } else throw new UsageError(`不认识的参数 --${name}\n${USAGE}`);
  }
  return { options, flags };
}

// —— 读各处的现状（全部经 io；读不到都是 { ok: false, why }） ——

const gh = (io, args, opts = {}) => io.run('gh', args, { cwd: io.cwd(), timeoutMs: 60_000, ...opts });

/** 法国上跑一条命令；ssh 没连上、超时、起不了都在 r.error / status 255 / null 里。 */
const france = (io, command, timeoutMs = 60_000) => io.ssh(command, { timeoutMs });

/**
 * fleet-api engine status → { ok: true, on } 或 { ok: false, why }。
 * 法国在用的版本还没有 `engine` 子命令（总开关 #1086 之后才有；第一次发版就撞上：在用 390eca1f，fleet-api 打用法、退出非 0）：
 * 没有总开关就没有什么要暂停的，当「关着」读（legacy: true），第 2 步记跳过，发完新版本就有了。只认「打了用法」这一种；连不上库之类照旧算读不到。
 */
async function engineStatus(io) {
  const r = await france(io, `${FLEET_API} engine status`);
  if (!didNotRun(r) && r.status !== 0 && /用法：fleet-api/.test(`${r.stdout}\n${r.stderr}`))
    return { ok: true, on: false, legacy: true, text: '在用的版本还没有引擎总开关（engine 子命令不存在）' };
  if (didNotRun(r) || r.status !== 0) return { ok: false, why: `法国引擎总开关读不到：${tailOf(r)}` };
  const m = /引擎总开关：(开着|关着)/.exec(String(r.stdout));
  if (!m) return { ok: false, why: `法国引擎总开关的回话认不出：${tailOf(r)}` };
  return { ok: true, on: m[1] === '开着', text: String(r.stdout).trim().split('\n')[0] };
}

async function engineSet(io, on, reason) {
  const r = await france(io, `${FLEET_API} engine ${on ? 'on' : 'off'} --reason ${shq(reason)}`);
  if (didNotRun(r) || r.status !== 0)
    return { ok: false, why: `fleet-api engine ${on ? 'on' : 'off'} 没成：${tailOf(r)}` };
  return { ok: true };
}

async function dispatchSet(io, repo, reason) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, why: `仓名「${repo}」认不出` };
  const r = await france(io, `${FLEET_API} dispatch ${repo} on`);
  if (didNotRun(r) || r.status !== 0)
    return { ok: false, why: `${repo} 的「让 AI 接活」开不回去：${tailOf(r)}（${reason}）` };
  return { ok: true };
}

/**
 * 要发的那个提交的汇总检查（ci.yml 的 check job，必过检查的汇总）：green / red / pending，读不到 unknown。
 * 看要发的提交，不看主线头：主线上自动合并一个接一个进来时，主线头的 CI 每次都被新合并取消重跑，
 * 「主线头 CI 空下来」永远等不到（等了 21 分钟卡住）；发出去的就是这个提交，它自己绿了就够。
 * 标签目标在解析出提交之前拿不到号，退回看主线头。
 */
function ciRef(state) {
  return state.target.sha ?? (state.target.kind === 'sha' ? state.target.value : 'main');
}

/**
 * 后备读法（check-runs 接口读不出时用；它连着回 HTTP 500 一个多小时，发版车整个被卡住）：
 * 看这个提交的 ci 工作流运行。ci 工作流里就含汇总检查（check），它的结论就是汇总的结论。
 * 只对点名的提交用（主线头没有提交号，不走这条）；读不到照旧回 unknown，不拿空顶。
 */
async function mainCiByRuns(io, ref) {
  const full = gh(io, ['api', `repos/{owner}/{repo}/commits/${ref}`, '--jq', '.sha']);
  const sha = String(full.stdout ?? '').trim();
  if (didNotRun(full) || full.status !== 0 || !/^[0-9a-f]{40}$/.test(sha))
    return { verdict: 'unknown', why: `提交号补不全：${tailOf(full)}` };
  const r = gh(io, [
    'api',
    `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=20`,
    '--jq',
    '[.workflow_runs[] | select(.name=="ci") | {status,conclusion}]',
  ]);
  if (didNotRun(r) || r.status !== 0) return { verdict: 'unknown', why: `ci 工作流运行读不到：${tailOf(r)}` };
  let runs;
  try {
    runs = JSON.parse(String(r.stdout).trim() || '[]');
  } catch (e) {
    return { verdict: 'unknown', why: `ci 工作流运行的回话不是 JSON（${e.message}）` };
  }
  if (!Array.isArray(runs)) return { verdict: 'unknown', why: 'ci 工作流运行的回话认不出（不是列表）' };
  const name = `要发的提交 ${ref.slice(0, 8)}`;
  if (runs.length === 0) return { verdict: 'pending', why: `${name}还没有 ci 工作流运行` };
  if (runs.some((x) => x.status !== 'completed')) return { verdict: 'pending', why: `${name}的 CI 还在跑` };
  if (runs.every((x) => x.conclusion === 'success')) return { verdict: 'green', why: '' };
  return { verdict: 'red', why: `${name}的 CI 是红的（${runs.map((x) => x.conclusion).join('、')}）` };
}

/** check-runs 读不出时，点名的提交改看 ci 工作流运行；两处都读不出才是 unknown。 */
async function mainCi(io, ref = 'main') {
  const byChecks = await mainCiByChecks(io, ref);
  if (byChecks.verdict === 'pending' && byChecks.empty && ref !== 'main') {
    // 汇总检查读到 0 条：判定仍是 pending（check 读不到不等于绿），ci 工作流运行只当佐证写进原因
    const byRuns = await mainCiByRuns(io, ref);
    const note =
      byRuns.verdict === 'green' ? 'ci 工作流运行已全绿' : byRuns.why || `ci 工作流运行 ${byRuns.verdict}`;
    return { verdict: 'pending', why: `${byChecks.why}（佐证：${note}）` };
  }
  if (byChecks.verdict !== 'unknown' || ref === 'main') return byChecks;
  const byRuns = await mainCiByRuns(io, ref);
  if (byRuns.verdict === 'unknown')
    return { verdict: 'unknown', why: `${byChecks.why}；后备也读不到：${byRuns.why}` };
  return byRuns;
}

/**
 * 按名字过滤取汇总检查（check_name=check）并按 total_count 翻页取全：
 * 提交上检查多到一页装不下时（一个提交 210 条，merge-gate 刷屏），不过滤会把 check 挤出第一页，读成 0 条。
 * 任何一页读不出都回 unknown，不拿已读到的半截当结论。
 */
async function readCheckRuns(io, ref) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const r = gh(io, [
      'api',
      `repos/{owner}/{repo}/commits/${ref}/check-runs?check_name=check&per_page=100&page=${page}`,
      '--jq',
      '{total: .total_count, runs: [.check_runs[] | select(.name=="check") | {status,conclusion}]}',
    ]);
    if (didNotRun(r) || r.status !== 0) return { error: `主线 CI 读不到（第 ${page} 页）：${tailOf(r)}` };
    let body;
    try {
      body = JSON.parse(String(r.stdout).trim() || 'null');
    } catch (e) {
      return { error: `主线 CI 的回话不是 JSON（${e.message}）` };
    }
    if (!body || !Array.isArray(body.runs) || !Number.isInteger(body.total))
      return { error: '主线 CI 的回话认不出（缺 total_count 或不是列表）' };
    all.push(...body.runs);
    if (all.length >= body.total) return { runs: all };
    if (body.runs.length === 0)
      return { error: `主线 CI 翻页读不全（共 ${body.total} 条，只读到 ${all.length} 条）` };
  }
  return { error: '主线 CI 翻页超过 10 页，读不全' };
}

async function mainCiByChecks(io, ref) {
  const got = await readCheckRuns(io, ref);
  if (got.error) return { verdict: 'unknown', why: got.error };
  const runs = got.runs;
  if (runs.length === 0)
    return {
      verdict: 'pending',
      empty: true,
      why: `${ref === 'main' ? '主线头' : '要发的提交 ' + ref.slice(0, 8)}还没有汇总检查（check）的结果`,
    };
  if (runs.some((x) => x.status !== 'completed'))
    return {
      verdict: 'pending',
      why: `${ref === 'main' ? '主线头' : '要发的提交 ' + ref.slice(0, 8)}的 CI 还在跑`,
    };
  if (runs.every((x) => x.conclusion === 'success')) return { verdict: 'green', why: '' };
  return {
    verdict: 'red',
    why: `${ref === 'main' ? '主线头' : '要发的提交 ' + ref.slice(0, 8)}的 CI 是红的（${runs.map((x) => x.conclusion).join('、')}）`,
  };
}

/** 挂了自动合并、还没合也没关的 PR。 */
async function autoMergePrs(io) {
  const r = gh(io, [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,autoMergeRequest',
  ]);
  if (didNotRun(r) || r.status !== 0) return { ok: false, why: `PR 列表读不到：${tailOf(r)}` };
  try {
    const rows = JSON.parse(String(r.stdout).trim() || '[]');
    if (!Array.isArray(rows)) return { ok: false, why: 'PR 列表的回话认不出（不是列表）' };
    return {
      ok: true,
      prs: rows
        .filter((p) => p.autoMergeRequest)
        .map((p) => ({ number: p.number, title: String(p.title ?? '') })),
    };
  } catch (e) {
    return { ok: false, why: `PR 列表的回话不是 JSON（${e.message}）` };
  }
}

/**
 * 发版暂停期间必然出现、暂停一撤就消失的异常类别 → 给人看的名字。按 `kind` 认，不匹配文案。
 * 这一趟不关总开关（决定 0093），但 release.sh 切版本时会暂停在跑的任务、重启引擎；老现场那一支总开关还关着。
 * `task-idle`：任务被暂停、手上没会话，在动手的单会「没动」（#1292）。
 * `route-stale`：路由探针要引擎开着才跑，老现场关着总开关时在线路由的结论必然变旧（#1520）。
 */
const PAUSE_KINDS = new Map([
  [KIND_TASK_IDLE, '单没动、手上没会话'],
  [KIND_ROUTE_STALE, '路由结论没更新'],
]);

// 第 6 步提醒项的口径（发版相关键前缀 RELEASE_ALERT_PREFIXES、重启打断重试类 VERIFY_RETRY_PREFIXES、
// 认提醒项的 isNotificationIssue）都在 france-lib.mjs，这里只引用、照原名再导出。别的新提醒（任务失败、对账之类）列出来，不拦。
export { RELEASE_ALERT_PREFIXES, VERIFY_RETRY_PREFIXES };

/** 「单没动、手上没会话 2 处、路由结论没更新 0 处」：每个类别都列，0 也写出来。 */
function pausedText(paused) {
  const parts = [...PAUSE_KINDS].map(([k, name]) => `${name} ${paused[k] ?? 0} 处`);
  return parts.join('、');
}

/**
 * france.mjs --json：{ ok, code, bad, unread, note, paused, text }。退出码 2＝整个没读到。
 * 按异常的 `kind` 分类，不匹配文案（#1292、#1520）：PAUSE_KINDS 里的类别不计入 bad/unread/note，只按类别数进 paused。
 * items 每条带 source：'alert'＝没处理的提醒（france-lib 的 isNotificationIssue 认 where；第 6 步按键前缀判和发版有没有关），
 * 'health'＝健康项（新出现照旧拦）。
 * 预检基线和验证用同一个函数，口径一致。
 */
async function franceHealth(io) {
  const r = io.run(io.nodePath, [join(io.scriptsDir, 'france.mjs'), '--json'], {
    cwd: io.cwd(),
    timeoutMs: 120_000,
  });
  if (didNotRun(r) || r.status === 2 || (r.status !== 0 && r.status !== 1))
    return { ok: false, why: `france.mjs 没读到法国：${tailOf(r)}` };
  let view;
  try {
    view = JSON.parse(String(r.stdout));
  } catch (e) {
    return { ok: false, why: `france.mjs --json 的输出不是 JSON（${e.message}）：${tailOf(r)}` };
  }
  if (!view || !Array.isArray(view.anomalies))
    return { ok: false, why: `france.mjs --json 的输出里没有 anomalies 列表：${tailOf(r)}` };
  const count = { bad: 0, unread: 0, note: 0 };
  const shown = [];
  /** 每条没被暂停类别吃掉的异常：key 是稳定标识（france-lib 给；没有就按 kind 加文字顶），验证时拿它比「哪几条是新出现的」。 */
  const items = [];
  /** @type {Record<string, number>} */
  const paused = {};
  for (const a of view.anomalies) {
    if (PAUSE_KINDS.has(a.kind)) {
      paused[a.kind] = (paused[a.kind] ?? 0) + 1;
      continue;
    }
    if (!(a.level in count))
      return { ok: false, why: `france.mjs --json 的异常里有认不出的级别 ${JSON.stringify(a.level)}` };
    count[a.level] += 1;
    const text = `${a.level === 'note' ? '· 留意：' : '⚠ '}${a.what}`;
    shown.push(text);
    items.push({
      key: typeof a.key === 'string' && a.key !== '' ? a.key : `${a.kind ?? a.level}:${a.what}`,
      level: a.level,
      kind: a.kind,
      source: isNotificationIssue(a) ? 'alert' : 'health',
      text,
    });
  }
  return {
    ok: true,
    code: r.status,
    ...count,
    paused: pausedText(paused),
    text: shown.join('\n'),
    items,
  };
}

// —— 阶段 ——
// 每个阶段回 { ok: true } 或 { ok: false, kind: 'failed' | 'blocked', why, laggards? }。

const failed = (why) => ({ ok: false, kind: 'failed', why });
const blocked = (why, laggards = []) => ({ ok: false, kind: 'blocked', why, laggards });

/** 0 预检（只读）：什么都不改，所以失败了也不用撤。 */
async function phasePreflight(io, state) {
  const started = io.now().getTime();
  const problems = [];
  const left = () => Math.max(1000, io.limits.preflightMs - (io.now().getTime() - started));

  const ci = await mainCi(io, ciRef(state));
  if (ci.verdict !== 'green') problems.push(`主线 CI 不是绿的：${ci.why}`);

  const lock = io.ssh(`flock -n -E ${BUSY} ${LOCK_FILE} -c true`, { timeoutMs: Math.min(60_000, left()) });
  const lockR = await lock;
  if (didNotRun(lockR)) problems.push(`法国读不到（看发布锁）：${tailOf(lockR)}`);
  else if (lockR.status === BUSY) problems.push('法国上另一个发布正在跑（.lock 被占着）');
  else if (lockR.status !== 0) problems.push(`看发布锁没成：${tailOf(lockR)}`);

  const health = await franceHealth(io);
  if (!health.ok) problems.push(health.why);
  else {
    state.baseline = {
      bad: health.bad,
      unread: health.unread,
      note: health.note,
      keys: health.items.map((x) => x.key),
    };
    sayTo(
      io,
      `预检：法国现状 ${health.bad} 处异常、${health.unread} 处没读到、${health.note} 处留意（记作基线，验证时只拦新增；暂停期必然出现的不计：${health.paused}）`,
    );
  }

  const prs = await autoMergePrs(io);
  if (!prs.ok) problems.push(prs.why);
  else if (prs.prs.length > 0)
    sayTo(
      io,
      `预检：挂了自动合并、还没合的 PR ${prs.prs.length} 个（第 3 步只提示、不等它们）：${prs.prs.map((p) => `#${p.number}`).join(' ')}`,
    );

  const sessions = await io.runningSessions();
  if (!sessions.ok) problems.push(`法国在跑几个会话读不到（${sessions.kind}）：${sessions.why}`);
  else sayTo(io, `预检：法国在跑的会话 ${sessions.running} 个`);

  if (io.now().getTime() - started > io.limits.preflightMs)
    problems.push(`预检用了超过 ${minutes(io.limits.preflightMs)} 分钟`);
  if (problems.length > 0) return failed(`预检没过（什么都没改）：\n- ${problems.join('\n- ')}`);
  return { ok: true };
}

/** 1 本机：占位，什么都不做（见头注释）。 */
async function phaseLocal(io, state) {
  saveState(io, state);
  sayTo(io, '本机：没有要暂停的东西');
  return { ok: true };
}

/**
 * 2 暂停法国：不关总开关（#2038、决定 0093）。release.sh 切版本前自己给在跑的任务发 hard 暂停、发完发「继续」；
 * 这一步只读总开关记下发版前的样子（before.master，pausedMaster: false），给第 7 步核对。读不到不往下走。
 * 兼容老现场：上一回老版本发版车停下时总开关是它关的（before.master 为真、记录里没有 pausedMaster、现在关着）：
 * 保留那份记录（含各仓接活开关），记 pausedMaster: true，第 7 步照老规矩开回。
 */
async function phasePauseFrance(io, state) {
  const now = await engineStatus(io);
  if (!now.ok) return failed(now.why);
  if (state.before?.master === true && state.before.pausedMaster !== false && !now.on) {
    state.before = { ...state.before, pausedMaster: true };
    saveState(io, state);
    sayTo(io, '暂停法国：总开关是上一回老版本发版车关的（发版前开着，已记），第 7 步开回');
    return { ok: true };
  }
  state.before = {
    master: now.on,
    ...(now.legacy ? { legacy: true } : {}),
    pausedMaster: false,
    repos: null,
    recordedAt: iso(io),
  };
  saveState(io, state);
  sayTo(
    io,
    now.legacy
      ? '暂停法国：不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）；在用的版本还没有引擎总开关，已记'
      : `暂停法国：不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）；发版前总开关${now.on ? '开着' : '关着'}，已记，第 7 步核对`,
  );
  return { ok: true };
}

/**
 * 3 等收尾：只等要发的提交的 CI 绿（上限 ciMs），红了立刻停。不等法国会话收尾（#2038）：release.sh 切版本前自己暂停在跑的任务。
 * 自动合并的 PR 只提示（打印出来，内容变了再打一次），不挡、不算拖后腿。
 */
async function phaseWait(io, state) {
  const started = io.now().getTime();
  const L = io.limits;
  let lastLine = '';
  let lastHints = '';
  for (;;) {
    saveState(io, state); // 心跳
    const at = io.now().getTime();
    const status = [];
    const prs = await autoMergePrs(io);
    status.push({
      key: '自动合并的 PR',
      held: prs.ok ? prs.prs.map((p) => `#${p.number} ${p.title}`) : [prs.why],
      hint: true,
    });

    const ci = await mainCi(io, ciRef(state));
    if (ci.verdict === 'red')
      return blocked(`主线 CI 红了：${ci.why}。先修主线，再来（同一个目标再跑一次 start）`, [ci.why]);
    status.push({ key: '主线 CI', held: ci.verdict === 'green' ? [] : [ci.why], limit: L.ciMs });

    const line = status.map((x) => `${x.key} ${x.held.length}${x.hint ? '（只提示，不等）' : ''}`).join('，');
    if (line !== lastLine) {
      sayTo(
        io,
        `等收尾（已 ${minutes(at - started)} 分钟，只等 CI；法国会话不等，release.sh 切版本时自己暂停）：${line}`,
      );
      lastLine = line;
    }
    const hints = status
      .filter((x) => x.hint && x.held.length > 0)
      .flatMap((x) => x.held.map((h) => `${x.key}：${h}`));
    const hintText = hints.join('\n');
    if (hintText !== lastHints) {
      if (hints.length > 0) sayTo(io, `等收尾：这几样只提示、不等：\n- ${hints.join('\n- ')}`);
      lastHints = hintText;
    }
    const open = status.filter((x) => !x.hint && x.held.length > 0);
    if (open.length === 0) {
      sayTo(io, '等收尾：都收完了');
      return { ok: true };
    }
    if (open.every((x) => at - started >= x.limit)) {
      const laggards = open.flatMap((x) => x.held.map((h) => `${x.key}：${h}`));
      return blocked(
        `等了 ${minutes(at - started)} 分钟还有拖后腿的（没动现场；再等就同一个目标再跑一次 start，不等了就 abort）：\n- ${laggards.join('\n- ')}`,
        laggards,
      );
    }
    await io.sleep(L.pollMs);
  }
}

/** 4 发版（对外发布）：必须带 founder-ok。 */
async function phaseRelease(io, state) {
  if (typeof state.founderOk !== 'string' || state.founderOk.trim() === '')
    return failed('发版是对外发布，必须带 --founder-ok（创始人原话）：没带，不发');
  state.release = { ...(state.release ?? {}), started: true };
  saveState(io, state);
  return releaseBySha(io, state);
}

async function releaseBySha(io, state) {
  const sha = state.target.value;
  sayTo(
    io,
    `发版：ssh 到法国，用目标提交 ${sha.slice(0, 12)} 自带的 release.sh（检出里那份不跑；创始人原话：「${state.founderOk}」）`,
  );
  state.target.sha = sha;
  // 令牌记在状态里：同一趟（含 start 重跑）认得出「这个服务是我起的」，接着看日志，不起第二个。
  // 发布没成（退出码非 0、没了）时清掉，下一次 start 才会真的重发。
  state.release ??= {};
  if (typeof state.release.token !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(state.release.token))
    state.release.token = randomBytes(8).toString('hex');
  saveState(io, state);
  const command = releaseLaunchCommand(sha, state.release.token);
  const clearToken = () => {
    delete state.release.token;
    saveState(io, state);
  };
  // 发布由法国上的 systemd 临时服务跑，ssh 只是回现状：断了（255、超时）重连接着看，不当成发布失败。
  // 总时限 releaseMs，到点还没看到发完才判没成。
  const started = io.now().getTime();
  let lastNote = '';
  let lastWhy = '';
  let drops = 0;
  const note = (text) => {
    if (text !== lastNote) sayTo(io, text);
    lastNote = text;
  };
  for (;;) {
    saveState(io, state); // 心跳
    const r = await io.ssh(command, { timeoutMs: 60_000 });
    if (didNotRun(r)) {
      drops += 1;
      lastWhy = `ssh 断了或连不上（${tailOf(r)}）`;
      note(`发版：${lastWhy}，法国上的发布不受影响，重连接着看（已断 ${drops} 次）`);
    } else if (r.status !== 0) {
      clearToken();
      return failed(`起发布服务没成（退出码 ${r.status}）：${tailOf(r, 5)}`);
    } else {
      const rep = parseLaunchReport(r.stdout);
      if (rep === null) {
        lastWhy = `法国回话认不出：${tailOf(r)}`;
        note(`发版：${lastWhy}，再看一次`);
      } else if (rep.state === 'refused') {
        clearToken();
        return failed(`法国拒了这次发版入口：${rep.tail || tailOf(r)}`);
      } else if (rep.state === 'lost') {
        clearToken();
        return failed(
          `法国上的发布服务没了，日志里也没有退出码（${rep.log}：${rep.tail}）：不知道发出去没有，先到法国看 ${HISTORY_FILE} 和这份日志，再同一个目标跑 start`,
        );
      } else if (rep.state === 'finished') {
        if (rep.exit === null) {
          clearToken();
          return failed(`法国上的发布结束了但没有退出码（${rep.log}）：不当成功`);
        }
        if (rep.exit === 0) return { ok: true };
        if (rep.exit === 2) {
          sayTo(io, 'release.sh 退出码 2：没有红，但有待配的事项（验证那一步会再看）');
          return { ok: true };
        }
        clearToken();
        return failed(`release.sh 退出码 ${rep.exit}（有红或已退回）：${rep.tail}`);
      } else if (rep.state === 'busy') {
        lastWhy = '法国上别的发布占着锁（.lock），不是这一趟起的';
        note(`发版：${lastWhy}，等它放锁再起`);
      } else {
        lastWhy = '发布还在跑';
        note(
          rep.state === 'started'
            ? `发版：已在法国起发布服务（日志 ${rep.log}），本机轮询看结果；ssh 断了不影响它`
            : `发版：法国上这个提交的发布服务已经在跑（接着看，不起第二个；日志 ${rep.log}）`,
        );
      }
    }
    if (io.now().getTime() - started >= io.limits.releaseMs)
      return failed(
        `等了 ${minutes(io.limits.releaseMs)} 分钟没看到发布结束（最后一次：${lastWhy}）：不知道发出去没有，先到法国看 ${HISTORY_FILE}，再同一个目标跑 start（发布还在跑就接着看，不会起第二个）`,
      );
    await io.sleep(io.limits.pollMs);
  }
}

/** 每 pollMs 试一次 check()，done 就回；到点回 { ok: false, why: 最后一次的原因 }。check 回 fatal 立刻带出去。 */
async function waitFor(io, state, limitMs, check) {
  const started = io.now().getTime();
  for (;;) {
    saveState(io, state); // 心跳
    const r = await check();
    if (r.done) return { ok: true, value: r.value, fatal: r.fatal };
    if (io.now().getTime() - started >= limitMs) return { ok: false, why: r.why };
    await io.sleep(io.limits.pollMs);
  }
}

/** 法国发布历史末行：{ ok: true, sha, event } 或 { ok: false, why }。 */
async function historyTail(io) {
  const r = await io.ssh(`tail -n 1 ${HISTORY_FILE}`, { timeoutMs: 60_000 });
  if (didNotRun(r) || r.status !== 0) return { ok: false, why: `法国发布历史读不到：${tailOf(r)}` };
  const [, sha, event] = String(r.stdout).trim().split(/\s+/);
  if (!sha || !event) return { ok: false, why: '法国发布历史末行认不出' };
  return { ok: true, sha, event };
}

/** 5 等部署：发布历史末行＝目标提交，release.sh --check 没有红。 */
async function phaseDeploy(io, state) {
  const sha = state.target.sha;
  if (!sha) return failed('不知道目标提交是哪个（发版那一步没记上），没法核对部署');
  const hit = await waitFor(io, state, io.limits.deployMs, async () => {
    const h = await historyTail(io);
    if (!h.ok) return { done: false, why: h.why };
    const { sha: got, event } = h;
    if (!(got.startsWith(sha) || sha.startsWith(got)))
      return { done: false, why: `在用的还是 ${got.slice(0, 12)}，目标 ${sha.slice(0, 12)} 还没上` };
    if (event === 'release' || event === 'recovered') return { done: true };
    if (event === 'unhealthy' || event === 'auto-rollback' || event === 'rollback')
      return { done: true, fatal: `目标 ${sha.slice(0, 12)} 的历史末行是 ${event}：没过健康检查或已退回` };
    return { done: false, why: `目标 ${sha.slice(0, 12)} 的历史末行是 ${event}` };
  });
  if (hit.fatal) return failed(hit.fatal);
  if (!hit.ok) return blocked(`等了 ${minutes(io.limits.deployMs)} 分钟，目标还没上：${hit.why}`, [hit.why]);
  const chk = await io.ssh(`bash ${RELEASE_SH} --check`, { timeoutMs: 5 * 60_000 });
  if (didNotRun(chk)) return failed(`release.sh --check 没跑成：${tailOf(chk)}`);
  if (chk.status === 1) return failed(`release.sh --check 有红：${tailOf(chk, 5)}`);
  return { ok: true };
}

/**
 * 第 6 步比一次：基线里没有的 key＝发版期间新出现的。健康项新出现就拦（hard）；提醒项只拦和发版有关的（RELEASE_ALERT_PREFIXES，hard）
 * 和重启打断的（VERIFY_RETRY_PREFIXES，retrying，窗口里重试），别的新提醒进 unrelated 只列出来。
 * 留意级（note）和任务停下（kind task-park）不拦；task-park 进 parked 列出来。旧状态文件的基线没有 keys 时 hasKeys 为假，调用方按条数比。
 */
function freshVerdict(health, base) {
  const hasKeys = Array.isArray(base.keys);
  const known = new Set(hasKeys ? base.keys : []);
  const fresh = hasKeys ? health.items.filter((x) => !known.has(x.key)) : [];
  const hard = [];
  const retrying = [];
  const unrelated = [];
  for (const x of fresh) {
    if (x.level === 'note' || x.kind === KIND_TASK_PARK) continue;
    if (x.source !== 'alert') hard.push(x);
    else if (VERIFY_RETRY_PREFIXES.some((p) => x.key.startsWith(p))) retrying.push(x);
    else if (RELEASE_ALERT_PREFIXES.some((p) => x.key.startsWith(p))) hard.push(x);
    else unrelated.push(x);
  }
  return { hasKeys, hard, retrying, unrelated, parked: fresh.filter((x) => x.kind === KIND_TASK_PARK) };
}

const listItems = (xs, n = 12) =>
  xs
    .slice(0, n)
    .map((x) => x.text)
    .join('\n');

/**
 * 6 验证：法国现状比预检基线没有「新出现」的、和这次发版有关的异常（比 key 的集合，不比条数，#1740）；总开关读得到。
 * 健康项（服务、健康检查、发布历史、定时任务、探针）新出现就拦；提醒项只拦键前缀在 RELEASE_ALERT_PREFIXES 里的；
 * 重启打断的那几类（VERIFY_RETRY_PREFIXES）在 limits.verifyMs 里每 pollMs 重读，撤了就过、到点还在才卡住。
 * 别的新提醒、任务停下（kind task-park）是引擎照常干活的结果，不算新版的问题：不拦，只在通过那行后另起一行列出来。
 * 旧状态文件的基线没有 keys 时退回按条数比。PAUSE_KINDS 里的类别不算（见 PAUSE_KINDS）。
 */
async function phaseVerify(io, state) {
  const started = io.now().getTime();
  const base = state.baseline ?? { bad: 0, unread: 0, note: 0 };
  let health;
  let v;
  for (;;) {
    saveState(io, state); // 心跳
    health = await franceHealth(io);
    if (!health.ok) return failed(health.why);
    v = freshVerdict(health, base);
    if (!v.hasKeys) {
      if (health.bad + health.unread > base.bad + base.unread)
        return blocked(
          `发完版法国多出了异常（预检时 ${base.bad} 异常 ${base.unread} 没读到，现在 ${health.bad} 异常 ${health.unread} 没读到）：\n${health.text.split('\n').slice(0, 12).join('\n')}`,
          [`异常 ${health.bad}、没读到 ${health.unread}`],
        );
      break;
    }
    if (v.hard.length > 0)
      return blocked(
        `发完版法国多出了异常（预检时 ${base.bad} 异常 ${base.unread} 没读到，现在 ${health.bad} 异常 ${health.unread} 没读到；新出现的 ${v.hard.length} 条）：\n${listItems(v.hard)}`,
        [`新出现 ${v.hard.length} 条`],
      );
    if (v.retrying.length === 0) break;
    const waited = io.now().getTime() - started;
    if (waited >= io.limits.verifyMs)
      return blocked(
        `发布重启打断的 ${v.retrying.length} 条等了 ${minutes(waited)} 分钟还没撤：
${listItems(v.retrying)}`,
        [`重启打断的 ${v.retrying.length} 条没撤`],
      );
    sayTo(
      io,
      `验证：发布重启打断的 ${v.retrying.length} 条还没撤（已等 ${minutes(waited)} 分钟，最多 ${minutes(io.limits.verifyMs)} 分钟，再看一次）：${v.retrying.map((x) => x.key).join('、')}`,
    );
    await io.sleep(io.limits.pollMs);
  }
  const eng = await engineStatus(io);
  if (!eng.ok) return failed(eng.why);
  sayTo(
    io,
    `验证：法国 ${health.bad} 处异常、${health.unread} 处没读到（预检基线 ${base.bad}、${base.unread}；暂停期必然出现的不计：${health.paused}）；${eng.text}`,
  );
  if (v.unrelated.length > 0) {
    const more = v.unrelated.length > 8 ? `……共 ${v.unrelated.length} 条` : '';
    sayTo(
      io,
      `发版期间新出现的提醒，和这次发版无关（不拦，只列出来给人看）：${v.unrelated
        .slice(0, 8)
        .map((x) => x.text.replace(/^(?:· 留意：|⚠ )/, ''))
        .join('；')}${more}`,
    );
  }
  if (v.parked.length > 0) {
    const more = v.parked.length > 8 ? `……共 ${v.parked.length} 条` : '';
    sayTo(
      io,
      `发版期间单子停下的（引擎照常干活的结果，不算新版的问题，只列出来给人看）：${v.parked
        .slice(0, 8)
        .map((x) => x.text.replace(/^(?:· 留意：|⚠ )/, ''))
        .join('；')}${more}`,
    );
  }
  return { ok: true };
}

/**
 * 7 恢复（现在是核对）：这一趟不关总开关（决定 0093），所以只有老现场那一支（第 2 步认出上一回老版本关的，before.pausedMaster 为真）
 * 才开回：总开关和发版前开着的各仓「让 AI 接活」，经 fleet-api 写操作记录；开不回去、读回来不对是「没成」（退出码 2），同一个目标再跑一次 start 重试这一步。
 * 其余情况不碰总开关：读回来和发版前一致就说一致；不一致（发版期间有人开了或关了）照实报，不替人开或关，这一步照过。
 * 第 2 步没记下发版前的样子（before 缺）不猜，没成。
 */
async function phaseRestore(io, state) {
  saveState(io, state);
  const before = state.before;
  if (before === null || before === undefined || typeof before.master !== 'boolean')
    return failed(
      '恢复没成：第 2 步没记下发版前的开关状态（state.before 缺），不敢猜着核对；发版已经发出去了，到驾驶舱环境页核对总开关和各仓「让 AI 接活」',
    );
  const eng = await engineStatus(io);
  if (!eng.ok) return failed(`恢复没成（发版已经发出去了）：${eng.why}`);
  if (!(before.master && before.pausedMaster !== false)) {
    if (before.legacy || eng.legacy) {
      sayTo(io, '恢复：发版前法国还没有引擎总开关，这一趟也没动过，没什么要核对的');
      return { ok: true };
    }
    const word = (on) => (on ? '开着' : '关着');
    if (eng.on === before.master) {
      sayTo(io, `恢复：这一趟没关总开关（决定 0093），没动；核对和发版前一致（${word(eng.on)}）`);
      return { ok: true };
    }
    state.restoreMismatch = { before: before.master, now: eng.on, at: iso(io) };
    saveState(io, state);
    warnTo(
      io,
      `恢复：法国总开关和发版前不一致：发版前${word(before.master)}，现在${word(eng.on)}（发版期间有人${eng.on ? '开了' : '关了'}，或别的流程动过）。这一趟没关过总开关，不替人${eng.on ? '关' : '开'}：到驾驶舱环境页看是谁动的，要改自己改`,
    );
    return { ok: true };
  }
  const reason = `发版后开回老版本发版车关的总开关（release-train，目标 ${targetText(state.target)}）`;
  const problems = [];
  if (!eng.on) {
    const on = await engineSet(io, true, reason);
    if (!on.ok) problems.push(on.why);
  }
  const opened = [];
  for (const r of before.repos ?? []) {
    if (!r.on) continue;
    const d = await dispatchSet(io, r.repo, reason);
    if (!d.ok) problems.push(d.why);
    else opened.push(r.repo);
  }
  const back = await engineStatus(io);
  if (!back.ok) problems.push(`开回去之后读不回总开关：${back.why}`);
  else if (!back.on) problems.push('开回去之后读回来总开关还是关着');
  if (problems.length > 0)
    return failed(
      `恢复没成：发版已经发出去了，但发版前开着的引擎没能全部恢复：\n- ${problems.join('\n- ')}\n到驾驶舱环境页或 fleet-api engine on 手动开；同一个目标再跑一次 start 会重试这一步`,
    );
  sayTo(
    io,
    `恢复：法国总开关已开回（上一回老版本发版车关的，发版前开着），各仓开回 ${opened.length} 个${opened.length ? `（${opened.join('、')}）` : ''}`,
  );
  return { ok: true };
}

/** 8 派清单：先只打印。读 gh issue list --milestone 现读（pnpm plan 坏了，不依赖）。 */
export function orderFromDescription(description) {
  const text = String(description ?? '');
  const open = /<!--\s*fleet:order\s*-->/.exec(text);
  const close = /<!--\s*\/fleet:order\s*-->/.exec(text);
  if (!open || !close || close.index < open.index) return [];
  return text
    .slice(open.index + open[0].length, close.index)
    .split(/\r?\n/)
    .map((l) => /^\s*\d+\.\s*#(\d+)/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);
}

const BLOCKER = /断链|坏了|紧急|bug|挡路/i;

/**
 * 方案 5.1 的规则，能用标签和先后段机械做的部分：先后段里写了的按它的顺序在前（创始人和指挥官排的，规则 1–5 的结果都落在这里）；
 * 其余：贴了挡路类标签的先，母单排最后（它自己不干活，子单在它页面里排），同级小号在前。
 * 标出：母单；本机做；可交法国（没贴「本机做」、不是母单）。
 */
export function rankIssues(issues, order) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const labelsOf = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  const tag = (i) => {
    const labels = labelsOf(i);
    const mother = labels.includes('母单');
    const local = labels.includes('本机做');
    return { mother, local, handoff: !mother && !local };
  };
  const listed = order.filter((n) => byNumber.has(n));
  const rest = issues
    .filter((i) => !listed.includes(i.number))
    .sort((a, b) => {
      const rank = (i) => (tag(i).mother ? 2 : labelsOf(i).some((l) => BLOCKER.test(l)) ? 0 : 1);
      return rank(a) - rank(b) || a.number - b.number;
    })
    .map((i) => i.number);
  const rows = [...listed, ...rest].map((n, idx) => {
    const i = byNumber.get(n);
    return { rank: idx + 1, number: n, title: String(i.title ?? ''), listed: idx < listed.length, ...tag(i) };
  });
  return { rows, missing: order.filter((n) => !byNumber.has(n)) };
}

async function phaseList(io, state) {
  const ms = gh(io, [
    'api',
    'repos/{owner}/{repo}/milestones?state=open&per_page=100',
    '--jq',
    '[.[] | {title, description}]',
  ]);
  let milestone;
  if (didNotRun(ms) || ms.status !== 0) milestone = { ok: false, why: `里程碑读不到：${tailOf(ms)}` };
  else {
    try {
      const all = JSON.parse(String(ms.stdout).trim() || '[]');
      const versions = all
        .map((m) => ({ ...m, n: Number(/^v(\d+)(?!\d)/.exec(m.title ?? '')?.[1]) }))
        .filter((m) => Number.isInteger(m.n))
        .sort((a, b) => a.n - b.n);
      milestone = versions[0]
        ? { ok: true, m: versions[0] }
        : { ok: false, why: '开着的里程碑里没有 v<N> 这样的版本' };
    } catch (e) {
      milestone = { ok: false, why: `里程碑的回话不是 JSON（${e.message}）` };
    }
  }
  if (!milestone.ok) return listFailed(io, state, milestone.why);
  const r = gh(io, [
    'issue',
    'list',
    '--state',
    'open',
    '--milestone',
    milestone.m.title,
    '--limit',
    '200',
    '--json',
    'number,title,labels',
  ]);
  if (didNotRun(r) || r.status !== 0) return listFailed(io, state, `单子列表读不到：${tailOf(r)}`);
  let issues;
  try {
    issues = JSON.parse(String(r.stdout).trim() || '[]');
  } catch (e) {
    return listFailed(io, state, `单子列表的回话不是 JSON（${e.message}）`);
  }
  const { rows } = rankIssues(issues, orderFromDescription(milestone.m.description));
  sayTo(
    io,
    `清单（${milestone.m.title}，开着 ${rows.length} 张）。先后段里写的在前，其余先挡路的、母单排最后、同级小号在前；先只打印，不自动派：`,
  );
  for (const t of rows)
    sayTo(
      io,
      `${t.rank}. #${t.number} ${t.title}${t.mother ? ' 〔母单：子单在它页面里排〕' : t.local ? ' 〔本机做〕' : ' 〔可交法国〕'}${t.listed ? '' : ' （先后段里没写）'}`,
    );
  state.result = { milestone: milestone.m.title, issues: rows.length };
  return { ok: true };
}

function listFailed(io, state, why) {
  state.result = { listError: why };
  warnTo(io, `清单没读到：${why}（这一趟发版和恢复都做完了，只是清单要自己读）`);
  return { ok: true, listError: true };
}

const PHASE_FUNCS = [
  phasePreflight,
  phaseLocal,
  phasePauseFrance,
  phaseWait,
  phaseRelease,
  phaseDeploy,
  phaseVerify,
  phaseRestore,
  phaseList,
];

// —— 命令 ——

async function runFrom(io, state) {
  for (let p = state.phase; p < PHASE_FUNCS.length; p++) {
    state.phase = p;
    state.status = 'running';
    state.laggards = [];
    saveState(io, state);
    sayTo(io, `—— 第 ${p} 步「${PHASES[p]}」——`);
    let r;
    try {
      r = await PHASE_FUNCS[p](io, state);
    } catch (e) {
      r = failed(`这一步出错：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!r.ok) {
      state.status = r.kind === 'blocked' ? 'blocked' : 'failed';
      state.why = scrubText(r.why);
      state.laggards = (r.laggards ?? []).map((l) => scrubText(l));
      saveState(io, state);
      warnTo(io, `第 ${p} 步「${PHASES[p]}」${r.kind === 'blocked' ? '卡住了' : '没成'}：${r.why}`);
      warnTo(
        io,
        p >= PHASES.indexOf('恢复')
          ? '版本已经发出去了，这一步只是核对或开回发版前的开关没成。同一个目标再跑一次 start 只重试这一步'
          : `现场没动。同一个目标再跑一次 start 从这一步接着走；不走了就 node release-train.mjs abort`,
      );
      return r.kind === 'blocked' ? 3 : 2;
    }
    if (r.listError) state.listError = true;
  }
  state.status = 'done';
  state.why = null;
  saveState(io, state);
  sayTo(io, '这一趟做完了。');
  return state.listError ? 2 : 0;
}

async function cmdStart(p, io) {
  const sha = p.options.get('sha');
  if (sha === undefined)
    throw new UsageError('要给 --sha <提交>（发版的单位是主线上的一个提交，不再有 --tag）');
  if (!/^[0-9a-f]{7,40}$/.test(sha))
    throw new UsageError(`--sha 要是十六进制的提交号（7–40 位），给的是「${scrubText(sha)}」`);
  const founderOk = p.options.get('founder-ok');
  if (founderOk === undefined || founderOk.trim() === '') {
    warnTo(io, '发版是对外发布，必须带 --founder-ok "<创始人原话>"：没带，什么都没做');
    return 1;
  }
  // --restore 和不给一样：发完核对开关和发版前一致（老现场才开回，还原不需要创始人逐次授权）；留着只是让老命令行、明写的人不报「不认识的参数」
  const restore = p.flags.has('restore');
  const target = { kind: 'sha', value: sha };

  const read = readState(io);
  if (!read.ok) return fail(io, read.why);
  const prev = read.state;
  // 停在第 0 步（预检没过）的什么都没动过，不算「没了结」：换目标直接重来
  if (prev && (prev.status === 'blocked' || prev.status === 'failed') && prev.phase > 0) {
    if (!sameTarget(prev.target, target))
      return refuse(
        io,
        `上一趟（目标 ${targetText(prev.target)}，停在第 ${prev.phase} 步）还没了结：同一个目标再跑 start 接着走，或者先 node release-train.mjs abort`,
      );
    const state = { ...prev, target: mergedTarget(prev.target, target), founderOk, restore };
    sayTo(
      io,
      `接着上一趟走：从第 ${state.phase} 步「${PHASES[state.phase]}」起（${state.status === 'blocked' ? '上次卡住' : '上次没成'}）`,
    );
    return runFrom(io, state);
  }
  if (prev && prev.status === 'running') {
    const v = verdictOf(io, prev);
    if (!v.dead)
      return refuse(
        io,
        `有一趟正在走（第 ${prev.phase} 步「${PHASES[prev.phase]}」，${prev.startedAt} 起；驱动还活着：${v.why}）：看 node release-train.mjs status`,
      );
    if (!sameTarget(prev.target, target))
      return refuse(
        io,
        `上一趟（目标 ${targetText(prev.target)}）驱动没了，停在第 ${prev.phase} 步「${PHASES[prev.phase]}」（${v.why}）：同一个目标再跑 start 接着走，或者先 node release-train.mjs abort`,
      );
    return resumeDead(io, { ...prev, target: mergedTarget(prev.target, target), founderOk, restore }, v);
  }
  const state = {
    schema: 1,
    status: 'running',
    phase: 0,
    startedAt: iso(io),
    updatedAt: iso(io),
    target,
    founderOk,
    restore,
    before: null,
    baseline: null,
    laggards: [],
    release: {},
  };
  return runFrom(io, state);
}

/**
 * 驱动死了的那一趟，当成「没成」从停下的那一步接着走。停在第 4 步（发版）的：先看法国有没有别的发布占着锁，
 * 再读 .history 末行判发没发成——发成了（末行是目标提交、事件 release 或 recovered）跳到第 5 步，没发成从第 4 步重发（同一个提交重发什么都不变）。
 * 锁占着、读不到历史都不往下走（不猜）。
 */
async function resumeDead(io, state, v) {
  sayTo(
    io,
    `上一趟驱动没了，停在第 ${state.phase} 步「${PHASES[state.phase]}」（${v.why}）：当成「没成」，接着走`,
  );
  if (state.phase === 4) {
    const lock = await io.ssh(`flock -n -E ${BUSY} ${LOCK_FILE} -c true`, { timeoutMs: 60_000 });
    if (didNotRun(lock)) return fail(io, `驱动死在发版那一步，法国读不到（看发布锁）：${tailOf(lock)}`);
    if (lock.status === BUSY) {
      // 锁占着多半是上一趟起的发布服务还在跑（#1995）：不再报冲突，回第 4 步接着看它（令牌对得上就不起第二个）
      sayTo(io, '驱动死在发版那一步，法国上发布还在跑（.lock 被占着）：回第 4 步接着看它，不起第二个');
      return runFrom(io, state);
    }
    if (lock.status !== 0) return fail(io, `驱动死在发版那一步，看发布锁没成：${tailOf(lock)}`);
    const h = await historyTail(io);
    if (!h.ok) return fail(io, `驱动死在发版那一步，不知道发成没有，不敢猜：${h.why}`);
    const sha = state.target.value;
    const hit = h.sha.startsWith(sha) || sha.startsWith(h.sha);
    if (hit && (h.event === 'release' || h.event === 'recovered')) {
      state.target.sha = sha;
      state.release = { ...(state.release ?? {}), started: true };
      state.phase = 5;
      sayTo(
        io,
        `法国发布历史末行已是目标 ${sha.slice(0, 12)}（${h.event}）：发版发成了，从第 5 步「${PHASES[5]}」起`,
      );
    } else
      sayTo(
        io,
        `法国发布历史末行${hit ? `是目标 ${sha.slice(0, 12)} 但事件是 ${h.event}` : `还是 ${h.sha.slice(0, 12)}，目标没上`}：当没发成，从第 4 步「${PHASES[4]}」重发`,
      );
  }
  if (state.phase >= 5) state.target.sha ??= state.target.value;
  return runFrom(io, state);
}

/** 老现场：发版前总开关开着、且是老版本发版车关的（记录里没有 pausedMaster＝老版本写的，或第 2 步认出来记了 true）。 */
const oldScene = (s) => s.before?.master === true && s.before.pausedMaster !== false;

const fail = (io, why) => {
  warnTo(io, why);
  return 2;
};
const refuse = (io, why) => {
  warnTo(io, why);
  return 1;
};

async function cmdStatus(io) {
  const read = readState(io);
  if (!read.ok) return fail(io, read.why);
  const s = read.state;
  if (!s) {
    sayTo(io, `没有发版在走（没有 ${STATE_REL}）`);
    return 0;
  }
  const words = { running: '在走', blocked: '卡住了', failed: '没成', done: '做完了', aborted: '已撤销' };
  const verdict = s.status === 'running' ? verdictOf(io, s) : null;
  sayTo(
    io,
    `发版（${targetText(s.target)}，不关总开关，发完核对开关）：${verdict?.dead ? '驱动没了' : (words[s.status] ?? s.status)}，第 ${s.phase} 步「${PHASES[s.phase] ?? '？'}」，${s.startedAt} 起，${s.updatedAt} 更新`,
  );
  sayTo(
    io,
    `法国总开关发版前：${s.before ? (s.before.master ? '开着' : '关着') : '还没记'}${oldScene(s) ? '（上一回老版本发版车关的，第 7 步开回）' : ''}；已发版：${s.release?.started ? '已动手' : '还没'}`,
  );
  if (s.why) sayTo(io, `停下的原因：${s.why}`);
  for (const l of s.laggards ?? []) sayTo(io, `  拖后腿：${l}`);
  if (verdict?.dead) {
    sayTo(
      io,
      `驱动没了，停在第 ${s.phase} 步「${PHASES[s.phase] ?? '？'}」：${verdict.why}${oldScene(s) ? '。没人在恢复，法国引擎总开关还是老版本发版车关的' : ''}`,
    );
    sayTo(
      io,
      `接着走（同一个目标，从停下的那一步起${s.phase === 4 ? '；第 4 步会先读法国发布历史判发没发成' : ''}）：${resumeCommand(s)}`,
    );
    sayTo(io, '不走了：node release-train.mjs abort');
  } else if (verdict) sayTo(io, `驱动还活着：${verdict.why}`);
  return 0;
}

async function cmdAbort(io) {
  const read = readState(io);
  if (!read.ok) return fail(io, read.why);
  const s = read.state;
  if (!s || s.status === 'done' || s.status === 'aborted') {
    sayTo(io, '没有在走的一趟');
    return 0;
  }
  sayTo(io, `撤销（目标 ${targetText(s.target)}，停在第 ${s.phase} 步）`);
  let code = 0;
  if (oldScene(s) && !s.release?.started) {
    const on = await engineSet(
      io,
      true,
      `撤销发版，开回老版本发版车关的总开关（release-train abort，目标 ${targetText(s.target)}）`,
    );
    const back = on.ok ? await engineStatus(io) : on;
    if (!on.ok || !back.ok || !back.on) {
      warnTo(
        io,
        `法国总开关没能开回去（${on.ok ? (back.ok ? '读回来还是关着' : back.why) : on.why}）：发版前它是开着的，到驾驶舱环境页或 fleet-api engine on 自己开`,
      );
      code = 2;
    } else
      sayTo(
        io,
        '法国总开关已开回发版前的样子（开着；上一回老版本发版车关的）。各仓的「让 AI 接活」开关没动过',
      );
  } else if (oldScene(s)) {
    sayTo(
      io,
      '已经动手发过版：不知道发成没有、健康没确认，法国总开关保持关（上一回老版本发版车关的，发版前是开着的）。确认没事后到驾驶舱环境页或 fleet-api engine on 自己开',
    );
  } else {
    sayTo(io, '这一趟没关过法国总开关（决定 0093：release.sh 切版本时只暂停在跑的任务），没动');
  }
  s.status = 'aborted';
  s.why = '手动撤销';
  saveState(io, s);
  return code;
}

/**
 * 入口。io = {
 *   home, env, now(), sleep(ms), cwd(), nodePath, scriptsDir, limits（可省，默认 DEFAULT_LIMITS）, out(text), err(text),
 *   run(command, args, {cwd, timeoutMs}) → {status, stdout, stderr, error}   gh、git、pnpm、node（france.mjs）,
 *   ssh(remoteCommand, {timeoutMs, tickMs?, onTick?}) → 同上（可返回 Promise）   到法国跑一条命令（名字读不到、连不上都在返回里：error 或 status 255）；
 *     给了 onTick 的（第 4 步发版）外壳在等 ssh 期间每 tickMs 调一次，用来刷驱动心跳,
 *   runningSessions() → Promise<{ok: true, running, rows} | {ok: false, kind, why}>   france-sessions-lib.mjs 的 fetchRunningSessions（只有预检读，列出来给人看）,
 *   pid?, host?, isAlive?(pid) → boolean   驱动自己的进程号、机器名、查某个 pid 在不在（都可省：省了就只靠心跳时刻判死活）,
 * }。返回退出码。
 */
export async function runTrain(argv, io) {
  io = { ...io, limits: { ...DEFAULT_LIMITS, ...(io.limits ?? {}) } };
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'start') return await cmdStart(parseArgs(rest, ['sha', 'founder-ok'], ['restore']), io);
    if (cmd === 'status' || cmd === 'abort') {
      parseArgs(rest, []); // 不收任何参数：多出来的在这里报用法不对
      return await (cmd === 'status' ? cmdStatus(io) : cmdAbort(io));
    }
    throw new UsageError(`没有「${cmd}」这个命令\n${USAGE}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    return fail(io, `没做成：${e instanceof Error ? e.message : String(e)}`);
  }
}
