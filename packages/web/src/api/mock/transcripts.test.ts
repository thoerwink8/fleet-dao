// 会话内容（#1640）的模拟后端：和真后端同一个形状（RunTranscriptResponse）、同一套语义：增量读、在跑的段 done=false 且越读越多、
// 没有记录和读不到分开、别的单的段 404。
import { describe, expect, test } from 'vitest';
import { ApiError } from '../client';
import { createMockApi } from './server';

const fresh = (opts: Parameters<typeof createMockApi>[0] = {}) =>
  createMockApi({ live: false, latencyMs: 0, ...opts });

describe('mock 的会话内容', () => {
  test('一段完整会话：提示词打头、结论收尾，种类齐全（含报错和被截断的长结果）', async () => {
    const r = await fresh().runTranscript('t-c9', 'seg-c9-3');
    expect(r).toMatchObject({ done: true, noRecord: false });
    expect(r.entries.map((e) => e.seq)).toEqual(r.entries.map((_, i) => i));
    expect(r.entries[0]?.kind).toBe('prompt');
    expect(r.entries.at(-1)).toMatchObject({ kind: 'result', ok: true });
    const kinds = new Set(r.entries.map((e) => e.kind));
    for (const k of ['prompt', 'assistant', 'tool_call', 'tool_result', 'error', 'result']) {
      expect(kinds).toContain(k);
    }
    expect(r.entries.some((e) => e.meta?.truncated === true)).toBe(true);
    expect(r.entries.some((e) => e.kind === 'tool_result' && e.ok === false)).toBe(true);
    expect(r.nextAfter).toBe(r.entries.length - 1);
  });

  test('after 增量：只回更大的序号；读到头回空、nextAfter 原样', async () => {
    const api = fresh();
    const all = await api.runTranscript('t-c9', 'seg-c9-3');
    const tail = await api.runTranscript('t-c9', 'seg-c9-3', { after: 17 });
    expect(tail.entries.map((e) => e.seq)).toEqual(all.entries.slice(18).map((e) => e.seq));
    expect(await api.runTranscript('t-c9', 'seg-c9-3', { after: all.nextAfter ?? 0 })).toEqual({
      entries: [],
      nextAfter: all.nextAfter,
      done: true,
      noRecord: false,
    });
  });

  test('在跑的段：done=false，每读一次多放出几条，接着 nextAfter 读到的是新增的', async () => {
    const api = fresh();
    const first = await api.runTranscript('t-12', 'seg-t-12-manual-40');
    expect(first.done).toBe(false);
    expect(first.entries.length).toBeGreaterThan(0);
    const second = await api.runTranscript('t-12', 'seg-t-12-manual-40', { after: first.nextAfter ?? 0 });
    expect(second.entries.length).toBeGreaterThan(0);
    expect(second.entries[0]?.seq).toBe((first.nextAfter ?? -1) + 1);
    expect(second.done).toBe(false);
    // 放完了就不再有新的，段还没结束 done 仍是 false
    let last = second;
    for (let i = 0; i < 20; i++) {
      last = await api.runTranscript('t-12', 'seg-t-12-manual-40', { after: last.nextAfter ?? 0 });
    }
    expect(last.entries).toEqual([]);
    expect(last.done).toBe(false);
  });

  test('没有记录（跑在记录会话内容之前）：已结束、一条都没有 → noRecord=true，和读不到分开', async () => {
    const r = await fresh().runTranscript('t-c9', 'seg-c9-1');
    expect(r).toEqual({ entries: [], nextAfter: null, done: true, noRecord: true });
  });

  test('读不到：抛 503 run_transcript_unreadable，不是空列表', async () => {
    const err = await fresh({ transcriptFail: ['seg-c9-3'] })
      .runTranscript('t-c9', 'seg-c9-3')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'run_transcript_unreadable' });
  });

  test('别的单的段、不存在的单：404', async () => {
    const api = fresh();
    await expect(api.runTranscript('t-12', 'seg-c9-3')).rejects.toMatchObject({
      status: 404,
      code: 'run_not_found',
    });
    await expect(api.runTranscript('t-nope', 'seg-c9-3')).rejects.toMatchObject({
      status: 404,
      code: 'task_not_found',
    });
  });
});
