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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_NAMED_FAMILIES } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import {
  type ColdVerifyStatus,
  coldVerifyNotRun,
  coldVerifyPending,
  coldVerifyStatus,
  coldVerifyWaiting,
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

/**
 * 目录里有、但不能当「认得的作者族」的：cursor（Cursor Auto 背后到底是哪家不知道，不能当成和验收人不同族）、
 * unclassified（拆不出的串）、jev（不是写代码的模型）。再加上拼写不认识的串，都按「认不出」停。
 */
const NOT_A_KNOWN_AUTHOR_FAMILY: ReadonlySet<string> = new Set(['cursor', 'unclassified', 'jev']);

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
}

/**
 * 这一次要的三样从哪来。**读不到一律抛**（顶层翻成 failure 状态）：返回 undefined / 空字符串当「没有」的写法
 * 在这一层是禁止的——那正是「拿不到当没问题」。
 */
export interface ColdVerifySources {
  /** PR 此刻的头（状态贴它）、diff 的基线、分支名。 */
  pr(prNumber: number): Promise<{ head: string; baseSha: string; branch: string }>;
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
  const post = async (
    head: string | null,
    status: ColdVerifyStatus,
    rest: Omit<ColdVerifyRunResult, 'status' | 'head'> = {},
  ): Promise<ColdVerifyRunResult> => {
    if (deps.writeStatus !== undefined && head !== null) {
      await deps.writeStatus({ prNumber, head, status });
    }
    return { status, head, ...rest };
  };

  // 1. 取 PR（头、基线、分支）。读不到 = 没验成，照样贴（贴不上就算了：连头都没有）。
  let pr: { head: string; baseSha: string; branch: string };
  try {
    pr = await deps.sources.pr(prNumber);
  } catch (err) {
    const why = errMessage(err);
    const status = coldVerifyNotRun(`读不到 PR #${prNumber} 现在的样子（${why}）`);
    return await post(null, status, { sourceProblem: `读不到 PR：${why}` });
  }

  // 开跑之前先贴 pending：合并闸显示「等验收」而不是「还没验」；贴不上（没权限、GitHub 不通）就在这里抛出去，
  // 别先花一次模型调用、跑完了结论又贴不上。
  if (deps.writeStatus !== undefined) {
    await deps.writeStatus({ prNumber, head: pr.head, status: coldVerifyPending(round) });
  }

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

  // 作者族必须个个都是我们认得的：认不出就挑不出「不同的族」，硬跑就可能是同族自审。一个都没有也一样。
  // 认得 = 0006 的验收族（FAMILY_ORDER，进避让名单）+ 目录里别的真实存在的族（glm、gemini、muse，不进避让：
  // 验收人只从 FAMILY_ORDER 里挑，必然和它们不同族）。cursor（背后是哪家不知道）、unclassified、jev 不算认得。
  const known = new Set<string>(FAMILY_ORDER);
  const authorOnly = new Set<string>(
    CATALOG_NAMED_FAMILIES.filter((f) => !known.has(f) && !NOT_A_KNOWN_AUTHOR_FAMILY.has(f)),
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
  if (avoid.length + otherAuthors.length === 0 || unknown.length > 0) {
    const status = coldVerifyNotRun(
      avoid.length + otherAuthors.length === 0 && unknown.length === 0
        ? `PR #${prNumber} 没有记下是哪一族写的：没法保证换了家族`
        : `认不出 PR #${prNumber} 的作者族「${unknown.join('、')}」（认得的是 0006 的 ${FAMILY_ORDER.join('、')}，加上目录里的 ${[...authorOnly].join('、')}）：认不出就挑不出别家`,
    );
    return await post(pr.head, status, {
      sourceProblem: `作者族认不出：${unknown.length > 0 ? unknown.join('、') : '没有记录'}`,
    });
  }

  // 3. 起一次冷调用。diff / specDir 都注入进去（verifier-invoke 不自己调 git）。
  // 点名但没改的文件在这里读：引擎镜像里 PR 头上的内容。读失败留在提示词里，不从这一层抛出去。
  const input: VerifierInvokeInput = {
    prNumber,
    branch: pr.branch,
    baseSha: pr.baseSha,
    taskId: spec.taskId,
    issueNumber: spec.issueNumber,
    ...(spec.workflowId !== undefined ? { workflowId: spec.workflowId } : {}),
    what: spec.what,
    howToFinish: spec.howToFinish,
    modelFamiliesAvoid: avoid,
    ...(otherAuthors.length > 0 ? { otherAuthorFamilies: otherAuthors } : {}),
    round,
  };
  const invokeDeps: ColdVerifyInvokeDeps = {
    oneShot: deps.oneShot,
    fetchDiff: async ({ baseSha }) => deps.sources.diff({ prNumber, baseSha }),
    fetchSpec: async () => ({ ...(spec.specDir !== undefined ? { specDir: spec.specDir } : {}) }),
    fetchNamedFiles: readNamedFilesAtHead({ head: pr.head, workflowId: spec.workflowId }),
    chooseModelForFamily: deps.chooseModelForFamily,
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
const SOURCE_PREFIXES = ['读不到 diff：', '读不到单子：', '没讨论成：', '冷调用没跑成：'] as const;

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

function runGit(cwd: string, args: string[]): Promise<GitText> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'safe.directory=*', '-c', 'core.quotePath=false', ...args],
      {
        cwd,
        encoding: 'buffer',
        timeout: 15_000,
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

function isSourceProblem(problem: string | undefined): boolean {
  return problem !== undefined && SOURCE_PREFIXES.some((p) => problem.startsWith(p));
}

/** runs 记账的占位：调用方不给真 writer 时用（#556 接真表）。 */
export type ColdVerifyRuns = RunsWriter;
export type ColdVerifyRunRecord = RunRecord;
