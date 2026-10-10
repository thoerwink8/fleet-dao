import { fileURLToPath } from 'node:url';

/** 包目录（packages/agent-eval）。 */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
/** 仓根。 */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export interface Verdict {
  pass: boolean;
  reason: string;
  /** 只有用了 LLM 打分的题有（0–1）。 */
  score?: number;
}

/** 判不了（判分自己跑不起来、读不到、格式认不出）：记成「没跑成」，不当过也不当没过。 */
export class UngradableError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'UngradableError';
  }
}

export interface GradeContext {
  /** 被测会话的最终回答。 */
  answer: string;
  /** 会话干活的临时目录（夹具拷贝或仓快照）；判分可以读、可以在里面跑命令。 */
  workDir: string;
  /** 这道题在包里的目录（cases/<场景>/<题>）：里面的 hidden/ 是标准答案和藏起来的验收，不会拷进 workDir。 */
  caseDir: string;
  /** 一次 LLM 打分（裁判模型固定 claude-sonnet-5-5）；只有声明了 usesJudge 的题会用。 */
  judge: (prompt: string) => Promise<string>;
}

export type CaseSource = { kind: 'fixture' } | { kind: 'repo'; commit: string };

export interface EvalCase {
  /** `<场景>/<题名>`。 */
  id: string;
  scenario: string;
  /** 题名（目录名）。 */
  name: string;
  /** 用哪个子代理的定义（工具和正文）。 */
  agent: string;
  /** 给会话的提示词原文（走 stdin）。 */
  prompt: string;
  source: CaseSource;
  /** 种了什么（标准答案），给人看；不进临时目录。 */
  planted: string;
  /** 为什么能区分强弱。 */
  why: string;
  /** 判分用一次 LLM 打分（只有 architect 这道）。 */
  usesJudge?: boolean;
  grade: (ctx: GradeContext) => Promise<Verdict>;
}

/** 方案第三节：这两种要浏览器，自动探查不做。 */
export const SKIPPED_SCENARIOS: readonly { scenario: string; agent: string; reason: string }[] = [
  { scenario: 'ui-builder', agent: 'fleet-ui-builder', reason: '要浏览器，自动探查不做（靠截图人看）' },
  { scenario: 'ui-verifier', agent: 'fleet-ui-verifier', reason: '要浏览器，自动探查不做（靠截图人看）' },
];
