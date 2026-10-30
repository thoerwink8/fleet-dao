import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createFleetMcpServer, type FleetMcpDeps, fleetMcpSourceKind } from '../src/fleet-mcp.ts';

interface Seen {
  url: string;
  method: string;
  token: string | null;
  body: unknown;
}

function setup(reply: (seen: Seen) => { status: number; body: unknown } | Error, claimCode = 0) {
  const seen: Seen[] = [];
  const claims: number[] = [];
  const deps: FleetMcpDeps = {
    source: 'mirasim',
    endpoint: () => ({ url: 'https://fr.example/', token: 'tok-1' }),
    fetch: (async (url: string, init: RequestInit) => {
      const s: Seen = {
        url,
        method: init.method ?? 'GET',
        token: new Headers(init.headers).get('X-Fleet-Node-Token'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(s);
      const r = reply(s);
      if (r instanceof Error) throw r;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch,
    claim: async (n) => {
      claims.push(n);
      return claimCode === 0
        ? { code: 0, out: [`已领 #${n}`], err: [] }
        : { code: 1, out: [], err: ['引擎在做'] };
    },
  };
  return { deps, seen, claims };
}

async function connect(deps: FleetMcpDeps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createFleetMcpServer(deps).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

const issueArgs = {
  kind: '需求',
  domain: 'engine',
  nature: 'process',
  milestone: '当前',
  title: '标题',
  body: '## 场景\n…',
  local: false,
  ref: 'sess-1',
};

describe('fleet MCP', () => {
  it('列出 4 个工具，描述是中文', async () => {
    const c = await connect(setup(() => ({ status: 200, body: {} })).deps);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'fleet_claim',
      'fleet_dispatch',
      'fleet_events',
      'fleet_issue_open',
    ]);
    expect(tools.find((t) => t.name === 'fleet_issue_open')?.description).toContain('要合 PR');
  });

  it('开单成功：带通行证、来源、自动幂等钥匙', async () => {
    const s = setup(() => ({ status: 200, body: { number: 7, url: 'https://gh/7', created: true } }));
    const r = await (await connect(s.deps)).callTool({ name: 'fleet_issue_open', arguments: issueArgs });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain('#7');
    const [req] = s.seen;
    expect(req?.url).toBe('https://fr.example/api/nodes/issues');
    expect(req?.token).toBe('tok-1');
    expect(req?.body).toMatchObject({
      repo: 'thoerwink8/fleet-dao',
      source: { kind: 'mirasim', ref: 'sess-1' },
      milestone: '当前',
    });
    expect(req?.body).toMatchObject({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it('开单 409 候选、422 问题照实返回并标 isError', async () => {
    const c409 = setup(() => ({ status: 409, body: { candidates: [{ number: 3, title: '像' }] } }));
    const r1 = await (await connect(c409.deps)).callTool({ name: 'fleet_issue_open', arguments: issueArgs });
    expect(isError(r1)).toBe(true);
    expect(text(r1)).toContain('mergeInto');
    expect(text(r1)).toContain('像');
    const c422 = setup(() => ({ status: 422, body: { problems: ['缺「## 原话」'] } }));
    const r2 = await (await connect(c422.deps)).callTool({ name: 'fleet_issue_open', arguments: issueArgs });
    expect(isError(r2)).toBe(true);
    expect(text(r2)).toContain('缺「## 原话」');
  });

  it('开单：200 但回包认不出不算成功', async () => {
    const s = setup(() => ({ status: 200, body: {} }));
    const r = await (await connect(s.deps)).callTool({ name: 'fleet_issue_open', arguments: issueArgs });
    expect(isError(r)).toBe(true);
  });

  it('派单成功；准入没过列出每条原因；503 说不知道派没派', async () => {
    const ok = setup(() => ({ status: 200, body: { result: 'dispatched', text: '起了' } }));
    const r = await (await connect(ok.deps)).callTool({
      name: 'fleet_dispatch',
      arguments: { issueNumber: 12, ref: '12' },
    });
    expect(isError(r)).toBe(false);
    expect(ok.seen[0]?.body).toEqual({
      repo: 'thoerwink8/fleet-dao',
      issueNumber: 12,
      source: { kind: 'mirasim', ref: '12' },
    });
    const no = setup(() => ({
      status: 409,
      body: { result: 'refused', reasons: [{ reason: 'has_pr', why: '已有 PR' }], text: '不派' },
    }));
    const r2 = await (await connect(no.deps)).callTool({
      name: 'fleet_dispatch',
      arguments: { issueNumber: 12, ref: '12' },
    });
    expect(isError(r2)).toBe(true);
    expect(text(r2)).toContain('has_pr：已有 PR');
    const down = setup(() => ({ status: 503, body: { error: { code: 'x', message: '读不到库' } } }));
    const r3 = await (await connect(down.deps)).callTool({
      name: 'fleet_dispatch',
      arguments: { issueNumber: 12, ref: '12' },
    });
    expect(isError(r3)).toBe(true);
    expect(text(r3)).toContain('读不到库');
    expect(text(r3)).toContain('不知道有没有做成');
  });

  it('领单：成功原样回；退出码非 0 标 isError', async () => {
    const good = setup(() => ({ status: 200, body: {} }));
    const r = await (await connect(good.deps)).callTool({
      name: 'fleet_claim',
      arguments: { issueNumber: 5 },
    });
    expect(isError(r)).toBe(false);
    expect(good.claims).toEqual([5]);
    expect(text(r)).toContain('已领 #5');
    const bad = setup(() => ({ status: 200, body: {} }), 1);
    const r2 = await (await connect(bad.deps)).callTool({
      name: 'fleet_claim',
      arguments: { issueNumber: 5 },
    });
    expect(isError(r2)).toBe(true);
    expect(text(r2)).toContain('引擎在做');
  });

  it('读账本：带 after、limit；回包缺 events 算错', async () => {
    const s = setup(() => ({
      status: 200,
      body: {
        events: [
          {
            id: 3,
            at: 't',
            actorKind: 'agent',
            actorId: 'n',
            action: 'a',
            target: 'x',
            after: null,
            ok: true,
          },
        ],
        next: 3,
      },
    }));
    const r = await (await connect(s.deps)).callTool({
      name: 'fleet_events',
      arguments: { after: 2, limit: 10 },
    });
    expect(isError(r)).toBe(false);
    expect(s.seen[0]?.method).toBe('GET');
    expect(s.seen[0]?.url).toBe('https://fr.example/api/nodes/events?after=2&limit=10');
    expect(text(r)).toContain('after=3');
    const bad = setup(() => ({ status: 200, body: { nope: 1 } }));
    expect(isError(await (await connect(bad.deps)).callTool({ name: 'fleet_events', arguments: {} }))).toBe(
      true,
    );
  });

  it('网络不通、回的不是 JSON、401 都是 isError，不泄露通行证', async () => {
    const net = setup(() => new Error('ECONNREFUSED'));
    const r = await (await connect(net.deps)).callTool({ name: 'fleet_events', arguments: {} });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('ECONNREFUSED');
    const html = setup(() => ({ status: 502, body: '<html>bad gateway</html>' }));
    const r2 = await (await connect(html.deps)).callTool({ name: 'fleet_events', arguments: {} });
    expect(isError(r2)).toBe(true);
    expect(text(r2)).toContain('bad gateway');
    const unauth = setup(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: '通行证不对' } },
    }));
    const r3 = await (await connect(unauth.deps)).callTool({ name: 'fleet_events', arguments: {} });
    expect(isError(r3)).toBe(true);
    expect(text(r3)).not.toContain('tok-1');
  });

  it('通行证读不到：isError 并带原因', async () => {
    const s = setup(() => ({ status: 200, body: {} }));
    s.deps.endpoint = () => {
      throw new Error('读不到 config.json');
    };
    const r = await (await connect(s.deps)).callTool({ name: 'fleet_events', arguments: {} });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('读不到 config.json');
  });

  it('入参不合约定被拒（单号要正整数）', async () => {
    const s = setup(() => ({ status: 200, body: {} }));
    const r = await (await connect(s.deps)).callTool({
      name: 'fleet_dispatch',
      arguments: { issueNumber: 0, ref: 'x' },
    });
    expect(isError(r)).toBe(true);
    expect(s.seen).toEqual([]);
  });
});

describe('fleetMcpSourceKind', () => {
  it('默认 local-session，认 4 个值，认不出抛', () => {
    expect(fleetMcpSourceKind({})).toBe('local-session');
    expect(fleetMcpSourceKind({ FLEET_MCP_SOURCE: 'harness-chat' })).toBe('harness-chat');
    expect(() => fleetMcpSourceKind({ FLEET_MCP_SOURCE: 'bogus' })).toThrow('认不出');
  });
});
