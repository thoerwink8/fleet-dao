// 本机写码工人脱离聊天进程（单 #2761 第二片）：pnpm work run <单号> | pnpm work runs。
// 为什么：本机工人以前是聊天进程里的子代理，Mirasim 每重启一次 Claude Code（创始人按停止、插队）就一起停（三天 8 次，停掉 3 个工人）；
// reclaude 网关一次 502 也让本机 8 个工人同时断了。所以工人既要脱离聊天进程，又要在网关恢复后自己从断点续。
//
// 怎么跑：
// - pnpm work run <单号>（runCmd）：过一遍本机容量（agents/hooks/capacity.mjs，和派子代理同一个判法，不够、没查成都不派）→ 领单
//   （本机没有这张单的租约才领，和 pnpm work claim 同一条路）→ 建或复用工作树 <主检出>/.claude/worktrees/<单号>-<短名>（分支 local/<单号>-<短名>）
//   → 写交代和 spec → 经 agents/local-sessions/detach.mjs 起看护进程（Windows 走 WMI，父进程不在聊天进程的树里，taskkill /T 摸不到）。
// - 看护进程（bin/work-supervisor.ts → superviseRun）：经 reclaude 起无头工人（--agent general-purpose，-p，交代从标准输入喂，
//   --output-format json，--session-id 定好会话号）；每 BEAT_EVERY_MS 写一次 state.json 的 beatAt，每 RENEW_EVERY_MS 续一次法国的租约
//   （pnpm work renew 同一条路）；工人退出后判：做完 → 写 result.json（done）；网关、网络断（5xx、overloaded、连不上……）或认不出的失败 →
//   等一会儿（1、2、4……分钟，最多 10 分钟）用 --resume <同一个会话号> 接着做，最多 MAX_ATTEMPTS 次；登录、权限坏了 → 写 result.json（failed）。
//   会话还没建起来就断了（--resume 报找不到会话）→ 下一次用原会话号重新起。
// - 看护进程自己没了（关机、被杀）：state.json 不是终态、beatAt 超过 BEAT_STALE_MS 没动。再跑一次 pnpm work run <单号> 就接着同一个
//   状态文件、同一个会话号续（--resume），尝试次数接着数，租约心跳重新跑起来。
// - 叫醒：agents/hooks/work-watch.mjs 挂在 Stop 上（asyncRewake），只在 result.json 写出来（或看护进程没了）时叫醒派它的会话
//   （state.json 的 dispatcher = 派的时候的 CLAUDE_CODE_SESSION_ID），中间的心跳、重试都不叫。
//
// 文件（~/.fleet-dao/work-runs/<owner>__<name>__<单号>/，FLEET_WORK_RUNS_DIR 可改）：spec.json（怎么起）、brief.md（交代）、
// state.json（现在怎样）、result.json（终态才有）、attempt-<n>.out.json / attempt-<n>.err.log（每次的输出）、reported（叫醒过了，钩子写）。
// work-watch.mjs 按同样的文件名和字段读（那边是纯 node，引不了这里；两边的测试各自钉着同一份形状）。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RUN_SCHEMA = 1;
/** 看护进程多久写一次 beatAt */
export const BEAT_EVERY_MS = 30_000;
/** beatAt 这么久没动、又不是终态，就算看护进程没了（work-watch.mjs 同一个数） */
export const BEAT_STALE_MS = 3 * 60_000;
/** 多久续一次法国的租约（租约 2 小时） */
export const RENEW_EVERY_MS = 20 * 60_000;
/** 最多起几次工人（第一次 + 续的） */
export const MAX_ATTEMPTS = 12;
/** 第一次续之前等多久；之后每次翻倍，最多 MAX_BACKOFF_MS */
export const FIRST_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
/** 结果里留最后一条回复的前多少字 */
export const SUMMARY_MAX = 2000;
/** 交给工人的环境变量（WMI 起的进程拿不到派的人的环境，只带这几样；不带令牌） */
export const PASS_ENV = [
  'PATH',
  'Path',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export type RunState = 'starting' | 'running' | 'retrying' | 'done' | 'failed';
export const TERMINAL: readonly RunState[] = ['done', 'failed'];

export interface RunSpec {
  v: typeof RUN_SCHEMA;
  repo: string;
  issue: number;
  title: string;
  /** 跑 pnpm work 的那份检出（看护进程在这里续租） */
  repoRoot: string;
  worktree: string;
  branch: string;
  dispatcher: string | null;
  reclaude: string;
  env: Record<string, string>;
  createdAt: string;
}

export interface RunStatus {
  v: typeof RUN_SCHEMA;
  repo: string;
  issue: number;
  state: RunState;
  dispatcher: string | null;
  worktree: string;
  branch: string;
  supervisorPid: number | null;
  sessionId: string | null;
  /** 会话建起来了（工人至少输出过一次带会话号的结果，或 --resume 没报找不到）：续的时候用 --resume */
  sessionStarted: boolean;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  beatAt: string;
  lastRenewAt: string | null;
  lastRenewOk: boolean | null;
  lastError: string | null;
  nextTryAt: string | null;
}

export interface RunResult {
  v: typeof RUN_SCHEMA;
  repo: string;
  issue: number;
  state: 'done' | 'failed';
  /** 工人最后一条回复（截断） */
  summary: string;
  why: string | null;
  sessionId: string | null;
  attempts: number;
  finishedAt: string;
}

/** 运行记录的根目录 */
export function runsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.FLEET_WORK_RUNS_DIR || join(home, '.fleet-dao', 'work-runs');
}

