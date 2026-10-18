// #555-1 验收段冷调用的纯接口：喂 diff + 要什么 + 怎么算做完 → 起一次 one-shot 冷调用（换一个不同家族）→
// 回 pass/fail + 问题清单。
//
// **不走 Fusion**（docs/decisions/0010-three-segment-flow.md 已替掉 Fusion 流程）：本模块不被
// packages/engine/src/workflows/verify.ts 调；那一份是 Fusion 句号后留下的。本切片**新增**给 v3 验收段用。
//
// 三条硬约束（specs/555-验收/需求.md）：
// 1. **喂材料**：diff + 单子的「要什么」+「怎么算做完」，有就再加 PR 正文、引擎跑过的测试输出（决定 0093：没给 PR 正文
//    却判「PR 正文没写」是误判的来源）。diff 不由本模块自己拼 `git diff`——**注入**进来（FetchDiff / FetchSpec），
//    调用方（组装层）自己决定从哪读（GitHub、git 工作树、fake）。验收只判「怎么算做完」各条在材料里成不成立：
//    要 diff 以外证据（截图、现场、线上数据、审计结果）的条目回「不归我验」（outOfScope），不算没过，调用方转给人；
//    建议类意见（含验收条原文写明「不挡」的）放 suggestions，不挡。
//    只要求「测试/检查/构建/类型检查通过」的验收条归合并闸的 CI：不因测试输出里没出现它判不过
//    （写了「没跑」「跳过」也算没出现）；测试输出里明确写了失败才写成问题。
// 2. **换家族**：docs/decisions/0006-discussion-model-order.md 钉的顺序 gpt → grok → claude → deepseek → kimi；
//    modelFamiliesAvoid（写过这张单的所有族）要全部跳过。别家都挑不出 → 两家都验 → 只派得出一家就「同族兜底验」
//    （#1731：用挑出来的那一家起一次全新的冷会话，结论照常算）→ 一家都派不出就回等待。不许拿默认模型顶上、不许假装 pass。
// 3. **只有三种能挡**：没做到验收条 / 有证据弄坏原有功能 / 安全或丢数据（specs/555 第 3 条）。
//    模型提到的风格意见不算挡，从 problems 里滤掉、但不允许反过来把「算挡的」藏起来。
//
// 默认 1 轮、最多 2 轮（specs/555 第 3 条）：本模块只跑调用方指定的那一轮（input.round）；要不要起
// 第 2 轮、什么时候起，是调用方的事。
//
// 明确失败的路径（不许拿「查不到」当 pass，通用段底线第 3 条 + specs/555 第 4 条）：
// - 入参没单号、taskId 不是库里 tasks.id 的样子 → 一进来就抛（zod），不起会话：这一次验收记进 runs 要挂得上单（#216）
// - fetchDiff 抛错 / 返回空 diff / 返回空 changedFiles → problems: ['读不到 diff：…']、pass: false
// - fetchSpec 抛错 → problems: ['读不到单子：…']、pass: false
// - 单子点名、diff 没改的文件读不到或 fetchNamedFiles 抛错 → **不**走上面这条：提示词里标「读不到」，验收照常问模型。
//   缺的是核对材料，不是这次验收没跑起来（#1612：缺材料判负会逼写代码的会话来回改）
// - 没讨论成：只剩「要派的族有在等的（回 `{ wait }`）、又没有别家给出结论」这一种 → 不起会话，routeWait 写明在等谁，
//   调用方过一会儿重来（#1697）。两家都验只派得出一家不再算没讨论成，改走同族兜底验（#1731，notes 以「同族兜底验：」开头）。
// - 一个模型都派不出（每一族都回 undefined、也没有在等的）→ 不起会话，回 routeWait（families 为空，reason 写「一个模型都派不出，
//   过一会儿重来」），调用方过一会儿重来，不停下等人（#1731）
// - 会话没跑成（one-shot outcome 不是 done、结论行不是固定写法、结论写 fail 却没有一条属于三种能挡的问题）→ 不当场回失败：
//   先记下，换下一个候选（这一族的下一条路由，再下一族，顺序和挑族一样，最后是作者族的同族兜底验）。**只有全部候选都试过还没有
//   结论**，才回 problems: ['冷调用没跑成：试过的路由都没验成：…']、pass: false，列出每条路由和原因（#1731）
// - 会话失败且失败分流认成上游临时故障（规则表上标了 blip）→ problems 空、upstreamRetry，调用方等一会儿再验
// - 内存放不下没派出去（admission_blocked）、切号停下（org_switch）→ 照旧回这一次的结局，调用方认结局过一会儿重来
// - 结论写 pass 但问题清单里还有算挡的 → pass: false（自相矛盾的结论不放行）
// - 发版重启引擎（#2848）：deps.detach 给了，一家验的会话脱开引擎跑，引擎要走时交回 detached（不换候选、不算没过），
//   下一个引擎用 attachVerifier 接回、同一份判法读结论；没脱开的会话在引擎要走时（deps.released）没跑完、接回的会话没给出结论，
//   回 lostOnRelease（调用方重验一次）。

import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import { classifyFailure, isUpstreamBlip } from './failure/index.ts';
import { segmentEvidence } from './runner/evidence.ts';
import type { OneShotDeps, OneShotInput, OneShotResult } from './runner/one-shot.ts';
import { ONE_SHOT_OUTCOMES, OneShotDetached, runOneShot, sessionErrorTail } from './runner/one-shot.ts';
import type { SegmentVerdict } from './runner/verdict.ts';
import { judgeVerify } from './runner/verdict.ts';

/** 冷调用 #555-1 的模型家族顺序（docs/decisions/0006-discussion-model-order.md 第 2 条）。 */
export const FAMILY_ORDER = ['gpt', 'grok', 'claude', 'deepseek', 'kimi'] as const;
export type ModelFamily = (typeof FAMILY_ORDER)[number];

export const ModelFamilySchema = z.enum(FAMILY_ORDER);

/** 输入 zod：调用方现成算好的东西全在这里；diff / 要什么都不再自己翻。 */
export const VerifierInvokeInputSchema = z
  .object({
    /** 验哪张 PR（调用方必给；本模块不许替它从库里翻上一段的 PR# —— specs/509 第六节）。 */
    prNumber: z.number().int().positive(),
    /** PR 用的分支名；进 prompt 让模型能对得上号。 */
    branch: z.string().min(1),
    /** diff 的基线（base..？ = PR 引入的全部改动）。 */
    baseSha: z.string().min(7),
    /** 这张单在库里的 tasks.id：fetchSpec 照它找需求文档目录，这一次验收记进 runs 也挂在这张单上（#216）。 */
    taskId: z.guid(),
    /** 单号（GitHub issue #）：记进 runs 的这一笔要挂得上单（#216），没有就不起会话。 */
    issueNumber: z.number().int().positive(),
    /** 这张单的任务工作流编号（taskWorkflowId），一起记进 runs；不在任务工作流里验的不给。 */
    workflowId: z.string().min(1).optional(),
    /** 「要什么」原文（需求文档里的「## 场景 / 需求」段；冷调用模型要照它核）。 */
    what: z.string().min(1),
    /** 「怎么算做完」逐条原文。 */
    howToFinish: z.array(z.string().min(1)).min(1),
    /**
     * 写过这张单的、在 FAMILY_ORDER 里的族（0006：全部要跳过再选）。和下面的 otherAuthorFamilies 合起来至少一个：
     * 一个都没有就不知道该避开谁，没法保证换了家族。
     * 一张单换过路由（先 Claude 写、后来换 GPT 写）时两族都在里面：只避开最后一个，验收的可能正是前一轮的作者。
     */
    modelFamiliesAvoid: z.array(ModelFamilySchema),
    /**
     * 写过这张单、但不在 FAMILY_ORDER 里的族（目录里认得的 glm、gemini、muse）：它们不是验收候选，验收人从 FAMILY_ORDER 里挑，
     * 必然和它们不同族，所以不进 modelFamiliesAvoid。只用来证明「作者是谁」是知道的：和 modelFamiliesAvoid 合起来至少一个。
     */
    otherAuthorFamilies: z.array(z.string().min(1)).optional(),
    /** 这是第几轮：默认 1 轮、最多 2 轮（specs/555 第 3 条）；本模块不判上限，只透传。 */
    round: z.union([z.literal(1), z.literal(2)]),
    /** 这一笔验收属于第几个回合（task_rounds.seq，#3140，只记账：runs.round_seq）；不在任务工作流里验的、老历史不给。 */
    roundSeq: z.number().int().positive().optional(),
    /**
     * 第 2 轮复核（工作流在 patched('verify-recheck') 下才给）：上一轮没过的验收条编号（从 1 起，对得上
     * howToFinish），和上轮问题原话。有它时，喂进来的 diff 是这一轮的增量，判法只复核这些条和增量里的改动。
     */
    recheck: z
      .object({
        failedCriteria: z.array(z.number().int().positive()),
        priorProblems: z.array(z.string()),
      })
      .optional(),
    /**
     * 要求两家都验（两个不同的族各验一遍，都过才算过）：作者族认不出时由调用方设为 true。
     * 为 true 时 modelFamiliesAvoid 和 otherAuthorFamilies 可以都为空。不为 true 时，别家一家都派不出也会改成两家都验。
     */
    requireTwoFamilies: z.boolean().optional(),
    /** PR 正文（写代码的会话写的说明）：只当线索给验收看，不当证据。没有不给。 */
    prBody: z.string().optional(),
    /**
     * 引擎在会话收场后自己跑过的测试输出（test:changed、tsc 之类）：有才给，当材料。
     * 「测试/检查/构建/类型检查通过」类验收条不靠它核对（归合并闸的 CI）；里面明确写了失败才当成问题。
     */
    testOutput: z.string().optional(),
  })
  .refine(
    (v) =>
      v.requireTwoFamilies === true || v.modelFamiliesAvoid.length + (v.otherAuthorFamilies?.length ?? 0) > 0,
    {
      message: '作者族一个都没有：不知道该避开谁，没法保证换了家族',
      path: ['modelFamiliesAvoid'],
    },
  );
