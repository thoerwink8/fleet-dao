// 解析器对着真跑夹具测。夹具：2026-09-25 法国 VPS，reclaude + Claude Code 2.1.281，haiku-4-5 与 opus-5-5 各跑的极小会话；
// 脱敏只动了家目录里的用户名和 signature（signature 里编着账号级编号）。帧形状有疑问时回看夹具原文。
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ClaudeLineEffect,
  ClaudeStreamReader,
  sameModel,
  versionAtLeast,
} from '../src/claude-code/stream.ts';
import type { FilePayload, SayPayload, TestPayload, ToolPayload } from '../src/types.ts';
import { fixtureFrames, fixtureInit, fixtureLines } from './helpers.ts';

const NOW = new Date('2026-09-25T00:00:00.000Z');

function readAll(name: string, testCommands?: string[]) {
  const { cwd } = fixtureInit(name);
  const reader = new ClaudeStreamReader({
    runId: 'run-1',
    cwd,
    ...(testCommands ? { testCommands } : {}),
    now: () => NOW,
  });
  const effects: ClaudeLineEffect[] = fixtureLines('claude-code', name).map((l) => reader.read(l));
  const events = effects.flatMap((e) => e.events);
  return { reader, effects, events, summary: reader.summary() };
}

const ofKind = <T>(events: ProgressEvent[], kind: string) =>
  events.filter((e) => e.kind === kind).map((e) => e.payload as T);

/** 终帧的用量直接从夹具原文取，不经被测的解析器。 */
function rawUsage(name: string) {
  const result = fixtureFrames('claude-code', name).find((f) => f.type === 'result') as {
    usage: Record<string, number>;
    total_cost_usd: number;
  };
  return {
    usage: {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadInputTokens: result.usage.cache_read_input_tokens,
      cacheCreationInputTokens: result.usage.cache_creation_input_tokens,
    },
    costUsd: result.total_cost_usd,
  };
}