export function runDir(root: string, repo: string, issue: number): string {
  return join(root, `${repo.replace(/[^\w.-]+/g, '__')}__${issue}`);
}

export const runFiles = (dir: string) => ({
  spec: join(dir, 'spec.json'),
  brief: join(dir, 'brief.md'),
  state: join(dir, 'state.json'),
  result: join(dir, 'result.json'),
  reported: join(dir, 'reported'),
  out: (n: number) => join(dir, `attempt-${n}.out.json`),
  err: (n: number) => join(dir, `attempt-${n}.err.log`),
});

/** 原子写：tmp 再改名，读的一方（钩子、pnpm work runs）不会读到一半 */
export function writeJson(path: string, v: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  for (let i = 0; ; i += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      // Windows 上目标正被别人读着时改名会 EPERM，重试几次
      if (i >= 4) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** 读 JSON；没有是 null，坏了抛 */
export function readJson<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text) as T;
}

/** 看护进程还在不在：不是终态、beatAt 在 BEAT_STALE_MS 以内 */
export function supervisorLive(s: RunStatus, now: Date): boolean {
  if (TERMINAL.includes(s.state)) return false;
  const beat = Date.parse(s.beatAt);
  return Number.isFinite(beat) && now.getTime() - beat <= BEAT_STALE_MS;
}

// ---------- 判一次工人跑完的结果 ----------

export interface AttemptOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Verdict =
  | { kind: 'done'; summary: string; sessionId: string | null }
  | {
      kind: 'retry';
      why: string;
      sessionId: string | null;
      /** missing：--resume 说会话不在；exists：--session-id 说这个号已经用了；unknown：看不出 */
      session: 'missing' | 'exists' | 'unknown';
    }
  | { kind: 'fatal'; why: string; sessionId: string | null };

/** 网关、网络、上游忙：等一会儿续 */
const TRANSIENT =
  /\b(?:5\d\d|429)\b|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|gateway|timed? ?out|connection (?:error|refused|reset)|API Error|rate limit/i;
/** 登录、额度、权限坏了：续也没用，照实报 */
const FATAL =
  /invalid api key|\b401\b|\b403\b|not logged in|please run \/login|authentication|unauthori[sz]ed|credit balance|permission denied by/i;
/** --resume 的会话不在（第一次就断了，会话没建起来） */
const NO_SESSION = /no conversation found|session .* not found|no session found/i;
/** --session-id 的号已经有会话了（上一次其实建起来了，只是没输出就断了） */
const SESSION_TAKEN = /already in use|already exists/i;