export type VerifierInvokeInput = z.infer<typeof VerifierInvokeInputSchema>;

/** 输出 zod：pass / fail + 问题清单。 */
export const VerifierInvokeOutputSchema = z.object({
  pass: z.boolean(),
  /** 问题清单：只有三类——没做到验收条 / 弄坏原有功能 / 安全丢数据；「没查成」也走这里写明白。 */
  problems: z.array(z.string()),
  /** 给人/驾驶舱看的备注（选了哪个家族、没讨论成的具体原因、丢了几条风格意见）。 */
  notes: z.string().optional(),
  /** 第几轮跑出来的（透传 input.round）。 */
  round: z.union([z.literal(1), z.literal(2)]),
  /**
   * 「不归我验」：要 diff 以外的证据才判得了的验收条（截图、页面现场、线上数据、审计结果，或只靠被跳过的文件才判得了）。
   * 不算没过、不回炉；调用方把它们转给人（留言到单上）。没有就不带。
   */
  outOfScope: z.array(z.string()).optional(),
  /** 建议（不挡）：模型「## 建议」段里的话，原样带给人看。没有就不带。 */
  suggestions: z.array(z.string()).optional(),
  /**
   * 真起了会话就有：哪一次执行、什么结局、哪个族哪条路由。没起会话（读不到 diff、没讨论成）没有。
   * 调用方靠结局认「内存放不下没派出去」这种过一会儿再来就行的，不要去解析 problems 的文字。
   */
  session: z
    .object({
      runId: z.string(),
      outcome: z.enum(ONE_SHOT_OUTCOMES),
      family: ModelFamilySchema,
      modelId: z.string(),
      routeId: z.string().optional(),
    })
    .optional(),
  /**
   * 上游临时故障（失败分流规则表上标了 blip 的）：等一会儿再验，不算没验成。
   * 秒数是分流给的等待；调用方照它睡，不停下报人。
   */
  upstreamRetry: z
    .object({
      reason: z.string().min(1),
      afterSeconds: z.number().positive(),
    })
    .optional(),
  /**
   * 没起会话、在等选路（#1697）：要派的族此刻派不出但等得来（chooseModelForFamily 回了 `{ wait }`）。调用方过一会儿重来，
   * 不报人。families 是在等的族（按问的先后），reason 是「族（在等什么）」用「；」连起来。
   * 一个模型都派不出（#1731）也回这个：families 为空，reason 写「一个模型都派不出，过一会儿重来」。
   */
  routeWait: z
    .object({
      families: z.array(ModelFamilySchema),
      reason: z.string().min(1),
    })
    .optional(),
  /**
   * 引擎要走了，验收会话脱开引擎接着跑（#2848，deps.detach 给了才会有）：没有结论。调用方交回给工作流，下一个引擎拿它接回
   * （attachVerifier）。会话的工作目录（cwd）没还：接回收场后由调用方删。
   */
  detached: z
    .object({
      runId: z.string(),
      startedAt: z.string(),
      family: ModelFamilySchema,
      modelId: z.string(),
      routeId: z.string().optional(),
      channel: z.string().optional(),
      /** 选路那句「为什么派它」：接回收场那一笔整行覆盖开跑那一行，带上原来的，免得冲成空。 */
      routeWhy: z.string().optional(),
      cwd: z.string(),
    })
    .optional(),
  /**
   * 发版叫停了这一次验收、又没接回（#2848）：引擎要走时被停下的会话（没脱开的那几种），或接回时会话已经没给出结论。
   * 不是没过、也不是做不出来：调用方重验一次（不算一轮）。写的是白话原因。
   */
  lostOnRelease: z.string().optional(),
});
export type VerifierInvokeOutput = z.infer<typeof VerifierInvokeOutputSchema>;

/**
 * 拉取 diff 的接口：**注入**。本模块不调 git / gh / GitHub——fetchDiff 的失败明确进 problems，
 * 不许拿空 diff 当「没改也就没挡的」。
 */
export type FetchDiff = (args: {
  prNumber: number;
  branch: string;
  baseSha: string;
}) => Promise<{ diffText: string; changedFiles: string[] }>;

/** 「要什么 / 怎么算做完」已经在 input 里了；这一道（拉单子的需求文档目录）单独注入是为了
 * 让「单子读不到」也走明确失败路径。 */
export type FetchSpec = (args: { taskId: string }) => Promise<{ specDir?: string }>;

/**
 * PR 头上一个路径的读回。三选一：正文、这个路径在头上不存在、这一步没读成。
 * 没读成要把原因带回，提示词里写「读不到：原因」，不能当成「没这个文件」悄悄丢掉。
 */
export type NamedHeadFile =
  | { path: string; kind: 'content'; content: string }
  | { path: string; kind: 'missing' }
  | { path: string; kind: 'unreadable'; reason: string };

/**
 * 读 PR 头提交上这些路径的当前内容。本模块不调 git，调用方（冷验收装配）从引擎镜像读。
 * 抛错由本模块接住，改写成每个路径「读不到」，不许因此让整次验收失败。
 */
export type FetchNamedFiles = (paths: string[]) => Promise<NamedHeadFile[]>;

/** 单子点名、又不在这次 diff 里的文件，最多带几个进提示词。再多一次看不完。 */
const MAX_NAMED_FILES = 5;
/** 单个文件超过这么多行，只给头尾，中间写明省略。 */
const NAMED_FILE_MAX_LINES = 200;
const NAMED_FILE_EDGE_LINES = 100;

