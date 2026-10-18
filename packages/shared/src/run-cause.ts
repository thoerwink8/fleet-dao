// 一笔会话（runs 里的一行）为什么起，和冷验收的结论（#3140）。
// 引擎起会话时写（runs.cause / cause_summary / round_seq），任务页「过程」的每一笔照它写「为什么起」：
// 同一回合的动手会有好几笔——出方案、主写、补提交、自测红了再改、超时或起不来换路由重派、切号重跑、暂停后继续。
// 老记录没有这几列：读的一边写「老记录没记」，不拿「主写」顶。
// 这个文件不依赖 zod：任务工作流（Temporal 沙箱）也要 import 它（子路径 @fleet-dao/shared/run-cause）。
// 结论的 zod 校验在 run-verdict.ts。

/** 起因的取值（和库里 runs_cause_known 约束、引擎写的一字不差；packages/db/test 核对）。 */
export const RUN_CAUSES = [
  'plan',
  'main',
  'commit_nudge',
  'self_check_fix',
  'rework_ci',
  'rework_verify',
  'rework_review',
  'rework_conflict',
  'rework_no_commit',
  'rework_other',
  'retry',
  'reroute',
  'org_switch',
  'pause_resume',
  'repin',
  'human_continue',
] as const;
export type RunCause = (typeof RUN_CAUSES)[number];

/** 起因给人看的说法。 */
export const RUN_CAUSE_LABELS: Record<RunCause, string> = {
  plan: '出方案',
  main: '主写',
  commit_nudge: '补提交',
  self_check_fix: '自测红了再改',
  rework_ci: 'CI 红了返工',
  rework_verify: '验收没过返工',
  rework_review: '评审要求改',
  rework_conflict: '和主线冲突返工',
  rework_no_commit: '没提交返工',
  rework_other: '返工',
  retry: '原路重试',
  reroute: '换路由重派',
  org_switch: '切号重跑',
  pause_resume: '暂停后继续',
  repin: '现在就换模型',
  human_continue: '人点了继续',
};

/** 起因摘要（为什么、接着做什么）的字数上限：引擎写之前截到这么长，库里有同样的约束。 */
export const RUN_CAUSE_SUMMARY_MAX = 500;

/** 一句话截到上限（空白折成一个空格；超了末尾加省略号，总长不超过 max）。 */
export function clipCauseSummary(text: string, max = RUN_CAUSE_SUMMARY_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 冷验收的结论（runs.verdict，验收那一笔上）：过没过、哪几条没过（问题原话）、没过的是第几条验收条、
 * 转给人验的条（「不归我验」，#3037）。老记录没有。校验形状见 run-verdict.ts 的 RunVerdictSchema。
 */
export interface RunVerdict {
  pass: boolean;
  /** 没过的问题原话；过了是空。 */
  problems: string[];
  /** 从问题里认出的验收条编号（「第 N 条」，从 1 起）；认不出的不列。 */
  failedCriteria: number[];
  /** 转给人的条（outOfScope）：不算没过、不挡合并，收尾留着原单。 */
  handedOver: string[];
}

/** 从问题里抽出验收条编号（「第 N 条」）。同一个号只留一次，按出现先后。 */
export function criterionNumbersOf(problems: readonly string[]): number[] {
  const out: number[] = [];
  for (const problem of problems) {
    for (const match of problem.matchAll(/第\s*(\d+)\s*条/g)) {
      const n = Number(match[1]);
      if (n >= 1 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** 由验收结果算要进库的结论；每条问题截 300 字，最多 20 条。 */
export function verdictOf(res: {
  pass: boolean;
  problems?: readonly string[] | undefined;
  outOfScope?: readonly string[] | undefined;
}): RunVerdict {
  const clip = (s: string) => clipCauseSummary(s, 300);
  const problems = (res.problems ?? []).slice(0, 20).map(clip);
  return {
    pass: res.pass,
    problems: res.pass ? [] : problems,
    failedCriteria: res.pass ? [] : criterionNumbersOf(res.problems ?? []),
    handedOver: (res.outOfScope ?? []).slice(0, 20).map(clip),
  };
}
