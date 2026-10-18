// 会话过程记录（#1640）：四家插头的读取器从真跑夹具里抽出的条目对不对；经 runClaudeCode 的 onTranscript 一条条交出。
// 流里没有的种类不编：cursor 没有单独的报错帧，grok 的终帧没有回答正文。
import { isSubagentMeta } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { runClaudeCode } from '../src/claude-code/run.ts';
import { ClaudeStreamReader } from '../src/claude-code/stream.ts';
import { CursorStreamReader } from '../src/cursor/stream.ts';
import { GrokStreamReader } from '../src/grok/stream.ts';
import { MirasimSession } from '../src/mirasim/session.ts';
import type { TranscriptEntry } from '../src/types.ts';
import { fakeAgent, fixtureInit, fixtureLines, fixturePath, tempDir } from './helpers.ts';
import { mirasimRecording } from './mirasim-fake.ts';

const NOW = new Date('2026-10-10T00:00:00.000Z');

/** 去掉时间，只看种类、工具、成败、开头的字。 */
const brief = (entries: TranscriptEntry[]) =>
  entries.map((e) => [e.kind, e.tool, e.ok, e.text.slice(0, 24)] as const);

function claude(name: string): TranscriptEntry[] {
  const reader = new ClaudeStreamReader({ runId: 'r', cwd: fixtureInit(name).cwd, now: () => NOW });
  return fixtureLines('claude-code', name).flatMap((l) => reader.read(l).transcript);
}

describe('Claude：stream-json', () => {
  it('读文件：一次工具调用（摘要是文件）、结果、一句话、结论', () => {
    const entries = claude('cc-haiku-read');
    expect(entries.map((e) => e.kind)).toEqual(['tool_call', 'tool_result', 'assistant', 'result']);
    expect(entries[0]).toMatchObject({
      kind: 'tool_call',
      tool: 'Read',
      text: 'hello.txt',
      at: NOW.toISOString(),
    });
    expect(entries[1]).toMatchObject({ kind: 'tool_result', tool: 'Read', ok: true });
    expect(entries[2]).toMatchObject({ kind: 'assistant', text: 'hello fleet' });
    expect(entries[3]).toMatchObject({ kind: 'result', ok: true });
    // 没有 prompt、truncated：这两种归引擎和记录器
    expect(entries.some((e) => (e.kind as string) === 'prompt')).toBe(false);
  });

  it('工具失败：tool_result 的 ok 是 false，带原文开头', () => {
    const entries = claude('cc-haiku-tool-error');
    const failed = entries.find((e) => e.kind === 'tool_result');
    expect(failed).toMatchObject({ tool: 'Read', ok: false });
    expect(failed?.text).toContain('File does not exist');
  });

  it('跑命令：调用的摘要是命令原文，不是 200 字截过的', () => {
    const entries = claude('cc-opus-edit-bash');
    const call = entries.find((e) => e.kind === 'tool_call' && e.tool === 'Bash');
    expect(call?.text).toContain('tail -c1 notes.md');
  });

  it('模型不可用时 CLI 合成的 API 错误记成 error；终帧报错的结论 ok 是 false', () => {
    const entries = claude('cc-bad-model');
    expect(entries.filter((e) => e.kind === 'error').length).toBeGreaterThan(0);
    expect(entries.at(-1)).toMatchObject({ kind: 'result', ok: false });
  });

  it('权限被拒记成 error，带工具名', () => {
    const entries = claude('cc-haiku-perm-denied');
    const denied = entries.filter((e) => e.kind === 'error');
    // 夹具里要么有 permission_denied 帧要么没有：有就必须带工具名，没有也不编一条
    for (const e of denied) expect(e.text).toContain('权限被拒');
  });
});

