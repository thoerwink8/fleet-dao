// 发版前先暂停手头的活（#618，创始人 2026-10-05 约 21:00：「每次发版本时，尽量在感觉要发版本的时候，就先把手头的活暂停。等手头的工作都暂停完，
// 就可以开始发版本。之后按照最优的顺序，把当前的任务清单依次执行下去。」）。release-train.mjs 是外壳（真的 ssh/gh/git/pnpm/睡眠），
// 全部逻辑在这份 release-train-lib.mjs（同 worker-lib.mjs 注入 io 的写法）。node release-train.mjs 不带参数看用法。
// 改这里之前必须知道：
// - 这份文件里没有任何真的起进程、连网、睡觉的代码：一切经 io 进来，agents/test/release-train.test.ts 换成假 ssh、假 gh、假时钟。
//   真跑的代码路径不许在测试里碰真 ssh（那条路只在 release-train.mjs 外壳里）。
// - 阶段（方案 4.2，每阶段有上限，到点停下列出拖后腿的，不硬来）：0 预检（只读）→1 暂停本机→2 暂停法国→3 等收尾→
//   4 发版（对外发布，必须带 --founder-ok）→5 等部署→6 验证→7 恢复→8 派清单。状态记在 ~/.fleet-dao/release-train.json，
//   停在「卡住」（blocked）或「没成」（failed）时再跑一次 start（同一个目标）从停下的那一步接着走；换目标要先 abort。
// - 暂停本机＝写 ~/.fleet-dao/release-train.paused，worker.mjs start 见标记就不起新工人（worker-lib.mjs 的 readPauseMarker）。
// - 暂停法国＝fleet-api engine off（关着时不拉单、不派活、不起干活的会话；在跑的做完当前一步）。第 2 步先记下总开关和各仓接活开关，
//   第 7 步发完、健康检查过了，按记下的恢复：开着的开回、关着的保持关，恢复不成功就是没成（退出码 2，不当成成功）。
//   release.sh 发完不再置关（决定 0032 第 4 条、#1256）；--restore 留着当「明写要开回」的写法，和默认一样，不再要创始人逐次授权（只是还原）。
// - 读不到就是读不到：读不到法国会话数、总开关、主线 CI 时不往下走（也不当成 0 或绿），回 { ok: false, why }。
// - 所有打出来和记下来的字过 scrubText（令牌、邮箱、IP、长串抹掉）；ssh 的名字不进输出。
// - 退出码：0 做完了（或 abort 做完了）；1 用法不对或被拒（没带 --founder-ok、已有一趟在走）；2 没做成（读不到、命令失败）；
//   3 卡住（到点还有拖后腿的，名单已列出；现场没动，要么再跑 start 再等，要么 abort）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubText } from './france-lib.mjs';
import { pauseMarkerPath } from './worker-lib.mjs';

export const STATE_REL = join('.fleet-dao', 'release-train.json');
export const RELEASES = '/srv/fleet-dao-releases';
/** 法国上的管理命令入口和发布脚本（docs/ops.md 第九节）。 */
export const FLEET_API = `bash ${RELEASES}/current/packages/api/bin/fleet-api`;
export const RELEASE_SH = '/srv/fleet-dao/deploy/release.sh';
export const HISTORY_FILE = `${RELEASES}/.history`;
export const LOCK_FILE = `${RELEASES}/.lock`;
/** flock -E：另一个发布占着锁时回这个码（75，同 release.sh 的 EXIT_RELEASE_BUSY）。 */
const BUSY = 75;

/**
 * 各阶段的上限（毫秒）和轮询间隔；测试里整份换小。等收尾只等两样：主线 CI 20 分钟、法国在跑的会话 13 分钟（沿用排空上限）；
 * 本机在跑的工人、自动合并的 PR 两项只提示不等（创始人 2026-10-06「不合理的想法你自由决定，都改掉」，母单 #1121：它们和法国发版无关，
 * 会把无关的事卡住；release.sh 自己还会排空一遍）。数值写在 agents/test/release-train.test.ts。
 */
