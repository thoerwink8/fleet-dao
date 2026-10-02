// #555-1 验收段冷调用的纯接口：喂 diff + 要什么 + 怎么算做完 → 起一次 one-shot 冷调用（换一个不同家族）→
// 回 pass/fail + 问题清单。
//
// **不走 Fusion**（docs/decisions/0010-three-segment-flow.md 已替掉 Fusion 流程）：本模块不被
// packages/engine/src/workflows/verify.ts 调；那一份是 Fusion 句号后留下的。本切片**新增**给 v3 验收段用。
//
// 三条硬约束（specs/555-验收/需求.md）：
// 1. **喂三样**：diff + 单子的「要什么」+「怎么算做完」。diff 不由本模块自己拼 `git diff`——**注入**进来
//    （FetchDiff / FetchSpec），调用方（组装层）自己决定从哪读（GitHub、git 工作树、fake）。
// 2. **换家族**：docs/decisions/0006-discussion-model-order.md 钉的顺序 gpt → claude → deepseek → grok → kimi；
//    modelFamilyAvoid（写这张单的族）要跳过。所有不同家族都挑不出 → 明确失败（**没讨论成**），不许
//    拿默认模型顶上、不许假装 pass。
// 3. **只有三种能挡**：没做到验收条 / 有证据弄坏原有功能 / 安全或丢数据（specs/555 第 3 条）。
//    模型提到的风格意见**不算挡**，从 problems 里滤掉、但不允许反过来把「算挡的」藏起来。
//
// 默认 1 轮、最多 2 轮（specs/555 第 3 条）：本模块只跑调用方指定的那一轮（input.round）；要不要起
// 第 2 轮、什么时候起，是调用方的事。
//
// 明确失败的路径（不许拿「查不到」当 pass，通用段底线第 3 条 + specs/555 第 4 条）：
// - fetchDiff 抛错 / 返回空 diff / 返回空 changedFiles → problems: ['读不到 diff：…']、pass: false
// - fetchSpec 抛错 → problems: ['读不到单子：…']、pass: false
// - chooseModelForFamily 对每个可用家族都返回 undefined → problems: ['没讨论成：…']、pass: false
// - one-shot outcome != 'done' 或结论行没说清 pass/fail → judgeVerify 判 failed，pass: false

import { z } from 'zod';
import type { OneShotDeps, OneShotInput } from './runner/one-shot.ts';
import { runOneShot } from './runner/one-shot.ts';
import type { SegmentVerdict } from './runner/verdict.ts';
import { judgeVerify } from './runner/verdict.ts';

/** 冷调用 #555-1 的模型家族顺序（docs/decisions/0006-discussion-model-order.md 第 2 条）。 */
export const FAMILY_ORDER = ['gpt', 'claude', 'deepseek', 'grok', 'kimi'] as const;
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
  /** 这单对应的「活」ID（task / run / demand 哪个层级由调用方定），本模块只透传给 fetchSpec。 */
  taskId: z.string().min(1),
  /** 「要什么」原文（需求文档里的「## 场景 / 需求」段；冷调用模型要照它核）。 */
  what: z.string().min(1),
  /** 「怎么算做完」逐条原文。 */
  howToFinish: z.array(z.string().min(1)).min(1),
  /** 写这张单的家族（0006：要跳过它再选）。 */
  modelFamilyAvoid: ModelFamilySchema,
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

/** 按家族挑一个能跑的 model：注入。「挑不出」调用方返回 undefined。 */
export type ChooseModelForFamily = (
  family: ModelFamily,
) => Promise<{ modelId: string; channel?: string } | undefined>;

