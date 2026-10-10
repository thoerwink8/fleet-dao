// 跑一道题（一个场景 × 一个模型）：备临时目录 → 起无头会话 → 读 stream-json → 判分 → 记一条结果。
// 起不来、超时、读不到、格式认不出、判分自己判不了：记「没跑成」和原因，不当没过、也不当过。
import type { AgentDefinition } from './definitions.ts';
import type { Launcher } from './launcher.ts';
import {
  buildJudgeArgs,
  buildSessionArgs,
  DEFAULT_MAX_TURNS,
  MODEL_IDS,
  type ModelKey,
  SESSION_TIMEOUT_MS,
} from './launcher.ts';
import { modelMatches, parseStream, StreamFormatError } from './stream.ts';
import type { EvalCase, Verdict } from './types.ts';
import { UngradableError } from './types.ts';
import { caseDirOf, prepareWorkspace, type Workspace } from './workspace.ts';

export const OUTPUT_LIMIT = 20_000;

/** model-mismatch：会话实际用的模型和点名的对不上，不算过也不算没过。 */
export type Status = 'pass' | 'fail' | 'not-run' | 'model-mismatch';

export interface CaseResult {
  caseId: string;
  scenario: string;
  agent: string;
  model: ModelKey;
  modelId: string;
  status: Status;
  /** 过没过；没跑成是 null。 */
  pass: boolean | null;
  /** 判分理由；没跑成时是没跑成的原因。 */
  reason: string;
  score?: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 定义里的 maxTurns（没写是 null）：只记录，命令行没有限回合的参数，实际只靠限时。 */
  maxTurns: number | null;
  /** 给会话的回合上限：定义的 maxTurns，没写的 40（见 launcher.ts 头注：只是记录）。 */
  turnBudget: number;
  numTurns: number | null;
  prompt: string;
  output: string;
  outputTruncated: boolean;
  judgeUsed: boolean;
  /** 会话实际用的模型：取第一条主会话 assistant 帧的，读不到退 init 帧的，都没有是 null。 */
  observedModel: string | null;
  initModel: string | null;
  assistantModel: string | null;
}

export interface RunDeps {
  launch: Launcher;
  defs: ReadonlyMap<string, AgentDefinition>;
  command: string;
  timeoutMs?: number;
  tmpRoot?: string;
  now?: () => number;
  /** 测试里换掉备临时目录这一步。 */
  prepare?: (c: EvalCase) => Workspace;
}

export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_LIMIT) return { text, truncated: false };
  return {
    text: `${text.slice(0, OUTPUT_LIMIT)}\n…[已截断：原文 ${text.length} 字，这里留前 ${OUTPUT_LIMIT} 字]`,
    truncated: true,
  };
}

/** 一次 LLM 打分：裁判会话没返回可用结果就抛 UngradableError。 */
async function askJudge(deps: RunDeps, cwd: string, prompt: string): Promise<string> {
  const r = await deps.launch({
    command: deps.command,
    args: buildJudgeArgs(),
    stdin: prompt,
    cwd,
    timeoutMs: deps.timeoutMs ?? SESSION_TIMEOUT_MS,
  });
  if (r.spawnError) throw new UngradableError(`裁判会话起不来：${r.spawnError}`);
  if (r.timedOut) throw new UngradableError('裁判会话超时');
  try {
    const s = parseStream(r.stdout);
    if (s.isError) throw new UngradableError(`裁判会话报错：${s.subtype ?? '未知'}`);
    return s.answer;
  } catch (e) {
    if (e instanceof StreamFormatError) throw new UngradableError(`裁判输出认不出：${e.message}`);
    throw e;
  }
}

export async function runCase(c: EvalCase, model: ModelKey, deps: RunDeps): Promise<CaseResult> {
  const now = deps.now ?? Date.now;
  const def = deps.defs.get(c.agent);
  const modelId = MODEL_IDS[model];
  const base: CaseResult = {
    caseId: c.id,
    scenario: c.scenario,
    agent: c.agent,
    model,
    modelId,
    status: 'not-run',
    pass: null,
    reason: '',
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    maxTurns: def?.maxTurns ?? null,
    turnBudget: def?.maxTurns ?? DEFAULT_MAX_TURNS,
    numTurns: null,
    prompt: c.prompt,
    output: '',
    outputTruncated: false,
    judgeUsed: false,
    observedModel: null,
    initModel: null,
    assistantModel: null,
  };
  const notRun = (reason: string, extra: Partial<CaseResult> = {}): CaseResult => ({
    ...base,
    ...extra,
    reason,
  });
  if (!def) return notRun(`没找到子代理定义 ${c.agent}`);

  let ws: Workspace;
  try {
    ws = (deps.prepare ?? ((x) => prepareWorkspace(x, deps.tmpRoot)))(c);
  } catch (e) {
    return notRun(`备临时目录失败：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const t0 = now();
    const r = await deps.launch({
      command: deps.command,
      args: buildSessionArgs(def, modelId),
      stdin: c.prompt,
      cwd: ws.dir,
      timeoutMs: deps.timeoutMs ?? SESSION_TIMEOUT_MS,
    });
    const durationMs = now() - t0;
    if (r.spawnError) return notRun(`会话起不来：${r.spawnError}`, { durationMs });
    if (r.timedOut)
      return notRun(`超过 ${(deps.timeoutMs ?? SESSION_TIMEOUT_MS) / 60_000} 分钟限时，被杀掉`, {
        durationMs,
      });
    let summary: ReturnType<typeof parseStream>;
    try {
      summary = parseStream(r.stdout);
    } catch (e) {
      const why = e instanceof StreamFormatError ? e.message : String(e);
      return notRun(
        `输出认不出（退出码 ${String(r.exitCode)}）：${why}；stderr 尾部：${r.stderr.trim().slice(-300)}`,
        {
          durationMs,
        },
      );
    }
    const observedModel = summary.assistantModel ?? summary.initModel;
    const out = truncateOutput(summary.answer);
    const seen = {
      durationMs,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      numTurns: summary.numTurns ?? null,
      output: out.text,
      outputTruncated: out.truncated,
      observedModel,
      initModel: summary.initModel,
      assistantModel: summary.assistantModel,
    };
    if (summary.isError) return notRun(`会话自己报错：${summary.subtype ?? '未知'}`, seen);
    if (observedModel !== null && !modelMatches(modelId, observedModel)) {
      return {
        ...base,
        ...seen,
        status: 'model-mismatch',
        reason: `点名 ${modelId}，实际用的是 ${observedModel}，没判分`,
      };
    }

    let judgeUsed = false;
    let verdict: Verdict;
    try {
      verdict = await c.grade({
        answer: summary.answer,
        workDir: ws.dir,
        caseDir: caseDirOf(c),
        judge: (p) => {
          judgeUsed = true;
          return askJudge(deps, ws.dir, p);
        },
      });
    } catch (e) {
      if (e instanceof UngradableError) return notRun(`判分判不了：${e.message}`, { ...seen, judgeUsed });
      throw e;
    }
    return {
      ...base,
      ...seen,
      status: verdict.pass ? 'pass' : 'fail',
      pass: verdict.pass,
      reason: observedModel === null ? `${verdict.reason}；没读到实际模型` : verdict.reason,
      ...(verdict.score === undefined ? {} : { score: verdict.score }),
      judgeUsed,
    };
  } finally {
    ws.cleanup();
  }
}
