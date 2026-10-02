// #555-2 的装配入口：把一个 PR 的「验收那一遍」跑完——取三样（diff、要什么、怎么算做完）→ 按 0006 换家族起一次
// 冷调用（#555-1 的 invokeVerifier）→ 把结论贴成 PR 当前头上的 cold-verify 状态（合并闸读的那条）。
//
// **为什么要有这一条**：#555-1 把冷调用做成了纯接口、555-2 把它接进合并闸；「谁在什么时候跑它、读不到时怎么办」
// 落不成代码的话，合并闸等的那条状态就永远没人写（闸判「还没验」，PR 一直卡着）。这一条就是那个「谁」：
// 三段的第三段在装配侧的真身，本机垫片 / 定时对账 / 以后会话交活都走它。
//
// **一条都不许悄悄过去**（通用段底线第三条，specs/555 第 4 条）：
// - 取三样里任何一样读不成（读 PR、读 diff、读单子、读作者族）→ 照样**贴** failure（cold-verify-post 那一层），
//   不贴 = 闸判「还没验」，和「没跑过」看不出来；
// - 挑不出家族、冷调用没跑成 → verifier-invoke 已经判 pass=false，这一层照 stress 贴 failure；
// - 贴状态本身失败 → ColdVerifyWriteError 抛出去，调用方按「没验成」处理，不吞。
//
// **不自己判「要不要验」**：那是合并闸按路径判的事（coldVerifyNeed，改到先审后合那片路径才要）。
// 这一层只要被调了就跑；谁调它、什么时候调，见调用方。重复贴同一条状态没有害处（同一 context 同一头只留最新一条），
// 所以「该验的没验」这件事由合并闸拦住、不由这一层猜。

import {
  type ColdVerifyStatus,
  coldVerifyNotRun,
  coldVerifyStatus,
  type WriteColdVerifyStatus,
} from './cold-verify-status.ts';
import type { RunRecord, RunsWriter } from './runner/not-wired.ts';
import type { OneShotDeps } from './runner/one-shot.ts';
import {
  type ChooseModelForFamily,
  FAMILY_ORDER,
  type FetchDiff,
  type FetchSpec,
  invokeVerifier,
  type VerifierInvokeInput,
  type VerifierInvokeOutput,
} from './verifier-invoke.ts';

/**
 * 这一次要的三样从哪来。**读不到一律抛**（顶层翻成 failure 状态）：返回 undefined / 空字符串当「没有」的写法
 * 在这一层是禁止的——那正是「拿不到当没问题」。
 */
export interface ColdVerifySources {
  /** PR 此刻的头（状态贴它）、diff 的基线、分支名。 */
  pr(prNumber: number): Promise<{ head: string; baseSha: string; branch: string }>;
  /** diff 原文 + 改了哪些文件。 */
  diff(args: { prNumber: number; baseSha: string }): Promise<{ diffText: string; changedFiles: string[] }>;
  /** 单子的「要什么 / 怎么算做完」+ 这单的 id（fetchSpec 照它找需求文档目录）。 */
  spec(prNumber: number): Promise<{ taskId: string; what: string; howToFinish: string[]; specDir?: string }>;
  /** 写这张单的族（0006：跳过它再选）。读不到就是没查成（抛），不许猜成某一族。 */
  authorFamily(prNumber: number): Promise<string>;
}

