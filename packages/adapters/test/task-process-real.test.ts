// 任务页「过程」吃的是四家插头真交出的条目（#3140）：真跑夹具 → 读取器 → 切步算法，调用号配得上、命令成败不编。
import { cutSteps, processRowOf } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamReader } from '../src/claude-code/stream.ts';
import type { TranscriptEntry } from '../src/types.ts';
import { fixtureInit, fixtureLines } from './helpers.ts';

const NOW = new Date('2026-10-10T00:00:00.000Z');

function process(name: string, running = false) {
  const reader = new ClaudeStreamReader({ runId: 'r', cwd: fixtureInit(name).cwd, now: () => NOW });
  const entries: TranscriptEntry[] = fixtureLines('claude-code', name).flatMap(
    (l) => reader.read(l).transcript,
  );
  const rows = entries.map((e, i) => processRowOf({ ...e, seq: i }));
  return { entries, rows, run: cutSteps(rows, { running }) };
}

describe('真跑夹具走过切步算法', () => {
  it('跑命令的一笔：调用都带调用号，Bash 结果配上调用，一个都不丢、没有「结果未知」', () => {
    const { entries, run } = process('cc-opus-edit-bash');
    const calls = entries.filter((e) => e.kind === 'tool_call');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => typeof c.meta?.callId === 'string')).toBe(true);
    expect(run.steps.reduce((n, s) => n + s.calls, 0)).toBe(calls.length);
    expect(run.legacyCalls).toBe(0);
    expect(run.counts.commands).toBe(calls.filter((c) => c.tool === 'Bash').length);
    expect(run.counts.commandsRunning).toBe(0);
    expect(run.counts.commandsUnknown).toBe(0);
  });

  it.each(['cc-haiku-edit', 'cc-haiku-write'])(
    '改文件（%s）：成功的编辑列进改了哪些文件，增删行数有数或记在「没记行数」里',
    (name) => {
      const { entries, run } = process(name);
      const edited = entries.filter(
        (e) => e.kind === 'tool_result' && (e.tool === 'Edit' || e.tool === 'Write') && e.ok === true,
      );
      expect(edited.length).toBeGreaterThan(0);
      expect(run.counts.files.length).toBeGreaterThan(0);
      expect(run.counts.added + run.counts.removed + run.counts.uncounted).toBeGreaterThan(0);
    },
  );

  it('工具失败的一笔：失败的调用记成失败', () => {
    const { run } = process('cc-haiku-tool-error');
    expect(run.counts.callsFailed).toBe(1);
  });

  it('只读文件的一笔：没有命令；读了一个文件', () => {
    const { run } = process('cc-haiku-read');
    expect(run.counts.commands).toBe(0);
    expect(run.counts.reads).toBe(1);
  });
});