/** 从 --output-format json 的输出里取最后那个结果对象；认不出是 null */
export function parseResultJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      if (Array.isArray(v)) {
        const last = [...v]
          .reverse()
          .find((x) => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'result');
        return (last as Record<string, unknown> | undefined) ?? null;
      }
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text);
  if (whole) return whole;
  for (const line of text.split(/\r?\n/).reverse()) {
    const v = line.trim() ? tryParse(line) : null;
    if (v) return v;
  }
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 工人这一次跑完怎么办：做完、续、还是不续了 */
export function judgeAttempt(o: AttemptOutput): Verdict {
  const json = parseResultJson(o.stdout);
  const sessionId = typeof json?.session_id === 'string' ? json.session_id : null;
  const result = typeof json?.result === 'string' ? json.result : '';
  const isError =
    json?.is_error === true || (typeof json?.subtype === 'string' && json.subtype !== 'success');
  if (o.code === 0 && json && !isError) {
    return { kind: 'done', summary: clip(result.trim(), SUMMARY_MAX), sessionId };
  }
  const text = `${result}\n${o.stderr}\n${json ? '' : o.stdout}`.trim();
  const short = clip(text.replace(/\s+/g, ' '), 300) || `退出码 ${o.code ?? '（被信号停了）'}，没有输出`;
  if (NO_SESSION.test(text))
    return { kind: 'retry', why: `会话没建起来（${short}）`, sessionId, session: 'missing' };
  if (SESSION_TAKEN.test(text)) {
    return {
      kind: 'retry',
      why: `会话已经建起来了，改用 --resume（${short}）`,
      sessionId,
      session: 'exists',
    };
  }
  if (FATAL.test(text)) return { kind: 'fatal', why: `登录、权限或额度坏了，续也没用：${short}`, sessionId };
  if (json?.subtype === 'error_max_turns') return { kind: 'fatal', why: `回合用完了：${short}`, sessionId };
  // 网关、网络断，或认不出的失败（进程被停、没输出）：续。认不出的也续——续不成次数用完照样落成 failed
  const why = TRANSIENT.test(text) ? `网关或网络断了：${short}` : `没跑完：${short}`;
  return { kind: 'retry', why, sessionId, session: 'unknown' };
}

/** 第 n 次续之前等多久（n 从 1 起） */
export function backoffMs(n: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, n - 1));
}

// ---------- 交代 ----------

export function defaultBrief(o: { issue: number; title: string; worktree: string; branch: string }): string {
  return [
    `单 #${o.issue}：${o.title}`,
    '',
    `照 \`gh issue view ${o.issue}\` 的正文做，「怎么算做完」逐条做到，直到 PR 合并。`,
    `- 工作树 ${o.worktree}（分支 ${o.branch}，从 origin/main 拉的；先读仓根 AGENTS.md，再 pnpm install --frozen-lockfile）。单已经领好，不用再 pnpm work claim。`,
    '- 只跑改到的和新加的测试文件（npx vitest run <文件>），再跑仓里的格式和类型检查；新用例改前红、改后绿。',
    `- 开 PR 用 pnpm pr:open（分支带单号会自动写关单词；改到改标准路径照仓里的规矩办，没有创始人原话就停下写进最后的回复）。开完用一条前台的 gh pr checks <PR号> --watch --fail-fast 等到合并或红，红了查根子、修好再推，直到合并。`,
    '- 你是 pnpm work run 派的无头工人（脱离聊天进程跑），没人能回答你的问题：交代没写的取最保守的理解，取舍写进最后的回复。',
    '- 中途被打断（网关断、进程被停）会用同一个会话续上：续的时候先看工作树和 PR 的现状，别重做已经做完的。',
    '- 最后一条回复会写进结果文件、叫醒派你的会话：写结论、PR 号和合没合、没做的和原因，结论带证据。',
  ].join('\n');
}

export const RESUME_PROMPT =
  '上一次被打断了（网关断、或进程被停）。从断点接着做：先看工作树（git status、git log）和这张单的 PR（gh pr list --head <分支>）现在怎样，' +
  '别重做已经做完的；做完照原来的交代写最后一条回复。';

// ---------- 看护进程 ----------

