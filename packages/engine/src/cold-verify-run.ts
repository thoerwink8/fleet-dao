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
  type ModelFamily,
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
    const why = message(err);
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
    const why = message(err);
    const status = coldVerifyNotRun(`读不到 PR #${prNumber} 的单子（要什么 / 怎么算做完 / 作者族）：${why}`);
    return await post(pr.head, status, { sourceProblem: `读不到单子：${why}` });
  }

  // 作者族必须个个都是我们认得的：认不出就挑不出「不同的族」，硬跑就可能是同族自审。一个都没有也一样。
  const known = new Set<string>(FAMILY_ORDER);
  const avoid: ModelFamily[] = [];
  const unknown: string[] = [];
  for (const raw of authorFamilies) {
    const family = raw.trim().toLowerCase();
    if (known.has(family)) {
      if (!avoid.includes(family as ModelFamily)) avoid.push(family as ModelFamily);
    } else unknown.push(raw);
  }
  if (avoid.length === 0 || unknown.length > 0) {
    const status = coldVerifyNotRun(
      avoid.length === 0 && unknown.length === 0
        ? `PR #${prNumber} 没有记下是哪一族写的：没法保证换了家族`
        : `认不出 PR #${prNumber} 的作者族「${unknown.join('、')}」（0006 的族是 ${FAMILY_ORDER.join('、')}）：认不出就挑不出别家`,
    );
    return await post(pr.head, status, {
      sourceProblem: `作者族认不出：${unknown.length > 0 ? unknown.join('、') : '没有记录'}`,
    });
  }

  // 3. 起一次冷调用。diff / specDir 都注入进去（verifier-invoke 不自己调 git）。
  const input: VerifierInvokeInput = {
    prNumber,
    branch: pr.branch,
    baseSha: pr.baseSha,
    taskId: spec.taskId,
    issueNumber: spec.issueNumber,
    ...(spec.workflowId !== undefined ? { workflowId: spec.workflowId } : {}),
    what: spec.what,
    howToFinish: spec.howToFinish,
    modelFamiliesAvoid: avoid as [ModelFamily, ...ModelFamily[]],
    round,
  };
  const invokeDeps: ColdVerifyInvokeDeps = {
    oneShot: deps.oneShot,
    fetchDiff: async ({ baseSha }) => deps.sources.diff({ prNumber, baseSha }),
    fetchSpec: async () => ({ ...(spec.specDir !== undefined ? { specDir: spec.specDir } : {}) }),
    chooseModelForFamily: deps.chooseModelForFamily,
    cwd: deps.cwd,
    ...(deps.prepareCwd === undefined ? {} : { prepareCwd: deps.prepareCwd }),
    ...(deps.timeoutMinutes === undefined ? {} : { timeoutMinutes: deps.timeoutMinutes }),
  };

  let verdict: VerifierInvokeOutput;
  try {
    verdict = await deps.invoke(input, invokeDeps);
  } catch (err) {
    const why = message(err);
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

function isSourceProblem(problem: string | undefined): boolean {
  return problem !== undefined && SOURCE_PREFIXES.some((p) => problem.startsWith(p));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** runs 记账的占位：调用方不给真 writer 时用（#556 接真表）。 */
export type ColdVerifyRuns = RunsWriter;
export type ColdVerifyRunRecord = RunRecord;