describe('ClaudeStreamReader · 真跑夹具', () => {
  it('读文件：一条读工具调用、一句回复、终帧用量与花费、会话号、实际模型', () => {
    const { events, summary } = readAll('cc-haiku-read');
    expect(ofKind<ToolPayload>(events, 'tool')).toEqual([
      {
        phase: 'start',
        toolUseId: 'toolu_01SggLj3NCU3w4UJcUikKVDy',
        tool: 'Read',
        action: 'read',
        summary: 'hello.txt',
      },
      {
        phase: 'end',
        toolUseId: 'toolu_01SggLj3NCU3w4UJcUikKVDy',
        tool: 'Read',
        action: 'read',
        summary: 'hello.txt',
        ok: true,
      },
    ]);
    expect(ofKind<SayPayload>(events, 'say')).toEqual([{ text: 'hello fleet', source: 'stream' }]);
    expect(events.every((e) => e.runId === 'run-1' && e.at === NOW.toISOString())).toBe(true);
    expect(summary.sessionId).toBe(fixtureInit('cc-haiku-read').sessionId);
    expect(summary.initModel).toBe('claude-haiku-4-5-20251001');
    expect(summary.observedModel).toBe('claude-haiku-4-5-20251001');
    expect(summary.cliVersion).toBe('2.1.281');
    expect(summary.startedWork).toBe(true);
    expect(summary.result).toMatchObject({
      isError: false,
      subtype: 'success',
      terminalReason: 'completed',
      text: 'hello fleet',
      numTurns: 2,
      ...rawUsage('cc-haiku-read'),
      models: ['claude-haiku-4-5-20251001'],
      permissionDenials: 0,
    });
    expect(summary.filesChanged).toEqual([]);
  });

  it('改文件：先读后改，改成功才报 file 事件，路径是工作树内的相对路径', () => {
    const { events, summary } = readAll('cc-haiku-edit');
    const starts = ofKind<ToolPayload>(events, 'tool').filter((t) => t.phase === 'start');
    expect(starts.map((t) => [t.tool, t.action, t.summary])).toEqual([
      ['Read', 'read', 'notes.md'],
      ['Edit', 'edit', 'notes.md'],
    ]);
    expect(ofKind<FilePayload>(events, 'file')).toEqual([{ path: 'notes.md', tool: 'Edit' }]);
    expect(summary.filesChanged).toEqual(['notes.md']);
    expect(summary.toolCalls).toBe(2);
    expect(summary.toolErrors).toBe(0);
  });

  it('新建文件（Write）也报 file 事件', () => {
    const { events } = readAll('cc-haiku-write');
    expect(ofKind<FilePayload>(events, 'file')).toEqual([{ path: 'plan.md', tool: 'Write' }]);
  });

  it('跑命令：摘要是命令原文，带上助手写的说明；含仓库测试命令的记成一次测试', () => {
    const { events, summary } = readAll('cc-haiku-bash', ['git status']);
    const [start] = ofKind<ToolPayload>(events, 'tool');
    expect(start).toMatchObject({
      tool: 'Bash',
      action: 'run',
      summary: 'ls -1 && git status --short',
      description: 'List files in the current directory and show git status',
    });
    expect(ofKind<TestPayload>(events, 'test')).toEqual([
      { command: 'ls -1 && git status --short', ok: true },
    ]);
    expect(summary.testRuns).toHaveLength(1);
  });

  it('命令非零退出：工具结束 ok=false 带原文，测试记成失败', () => {
    const { events, summary } = readAll('cc-haiku-bash-fail', ['ls missing-dir']);
    const end = ofKind<ToolPayload>(events, 'tool').find((t) => t.phase === 'end');
    expect(end?.ok).toBe(false);
    expect(end?.error).toContain('Exit code 2');
    expect(ofKind<TestPayload>(events, 'test')).toEqual([{ command: 'ls missing-dir', ok: false }]);
    expect(summary.toolErrors).toBe(1);
    expect(summary.result?.isError).toBe(false);
  });

  it('命令超时（BASH_DEFAULT_TIMEOUT_MS=4000 时跑 sleep 12）：工具失败、退出码 143，中间的 task_* 系统帧不打扰', () => {
    const { events, summary } = readAll('cc-haiku-bash-timeout');
    const end = ofKind<ToolPayload>(events, 'tool').find((t) => t.phase === 'end');
    expect(end).toMatchObject({ tool: 'Bash', summary: 'sleep 12; echo slept', ok: false });
    expect(end?.error).toContain('Exit code 143');
    expect(summary.result?.text).toContain('Command timed out after 4s');
    expect(summary.unknownFrames).toEqual({});
  });

  it('工具报错（读不存在的文件）只算工具失败，会话照常完成', () => {
    const { events, summary } = readAll('cc-haiku-tool-error');
    const end = ofKind<ToolPayload>(events, 'tool').find((t) => t.phase === 'end');
    expect(end).toMatchObject({ tool: 'Read', ok: false });
    expect(end?.error).toContain('File does not exist');
    expect(summary.toolErrors).toBe(1);
    expect(summary.result?.isError).toBe(false);
  });

  it('权限被拒：记下被拒的工具，终帧也数到一次', () => {
    const { summary } = readAll('cc-haiku-perm-denied');
    expect(summary.permissionDenials).toEqual([
      {
        tool: 'Bash',
        toolUseId: 'toolu_01MmePwgMy5HVYwesWb8rMwo',
        reason: 'no approval surface in this session; permission request denied automatically',
      },
    ]);
    expect(summary.result?.permissionDenials).toBe(1);
    expect(summary.toolErrors).toBe(1);
  });

  it('模型不存在：init 照样回显请求的模型，助手消息是 <synthetic>，终帧 is_error 但 subtype 仍是 success', () => {
    const { events, summary } = readAll('cc-bad-model');
    expect(summary.initModel).toBe('claude-nonexistent-0');
    expect(summary.observedModel).toBeUndefined();
    expect(summary.apiError?.code).toBe('model_not_found');
    expect(summary.result).toMatchObject({
      isError: true,
      subtype: 'success',
      terminalReason: 'api_error',
      apiErrorStatus: 404,
    });
    expect(events).toEqual([]);
    expect(summary.startedWork).toBe(false);
  });

  it('opus-5-5：用 Bash 改的文件从 bashEditDiff 读出来', () => {
    const { events, summary } = readAll('cc-opus-edit-bash');
    expect(summary.observedModel).toBe('claude-opus-5-5');
    expect(ofKind<FilePayload>(events, 'file')).toEqual([{ path: 'notes.md', tool: 'Bash' }]);
    expect(summary.tools).not.toContain('TodoWrite');
    expect(summary.tools).not.toContain('TaskCreate');
  });

  it('续会话：两次记录的会话号相同，第二次回答用到了第一次的上下文（391 → 392）', () => {
    const a = readAll('cc-haiku-resume-a').summary;
    const b = readAll('cc-haiku-resume-b').summary;
    expect(b.sessionId).toBe(a.sessionId);
    expect(a.result?.text).toBe('391');
    expect(b.result?.text).toBe('392');
  });

  it('额度读数：5 小时窗与 7 天窗的利用率和清零时间', () => {
    const { summary } = readAll('cc-haiku-read');
    expect(summary.rateLimits).toEqual([
      {
        status: 'allowed',
        exhausted: false,
        rateLimitType: 'five_hour',
        resetsAt: new Date(1790276400 * 1000).toISOString(),
        windows: [
          {
            name: 'five_hour',
            kind: '5h',
            utilization: 0.26,
            resetsAt: new Date(1790276400 * 1000).toISOString(),
          },
          {
            name: 'seven_day',
            kind: '7d',
            utilization: 0.07,
            resetsAt: new Date(1790452800 * 1000).toISOString(),
          },
        ],
        observedAt: NOW.toISOString(),
      },
    ]);
  });

  it('哪些帧算「在干活」：助手、工具结果、思考帧算；init、额度帧不算', () => {
    const { effects } = readAll('cc-haiku-read');
    const frames = fixtureFrames('claude-code', 'cc-haiku-read');
    const byType = frames.map((f, i) => [
      `${f.type}${f.subtype ? `/${f.subtype}` : ''}`,
      effects[i]?.activity,
    ]);
    expect(byType).toEqual([
      ['system/init', false],
      ['system/thinking_tokens', true],
      ['system/thinking_tokens', true],
      ['assistant', true],
      ['assistant', true],
      ['rate_limit_event', false],
      ['user', true],
      ['assistant', true],
      ['assistant', true],
      ['result/success', true],
    ]);
  });

  it('工具在跑时 toolsInFlight 为 1，结果回来归零', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/tmp/fleet-fx/w-read' });
    const lines = fixtureLines('claude-code', 'cc-haiku-read');
    const counts = lines.map((l) => {
      reader.read(l);
      return reader.toolsInFlight;
    });
    expect(counts).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
  });
});

