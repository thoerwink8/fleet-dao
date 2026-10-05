// #555-1 验收段冷调用的纯接口：喂 diff + 要什么 + 怎么算做完 → 起一次 one-shot 冷调用（换一个不同家族）→
// 回 pass/fail + 问题清单。
//
// **不走 Fusion**（docs/decisions/0010-three-segment-flow.md 已替掉 Fusion 流程）：本模块不被
// packages/engine/src/workflows/verify.ts 调；那一份是 Fusion 句号后留下的。本切片**新增**给 v3 验收段用。
//
// 三条硬约束（specs/555-验收/需求.md）：
// 1. **喂三样**：diff + 单子的「要什么」+「怎么算做完」。diff 不由本模块自己拼 `git diff`——**注入**进来
//    （FetchDiff / FetchSpec），调用方（组装层）自己决定从哪读（GitHub、git 工作树、fake）。
// 2. **换家族**：docs/decisions/0006-discussion-model-order.md 钉的顺序 gpt → grok → claude → deepseek → kimi（2026-10-05 起）；
//    modelFamiliesAvoid（写过这张单的所有族）要全部跳过。所有不同家族都挑不出 → 明确失败（**没讨论成**），不许
//    拿默认模型顶上、不许假装 pass。
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
// - chooseModelForFamily 对每个可用家族都返回 undefined → problems: ['没讨论成：…']、pass: false
// - one-shot outcome != 'done' 或结论行不是固定写法 → problems: ['冷调用没跑成：…']、pass: false
// - 结论写 fail 却没有一条属于三种能挡的问题 → 同样是「冷调用没跑成」（要人看，不当成过，也不让写代码的会话白改）
// - 结论写 pass 但问题清单里还有算挡的 → pass: false（自相矛盾的结论不放行）

import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import type { OneShotDeps, OneShotInput, OneShotResult } from './runner/one-shot.ts';
import { ONE_SHOT_OUTCOMES, runOneShot } from './runner/one-shot.ts';
import type { SegmentVerdict } from './runner/verdict.ts';
import { judgeVerify } from './runner/verdict.ts';

/** 冷调用 #555-1 的模型家族顺序（docs/decisions/0006-discussion-model-order.md 第 2 条）。 */
export const FAMILY_ORDER = ['gpt', 'grok', 'claude', 'deepseek', 'kimi'] as const;
export type ModelFamily = (typeof FAMILY_ORDER)[number];

export const ModelFamilySchema = z.enum(FAMILY_ORDER);

/** 输入 zod：调用方现成算好的东西全在这里；diff / 要什么都不再自己翻。 */
export const VerifierInvokeInputSchema = z.object({
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
   * 写过这张单的所有族（0006：全部要跳过再选）。至少一个：一个都没有就不知道该避开谁，没法保证换了家族。
   * 一张单换过路由（先 Claude 写、后来换 GPT 写）时两族都在里面：只避开最后一个，验收的可能正是前一轮的作者。
   */
  modelFamiliesAvoid: z.array(ModelFamilySchema).min(1),
  /** 这是第几轮：默认 1 轮、最多 2 轮（specs/555 第 3 条）；本模块不判上限，只透传。 */
  round: z.union([z.literal(1), z.literal(2)]),
});
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
 * 按家族挑一个能跑的 model：注入。「挑不出」调用方返回 undefined。
 * routeId：生产的 Spawner 据此在库里查执行方式、会话用户、上游模型串（modelId 只是记账用）；不给，测试里的假 Spawner 也能跑。
 * runId：这一次起会话的编号（runs 主键），挑中时先定下（切号的登记要在起会话之前就知道它，#59）；不给由 one-shot 自己起。
 * reservationId：选路时给这一次验收预占的池的名额（#757）：开跑那一行写进去时换掉；不经选路的不给。
 */
export type ChooseModelForFamily = (family: ModelFamily) => Promise<
  | {
      modelId: string;
      channel?: string;
      routeId?: string;
      runId?: string;
      reservationId?: string;
    }
  | undefined
>;

/** 挑中的验收方：哪一族、哪个模型、哪条路由。 */
export interface PickedVerifier {
  family: ModelFamily;
  modelId: string;
  channel?: string;
  routeId?: string;
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
   * prepareCwd 本身抛错（路由用不了、目录交不出去）原样往外抛，由调用方记成「没跑起来」。
   */
  prepareCwd?: (picked: PickedVerifier) => Promise<{ cwd: string; release: () => Promise<void> }>;
  /** 超时（分钟），默认 60。 */
  timeoutMinutes?: number;
}

/** 三种能挡的问题前缀（specs/555 第 3 条）。problems 里每条必须以这三种之一开头；风格意见不许进。 */
export const BLOCKER_KINDS = ['没做到验收条', '弄坏了原有功能', '安全或丢数据'] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/**
 * 渲染喂给冷调用模型的 prompt（不走 runner/brief.ts 的 VerifyBrief——那一份要求调用方带 headSha，
 * 而本切片输入只钉到 baseSha；headSha 由 fetchDiff 那侧认、模型不需要复述）。
 */
