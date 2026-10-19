// #555-2 的装配入口：把一个 PR 的「验收那一遍」跑完——取三样（diff、要什么、怎么算做完）→ 按 0006 换家族起一次
// 冷调用（#555-1 的 invokeVerifier）→ 把结论贴成 PR 当前头上的 cold-verify 状态（合并闸读的那条）。
//
// **为什么要有这一条**：#555-1 把冷调用做成了纯接口、555-2 把它接进合并闸；「谁在什么时候跑它、读不到时怎么办」
// 落不成代码的话，合并闸等的那条状态就永远没人写（闸判「还没验」，PR 一直卡着）。这一条就是那个「谁」：
// 三段的第三段在装配侧的真身，真活动（real/task-verify.ts，任务工作流的 coldVerify）走它。
//
// **一条都不许悄悄过去**（通用段底线第三条，specs/555 第 4 条）：
// - 取三样里任何一样读不成（读 PR、读 diff、读单子、读作者族）→ 照样**贴** failure（cold-verify-post 那一层），
//   不贴 = 闸判「还没验」，和「没跑过」看不出来；
// - 挑不出家族、冷调用没跑成 → verifier-invoke 已经判 pass=false，这一层照 stress 贴 failure；
// - 贴状态本身失败 → 抛出去，调用方按「没验成」处理，不吞。开跑之前先贴一条 pending：贴不上就别花一次模型调用。
//
// **不自己判「要不要验」**：那是合并闸按分支名判的事（merge-gates.ts 的 coldVerifyNeed：引擎任务工作流开的 PR 才要）。
// 这一层只要被调了就跑；谁调它、什么时候调，见调用方（任务工作流在挂自动合并之前调）。重复贴同一条状态没有害处
// （同一 context 同一头只留最新一条），所以「该验的没验」这件事由合并闸拦住、不由这一层猜。
//
// **点名但没改的文件**（#1612）：验收条点了 diff 以外的路径时，从引擎镜像读 PR 头上的当前内容，交给 verifier-invoke
// 放进提示词。读不到（镜像没有这个仓、提交不在、git 失败）标「读不到：原因」，验收照常进行。这一步不许抛出去——
// 抛了会变成「冷调用没跑起来」，写代码的会话改不出能过的 diff。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CATALOG_NAMED_FAMILIES } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { UNVERIFIABLE_AUTHOR_FAMILIES } from './author-families.ts';
import {
  type ColdVerifyStatus,
  type ColdVerifyStatusMemo,
  coldVerifyNotRun,
  coldVerifyPending,
  coldVerifyStatus,
  coldVerifyWaiting,
  sameStatus,
  type WriteColdVerifyStatus,
} from './cold-verify-status.ts';
import type { RunRecord, RunsWriter } from './runner/not-wired.ts';
import type { OneShotDeps } from './runner/one-shot.ts';
import {
  type ChooseModelForFamily,
  FAMILY_ORDER,
  type FetchNamedFiles,
  isNamedRepoPath,
  type ModelFamily,
  type NamedHeadFile,
  type VerifierInvokeDeps,
  type VerifierInvokeInput,
  type VerifierInvokeOutput,
} from './verifier-invoke.ts';

/** 这张 PR 对着的单子：是哪张（验收这一笔记进 runs 挂在它名下，#216）、要什么、怎么算做完。 */
export interface ColdVerifySpec {
  /** 库里的 tasks.id（fetchSpec 也照它找需求文档目录）。 */
  taskId: string;
  /** 单号（GitHub issue #）。 */
  issueNumber: number;
  /** 这张单的任务工作流编号（taskWorkflowId）；不在任务工作流里验的不给。 */
  workflowId?: string;
  what: string;
  howToFinish: string[];
  specDir?: string;
  /** 引擎在会话收场后自己跑过的测试输出（有才给）：原样放进验收材料（决定 0093）。 */
  testOutput?: string;
  /**
   * 第 2 轮复核：上一轮没过的验收条编号和问题原话。有它时，调用方喂进来的 diff 应是这一轮的增量。
   * 老调用方不给。
   */
  recheck?: { failedCriteria: number[]; priorProblems: string[] };
}

/**
 * 这一次要的三样从哪来。**读不到一律抛**（顶层翻成 failure 状态）：返回 undefined / 空字符串当「没有」的写法
 * 在这一层是禁止的——那正是「拿不到当没问题」。
 */
export interface ColdVerifySources {
  /** PR 此刻的头（状态贴它）、diff 的基线、分支名；body 是 PR 正文（给了就放进验收材料，决定 0093）。 */
  pr(prNumber: number): Promise<{ head: string; baseSha: string; branch: string; body?: string }>;
  /** diff 原文 + 改了哪些文件。 */
  diff(args: { prNumber: number; baseSha: string }): Promise<{ diffText: string; changedFiles: string[] }>;
  /** 单子：是哪张、「要什么 / 怎么算做完」。 */
  spec(prNumber: number): Promise<ColdVerifySpec>;
  /** 写过这张单的所有族（0006：全部跳过再选）。读不到就是没查成（抛），不许猜成某一族；空表也算读不到。 */
  authorFamilies(prNumber: number): Promise<string[]>;
}

