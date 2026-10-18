import { describe, expect, it } from 'vitest';
import {
  type ClaudeCodeRunReport,
  claudeErrorText,
  claudeRunFacts,
  judgeClaudeRun,
} from '../src/claude-code/run.ts';
import { ClaudeStreamReader } from '../src/claude-code/stream.ts';

const QUOTA = '拼车 5 小时额度已用完，约 20 分钟后重置';
function report(frames: unknown[], stderrTail = ''): ClaudeCodeRunReport {
  const reader = new ClaudeStreamReader({ runId: 'error-test', cwd: '/repo' });
  for (const frame of frames) reader.read(JSON.stringify(frame));
  return {
    runId: 'error-test',
    requestedModel: 'claude-opus-5-5',
    session: { mode: 'new', id: '00000000-0000-4000-8000-000000000001' },
    exitCode: 1,
    signal: null,
    stragglers: 0,
    leftovers: 0,
    stderrTail,
    startedAt: '2026-10-18T00:00:00Z',
    endedAt: '2026-10-18T00:00:01Z',
    wallMs: 1000,
    lines: frames.length,
    droppedLines: 0,
    stream: reader.summary(),
  };
}
const assistant = (text: string) => ({
  type: 'assistant',
  is_api_error_message: true,
  error: 'api_error',
  message: { content: [{ type: 'text', text }] },
});
const emptyResult = { type: 'result', is_error: true, terminal_reason: 'api_error', result: '' };

describe('Claude 错误通道保真和额度归因', () => {
  it.each([{ end: [] }, { end: [emptyResult] }])(
    '助手报错后空终帧 %j 和空 stderr 不能盖掉真实拒绝原文',
    ({ end }) => {
      const r = report([assistant(QUOTA), ...end]);
      expect(claudeErrorText(r)).toBe(QUOTA);
      expect(claudeRunFacts(r).lastWords).toBe(QUOTA);
      expect(judgeClaudeRun(r)).toMatchObject({ reason: 'quota_exhausted' });
    },
  );

  it('只有 stderr 的额度拒绝也保留原文，不依赖 JSON 限流帧', () => {
    const r = report([], QUOTA);
    expect(claudeErrorText(r)).toBe(QUOTA);
    expect(judgeClaudeRun(r).reason).toBe('quota_exhausted');
  });

  it.each([
    "You've hit your limit · resets 3pm (Asia/Shanghai)",
    "You've hit your 5-hour limit",
    'Claude AI session limit reached',
    'Monthly limit reached',
  ])('官方订阅额度说法 %j 认作额度用完，不当成探不通', (text) => {
    const r = report([assistant(text), emptyResult]);
    expect(claudeRunFacts(r).quotaExhausted).toBe(true);
    expect(judgeClaudeRun(r)).toMatchObject({ reason: 'quota_exhausted' });
  });

  it('服务端临时限流的否定句不当额度', () => {
    const r = report([
      assistant('Server is temporarily limiting requests (not your usage limit)'),
      emptyResult,
    ]);
    expect(claudeRunFacts(r).quotaExhausted).toBe(false);
  });

  it('标准限流帧仍按既有 exhausted 判据，保留上游重置时间', () => {
    const resetsAt = 1792281600;
    const r = report([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
      },
      emptyResult,
    ]);
    expect(judgeClaudeRun(r).reason).toBe('quota_exhausted');
    expect(r.stream.rateLimits[0]?.resetsAt).toBe(new Date(resetsAt * 1000).toISOString());
  });

  it.each([
    'authentication failed: please login',
    'ECONNRESET: upstream unavailable',
    '429 rate limited (not your usage limit)',
    'unexpected internal error',
  ])('认证、网络、临时限流或未知故障不能统统当额度：%s', (text) => {
    const r = report([assistant(text), emptyResult]);
    expect(claudeRunFacts(r).quotaExhausted).toBe(false);
    expect(judgeClaudeRun(r)).toMatchObject({ reason: 'agent_error', detail: expect.stringContaining(text) });
  });

  it('失败后重试成功，回答中讨论额度不能触发额度故障', () => {
    const r = report([
      assistant(QUOTA),
      { type: 'result', is_error: false, result: '已修复 usage limit 的测试。' },
    ]);
    r.exitCode = 0;
    expect(claudeErrorText(r)).toBeUndefined();
    expect(claudeRunFacts(r).quotaExhausted).toBe(false);
    expect(judgeClaudeRun(r).outcome).toBe('ok');
  });

  it('错误中夹带的 Bearer、API Key 和查询令牌不进入新增公开诊断', () => {
    const secret = 'secret-token-example-123';
    const r = report([
      assistant(
        `${QUOTA}\nAuthorization: Bearer ${secret}\nrck_secretapikey123\nhttps://example.invalid/?token=${secret}`,
      ),
      emptyResult,
    ]);
    const text = JSON.stringify(claudeRunFacts(r));
    expect(text).toContain('额度已用完');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('rck_secretapikey123');
  });
});
