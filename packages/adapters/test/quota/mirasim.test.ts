import { describe, expect, it } from 'vitest';
import {
  QuotaReadError,
  readAllQuotas,
  readingsFromRelayFrame,
  windowsForModel,
} from '../../src/quota/index.ts';
import { blockNetwork, FakeSocket, fakeDeps, fakeFiles, fixtureJson } from './helpers.ts';

blockNetwork();

const ctx = { poolId: 'mirasim-relay', fetchedAt: '2026-09-24T19:00:00.000Z' };
const frame0924 = () => fixtureJson('mirasim-relay-2026-09-24.json');
const frame0906 = () => fixtureJson('mirasim-relay-2026-09-06.json');

function relayWith(windows: unknown[], usage: Record<string, unknown> = {}) {
  return {
    type: 'relay',
    relay: { usage: { ok: true, capturedAt: '2026-09-24T18:59:47.384Z', windows, ...usage } },
  };
}

describe('Mirasim 中转：getRelay 真机帧 → 每池每窗一行', () => {
  it('每个窗口各存一行：5h 快清零且几乎没用，这个信号不能被最紧的 7d 盖掉', () => {
    const { windows } = readingsFromRelayFrame(frame0924(), ctx);
    expect(windows.map((w) => w.label)).toEqual(['5h', '7d', '7d_claude', '7d_fable']);
    const fiveHour = windows[0];
    expect(fiveHour).toMatchObject({
      poolId: 'mirasim-relay',
      window: '5h',
      unit: 'points',
      used: 1140.30619063,
      limit: 143528,
      resetsAt: '2026-09-24T19:06:54.000Z',
      upstreamStatus: 'allowed',
      reading: 'measured',
      source: 'mirasim-relay',
      readAt: '2026-09-24T18:59:47.384Z',
    });
    expect(fiveHour?.scope).toBeUndefined();
    expect(windows[1]).toMatchObject({ window: '7d', used: 285510.67814471, limit: 512600 });
  });

  it('只扣某一族的窗口带组名，账号级窗口不带', () => {
    const { windows } = readingsFromRelayFrame(frame0924(), ctx);
    expect(windows.map((w) => [w.label, w.window, w.scope])).toEqual([
      ['5h', '5h', undefined],
      ['7d', '7d', undefined],
      ['7d_claude', '7d_model', 'claude'],
      ['7d_fable', '7d_model', 'fable'],
    ]);
  });

  it('窗口集合不固定：09-06 的帧没有 7d_claude，09-24 多出来的照收；从没见过的窗口也不丢', () => {
    expect(readingsFromRelayFrame(frame0906(), ctx).windows.map((w) => w.label)).toEqual([
      '5h',
      '7d',
      '7d_fable',
    ]);
    const odd = readingsFromRelayFrame(
      relayWith([
        { label: '1d_gpt', used: 10, budget: 100, resetAt: '2026-09-25T00:00:00Z', status: 'allowed' },
        { label: 'burst', used: 1, budget: 4, resetAt: '2026-09-24T20:00:00Z', status: 'surge' },
      ]),
      ctx,
    );
    expect(odd.windows).toMatchObject([
      { label: '1d_gpt', window: 'other', scope: 'gpt', used: 10, limit: 100 },
      { label: 'burst', window: 'other', used: 1, limit: 4, statusRaw: 'surge' },
    ]);
    expect(odd.windows[1]?.upstreamStatus).toBeUndefined();
  });

  it('上限每次都从这一帧重读：官方改档后按新上限算，不沿用旧值', () => {
    const before = readingsFromRelayFrame(frame0906(), ctx).windows.find((w) => w.label === '5h');
    const after = readingsFromRelayFrame(frame0924(), ctx).windows.find((w) => w.label === '5h');
    expect(before?.limit).toBe(171852);
    expect(after?.limit).toBe(143528);
    expect(after?.utilization).toBeCloseTo(1140.30619063 / 143528, 10);
  });

  it('以上游状态字为准：7d_fable 用到 99.04% 上游就说 limit_reached，7d 到 85% 就 warning', () => {
    const { windows } = readingsFromRelayFrame(frame0906(), ctx);
    const fable = windows.find((w) => w.label === '7d_fable');
    expect(fable?.used).toBeLessThan(fable?.limit ?? 0);
    expect(fable?.upstreamStatus).toBe('limit_reached');
    expect(windows.find((w) => w.label === '7d')?.upstreamStatus).toBe('warning');
  });

  it('模型组窗口只卡对应模型：7d_fable 满了，gpt 路由照样只看 5h / 7d', () => {
    const { windows } = readingsFromRelayFrame(frame0906(), ctx);
    const full = (model: string) =>
      windowsForModel(windows, { id: model })
        .filter((w) => w.upstreamStatus === 'limit_reached')
        .map((w) => w.label);
    expect(full('claude-5-fable-medium')).toEqual(['7d_fable']);
    expect(full('gpt-5.6-luna')).toEqual([]);
  });

  it('利用率按已用 ÷ 上限算，不看上游百分比的刻度（0–1 还是 0–100）', () => {
    const { windows } = readingsFromRelayFrame(
      relayWith([{ label: '7d', usedPercent: 0.9, used: 9, budget: 1000, resetAt: '2026-09-29T00:00:00Z' }]),
      ctx,
    );
    expect(windows[0]?.utilization).toBeCloseTo(0.009, 10);
  });

  it('没给清零时刻时按 resetAfterSeconds 从采样时刻推', () => {
    const { windows } = readingsFromRelayFrame(
      relayWith([{ label: '5h', used: 1, budget: 10, resetAfterSeconds: 60 }]),
      ctx,
    );
    expect(windows[0]?.resetsAt).toBe('2026-09-24T19:00:47.384Z');
  });
});