export interface ColdVerifyDeps {
  sources: ColdVerifySources;
  /** 跑一轮（生产是 invokeVerifier 本体；测试给 fake，不起真进程）。 */
  invoke: (input: VerifierInvokeInput, deps: ColdVerifyInvokeDeps) => Promise<VerifierInvokeOutput>;
  /** 冷调用要的依赖（one-shot 的 spawner / runs 记账等），由调用方装配好传进来。 */
  oneShot: OneShotDeps;
  /** 按族挑模型（生产给 cold-verify-pick.ts 的 familyPickerFrom(...) 那一份；测试给 fake）。 */
  chooseModelForFamily: ChooseModelForFamily;
  /** 会话 cwd（调用方为这张 PR 准备的目录）。给了 prepareCwd 就不用它。 */
  cwd: string;
  /** 挑中谁之后、起会话之前，为它备工作目录（目录要归那条路由的会话用户）；透传给 invokeVerifier。 */
  prepareCwd?: NonNullable<VerifierInvokeDeps['prepareCwd']>;
  /** 贴状态。给了才贴（不给 = 只跑不贴，测试/演练用）。 */
  writeStatus?: WriteColdVerifyStatus;
  /**
   * 这个 PR 上最后贴成功的状态的记忆（#2007，调用方持有、跨圈保留，不写库）。给了就：一模一样的状态不再贴；
   * 「跑着」推迟到真挑中路由、要起会话时才贴。不给 = 老样子（每圈先贴「跑着」，来什么贴什么）。
   */
  statusMemo?: ColdVerifyStatusMemo;
  /** 这是第几轮（默认 1）；上限由调用方判（canStartRound），这一层照给的值跑。 */
  round?: 1 | 2;
  /** 超时（分钟），透传给 one-shot。 */
  timeoutMinutes?: number;
  /**
   * 这一次的结局是不是「过一会儿再来就行」（比如内存放不下、会话没派出去）：回一句白话原因＝是。
   * 是的话这一层不贴 failure（那会让合并闸和 PR 页面显示成验收没过），贴一条 pending 写明在等什么，并把原因放在返回的 wait 里。
   */
  waitReason?: (verdict: VerifierInvokeOutput) => string | undefined;
}

/** 交给 `invoke` 的那一份：就是 invokeVerifier 的依赖（cwd 在 ColdVerifyDeps 上给，这里原样带过去）。 */
export type ColdVerifyInvokeDeps = VerifierInvokeDeps;

export interface ColdVerifyRunResult {
  /** 贴在头上了的那条状态（没给 writeStatus 时照样有，调用方自己报）。 */
  status: ColdVerifyStatus;
  /** 贴上了的那个头；连 PR 都没读到就是 null（没处贴）。 */
  head: string | null;
  /** 取三样时哪一步没成（有它就是「没验成」那一档，status 一定是 failure）。 */
  sourceProblem?: string;
  /** 真起了冷调用就有它。 */
  verdict?: VerifierInvokeOutput;
  /** 这一次没做成但过一会儿再来就行（waitReason 认出的）：status 是 pending，不是 failure，也不是 sourceProblem。 */
  wait?: string;
}

/**
 * 跑一个 PR 的验收那一遍。
 *
 * 返回里 `status` 是 success、failure，或者（只有 waitReason 认出「过一会儿再来」时）pending：这一层不会「什么都不回」，
 * 也不会把「没查成」漏成 success。
 */
