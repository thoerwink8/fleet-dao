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
//   工人进程自己没跑完（网关、崩溃）才 --resume。退出码成功但交付没核上：先把状态写成「只复核」再读交付；网络读失败只退避复核、不再起工人；
//   审查未结、本分支没有唯一真实 PR、或其他确定条件写成 waiting（工作树、会话、检查点留着，不续写码）；
//   同仓其他真实 PR 已合并且验收责任已结清才写 stopped，不把本运行记 done，也不靠 issue 已关闭或伪造本分支 PR。
//   会话还没建起来就断了（--resume 报找不到会话）→ 下一次用原会话号重新起。
// - 看护进程自己没了（关机、被杀）：state.json 不是终态、beatAt 超过 BEAT_STALE_MS 没动。再跑一次 pnpm work run <单号>：
//   waiting 只复核，不 --resume 写码；还在跑的才接着同一个会话续。尝试次数接着数，租约心跳重新跑起来。
//   续跑和第一次派工都先在运行目录里原子占住 supervisor-start（建下一代 gen-<n>，同一编号跨进程只有一个能建成，见 claimRunLock 上面的说明）。占位上的进程还活着就不再起第二个看护，
//   也不手写 state/result、不杀已有进程；进程已经没了的占位才由下一次接手。看护进程自己再占 worker-slot，两个看护也不会各起一个工人。
// - 审查等待要接着改：pnpm work rework <单号>。按原 run、session 和 GitHub 上当前未解决退回代次核验后，才用 --resume 起原会话；
//   同一代次同时只起一个工人。外部交付和已停不走这条。rework.json 只是这次请求，pnpm work run 不因为它去写码。
// - 叫醒：agents/hooks/work-watch.mjs 挂在 Stop 上（asyncRewake）。终态、看护进程没了、已 park 的等待各叫一次。
//   已 park 的等待写明不是做完、不要再派写码。复核中心跳还在不叫；复核中心跳丢了只通知接着复核，不叫人去写码。
//   Codex 同步续轮读同一份结束说明，用结果摘要去重，不把 waiting 当成做完。
//
// 文件（~/.fleet-dao/work-runs/<owner>__<name>__<单号>/，FLEET_WORK_RUNS_DIR 可改）：spec.json（怎么起）、brief.md（交代）、
// state.json（现在怎样）、result.json（终态才有）、attempt-<n>.out.json / attempt-<n>.err.log（每次的输出）、reported（叫醒过了，钩子写）。
// work-watch.mjs 按同样的文件名和字段读（那边是纯 node，引不了这里；两边的测试各自钉着同一份形状）。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
/** 交给工人的环境变量（WMI 起的进程拿不到派的人的环境，只带这几样；不带令牌）。显式目标仓要带上，脱离之后续租才不会按 origin 另认一个仓。 */
export const PASS_ENV = [
  'PATH',
  'Path',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'GH_REPO',
  'GITHUB_REPOSITORY',
];

export type RunState = 'starting' | 'running' | 'retrying' | 'waiting' | 'done' | 'failed' | 'stopped';
export const TERMINAL: readonly RunState[] = ['done', 'failed', 'stopped'];

/** 同仓其他分支已经合并、并核对过的交付事实。没有这些字段就不能当已交付。 */
export interface ExternalDeliveryFact {
  repo: string;
  pr: number;
  head: string;
  mergeCommit: string;
  mergedAt: string;
}

/** 交付核验没通过时停在哪一类。retry 才会退避再读；其余确定条件不 resume 工人。 */
export type DeliveryFailureKind = 'retry' | 'review' | 'external' | 'blocked';

export interface DeliveryHold {
  kind: 'review' | 'external' | 'blocked';
  why: string;
  acceptance?: 'open' | 'settled' | 'unknown';
  external?: ExternalDeliveryFact;
}

/**
 * 交付核验的分类失败。kind 给看护进程用：网络读失败可退避，审查等待和他分支已交付不立刻 resume。
 * 调用方仍以抛错表示「不能记完成」。
 */
export class DeliveryCheckError extends Error {
  readonly kind: DeliveryFailureKind;
  readonly acceptance?: 'open' | 'settled' | 'unknown';
  readonly external?: ExternalDeliveryFact;
  /** 还有本机未确认的退回意图或未结责任：即便外部事实齐了也不能终结 */
  readonly retain?: boolean;
  constructor(
    kind: DeliveryFailureKind,
    message: string,
    extra?: {
      acceptance?: 'open' | 'settled' | 'unknown';
      external?: ExternalDeliveryFact;
      retain?: boolean;
    },
  ) {
    super(message);
    this.name = 'DeliveryCheckError';
    this.kind = kind;
    if (extra?.acceptance !== undefined) this.acceptance = extra.acceptance;
    if (extra?.external !== undefined) this.external = extra.external;
    if (extra?.retain !== undefined) this.retain = extra.retain;
  }
}

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
  /** 交付没核上时为什么停着。没有就是还在跑或已终了 */
  hold?: DeliveryHold | null;
}

