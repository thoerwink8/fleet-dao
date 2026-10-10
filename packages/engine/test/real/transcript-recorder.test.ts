// real/transcript-recorder.ts（#1640）：打码、按种类截断并标出来、每段条数上限和收尾的 truncated、攒批、写库失败不抛。
// 违规样本在运行时拼起来（值用固定种子的伪随机串）：源码里不出现整段，全仓卫生检查不会扫到这个文件自己。
import type { TranscriptRow } from '@fleet-dao/db';
import { TRANSCRIPT_LIMITS, TRANSCRIPT_TRUNCATED_MARK } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { sanitizeTranscriptText, TranscriptRecorder } from '../../src/real/transcript-recorder.ts';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 固定种子的伪随机串（xorshift32）：每次一样，但源码里没有整段令牌。 */
function pseudoRandom(length: number, seed: number): string {
  let x = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += BASE62[x % BASE62.length];
  }
  return out;
}
const TOKEN = ['ghp', pseudoRandom(36, 9)].join('_');

const at = '2026-10-10T00:00:00.000Z';

function recorder(over: Partial<ConstructorParameters<typeof TranscriptRecorder>[0]> = {}) {
  const written: TranscriptRow[] = [];
  const batches: number[] = [];
  const logs: string[] = [];
  const r = new TranscriptRecorder({
    runId: 'run-1',
    write: async (_id, rows) => {
      batches.push(rows.length);
      written.push(...rows);
    },
    log: (m) => void logs.push(m),
    flushEveryMs: 5,
    ...over,
  });
  return { r, written, batches, logs };
}

describe('打码', () => {
  it('令牌换成「已打码」，前后的话原样；meta 记打了几处', () => {
    const got = sanitizeTranscriptText('assistant', `我用 ${TOKEN} 去推送，然后继续`);
    expect(got.text).not.toContain(TOKEN);
    expect(got.text).toContain('已打码');
    expect(got.text.startsWith('我用 ')).toBe(true);
    expect(got.text.endsWith('，然后继续')).toBe(true);
    expect(got.meta).toEqual({ redacted: 1 });
  });

  it('没有密钥的文本原样，没有 meta', () => {
    expect(sanitizeTranscriptText('assistant', '改了 tier.ts 第 12 行')).toEqual({
      text: '改了 tier.ts 第 12 行',
    });
  });

  it('先打码再截断：令牌正好跨在截断线上，也不会留下半截', () => {
    const lead = 'a'.repeat(TRANSCRIPT_LIMITS.toolInputChars - 10);
    const got = sanitizeTranscriptText('tool_call', `${lead} ${TOKEN}`);
    expect(got.text).not.toContain(TOKEN.slice(0, 8));
    expect(got.text).toContain('已打码');
  });

  it('记录员写进库的文本也是打过码的（工具输入摘要里的命令带着令牌）', async () => {
    const { r, written } = recorder();
    r.record({ at, kind: 'tool_call', text: `git push https://x:${TOKEN}@github.com/o/r.git`, tool: 'Bash' });
    await r.close();
    expect(written[0]?.text).not.toContain(TOKEN);
    expect(written[0]?.meta).toMatchObject({ redacted: 1 });
  });
});

describe('截断', () => {
  const cases: [Parameters<typeof sanitizeTranscriptText>[0], number][] = [
    ['assistant', 4000],
    ['tool_call', 300],
    ['tool_result', 500],
  ];
  for (const [kind, max] of cases) {
    it(`${kind}：超过 ${max} 字截断，末尾加标记，meta 带原来的字数；正好 ${max} 字不动`, () => {
      const exact = sanitizeTranscriptText(kind, '字'.repeat(max));
      expect(exact).toEqual({ text: '字'.repeat(max) });
      const over = sanitizeTranscriptText(kind, '字'.repeat(max + 123));
      expect(over.text).toBe(`${'字'.repeat(max)}${TRANSCRIPT_TRUNCATED_MARK}`);
      expect(over.meta).toEqual({ truncated: true, originalChars: max + 123 });
    });
  }

  it('上限就是单上写的数', () => {
    expect(TRANSCRIPT_LIMITS).toMatchObject({
      assistantChars: 4000,
      toolInputChars: 300,
      toolResultChars: 500,
      maxEntries: 3000,
    });
  });
});