export async function runColdVerifyForPr(
  prNumber: number,
  deps: ColdVerifyDeps,
): Promise<ColdVerifyRunResult> {
  const round = deps.round ?? 1;
  const memo = deps.statusMemo;
  // 贴一条状态；和这个头上最后贴成功的那条一模一样就不再贴（#2007）。贴失败照旧抛，记忆不更新（下一圈照贴）。
  const put = async (head: string, status: ColdVerifyStatus): Promise<void> => {
    if (deps.writeStatus === undefined) return;
    const last = memo?.get(head);
    if (last !== undefined && sameStatus(last, status)) return;
    await deps.writeStatus({ prNumber, head, status });
    memo?.set(head, status);
  };
  const post = async (
    head: string | null,
    status: ColdVerifyStatus,
    rest: Omit<ColdVerifyRunResult, 'status' | 'head'> = {},
  ): Promise<ColdVerifyRunResult> => {
    if (head !== null) await put(head, status);
    return { status, head, ...rest };
  };

  // 1. 取 PR（头、基线、分支）。读不到 = 没验成，照样贴（贴不上就算了：连头都没有）。
  let pr: { head: string; baseSha: string; branch: string; body?: string };
  try {
    pr = await deps.sources.pr(prNumber);
  } catch (err) {
    const why = errMessage(err);
    const status = coldVerifyNotRun(`读不到 PR #${prNumber} 现在的样子（${why}）`);
    return await post(null, status, { sourceProblem: `读不到 PR：${why}` });
  }

  // 开跑之前先贴 pending：合并闸显示「等验收」而不是「还没验」；贴不上（没权限、GitHub 不通）就在这里抛出去，
  // 别先花一次模型调用、跑完了结论又贴不上。
  // 给了记忆（#2007，生产的路）：「跑着」推迟到真挑中路由、马上要起会话的那一刻再贴（下面包的 chooseModelForFamily）。
  // 还是先于任何一次模型调用，「贴不上就别先花一次模型调用」的意图不变；但没路由的那些圈（总开关关着、选路在等）
  // 不再每圈先贴「跑着」再贴「在等」、来回改写同一条状态、每次都触发一轮合并闸。没给记忆（老调用方、测试）= 老样子，先贴。
  const running = coldVerifyPending(round);
  let runningPosted = memo === undefined;
  if (runningPosted) await put(pr.head, running);
  const chooseModelForFamily: ChooseModelForFamily = async (family) => {
    const picked = await deps.chooseModelForFamily(family);
    if (!runningPosted && picked !== undefined && 'modelId' in picked) {
      runningPosted = true;
      await put(pr.head, running);
    }
    return picked;
  };

  // 2. 取单子（要什么 / 怎么算做完 / 作者族）。读不到也贴 failure。
  let spec: ColdVerifySpec;
  let authorFamilies: string[];
  try {
    spec = await deps.sources.spec(prNumber);
    authorFamilies = await deps.sources.authorFamilies(prNumber);
  } catch (err) {
    const why = errMessage(err);
    const status = coldVerifyNotRun(`读不到 PR #${prNumber} 的单子（要什么 / 怎么算做完 / 作者族）：${why}`);
    return await post(pr.head, status, { sourceProblem: `读不到单子：${why}` });
  }

  // 认得 = 0006 的验收族（FAMILY_ORDER，进避让名单）+ 目录里别的真实存在的族（glm、gemini、muse，不进避让：
  // 验收人只从 FAMILY_ORDER 里挑，必然和它们不同族）。cursor（背后是哪家不知道）、unclassified、jev 不算认得。
  const known = new Set<string>(FAMILY_ORDER);
  const authorOnly = new Set<string>(
    CATALOG_NAMED_FAMILIES.filter((f) => !known.has(f) && !UNVERIFIABLE_AUTHOR_FAMILIES.has(f)),
  );
  const avoid: ModelFamily[] = [];
  const unknown: string[] = [];
  const otherAuthors: string[] = [];
  for (const raw of authorFamilies) {
    const family = raw.trim().toLowerCase();
    if (known.has(family)) {
      if (!avoid.includes(family as ModelFamily)) avoid.push(family as ModelFamily);
    } else if (authorOnly.has(family)) {
      if (!otherAuthors.includes(family)) otherAuthors.push(family);
    } else unknown.push(raw);
  }
  // 认不出、或一个都没有：不停下，改成两家都验（两个不同的族各验一遍，都过才算过；verifier-invoke 的 requireTwoFamilies）。
  const requireTwoFamilies = unknown.length > 0 || avoid.length + otherAuthors.length === 0;

  // 3. 起一次冷调用。diff / specDir 都注入进去（verifier-invoke 不自己调 git）。
  // 点名但没改的文件在这里读：引擎镜像里 PR 头上的内容。读失败留在提示词里，不从这一层抛出去。
  const input: VerifierInvokeInput = {
    prNumber,
    branch: pr.branch,
    baseSha: pr.baseSha,
    headSha: pr.head,
    taskId: spec.taskId,
    issueNumber: spec.issueNumber,
    ...(spec.workflowId !== undefined ? { workflowId: spec.workflowId } : {}),
    what: spec.what,
    howToFinish: spec.howToFinish,
    modelFamiliesAvoid: avoid,
    ...(otherAuthors.length > 0 ? { otherAuthorFamilies: otherAuthors } : {}),
    round,
    ...(requireTwoFamilies ? { requireTwoFamilies: true } : {}),
    ...(pr.body !== undefined && pr.body.trim() !== '' ? { prBody: pr.body } : {}),
    ...(spec.testOutput !== undefined && spec.testOutput.trim() !== ''
      ? { testOutput: spec.testOutput }
      : {}),
    ...(spec.recheck !== undefined ? { recheck: spec.recheck } : {}),
  };
  const invokeDeps: ColdVerifyInvokeDeps = {
    oneShot: deps.oneShot,
    fetchDiff: async ({ baseSha }) => deps.sources.diff({ prNumber, baseSha }),
    fetchSpec: async () => ({ ...(spec.specDir !== undefined ? { specDir: spec.specDir } : {}) }),
    fetchNamedFiles: readNamedFilesAtHead({ head: pr.head, workflowId: spec.workflowId }),
    chooseModelForFamily,
    cwd: deps.cwd,
    ...(deps.prepareCwd === undefined ? {} : { prepareCwd: deps.prepareCwd }),
    ...(deps.timeoutMinutes === undefined ? {} : { timeoutMinutes: deps.timeoutMinutes }),
  };

  let verdict: VerifierInvokeOutput;
  try {
    verdict = await deps.invoke(input, invokeDeps);
  } catch (err) {
    const why = errMessage(err);
    const status = coldVerifyNotRun(`冷调用这一次没跑起来（${why}）`);
    return await post(pr.head, status, { sourceProblem: `起调用失败：${why}` });
  }

  // 过一会儿再来就行的（内存放不下没派出去之类）：贴 pending 写明在等什么，不贴 failure。
  const wait = deps.waitReason?.(verdict);
  if (wait !== undefined) {
    return await post(pr.head, coldVerifyWaiting(wait), { verdict, wait });
  }

  // 4. 翻成状态、贴上（pass 才是 success；其余一律 failure）。
  const status = coldVerifyStatus(verdict);
  const failure = verdict.problems.find((p) => p.trim() !== '');
  const sourceProblem = status.state === 'failure' && isSourceProblem(failure) ? failure : undefined;
  return await post(pr.head, status, {
    verdict,
    ...(sourceProblem === undefined ? {} : { sourceProblem }),
  });
}