export interface RunResult {
  v: typeof RUN_SCHEMA;
  repo: string;
  issue: number;
  /** stopped：需求已由其他真实 PR 交付且验收已结清，本运行停止，不记 done */
  state: 'done' | 'failed' | 'stopped';
  /** 工人最后一条回复（截断） */
  summary: string;
  why: string | null;
  sessionId: string | null;
  attempts: number;
  finishedAt: string;
}

/** 确定条件停下：没写 result.json，工作树和会话还在，恢复时只复核、不起工人。 */
export interface WaitingOutcome {
  state: 'waiting';
  why: string;
  sessionId: string | null;
  attempts: number;
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
  /** pnpm work rework 写下的这一次返工请求。看护只在带着 --rework 进来时才认。 */
  rework: join(dir, 'rework.json'),
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

/**
 * 看护进程还在不在：不是终态、beatAt 在 BEAT_STALE_MS 以内。
 * waiting 且 pid 已清掉是故意停着等复核，心跳时间还新鲜也不算有工人在跑，恢复入口不用空等一个心跳周期。
 * 复核进行中 pid 还在，这段时间算活着，同一个运行不会再起一个工人。
 */
export function supervisorLive(s: RunStatus, now: Date): boolean {
  if (TERMINAL.includes(s.state)) return false;
  if (s.state === 'waiting' && !Number.isSafeInteger(s.supervisorPid)) return false;
  const beat = Date.parse(s.beatAt);
  return Number.isFinite(beat) && now.getTime() - beat <= BEAT_STALE_MS;
}

const READ_FAIL =
  /未读成|没读成|读取失败|响应不是JSON|Unexpected token|Unexpected end|ECONN|ETIMEDOUT|fetch failed|network|超时|timed? ?out|socket hang up|\b5\d\d\b/i;

export interface ClassifiedDelivery {
  kind: DeliveryFailureKind;
  why: string;
  acceptance?: 'open' | 'settled' | 'unknown';
  external?: ExternalDeliveryFact;
  retain?: boolean;
}

/** 把交付核验抛错分成可退避的读失败，和不能靠重开 CLI 消失的确定条件。认不出的不当已交付。 */
export function classifyDeliveryError(e: unknown): ClassifiedDelivery {
  if (e instanceof DeliveryCheckError) {
    return {
      kind: e.kind,
      why: e.message,
      ...(e.acceptance ? { acceptance: e.acceptance } : {}),
      ...(e.external ? { external: e.external } : {}),
      ...(e.retain ? { retain: true } : {}),
    };
  }
  const why = e instanceof Error ? e.message : String(e);
  if (e instanceof SyntaxError || READ_FAIL.test(why) || TRANSIENT.test(why)) return { kind: 'retry', why };
  return { kind: 'blocked', why };
}

const SHA = /^[a-f0-9]{40}$/;

/** 他分支已交付可以终结：同仓、真实 PR/head/mergeCommit、验收已结清、没有仍要保留的责任。issue 关闭不算。 */
export function externalStop(spec: RunSpec, hold: DeliveryHold): boolean {
  const fact = hold.external;
  return (
    hold.kind === 'external' &&
    hold.acceptance === 'settled' &&
    !!fact &&
    fact.repo.toLowerCase() === spec.repo.toLowerCase() &&
    Number.isSafeInteger(fact.pr) &&
    fact.pr > 0 &&
    SHA.test(fact.head) &&
    SHA.test(fact.mergeCommit) &&
    Number.isFinite(Date.parse(fact.mergedAt))
  );
}

function holdFrom(spec: RunSpec, failure: ClassifiedDelivery): DeliveryHold {
  const same =
    failure.external && failure.external.repo.toLowerCase() === spec.repo.toLowerCase()
      ? failure.external
      : undefined;
  const kind: DeliveryHold['kind'] =
    failure.kind === 'review' ? 'review' : failure.kind === 'external' && same ? 'external' : 'blocked';
  return {
    kind,
    why: failure.why,
    ...(failure.acceptance ? { acceptance: failure.acceptance } : {}),
    ...(kind === 'external' && same ? { external: same } : {}),
  };
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
    `- 开 PR 用 pnpm pr:open（分支带单号会自动写关单词；改到改标准路径照仓里的规矩办，没有创始人原话就停下写进最后的回复）。受管 PR 建好后不自动挂合并：先 pnpm work feedback ${o.issue} 读取完整意见，按原 run/session 对退回逐条 ack；修复并推送后由审查方 resolve，工人不能代替审查方解除退回。无未结退回时再 pnpm work deliver ${o.issue} 为精确 head 申请 squash 自动合并。gh pr checks <PR号> --watch --fail-fast 只等检查结果，红了修好再推并重新走交付核验；检查全绿后仍须 gh pr view <PR号> --json state,mergedAt 核实真实合并，不能把检查通过当成交付完成。`,
    '- 你是 pnpm work run 派的无头工人（脱离聊天进程跑），没人能回答你的问题：交代没写的取最保守的理解，取舍写进最后的回复。',
    '- 中途被打断（网关断、进程被停）会用同一个会话续上：续的时候先看工作树和 PR 的现状，别重做已经做完的。',
    `- 每次交付先 pnpm work feedback ${o.issue} 读取完整意见；按原run/session用 pnpm work ack ${o.issue} --return <编号>确认收到，不能自行resolve。交付用 pnpm work deliver ${o.issue}，不要裸gh ready/merge绕过审查；新head和CI绿都不解除退回。`,
    '- 最后一条回复会写进结果文件、叫醒派你的会话：写结论、PR 号和合没合、没做的和原因，结论带证据。',
  ].join('\n');
}

