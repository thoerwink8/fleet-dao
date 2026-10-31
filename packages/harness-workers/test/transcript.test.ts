// 工人过程落库（#3781）：stream-json 样例解析、截断和打码（令牌不进库）、批量写、进程被杀时攒着的也写掉、上限、写库失败照实记。
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRANSCRIPT_INPUT_MAX_BYTES,
  TRANSCRIPT_TEXT_MAX_BYTES,
  transcriptStream,
} from '@fleet-dao/harness-contract';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { type Db, readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeWorker, type WorkerTurn } from '../src/slot.ts';
import { clipBytes, parseStreamLine, summarizeToolInput, TranscriptWriter } from '../src/transcript.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/stream-sample.jsonl', import.meta.url));
// 假令牌现拼：源码里不留像令牌的字面量
const TOKEN = `ghp_${'Ab3'.repeat(12)}`;
const redact = makeRedactor([TOKEN]);
const sample = (): string[] =>
  readFileSync(SAMPLE, 'utf8')
    .split('__SID__')
    .join('sid-1')
    .split('__TOKEN__')
    .join(TOKEN)
    .split('\n')
    .filter((l) => l !== '');

let t: TestDb;
let tmpRoot: string;
let n = 0;
const rid = () => `tr-${process.pid}-${++n}`;
const rows = (runId: string) => readStream(t.db, transcriptStream(runId), 0, 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestDb();
  tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-transcript-test-'));
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.events restart identity');
});

describe('解析 stream-json 样例', () => {
  it('助手的话、工具调用、工具结果、最终 result 各成一条，其余（init、thinking、限流、非 JSON）不落', () => {
    const items = sample().flatMap((l) => parseStreamLine(l, 'r1', redact));
    expect(items.map((i) => i.type)).toEqual([
      'transcript.assistant',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.assistant',
      'transcript.result',
    ]);
  });

  it('工具调用和工具结果靠 toolUseId 配对；参数摘要是人话，错误结果带标记', () => {
    const items = sample().flatMap((l) => parseStreamLine(l, 'r1', redact));
    const uses = items.filter((i) => i.type === 'transcript.tool_use').map((i) => i.payload);
    const results = items.filter((i) => i.type === 'transcript.tool_result').map((i) => i.payload);
    expect(uses.map((u) => [u.name, u.toolUseId, u.summary])).toEqual([
      ['Read', 'toolu_01Read', '/work/repo/packages/web/src/routes/login.tsx'],
      ['Bash', 'toolu_02Bash', 'curl -s -H "Authorization: Bearer ***" http://127.0.0.1:4799/health'],
      ['Grep', 'toolu_03Grep', 'width: 420  packages/web/src'],
    ]);
    expect(results.map((r) => [r.toolUseId, r.isError])).toEqual([
      ['toolu_01Read', false],
      ['toolu_02Bash', false],
      ['toolu_03Grep', true],
    ]);
    // 内容是数组形式的 tool_result 也取得出文字
    expect(results[1]?.text).toContain('4 tests passed');
    const last = items.at(-1)?.payload;
    expect(last).toMatchObject({ subtype: 'success', isError: false, durationMs: 183000, numTurns: 4 });
  });

  it('认不出的行不抛', () => {
    for (const l of [
      '',
      'Syncing config…',
      '[1,2]',
      'null',
      '{"type":"assistant"}',
      '{"type":"user","message":{"content":"x"}}',
    ]) {
      expect(parseStreamLine(l, 'r1', redact)).toEqual([]);
    }
  });
});

describe('截断和打码', () => {
  it('令牌不进载荷：参数、结果、助手的话、result 里出现的都打成 ***', () => {
    const text = `${TOKEN} 和 Bearer ${'z'.repeat(24)}`;
    const line = (o: unknown) => JSON.stringify(o);
    const all = [
      ...parseStreamLine(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text },
              { type: 'tool_use', id: 'u', name: 'Bash', input: { command: text } },
            ],
          },
        }),
        'r',
        redact,
      ),
      ...parseStreamLine(
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: text }] },
        }),
        'r',
        redact,
      ),
      ...parseStreamLine(line({ type: 'result', subtype: 'success', result: text }), 'r', redact),
    ];
    expect(all).toHaveLength(4);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('z'.repeat(24));
    expect(dump).toContain('***');
  });

  it('先打码再截断：令牌正好跨在截断边界上也不会漏出前缀', () => {
    const body = `${'a'.repeat(TRANSCRIPT_TEXT_MAX_BYTES - 10)}${TOKEN}${'b'.repeat(100)}`;
    const [it] = parseStreamLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: body }] },
      }),
      'r',
      redact,
    );
    const text = String(it?.payload.text);
    expect(text).not.toContain('ghp_');
    expect(it?.payload.truncated).toBe(true);
  });

  it('工具结果最多 4KB（按字节），记下原来多长；汉字不会被切成两半', () => {
    const body = '汉'.repeat(5000);
    const [it] = parseStreamLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: body }] },
      }),
      'r',
      redact,
    );
    const text = String(it?.payload.text);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(TRANSCRIPT_TEXT_MAX_BYTES);
    expect(text).not.toContain('�');
    expect(it?.payload).toMatchObject({ truncated: true, chars: 5000 });
    expect(clipBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });

  it('工具参数 JSON 最多 1KB，摘要最多 160 字且只取第一行', () => {
    const cmd = `echo 一行\n${'x'.repeat(3000)}`;
    const [it] = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: cmd } }] },
      }),
      'r',
      redact,
    );
    expect(Buffer.byteLength(String(it?.payload.input), 'utf8')).toBeLessThanOrEqual(
      TRANSCRIPT_INPUT_MAX_BYTES,
    );
    expect(it?.payload.inputTruncated).toBe(true);
    expect(it?.payload.summary).toBe('echo 一行');
    expect(summarizeToolInput('Bash', { command: 'y'.repeat(500) })).toHaveLength(160);
    expect(summarizeToolInput('mcp__x__y', { a: 1, b: '第一个字符串' })).toBe('第一个字符串');
  });
});

