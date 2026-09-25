// 经插头起一个 Claude Code 会话来答判断题（构建期先用 Opus 5.5，走 Claude 订阅，套餐内）。
// 会话在一个一次性的空目录里跑，权限 dontAsk（要批准的工具一律拒），不给任何仓库和凭据；答完就收掉目录。
// 起一次会话要几秒到几十秒，适合分诊、质检、交活核实这类不赶时间的题；飞书这种要秒回的题用 TypeSafe。
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  type ClaudeEffort,
  runClaudeCode,
} from '@fleet-dao/adapters';
import {
  assertPinnedModel,
  type BackendAnswer,
  type BackendFailure,
  type BackendRequest,
  type BackendResult,
  estimateTokens,
  type JevBackend,
} from '../backend.ts';
import { scrubHead } from '../scrub.ts';

export interface ClaudeJudgeOptions {
  /** 起 reclaude 的命令（绝对路径）。没有默认值：谁要起真会话谁显式给。 */
  command: readonly string[];
  /** 钉死的具体型号，例如 claude-opus-5-5。 */
  model: string;
  /** 思考深度，默认 low：判断题不需要长考，快一点。 */
  effort?: ClaudeEffort;
  /** 放一次性空目录的地方，默认系统临时目录。 */
  workRoot?: string;
  /** 一次判断的总时长上限，默认 5 分钟（reclaude 首跑同步配置就可能要上百秒）。 */
  wallClockMs?: number;
  /** 宿主环境，默认 process.env（只会抄白名单里的键，见插头的 buildSessionEnv）。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 测试注入：换掉真的起会话。 */
  run?: (spec: ClaudeCodeRunSpec, options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunReport>;
}

export const CLAUDE_JUDGE_DEFAULT_WALL_MS = 5 * 60_000;

/** 判断题会话的系统提示：只答题，不动手。 */
export const CLAUDE_JUDGE_SYSTEM = [
  '你在当判断题模型：只根据用户消息里给的证据，回答里面的选择题。',
  '不要用任何工具，不要读文件，不要追问，也不要替证据补没写出来的事。',
  '每道题只能从给的选项 id 里选一个，并给出 0 到 1 之间的把握度：你有多确定这个选项是对的；拿不准就给低的。',
  '只输出一个 JSON 对象，不要任何别的文字：{"<题号>": {"option": "<选项 id>", "confidence": <0 到 1 的数>}, …}',
].join('\n');

/** 证据用标签包起来：证据原文里的 Markdown 标题不会和题目的结构搅在一起。 */
export function claudeJudgePrompt(request: BackendRequest): string {
  const evidence = request.evidence
    .map((e) => `<evidence name="${e.label.replace(/"/g, "'")}">\n${e.text}\n</evidence>`)
    .join('\n\n');
  const questions = request.questions
    .map((q) =>
      [`### ${q.id}`, q.instructions, '选项：', ...q.options.map((o) => `- ${o.id}：${o.criteria}`)].join(
        '\n',
      ),
    )
    .join('\n\n');
  const shape = request.questions.map((q) => `"${q.id}": {"option": "…", "confidence": 0.0}`).join(', ');
  return [
    `下面是 ${request.questions.length} 道选择题和一份证据。只根据证据作答。`,
    '## 证据',
    evidence,
    '## 题目',
    questions,
    `只输出一个 JSON 对象：{${shape}}`,
  ].join('\n\n');
}

/** 从会话最后的回复里取出 JSON 答案：先整段解析，不行就取第一个 { 到最后一个 } 之间。 */
export function parseClaudeAnswers(
  text: string,
  request: BackendRequest,
): { ok: true; answers: Record<string, BackendAnswer> } | { ok: false; why: string } {
  const trimmed = text.trim();
  let json: unknown;
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      json = JSON.parse(candidate);
      break;
    } catch {
      // 再试下一种
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // 回复可能照抄了证据里的令牌：先脱敏再截。
    return { ok: false, why: `回复里找不到 JSON：${scrubHead(trimmed, 200)}` };
  }
  const body = json as Record<string, unknown>;
  const answers: Record<string, BackendAnswer> = {};
  for (const q of request.questions) {
    if (!(q.id in body)) continue;
    const a = body[q.id];
    if (!a || typeof a !== 'object') {
      answers[q.id] = { invalid: '这道题的答案不是对象' };
      continue;
    }
    const { option, confidence } = a as Record<string, unknown>;
    if (typeof option !== 'string') answers[q.id] = { invalid: '没有 option' };
    else if (typeof confidence !== 'number') answers[q.id] = { invalid: '没有 confidence' };
    else answers[q.id] = { option, confidence };
  }
  return { ok: true, answers };
}