export interface SuperviseDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  newSessionId: () => string;
  /** 起一次工人，跑完回退出码和输出（输出也落到 outFile、errFile） */
  runWorker: (o: {
    args: string[];
    stdin: string;
    cwd: string;
    env: Record<string, string>;
    outFile: string;
    errFile: string;
  }) => Promise<AttemptOutput>;
  /** 续一次法国的租约 */
  renew: () => Promise<{ ok: boolean; text: string }>;
  /** 每 ms 毫秒调一次 fn，回一个停下的函数 */
  repeat: (fn: () => void, ms: number) => () => void;
  log: (line: string) => void;
}

/** 工人的命令行：第一次定会话号，续的时候 --resume 同一个 */
export function workerArgs(sessionId: string, resume: boolean): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--agent',
    'general-purpose',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];
}

/**
 * 看护一张单的工人到终态。重复起（看护进程没了再起）接着同一个状态文件续。返回最后写下的结果；
 * 已经有一个活着的看护进程在管就回 null、什么都不动。
 */
export async function superviseRun(dir: string, deps: SuperviseDeps): Promise<RunResult | null> {
  const f = runFiles(dir);
  const spec = readJson<RunSpec>(f.spec);
  if (!spec) throw new Error(`${f.spec} 不在：先 pnpm work run <单号>`);
  const brief = readFileSync(f.brief, 'utf8');
  const done = readJson<RunResult>(f.result);
  if (done) return done;
  const at = () => deps.now().toISOString();
  const prev = readJson<RunStatus>(f.state);
  if (prev && prev.supervisorPid !== deps.pid && supervisorLive(prev, deps.now())) {
    deps.log(`#${spec.issue} 已经有看护进程 ${prev.supervisorPid} 在管（${prev.beatAt} 还在动），这个退出`);
    return null;
  }
  let s: RunStatus = {
    v: RUN_SCHEMA,
    repo: spec.repo,
    issue: spec.issue,
    dispatcher: spec.dispatcher,
    worktree: spec.worktree,
    branch: spec.branch,
    sessionId: prev?.sessionId ?? null,
    sessionStarted: prev?.sessionStarted ?? false,
    attempts: prev?.attempts ?? 0,
    startedAt: prev?.startedAt ?? at(),
    lastRenewAt: prev?.lastRenewAt ?? null,
    lastRenewOk: prev?.lastRenewOk ?? null,
    lastError: prev?.lastError ?? null,
    state: 'running',
    supervisorPid: deps.pid,
    updatedAt: at(),
    beatAt: at(),
    nextTryAt: null,
  };
  const save = (patch: Partial<RunStatus>) => {
    s = { ...s, ...patch, updatedAt: at(), beatAt: at() };
    writeJson(f.state, s);
  };
  save({});
  const stopBeat = deps.repeat(() => {
    try {
      save({});
    } catch {
      // 心跳写不成下一拍再写
    }
  }, BEAT_EVERY_MS);
  const renew = async () => {
    try {
      const r = await deps.renew();
      save({ lastRenewAt: at(), lastRenewOk: r.ok });
      if (!r.ok) deps.log(`续租没成：${r.text}`);
    } catch (e) {
      save({ lastRenewAt: at(), lastRenewOk: false });
      deps.log(`续租没成：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const stopRenew = deps.repeat(() => void renew(), RENEW_EVERY_MS);
  const finish = (state: 'done' | 'failed', summary: string, why: string | null): RunResult => {
    const r: RunResult = {
      v: RUN_SCHEMA,
      repo: spec.repo,
      issue: spec.issue,
      state,
      summary,
      why,
      sessionId: s.sessionId,
      attempts: s.attempts,
      finishedAt: at(),
    };
    writeJson(f.result, r);
    save({ state, nextTryAt: null, lastError: why });
    return r;
  };
  try {
    await renew();
    const sessionId = s.sessionId ?? deps.newSessionId();
    if (s.sessionId === null) save({ sessionId });
    for (;;) {
      if (s.attempts >= MAX_ATTEMPTS) {
        return finish(
          'failed',
          '',
          `起了 ${s.attempts} 次都没做完，最后一次：${s.lastError ?? '（没记下）'}`,
        );
      }
      const n = s.attempts + 1;
      const resume = s.sessionStarted;
      save({ state: 'running', attempts: n, nextTryAt: null });
      deps.log(
        `#${spec.issue} 第 ${n} 次起工人（${resume ? `--resume ${sessionId}` : `新会话 ${sessionId}`}）`,
      );
      const out = await deps.runWorker({
        args: workerArgs(sessionId, resume),
        stdin: resume ? RESUME_PROMPT : brief,
        cwd: spec.worktree,
        env: { ...spec.env, FLEET_WORKER: '1' },
        outFile: f.out(n),
        errFile: f.err(n),
      });
      const v = judgeAttempt(out);
      if (v.kind === 'done') return finish('done', v.summary, null);
      if (v.kind === 'fatal') return finish('failed', '', v.why);
      // 会话号对上了、或 --session-id 说号已经用了，说明会话建起来了，下次 --resume；--resume 报找不到会话就退回用原会话号新起
      const started =
        v.session === 'missing'
          ? false
          : v.session === 'exists' || s.sessionStarted || v.sessionId === sessionId || resume;
      // 只是会话号用法换一下（不是断了）：不用等
      const wait = v.session === 'unknown' ? backoffMs(n) : 0;
      save({
        state: 'retrying',
        sessionStarted: started,
        lastError: v.why,
        nextTryAt: new Date(deps.now().getTime() + wait).toISOString(),
      });
      deps.log(`#${spec.issue} 第 ${n} 次没做完（${v.why}），${Math.round(wait / 1000)} 秒后续`);
      await deps.sleep(wait);
    }
  } finally {
    stopBeat();
    stopRenew();
  }
}