export const DEFAULT_LIMITS = {
  preflightMs: 2 * 60_000,
  pauseMs: 60_000,
  ciMs: 20 * 60_000,
  franceMs: 13 * 60_000,
  publishMs: 5 * 60_000,
  mergeMs: 15 * 60_000,
  tagMs: 5 * 60_000,
  releaseMs: 15 * 60_000,
  deployMs: 20 * 60_000,
  verifyMs: 5 * 60_000,
  restoreMs: 60_000,
  pollMs: 30_000,
};

export const PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];

export const USAGE = `用法：node release-train.mjs <命令>（在项目仓的检出里跑；发版会等很久，用 run_in_background 起）
  start --sha <提交> --founder-ok "<创始人原话>" [--restore]
  start --tag vN    --founder-ok "<创始人原话>" [--restore]
        发版前先暂停手头的活，再发版，再恢复：
        0 预检（只读：主线 CI 绿、没有别的发布在跑、法国能读、列出挂了自动合并的 PR）→ 1 暂停本机（写标记，worker.mjs start 拒起新工人）
        → 2 暂停法国（记下总开关和各仓开关，fleet-api engine off；本来就关着记「跳过」）→ 3 等收尾（等：主线 CI 绿、法国在跑会话 0，各有上限，到点停下列出拖后腿的；
        本机在跑的工人、挂了自动合并没合的 PR 只提示、不等）→ 4 发版 → 5 等部署 → 6 验证 → 7 恢复 → 8 按最优顺序打印当前版本的清单
        --sha：ssh 到法国跑 release.sh <提交>；--tag：pnpm publish:pr（要在 release/vN 分支上）→ 等合并 → 等 release.yml 打标记 → 法国自动发布接手
        --founder-ok：发版是对外发布，必须带创始人原话，没带就拒（连暂停都不做）
        发完、健康检查过了，法国按暂停前记下的恢复：总开关和各仓接活开关开着的开回、关着的保持关（写操作记录；开不回去算没成、退出码 2）
        --restore：明写「发完开回去」，和不给一样（默认就恢复，不再要创始人逐次授权）
        停在「卡住」或「没成」时，同一个目标再跑一次 start 从停下的那一步接着走（恢复没成也是这样重试）
  status          看这一趟走到哪、暂停标记在不在、拖后腿的是谁（只读）
  abort           撤暂停、恢复原状：清本机标记；还没发版就把法国总开关开回暂停前的样子；已经动手发过版就保持关（不知道发成没有、健康没确认；
                  确认没事后自己到环境页或 fleet-api engine on 开）。想让它确认健康后自动恢复，别 abort，同一个目标再跑一次 start
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
/** 单引号包起来交给法国的 shell：里面的单引号写成 '\'' */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** 命令（run/ssh）没跑成：起不来、被超时杀、ssh 自己连不上。 */
const didNotRun = (r) => r.error || r.status === null || r.status === 255;
const minutes = (ms) => Math.round(ms / 60_000);

// —— 状态文件 ——

const stateFile = (home) => join(home, STATE_REL);

/** 读状态：没有是 { ok: true, state: null }；在但读不了、认不出是 { ok: false, why }（不覆盖它）。 */
function readState(io) {
  const file = stateFile(io.home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, state: null };
    return { ok: false, why: `${file} 读不了（${e.code ?? e.message}）` };
  }
  try {
    const s = JSON.parse(text);
    if (s === null || typeof s !== 'object' || s.schema !== 1 || !Number.isInteger(s.phase))
      return { ok: false, why: `${file} 认不出（不是这个脚本写的）：确认没有发版在走后删掉它再来` };
    return { ok: true, state: s };
  } catch (e) {
    return { ok: false, why: `${file} 不是 JSON（${e.message}）：确认没有发版在走后删掉它再来` };
  }
}

/** 落盘：先写临时文件再换名，半截的文件不会留下。 */
function saveState(io, state) {
  state.updatedAt = iso(io);
  const file = stateFile(io.home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

const writeMarker = (io, state) => {
  const file = pauseMarkerPath(io.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ since: iso(io), target: targetText(state.target), by: 'release-train' })}\n`,
  );
};
const clearMarker = (io) => {
  const file = pauseMarkerPath(io.home);
  const was = existsSync(file);
  rmSync(file, { force: true });
  return was;
};