export function createClaudeJudgeBackend(options: ClaudeJudgeOptions): JevBackend {
  assertPinnedModel('claude-code', options.model);
  if (options.command.length === 0 || !options.command[0]) throw new Error('没给起 reclaude 的命令');
  const run = options.run ?? runClaudeCode;

  return {
    kind: 'claude-code',
    model: options.model,
    async ask(request: BackendRequest): Promise<BackendResult> {
      const prompt = claudeJudgePrompt(request);
      const started = Date.now();
      const fail = (reason: BackendFailure, detail: string, model?: string): BackendResult => ({
        ok: false,
        reason,
        detail,
        latencyMs: Date.now() - started,
        ...(model ? { model } : {}),
      });
      let dir: string | undefined;
      try {
        // 前缀和旧系统测试留在 /tmp 的 fleet-jev-* 分开，收尾查残留时一眼认得出是谁的。
        dir = await mkdtemp(join(options.workRoot ?? tmpdir(), 'fleet-jev-judge-'));
        const sessionId = randomUUID();
        const report = await run(
          {
            runId: `jev-${sessionId.slice(0, 8)}`,
            cwd: dir,
            prompt,
            model: options.model,
            session: { mode: 'new', id: sessionId },
            permissionMode: 'dontAsk',
            effort: options.effort ?? 'low',
            appendSystemPrompt: CLAUDE_JUDGE_SYSTEM,
            // 判断题会话不用 fleet 命令：给一个连不上的地址和一张空通行证。
            env: {
              base: options.env ?? process.env,
              fleetApi: 'http://127.0.0.1:9',
              fleetToken: 'jev-no-fleet',
            },
            limits: { wallClockMs: options.wallClockMs ?? CLAUDE_JUDGE_DEFAULT_WALL_MS },
          },
          { command: options.command, ...(request.signal ? { signal: request.signal } : {}) },
        );
        return toResult(report, request, prompt, fail, Date.now() - started);
      } catch (err) {
        return fail('backend_error', err instanceof Error ? err.message : String(err));
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function toResult(
  report: ClaudeCodeRunReport,
  request: BackendRequest,
  prompt: string,
  fail: (reason: BackendFailure, detail: string, model?: string) => BackendResult,
  latencyMs: number,
): BackendResult {
  const observed = report.stream.observedModel;
  if (report.spawnError) return fail('backend_error', `进程没起来：${report.spawnError}`);
  if (report.killed) {
    const why = report.killed.reason;
    if (why === 'model_mismatch')
      return fail('model_mismatch', `回话的是 ${observed ?? '（没读到）'}`, observed);
    if (why === 'startup_timeout' || why === 'wall_clock_timeout' || why === 'idle_timeout') {
      return fail('timeout', `会话被插头停了：${why}`);
    }
    return fail('backend_error', `会话被插头停了：${why}`);
  }
  if (report.stream.rateLimits.some((r) => r.exhausted)) return fail('quota', '账号池额度用满');
  const result = report.stream.result;
  if (!result) return fail('backend_error', `进程退出（退出码 ${report.exitCode}），没有终帧`);
  if (result.isError) {
    const status = result.apiErrorStatus;
    const detail = [result.terminalReason, report.stream.apiError?.code, status && `HTTP ${status}`]
      .filter((x) => x)
      .join(' · ');
    if (status === 429) return fail('rate_limited', detail);
    if (status === 401 || status === 403) return fail('auth', detail);
    if (status !== undefined && (status === 529 || status >= 500)) return fail('overloaded', detail);
    return fail('backend_error', detail || '会话报错');
  }
  const parsed = parseClaudeAnswers(result.text ?? '', request);
  if (!parsed.ok) return fail('bad_answer', parsed.why, observed);
  // 插头对终帧里没有的 token 字段不拿 0 顶上：读到几项加几项，一项都没有就按字数估。
  const usage = result.usage;
  const parts = [usage?.inputTokens, usage?.cacheReadInputTokens, usage?.cacheCreationInputTokens].filter(
    (n): n is number => typeof n === 'number',
  );
  const tokens = parts.length > 0 ? parts.reduce((sum, n) => sum + n, 0) : undefined;
  return {
    ok: true,
    answers: parsed.answers,
    // 没读到实际模型（极少见）就当没核对上：交给 ask 按对不上处理，不冒认。
    model: observed ?? '（没读到实际模型）',
    latencyMs,
    inputTokens: tokens && tokens > 0 ? tokens : estimateTokens([prompt]),
    tokensEstimated: !(tokens && tokens > 0),
  };
}