/**
 * 「没验成」（读不到三样里的某一样 / 没家族可挑）和「验了但没过」是两档：合并闸只看得到状态、看不出这两者的区别，
 * 但**报给人看的地方**必须分得清——前者要人查管子，后者要人改代码。判法用 verifier-invoke 自己写的那几个前缀
 * （它那几条明确失败的 problems 都以这几个词开头，见 verifier-invoke.ts 顶部注释）。
 */
// 「这会儿验不了：」是一个模型都派不出（#1731）：生产的 waitReason 认它回等待；没接 waitReason 的调用方也不能当成「没过」去返工
const SOURCE_PREFIXES = [
  '读不到 diff：',
  '读不到单子：',
  '没讨论成：',
  '冷调用没跑成：',
  '这会儿验不了：',
] as const;

const SHA40 = /^[0-9a-f]{40}$/i;
/** 镜像目录名只收这种段：工作流编号拆出来的 owner/name 若是 `..` 就不能拿去拼路径。 */
const MIRROR_SEGMENT = /^[A-Za-z0-9._-]+$/;

interface GitText {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** 读镜像时不带令牌、不读用户的 git 配置。safe.directory 放开：镜像有时属另一个系统用户，只读 cat-file。 */
function gitReadEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function runGit(cwd: string, args: string[], timeout = 15_000): Promise<GitText> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'safe.directory=*', '-c', 'core.quotePath=false', ...args],
      {
        cwd,
        encoding: 'buffer',
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: gitReadEnv(),
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
        const errText = errBuf.toString('utf8');
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        const extra = error !== null && errText.trim() === '' ? error.message : '';
        resolve({ code, stdout: out, stderr: extra === '' ? errText : `${errText}\n${extra}` });
      },
    );
  });
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '没有原因';
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function classifyShowFailure(stderr: string): { kind: 'missing' } | { kind: 'unreadable'; reason: string } {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/maxBuffer/i.test(text)) return { kind: 'unreadable', reason: '文件太大，读的时候超了上限' };
  if (/does not exist in|exists on disk, but not in/i.test(text)) return { kind: 'missing' };
  if (/invalid object name|bad object|not a valid object name|ambiguous argument/i.test(text)) {
    return { kind: 'unreadable', reason: '镜像里没有这个提交' };
  }
  if (/not a git repository|dubious ownership|detected dubious/i.test(text)) {
    return { kind: 'unreadable', reason: '引擎镜像读不了' };
  }
  return { kind: 'unreadable', reason: oneLine(text) };
}

/**
 * 引擎镜像的裸仓：`<FLEET_GITHUB_STATE_DIR>/mirrors/<owner>/<name>.git`（和 github 包的 mirrorPath 同一条路径）。
 * 对不上就带回原因，不抛。
 */
