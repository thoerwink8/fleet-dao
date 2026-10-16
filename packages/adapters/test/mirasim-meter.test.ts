// Mirasim 用量账本（中转计量）按会话读（#1935）：行的形状照法国会话用户 ~/.mirasim/insights/usage-2026-10.ndjson 的真行
// （去掉了账号、仓这类和用量无关的字段）。全 0 的占位不许读成 0；回填了的读对；中转没有记录的、认不出的明说读不成。
import { describe, expect, it } from 'vitest';
import { type MeterFs, meterReadingFrom, readMirasimMeter } from '../src/mirasim/meter.ts';

const SESSION = '900a810b-7b5f-4ad0-82a2-f46e3b05a6d5';
const OTHER = '6030fb0e-69b7-497d-8119-b304941e3497';
const KEY = `claude:${SESSION}`;
const T0 = Date.parse('2026-10-12T06:30:00.000Z');
const WINDOW = { sessionKey: KEY, since: T0, until: T0 + 10 * 60_000 };

let seq = 0;
/** 一次走中转的 2xx 调用；默认是回填好了的。 */
function call(over: Record<string, unknown> = {}): string {
  seq += 1;
  const callId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return JSON.stringify({
    v: 1,
    id: `${SESSION}:${callId}`,
    ts: new Date(T0 + seq * 1000).toISOString(),
    sessionId: SESSION,
    agent: 'claude',
    provider: 'anthropic',
    upstreamHost: 'relay.mirasim.ai',
    viaRelay: true,
    leg: 'relay',
    model: 'claude-sonnet-5-5',
    status: 200,
    input: 2,
    output: 3963,
    cacheRead: 341543,
    cacheWrite: 4923,
    reasoning: 0,
    relayCallId: `r${seq}`,
    workspace: `/var/lib/fleet-work/_tmp/verify-${SESSION}`,
    relayMetered: true,
    ...over,
  });
}

/** 调用当时写下的那一行：四样全 0，还没回填。 */
const placeholder = (over: Record<string, unknown> = {}) =>
  call({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, relayMetered: undefined, ...over });