describe('批量写', () => {
  const feed = (w: TranscriptWriter, k: number) => {
    for (let i = 0; i < k; i++) {
      w.pushLine(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `第 ${i} 句` }] } }),
      );
    }
  };

  it('攒到 maxBatch 才写一个事务；没到点之前库里什么都没有；关的时候把零头写掉', async () => {
    const runId = rid();
    const w = new TranscriptWriter({ db: t.db, runId, redact, flushMs: 60_000, maxBatch: 50 });
    feed(w, 49);
    await sleep(100);
    expect(await rows(runId)).toHaveLength(0);
    feed(w, 71);
    const sum = await w.close();
    expect(sum).toMatchObject({ rows: 120, batches: 3, dropped: 0, lost: 0 });
    const got = await rows(runId);
    expect(got).toHaveLength(120);
    // 顺序和 seq 连续
    expect(got.map((e) => e.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(got[0]?.payload.text).toBe('第 0 句');
    expect(got[119]?.payload.text).toBe('第 70 句');
  });

  it('不满一批也按时间写：flushMs 到点自己写', async () => {
    const runId = rid();
    const w = new TranscriptWriter({ db: t.db, runId, redact, flushMs: 80, maxBatch: 50 });
    feed(w, 3);
    await sleep(600);
    expect(await rows(runId)).toHaveLength(3);
    await w.close();
  });

  it('同一个 runId 重来：从流里现有的最后一条往后接，不撞 seq', async () => {
    const runId = rid();
    const a = new TranscriptWriter({ db: t.db, runId, redact });
    feed(a, 2);
    await a.close();
    const b = new TranscriptWriter({ db: t.db, runId, redact });
    feed(b, 2);
    await b.close();
    expect((await rows(runId)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('超过上限的丢掉，末尾记一条 transcript.dropped，数字照实', async () => {
    const runId = rid();
    const w = new TranscriptWriter({ db: t.db, runId, redact, maxRows: 5 });
    feed(w, 8);
    const sum = await w.close();
    expect(sum).toMatchObject({ rows: 6, dropped: 3 });
    const got = await rows(runId);
    expect(got.at(-1)).toMatchObject({ type: 'transcript.dropped', payload: { count: 3 } });
  });

  it('写库一直失败：不抛，照实记 lost（过程丢了不拖垮起止记账）', async () => {
    const down = {
      select: () => {
        throw new Error('库挂了');
      },
    } as unknown as Db;
    const w = new TranscriptWriter({ db: down, runId: rid(), redact });
    feed(w, 4);
    const sum = await w.close();
    expect(sum).toMatchObject({ rows: 0, lost: 4 });
  });
});

describe('槽位把过程落进 transcript:<runId>', () => {
  function turn(over: Partial<WorkerTurn> = {}): WorkerTurn {
    return {
      db: t.db,
      runId: rid(),
      command: [process.execPath, FAKE],
      model: 'claude-opus-5-5',
      permissionMode: 'bypassPermissions',
      prompt: '改一行',
      cwd: process.cwd(),
      mcp: { url: 'http://127.0.0.1:4799/mcp', token: TOKEN },
      budget: { startupMs: 3_000, totalMs: 20_000, killGraceMs: 200 },
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
      extraEnv: { FAKE_MODE: 'replay', FAKE_REPLAY: SAMPLE, FAKE_PLANT: TOKEN },
      tmpRoot,
      ...over,
    };
  }

  it('跑完：九条过程在 transcript 流里，worker 流还是起止两条，settled 带过程的数字，库里没有令牌', async () => {
    const tr = turn();
    await runClaudeWorker(tr);
    const got = await rows(tr.runId);
    expect(got.map((e) => e.type)).toEqual([
      'transcript.assistant',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.assistant',
      'transcript.result',
    ]);
    const worker = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(worker.map((e) => e.type)).toEqual(['worker.spawned', 'worker.settled']);
    expect(worker[1]?.payload.transcript).toMatchObject({ rows: 9, dropped: 0, lost: 0 });
    const all = JSON.stringify([...got, ...worker]);
    expect(all).not.toContain(TOKEN);
  });

  it('进程被叫停：攒在缓冲里还没到点的过程，也在记 worker.settled 之前写进库', async () => {
    const ac = new AbortController();
    const tr = turn({
      extraEnv: { FAKE_MODE: 'replay-hang', FAKE_REPLAY: SAMPLE, FAKE_PLANT: TOKEN },
      signal: ac.signal,
    });
    // 默认 1.5 秒才会按时间写：0.9 秒就叫停，写进库的只可能是 close 时那一批
    setTimeout(() => ac.abort(), 900);
    const { result } = await runClaudeWorker(tr);
    expect(result.killed?.reason).toBe('aborted');
    expect((await rows(tr.runId)).length).toBe(9);
    const worker = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(worker.at(-1)?.type).toBe('worker.settled');
  });
});