function mirrorDir(
  workflowId: string | undefined,
): { ok: true; dir: string } | { ok: false; reason: string } {
  if (workflowId === undefined || workflowId.trim() === '') {
    return { ok: false, reason: '没有工作流编号，对不上引擎镜像' };
  }
  const parsed = parseTaskWorkflowId(workflowId);
  if (parsed === null) return { ok: false, reason: '工作流编号对不上仓，没有引擎镜像可查' };
  const { owner, name } = parsed.repo;
  if (
    !MIRROR_SEGMENT.test(owner) ||
    !MIRROR_SEGMENT.test(name) ||
    owner === '.' ||
    owner === '..' ||
    name === '.' ||
    name === '..'
  ) {
    return { ok: false, reason: '工作流编号里的仓名不合规，没有拿去对镜像' };
  }
  const state = process.env.FLEET_GITHUB_STATE_DIR?.trim() || '/var/lib/fleet-dao/github';
  return { ok: true, dir: join(state, 'mirrors', owner.toLowerCase(), `${name.toLowerCase()}.git`) };
}

async function readOne(mirror: string, head: string, path: string): Promise<NamedHeadFile> {
  if (!isNamedRepoPath(path)) return { path, kind: 'unreadable', reason: '路径不合规，没有拿去读' };
  const rev = `${head}:${path}`;
  const typed = await runGit(mirror, ['cat-file', '-t', rev]);
  if (typed.code !== 0) {
    const why = classifyShowFailure(typed.stderr);
    return why.kind === 'missing'
      ? { path, kind: 'missing' }
      : { path, kind: 'unreadable', reason: why.reason };
  }
  const type = typed.stdout.toString('utf8').trim();
  if (type === 'tree') return { path, kind: 'unreadable', reason: '这个路径是目录，不是文件' };
  if (type !== 'blob') return { path, kind: 'unreadable', reason: `不是普通文件（${oneLine(type)}）` };
  const blob = await runGit(mirror, ['cat-file', '-p', rev]);
  if (blob.code !== 0) {
    const why = classifyShowFailure(blob.stderr);
    return why.kind === 'missing'
      ? { path, kind: 'missing' }
      : { path, kind: 'unreadable', reason: why.reason };
  }
  if (blob.stdout.includes(0)) return { path, kind: 'unreadable', reason: '不是文本文件' };
  return { path, kind: 'content', content: blob.stdout.toString('utf8') };
}

/**
 * 生产用的读取：引擎镜像里、PR 头提交上的文件。推分支时对象进过镜像，这里只读、不再抓远端。
 * 任何一个路径失败都变成「读不到」，整份函数不抛。
 */
function readNamedFilesAtHead(args: { head: string; workflowId: string | undefined }): FetchNamedFiles {
  return async (paths) => {
    const head = args.head.trim();
    if (!SHA40.test(head)) {
      return paths.map((path) => ({ path, kind: 'unreadable' as const, reason: 'PR 的头不是完整的提交号' }));
    }
    const mirror = mirrorDir(args.workflowId);
    if (!mirror.ok) {
      return paths.map((path) => ({ path, kind: 'unreadable' as const, reason: mirror.reason }));
    }
    if (!existsSync(mirror.dir)) {
      return paths.map((path) => ({
        path,
        kind: 'unreadable' as const,
        reason: '引擎镜像里没有这个仓，读不了 PR 头上的文件',
      }));
    }
    const out: NamedHeadFile[] = [];
    for (const path of paths) {
      try {
        out.push(await readOne(mirror.dir, head, path));
      } catch (err) {
        out.push({ path, kind: 'unreadable', reason: oneLine(errMessage(err)) });
      }
    }
    return out;
  };
}

/**
 * 第 2 轮的增量 diff：镜像里 `since..head`（上一轮验收的头到现在的头）。
 * 读不到抛错，调用方写成「读不到 diff」，不许退回整张 PR 的 diff 再从头判一遍。
 */
export async function incrementalDiffAtHead(args: {
  workflowId: string | undefined;
  sinceSha: string;
  headSha: string;
}): Promise<{ diffText: string; changedFiles: string[] }> {
  if (!SHA40.test(args.sinceSha) || !SHA40.test(args.headSha)) {
    throw new Error('增量 diff 的两头要是完整提交号');
  }
  const mirror = mirrorDir(args.workflowId);
  if (!mirror.ok) throw new Error(mirror.reason);
  if (!existsSync(mirror.dir)) throw new Error('引擎镜像里没有这个仓，读不了增量 diff');
  const range = `${args.sinceSha}..${args.headSha}`;
  const names = await runGit(mirror.dir, ['diff', '--name-only', '--no-ext-diff', range]);
  if (names.code !== 0) throw new Error(`读不到增量 diff：${oneLine(names.stderr)}`);
  const patch = await runGit(mirror.dir, ['diff', '--no-color', '--no-ext-diff', range]);
  if (patch.code !== 0) throw new Error(`读不到增量 diff：${oneLine(patch.stderr)}`);
  const changedFiles = names.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return { diffText: patch.stdout.toString('utf8'), changedFiles };
}