const BACKTICK_PATH = /`([^`\n]+)`/g;

/**
 * 仓内相对路径：至少一段目录、文件名带后缀，只含常见路径字符。
 * 不认绝对路径、`..`、网址、没有目录的 `foo.ts`。验收条里的例子是 `deploy/france.sh`、`packages/x/y.ts`。
 */
export function isNamedRepoPath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 400) return false;
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(raw)) return false;
  const segments = raw.split('/');
  if (segments.some((seg) => seg === '.' || seg === '..')) return false;
  const file = segments.at(-1) ?? '';
  const dot = file.lastIndexOf('.');
  return dot > 0 && dot < file.length - 1;
}

function pathsInBackticks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(BACKTICK_PATH)) {
    const raw = match[1]?.trim() ?? '';
    if (isNamedRepoPath(raw)) out.push(raw);
  }
  return out;
}

/**
 * 从「怎么算做完」和「要什么」的反引号里取出仓内相对路径，去掉 diff 已经改过的，最多 5 个。
 * 先扫怎么算做完（验收条点名的优先），再扫要什么；同一个路径只留第一次。
 */
export function namedPathsOutsideDiff(
  what: string,
  howToFinish: readonly string[],
  changedFiles: readonly string[],
): string[] {
  const changed = new Set(changedFiles);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of [...howToFinish, what]) {
    for (const path of pathsInBackticks(text)) {
      if (changed.has(path) || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= MAX_NAMED_FILES) return out;
    }
  }
  return out;
}

/**
 * 按家族挑一个能跑的 model：注入。「挑不出」调用方返回 undefined。
 * routeId：生产的 Spawner 据此在库里查执行方式、会话用户、上游模型串（modelId 只是记账用）；不给，测试里的假 Spawner 也能跑。
 * runId：这一次起会话的编号（runs 主键），挑中时先定下（切号的登记要在起会话之前就知道它，#59）；不给由 one-shot 自己起。
 * reservationId：选路时给这一次验收预占的池的名额（#757）：开跑那一行写进去时换掉；不经选路的不给。
 * 挑中了没起会话的（两家都验只凑出一家），本模块不放预占：调用方收场时放（real/task-verify.ts 的 finally）。
 * `{ wait }`：这一族此刻派不出、但等得来（等空位、等额度清零、等熔断到点），wait 写在等什么。和 undefined（没路由、被关、
 * 硬挡，等也等不来）分开：别家在等时本模块回等待（routeWait），不改成两家都验。
 */
export type ChooseModelForFamily = (family: ModelFamily) => Promise<
  | {
      modelId: string;
      channel?: string;
      routeId?: string;
      runId?: string;
      reservationId?: string;
      /** 选路那句「为什么派它」，开跑写进 runs.route_why。不给 = 没记。 */
      routeWhy?: string;
    }
  | { wait: string }
  | undefined
>;

/** chooseModelForFamily 挑中的那种回答（不是 undefined、也不是在等）。 */
type ChosenModel = Extract<NonNullable<Awaited<ReturnType<ChooseModelForFamily>>>, { modelId: string }>;

/** 挑中的验收方：哪一族、哪个模型、哪条路由。 */
export interface PickedVerifier {
  family: ModelFamily;
  modelId: string;
  channel?: string;
  routeId?: string;
  /** 挑中时定下的这一次起会话的编号（chooseModelForFamily 给了才有）：调用方在 prepareCwd 里照它登记切号（#59）。 */
  runId?: string;
}

export interface VerifierInvokeDeps {
  oneShot: OneShotDeps;
  fetchDiff: FetchDiff;
  fetchSpec: FetchSpec;
  chooseModelForFamily: ChooseModelForFamily;
  /** 会话 cwd（通常是调用方为这张 PR 准备的工作树）。给了 prepareCwd 就不用它。 */
  cwd: string;
  /**
   * 挑中谁之后、起会话之前，为它备会话的工作目录：目录要归这条路由的会话用户，所以只能等挑完才知道备给谁
   * （生产：交给会话用户的一个空目录，验收的会话手上没有仓库检出）。release 在会话收场后调，成败都调；它抛错不改结论。
   * 两家都验时两家都挑完才并行起会话，每一家起会话前各调一次：要跟着「这一次起的是谁」的登记（切号）放在这里，不放在挑模型那一下。
   * prepareCwd 本身抛错（路由用不了、目录交不出去）原样往外抛，由调用方记成「没跑起来」。
   */
  prepareCwd?: (picked: PickedVerifier) => Promise<{
    cwd: string;
    release: () => Promise<void>;
    /** 两家并行时每个会话各用各的（切号登记的停止信号、起进程前的标记都是按会话的）；不给用 deps.oneShot。 */
    oneShot?: OneShotDeps;
  }>;
  /** 超时（分钟），默认 60。 */
  timeoutMinutes?: number;
  /**
   * 脱开引擎跑（#2848，和动手段同一套）：给 true，一家验的会话交 detach 给 one-shot，执行方式支持的引擎要走时放手、交回
   * detached。两家都验的两个会话并行跑，交回只带得了一个，不脱开（引擎要走时被停下，按 lostOnRelease 重验一次）。
   */
  detach?: boolean;
  /** 引擎要走了（发版切版本、重启）就回一句原因：这时没跑完的会话不换下一个候选，回 lostOnRelease 重验一次。 */
  released?: () => string | undefined;
  /**
   * 单子点名、这次 diff 没改的文件，按 PR 头读当前内容。不给就不加那一节（没有这份依赖的调用方照旧只看 diff）。
   * 读不到、或者这一步抛错，都不让验收失败：提示词里标「读不到」。
   */
  fetchNamedFiles?: FetchNamedFiles;
}

/** 三种能挡的问题前缀（specs/555 第 3 条）。problems 里每条必须以这三种之一开头；风格意见不许进。 */
export const BLOCKER_KINDS = ['没做到验收条', '弄坏了原有功能', '安全或丢数据'] as const;

/** 提示词里这一句：验收会话可以读 PR 头的完整检出，不只好看 diff。 */
export const VERIFY_MAY_READ_HEAD = '你可以在 PR 头的完整检出里读文件';

/**
 * 第 2 轮的判法原句。新提出的、不在增量里的问题只记备注、不拒。
 * 增量里新出现的问题，模型要在正文里写上能对上本轮 changedFiles 的「增量文件：`路径`」证据，
 * 否则和「不在上轮没过的条里」一样改记备注。
 */
export const VERIFY_RECHECK_RULE =
  '只复核上轮没过的条和增量里的改动，新提出的、不在增量里的问题只记备注、不拒';

/** 问题正文里的验收条编号（从 1 起）。认不出就空。 */
export function criterionNumbersIn(problem: string): number[] {
  return [...problem.matchAll(/第\s*(\d+)\s*条/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n >= 1);
}

/** 每条问题都要有一个落在「怎么算做完」里的编号。没有、或编号对不上，算格式错。 */
export function missingCriterionNumbers(problems: readonly string[], criterionCount: number): boolean {
  if (problems.length === 0) return false;
  return problems.some((problem) => {
    const nums = criterionNumbersIn(problem);
    return !nums.some((n) => n <= criterionCount);
  });
}

/**
 * 第 2 轮：编号在上轮没过的条里，或正文写了「增量」（模型标明这是增量里的新问题），才继续挡。
 * 增量里的新问题必须带能对上本轮 changedFiles 的「增量文件：`路径`」证据；其余新提出的改记备注。
 */
export function splitRecheckProblems(
  problems: readonly string[],
  failedCriteria: ReadonlySet<number>,
  changedFiles: readonly string[] = [],
): { keep: string[]; noted: string[] } {
  const changed = new Set(changedFiles);
  const incrementalEvidence = (problem: string): boolean =>
    [...problem.matchAll(/增量文件\s*[:：]\s*`([^`\n]+)`/g)].some((match) => {
      const path = match[1]?.trim();
      return path !== undefined && changed.has(path);
    });
  const keep: string[] = [];
  const noted: string[] = [];
  for (const problem of problems) {
    const cited = criterionNumbersIn(problem).some((n) => failedCriteria.has(n));
    if (cited || incrementalEvidence(problem)) keep.push(problem);
    else noted.push(problem);
  }
  return { keep, noted };
}
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** 行数按人看到的行算：文件末尾那个换行不算多出来的一行。 */
function fileLines(content: string): string[] {
  if (content === '') return [];
  const parts = content.split('\n');
  if (content.endsWith('\n')) parts.pop();
  return parts;
}

/** 超过 200 行只留头 100 行和尾 100 行，并写明中间省略了多少。不到这个行数原样给。 */
function clipNamedFile(content: string): { text: string; note?: string } {
  const lines = fileLines(content);
  if (lines.length <= NAMED_FILE_MAX_LINES) return { text: lines.join('\n') };
  const head = lines.slice(0, NAMED_FILE_EDGE_LINES);
  const tail = lines.slice(-NAMED_FILE_EDGE_LINES);
  const omitted = lines.length - NAMED_FILE_EDGE_LINES * 2;
  return {
    note: `（这个文件共 ${lines.length} 行，超过 ${NAMED_FILE_MAX_LINES} 行，只给头 ${NAMED_FILE_EDGE_LINES} 行和尾 ${NAMED_FILE_EDGE_LINES} 行，中间省略 ${omitted} 行。）`,
    text: `${head.join('\n')}\n…（省略 ${omitted} 行）…\n${tail.join('\n')}`,
  };
}