function renderPrompt(
  input: VerifierInvokeInput,
  diff: { diffText: string; changedFiles: string[] },
  specDir?: string,
): string {
  return [
    `# 任务：验收 PR #${input.prNumber}（第 ${input.round} 轮）`,
    '',
    '## 要什么',
    input.what.trim(),
    '',
    '## 怎么算做完（逐条都要回）',
    ...input.howToFinish.map((a, i) => `${i + 1}. ${a}`),
    ...(specDir !== undefined ? ['', `## 需求文档出处`, `\`${specDir}\`（对照这份，不要凭印象）。`] : []),
    '',
    '## 验什么',
    `PR：#${input.prNumber}`,
    `分支：\`${input.branch}\`  基线：\`${input.baseSha}\``,
    '你手上没有仓库的检出（当前目录是空的），只能看下面的 diff 和上面的需求原文。某一条在 diff 里看不出做没做，按没做到算，',
    '不要凭想象放行；CI、测试跑没跑过不归你管（CI 另外要求必过），你只看这次改动对不对得上单子。不要改文件、不要提交、不要开 PR。',
    '',
    '## 改了哪些文件',
    ...diff.changedFiles.map((f) => `- ${f}`),
    '',
    '## diff（unified patch）',
    '```diff',
    diff.diffText,
    '```',
    '',
    '## 判法（只有三种能挡）',
    '对照「要什么」和「怎么算做完」逐条核；**只有三种**能写进「## 问题」：',
    `- ${BLOCKER_KINDS[0]}：单子要 A、代码做了 B（或没做）`,
    `- ${BLOCKER_KINDS[1]}：有证据显示这次改动弄坏了原有功能`,
    `- ${BLOCKER_KINDS[2]}：安全或丢数据`,
    '风格、命名、设计好不好**不许写**进「## 问题」（可以放到「## 建议」段，但不影响结论）。',
    '',
    '## 输出形状',
    `先写一段「## 问题」（每行一条，以 \`- ${BLOCKER_KINDS[0]}：\`、\`- ${BLOCKER_KINDS[1]}：\` 或 \`- ${BLOCKER_KINDS[2]}：\` 开头；没有问题就留空）；`,
    '中间可以写「## 建议」段（不挡，不影响结论）；',
    '**最后一行写** `verdict: pass` 或 `verdict: fail`（不许别的话、不许两个都写）。写 fail 就必须在「## 问题」里至少有一条。',
  ].join('\n');
}

/**
 * 从模型 stdout 里抽出「## 问题」段的逐条 problem、最后一行 verdict、以及「被丢掉的风格意见计数」。
 * problems 只留以三种能挡开头的（specs/555：风格意见不许算挡）。
 */