function targetText(t) {
  return t.kind === 'tag' ? t.value : `${t.value.slice(0, 12)}`;
}

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
 * 法国在用的版本还没有 `engine` 子命令（总开关 #1086 之后才有；2026-10-06 第一次发版就撞上：在用 390eca1f，fleet-api 打用法、退出非 0）：
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
 * 「主线头 CI 空下来」永远等不到（2026-10-07 夜等了 21 分钟卡住）；发出去的就是这个提交，它自己绿了就够。
 * 标签目标在解析出提交之前拿不到号，退回看主线头。
 */
function ciRef(state) {
  return state.target.sha ?? (state.target.kind === 'sha' ? state.target.value : 'main');
}

async function mainCi(io, ref = 'main') {
  const r = gh(io, [
    'api',
    `repos/{owner}/{repo}/commits/${ref}/check-runs?per_page=100`,
    '--jq',
    '[.check_runs[] | select(.name=="check") | {status,conclusion}]',
  ]);
  if (didNotRun(r) || r.status !== 0) return { verdict: 'unknown', why: `主线 CI 读不到：${tailOf(r)}` };
  let runs;
  try {
    runs = JSON.parse(String(r.stdout).trim() || '[]');
  } catch (e) {
    return { verdict: 'unknown', why: `主线 CI 的回话不是 JSON（${e.message}）` };
  }
  if (!Array.isArray(runs)) return { verdict: 'unknown', why: '主线 CI 的回话认不出（不是列表）' };
  if (runs.length === 0)
    return {
      verdict: 'pending',
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

/** worker.mjs status 的输出：谁在跑、谁说不准、谁没查成。 */
export function parseWorkerStatus(stdout) {
  const running = [];
  const uncertain = [];
  const unreadable = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line === '' || /^\s/.test(line)) continue; // 缩进的是详情行
    const name = line.split('：')[0];
    if (/^[^：]+：没查成——/.test(line)) unreadable.push(name);
    else if (/不确定在跑没跑/.test(line)) uncertain.push(name);
    else if (/，在跑，pid /.test(line)) running.push(name); // 「已经不在跑了，pid」不会命中
  }
  return { running, uncertain, unreadable };
}

async function localWorkers(io) {
  const r = io.run(io.nodePath, [join(io.scriptsDir, 'worker.mjs'), 'status'], {
    cwd: io.cwd(),
    timeoutMs: 120_000,
  });
  if (didNotRun(r)) return { ok: false, why: `worker.mjs status 没跑起来：${tailOf(r)}` };
  const w = parseWorkerStatus(r.stdout);
  if (r.status !== 0 && w.unreadable.length === 0)
    return { ok: false, why: `worker.mjs status 退出码 ${r.status}：${tailOf(r)}` };
  return { ok: true, ...w };
}

