// 经插头起 Claude 会话答判断题：提示词怎么拼、答案怎么取、插头的各种结局怎么变成「没判」的原因。起会话用注入的假实现，不起真执行体。
import { existsSync } from 'node:fs';
import type { ClaudeCodeRunReport, ClaudeCodeRunSpec, ClaudeStreamSummary } from '@fleet-dao/adapters';
import { describe, expect, it } from 'vitest';
import type { BackendRequest } from '../src/backend.ts';
import {
  CLAUDE_JUDGE_SYSTEM,
  claudeJudgePrompt,
  createClaudeJudgeBackend,
  parseClaudeAnswers,
} from '../src/backends/claude.ts';

const request: BackendRequest = {
  questions: [
    {
      id: 'triage-ui',
      instructions: '做这条需求要不要改用户看得见的界面？',
      options: [
        { id: 'ui', criteria: '要改界面' },
        { id: 'no_ui', criteria: '不改界面' },
      ],
    },
    {
      id: 'triage-gate',
      instructions: '会不会碰人闸？',
      options: [
        { id: 'none', criteria: '都不碰' },
        { id: 'money', criteria: '花钱' },
      ],
    },
  ],
  evidence: [{ label: '需求原文', text: '# 标题\n给看板加一个额度页' }],
};

function summary(over: Partial<ClaudeStreamSummary> = {}): ClaudeStreamSummary {
  return {
    startedWork: true,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
    permissionDenials: [],
    apiRetries: 0,
    rateLimits: [],
    frames: 5,
    nonJsonLines: 0,
    unknownFrames: {},
    observedModel: 'claude-opus-5-5',
    ...over,
  };
}

function report(spec: ClaudeCodeRunSpec, over: Partial<ClaudeCodeRunReport> = {}, text?: string) {
  const base: ClaudeCodeRunReport = {
    exitCode: 0,
    signal: null,
    stragglers: 0,
    leftovers: 0,
    stderrTail: '',
    startedAt: '2026-09-25T00:00:00.000Z',
    endedAt: '2026-09-25T00:00:09.000Z',
    wallMs: 9000,
    lines: 5,
    droppedLines: 0,
    runId: spec.runId,
    requestedModel: spec.model,
    session: spec.session,
    stream: summary({
      result: {
        isError: false,
        text:
          text ??
          '{"triage-ui": {"option": "ui", "confidence": 0.86}, "triage-gate": {"option": "none", "confidence": 0.95}}',
        usage: {
          inputTokens: 1200,
          outputTokens: 40,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 0,
        },
        models: ['claude-opus-5-5'],
        permissionDenials: 0,
      },
    }),
  };
  return { ...base, ...over };
}

function backendWith(make: (spec: ClaudeCodeRunSpec) => ClaudeCodeRunReport) {
  const specs: ClaudeCodeRunSpec[] = [];
  const commands: (readonly string[])[] = [];
  const backend = createClaudeJudgeBackend({
    command: ['/opt/reclaude'],
    model: 'claude-opus-5-5',
    env: { PATH: '/usr/bin' },
    run: async (spec, options) => {
      specs.push(spec);
      commands.push(options.command);
      expect(existsSync(spec.cwd)).toBe(true);
      return make(spec);
    },
  });
  return { backend, specs, commands };
}