/** pnpm work rework 写进 rework.json 的这一次请求。代次和编号必须仍是 GitHub 上未解决的那条。 */
export interface ReworkIntent {
  v: 1;
  /** spec.createdAt，不是调用方自己编的运行号 */
  run: string;
  /** state.sessionId */
  session: string;
  generation: number;
  returnId: string;
}

/**
 * 审查等待能不能按原 run/session 返工。外部交付和已停直接拒绝。
 * 只认未解决、且 run/session 对得上的退回里代次最高的那一条。
 */
export function acceptRework(
  spec: RunSpec,
  state: RunStatus,
  records: readonly {
    resolved: boolean;
    event: { action: string; run: string; session: string; generation: number; returnId: string };
  }[],
): ReworkIntent {
  if (state.hold?.kind === 'external' || state.state === 'stopped') {
    throw new Error(`#${spec.issue} 已由其他真实PR交付或已停，不重派工人`);
  }
  if (state.state !== 'waiting' || state.hold?.kind !== 'review' || !state.sessionId) {
    throw new Error(`#${spec.issue} 不是已停住的审查等待，不能返工`);
  }
  const open = records.filter(
    (r) =>
      !r.resolved &&
      r.event.action === 'return' &&
      r.event.run === spec.createdAt &&
      r.event.session === state.sessionId &&
      Number.isSafeInteger(r.event.generation) &&
      r.event.generation > 0 &&
      typeof r.event.returnId === 'string' &&
      r.event.returnId !== '',
  );
  if (open.length === 0) throw new Error(`#${spec.issue} 没有对得上原 run/session 的未解决退回，不能返工`);
  const generation = Math.max(...open.map((r) => r.event.generation));
  const current = open.filter((r) => r.event.generation === generation);
  if (current.length !== 1) throw new Error(`#${spec.issue} 当前退回代次对不上唯一未解决退回，不能返工`);
  const hit = current[0];
  if (!hit) throw new Error(`#${spec.issue} 当前退回代次对不上唯一未解决退回，不能返工`);
  return { v: 1, run: spec.createdAt, session: state.sessionId, generation, returnId: hit.event.returnId };
}

function readReworkIntent(path: string): ReworkIntent | null {
  const v = readJson<Partial<ReworkIntent>>(path);
  if (!v) return null;
  if (v.v !== 1) return null;
  if (typeof v.run !== 'string' || v.run === '') return null;
  if (typeof v.session !== 'string' || v.session === '') return null;
  if (typeof v.returnId !== 'string' || v.returnId === '') return null;
  if (typeof v.generation !== 'number' || !Number.isSafeInteger(v.generation) || v.generation < 1)
    return null;
  return { v: 1, run: v.run, session: v.session, generation: v.generation, returnId: v.returnId };
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
    /** spawn 出真实工人后同步登记其 PID，防止看护进程死后重复派工 */
    onSpawn?: (pid: number) => void;
    /** 真实工人退出后清掉 PID；看护进程若先死则由 PID 存活性保护接管 */
    onExit?: (pid: number) => void;
  }) => Promise<AttemptOutput>;
  /** 续一次法国的租约 */
  renew: () => Promise<{ ok: boolean; text: string }>;
  /** 每 ms 毫秒调一次 fn，回一个停下的函数 */
  repeat: (fn: () => void, ms: number) => () => void;
  log: (line: string) => void;
  feedbackContext?: (spec: RunSpec) => Promise<string>;
  validateDelivery?: (spec: RunSpec) => Promise<void>;
  /** 这次是 pnpm work rework 拉起的。没有这面旗，waiting 只复核，哪怕目录里有 rework.json。 */
  rework?: boolean;
  /** 用当前未解决退回核对 rework.json。对不上就不起工人。 */
  confirmRework?: (spec: RunSpec, intent: ReworkIntent) => Promise<void>;
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