/** 文件正文里若有反引号，围栏要比最长的那一串再长一格，免得正文把围栏截断。 */
function fenceFor(content: string): string {
  let width = 3;
  for (const run of content.match(/`+/g) ?? []) width = Math.max(width, run.length + 1);
  return '`'.repeat(width);
}

/** 没有点名且没改的文件时返回空，调用方就不输出这一节。 */
function renderNamedFiles(files: readonly NamedHeadFile[]): string[] {
  if (files.length === 0) return [];
  const lines = [
    '',
    '## 单子点名但这次没改的文件（只读，当前内容）',
    '这些文件不在这次的 diff 里。下面是 PR 头上的当前内容，用来核对验收条点到、这次没改的文件。标了「读不到」的是这一步没读成。',
    '',
  ];
  for (const file of files) {
    lines.push(`### \`${file.path}\``);
    if (file.kind === 'missing') {
      lines.push('这个路径在 PR 头上不存在。', '');
      continue;
    }
    if (file.kind === 'unreadable') {
      lines.push(`读不到：${file.reason}`, '');
      continue;
    }
    const clipped = clipNamedFile(file.content);
    if (clipped.note !== undefined) lines.push(clipped.note);
    const fence = fenceFor(clipped.text);
    lines.push(`${fence}text`, clipped.text, fence, '');
  }
  return lines;
}

function alignNamedFiles(paths: readonly string[], got: readonly NamedHeadFile[]): NamedHeadFile[] {
  const byPath = new Map<string, NamedHeadFile>();
  for (const item of got) {
    if (typeof item?.path === 'string' && !byPath.has(item.path)) byPath.set(item.path, item);
  }
  return paths.map((path) => {
    const item = byPath.get(path);
    if (item === undefined) return { path, kind: 'unreadable', reason: '没有回这个路径' };
    if (item.kind === 'content' && typeof item.content === 'string') {
      return { path, kind: 'content', content: item.content };
    }
    if (item.kind === 'missing') return { path, kind: 'missing' };
    if (item.kind === 'unreadable') {
      const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
      return { path, kind: 'unreadable', reason: reason === '' ? '没有原因' : reason };
    }
    return { path, kind: 'unreadable', reason: '回的样子认不出' };
  });
}

/** 点名的路径一个都没有、或者调用方没接读取时，不加这一节。读取抛错改写成每个路径「读不到」。 */
async function loadNamedFiles(
  input: VerifierInvokeInput,
  changedFiles: readonly string[],
  fetchNamedFiles: FetchNamedFiles | undefined,
): Promise<NamedHeadFile[]> {
  const paths = namedPathsOutsideDiff(input.what, input.howToFinish, changedFiles);
  if (paths.length === 0 || fetchNamedFiles === undefined) return [];
  try {
    const got = await fetchNamedFiles(paths);
    if (!Array.isArray(got)) {
      return paths.map((path) => ({ path, kind: 'unreadable', reason: '回的不是一份清单' }));
    }
    return alignNamedFiles(paths, got);
  } catch (err) {
    const why = errMessage(err);
    return paths.map((path) => ({ path, kind: 'unreadable', reason: why }));
  }
}

/**
 * 渲染喂给冷调用模型的 prompt（不走 runner/brief.ts 的 VerifyBrief——那一份要求调用方带 headSha，
 * 而本切片输入只钉到 baseSha；headSha 由 fetchDiff 那侧认、模型不需要复述）。
 */
function renderPrompt(
  input: VerifierInvokeInput,
  diff: { diffText: string; changedFiles: string[] },
  specDir: string | undefined,
  named: readonly NamedHeadFile[],
): string {
  const prBody = input.prBody?.trim() ?? '';
  const testOutput = input.testOutput?.trim() ?? '';
  const recheck = input.round === 2 ? input.recheck : undefined;
  const materials = [
    '上面的需求原文',
    ...(prBody !== '' ? ['下面的 PR 正文'] : []),
    ...(testOutput !== '' ? ['引擎跑过的测试输出'] : []),
    recheck ? '这一轮的增量 diff' : 'diff',
    ...(named.length > 0 ? ['「单子点名但这次没改的文件」里的当前内容'] : []),
    'PR 头的完整检出',
  ];
  const recheckLines =
    recheck === undefined
      ? []
      : [
          '',
          '## 上一轮没过的条',
          '这一轮只复核下面这些，再加这一轮增量 diff 里的改动。',
          ...(recheck.failedCriteria.length === 0
            ? ['（上轮问题里没有认得出的验收条编号，按下面对原话复核。）']
            : recheck.failedCriteria.map((n) => {
                const text = input.howToFinish[n - 1];
                return text ? `- 第 ${n} 条：${text}` : `- 第 ${n} 条`;
              })),
          ...(recheck.priorProblems.length > 0
            ? ['', '上轮写的问题：', ...recheck.priorProblems.map((p) => `- ${p}`)]
            : []),
        ];
  return [
    `# 任务：验收 PR #${input.prNumber}（第 ${input.round} 轮）`,
    '',
    '## 要什么',
    input.what.trim(),
    '',
    '## 怎么算做完（逐条都要回）',
    ...input.howToFinish.map((a, i) => `${i + 1}. ${a}`),
    ...(specDir !== undefined ? ['', `## 需求文档出处`, `\`${specDir}\`（对照这份，不要凭印象）。`] : []),
    ...recheckLines,
    '',
    '## 验什么',
    `PR：#${input.prNumber}`,
    `分支：\`${input.branch}\`  基线：\`${input.baseSha}\``,
    `${VERIFY_MAY_READ_HEAD}。能看的材料：${materials.join('、')}。当前目录是 PR 头的完整检出时，直接读文件；某个文件读不到，只根据下面这些材料判，不要因为读不到就当成没做到。`,
    '你只做一件事：逐条判「怎么算做完」在这些材料里成不成立。',
    `- 材料里看得出做到了：成立。材料里看得出没做到，或这一条本该在 diff 里看得见却找不到：写进「## 问题」（${BLOCKER_KINDS[0]}），不要凭想象放行。这一句只管 diff 能看见的内容，不包括只要求测试、检查、构建或类型检查通过的条目。`,
    '- 这一条要 diff 以外的证据才判得了（截图、页面现场、线上或法国的数据、审计结果、人手操作的结果），或只靠标了「跳过」的文件才判得了：',
    '  不算没做到，写进「## 不归我验」，引擎转给人验。',
    '- 验收条原文写明「只算建议」「不挡」「可选」的：不挡，有意见写进「## 建议」。',
    '- PR 正文是写代码的会话自己写的说明，只当线索、不当做到了的证据；验收条没要求 PR 正文写什么，就不许拿「PR 正文没写」挡。',
    '- 「怎么算做完」里只要求「某某测试/检查/构建/类型检查通过」的条目，一律由合并闸的 CI 保证，你不核对、不因测试输出里没出现它判不过；只有测试输出里明确出现失败时才作为问题写出。输出里写「没跑」「跳过」、或没有这一条的输出，不算失败，不写进问题。',
    '不要改文件、不要提交、不要开 PR。',
    'diff 里标了「这个文件太大，只给了摘要」的文件，摘要里看不到的部分不算没做到，别拿它挡；标了「生成文件」的（迁移快照）不逐行看，',
    '只核对它和同一 PR 里的迁移 sql、schema 改动对得上；标了「跳过」的文件看不到内容，不凭它挡、也不凭它放。',
    '',
    '## 改了哪些文件',
    ...diff.changedFiles.map((f) => `- ${f}`),
    ...renderNamedFiles(named),
    ...renderTextBlock('PR 正文（写代码的会话写的，只当线索）', prBody, PR_BODY_MAX_CHARS, 'head'),
    ...renderTextBlock('引擎跑过的测试输出', testOutput, TEST_OUTPUT_MAX_CHARS, 'tail'),
    '',
    recheck ? '## 这一轮的增量 diff（unified patch）' : '## diff（unified patch）',
    ...(recheck ? ['下面只是上一轮验收之后、这一轮新推上来的增量，不是整张 PR 从基线起的全部 diff。'] : []),
    '```diff',
    diff.diffText,
    '```',
    '',
    '## 判法（只有三种能挡）',
    '**只有三种**能写进「## 问题」：',
    `- ${BLOCKER_KINDS[0]}：「怎么算做完」的某一条，单子要 A、材料里是 B（或没做）。只要求测试、检查、构建或类型检查通过的不在此列：不因测试输出里没出现它写，只有测试输出里明确出现失败才写`,
    `- ${BLOCKER_KINDS[1]}：diff 里有证据显示这次改动弄坏了原有功能`,
    `- ${BLOCKER_KINDS[2]}：diff 里有证据显示安全或丢数据的问题`,
    '风格、命名、设计好不好、「最好再加个……」**不许写**进「## 问题」，放「## 建议」，不影响结论。',
    '每条问题都要带验收条编号，写成「第 N 条」（N 是上面「怎么算做完」的序号，从 1 起）。没有编号算格式错。',
    ...(recheck
      ? [
          VERIFY_RECHECK_RULE,
          '上轮没过的条没修好：写进「## 问题」，带第 N 条。增量 diff 里新改坏的：也写进「## 问题」，带第 N 条，并且正文写「增量文件：`本轮 diff 中的实际路径`」。新提出的、不在增量里的：写进「## 建议」。增量文件路径对不上本轮 diff、或没有这句证据，且编号也不在上轮没过的条里的，引擎会改记备注、不拒。',
        ]
      : []),
    '',
    '## 输出形状',
    `先写一段「## 问题」（每行一条，以 \`- ${BLOCKER_KINDS[0]}：第 N 条：\`、\`- ${BLOCKER_KINDS[1]}：第 N 条：\` 或 \`- ${BLOCKER_KINDS[2]}：第 N 条：\` 开头，N 是「怎么算做完」的序号；没有编号算格式错；没有问题就留空）；`,
    '再写「## 不归我验」（每行一条，`- 第 N 条：要什么证据、为什么 diff 里看不出`；没有就留空）；',
    '可以写「## 建议」段（不挡，不影响结论）；',
    '**最后一行写** `verdict: pass` 或 `verdict: fail`（不许别的话、不许两个都写）。只有「## 问题」里有条目才写 fail；',
    '只有「不归我验」或「建议」的写 pass。',
  ].join('\n');
}

/** PR 正文、测试输出各最多带多少字符进提示词（正文留头、测试输出留尾：错误多在末尾）。 */
const PR_BODY_MAX_CHARS = 20_000;
const TEST_OUTPUT_MAX_CHARS = 30_000;

/** 一段纯文本材料：空的不出这一节；超长截掉并写明。 */
function renderTextBlock(title: string, text: string, max: number, keep: 'head' | 'tail'): string[] {
  if (text === '') return [];
  const clipped =
    text.length <= max
      ? { body: text, note: undefined }
      : {
          body: keep === 'head' ? text.slice(0, max) : text.slice(-max),
          note: `（共 ${text.length} 个字符，超过 ${max}，只给${keep === 'head' ? '开头' : '末尾'} ${max} 个。）`,
        };
  const fence = fenceFor(clipped.body);
  return ['', `## ${title}`, ...(clipped.note ? [clipped.note] : []), `${fence}text`, clipped.body, fence];
}

/**
 * 「## 标题」段下的逐条（`- ` 或 `* ` 开头）。续行只认紧跟在某一条后面、中间没有空行的；
 * 结论行不算续行（不然「verdict: fail」会被并进最后一条的文字里）。没有这一段回空。
 */
function sectionItems(lines: readonly string[], heading: RegExp): string[] {
  const start = lines.findIndex((l) => heading.test(l));
  const raw: string[] = [];
  if (start < 0) return raw;
  let afterItem = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (/^##\s+/.test(l)) break;
    const t = l.trim();
    if (t === '') {
      afterItem = false;
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      raw.push(t.slice(2).trim());
      afterItem = true;
    } else if (readVerdict(t) !== null) {
      break;
    } else if (afterItem) {
      raw[raw.length - 1] = `${raw[raw.length - 1]} ${t}`;
    }
  }
  return raw.filter((item) => item !== '' && !/^[（(]?(无|没有|空)[）)。.]?$/.test(item));
}

/**
 * 从模型 stdout 里抽出「## 问题」段的逐条 problem、「## 不归我验」「## 建议」两段、最后一行 verdict、
 * 以及「被丢掉的风格意见计数」。problems 只留以三种能挡开头的（specs/555：风格意见不许算挡），丢掉的并进建议。
 */
function parseStdout(stdout: string): {
  verdictLine: string;
  problems: string[];
  outOfScope: string[];
  suggestions: string[];
  droppedStyleNotes: number;
} {
  const lines = stdout.split('\n');
  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l !== '');
  const verdictLine = nonEmpty.at(-1) ?? '';
  const raw = sectionItems(lines, /^##\s+问题/);
  const keep = raw.filter((p) => BLOCKER_KINDS.some((k) => p.startsWith(k)));
  const dropped = raw.filter((p) => !BLOCKER_KINDS.some((k) => p.startsWith(k)));
  return {
    verdictLine,
    problems: keep,
    outOfScope: sectionItems(lines, /^##\s+不归我验/),
    suggestions: [...sectionItems(lines, /^##\s+建议/), ...dropped],
    droppedStyleNotes: dropped.length,
  };
}

/**
 * 结论行必须是固定写法 `verdict: pass` / `verdict: fail`（两头的反引号、星号、句号容忍）。
 * judgeVerify 只看行里有没有 pass、fail 两个词：「verdict: not pass」它也放过去，这里不放。
 */
export function readVerdict(line: string): 'pass' | 'fail' | null {
  const cleaned = line.trim().replace(/^[`*_>\s]+|[`*_\s.。]+$/g, '');
  const m = /^verdict\s*[:：]\s*(pass|fail)$/i.exec(cleaned);
  return m ? (m[1]?.toLowerCase() === 'pass' ? 'pass' : 'fail') : null;
}

/** 会话没跑成时，执行体报的原因码和原话（额度用完、模型对不上、中转对不上账……）：写进问题里，人看得到怎么回事。 */
function failureFacts(result: OneShotResult): string {
  const f = result.facts;
  const reason = f?.reason && f.reason !== 'delivered' && f.reason !== 'answered' ? `原因码 ${f.reason}` : '';
  return [reason, f?.detail, f?.rawError]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join('；')
    .slice(0, 600);
}

function routeLabel(picked: PickedVerifier): string {
  return picked.routeId ?? `${picked.family}/${picked.modelId}`;
}

function coldCallFailed(verdict: SegmentVerdict, result: OneShotResult): string {
  const facts = failureFacts(result);
  return `冷调用没跑成：${verdict.reason}${facts ? `；${facts}` : ''}`;
}

/** 认不出时写进停下说明的报错尾巴。脱敏、截末尾；什么都没有就写明。 */
function listedTail(text: string): string {
  const tail = sessionErrorTail(text);
  return tail === '' ? '（没有报错尾巴）' : tail;
}

type SessionClass =
  | { kind: 'blip'; reason: string; afterSeconds: number }
  | { kind: 'unknown'; tail: string }
  | { kind: 'known' };

/** 会话失败交给失败分流：上游临时故障等一会儿，认不出换路由，其余照旧停下。关键词只在规则表里。 */
function classOfFailed(result: OneShotResult): SessionClass {
  const evidence = segmentEvidence(result);
  const classified = classifyFailure({
    source: 'session:verify',
    routeBound: true,
    retryable: null,
    ...(evidence.code === undefined ? {} : { code: evidence.code }),
    ...(evidence.message === undefined ? {} : { message: evidence.message }),
    ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
    ...(evidence.httpStatus === undefined ? {} : { httpStatus: evidence.httpStatus }),
    ...(evidence.resetsAt === undefined ? {} : { resetsAt: evidence.resetsAt }),
  });
  if (isUpstreamBlip(classified.rule) && classified.action === 'retry') {
    const delay = classified.delaySeconds;
    return {
      kind: 'blip',
      reason: classified.reason,
      afterSeconds: Number.isFinite(delay) && delay > 0 ? Math.max(1, Math.round(delay)) : 1,
    };
  }
  if (classified.rule === 'FB') return { kind: 'unknown', tail: listedTail(evidence.message ?? '') };
  return { kind: 'known' };
}

type VerifierSession = NonNullable<VerifierInvokeOutput['session']>;

/** 一次验收会话收场后的判法（新起的、接回的同一份）：终局直接交回、没验成换下一个候选、有结论。 */
type SessionJudgement =
  | { kind: 'final'; out: VerifierInvokeOutput }
  | { kind: 'miss'; why: string }
  | {
      kind: 'verdict';
      passed: boolean;
      problems: string[];
      outOfScope: string[];
      suggestions: string[];
      notes: string[];
      session: VerifierSession;
    };

function sessionOf(result: OneShotResult, picked: PickedVerifier): VerifierSession {
  return {
    runId: result.runId,
    outcome: result.outcome,
    family: picked.family,
    modelId: picked.modelId,
    ...(picked.routeId !== undefined ? { routeId: picked.routeId } : {}),
  };
}

/**
 * 读一次验收会话的结局（#2848 从 runFamily 拆出来，接回的会话 attachVerifier 用同一份）。
 * 内存放不下、切号停下、上游临时故障、发版叫停（released 回了原因）是终局：原样交回，调用方过一会儿再验；
 * 别的没跑成、结论行写法不对、写 fail 却没有算挡的问题是 miss（换下一个候选）；其余是结论。
 */
function judgeVerifierSession(
  result: OneShotResult,
  picked: PickedVerifier,
  round: 1 | 2,
  released?: () => string | undefined,
): SessionJudgement {
  const session = sessionOf(result, picked);
  const who = `家族 ${picked.family}（model ${picked.modelId}）`;
  // verdict 行 = stdout 最后一行非空（judgeVerify 按这一行判 pass / fail）。
  const lastLineOfStdout =
    result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .at(-1) ?? '';
  const verdict: SegmentVerdict = judgeVerify(result, { verdictLine: lastLineOfStdout });

  if (verdict.kind !== 'ok') {
    // 内存放不下没派出去、切号停下：这一次的结局原样回去，调用方认结局过一会儿重来，不换路由
    if (result.outcome === 'admission_blocked' || result.outcome === 'org_switch') {
      return {
        kind: 'final',
        out: { pass: false, problems: [coldCallFailed(verdict, result)], notes: who, round, session },
      };
    }
    // 引擎要走了（发版切版本、重启）时没跑完的：是发版叫停的，不是这条路由没验成，不换候选、不算没过，重验一次（#2848）
    const lost = released?.();
    if (lost !== undefined) {
      return {
        kind: 'final',
        out: {
          pass: false,
          problems: [],
          notes: who,
          round,
          session,
          lostOnRelease: `${lost}：${coldCallFailed(verdict, result).replace(/^冷调用没跑成：/, '')}`,
        },
      };
    }
    // 跑了、退出失败的看分流：上游临时故障等一会儿再验，不换家
    let why = coldCallFailed(verdict, result).replace(/^冷调用没跑成：/, '');
    if (result.outcome === 'failed') {
      const klass = classOfFailed(result);
      if (klass.kind === 'blip') {
        return {
          kind: 'final',
          out: {
            pass: false,
            problems: [],
            notes: who,
            round,
            session,
            upstreamRetry: { reason: klass.reason, afterSeconds: klass.afterSeconds },
          },
        };
      }
      if (klass.kind === 'unknown') why = `认不出原因：${klass.tail}`;
    }
    // 其余（超时、被杀、起不来、认得出的失败）：记下，换下一个候选
    return { kind: 'miss', why };
  }

  const stdoutPieces = parseStdout(result.stdout);
  const word = readVerdict(stdoutPieces.verdictLine);
  if (word === null) {
    return {
      kind: 'miss',
      why: `结论行不是固定写法「verdict: pass」或「verdict: fail」（最后一行是：${stdoutPieces.verdictLine.slice(0, 120)}）`,
    };
  }
  const notes: string[] = [who];
  if (stdoutPieces.droppedStyleNotes > 0) {
    notes.push(
      `模型另外在「## 问题」里写了 ${stdoutPieces.droppedStyleNotes} 条不属于三种能挡的意见，按 specs/555 不许算挡，已挪进建议`,
    );
  }
  const { outOfScope, suggestions } = stdoutPieces;
  if (outOfScope.length > 0) notes.push(`不归我验 ${outOfScope.length} 条（要 diff 以外的证据，转给人）`);
  if (word === 'fail' && stdoutPieces.problems.length === 0 && outOfScope.length > 0) {
    // 只写了「不归我验」却给了 fail：那几条不算没做到（决定 0093），按过算，那几条转给人
    notes.push('模型写了 verdict: fail，但只有「不归我验」、没有算挡的问题：按过算');
    return { kind: 'verdict', passed: true, problems: [], outOfScope, suggestions, notes, session };
  }
  if (word === 'fail' && stdoutPieces.problems.length === 0) {
    // 说没过却一条算挡的都没写：不当成过（模型明明说了不行），也不能把空问题表丢回给写代码的会话白改——算这一条没验成，换下一个候选
    return {
      kind: 'miss',
      why: `结论写了 fail，但「## 问题」里没有一条以「${BLOCKER_KINDS.join('」「')}」开头的（${
        stdoutPieces.droppedStyleNotes > 0
          ? `它写了 ${stdoutPieces.droppedStyleNotes} 条不算挡的意见`
          : '它一条都没写'
      }）`,
    };
  }
  if (word === 'pass' && stdoutPieces.problems.length > 0) {
    notes.push(
      `模型写了 verdict: pass，但问题清单里还有 ${stdoutPieces.problems.length} 条算挡的：自相矛盾，按没过处理`,
    );
  }
  return {
    kind: 'verdict',
    passed: word === 'pass' && stdoutPieces.problems.length === 0,
    problems: stdoutPieces.problems,
    outOfScope,
    suggestions,
    notes,
    session,
  };
}

/** 接回脱开跑着的那一次验收会话（#2848）：要的是原来那一次的编号、族、路由和这张单的记账字段。 */
export interface VerifierAttachInput {
  attach: NonNullable<VerifierInvokeOutput['detached']>;
  round: 1 | 2;
  taskId: string;
  issueNumber: number;
  workflowId?: string;
  /** 这一笔验收属于第几个回合（#3140，只记账）。 */
  roundSeq?: number;
  prNumber: number;
  branch: string;
}

/**
 * 接回上一个引擎放手的那一次验收会话（#2848）：不拉 diff、不选路、不起会话，one-shot 带 attach 从收发目录接回、等它收场，
 * 结论照 invokeVerifier 的判法读，结局记回原来那一行 runs。
 * - 接回时引擎又要走了：再交回 detached（等下一个引擎）。
 * - 会话没给出结论（被发版叫停了、接回时已经没了、结论认不出）：不换候选、不算没过，回 lostOnRelease，调用方重验一次。
 */
export async function attachVerifier(
  input: VerifierAttachInput,
  deps: Pick<VerifierInvokeDeps, 'oneShot' | 'timeoutMinutes' | 'released'>,
): Promise<VerifierInvokeOutput> {
  const { attach, round } = input;
  const picked: PickedVerifier = {
    family: attach.family,
    modelId: attach.modelId,
    ...(attach.channel !== undefined ? { channel: attach.channel } : {}),
    ...(attach.routeId !== undefined ? { routeId: attach.routeId } : {}),
    runId: attach.runId,
  };
  let result: OneShotResult;
  try {
    result = await runOneShot(
      {
        runId: attach.runId,
        segment: 'verify',
        modelId: attach.modelId,
        ...(attach.channel !== undefined ? { channel: attach.channel } : {}),
        ...(attach.routeId !== undefined ? { routeId: attach.routeId } : {}),
        ...(attach.routeWhy?.trim() ? { routeWhy: attach.routeWhy.trim() } : {}),
        taskId: input.taskId,
        issueNumber: input.issueNumber,
        ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
        ...(input.roundSeq !== undefined ? { roundSeq: input.roundSeq } : {}),
        prNumber: input.prNumber,
        branch: input.branch,
        prompt: '',
        cwd: attach.cwd,
        ...(deps.timeoutMinutes !== undefined ? { timeoutMinutes: deps.timeoutMinutes } : {}),
        detach: { attach: { startedAt: attach.startedAt } },
      },
      deps.oneShot,
    );
  } catch (error) {
    if (error instanceof OneShotDetached) return { pass: false, problems: [], round, detached: attach };
    throw error;
  }
  const judged = judgeVerifierSession(result, picked, round, deps.released);
  if (judged.kind === 'final') return judged.out;
  if (judged.kind === 'miss') {
    return {
      pass: false,
      problems: [],
      notes: `家族 ${picked.family}（model ${picked.modelId}）`,
      round,
      session: sessionOf(result, picked),
      lostOnRelease: `接回的验收会话没给出结论（${judged.why}）`,
    };
  }
  return {
    pass: judged.passed,
    problems: judged.problems,
    notes: judged.notes.join('；'),
    round,
    session: judged.session,
    ...(judged.outOfScope.length > 0 ? { outOfScope: judged.outOfScope } : {}),
    ...(judged.suggestions.length > 0 ? { suggestions: judged.suggestions } : {}),
  };
}

/**
 * 跑 #555-1 一轮冷调用。
 *
 * 返回的 `problems` 数组有四类来源，都写在那个数组里：
 * - 读不到 diff / 单子 / 没讨论成 → 本模块自己塞的明确失败原因
 * - 冷调用没跑成（judgeVerify failed、结论行不是固定写法、fail 却没有算挡的问题）→ 那条 reason
 * - 冷调用跑成 + verdict fail → 模型「## 问题」里以三种能挡开头的那几条
 * - 冷调用跑成 + verdict pass → problems 是空数组（模型该写的「## 问题」也是空的）
 */
export async function invokeVerifier(
  input: VerifierInvokeInput,
  deps: VerifierInvokeDeps,
): Promise<VerifierInvokeOutput> {
  const parsed = VerifierInvokeInputSchema.parse(input);

  // 1. 拉 diff（注入，不调 git/gh）。
  let diff: { diffText: string; changedFiles: string[] };
  try {
    diff = await deps.fetchDiff({
      prNumber: parsed.prNumber,
      branch: parsed.branch,
      baseSha: parsed.baseSha,
    });
  } catch (err) {
    const msg = errMessage(err);
    return {
      pass: false,
      problems: [`读不到 diff：${msg}`],
      notes: 'specs/555 第 4 条：读不到 PR 必填栏就明确失败',
      round: parsed.round,
    };
  }
  if (parsed.round === 1 && diff.diffText.trim() === '') {
    return {
      pass: false,
      problems: ['读不到 diff：fetchDiff 返回了空 diff（不许拿空当「没改动所以没挡的」）'],
      notes: 'specs/555 第 4 条',
      round: parsed.round,
    };
  }
  if (parsed.round === 1 && diff.changedFiles.length === 0) {
    return {
      pass: false,
      problems: ['读不到 diff：fetchDiff 返回了空 changedFiles（没改任何文件就是没干活）'],
      notes: 'specs/555 第 4 条',
      round: parsed.round,
    };
  }

  // 2. 拉 specDir（注入）。
  let spec: { specDir?: string };
  try {
    spec = await deps.fetchSpec({ taskId: parsed.taskId });
  } catch (err) {
    const msg = errMessage(err);
    return {
      pass: false,
      problems: [`读不到单子：${msg}`],
      notes: 'specs/555 第 4 条',
      round: parsed.round,
    };
  }

  // 3. 按 0006 顺序挑家族，跳过写过这张单的所有族。认不出原因的会话失败先换下一条路由再验
  // （同一族再问时避开刚试过的；选路不认避开时，同一条路由只试一次，免得死循环）。上游临时故障等一会儿再验，不换家。
  // 认得出的别的失败马上停下。一家都挑不出 → 没讨论成（不许拿默认模型顶）。
  const avoid = new Set<string>(parsed.modelFamiliesAvoid);
  const seenRoutes = new Set<string>();
  const misses: { route: string; tail: string }[] = [];
  let lastSession: VerifierInvokeOutput['session'];
  /** 问题没带验收条编号：整次验收只重跑一次，跨家族也不能再重跑。 */
  let formatRetried = false;
  const named = await loadNamedFiles(parsed, diff.changedFiles, deps.fetchNamedFiles);
  const prompt = renderPrompt(parsed, diff, spec.specDir, named);

  /** 一个族试完的结果：终局（直接回给调用方）、有结论、或这一族挑不出可用模型。 */
  type FamilyOutcome =
    | { kind: 'final'; out: VerifierInvokeOutput }
    | {
        kind: 'verdict';
        family: ModelFamily;
        modelId: string;
        passed: boolean;
        problems: string[];
        outOfScope: string[];
        suggestions: string[];
        notes: string[];
        session: NonNullable<VerifierInvokeOutput['session']>;
      }
    | { kind: 'none' };

  /** 问一族要一个模型：挑中、在等（等得来）、派不出（等不来）。 */
  type Pick = { kind: 'model'; m: ChosenModel } | { kind: 'wait'; detail: string } | { kind: 'none' };
  const pickFor = async (family: ModelFamily): Promise<Pick> => {
    const m = await deps.chooseModelForFamily(family);
    if (m === undefined) return { kind: 'none' };
    if ('wait' in m) return { kind: 'wait', detail: m.wait };
    return { kind: 'model', m };
  };

  /** 选路说在等的族：别家没有结论时回等待，不起会话（#1697）。 */
  const waiting: { family: ModelFamily; detail: string }[] = [];
  const waitOut = (): VerifierInvokeOutput => {
    const reason = waiting.map((w) => `${w.family}（${w.detail}）`).join('；');
    return {
      pass: false,
      problems: [`没讨论成：要派的族这会儿派不出、等得来（${reason}），这一次没起会话`],
      notes: '在等选路：过一会儿重来，不改成作者族互验，也不先起一家白跑',
      round: parsed.round,
      routeWait: { families: waiting.map((w) => w.family), reason },
    };
  };

  /**
   * 拿挑中的模型起会话。会话没跑成（结局不是 done、结论行写法不对、写 fail 却没有算挡的问题）先记进 misses，
   * 换这一族的下一条路由再验；换的那一下挑不出、或在等，这一族就算没验成（none），调用方换下一族（#1731）。
   * 上游临时故障、内存放不下、切号是「过一会儿再来」，原样回给调用方（final），不换。
   */
  const runFamily = async (
    family: ModelFamily,
    first: ChosenModel,
    detachable = false,
  ): Promise<FamilyOutcome> => {
    let m = first;
    /** 这一条路由没验成：记下，换这一族的下一条路由；换不出就回 none。 */
    const missAndNext = async (route: string, why: string): Promise<boolean> => {
      misses.push({ route, tail: why });
      const next = await pickFor(family);
      if (next.kind !== 'model') return false;
      m = next.m;
      return true;
    };
    while (true) {
      const picked: PickedVerifier = {
        family,
        modelId: m.modelId,
        ...(m.channel !== undefined ? { channel: m.channel } : {}),
        ...(m.routeId !== undefined ? { routeId: m.routeId } : {}),
        ...(m.runId !== undefined ? { runId: m.runId } : {}),
      };
      const label = routeLabel(picked);
      if (seenRoutes.has(label)) return { kind: 'none' };
      seenRoutes.add(label);

      const prepared = deps.prepareCwd ? await deps.prepareCwd(picked) : undefined;
      const cwd = prepared ? prepared.cwd : deps.cwd;
      const oneShotInput: OneShotInput = {
        ...(m.runId !== undefined ? { runId: m.runId } : {}),
        ...(m.reservationId !== undefined ? { reservationId: m.reservationId } : {}),
        ...(m.routeWhy?.trim() ? { routeWhy: m.routeWhy.trim() } : {}),
        segment: 'verify',
        modelId: picked.modelId,
        ...(picked.channel !== undefined ? { channel: picked.channel } : {}),
        ...(picked.routeId !== undefined ? { routeId: picked.routeId } : {}),
        // 记到这张单名下（#216）：验收是冷调用、不分档，不带派工档
        taskId: parsed.taskId,
        issueNumber: parsed.issueNumber,
        ...(parsed.workflowId !== undefined ? { workflowId: parsed.workflowId } : {}),
        ...(parsed.roundSeq !== undefined ? { roundSeq: parsed.roundSeq } : {}),
        prNumber: parsed.prNumber,
        branch: parsed.branch,
        prompt,
        cwd,
        ...(deps.timeoutMinutes !== undefined ? { timeoutMinutes: deps.timeoutMinutes } : {}),
        // 一家验的会话可以脱开引擎跑（#2848）：执行方式支持的，引擎要走时放手、交回 detached
        ...(detachable && deps.detach ? { detach: {} } : {}),
      };
      let oneShotResult: OneShotResult;
      try {
        oneShotResult = await runOneShot(oneShotInput, prepared?.oneShot ?? deps.oneShot);
      } catch (error) {
        // 引擎要走了、会话脱开接着跑：备的目录还归会话在用，不还；交回接回要的东西（#2848）
        if (error instanceof OneShotDetached) {
          return {
            kind: 'final',
            out: {
              pass: false,
              problems: [],
              notes: `家族 ${picked.family}（model ${picked.modelId}）：引擎要走了，验收会话脱开接着跑，等下一个引擎接回`,
              round: parsed.round,
              detached: {
                runId: error.runId,
                startedAt: error.startedAt,
                family: picked.family,
                modelId: picked.modelId,
                ...(picked.routeId !== undefined ? { routeId: picked.routeId } : {}),
                ...(picked.channel !== undefined ? { channel: picked.channel } : {}),
                ...(oneShotInput.routeWhy !== undefined ? { routeWhy: oneShotInput.routeWhy } : {}),
                cwd,
              },
            },
          };
        }
        await prepared?.release().catch(() => undefined);
        throw error;
      }
      // 备的目录会话收场后就还回去（成败都还）；还不掉不改结论，备目录的那一侧自己记日志
      await prepared?.release().catch(() => undefined);
      lastSession = sessionOf(oneShotResult, picked);
      const judged = judgeVerifierSession(oneShotResult, picked, parsed.round, deps.released);
      if (judged.kind === 'final') return judged;
      if (judged.kind === 'miss') {
        if (await missAndNext(label, judged.why)) continue;
        return { kind: 'none' };
      }
      let problems = judged.problems;
      let suggestions = judged.suggestions;
      if (missingCriterionNumbers(problems, parsed.howToFinish.length)) {
        // 没有验收条编号：格式错，只重跑一次。下一条路由还是刚才这条时，拿掉「已经试过」再跑这一次。
        const why = '问题没带验收条编号（格式错）';
        misses.push({ route: label, tail: why });
        if (!formatRetried) {
          formatRetried = true;
          const next = await pickFor(family);
          if (next.kind === 'model') {
            const nextLabel = next.m.routeId ?? `${family}/${next.m.modelId}`;
            if (seenRoutes.has(nextLabel)) seenRoutes.delete(nextLabel);
            m = next.m;
          } else {
            seenRoutes.delete(label);
          }
          continue;
        }
        return { kind: 'none' };
      }
      const recheck = parsed.round === 2 ? parsed.recheck : undefined;
      const notes = [...judged.notes];
      if (recheck !== undefined) {
        const split = splitRecheckProblems(problems, new Set(recheck.failedCriteria), diff.changedFiles);
        problems = split.keep;
        if (split.noted.length > 0) {
          suggestions = [...suggestions, ...split.noted];
          notes.push(`新提出的、不在增量里的 ${split.noted.length} 条只记备注、不拒`);
        }
      }
      if (formatRetried) notes.push('上一次问题没带验收条编号，按格式错重跑了一次');
      if (!judged.passed && problems.length === 0 && recheck !== undefined) {
        notes.push('模型写了不通过，但保留下来的问题为空：新问题只记备注、不拒，按过算');
      }
      return {
        ...judged,
        family: picked.family,
        modelId: picked.modelId,
        passed: problems.length === 0,
        problems,
        suggestions,
        notes,
      };
    }
  };
  /** 各家的「不归我验」「建议」合起来（去重，两家时带上族名）；空的不带。 */
  const extras = (
    vs: readonly Extract<FamilyOutcome, { kind: 'verdict' }>[],
  ): { outOfScope?: string[]; suggestions?: string[] } => {
    const tag = (v: { family: string }, item: string) => (vs.length > 1 ? `${v.family}：${item}` : item);
    const outOfScope = [...new Set(vs.flatMap((v) => v.outOfScope.map((o) => tag(v, o))))];
    const suggestions = [...new Set(vs.flatMap((v) => v.suggestions.map((o) => tag(v, o))))];
    return {
      ...(outOfScope.length > 0 ? { outOfScope } : {}),
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  };

  // 4. 一家验：不要求两家时，按顺序问不在避开族里的族，谁先给出结论就用谁，和一直以来一样。在等的族跳过、记下。
  if (parsed.requireTwoFamilies !== true) {
    for (const family of FAMILY_ORDER) {
      if (avoid.has(family)) continue;
      const p = await pickFor(family);
      if (p.kind === 'wait') waiting.push({ family, detail: p.detail });
      if (p.kind !== 'model') continue;
      // 一家验：一次只跑一个会话，可以脱开引擎跑（#2848）
      const r = await runFamily(family, p.m, true);
      if (r.kind === 'final') return r.out;
      if (r.kind === 'verdict') {
        return {
          pass: r.passed,
          problems: r.problems,
          notes: r.notes.join('；'),
          round: parsed.round,
          session: r.session,
          ...extras([r]),
        };
      }
    }
    // 别家有在等的、又没有一家给出结论：等它（#1697）。不改成两家都验，那样是作者族互验，没有跨族把关。
    // 别家有没验成的（misses）也一样等：等来的那一族可能验得成，比停下等人好（#1731）。
    if (waiting.length > 0) return waitOut();
  }

  // 5. 两家都验：认不出作者（requireTwoFamilies），或别家全都派不出、没验成。候选族先排不在避开族里的，再排避开族里的。
  // 先把两个不同族的模型都挑出来，挑齐了才起会话（#1697）：只挑到一家时起了它，下一次重来又要把它整个再跑一遍。
  // 挑到一家、另一家在等：回等待，挑到的那家不起会话，它的预占由调用方收场时放掉。同一族只算一家。
  // 一家没验成（#1731）：接着问后面的候选族；只凑出一家的结论就按「同族兜底验」用它；一家都没有：没模型就等，试遍了才算没跑成。
  const candidates =
    parsed.requireTwoFamilies === true
      ? [...FAMILY_ORDER.filter((f) => !avoid.has(f)), ...FAMILY_ORDER.filter((f) => avoid.has(f))]
      : FAMILY_ORDER.filter((f) => avoid.has(f)); // 不在避开族里的，一家验时已经问过、全都派不出或没验成
  const chosen: { family: ModelFamily; m: ChosenModel }[] = [];
  // 候选族按挑族顺序只问一次：先挑齐两家，没验成的再从这里接着往后拿
  const rest = [...candidates];
  while (chosen.length < 2) {
    const family = rest.shift();
    if (family === undefined) break;
    const p = await pickFor(family);
    if (p.kind === 'wait') waiting.push({ family, detail: p.detail });
    if (p.kind === 'model') chosen.push({ family, m: p.m });
  }
  if (chosen.length < 2 && waiting.length > 0) return waitOut();
  const verdicts: Extract<FamilyOutcome, { kind: 'verdict' }>[] = [];
  // 两家的会话并行起，不串着等第一家跑完。都收场了再看：一家起不来（NO_SLOT 等抛错）不取消另一家，另一家照常跑完、
  // 结论已记进 runs，这一次把那个错原样往外抛（调用方判成等待）；没有抛错的，有终局的先回终局，其余按挑族顺序收结论。
  const settled = await Promise.allSettled(chosen.map(({ family, m }) => runFamily(family, m)));
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    if (s.value.kind === 'final') return s.value.out;
  }
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.kind === 'verdict') verdicts.push(s.value);
  }
  // 挑出来的有没验成的：按挑族的顺序接着问后面的族，凑够两家结论为止
  while (verdicts.length < 2) {
    const family = rest.shift();
    if (family === undefined) break;
    const p = await pickFor(family);
    if (p.kind === 'wait') waiting.push({ family, detail: p.detail });
    if (p.kind !== 'model') continue;
    const r = await runFamily(family, p.m);
    if (r.kind === 'final') return r.out;
    if (r.kind === 'verdict') verdicts.push(r);
  }
  if (verdicts.length >= 2) {
    const failed = verdicts.filter((v) => !v.passed);
    const names = verdicts.map((v) => `${v.family}（model ${v.modelId}）`).join('、');
    return {
      pass: failed.length === 0,
      problems: failed.flatMap((v) => v.problems.map((p) => `${v.family}：${p}`)),
      notes: [
        `两家都验：${names}`,
        ...verdicts.flatMap((v) => v.notes.slice(1).map((n) => `${v.family}：${n}`)),
      ].join('；'),
      round: parsed.round,
      session: verdicts[1]?.session,
      ...extras(verdicts),
    };
  }
  const listed = misses.map((item) => `${item.route}：${item.tail}`).join('；');
  const only = verdicts[0];
  // 只凑出一家的结论：它说没过就是没过（两家都验本来就要都过）；它说过、但还有族在等，等那一族来再验
  if (only !== undefined && (!only.passed || waiting.length === 0)) {
    return {
      pass: only.passed,
      problems: only.problems,
      notes: [
        `同族兜底验：族 ${only.family}（model ${only.modelId}），别家派不出或没验成，用它起了一次全新的冷会话`,
        ...(misses.length > 0 ? [`没验成的路由：${listed}`] : []),
        ...only.notes.slice(1),
      ].join('；'),
      round: parsed.round,
      session: only.session,
      ...extras([only]),
    };
  }
  if (waiting.length > 0) return waitOut();
  if (misses.length === 0) {
    // 一个族都派不出、也没有在等的：不停下等人，回等待，过一会儿重来（#1731）
    const reason = `一个模型都派不出，过一会儿重来（避开的族 ${[...avoid].join('、') || '无'}）`;
    return {
      pass: false,
      problems: [`这会儿验不了：${reason}`],
      notes: '没有能派的验收模型：过一会儿重来，不许默认模型顶上、更不许拿它当 pass',
      round: parsed.round,
      routeWait: { families: [], reason },
    };
  }
  return {
    pass: false,
    problems: [`冷调用没跑成：试过的路由都没验成：${listed}`],
    notes: '验收用途里还能派的路由（含作者族的同族兜底验）都试过了',
    round: parsed.round,
    ...(lastSession === undefined ? {} : { session: lastSession }),
  };
}