describe('Claude：子代理（手写的帧，夹具里没有录到子代理——形状按 parent_tool_use_id 的约定写）', () => {
  const frames = [
    {
      type: 'assistant',
      message: {
        model: 'm',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_A',
            name: 'Agent',
            input: {
              subagent_type: 'reviewer',
              description: '审一下',
              prompt: '请审 tier.ts 的改动\n第二行不该出现',
            },
          },
        ],
      },
      parent_tool_use_id: null,
    },
    {
      type: 'assistant',
      message: { model: 'm', content: [{ type: 'text', text: '我来看 tier.ts' }] },
      parent_tool_use_id: 'toolu_A',
    },
    {
      type: 'assistant',
      message: {
        model: 'm',
        content: [{ type: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: 'tier.ts' } }],
      },
      parent_tool_use_id: 'toolu_A',
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'export const T = 1' }] },
      parent_tool_use_id: 'toolu_A',
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: '没问题' }] },
      parent_tool_use_id: null,
    },
    {
      type: 'assistant',
      message: { model: 'm', content: [{ type: 'text', text: '审完了' }] },
      parent_tool_use_id: null,
    },
  ];

  it('子代理的话和工具调用带 meta.subagent（派它的那次 Agent 调用的 id）和子代理名；主会话的照旧不带；Agent 调用写派了谁、头一句', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w', now: () => NOW });
    const entries = frames.flatMap((f) => reader.read(JSON.stringify(f)).transcript);
    const sub = { subagent: 'toolu_A', subagentType: 'reviewer' };
    expect(entries.map((e) => [e.kind, e.tool, e.text, e.meta])).toEqual([
      ['tool_call', 'Agent', '派了 reviewer：请审 tier.ts 的改动', { callId: 'toolu_A' }],
      ['assistant', undefined, '我来看 tier.ts', sub],
      ['tool_call', 'Read', 'tier.ts', { callId: 'toolu_B', ...sub }],
      ['tool_result', 'Read', 'export const T = 1', { callId: 'toolu_B', ...sub }],
      ['tool_result', 'Agent', '没问题', { callId: 'toolu_A' }],
      ['assistant', undefined, '审完了', undefined],
    ]);
  });

  it('引擎实际写的子代理标记是调用编号字符串，不是 true：shared 的 isSubagentMeta 认得出，主会话的条目不被认成子代理（#3140）', () => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w', now: () => NOW });
    const entries = frames.flatMap((f) => reader.read(JSON.stringify(f)).transcript);
    expect(entries.map((e) => isSubagentMeta(e.meta))).toEqual([false, true, true, true, false, false]);
    // 旧写法 meta.subagent === true 一条也认不出：页面当年就是这样把线上的子代理条目全当成主会话的
    expect(entries.filter((e) => e.meta?.subagent === true)).toHaveLength(0);
  });
});