/** france.mjs：{ ok, code, bad, unread, note, text }。退出码 2＝整个没读到。 */
async function franceHealth(io) {
  const r = io.run(io.nodePath, [join(io.scriptsDir, 'france.mjs')], { cwd: io.cwd(), timeoutMs: 120_000 });
  if (didNotRun(r) || r.status === 2 || (r.status !== 0 && r.status !== 1))
    return { ok: false, why: `france.mjs 没读到法国：${tailOf(r)}` };
  const m = /断链排查：(\d+) 处异常、(\d+) 处没读到、(\d+) 处留意/.exec(String(r.stdout));
  if (!m) return { ok: false, why: `france.mjs 的输出里找不到「断链排查：…」那一行：${tailOf(r)}` };
  return {
    ok: true,
    code: r.status,
    bad: Number(m[1]),
    unread: Number(m[2]),
    note: Number(m[3]),
    text: String(r.stdout).trim(),
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
    state.baseline = { bad: health.bad, unread: health.unread, note: health.note };
    sayTo(
      io,
      `预检：法国现状 ${health.bad} 处异常、${health.unread} 处没读到、${health.note} 处留意（记作基线，验证时只拦新增）`,
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

/** 1 暂停本机：写标记；列出在跑的工人（第 3 步等它们）。 */
async function phasePauseLocal(io, state) {
  writeMarker(io, state);
  state.marker = true;
  saveState(io, state);
  const w = await localWorkers(io);
  if (!w.ok)
    sayTo(
      io,
      `暂停本机：标记已写，worker.mjs start 现在会拒起新工人；在跑的工人没读到（${w.why}），第 3 步再读`,
    );
  else
    sayTo(
      io,
      `暂停本机：标记已写，worker.mjs start 现在会拒起新工人；在跑的工人 ${w.running.length} 个${w.running.length ? `（${w.running.join('、')}）` : ''}`,
    );
  return { ok: true };
}

/** 2 暂停法国：记下总开关和各仓开关，engine off；总开关本来就关着记「跳过」。 */
async function phasePauseFrance(io, state) {
  const now = await engineStatus(io);
  if (!now.ok) return failed(now.why);
  if (state.before?.master === true) {
    // 接着上次走：暂停前的样子已经记过了，别拿现在的「关着」盖掉它
    if (!now.on) {
      sayTo(io, '暂停法国：总开关已经是关的（上次已关），暂停前是开着的，已记');
      return { ok: true };
    }
  } else if (!now.on) {
    state.before = { master: false, repos: null, recordedAt: iso(io) };
    saveState(io, state);
    sayTo(
      io,
      now.legacy
        ? '暂停法国：跳过（在用的版本还没有引擎总开关，没什么要暂停的；发完这一版就有了）'
        : '暂停法国：跳过（引擎总开关本来就关着，没什么要暂停的）',
    );
    return { ok: true };
  } else {
    const repos = await io.franceRepos();
    if (!repos.ok)
      return failed(`法国各仓的「让 AI 接活」开关读不到，不敢关总开关（关了就恢复不了原样）：${repos.why}`);
    state.before = {
      master: true,
      repos: repos.rows.map((r) => ({
        repo: r.repo,
        on: r.auto_dispatch_since !== null && r.auto_dispatch_since !== undefined,
      })),
      recordedAt: iso(io),
    };
    saveState(io, state);
  }
  const off = await engineSet(io, false, `发版前暂停（release-train，目标 ${targetText(state.target)}）`);
  if (!off.ok) return failed(off.why);
  const back = await engineStatus(io);
  if (!back.ok) return failed(`关完读回失败：${back.why}`);
  if (back.on) return failed('engine off 说成了，读回来总开关还是开着：不往下走');
  sayTo(
    io,
    `暂停法国：总开关已关（暂停前开着；各仓开关记了 ${state.before.repos?.filter((r) => r.on).length ?? 0} 个开着的、共 ${state.before.repos?.length ?? 0} 个）`,
  );
  return { ok: true };
}

/**
 * 3 等收尾：等主线 CI 绿、法国在跑的会话 0，各有上限，到点停下列出拖后腿的。本机在跑的工人、自动合并的 PR 只提示（打印出来，
 * 内容变了再打一次），不挡、不算拖后腿。
 */
async function phaseWait(io, state) {
  const started = io.now().getTime();
  const L = io.limits;
  let lastLine = '';
  let lastHints = '';
  for (;;) {
    const at = io.now().getTime();
    const status = [];
    const w = await localWorkers(io);
    const wHeld = w.ok
      ? [
          ...w.running,
          ...w.uncertain.map((n) => `${n}（不确定在不在跑）`),
          ...w.unreadable.map((n) => `${n}（没查成）`),
        ]
      : [`本机工人读不到：${w.why}`];
    status.push({ key: '本机工人', held: wHeld, hint: true });

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

    const s = await io.runningSessions();
    status.push({
      key: '法国在跑的会话',
      held: s.ok
        ? s.rows
            .map((r) => `${r.repo ?? '（无单）'}${r.n ? `#${r.n}` : ''} ${r.stage}`)
            .concat(s.running > s.rows.length ? [`……共 ${s.running} 个`] : [])
        : [`读不到（${s.kind}）：${s.why}`],
      limit: L.franceMs,
    });

    const line = status.map((x) => `${x.key} ${x.held.length}${x.hint ? '（只提示，不等）' : ''}`).join('，');
    if (line !== lastLine) {
      sayTo(io, `等收尾（已 ${minutes(at - started)} 分钟）：${line}`);
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
        `等了 ${minutes(at - started)} 分钟还有拖后腿的（没动现场；再等就同一个目标再跑一次 start，不等了就 abort 撤暂停）：\n- ${laggards.join('\n- ')}`,
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
  if (state.target.kind === 'sha') return releaseBySha(io, state);
  return releaseByTag(io, state);
}

async function releaseBySha(io, state) {
  const sha = state.target.value;
  sayTo(io, `发版：ssh 到法国跑 release.sh ${sha.slice(0, 12)}（创始人原话：「${state.founderOk}」）`);
  const r = await io.ssh(`bash ${RELEASE_SH} ${sha}`, { timeoutMs: io.limits.releaseMs });
  state.target.sha = sha;
  if (didNotRun(r))
    return failed(
      `release.sh 没跑完整（${tailOf(r)}）：不知道发出去没有，先到法国看 ${HISTORY_FILE}，再同一个目标跑 start（同一个提交重发什么都不变）`,
    );
  if (r.status === 0) return { ok: true };
  if (r.status === 2) {
    sayTo(io, 'release.sh 退出码 2：没有红，但有待配的事项（验证那一步会再看）');
    return { ok: true };
  }
  return failed(`release.sh 退出码 ${r.status}（有红或已退回）：${tailOf(r, 5)}`);
}

async function releaseByTag(io, state) {
  const tag = state.target.value;
  state.release ??= {};
  const rel = state.release;
  sayTo(
    io,
    `发版：走版本标记 ${tag}（创始人原话：「${state.founderOk}」）。注意：里程碑里没做完的单这一步不会自动挪走（#995 还没做），自己先确认`,
  );
  // 标记已经在了（上次接着走）：直接去取它指的提交
  let sha = await tagSha(io, tag);
  if (!sha.ok) return failed(sha.why);
  if (sha.sha === null) {
    if (rel.pr === undefined) {
      const r = io.run('pnpm', ['publish:pr'], { cwd: io.cwd(), timeoutMs: io.limits.publishMs });
      if (didNotRun(r) || r.status !== 0)
        return failed(`pnpm publish:pr 没成（要在 release/${tag} 分支上跑）：${tailOf(r, 5)}`);
      const m = /PR #(\d+)/.exec(String(r.stdout));
      if (!m) return failed(`pnpm publish:pr 的输出里找不到 PR 号：${tailOf(r, 5)}`);
      rel.pr = Number(m[1]);
      saveState(io, state);
      sayTo(io, `发版：开了「发布 ${tag}」PR #${rel.pr}，等它合并`);
    }
    const merged = await waitFor(io, io.limits.mergeMs, async () => {
      const r = gh(io, ['pr', 'view', String(rel.pr), '--json', 'state']);
      if (didNotRun(r) || r.status !== 0) return { done: false, why: `PR #${rel.pr} 读不到：${tailOf(r)}` };
      let st;
      try {
        st = JSON.parse(String(r.stdout)).state;
      } catch (e) {
        return { done: false, why: `PR #${rel.pr} 的回话不是 JSON（${e.message}）` };
      }
      if (st === 'MERGED') return { done: true };
      if (st === 'CLOSED') return { done: true, fatal: `发布 PR #${rel.pr} 被关了没合` };
      return { done: false, why: `PR #${rel.pr} 还没合（${st}）` };
    });
    if (merged.fatal) return failed(merged.fatal);
    if (!merged.ok)
      return blocked(`等了 ${minutes(io.limits.mergeMs)} 分钟，发布 PR 还没合：${merged.why}`, [merged.why]);
    const tagged = await waitFor(io, io.limits.tagMs, async () => {
      const t = await tagSha(io, tag);
      if (!t.ok) return { done: false, why: t.why };
      return t.sha === null ? { done: false, why: `标记 ${tag} 还没出现` } : { done: true, value: t.sha };
    });
    if (!tagged.ok)
      return blocked(`PR 合了，但 ${minutes(io.limits.tagMs)} 分钟内标记 ${tag} 没出现：${tagged.why}`, [
        tagged.why,
      ]);
    sha = { ok: true, sha: tagged.value };
  }
  state.target.sha = sha.sha;
  saveState(io, state);
  sayTo(io, `发版：标记 ${tag} 指向 ${sha.sha.slice(0, 12)}，等法国自动发布接手`);
  return { ok: true };
}

/** 远端的标记指向哪个提交：没有回 { ok: true, sha: null }，连不上回 { ok: false }。 */
async function tagSha(io, tag) {
  const r = io.run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    cwd: io.cwd(),
    timeoutMs: 60_000,
  });
  if (didNotRun(r) || r.status !== 0) return { ok: false, why: `读不了远端的标记 ${tag}：${tailOf(r)}` };
  const lines = String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const peeled = lines.find((l) => l.endsWith(`^{}`));
  const hit = (peeled ?? lines[0])?.split(/\s+/)[0];
  if (hit === undefined) return { ok: true, sha: null };
  if (!/^[0-9a-f]{40}$/.test(hit)) return { ok: false, why: `标记 ${tag} 指向的东西认不出` };
  return { ok: true, sha: hit };
}

/** 每 pollMs 试一次 check()，done 就回；到点回 { ok: false, why: 最后一次的原因 }。check 回 fatal 立刻带出去。 */
async function waitFor(io, limitMs, check) {
  const started = io.now().getTime();
  for (;;) {
    const r = await check();
    if (r.done) return { ok: true, value: r.value, fatal: r.fatal };
    if (io.now().getTime() - started >= limitMs) return { ok: false, why: r.why };
    await io.sleep(io.limits.pollMs);
  }
}

/** 5 等部署：发布历史末行＝目标提交，release.sh --check 没有红。 */
async function phaseDeploy(io, state) {
  const sha = state.target.sha;
  if (!sha) return failed('不知道目标提交是哪个（发版那一步没记上），没法核对部署');
  const hit = await waitFor(io, io.limits.deployMs, async () => {
    const r = await io.ssh(`tail -n 1 ${HISTORY_FILE}`, { timeoutMs: 60_000 });
    if (didNotRun(r) || r.status !== 0) return { done: false, why: `法国发布历史读不到：${tailOf(r)}` };
    const [, got, event] = String(r.stdout).trim().split(/\s+/);
    if (!got || !event) return { done: false, why: '法国发布历史末行认不出' };
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

/** 6 验证：法国现状比预检基线没有新增异常；总开关读得到。 */
async function phaseVerify(io, state) {
  const health = await franceHealth(io);
  if (!health.ok) return failed(health.why);
  const base = state.baseline ?? { bad: 0, unread: 0, note: 0 };
  if (health.bad + health.unread > base.bad + base.unread)
    return blocked(
      `发完版法国多出了异常（预检时 ${base.bad} 异常 ${base.unread} 没读到，现在 ${health.bad} 异常 ${health.unread} 没读到）：\n${health.text.split('\n').slice(0, 12).join('\n')}`,
      [`异常 ${health.bad}、没读到 ${health.unread}`],
    );
  const eng = await engineStatus(io);
  if (!eng.ok) return failed(eng.why);
  sayTo(
    io,
    `验证：法国 ${health.bad} 处异常、${health.unread} 处没读到（预检基线 ${base.bad}、${base.unread}）；${eng.text}`,
  );
  return { ok: true };
}

/**
 * 7 恢复：本机清标记；法国按第 2 步记下的发版前状态还原（决定 0032 第 4 条、#1256）：总开关发版前开着的开回、关着的保持关；
 * 各仓「让 AI 接活」发版前开着的、现在不是开着的开回，关着的不动。恢复动作经 fleet-api 写操作记录。
 * 恢复不成功（读不到、开不回去、读回来不对）是「没成」：退出码 2、写明发版已经发出去了只是没恢复，同一个目标再跑一次 start 重试这一步。
 */
async function phaseRestore(io, state) {
  const was = clearMarker(io);
  state.marker = false;
  saveState(io, state);
  sayTo(io, `恢复：本机暂停标记${was ? '已清' : '本来就不在'}，worker.mjs start 又能起工人了`);
  const before = state.before;
  if (before === null || before === undefined || typeof before.master !== 'boolean')
    return failed(
      '恢复没成：第 2 步没记下发版前的开关状态（state.before 缺），不敢猜着开或关；发版已经发出去了，到驾驶舱环境页核对总开关和各仓「让 AI 接活」',
    );
  const eng = await engineStatus(io);
  if (!eng.ok) return failed(`恢复没成（发版已经发出去了）：${eng.why}`);
  if (!before.master) {
    sayTo(
      io,
      eng.legacy
        ? '恢复：发版前法国还没有引擎总开关，没什么要恢复的'
        : `恢复：法国总开关发版前就关着，保持关${eng.on ? '（现在是开着的：发版期间有人开了，没动）' : ''}`,
    );
    return { ok: true };
  }
  const reason = `发版后恢复发版前的状态（release-train，目标 ${targetText(state.target)}）`;
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
    `恢复：法国总开关已开回（发版前开着），各仓开回 ${opened.length} 个${opened.length ? `（${opened.join('、')}）` : ''}`,
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
  const { rows, missing } = rankIssues(issues, orderFromDescription(milestone.m.description));
  sayTo(
    io,
    `清单（${milestone.m.title}，开着 ${rows.length} 张）。先后段里写的在前，其余先挡路的、母单排最后、同级小号在前；先只打印，不自动派：`,
  );
  for (const t of rows)
    sayTo(
      io,
      `${t.rank}. #${t.number} ${t.title}${t.mother ? ' 〔母单：子单在它页面里排〕' : t.local ? ' 〔本机做〕' : ' 〔可交法国〕'}${t.listed ? '' : ' （先后段里没写）'}`,
    );
  if (missing.length > 0)
    sayTo(
      io,
      `先后段里写了、但不在开着的单里：${missing.map((n) => `#${n}`).join(' ')}（已关或已挪走，该清出先后段）`,
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
  phasePauseLocal,
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
          ? '版本已经发出去了，这一步只是恢复发版前的开关没成。同一个目标再跑一次 start 只重试这一步'
          : `现场没动（暂停标记${state.marker ? '还在' : '没写'}）。同一个目标再跑一次 start 从这一步接着走；不走了就 node release-train.mjs abort`,
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
  const tag = p.options.get('tag');
  if ((sha === undefined) === (tag === undefined)) throw new UsageError('--sha 和 --tag 要恰好给一个');
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha))
    throw new UsageError(`--sha 要是十六进制的提交号（7–40 位），给的是「${scrubText(sha)}」`);
  if (tag !== undefined && !/^v\d+$/.test(tag))
    throw new UsageError(`--tag 要写成 v<数字>，给的是「${scrubText(tag)}」`);
  const founderOk = p.options.get('founder-ok');
  if (founderOk === undefined || founderOk.trim() === '') {
    warnTo(io, '发版是对外发布，必须带 --founder-ok "<创始人原话>"：没带，什么都没做（连暂停都没暂停）');
    return 1;
  }
  // --restore 和不给一样：发完都恢复到发版前（还原不需要创始人逐次授权）；留着只是让老命令行、明写的人不报「不认识的参数」
  const restore = p.flags.has('restore');
  const target = sha !== undefined ? { kind: 'sha', value: sha } : { kind: 'tag', value: tag };

  const read = readState(io);
  if (!read.ok) return fail(io, read.why);
  const prev = read.state;
  // 停在第 0 步（预检没过）的什么都没动过，不算「没了结」：换目标直接重来
  if (prev && (prev.status === 'blocked' || prev.status === 'failed') && prev.phase > 0) {
    if (prev.target.kind !== target.kind || prev.target.value !== target.value)
      return refuse(
        io,
        `上一趟（目标 ${targetText(prev.target)}，停在第 ${prev.phase} 步）还没了结：同一个目标再跑 start 接着走，或者先 node release-train.mjs abort`,
      );
    const state = { ...prev, founderOk, restore };
    sayTo(
      io,
      `接着上一趟走：从第 ${state.phase} 步「${PHASES[state.phase]}」起（${state.status === 'blocked' ? '上次卡住' : '上次没成'}）`,
    );
    return runFrom(io, state);
  }
  if (prev && prev.status === 'running')
    return refuse(
      io,
      `有一趟正在走（第 ${prev.phase} 步「${PHASES[prev.phase]}」，${prev.startedAt} 起）：看 node release-train.mjs status；确认它已经死了就 abort`,
    );
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
    marker: false,
    laggards: [],
    release: {},
  };
  return runFrom(io, state);
}

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
  const marker = existsSync(pauseMarkerPath(io.home));
  const s = read.state;
  if (!s) {
    sayTo(
      io,
      `没有发版在走（没有 ${STATE_REL}）。暂停标记：${marker ? '在（没有对应的一趟：node release-train.mjs abort 清掉）' : '不在'}`,
    );
    return 0;
  }
  const words = { running: '在走', blocked: '卡住了', failed: '没成', done: '做完了', aborted: '已撤销' };
  sayTo(
    io,
    `发版（${targetText(s.target)}，发完恢复发版前的开关）：${words[s.status] ?? s.status}，第 ${s.phase} 步「${PHASES[s.phase] ?? '？'}」，${s.startedAt} 起，${s.updatedAt} 更新`,
  );
  sayTo(
    io,
    `暂停标记：${marker ? '在' : '不在'}；法国总开关暂停前：${s.before ? (s.before.master ? '开着' : '关着') : '还没记'}；已发版：${s.release?.started ? '已动手' : '还没'}`,
  );
  if (s.why) sayTo(io, `停下的原因：${s.why}`);
  for (const l of s.laggards ?? []) sayTo(io, `  拖后腿：${l}`);
  return 0;
}

async function cmdAbort(io) {
  const read = readState(io);
  if (!read.ok) return fail(io, read.why);
  const s = read.state;
  const cleared = clearMarker(io);
  if (!s || s.status === 'done' || s.status === 'aborted') {
    sayTo(io, `没有在走的一趟。暂停标记${cleared ? '是留下来的，已清' : '也不在'}`);
    return 0;
  }
  sayTo(
    io,
    `撤销（目标 ${targetText(s.target)}，停在第 ${s.phase} 步）：本机暂停标记${cleared ? '已清' : '本来就不在'}`,
  );
  let code = 0;
  if (s.before?.master === true && !s.release?.started) {
    const on = await engineSet(
      io,
      true,
      `撤销发版暂停，恢复暂停前的样子（release-train abort，目标 ${targetText(s.target)}）`,
    );
    const back = on.ok ? await engineStatus(io) : on;
    if (!on.ok || !back.ok || !back.on) {
      warnTo(
        io,
        `法国总开关没能开回去（${on.ok ? (back.ok ? '读回来还是关着' : back.why) : on.why}）：暂停前它是开着的，到驾驶舱环境页或 fleet-api engine on 自己开`,
      );
      code = 2;
    } else sayTo(io, '法国总开关已开回暂停前的样子（开着）。各仓的「让 AI 接活」开关暂停期间没动过');
  } else if (s.release?.started) {
    sayTo(
      io,
      s.before?.master === true
        ? '已经动手发过版：不知道发成没有、健康没确认，法国总开关保持关（发版前是开着的）。确认没事后到驾驶舱环境页或 fleet-api engine on 自己开'
        : '已经动手发过版：法国总开关发版前就是关着的，保持关',
    );
  } else {
    sayTo(io, '法国总开关暂停前就是关着的（或还没暂停），没动');
  }
  s.status = 'aborted';
  s.marker = false;
  s.why = '手动撤销';
  saveState(io, s);
  return code;
}

/**
 * 入口。io = {
 *   home, env, now(), sleep(ms), cwd(), nodePath, scriptsDir, limits（可省，默认 DEFAULT_LIMITS）, out(text), err(text),
 *   run(command, args, {cwd, timeoutMs}) → {status, stdout, stderr, error}   gh、git、pnpm、node（worker.mjs、france.mjs）,
 *   ssh(remoteCommand, {timeoutMs}) → 同上   到法国跑一条命令（名字读不到、连不上都在返回里：error 或 status 255）,
 *   runningSessions() → Promise<{ok: true, running, rows} | {ok: false, kind, why}>   france-sessions-lib.mjs 的 fetchRunningSessions,
 *   franceRepos() → Promise<{ok: true, rows: [{repo, auto_dispatch_since}]} | {ok: false, why}>   法国各仓的「让 AI 接活」开关,
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
    if (cmd === 'start')
      return await cmdStart(parseArgs(rest, ['sha', 'tag', 'founder-ok'], ['restore']), io);
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