/** 上次工人写进 attempt 文件的回复；复核收尾时用，不再为了取这句话起一次 CLI。 */
function lastWorkerSummary(dir: string, attempts: number): string {
  if (attempts < 1) return '';
  try {
    const json = parseResultJson(readFileSync(runFiles(dir).out(attempts), 'utf8'));
    return clip(typeof json?.result === 'string' ? json.result.trim() : '', SUMMARY_MAX);
  } catch {
    return '';
  }
}

/**
 * 看护一张单的工人到终态或等待复核。重复起（看护进程没了再起）接着同一个状态文件续。
 * 已经有一个活着的看护进程在管就回 null、什么都不动。waiting 的恢复只复核交付，不起工人。
 * 带着 rework 且 rework.json 对得上原 run/session 时，先核当前未解决退回，再 --resume 原会话。
 * 真要起工人之前先原子占住 worker-slot：两个看护进程同时读到失联心跳，也只有一个能起工人。
 */
export async function superviseRun(
  dir: string,
  deps: SuperviseDeps,
): Promise<RunResult | WaitingOutcome | null> {
  const f = runFiles(dir);
  const spec = readJson<RunSpec>(f.spec);
  if (!spec) throw new Error(`${f.spec} 不在：先 pnpm work run <单号>`);
  const brief = readFileSync(f.brief, 'utf8');
  const done = readJson<RunResult>(f.result);
  if (done) {
    if (done.state === 'done' && deps.validateDelivery) {
      try {
        await deps.validateDelivery(spec);
      } catch (e) {
        const corrected: RunResult = {
          ...done,
          state: 'failed',
          why: `旧完成回执重新核验失败：${e instanceof Error ? e.message : String(e)}`,
        };
        writeJson(f.result, corrected);
        const old = readJson<RunStatus>(f.state);
        if (old)
          writeJson(f.state, {
            ...old,
            state: 'failed',
            lastError: corrected.why,
            updatedAt: deps.now().toISOString(),
          });
        return corrected;
      }
    }
    return done;
  }
  const prev = readJson<RunStatus>(f.state);
  if (prev && prev.supervisorPid !== deps.pid && supervisorLive(prev, deps.now())) {
    deps.log(`#${spec.issue} 已经有看护进程 ${prev.supervisorPid} 在管（${prev.beatAt} 还在动），这个退出`);
    return null;
  }
  const slot = claimRunLock(dir, WORKER_SLOT_LOCK, process.pid, deps.now());
  if (!slot) {
    deps.log(`#${spec.issue} 工人名额已被占住，不并发起工人`);
    return null;
  }
  try {
    return await superviseClaimed(dir, spec, brief, prev, slot, deps);
  } finally {
    releaseRunLock(dir, WORKER_SLOT_LOCK, slot);
    releaseRunLockByPid(dir, SUPERVISOR_START_LOCK, process.pid);
  }
}

