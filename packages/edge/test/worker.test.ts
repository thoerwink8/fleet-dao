// Worker 怎么读环境、怎么探测、密钥缺失怎么失败（#292 第 1 片）。判法本身在 judge.test.ts。
import { describe, expect, it } from 'vitest';
import worker, { type EdgeEnv, type EdgeStateStore, runRound, STATE_KEY } from '../src/worker.ts';

const T0 = Date.parse('2026-10-10T12:00:00+08:00');
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-hook-token-for-logs';
const WATCH = 'watch-id-for-test';
const HK = 'https://hk.example/';
const FR = 'https://hk.example/healthz';

function memoryStore(): EdgeStateStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function env(over: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    FLEET_EDGE_HK_URL: HK,
    FLEET_EDGE_FR_URL: FR,
    FLEET_FEISHU_WEBHOOK: HOOK,
    FLEET_EDGE_WATCH_ID: WATCH,
    EDGE_STATE: memoryStore(),
    ...over,
  };
}

function header(init: RequestInit | undefined): string | undefined {
  const h = init?.headers;
  if (h === undefined || h instanceof Headers || Array.isArray(h)) return undefined;
  const v = h['x-fleet-watch'];
  return typeof v === 'string' ? v : undefined;
}

function scripted(statusFor: (url: string) => number | 'throw') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(init === undefined ? { url } : { url, init });
    const status = statusFor(url);
    if (status === 'throw') return Promise.reject(new Error(`connect failed ${url}`));
    if (url === HOOK) {
      return Promise.resolve(new Response(JSON.stringify({ code: 0 }), { status }));
    }
    return Promise.resolve(new Response('ok', { status }));
  };
  return { calls, fetchImpl };
}

async function round(partial: Partial<EdgeEnv>, statusFor: (url: string) => number | 'throw', now = T0) {
  const lines: string[] = [];
  const e = env(partial);
  const net = scripted(statusFor);
  await runRound({
    env: e,
    now,
    fetchImpl: net.fetchImpl,
    log: (line) => lines.push(line),
  });
  return { lines, calls: net.calls, store: e.EDGE_STATE as ReturnType<typeof memoryStore> };
}