describe('一段的条数上限', () => {
  it('超了停记，收尾补一条 truncated 写「后面还有 N 条没记」；编号连续，不超过上限加一行', async () => {
    const { r, written } = recorder({ limits: { ...TRANSCRIPT_LIMITS, maxEntries: 5 } });
    r.prompt('提示词');
    for (let i = 0; i < 9; i++) r.record({ at, kind: 'assistant', text: `话 ${i}` });
    await r.close();
    expect(written).toHaveLength(6);
    expect(written.map((w) => w.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(written.slice(0, 5).map((w) => w.kind)).toEqual([
      'prompt',
      'assistant',
      'assistant',
      'assistant',
      'assistant',
    ]);
    expect(written[5]).toMatchObject({
      kind: 'truncated',
      text: '后面还有 5 条没记（一段最多记 5 条）',
      meta: { dropped: 5 },
    });
  });

  it('没超就没有 truncated', async () => {
    const { r, written } = recorder({ limits: { ...TRANSCRIPT_LIMITS, maxEntries: 5 } });
    for (let i = 0; i < 5; i++) r.record({ at, kind: 'assistant', text: `话 ${i}` });
    await r.close();
    expect(written.map((w) => w.kind)).not.toContain('truncated');
  });
});

describe('攒批', () => {
  it('够 batchSize 立刻写；不够的等节拍或收场一起写', async () => {
    const { r, batches } = recorder({ batchSize: 3, flushEveryMs: 60_000 });
    for (let i = 0; i < 7; i++) {
      r.record({ at, kind: 'assistant', text: `话 ${i}` });
      // 让到批量时立刻发出的那一次写先跑完，再来下一条
      await new Promise((res) => setImmediate(res));
    }
    expect(batches).toEqual([3, 3]);
    await r.close();
    expect(batches).toEqual([3, 3, 1]);
  });

  it('到了节拍没到批量也会写（在跑的段页面要看到新的）', async () => {
    const { r, written } = recorder({ batchSize: 100, flushEveryMs: 5 });
    r.record({ at, kind: 'assistant', text: '一句' });
    await new Promise((res) => setTimeout(res, 60));
    expect(written).toHaveLength(1);
    await r.close();
  });

  it('时间认不出就用记录员的时钟，不写 Invalid Date', async () => {
    const now = new Date('2026-10-10T01:02:03.000Z');
    const { r, written } = recorder({ now: () => now });
    r.record({ at: '不是时间', kind: 'assistant', text: 'x' });
    await r.close();
    expect(written[0]?.at).toEqual(now);
  });
});

describe('写库失败不影响会话', () => {
  it('【故意造出的失败】写抛错：record / prompt / close 都不抛，只记一次日志', async () => {
    const logs: string[] = [];
    const r = new TranscriptRecorder({
      runId: 'run-1',
      write: async () => {
        throw new Error('connection terminated');
      },
      log: (m) => void logs.push(m),
      batchSize: 1,
      flushEveryMs: 5,
    });
    r.prompt('p');
    r.record({ at, kind: 'assistant', text: 'a' });
    r.record({ at, kind: 'assistant', text: 'b' });
    await expect(r.close()).resolves.toBeUndefined();
    expect(logs.filter((l) => l.includes('写不进库'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('收场时仍没写进库'))).toBe(true);
  });

  it('一时写不进、后面好了：留着的补写，顺序不乱，编号不空', async () => {
    const written: TranscriptRow[] = [];
    let calls = 0;
    const r = new TranscriptRecorder({
      runId: 'run-1',
      write: async (_id, rows) => {
        calls++;
        if (calls === 1) throw new Error('一时的');
        written.push(...rows);
      },
      batchSize: 2,
      flushEveryMs: 60_000,
    });
    for (const t of ['a', 'b', 'c']) r.record({ at, kind: 'assistant', text: t });
    await r.close();
    expect(written.map((w) => [w.seq, w.text])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('close 之后再来的条目不记也不抛', async () => {
    const { r, written } = recorder();
    await r.close();
    r.record({ at, kind: 'assistant', text: '迟到' });
    expect(written).toEqual([]);
  });
});