describe('Claude 会话后端', () => {
  it('在一次性空目录里起会话：钉死模型、dontAsk、低思考深度、判断题系统提示；答完目录收掉', async () => {
    const { backend, specs, commands } = backendWith((spec) => report(spec));
    const result = await backend.ask(request);
    expect(result).toMatchObject({
      ok: true,
      model: 'claude-opus-5-5',
      answers: {
        'triage-ui': { option: 'ui', confidence: 0.86 },
        'triage-gate': { option: 'none', confidence: 0.95 },
      },
      inputTokens: 1500,
      tokensEstimated: false,
    });
    const spec = specs[0];
    expect(commands[0]).toEqual(['/opt/reclaude']);
    expect(spec).toMatchObject({
      model: 'claude-opus-5-5',
      permissionMode: 'dontAsk',
      effort: 'low',
      appendSystemPrompt: CLAUDE_JUDGE_SYSTEM,
      session: { mode: 'new' },
    });
    expect(spec?.prompt).toBe(claudeJudgePrompt(request));
    expect(existsSync(spec?.cwd ?? '')).toBe(false);
  });

  it('提示词：证据包在标签里原样放进去，每道题带全部选项，末尾说清只回 JSON', () => {
    const prompt = claudeJudgePrompt(request);
    expect(prompt).toContain('<evidence name="需求原文">\n# 标题\n给看板加一个额度页\n</evidence>');
    expect(prompt).toContain('### triage-ui');
    expect(prompt).toContain('- no_ui：不改界面');
    expect(prompt).toContain('- money：花钱');
    expect(prompt.trim().endsWith('}')).toBe(true);
  });

  it('答案夹在别的文字或代码块里也能取出来；缺题、形状不对的分开标', () => {
    const fenced =
      '```json\n{"triage-ui": {"option": "no_ui", "confidence": 0.7}, "triage-gate": "none"}\n```';
    expect(parseClaudeAnswers(fenced, request)).toEqual({
      ok: true,
      answers: {
        'triage-ui': { option: 'no_ui', confidence: 0.7 },
        'triage-gate': { invalid: '这道题的答案不是对象' },
      },
    });
    expect(parseClaudeAnswers('我觉得是 ui', request)).toMatchObject({ ok: false });
  });

  it('回复里找不到 JSON：原文先脱敏再截，照抄了证据里的令牌也不会截成半截留下', () => {
    const reply = `${'说'.repeat(190)} ${'K'.repeat(60)} 完`;
    const parsed = parseClaudeAnswers(reply, request);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.why).toContain('<长串>');
      expect(parsed.why).not.toContain('KKKK');
    }
  });

  it('插头的结局变成没判的原因', async () => {
    const cases: [string, (spec: ClaudeCodeRunSpec) => ClaudeCodeRunReport, string][] = [
      [
        '模型对不上被停',
        (s) =>
          report(s, {
            killed: { reason: 'model_mismatch', at: 'x' },
            stream: summary({ observedModel: 'claude-sonnet-5' }),
          }),
        'model_mismatch',
      ],
      ['起不来', (s) => report(s, { killed: { reason: 'startup_timeout', at: 'x' } }), 'timeout'],
      ['总时长到顶', (s) => report(s, { killed: { reason: 'wall_clock_timeout', at: 'x' } }), 'timeout'],
      ['进程没起来', (s) => report(s, { spawnError: 'ENOENT' }), 'backend_error'],
      [
        '额度用满',
        (s) =>
          report(s, {
            stream: summary({
              rateLimits: [{ status: 'rejected', exhausted: true, windows: [], observedAt: 'x' }],
            }),
          }),
        'quota',
      ],
      ['没有终帧', (s) => report(s, { stream: summary() }), 'backend_error'],
      [
        '接口 429',
        (s) =>
          report(s, {
            stream: summary({
              result: { isError: true, apiErrorStatus: 429, models: [], permissionDenials: 0 },
            }),
          }),
        'rate_limited',
      ],
      [
        '接口 529',
        (s) =>
          report(s, {
            stream: summary({
              result: { isError: true, apiErrorStatus: 529, models: [], permissionDenials: 0 },
            }),
          }),
        'overloaded',
      ],
      ['回复不是 JSON', (s) => report(s, {}, '好的，我看完了。'), 'bad_answer'],
    ];
    for (const [what, make, reason] of cases) {
      const { backend } = backendWith(make);
      expect(await backend.ask(request), what).toMatchObject({ ok: false, reason });
    }
  });

  it('起会话抛异常（例如工作目录没了）：不往外抛，当没判', async () => {
    const backend = createClaudeJudgeBackend({
      command: ['/opt/reclaude'],
      model: 'claude-opus-5-5',
      run: async () => {
        throw new Error('工作目录不存在');
      },
    });
    expect(await backend.ask(request)).toMatchObject({ ok: false, reason: 'backend_error' });
  });

  it('模型要钉死到具体型号，别名不行；没给命令不行', () => {
    for (const model of ['opus', 'claude-opus-latest', 'sonnet']) {
      expect(() => createClaudeJudgeBackend({ command: ['/opt/reclaude'], model })).toThrow();
    }
    expect(() => createClaudeJudgeBackend({ command: [], model: 'claude-opus-5-5' })).toThrow(/命令/);
  });

  it('测试里不会起真的 reclaude：插头自己会拒（这里走真的起会话函数）', async () => {
    const backend = createClaudeJudgeBackend({
      command: ['/usr/local/bin/reclaude'],
      model: 'claude-opus-5-5',
    });
    const result = await backend.ask(request);
    expect(result).toMatchObject({ ok: false, reason: 'backend_error' });
    if (!result.ok) expect(result.detail).toMatch(/测试里不许起真的执行体/);
  });
});