describe('runRound', () => {
  it('读不到密钥：这一轮没查成并写日志，不探测，不当成没挂', async () => {
    const lines: string[] = [];
    const net = scripted(() => 200);
    const e = env({ FLEET_FEISHU_WEBHOOK: '  ' });
    delete e.FLEET_EDGE_WATCH_ID;
    await expect(
      runRound({
        env: e,
        now: T0,
        fetchImpl: net.fetchImpl,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/没查成/);
    const logged = lines.join('\n');
    expect(logged).toContain('没查成');
    expect(logged).toContain('不当成没挂');
    expect(logged).toContain('FLEET_FEISHU_WEBHOOK');
    expect(logged).toContain('FLEET_EDGE_WATCH_ID');
    expect(logged).not.toContain(HOOK);
    expect(net.calls).toEqual([]);
  });

  it('飞书地址不认：日志不带那串地址，不把这一轮当成没挂', async () => {
    const lines: string[] = [];
    const secret = 'https://evil.example/hook/super-secret-token';
    const net = scripted(() => 200);
    await expect(
      runRound({
        env: env({ FLEET_FEISHU_WEBHOOK: secret }),
        now: T0,
        fetchImpl: net.fetchImpl,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/没查成/);
    const logged = lines.join('\n');
    expect(logged).toContain('地址不认');
    expect(logged).toContain('不当成没挂');
    expect(logged).not.toContain('super-secret-token');
    expect(net.calls).toEqual([]);
  });

  it('两次探测都带 x-fleet-watch，值是 FLEET_EDGE_WATCH_ID', async () => {
    const { calls } = await round({}, (url) => (url === HOOK ? 200 : 200));
    const probes = calls.filter((c) => c.url !== HOOK);
    expect(probes.map((c) => c.url).sort()).toEqual([FR, HK].sort());
    expect(probes.every((c) => header(c.init) === WATCH)).toBe(true);
    expect(calls.some((c) => c.url === HOOK)).toBe(false);
  });

  it('法国 502 把判出来的正文推给飞书，状态记下', async () => {
    const { calls, store } = await round({}, (url) => (url === FR ? 502 : 200));
    const post = calls.find((c) => c.url === HOOK);
    expect(post).toBeDefined();
    const body = JSON.parse(String(post?.init?.body)) as { msg_type: string; content: { text: string } };
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('法国挂了');
    expect(body.content.text).not.toContain(HOOK);
    const saved = [...store.data.values()].join('\n');
    expect(saved).toContain('"status":"down"');
  });

  it('同一次挂着不到一小时不再推', async () => {
    const e = env();
    const net1 = scripted((url) => (url === FR ? 502 : 200));
    await runRound({ env: e, now: T0, fetchImpl: net1.fetchImpl, log: () => {} });
    const net2 = scripted((url) => (url === FR ? 502 : 200));
    await runRound({ env: e, now: T0 + 5 * 60_000, fetchImpl: net2.fetchImpl, log: () => {} });
    expect(net2.calls.some((c) => c.url === HOOK)).toBe(false);
  });

  it('飞书没推成：这一轮失败，不把状态写成已经推过', async () => {
    const lines: string[] = [];
    const e = env();
    const fetchImpl: typeof fetch = (input, _init) => {
      const url = String(input);
      if (url === HOOK)
        return Promise.resolve(new Response(JSON.stringify({ code: 19001 }), { status: 200 }));
      return Promise.resolve(new Response('no', { status: url === FR ? 502 : 200 }));
    };
    await expect(runRound({ env: e, now: T0, fetchImpl, log: (line) => lines.push(line) })).rejects.toThrow(
      /没推成/,
    );
    expect(lines.join('\n')).not.toContain(HOOK);
    expect([...(e.EDGE_STATE as ReturnType<typeof memoryStore>).data.values()]).toEqual([]);
  });

  it('上一轮状态读失败：照挂处理并且推，不静默', async () => {
    const store: EdgeStateStore = {
      get: () => Promise.reject(new Error('kv down')),
      put: () => Promise.resolve(),
    };
    const { calls } = await round({ EDGE_STATE: store }, () => 200);
    const post = calls.find((c) => c.url === HOOK);
    const body = JSON.parse(String(post?.init?.body)) as { content: { text: string } };
    expect(body.content.text).toContain('读不到上一轮状态');
    expect(body.content.text).toContain('照挂处理');
    expect(body.content.text).toContain('不静默');
  });

  it('存着的内容认不出：同样照挂处理，不当成没挂', async () => {
    const store = memoryStore();
    store.data.set(STATE_KEY, '{');
    const { calls } = await round({ EDGE_STATE: store }, () => 200);
    const post = calls.find((c) => c.url === HOOK);
    const body = JSON.parse(String(post?.init?.body)) as { content: { text: string } };
    expect(body.content.text).toContain('照挂处理');
  });

  it('已存的空串或全空白认不出上一轮：两台都活着也照挂处理并且推，不静默', async () => {
    for (const raw of ['', '   ', '\n\t ']) {
      const store = memoryStore();
      store.data.set(STATE_KEY, raw);
      const lines: string[] = [];
      const net = scripted(() => 200);
      await runRound({
        env: env({ EDGE_STATE: store }),
        now: T0,
        fetchImpl: net.fetchImpl,
        log: (line) => lines.push(line),
      });
      const post = net.calls.find((c) => c.url === HOOK);
      expect(post, JSON.stringify(raw)).toBeDefined();
      const body = JSON.parse(String(post?.init?.body)) as { content: { text: string } };
      expect(body.content.text, JSON.stringify(raw)).toContain('读不到上一轮状态');
      expect(body.content.text, JSON.stringify(raw)).toContain('照挂处理');
      expect(body.content.text, JSON.stringify(raw)).toContain('不静默');
      expect(body.content.text, JSON.stringify(raw)).not.toContain('没挂');
      expect(lines.join('\n'), JSON.stringify(raw)).toContain('存着的内容认不出');
    }
  });

  it('定时入口读不到密钥时拒绝', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      await expect(worker.scheduled({ scheduledTime: T0, cron: '*/5 * * * *' }, {})).rejects.toThrow(
        /没查成/,
      );
    } finally {
      console.error = orig;
    }
    expect(lines.join('\n')).toContain('不当成没挂');
  });
});