describe('ClaudeStreamReader · 夹具里没有的帧（手造，依据写在用例里）', () => {
  it('额度用满：status=rejected 且没有 unifiedWindows，照样判用满并记清零时间（审计 CC-05，2026-09-23 实测形状）', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w', now: () => NOW });
    const effect = reader.read(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1790276400,
          rateLimitType: 'five_hour',
          isUsingOverage: false,
        },
      }),
    );
    expect(effect.rateLimit).toMatchObject({
      status: 'rejected',
      exhausted: true,
      resetsAt: new Date(1790276400 * 1000).toISOString(),
      windows: [],
    });
    expect(effect.activity).toBe(false);
  });

  it('上游重试帧只计数，不算开工也不算在干活（审计里 2.1.281 本机实跑的原文）', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w' });
    const effect = reader.read(
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":553,"error_status":null,"error":"unknown"}',
    );
    expect(effect.activity).toBe(false);
    expect(reader.summary()).toMatchObject({
      apiRetries: 1,
      lastApiRetry: { attempt: 1, maxRetries: 10, error: 'unknown' },
      startedWork: false,
    });
  });

  it('不是 JSON 的行和认不出的帧只计数，不抛错', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w' });
    reader.read('Syncing config…');
    reader.read('{"type":"stream_event","event":{}}');
    reader.read('   ');
    expect(reader.summary()).toMatchObject({
      nonJsonLines: 1,
      nonJsonSample: 'Syncing config…',
      unknownFrames: { stream_event: 1 },
      frames: 1,
    });
  });
});

describe('sameModel / versionAtLeast', () => {
  it('点具体 id，回来带日期后缀也算同一个；点别名核对不上', () => {
    expect(sameModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(sameModel('claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
    expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true);
    expect(sameModel('claude-opus-5-5', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(sameModel('haiku', 'claude-haiku-4-5-20251001')).toBe(false);
  });

  it('版本比较；认不出的版本号给 undefined，不冒充够新或太旧', () => {
    expect(versionAtLeast('2.1.281', '2.1.277')).toBe(true);
    expect(versionAtLeast('2.1.277', '2.1.277')).toBe(true);
    expect(versionAtLeast('2.1.260', '2.1.277')).toBe(false);
    expect(versionAtLeast('2.0.999', '2.1.0')).toBe(false);
    expect(versionAtLeast('dev', '2.1.277')).toBeUndefined();
  });
});