// ---------- pnpm work runs ----------

export interface RunRow {
  dir: string;
  status: RunStatus | null;
  result: RunResult | null;
  problem: string | null;
}

export function listRuns(root: string): RunRow[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return [];
    throw e;
  }
  return names.map((name) => {
    const dir = join(root, name);
    const f = runFiles(dir);
    try {
      return {
        dir,
        status: readJson<RunStatus>(f.state),
        result: readJson<RunResult>(f.result),
        problem: null,
      };
    } catch (e) {
      return {
        dir,
        status: null,
        result: null,
        problem: `读不了：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  });
}

export function renderRuns(rows: RunRow[], now: Date): string[] {
  if (rows.length === 0) return ['没有 pnpm work run 派过的工人'];
  return rows.map((r) => {
    if (r.problem || !r.status) return `${r.dir}：${r.problem ?? '没有 state.json'}`;
    const s = r.status;
    const head = `#${s.issue}（${s.repo}）`;
    if (r.result) {
      const tail =
        r.result.state === 'done' ? clip(r.result.summary.split('\n')[0] ?? '', 120) : (r.result.why ?? '');
      return `${head} ${r.result.state === 'done' ? '做完' : '没做成'}（第 ${r.result.attempts} 次，${r.result.finishedAt}）：${tail}`;
    }
    if (!supervisorLive(s, now)) {
      return `${head} 看护进程没了（最后心跳 ${s.beatAt}，第 ${s.attempts} 次）：pnpm work run ${s.issue} 接着同一个会话续`;
    }
    const retry = s.state === 'retrying' ? `，${s.nextTryAt} 续（${s.lastError ?? ''}）` : '';
    const lease = s.lastRenewOk === false ? '，租约上次没续上' : '';
    return `${head} 在跑：第 ${s.attempts} 次${retry}${lease}；工作树 ${s.worktree}`;
  });
}

/** 一张单有没有运行记录、在不在跑、是不是终了 */
export function runPhase(dir: string, now: Date): 'none' | 'live' | 'lost' | 'terminal' {
  const f = runFiles(dir);
  if (existsSync(f.result)) return 'terminal';
  const s = readJson<RunStatus>(f.state);
  if (!s) return existsSync(f.spec) ? 'lost' : 'none';
  return supervisorLive(s, now) ? 'live' : 'lost';
}

/** 新起一张单的运行目录（已有终了的记录要 --again：旧目录改名留着，不删） */
export function prepareRunDir(dir: string, now: Date, again: boolean): void {
  if (existsSync(dir) && again) renameSync(dir, `${dir}.${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
}