export interface VerifierInvokeDeps {
  oneShot: OneShotDeps;
  fetchDiff: FetchDiff;
  fetchSpec: FetchSpec;
  chooseModelForFamily: ChooseModelForFamily;
  /** 会话 cwd（通常是调用方为这张 PR 准备的工作树）。 */
  cwd: string;
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
    ...(specDir !== undefined ? ['', `## 需求文档出处`, `\`${specDir}\`（对照这份，不要凭印象）。`] : []),
    '',
    '## 验什么',
    `PR：#${input.prNumber}`,
    `分支：\`${input.branch}\`  基线：\`${input.baseSha}\``,
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
    '先写一段「## 问题」（每行一条，以 `- ${BLOCKER_KINDS[0]} / - ${BLOCKER_KINDS[1]} / - ${BLOCKER_KINDS[2]} ` 开头）；',
    '中间可以写「## 建议」段（不挡，不影响结论）；',
    '**最后一行写** `verdict: pass` 或 `verdict: fail`（不许别的话、不许两个都写）。',
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
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i] ?? '';
      if (/^##\s+/.test(l)) break;
      const t = l.trim();
      if (t.startsWith('- ') || t.startsWith('* ')) {
        raw.push(t.slice(2).trim());
      } else if (t !== '' && raw.length > 0) {
        // 续行：并回上一条
        raw[raw.length - 1] = `${raw[raw.length - 1]} ${t}`;
      }
    }
  }
  const keep = raw.filter((p) => BLOCKER_KINDS.some((k) => p.startsWith(k)));
  return { verdictLine, problems: keep, droppedStyleNotes: raw.length - keep.length };
}

/**
 * 跑 #555-1 一轮冷调用。
 *
 * 返回的 `problems` 数组有四类来源，都写在那个数组里：
 * - 读不到 diff / 单子 / 没讨论成 → 本模块自己塞的明确失败原因
 * - 冷调用没跑成（judgeVerify failed）→ 那条 verdict.reason
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
    const msg = err instanceof Error ? err.message : String(err);
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
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pass: false,
      problems: [`读不到单子：${msg}`],
      notes: 'specs/555 第 4 条',
      round: parsed.round,
    };
  }

  // 3. 按 0006 顺序挑家族，跳过 avoid；挑不出 → 明确失败（不许拿默认模型顶）。
  let picked: { family: ModelFamily; modelId: string; channel?: string } | undefined;
  for (const family of FAMILY_ORDER) {
    if (family === parsed.modelFamilyAvoid) continue;
    const m = await deps.chooseModelForFamily(family);
    if (m !== undefined) {
      picked = {
        family,
        modelId: m.modelId,
        ...(m.channel !== undefined ? { channel: m.channel } : {}),
      };
      break;
    }
  }
  if (picked === undefined) {
    const tried = FAMILY_ORDER.filter((f) => f !== parsed.modelFamilyAvoid).join('、');
    return {
      pass: false,
      problems: [`没讨论成：避开的族 ${parsed.modelFamilyAvoid}，剩下的 ${tried} 全挑不出可用模型`],
      notes: '0006：所有不同家族都不可用 = 没讨论成，不许默认模型顶上、更不许拿它当 pass',
      round: parsed.round,
    };
  }

  // 4. 起一次 one-shot（renders prompt、跑、判结论）。
  const prompt = renderPrompt(parsed, diff, spec.specDir);
  const oneShotInput: OneShotInput = {
    segment: 'verify',
    modelId: picked.modelId,
    ...(picked.channel !== undefined ? { channel: picked.channel } : {}),
    prompt,
    cwd: deps.cwd,
    ...(deps.timeoutMinutes !== undefined ? { timeoutMinutes: deps.timeoutMinutes } : {}),
  };
  const oneShotResult = await runOneShot(oneShotInput, deps.oneShot);

  // verdict 行 = stdout 最后一行非空（与 segments/verify.ts 的形状一致）。
  const lastLineOfStdout =
    oneShotResult.stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .at(-1) ?? '';
  const verdict: SegmentVerdict = judgeVerify(oneShotResult, { verdictLine: lastLineOfStdout });

  if (verdict.kind !== 'ok') {
    return {
      pass: false,
      problems: [`冷调用没跑成：${verdict.reason}`],
      notes: `家族 ${picked.family}（model ${picked.modelId}）`,
      round: parsed.round,
    };
  }

  const stdoutPieces = parseStdout(oneShotResult.stdout);
  const passed = /\bpass\b/i.test(stdoutPieces.verdictLine);
  const notes: string[] = [`家族 ${picked.family}（model ${picked.modelId}）`];
  if (stdoutPieces.droppedStyleNotes > 0) {
    notes.push(
      `模型另外提了 ${stdoutPieces.droppedStyleNotes} 条不属于三种能挡的意见，按 specs/555 不许算挡，已丢`,
    );
  }
  return {
    pass: passed,
    problems: stdoutPieces.problems,
    notes: notes.join('；'),
    round: parsed.round,
  };
}