describe('meterReadingFrom：一次会话的中转计量', () => {
  it('只有全 0 的占位：判「还在等回填」，不读成 0（故意造的失败：占位不许冒充读到了）', () => {
    const r = meterReadingFrom([placeholder(), placeholder()].join('\n'), WINDOW);
    expect(r.state).toBe('pending');
    expect(r).toMatchObject({ pending: 2, calls: 2 });
    expect(r).not.toHaveProperty('usage');
  });

  it('回填齐了：四样逐次加起来；别的会话、本地回的、没回 2xx 的、起止以外的都不算', () => {
    const lines = [
      call({ input: 2, output: 3963, cacheRead: 341543, cacheWrite: 4923 }),
      call({ input: 7297, output: 60, cacheRead: 0, cacheWrite: 62513 }),
      // 别的会话（工作目录里带着本会话的 uuid 也不算：按 sessionId 认）
      call({ sessionId: OTHER, id: `${OTHER}:x`, input: 999, output: 999 }),
      // 本地回的 422（不走上游）
      call({ leg: 'local', viaRelay: false, answeredLocally: true, status: 422, input: 0, output: 0 }),
      // 上游没回 2xx
      call({ status: 529, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, relayMetered: undefined }),
      // 这一笔开始之前（续跑的会话上一轮发的）
      call({ ts: new Date(T0 - 60_000).toISOString(), input: 5000, output: 5000 }),
    ];
    const r = meterReadingFrom(lines.join('\n'), WINDOW);
    expect(r).toEqual({
      state: 'settled',
      usage: {
        inputTokens: 7299,
        outputTokens: 4023,
        cacheReadTokens: 341543,
        cacheWriteTokens: 67436,
        calls: 2,
      },
    });
  });

  it('有一次回填了、一次还是占位：整次算没齐，不给部分数', () => {
    const r = meterReadingFrom([call(), placeholder()].join('\n'), WINDOW);
    expect(r).toMatchObject({ state: 'pending', pending: 1, calls: 2 });
  });

  it('中转没有这次调用的记录（noRelayRecord）：读不成、写明原因，不拿 0 顶', () => {
    const r = meterReadingFrom([call(), placeholder({ noRelayRecord: true })].join('\n'), WINDOW);
    expect(r.state).toBe('unknown');
    expect(r.state === 'unknown' && r.detail).toContain('中转没有这次调用的计量记录');
  });

  it('从执行体自己的记录抄来的用量（usageSource: agent）服务端还会再问中转：算还在等', () => {
    const r = meterReadingFrom(call({ relayMetered: undefined, usageSource: 'agent' }), WINDOW);
    expect(r.state).toBe('pending');
  });

  it('走中转、当场就有用量又不是抄来的：服务端不再问中转，照它算（和服务端 Wzn 同一条判法）', () => {
    const r = meterReadingFrom(
      call({ relayMetered: undefined, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }),
      WINDOW,
    );
    expect(r).toMatchObject({ state: 'settled', usage: { inputTokens: 10, outputTokens: 20 } });
  });

  it('花费：每一次都报了 relayUsd 才给合计，有一次没报就不给', () => {
    const all = meterReadingFrom([call({ relayUsd: 0.01 }), call({ relayUsd: 0.02 })].join('\n'), WINDOW);
    expect(all.state === 'settled' && all.usage.costUsd).toBe(0.03);
    const some = meterReadingFrom([call({ relayUsd: 0.01 }), call()].join('\n'), WINDOW);
    expect(some.state === 'settled' && 'costUsd' in some.usage).toBe(false);
  });

  it('带这个会话号的行认不出、token 数认不出、一次计费调用都没有：读不成', () => {
    expect(meterReadingFrom(`{"id":"${SESSION}:x",`, WINDOW).state).toBe('unknown');
    expect(meterReadingFrom(call({ input: -1 }), WINDOW).state).toBe('unknown');
    // 只看用量账本分不出没调用还是没记上：带 noBilledCalls，readMirasimMeter 再拿流量记录核（#2675）
    expect(meterReadingFrom('', WINDOW)).toEqual({
      state: 'unknown',
      detail: 'Mirasim 用量账本里没有这个会话在这一笔起止之间的计费调用',
      noBilledCalls: true,
    });
    expect(meterReadingFrom(call(), { ...WINDOW, sessionKey: 'claude:不是uuid' }).state).toBe('unknown');
  });
});

describe('readMirasimMeter：一轮读几次会话', () => {
  function fakeFs(files: Record<string, string>): MeterFs & { asked: string[][] } {
    const asked: string[][] = [];
    return {
      asked,
      async readdir(dir) {
        if (dir !== '/home/u/.mirasim/insights') throw Object.assign(new Error('no'), { code: 'ENOENT' });
        return Object.keys(files);
      },
      async linesWith(needles, paths) {
        asked.push([...paths]);
        return paths
          .flatMap((p) => (files[p.split(/[\\/]/).pop() ?? ''] ?? '').split('\n'))
          .filter((l) => needles.some((n) => l.includes(n)))
          .join('\n');
      },
    };
  }

  it('只读这几笔起止所在月份的文件，按会话一一回读数', async () => {
    const fs = fakeFs({
      'usage-2026-09.ndjson': call({ ts: '2026-09-01T00:00:00.000Z' }),
      'usage-2026-10.ndjson': [call(), placeholder({ sessionId: OTHER, id: `${OTHER}:p` })].join('\n'),
      'session-usage-2026-10.ndjson': '不是调用账本',
    });
    const out = await readMirasimMeter(
      '/home/u/.mirasim/insights',
      [WINDOW, { ...WINDOW, sessionKey: `claude:${OTHER}` }],
      fs,
    );
    expect(out[0]?.state).toBe('settled');
    expect(out[1]?.state).toBe('pending');
    expect(fs.asked).toEqual([['/home/u/.mirasim/insights/usage-2026-10.ndjson']]);
  });

  it('账本目录不在：整轮没查成，抛出来，不回一串「没有调用」', async () => {
    await expect(readMirasimMeter('/nope', [WINDOW], fakeFs({}))).rejects.toThrow(
      '没有 Mirasim 用量账本目录',
    );
  });
});