describe('Mirasim 中转：读到 0 个窗口 ≠ 没读成', () => {
  it('上游说 ok 而窗口为空：零个窗口，正常返回', () => {
    const out = readingsFromRelayFrame(relayWith([]), ctx);
    expect(out.windows).toEqual([]);
    expect(out.notes.join()).toContain('没有额度窗口');
  });

  it('usage.ok 不为真：上游没读成，报 upstream，不填默认窗口', () => {
    const bad = relayWith([], { ok: false, status: 'error', error: 'relay-limits failed' });
    expect(() => readingsFromRelayFrame(bad, ctx)).toThrowError(QuotaReadError);
    try {
      readingsFromRelayFrame(bad, ctx);
    } catch (e) {
      expect((e as QuotaReadError).code).toBe('upstream');
    }
  });

  it('错误帧、别的帧、空帧各有明确失败', () => {
    const code = (f: unknown) => {
      try {
        readingsFromRelayFrame(f, ctx);
        return 'ok';
      } catch (e) {
        return (e as QuotaReadError).code;
      }
    };
    expect(code({ type: 'error', message: 'nope' })).toBe('upstream');
    expect(code({ type: 'state', state: {} })).toBe('bad_response');
    expect(code(null)).toBe('bad_response');
    expect(code({ type: 'relay', relay: {} })).toBe('bad_response');
    expect(code({ type: 'relay', relay: { usage: { ok: true, windows: 'x' } } })).toBe('bad_response');
  });

  it('个别窗口缺数：那一格不收并写明，其余照收；全坏才算失败', () => {
    const some = readingsFromRelayFrame(
      relayWith([
        { label: '5h', used: 1, budget: 10, resetAt: '2026-09-24T20:00:00Z' },
        { label: '7d', used: 'n/a', budget: 10 },
      ]),
      ctx,
    );
    expect(some.windows.map((w) => w.label)).toEqual(['5h']);
    expect(some.notes.join()).toContain('7d');
    expect(() => readingsFromRelayFrame(relayWith([{ label: '7d', budget: 0 }]), ctx)).toThrowError(/认不出/);
  });

  it('缺数字但带着 limit_reached 的窗口不丢：只留状态字，调度照样看得见它满了', () => {
    const { windows, notes } = readingsFromRelayFrame(
      relayWith([
        { label: '7d_fable', status: 'limit_reached', modelScoped: true, resetAt: '2026-09-29T05:27:56Z' },
      ]),
      ctx,
    );
    expect(windows).toEqual([
      expect.objectContaining({
        label: '7d_fable',
        window: '7d_model',
        scope: 'fable',
        upstreamStatus: 'limit_reached',
        resetsAt: '2026-09-29T05:27:56.000Z',
      }),
    ]);
    expect(windows[0]?.used).toBeUndefined();
    expect(notes.join()).toContain('只留上游状态字');
  });

  it('点数缺了、百分比还在：按「已用 + 剩余」认刻度，认不出刻度就不收', () => {
    const { windows } = readingsFromRelayFrame(
      relayWith([
        { label: '5h', usedPercent: 0.9, remainingPercent: 99.1, resetAt: '2026-09-24T20:00:00Z' },
        { label: '7d', usedPercent: 0.557, remainingPercent: 0.443, resetAt: '2026-09-29T00:00:00Z' },
      ]),
      ctx,
    );
    expect(windows).toMatchObject([
      { label: '5h', unit: 'percent', used: 0.9, limit: 100 },
      { label: '7d', unit: 'percent', limit: 100 },
    ]);
    expect(windows[0]?.utilization).toBeCloseTo(0.009, 10);
    expect(windows[1]?.used).toBeCloseTo(55.7, 10);
    expect(() =>
      readingsFromRelayFrame(relayWith([{ label: '7d', usedPercent: 40, remainingPercent: 40 }]), ctx),
    ).toThrowError(/认不出/);
  });
});