/** 占到工人名额之后才写状态、起心跳、起工人。没占到的调用方不会进这里。 */
async function superviseClaimed(
  dir: string,
  spec: RunSpec,
  brief: string,
  prev: RunStatus | null,
  workerSlot: string,
  deps: SuperviseDeps,
): Promise<RunResult | WaitingOutcome | null> {
  const f = runFiles(dir);
  const at = () => deps.now().toISOString();
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
    hold: prev?.state === 'waiting' ? (prev.hold ?? null) : null,
    state: prev?.state === 'waiting' ? 'waiting' : 'running',
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
  const finish = (
    state: 'done' | 'failed' | 'stopped',
    summary: string,
    why: string | null,
    hold: DeliveryHold | null = null,
  ): RunResult => {
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
    save({ state, nextTryAt: null, lastError: why, hold });
    return r;
  };
  // 交付没核上：不写 result，清掉 pid，让恢复入口能进来复核；会话和工作树不动。
  const park = (hold: DeliveryHold): WaitingOutcome => {
    save({
      state: 'waiting',
      hold,
      lastError: hold.why,
      nextTryAt: null,
      supervisorPid: null,
      sessionStarted: true,
    });
    deps.log(`#${spec.issue} 交付停在确定条件，不续工人：${hold.why}`);
    return { state: 'waiting', why: hold.why, sessionId: s.sessionId, attempts: s.attempts };
  };
  // 工人已经正常退出之后只复核事实。网络失败退避再读；确定条件停下。两种都不另起 CLI。
  // 第一次 await 之前就把「只复核」写盘：核验读到一半进程没了，恢复也不能再 --resume 写码。
  const settleDelivery = async (summary: string): Promise<RunResult | WaitingOutcome> => {
    save({
      state: 'waiting',
      supervisorPid: deps.pid,
      sessionStarted: true,
      hold: s.hold ?? { kind: 'blocked', why: '工人已退出，正在复核交付，不起新工人' },
    });
    let tries = 0;
    for (;;) {
      try {
        if (deps.validateDelivery) await deps.validateDelivery(spec);
        return finish('done', summary, null);
      } catch (e) {
        const failure = classifyDeliveryError(e);
        if (failure.kind === 'retry') {
          tries += 1;
          const why = `交付核验没读成：${failure.why}`;
          if (tries >= MAX_ATTEMPTS) {
            return park({
              kind: 'blocked',
              why: `交付核验连续 ${tries} 次没读成，不再起工人：${failure.why}`,
            });
          }
          const wait = backoffMs(tries);
          save({
            state: 'waiting',
            supervisorPid: deps.pid,
            hold: { kind: 'blocked', why },
            lastError: why,
            nextTryAt: new Date(deps.now().getTime() + wait).toISOString(),
            sessionStarted: true,
          });
          deps.log(`#${spec.issue} ${why}，${Math.round(wait / 1000)} 秒后只复核、不起工人`);
          await deps.sleep(wait);
          continue;
        }
        const hold = holdFrom(spec, failure);
        if (failure.kind === 'external' && !failure.retain && externalStop(spec, hold)) {
          return finish('stopped', summary, hold.why, hold);
        }
        return park(hold);
      }
    }
  };
  try {
    await renew();
    const sessionId = s.sessionId ?? deps.newSessionId();
    if (s.sessionId === null) save({ sessionId });
    const intent = deps.rework ? readReworkIntent(f.rework) : null;
    const applying =
      prev?.state === 'waiting' &&
      intent !== null &&
      intent.run === spec.createdAt &&
      intent.session === sessionId &&
      s.hold?.kind === 'review';
    if (prev?.state === 'waiting' && !applying)
      return await settleDelivery(lastWorkerSummary(dir, s.attempts));
    if (applying && intent) {
      if (!deps.confirmRework) {
        rmSync(f.rework, { force: true });
        return park({ kind: 'review', why: '返工未经当前退回代次核验，不起工人' });
      }
      try {
        await deps.confirmRework(spec, intent);
      } catch (e) {
        rmSync(f.rework, { force: true });
        return park({
          kind: 'review',
          why: `返工未核上当前未解决退回，不续写码：${e instanceof Error ? e.message : String(e)}`,
        });
      }
      save({ sessionStarted: true });
    }
    let dropRework = applying;
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
      save({ state: 'running', attempts: n, nextTryAt: null, hold: null });
      if (dropRework) {
        rmSync(f.rework, { force: true });
        rmSync(f.reported, { force: true });
        dropRework = false;
      }
      deps.log(
        `#${spec.issue} 第 ${n} 次起工人（${resume ? `--resume ${sessionId}` : `新会话 ${sessionId}`}）`,
      );
      const out = await deps.runWorker({
        args: workerArgs(sessionId, resume),
        stdin: deps.feedbackContext
          ? `${resume ? RESUME_PROMPT : brief}\n${await deps.feedbackContext(spec)}`
          : resume
            ? RESUME_PROMPT
            : brief,
        cwd: spec.worktree,
        env: {
          ...spec.env,
          FLEET_WORKER: '1',
          FLEET_WORK_RUNS_DIR: dirname(dir),
          FLEET_WORK_RUN: spec.createdAt,
          FLEET_WORK_SESSION: sessionId,
        },
        outFile: f.out(n),
        errFile: f.err(n),
        onSpawn: (workerPid) => {
          try {
            if (!setRunLockWorker(dir, WORKER_SLOT_LOCK, workerSlot, workerPid)) {
              deps.log(`#${spec.issue} 工人 PID ${workerPid} 没能登记到 worker-slot，保留看护进程占位`);
            }
          } catch (e) {
            deps.log(
              `#${spec.issue} 工人 PID ${workerPid} 登记 worker-slot 失败，保留看护进程占位：${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        },
        onExit: (workerPid) => {
          try {
            setRunLockWorker(dir, WORKER_SLOT_LOCK, workerSlot, null);
          } catch (e) {
            deps.log(
              `#${spec.issue} 工人 PID ${workerPid} 退出后清理 worker-slot 失败：${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        },
      });
      const v = judgeAttempt(out);
      if (v.kind === 'done') {
        save({ sessionStarted: true });
        return await settleDelivery(v.summary);
      }
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
      const label =
        r.result.state === 'done' ? '做完' : r.result.state === 'stopped' ? '已停，不再派工' : '没做成';
      return `${head} ${label}（第 ${r.result.attempts} 次，${r.result.finishedAt}）：${tail}`;
    }
    if (runLockHeld(r.dir, SUPERVISOR_START_LOCK, now) && !supervisorLive(s, now)) {
      return `${head} 看护进程正在起来，不再另派；工作树 ${s.worktree}`;
    }
    if (s.state === 'waiting') {
      const who = supervisorLive(s, now) ? '正在复核' : '在等';
      return `${head} ${who}，不续工人：${s.lastError ?? ''}；工作树 ${s.worktree}；会话 ${s.sessionId ?? '无'} 保留`;
    }
    if (!supervisorLive(s, now)) {
      return `${head} 看护进程没了（最后心跳 ${s.beatAt}，第 ${s.attempts} 次）：pnpm work run ${s.issue} 接着同一个会话续`;
    }
    const retry = s.state === 'retrying' ? `，${s.nextTryAt} 续（${s.lastError ?? ''}）` : '';
    const lease = s.lastRenewOk === false ? '，租约上次没续上' : '';
    return `${head} 在跑：第 ${s.attempts} 次${retry}${lease}；工作树 ${s.worktree}`;
  });
}

/**
 * 恢复入口和工人名额的跨进程占位。锁目录只是容器，归属看里面编号最大的代次目录 gen-<n>：
 * - 占位：读出最大的一代，判它没人占（已放开，或 owner 进程和它登记的工人都没了），只接它的下一代——
 *   先在容器里把 generation.json、owner.json 写进临时目录，再整个改名成 gen-<n+1>。改名撞上已经在的非空目录必失败，
 *   同一个编号只有一个人建得成；建成那一刻 owner 已经在里面，没有「目录有了、owner 还没发布」的窗口。
 * - 建成后再列一次：已经有比自己大的一代，说明有人接替得更早，自己这一代作废，只删自己的。
 * - 代次只增不减：放开只在自己那一代里写 released.json，不删目录；赢家只清比自己小的代次（它们不可能还占着）。
 *   编号不回收，凭旧判断慢一步的恢复者要么撞上已经在的编号，要么建出比现任小的一代，复核时认输。
 * 不靠时间先后，也不另设回收闸：判死的那一代就是被接替的那一代，接替只是新建下一代，不挪、不删、不覆盖任何活着的代次。
 * owner.json 之后还会被交接、登记工人改写，所以先后只看编号，不看目录时间。
 */
export const SUPERVISOR_START_LOCK = 'supervisor-start';
/** 看护进程里的工人名额。两个看护进程同时进来，只有占到的那个起工人。 */
export const WORKER_SLOT_LOCK = 'worker-slot';

interface RunLockOwner {
  pid: number;
  token: string;
  claimedAt: string;
  /** worker-slot 由看护进程交接给真实 spawn 子进程后留下的 PID */
  workerPid?: number;
}

interface LockGeneration {
  n: number;
  path: string;
}

const GENERATION_DIR = /^gen-(\d{1,15})$/;
const GENERATION_FILE = 'generation.json';
const OWNER_FILE = 'owner.json';
const RELEASED_FILE = 'released.json';
const TMP_PREFIX = '.tmp-';
/** 改名成某一代没成：编号已经被别人建了（Windows 上是 EPERM/EACCES），或临时目录、容器不在了。都当没占上。 */
const LOST_PUBLISH = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

let lockSeq = 0;

function lockPath(dir: string, name: string): string {
  return join(dir, name);
}

function parseLockOwner(path: string): RunLockOwner | null {
  let v: Partial<RunLockOwner> | null;
  try {
    v = readJson<Partial<RunLockOwner>>(path);
  } catch {
    return null;
  }
  if (!v || typeof v.token !== 'string' || v.token === '') return null;
  if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid < 1) return null;
  if (typeof v.claimedAt !== 'string') return null;
  if (
    v.workerPid !== undefined &&
    (typeof v.workerPid !== 'number' || !Number.isSafeInteger(v.workerPid) || v.workerPid < 1)
  )
    return null;
  return {
    pid: v.pid,
    token: v.token,
    claimedAt: v.claimedAt,
    ...(v.workerPid === undefined ? {} : { workerPid: v.workerPid }),
  };
}

function listNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** 容器里的各代，编号从大到小 */
function generations(lock: string): LockGeneration[] {
  const out: LockGeneration[] = [];
  for (const name of listNames(lock)) {
    const m = GENERATION_DIR.exec(name);
    if (m) out.push({ n: Number(m[1]), path: join(lock, name) });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** 进程还在不在。EPERM 当还在（没有权限发信号不代表没这个进程）；只有 ESRCH 是真没了。 */
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function ownerAlive(owner: RunLockOwner | null): boolean {
  return !!owner && (pidAlive(owner.pid) || (owner.workerPid !== undefined && pidAlive(owner.workerPid)));
}

function fresh(path: string, now: Date): boolean {
  try {
    return now.getTime() - statSync(path).mtimeMs <= BEAT_STALE_MS;
  } catch {
    // 看不到就当有人刚动过，不并发起
    return true;
  }
}

/** 这一代还占不占着：放开了不占；owner 认得出看进程和工人；认不出（正常不会有）按目录新不新鲜保守地算。 */
function generationHeld(g: LockGeneration, now: Date): boolean {
  if (existsSync(join(g.path, RELEASED_FILE))) return false;
  const owner = parseLockOwner(join(g.path, OWNER_FILE));
  return owner ? ownerAlive(owner) : fresh(g.path, now);
}

/** 旧版本的占位（容器根上的 owner.json、candidates/*）还活着就当占着：升级时不和还在跑的旧看护抢。 */
function legacyHeld(lock: string): boolean {
  if (ownerAlive(parseLockOwner(join(lock, OWNER_FILE)))) return true;
  return listNames(join(lock, 'candidates')).some((n) =>
    ownerAlive(parseLockOwner(join(lock, 'candidates', n, OWNER_FILE))),
  );
}

interface LockView {
  /** 判空闲时读到的最大一代；接替只接它的下一代 */
  top: LockGeneration | null;
  held: boolean;
  /** 还没有任何一代、也认不出旧归属，容器又是新鲜的：有人刚建好容器正要发布 */
  pending: boolean;
}

function inspectLock(lock: string, now: Date): LockView {
  if (!existsSync(lock)) return { top: null, held: false, pending: false };
  const top = generations(lock)[0] ?? null;
  if (legacyHeld(lock)) return { top, held: true, pending: false };
  if (top) return { top, held: generationHeld(top, now), pending: false };
  if (parseLockOwner(join(lock, OWNER_FILE))) return { top, held: false, pending: false };
  return { top, held: false, pending: fresh(lock, now) };
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 清不掉的残骸不影响判归属：只有最大的一代算数
  }
}

/** 某个 token 现在拥有的那一代（没放开的）。 */
function generationOf(lock: string, token: string): { g: LockGeneration; owner: RunLockOwner } | null {
  for (const g of generations(lock)) {
    const owner = parseLockOwner(join(g.path, OWNER_FILE));
    if (owner?.token !== token) continue;
    if (existsSync(join(g.path, RELEASED_FILE))) return null;
    return { g, owner };
  }
  return null;
}

/** 现任：最大一代的 owner（放开了就没有）；还没有任何一代时是旧版本留下的 owner。 */
function readLockOwner(dir: string, name: string): RunLockOwner | null {
  const lock = lockPath(dir, name);
  const top = generations(lock)[0];
  if (!top) return parseLockOwner(join(lock, OWNER_FILE));
  if (existsSync(join(top.path, RELEASED_FILE))) return null;
  return parseLockOwner(join(top.path, OWNER_FILE));
}

/**
 * 占位还算不算数。最大一代的进程或它登记的工人还活着就占着，恢复不能再起一个工人。
 * 放开了、进程和工人都没了，才轮到下一次接手。还没有任何一代、又认不出归属的新鲜容器：当有人正在占，不并发起。
 */
export function runLockHeld(dir: string, name: string, now: Date): boolean {
  const view = inspectLock(lockPath(dir, name), now);
  return view.held || view.pending;
}

export function claimRunLock(dir: string, name: string, pid: number, now: Date): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('占位进程号不对');
  mkdirSync(dir, { recursive: true });
  const lock = lockPath(dir, name);
  let created = false;
  try {
    mkdirSync(lock);
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // 判空闲和定编号用同一次读：判的是哪一代没人占，就只接它的下一代。
  const view = inspectLock(lock, now);
  if (view.held || (view.pending && !created)) return null;
  const n = (view.top?.n ?? 0) + 1;
  lockSeq += 1;
  const token = `${pid}-${now.getTime()}-${lockSeq}`;
  const generation = { pid, token, claimedAt: now.toISOString() };
  const tmp = join(lock, `${TMP_PREFIX}${token}`);
  const mine = join(lock, `gen-${n}`);
  try {
    mkdirSync(tmp);
    writeJson(join(tmp, GENERATION_FILE), generation);
    writeJson(join(tmp, OWNER_FILE), generation);
    renameSync(tmp, mine);
  } catch (e) {
    removeQuietly(tmp);
    if (LOST_PUBLISH.has(String((e as NodeJS.ErrnoException).code))) return null;
    throw e;
  }
  // 建成之后再列一次：已经有更大的一代，这一代作废。只删自己这一代，别人的一律不碰。
  if (generations(lock).some((g) => g.n > n) || legacyHeld(lock)) {
    removeQuietly(mine);
    return null;
  }
  for (const g of generations(lock)) if (g.n < n) removeQuietly(g.path);
  for (const entry of listNames(lock)) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const owner = Number(entry.slice(TMP_PREFIX.length).split('-')[0]);
    if (Number.isSafeInteger(owner) && owner > 0 && !pidAlive(owner)) removeQuietly(join(lock, entry));
  }
  return token;
}