/**
 * 完整检出是在哪一步没成的（#3036）：头不合规、对不上 / 没有镜像、建目录、git archive、解包；别的（换进来的 checkout 抛的）是 unknown。
 * 报警照这一步写原因和建议：只有 EACCES 才是「目录权限」，缺对象不能修成 chmod。
 */
export type CheckoutStage = 'fetch' | 'head' | 'mirror' | 'mkdir' | 'archive' | 'extract' | 'unknown';

/** checkoutPrHead 抛的错：带失败那一步、原始错误（message 原样）、errno（有才有），archive 那步还带镜像目录和是不是缺对象。 */
export class CheckoutStageError extends Error {
  readonly stage: CheckoutStage;
  readonly code: string | undefined;
  readonly mirrorDir: string | undefined;
  readonly missingObject: boolean;

  constructor(
    stage: CheckoutStage,
    message: string,
    extra: { code?: string; mirrorDir?: string; missingObject?: boolean; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'CheckoutStageError';
    this.stage = stage;
    this.code = extra.code;
    this.mirrorDir = extra.mirrorDir;
    this.missingObject = extra.missingObject ?? false;
  }
}

/** git archive 的 stderr 是「镜像里没有这个对象」：not a tree object、bad object、认不出的 revision。 */
const MISSING_OBJECT =
  /not a tree object|bad object|not a valid object name|invalid object name|unknown revision|bad revision|missing (blob|tree|commit)/i;

/**
 * 把 PR 头的完整检出放进目录（git archive，不带 .git）。镜像没有、提交不在就抛 CheckoutStageError（写明哪一步），
 * 调用方自己决定要不要因此停下。
 */
export async function checkoutPrHead(
  dir: string,
  head: string,
  workflowId: string | undefined,
): Promise<void> {
  if (!SHA40.test(head)) throw new CheckoutStageError('head', 'PR 的头不是完整的提交号');
  const mirror = mirrorDir(workflowId);
  if (!mirror.ok) throw new CheckoutStageError('mirror', mirror.reason);
  if (!existsSync(mirror.dir)) {
    throw new CheckoutStageError('mirror', '引擎镜像里没有这个仓，放不了 PR 头的完整检出', {
      mirrorDir: mirror.dir,
    });
  }
  const scratch = await (async () => {
    try {
      await mkdir(dir, { recursive: true });
      return await mkdtemp(join(tmpdir(), 'fleet-verify-head-'));
    } catch (error) {
      const code = errnoOf(error);
      throw new CheckoutStageError('mkdir', errMessage(error), {
        ...(code === undefined ? {} : { code }),
        cause: error,
      });
    }
  })();
  const tarPath = join(scratch, 'head.tar');
  try {
    const archived = await runGit(mirror.dir, ['archive', '--format=tar', '-o', tarPath, head], 120_000);
    if (archived.code !== 0) {
      throw new CheckoutStageError('archive', oneLine(archived.stderr), {
        mirrorDir: mirror.dir,
        missingObject: MISSING_OBJECT.test(archived.stderr),
      });
    }
    const extractDir = resolve(dir);
    await new Promise<void>((resolve, reject) => {
      // scratch 是本次 mkdtemp 建的私有目录；相对归档名避免 GNU tar 把 Windows 盘符当远端主机。
      execFile(
        'tar',
        [
          '-xf',
          'head.tar',
          '-C',
          process.platform === 'win32' ? extractDir.replaceAll('\\', '/') : extractDir,
        ],
        { cwd: scratch, timeout: 120_000 },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const why = typeof stderr === 'string' && stderr.trim() !== '' ? oneLine(stderr) : errMessage(err);
          const code = errnoOf(err);
          reject(
            new CheckoutStageError('extract', why, { ...(code === undefined ? {} : { code }), cause: err }),
          );
        },
      );
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** 日志里这一句表示没放进完整检出，会话只看提示词里的材料。 */
export const VERIFY_CHECKOUT_FALLBACK = '验收会话没有放进 PR 头的完整检出（仍可看提示词里的材料）';

/**
 * 驾驶舱报警。键按检出目标（工作流编号；没有才按头）各一条：A 目标的故障不会被 B 目标的成功撤掉。
 * 正文写明失败那一步、目标 head、目录、原始错误和对应这一步的建议。
 */
export interface CheckoutBlockedAlert {
  dedupeKey: string;
  level: 'alert';
  taskId: null;
  title: string;
  body: string;
  stage: CheckoutStage;
}

/** 检出报警的键前缀。老的全局键 `cold-verify:checkout-dir` 不带目标，认不出是谁的，这里不再写、也不替它撤。 */
export const CHECKOUT_ALERT_PREFIX = 'cold-verify:checkout:';

/** 这个检出目标的报警键：同一工作流（同一张单的 PR）一条，换了头的成功也算这张单好了；没有工作流编号才按头分。 */
export function checkoutAlertKey(workflowId: string | undefined, head: string): string {
  const flow = workflowId?.trim();
  if (flow !== undefined && flow !== '') return `${CHECKOUT_ALERT_PREFIX}${flow}`;
  return `${CHECKOUT_ALERT_PREFIX}head:${oneLine(head).slice(0, 64)}`;
}

const STAGE_LABEL: Record<CheckoutStage, string> = {
  fetch: '获取待验精确头',
  head: '核对 PR 头',
  mirror: '找引擎镜像',
  mkdir: '建检出目录',
  archive: '从镜像 git archive',
  extract: '解包到检出目录',
  unknown: '没认出是哪一步',
};

export interface CheckoutBlockedInput {
  dir: string;
  head: string;
  workflowId: string | undefined;
  /** 检出抛的原错（CheckoutStageError 带失败那一步；别的算 unknown）。 */
  error: unknown;
  /** EACCES 时既有修复（ensure-tmp）本身没成的原因。 */
  repairError?: unknown;
}

function stageOf(error: unknown): CheckoutStage {
  return error instanceof CheckoutStageError ? error.stage : 'unknown';
}

function adviceFor(input: CheckoutBlockedInput, stage: CheckoutStage): string {
  const { error, dir, head } = input;
  const mirror = error instanceof CheckoutStageError ? error.mirrorDir : undefined;
  if (errnoOf(error) === 'EACCES') {
    const repaired =
      input.repairError === undefined ? '' : `既有修复（ensure-tmp）没成：${errMessage(input.repairError)}。`;
    return `${repaired}引擎用户要能在这一层下面 mkdir（${dir} 的上一层）。`;
  }
  if (error instanceof CheckoutStageError && error.missingObject) {
    return (
      `引擎镜像 ${mirror ?? '（没有镜像路径）'} 里取不出目标 head ${head}（git archive 认不出这个对象）。` +
      `请检查镜像里有没有这个提交，按既定 head 把它 fetch 进镜像后再验。这不是目录权限问题，别改属主或权限；引擎不自动重试。`
    );
  }
  switch (stage) {
    case 'head':
      return `PR 头 ${head} 不是完整提交号，查读 PR 的那一步。`;
    case 'mirror':
      return `对不上或没有引擎镜像${mirror === undefined ? '' : `（${mirror}）`}，查工作流编号和镜像目录。`;
    case 'mkdir':
      return `建 ${dir} 没成（不是权限问题），查磁盘和路径。`;
    case 'archive':
      return `镜像 ${mirror ?? '（没有镜像路径）'} 上 git archive 没成，查镜像本身是否完好。`;
    case 'extract':
      return `解包到 ${dir} 没成，查磁盘空间和目录。`;
    default:
      return '原始错误原样附上，按它查。';
  }
}

export function checkoutBlockedAlert(input: CheckoutBlockedInput): CheckoutBlockedAlert {
  const stage = stageOf(input.error);
  const code = errnoOf(input.error);
  const target = input.workflowId?.trim() ? input.workflowId.trim() : '（没有工作流编号）';
  return {
    dedupeKey: checkoutAlertKey(input.workflowId, input.head),
    level: 'alert',
    taskId: null,
    title: `冷验收放不进 PR 头的完整检出（${STAGE_LABEL[stage]}）`,
    body:
      `目标 ${target} 的 head ${input.head}，目录 ${input.dir}。` +
      `失败在「${STAGE_LABEL[stage]}」这一步${code === undefined ? '' : `（${code}）`}，原始错误：${errMessage(input.error)}。` +
      adviceFor(input, stage),
    stage,
  };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 这个目标真放进了完整检出：交给撤卡端口。startedAt 是这一次开跑的时刻，只证明它之前报的故障好了。 */
export interface CheckoutRecovered {
  dedupeKey: string;
  startedAt: Date;
  dir: string;
  head: string;
  workflowId: string | undefined;
}

/** 每次物理检出的独立成功证据；重送同一 receiptId 幂等，重做检出生成新 ID。 */
export interface CheckoutReceipt {
  receiptId: string;
  taskId?: string | undefined;
  runId?: string | undefined;
  workflowId: string | undefined;
  head: string;
  dir: string;
  startedAt: Date;
  completedAt: Date;
  type: 'full';
}

export interface PlaceVerifyCheckoutInput {
  taskId?: string | undefined;
  runId?: string | undefined;
  /** 独立于撤卡；写失败只诊断，证据保持未知，不改变验收。 */
  onCompleted?: (receipt: CheckoutReceipt) => Promise<void>;
  /** 生产经受管镜像的凭据和锁补齐既定头；失败保持 blocked，绝不改用分支最新头。 */
  ensureHead?: () => Promise<void>;
  signal?: AbortSignal;
  dir: string;
  head: string;
  workflowId: string | undefined;
  /** 不给就用 checkoutPrHead。测试换成先抛 EACCES、修好再真检出。 */
  checkout?: (dir: string, head: string, workflowId: string | undefined) => Promise<void>;
  /**
   * 检出是 EACCES 时先调一次（生产：sudo fleet-agent-scope ensure-tmp，把 _tmp 改回引擎用户）。
   * 不给就直接走退路。别的错（缺镜像、缺对象、解包失败）不修、不重试。
   */
  repair?: (dir: string) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 退路：除了日志，把失败那一步和目录写进这个目标的报警。写不进只记日志，不让验收因此停。 */
  onBlocked?: (alert: CheckoutBlockedAlert) => Promise<void>;
  /**
   * 真放进了完整检出：撤这个目标在 startedAt 之前报的检出报警（之后又报的是新故障，端口不许撤）。
   * 撤不成只记日志，不当成已恢复，也不让验收停。
   */
  onRecovered?: (recovered: CheckoutRecovered) => Promise<void>;
  /** 测试用。 */
  now?: () => Date;
}

/**
 * 把 PR 头的完整检出放进 dir。检出 EACCES（_tmp 是 root:root 755）时先 repair 再试一次，别的错不修不重试。
 * 成功回 full，并 onRecovered 撤这个目标的旧报警。仍放不进回 blocked：记 VERIFY_CHECKOUT_FALLBACK，并 onBlocked。
 * 只说检出放没放进，不碰验收结论。
 */
export async function placeVerifyCheckout(input: PlaceVerifyCheckoutInput): Promise<'full' | 'blocked'> {
  const checkout = input.checkout ?? checkoutPrHead;
  const log = input.log ?? (() => undefined);
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const receiptId = randomUUID();
  const dedupeKey = checkoutAlertKey(input.workflowId, input.head);
  const blocked = async (error: unknown, repairError?: unknown): Promise<'blocked'> => {
    const alert = checkoutBlockedAlert({
      dir: input.dir,
      head: input.head,
      workflowId: input.workflowId,
      error,
      ...(repairError === undefined ? {} : { repairError }),
    });
    log(VERIFY_CHECKOUT_FALLBACK, {
      error: errMessage(error),
      stage: alert.stage,
      dir: input.dir,
      head: input.head,
      ...(repairError === undefined ? {} : { repairError: errMessage(repairError) }),
    });
    if (input.onBlocked) {
      try {
        await input.onBlocked(alert);
      } catch (alertError) {
        log('冷验收检出目录的报警没写进库', { dir: input.dir, error: errMessage(alertError) });
      }
    }
    return 'blocked';
  };
  const full = async (): Promise<'full'> => {
    const receipt: CheckoutReceipt = {
      receiptId,
      taskId: input.taskId,
      runId: input.runId,
      workflowId: input.workflowId,
      head: input.head,
      dir: input.dir,
      startedAt,
      completedAt: now(),
      type: 'full',
    };
    if (input.onCompleted) {
      try {
        await input.onCompleted(receipt);
      } catch (error) {
        log('冷验收完整检出成功回执没写进库（证据未知）', {
          ...receipt,
          error: errMessage(error),
        });
      }
    }
    if (input.onRecovered) {
      try {
        await input.onRecovered({
          dedupeKey,
          startedAt,
          dir: input.dir,
          head: input.head,
          workflowId: input.workflowId,
        });
      } catch (resolveError) {
        log('冷验收检出放进去了，但这个目标的旧检出报警没撤成（报警留着）', {
          dedupeKey,
          error: errMessage(resolveError),
        });
      }
    }
    return 'full';
  };
  try {
    input.signal?.throwIfAborted();
    await input.ensureHead?.().catch((error: unknown) => {
      throw new CheckoutStageError('fetch', errMessage(error), { cause: error });
    });
    input.signal?.throwIfAborted();
    await checkout(input.dir, input.head, input.workflowId);
  } catch (error) {
    input.signal?.throwIfAborted();
    if (errnoOf(error) !== 'EACCES' || input.repair === undefined) return blocked(error);
    try {
      await input.repair(input.dir);
    } catch (repairError) {
      input.signal?.throwIfAborted();
      return blocked(error, repairError);
    }
    try {
      input.signal?.throwIfAborted();
      await checkout(input.dir, input.head, input.workflowId);
    } catch (again) {
      input.signal?.throwIfAborted();
      return blocked(again);
    }
  }
  input.signal?.throwIfAborted();
  return full();
}

function isSourceProblem(problem: string | undefined): boolean {
  return problem !== undefined && SOURCE_PREFIXES.some((p) => problem.startsWith(p));
}

/** runs 记账的占位：调用方不给真 writer 时用（#556 接真表）。 */
export type ColdVerifyRuns = RunsWriter;
export type ColdVerifyRunRecord = RunRecord;