export interface ColdVerifyDeps {
  sources: ColdVerifySources;
  /** 跑一轮（生产是 invokeVerifier 本体；测试给 fake，不起真进程）。 */
  invoke: (input: VerifierInvokeInput, deps: ColdVerifyInvokeDeps) => Promise<VerifierInvokeOutput>;
  /** 冷调用要的依赖（one-shot 的 spawner / runs 记账等），由调用方装配好传进来。 */
  oneShot: OneShotDeps;
  /** 按族挑模型（生产给 cold-verify-pick.ts 的 familyPickerFrom(...) 那一份；测试给 fake）。 */
  chooseModelForFamily: ChooseModelForFamily;
  /** 会话 cwd（调用方为这张 PR 准备的工作树）。 */
  cwd: string;
  /** 贴状态。给了才贴（不给 = 只跑不贴，测试/演练用）。 */
  writeStatus?: WriteColdVerifyStatus;
  /** 这是第几轮（默认 1）；上限由调用方判（canStartRound），这一层照给的值跑。 */
  round?: 1 | 2;
  /** 超时（分钟），透传给 one-shot。 */
  timeoutMinutes?: number;
}

/** 交给 `invoke` 的那一份（生产是 invokeVerifier 的 deps 减去 cwd —— cwd 在 ColdVerifyDeps 上）。 */
export interface ColdVerifyInvokeDeps {
  oneShot: OneShotDeps;
  fetchDiff: FetchDiff;
  fetchSpec: FetchSpec;
  chooseModelForFamily: ChooseModelForFamily;
  cwd: string;
  timeoutMinutes?: number;
}

export interface ColdVerifyRunResult {
  /** 贴在头上了的那条状态（没给 writeStatus 时照样有，调用方自己报）。 */
  status: ColdVerifyStatus;
  /** 贴上了的那个头；连 PR 都没读到就是 null（没处贴）。 */
  head: string | null;
  /** 取三样时哪一步没成（有它就是「没验成」那一档，status 一定是 failure）。 */
  sourceProblem?: string;
  /** 真起了冷调用就有它。 */
  verdict?: VerifierInvokeOutput;
}

/**
 * 跑一个 PR 的验收那一遍。
 *
 * 返回里 `status` **一定**是 success 或 failure（pending 只在调用方自己先贴的时候用）：这一层不会「什么都不回」，
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

  // 2. 取单子（要什么 / 怎么算做完 / 作者族）。读不到也贴 failure。
  let spec: { taskId: string; what: string; howToFinish: string[]; specDir?: string };
  let familyAvoid: string;
  try {
    spec = await deps.sources.spec(prNumber);
    familyAvoid = await deps.sources.authorFamily(prNumber);
  } catch (err) {
    const why = message(err);
    const status = coldVerifyNotRun(`读不到 PR #${prNumber} 的单子（要什么 / 怎么算做完 / 作者族）：${why}`);
    return await post(pr.head, status, { sourceProblem: `读不到单子：${why}` });
  }

  // 作者族必须是我们认得的那几个之一：认不出就别验（认不出就挑不出「不同的族」，硬跑就是同族自审）。
  const avoid = FAMILY_ORDER.find((f) => f === familyAvoid.trim().toLowerCase());
  if (avoid === undefined) {
    const status = coldVerifyNotRun(
      `认不出 PR #${prNumber} 的作者族「${familyAvoid}」（0006 的族是 ${FAMILY_ORDER.join('、')}）：认不出就挑不出别家`,
    );
    return await post(pr.head, status, { sourceProblem: `作者族认不出：${familyAvoid}` });
  }

  // 3. 起一次冷调用。diff / specDir 都注入进去（verifier-invoke 不自己调 git）。
  const input: VerifierInvokeInput = {
    prNumber,
    branch: pr.branch,
    baseSha: pr.baseSha,
    taskId: spec.taskId,
    what: spec.what,
    howToFinish: spec.howToFinish,
    modelFamilyAvoid: avoid,
    round,
  };
  const invokeDeps: ColdVerifyInvokeDeps = {
    oneShot: deps.oneShot,
    fetchDiff: async ({ baseSha }) => deps.sources.diff({ prNumber, baseSha }),
    fetchSpec: async () => ({ ...(spec.specDir !== undefined ? { specDir: spec.specDir } : {}) }),
    chooseModelForFamily: deps.chooseModelForFamily,
    cwd: deps.cwd,
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