/** 只放自己占上的那一代：在里面写 released.json，目录和编号留着。token 对不上就不动，失败方放不掉赢家。 */
export function releaseRunLock(dir: string, name: string, token: string): void {
  const hit = generationOf(lockPath(dir, name), token);
  if (!hit) return;
  writeJson(join(hit.g.path, RELEASED_FILE), { token, releasedAt: new Date().toISOString() });
}

/** 看护进程退出时放开入口交过来的占位。只认自己的进程号，不放别人刚占上的。 */
export function releaseRunLockByPid(dir: string, name: string, pid: number): void {
  const owner = readLockOwner(dir, name);
  if (!owner || owner.pid !== pid) return;
  releaseRunLock(dir, name, owner.token);
}

/** 入口把占位从自己改到刚拉起的看护进程。只改自己那一代的 owner，token 不变，失败方的 finally 仍放不掉这把锁。 */
export function handoffRunLock(dir: string, name: string, token: string, pid: number, now: Date): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const hit = generationOf(lockPath(dir, name), token);
  if (!hit) return false;
  writeJson(join(hit.g.path, OWNER_FILE), { pid, token, claimedAt: now.toISOString() });
  const saved = readLockOwner(dir, name);
  return saved?.token === token && saved.pid === pid;
}

/** 给 worker-slot 追加/清除真实工人 PID；看护 PID 仍保留，二者任一活着都占住名额。 */
export function setRunLockWorker(
  dir: string,
  name: string,
  token: string,
  workerPid: number | null,
): boolean {
  if (workerPid !== null && (!Number.isSafeInteger(workerPid) || workerPid < 1)) return false;
  const hit = generationOf(lockPath(dir, name), token);
  if (!hit) return false;
  writeJson(join(hit.g.path, OWNER_FILE), {
    pid: hit.owner.pid,
    token: hit.owner.token,
    claimedAt: hit.owner.claimedAt,
    ...(workerPid === null ? {} : { workerPid }),
  });
  const saved = readLockOwner(dir, name);
  return (
    saved?.token === token &&
    (workerPid === null ? saved.workerPid === undefined : saved.workerPid === workerPid)
  );
}

/** 一张单有没有运行记录、在不在跑、是不是终了、还是停着等复核 */
export function runPhase(dir: string, now: Date): 'none' | 'live' | 'lost' | 'terminal' | 'waiting' {
  const f = runFiles(dir);
  if (existsSync(f.result)) return 'terminal';
  const s = readJson<RunStatus>(f.state);
  if (!s) return existsSync(f.spec) ? 'lost' : 'none';
  if (supervisorLive(s, now)) return 'live';
  if (s.state === 'waiting') return 'waiting';
  return 'lost';
}

/** 新起一张单的运行目录（已有终了的记录要 --again：旧目录改名留着，不删） */
export function prepareRunDir(dir: string, now: Date, again: boolean): void {
  if (existsSync(dir) && again) renameSync(dir, `${dir}.${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
}