describe('Mirasim 中转读取器：回环 WebSocket', () => {
  const pool = {
    poolId: 'mirasim-relay',
    channelId: 'mirasim',
    reader: 'mirasim-relay' as const,
    port: 4316,
  };
  const tokenPath = '/home/tester/.mirasim/run/local-4316.token';

  it('读令牌 → 握手 → getRelay → 收成窗口；令牌只进 URL', async () => {
    let socket: FakeSocket | undefined;
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({
        readFile: fakeFiles({ [tokenPath]: 'secret-token-value\n' }),
        openWebSocket: (url) => {
          socket = new FakeSocket(url, (msg) => (msg.type === 'getRelay' ? [frame0924()] : []));
          return socket;
        },
      }),
    );
    const r = report.results[0];
    expect(r?.ok).toBe(true);
    expect(r?.ok && r.windows.length).toBe(4);
    expect(socket?.url).toBe('ws://127.0.0.1:4316/ws?token=secret-token-value');
    expect(socket?.sent).toEqual([{ type: 'clientHello' }, { type: 'getState' }, { type: 'getRelay' }]);
    expect(socket?.closed).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret-token-value');
  });

  it('令牌文件不在：no_credentials，写明是服务没跑还是没权限', async () => {
    const report = await readAllQuotas({ pools: [pool] }, fakeDeps({ readFile: fakeFiles({}) }));
    const r = report.results[0];
    expect(r?.ok).toBe(false);
    expect(!r?.ok && r?.error.code).toBe('no_credentials');
    const empty = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({ readFile: fakeFiles({ [tokenPath]: '  \n' }) }),
    );
    expect(!empty.results[0]?.ok && empty.results[0]?.error.code).toBe('no_credentials');
  });

  it('连不上回环端口：unreachable，令牌不进错误信息', async () => {
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({
        readFile: fakeFiles({ [tokenPath]: 'secret-token-value' }),
        openWebSocket: (url) => new FakeSocket(url, () => [], 'refuse'),
      }),
    );
    const r = report.results[0];
    expect(!r?.ok && r?.error.code).toBe('unreachable');
    expect(JSON.stringify(report)).not.toContain('secret-token-value');
  });

  it('服务端一直不回 relay 帧：到点报 timeout，不挂住', async () => {
    const report = await readAllQuotas(
      { pools: [{ ...pool, timeoutMs: 50 }] },
      fakeDeps({
        readFile: fakeFiles({ [tokenPath]: 'tok' }),
        openWebSocket: (url) => new FakeSocket(url, () => []),
      }),
    );
    const r = report.results[0];
    expect(!r?.ok && r?.error.code).toBe('timeout');
  });
});