function parseStdout(stdout: string): {
  verdictLine: string;
  problems: string[];
  droppedStyleNotes: number;
} {
  const lines = stdout.split('\n');
  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l !== '');
  const verdictLine = nonEmpty.at(-1) ?? '';
  const start = lines.findIndex((l) => /^##\s+问题/.test(l));
  const raw: string[] = [];
  if (start >= 0) {
    // 续行只认紧跟在某一条后面、中间没有空行的；结论行不算续行（不然「verdict: fail」会被并进最后一条问题的文字里）
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
  }
  const keep = raw.filter((p) => BLOCKER_KINDS.some((k) => p.startsWith(k)));
  return { verdictLine, problems: keep, droppedStyleNotes: raw.length - keep.length };
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
  if (diff.diffText.trim() === '') {
    return {
      pass: false,
      problems: ['读不到 diff：fetchDiff 返回了空 diff（不许拿空当「没改动所以没挡的」）'],
      notes: 'specs/555 第 4 条',
      round: parsed.round,
    };
  }
  if (diff.changedFiles.length === 0) {
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

  // 3. 按 0006 顺序挑家族，跳过写过这张单的所有族；挑不出 → 明确失败（不许拿默认模型顶）。
  const avoid = new Set<string>(parsed.modelFamiliesAvoid);
  let picked: PickedVerifier | undefined;
  let runId: string | undefined;
  let reservationId: string | undefined;
  for (const family of FAMILY_ORDER) {
    if (avoid.has(family)) continue;
    const m = await deps.chooseModelForFamily(family);
    if (m !== undefined) {
      picked = {
        family,
        modelId: m.modelId,
        ...(m.channel !== undefined ? { channel: m.channel } : {}),
        ...(m.routeId !== undefined ? { routeId: m.routeId } : {}),
      };
      runId = m.runId;
      reservationId = m.reservationId;
      break;
    }
  }
  if (picked === undefined) {
    const tried = FAMILY_ORDER.filter((f) => !avoid.has(f)).join('、');
    return {
      pass: false,
      problems: [
        `没讨论成：避开的族 ${[...avoid].join('、')}，${tried ? `剩下的 ${tried}` : '一个能换的族都不剩'} 全挑不出可用模型`,
      ],
      notes: '0006：所有不同家族都不可用 = 没讨论成，不许默认模型顶上、更不许拿它当 pass',
      round: parsed.round,
    };
  }

  // 4. 起一次 one-shot（renders prompt、跑、判结论）。
  const prompt = renderPrompt(parsed, diff, spec.specDir);
  const prepared = deps.prepareCwd ? await deps.prepareCwd(picked) : undefined;
  const oneShotInput: OneShotInput = {
    ...(runId !== undefined ? { runId } : {}),
    ...(reservationId !== undefined ? { reservationId } : {}),
    segment: 'verify',
    modelId: picked.modelId,
    ...(picked.channel !== undefined ? { channel: picked.channel } : {}),
    ...(picked.routeId !== undefined ? { routeId: picked.routeId } : {}),
    // 记到这张单名下（#216）：验收是冷调用、不分档，不带派工档
    taskId: parsed.taskId,
    issueNumber: parsed.issueNumber,
    ...(parsed.workflowId !== undefined ? { workflowId: parsed.workflowId } : {}),
    prNumber: parsed.prNumber,
    branch: parsed.branch,
    prompt,
    cwd: prepared ? prepared.cwd : deps.cwd,
    ...(deps.timeoutMinutes !== undefined ? { timeoutMinutes: deps.timeoutMinutes } : {}),
  };
  let oneShotResult: OneShotResult;
  try {
    oneShotResult = await runOneShot(oneShotInput, deps.oneShot);
  } finally {
    // 备的目录会话收场后就还回去（成败都还）；还不掉不改结论，备目录的那一侧自己记日志
    await prepared?.release().catch(() => undefined);
  }
  const session = {
    runId: oneShotResult.runId,
    outcome: oneShotResult.outcome,
    family: picked.family,
    modelId: picked.modelId,
    ...(picked.routeId !== undefined ? { routeId: picked.routeId } : {}),
  };
  const who = `家族 ${picked.family}（model ${picked.modelId}）`;

  // verdict 行 = stdout 最后一行非空（judgeVerify 按这一行判 pass / fail）。
  const lastLineOfStdout =
    oneShotResult.stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .at(-1) ?? '';
  const verdict: SegmentVerdict = judgeVerify(oneShotResult, { verdictLine: lastLineOfStdout });

  if (verdict.kind !== 'ok') {
    const facts = failureFacts(oneShotResult);
    return {
      pass: false,
      problems: [`冷调用没跑成：${verdict.reason}${facts ? `；${facts}` : ''}`],
      notes: who,
      round: parsed.round,
      session,
    };
  }

  const stdoutPieces = parseStdout(oneShotResult.stdout);
  const word = readVerdict(stdoutPieces.verdictLine);
  if (word === null) {
    return {
      pass: false,
      problems: [
        `冷调用没跑成：结论行不是固定写法「verdict: pass」或「verdict: fail」（最后一行是：${stdoutPieces.verdictLine.slice(0, 120)}）`,
      ],
      notes: who,
      round: parsed.round,
      session,
    };
  }
  const notes: string[] = [who];
  if (stdoutPieces.droppedStyleNotes > 0) {
    notes.push(
      `模型另外提了 ${stdoutPieces.droppedStyleNotes} 条不属于三种能挡的意见，按 specs/555 不许算挡，已丢`,
    );
  }
  if (word === 'fail' && stdoutPieces.problems.length === 0) {
    // 说没过却一条算挡的都没写：不当成过（模型明明说了不行），也不能把空问题表丢回给写代码的会话白改——要人看
    return {
      pass: false,
      problems: [
        `冷调用没跑成：结论写了 fail，但「## 问题」里没有一条以「${BLOCKER_KINDS.join('」「')}」开头的（${
          stdoutPieces.droppedStyleNotes > 0
            ? `它写了 ${stdoutPieces.droppedStyleNotes} 条不算挡的意见`
            : '它一条都没写'
        }）`,
      ],
      notes: notes.join('；'),
      round: parsed.round,
      session,
    };
  }
  if (word === 'pass' && stdoutPieces.problems.length > 0) {
    notes.push(
      `模型写了 verdict: pass，但问题清单里还有 ${stdoutPieces.problems.length} 条算挡的：自相矛盾，按没过处理`,
    );
  }
  return {
    pass: word === 'pass' && stdoutPieces.problems.length === 0,
    problems: stdoutPieces.problems,
    notes: notes.join('；'),
    round: parsed.round,
    session,
  };
}