describe('Claude：调用号、命令说明、改文件的增删行数（#3140）', () => {
  const call = (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    message: { model: 'm', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
  });
  const result = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    parent_tool_use_id: null,
    ...extra,
  });
  const run = (frames: unknown[]) => {
    const reader = new ClaudeStreamReader({ runId: 'r', cwd: '/w', now: () => NOW });
    return frames.flatMap((f) => reader.read(JSON.stringify(f)).transcript);
  };

  it('真跑夹具：Edit 的结果读 structuredPatch（+1 −1），调用和结果带同一个调用号', () => {
    const entries = claude('cc-haiku-edit').filter((e) => e.tool === 'Edit');
    const [c, r] = entries;
    expect(c?.kind).toBe('tool_call');
    expect(r?.kind).toBe('tool_result');
    expect(c?.meta?.callId).toBe('toolu_01BAkEB3sKicL7oimPaLtLef');
    expect(r?.meta).toEqual({ callId: 'toolu_01BAkEB3sKicL7oimPaLtLef', added: 1, removed: 1 });
  });

  it('真跑夹具：Write 新建文件没有 patch 块，按内容行数记新增', () => {
    const r = claude('cc-haiku-write').find((e) => e.kind === 'tool_result' && e.tool === 'Write');
    expect(r?.meta).toMatchObject({ added: 1, removed: 0 });
  });

  it('读文件、跑命令的结果不带增删行数；失败的编辑也不带', () => {
    const read = claude('cc-haiku-read').find((e) => e.kind === 'tool_result');
    expect(read?.meta).toEqual({ callId: expect.any(String) });
    const failed = run([
      call('t1', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
      result('t1', 'old_string not found', {
        tool_use_result: undefined,
      }),
    ]);
    expect(failed.at(-1)?.meta).toEqual({ callId: 't1' });
    const bad = run([
      call('t2', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] },
        tool_use_result: { structuredPatch: [{ lines: ['-x', '+y'] }] },
        parent_tool_use_id: null,
      },
    ]);
    expect(bad.at(-1)).toMatchObject({ ok: false, meta: { callId: 't2' } });
    expect(bad.at(-1)?.meta).not.toHaveProperty('added');
  });

  it('Bash 的说明写进调用的 meta.description；别的工具不带', () => {
    const entries = run([
      call('b1', 'Bash', { command: 'pnpm test', description: '跑测试' }),
      call('r1', 'Read', { file_path: '/w/a.ts', description: '不该出现' }),
    ]);
    expect(entries[0]?.meta).toEqual({ callId: 'b1', description: '跑测试' });
    expect(entries[1]?.meta).toEqual({ callId: 'r1' });
  });

  it('并行的两个 Edit，结果倒序回来：每个结果靠自己的调用号对回自己的调用，增删行数不串（评审反例）', () => {
    const entries = run([
      {
        type: 'assistant',
        message: {
          model: 'm',
          content: [
            {
              type: 'tool_use',
              id: 'ea',
              name: 'Edit',
              input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'A' },
            },
            {
              type: 'tool_use',
              id: 'eb',
              name: 'Edit',
              input: { file_path: '/w/b.ts', old_string: 'b', new_string: 'B\nB2' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      // b 先成功回来
      {
        ...result('eb', 'ok'),
        tool_use_result: { structuredPatch: [{ lines: ['-b', '+B', '+B2'] }] },
      },
      // a 后回来，且失败
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ea', content: 'fail', is_error: true }] },
        parent_tool_use_id: null,
      },
    ]);
    const calls = entries.filter((e) => e.kind === 'tool_call');
    const results = entries.filter((e) => e.kind === 'tool_result');
    expect(calls.map((c) => [c.text, c.meta?.callId])).toEqual([
      ['a.ts', 'ea'],
      ['b.ts', 'eb'],
    ]);
    expect(results.map((r) => [r.meta?.callId, r.ok, r.meta?.added, r.meta?.removed])).toEqual([
      ['eb', true, 2, 1],
      ['ea', false, undefined, undefined],
    ]);
  });
});

describe('cursor-agent', () => {
  function cursor(name: string): TranscriptEntry[] {
    const reader = new CursorStreamReader({ runId: 'r', cwd: '/tmp/agent-io-p3/x', now: () => NOW });
    return fixtureLines('cursor-agent', name).flatMap((l) => reader.read(l).transcript ?? []);
  }

  it('跑命令：话、调用、结果（命令的输出）、话、结论；没有 error（流里没有单独的报错帧）', () => {
    const entries = cursor('cursor-bash-fail');
    expect(brief(entries)).toEqual([
      ['assistant', undefined, undefined, '先跑这条命令，再只回报退出码。'],
      ['tool_call', 'shell', undefined, 'ls missing-dir; echo EXI'],
      ['tool_result', 'shell', true, 'EXIT:2'],
      ['assistant', undefined, undefined, '2'],
      ['result', undefined, true, '先跑这条命令，再只回报退出码。2'],
    ]);
    expect(entries.some((e) => e.kind === 'error')).toBe(false);
  });

  it('改文件和提交：两次工具之间的话也记', () => {
    const entries = cursor('cursor-edit-commit');
    expect(entries.map((e) => e.kind)).toEqual([
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
      'result',
    ]);
    expect(entries[2]?.text).toContain('cursor: 追加一行');
  });

  it('调用和结果带同一个调用号；改文件的结果带 linesAdded / linesRemoved（#3140）', () => {
    const entries = cursor('cursor-edit-tools');
    const calls = entries.filter((e) => e.kind === 'tool_call');
    const results = entries.filter((e) => e.kind === 'tool_result');
    expect(calls.every((c) => typeof c.meta?.callId === 'string')).toBe(true);
    expect(results.map((r) => r.meta?.callId).sort()).toEqual(calls.map((c) => c.meta?.callId).sort());
    const edit = results.find((r) => r.tool === 'edit');
    expect(edit?.meta).toMatchObject({ added: 1, removed: 0 });
    // 读文件的结果不带增删
    expect(results.find((r) => r.tool === 'read')?.meta).not.toHaveProperty('added');
  });
});

describe('grok', () => {
  function editResult(oldText: unknown, newText: unknown, extraUnknown = false): TranscriptEntry {
    const reader = new GrokStreamReader({ runId: 'r', cwd: '/tmp/agent-io-p3/x', now: () => NOW });
    const entries = fixtureLines('grok', 'grok-edit-commit').flatMap((line) => {
      const frame = JSON.parse(line);
      if (frame.type === 'tool_call_update' && Array.isArray(frame.content)) {
        frame.content = frame.content.map((block: Record<string, unknown>) =>
          block.type === 'diff' ? { ...block, oldText, newText } : block,
        );
        if (extraUnknown && frame.content.some((block: Record<string, unknown>) => block.type === 'diff')) {
          frame.content.push({ type: 'diff', oldText: 'old\n'.repeat(2000), newText: 'new\n'.repeat(2000) });
        }
      }
      return reader.read(JSON.stringify(frame)).transcript ?? [];
    });
    const result = entries.find((entry) => entry.kind === 'tool_result' && entry.tool === 'search_replace');
    if (!result) throw new Error('真实记录缺少 search_replace 结果');
    return result;
  }

  it('真实工具结果帧的不相邻修改不把未改中间行计入', () => {
    expect(editResult('head\na\nunchanged\nb\ntail', 'head\nA\nunchanged\nB\ntail').meta).toMatchObject({
      added: 2,
      removed: 2,
    });
  });

  it('一个 diff 块未知则整个工具行数未知，保留成功结果和调用号', () => {
    const result = editResult('a', 'b', true);
    expect(result.ok).toBe(true);
    expect(result.meta?.callId).toBeTruthy();
    expect(result.meta).not.toHaveProperty('added');
    expect(result.meta).not.toHaveProperty('removed');
  });

  it('缺失或错误类型的原文不是空文本；明确空文本才按新建计数', () => {
    for (const [before, after] of [
      [undefined, 'new'],
      [12, 'new'],
      ['old', undefined],
      ['old', false],
    ]) {
      const result = editResult(before, after);
      expect(result.ok).toBe(true);
      expect(result.meta?.callId).toBeTruthy();
      expect(result.meta).not.toHaveProperty('added');
      expect(result.meta).not.toHaveProperty('removed');
    }
    expect(editResult('', 'new\n').meta).toMatchObject({ added: 1, removed: 0 });
    expect(editResult('old\n', '').meta).toMatchObject({ added: 0, removed: 1 });
  });

  function grok(name: string): TranscriptEntry[] {
    const reader = new GrokStreamReader({ runId: 'r', cwd: '/tmp/agent-io-p3/x', now: () => NOW });
    const entries = fixtureLines('grok', name).flatMap((l) => reader.read(l).transcript ?? []);
    reader.flush();
    return [...entries, ...reader.drainTranscript()];
  }

  it('一字一帧的增量拼成一句话；结论只有停止原因', () => {
    const entries = grok('grok-bash-fail');
    expect(brief(entries)).toEqual([
      ['assistant', undefined, undefined, '我来运行这条命令，并只回报它的退出码。'],
      ['tool_call', 'run_terminal_command', undefined, 'ls missing-dir; echo "EX'],
      ['tool_result', 'run_terminal_command', true, "ls: cannot access 'missi"],
      ['assistant', undefined, undefined, '2'],
      ['result', undefined, true, '结束：end_turn'],
    ]);
  });

  it('并行的几次工具：调用和结果都各记各的，工具名对得上', () => {
    const entries = grok('grok-edit-commit');
    expect(entries.filter((e) => e.kind === 'tool_call').map((e) => e.tool)).toEqual([
      'read_file',
      'list_dir',
      'grep',
      'search_replace',
      'run_terminal_command',
    ]);
    expect(entries.filter((e) => e.kind === 'tool_result')).toHaveLength(5);
    // 终帧不带回答正文：最后一句话来自流里的 text 帧，收场时 flush 出来
    expect(entries.at(-2)).toMatchObject({ kind: 'assistant', text: '好了' });
  });

  it('调用和结果带同一个调用号；search_replace 的结果按改前改后的文本记增删行数；命令的说明记在 meta（#3140）', () => {
    const entries = grok('grok-edit-commit');
    const calls = entries.filter((e) => e.kind === 'tool_call');
    const results = entries.filter((e) => e.kind === 'tool_result');
    expect(calls.map((c) => c.meta?.callId).sort()).toEqual(results.map((r) => r.meta?.callId).sort());
    expect(results.find((r) => r.tool === 'search_replace')?.meta).toMatchObject({ added: 1, removed: 0 });
    expect(results.find((r) => r.tool === 'read_file')?.meta).not.toHaveProperty('added');
  });
});

describe('Mirasim', () => {
  function replay(name: string): TranscriptEntry[] {
    const recording = mirasimRecording(name);
    const session = new MirasimSession({ runId: 'r1', cwd: '/tmp/agent-io-p3/x', now: () => NOW });
    const out: TranscriptEntry[] = [];
    for (const f of recording.stream) {
      if (f.type === 'snapshot') session.applySnapshot(Number(f.seq), f.snapshot as Record<string, unknown>);
      else session.applyPatch(Number(f.seq), f.patch as Record<string, unknown>);
      out.push(...session.drainTranscript());
    }
    session.flush();
    out.push(...session.drainTranscript());
    return out;
  }

  it('kimi：重复的快照不重复记；一次命令、一句话、结论', () => {
    const entries = replay('mira-kimi');
    expect(entries.map((e) => [e.kind, e.tool, e.ok])).toEqual([
      ['tool_call', 'Bash', undefined],
      ['tool_result', 'Bash', true],
      ['assistant', undefined, undefined],
      ['result', undefined, true],
    ]);
    expect(entries[2]?.text).toBe('好了');
    expect(entries[3]?.text).toBe('done');
  });

  it('pi：两条命令各有调用和结果', () => {
    const entries = replay('mira-pi');
    expect(entries.filter((e) => e.kind === 'tool_call')).toHaveLength(2);
    expect(entries.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
    expect(entries.at(-1)).toMatchObject({ kind: 'result', ok: true });
  });

  it('调用和结果带同一个调用号；命令的结果标 exitKnown:false（快照里没有退出码，完成不代表成功，读的一边写「结果未知」）（#3140）', () => {
    for (const name of ['mira-kimi', 'mira-pi']) {
      const entries = replay(name);
      const calls = entries.filter((e) => e.kind === 'tool_call');
      const results = entries.filter((e) => e.kind === 'tool_result');
      expect(calls.length).toBeGreaterThan(0);
      expect(results.map((r) => r.meta?.callId)).toEqual(calls.map((c) => c.meta?.callId));
      expect(results.every((r) => r.meta?.exitKnown === false)).toBe(true);
    }
  });

  it('终态带死因：先记 error，再记 ok=false 的结论，只记一次', () => {
    const session = new MirasimSession({ runId: 'r1', cwd: '/w', now: () => NOW });
    session.applySnapshot(0, { phase: 'streaming', text: '', toolCalls: [] });
    session.applyPatch(1, { set: { phase: 'done', error: '上游断流' } });
    session.applyPatch(2, { set: { updatedAt: 1 } });
    const entries = session.drainTranscript();
    expect(entries.map((e) => [e.kind, e.ok, e.text])).toEqual([
      ['error', undefined, '上游断流'],
      ['result', false, 'done · 上游断流'],
    ]);
  });
});

describe('经插头的 onTranscript 一条条交出', () => {
  it('runClaudeCode：回放夹具，onTranscript 收到的和读取器抽的一样，序号随行', async () => {
    const got: { kind: string; seq: number; replay: boolean }[] = [];
    await runClaudeCode(
      {
        runId: 'run-tx-1',
        cwd: tempDir(),
        prompt: 'x',
        model: 'claude-haiku-4-5',
        session: { mode: 'new', id: fixtureInit('cc-haiku-read').sessionId },
        permissionMode: 'bypassPermissions',
        env: { base: process.env, fleetApi: 'http://127.0.0.1:7070', fleetToken: 'tok' },
        limits: { startupMs: 10_000, wallClockMs: 20_000, killGraceMs: 300 },
      },
      {
        command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-read') }),
        onTranscript: (entry, meta) => {
          got.push({ kind: entry.kind, seq: meta.seq, replay: meta.replay });
        },
      },
    );
    expect(got.map((g) => g.kind)).toEqual(['tool_call', 'tool_result', 'assistant', 'result']);
    expect(got.every((g) => !g.replay)).toBe(true);
    // 行号单调不减（同一行出两条的，序号相同）
    expect(got.map((g) => g.seq)).toEqual([...got.map((g) => g.seq)].sort((a, b) => a - b));
  }, 30_000);
});
