// 推送方（node-reporter.ts）：在假服务器上推成、401、超时、断网各一条；没推成 /healthz 的 node_report 报红、日志里有原文，
// 不吞；没配推送地址不建、不起循环、不发一个请求；循环一轮做完才排下一轮，停了就不再推。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeReportSchema } from '@fleet-dao/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHealthChecks } from '../src/health.ts';
import {
  createNodeReporter,
  NODE_REPORT_HEADER,
  NODE_REPORT_NOT_WIRED,
  type NodeReporterInput,
  nodeReporterFor,
  nodeReportPart,
} from '../src/node-reporter.ts';
import type { Logger } from '../src/ports.ts';
import { sampleSnapshot } from './node-snapshot-fixture.ts';

const TOKEN = 'node-report-token-for-tests-0123456789';
const SHA = 'a0006685f092154f90b462cc74e8872d32e50c15';
const T0 = new Date('2026-09-25T08:00:00.000Z');

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

/** 本机回环上起一个假的收快照的接口。 */
async function fakeReceiver(handler: Handler): Promise<URL> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/report`);
}

function memLog() {
  const lines: string[] = [];
  const keep = (message: string, fields?: Record<string, unknown>) => {
    lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const log: Logger = { info: keep, warn: keep, error: keep };
  return { log, lines };
}

function reporter(url: URL, over: Partial<NodeReporterInput> = {}) {
  const clock = { now: new Date(T0) };
  const { log, lines } = memLog();
  const r = createNodeReporter({
    target: { url, token: TOKEN },
    snapshot: async () => sampleSnapshot(),
    codeSha: () => SHA,
    log,
    now: () => new Date(clock.now),
    timeoutMs: 300,
    ...over,
  });
  const health = async () => (await runHealthChecks([r.healthCheck], log)).checks.node_report;
  return { r, clock, lines, health };
}

describe('推快照', () => {
  it('推成：带通行证头 POST 一份过契约的快照（带提交号）；node_report 报好、说上次推成是多久前', async () => {
    const got: { token: string | undefined; type: string | undefined; body: unknown }[] = [];
    const url = await fakeReceiver((req, body, res) => {
      got.push({
        token: req.headers[NODE_REPORT_HEADER.toLowerCase()] as string,
        type: req.headers['content-type'],
        body: JSON.parse(body),
      });
      res.writeHead(204).end();
    });
    const { r, clock, health } = reporter(url);
    expect(await r.pushOnce()).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]?.token).toBe(TOKEN);
    expect(got[0]?.type).toBe('application/json');
    const sent = NodeReportSchema.parse(got[0]?.body);
    expect(sent).toMatchObject({ schemaVersion: 1, reportedAt: T0.toISOString(), codeSha: SHA });
    expect(sent.env.name.name).toBe('本机');
    clock.now = new Date(T0.getTime() + 42_000);
    expect(await health()).toEqual({ ok: true, message: '上次推成在 42 秒前' });
  });

  it('提交号读不到：不给这个键，不写假值', async () => {
    const bodies: unknown[] = [];
    const url = await fakeReceiver((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200).end('{}');
    });
    const { r } = reporter(url, { codeSha: () => undefined });
    expect(await r.pushOnce()).toBe(true);
    expect(bodies[0]).not.toHaveProperty('codeSha');
  });

  it('【故意造出的失败】对方回 401：没推成，node_report 报红说对方不认通行证；日志里有状态码和回体', async () => {
    const url = await fakeReceiver((_req, _body, res) => {
      res.writeHead(401).end('unknown node token');
    });
    const { r, lines, health } = reporter(url);
    expect(await r.pushOnce()).toBe(false);
    expect(await r.pushOnce()).toBe(false);
    expect(await health()).toEqual({
      ok: false,
      code: 'push_failing',
      message: '连着 2 次没推成（对方不认这把通行证），起来后还没推成过',
    });
    expect(lines.some((l) => l.includes('HTTP 401 unknown node token'))).toBe(true);
  });

  it('【故意造出的失败】对方不回应：到点放弃，node_report 报红说对方没回应', async () => {
    const url = await fakeReceiver(() => {
      // 一直不回
    });
    const { r, health } = reporter(url, { timeoutMs: 100 });
    expect(await r.pushOnce()).toBe(false);
    expect(await health()).toMatchObject({
      ok: false,
      code: 'push_failing',
      message: expect.stringContaining('对方没回应'),
    });
  });

  it('【故意造出的失败】断网（端口上没人听）：node_report 报红说连不上；对外不带地址，地址只进日志', async () => {
    const url = await fakeReceiver((_req, _body, res) => res.writeHead(204).end());
    await new Promise<void>((r) => {
      const s = servers.pop();
      s?.close(() => r());
    });
    const { r, lines, health } = reporter(url);
    expect(await r.pushOnce()).toBe(false);
    const item = await health();
    expect(item).toMatchObject({
      ok: false,
      code: 'push_failing',
      message: expect.stringContaining('连不上对方'),
    });
    expect(JSON.stringify(item)).not.toContain('127.0.0.1');
    expect(lines.some((l) => l.includes('127.0.0.1'))).toBe(true);
  });

  it('推成过、后来推不成：报红里写上次推成是多久前；再推成就回绿、失败次数清零', async () => {
    let status = 204;
    const url = await fakeReceiver((_req, _body, res) => res.writeHead(status).end());
    const { r, clock, health } = reporter(url);
    expect(await r.pushOnce()).toBe(true);
    status = 502;
    clock.now = new Date(T0.getTime() + 3 * 60_000);
    expect(await r.pushOnce()).toBe(false);
    expect(await health()).toEqual({
      ok: false,
      code: 'push_failing',
      message: '连着 1 次没推成（对方回了错误），上次推成在 3 分钟前',
    });
    status = 204;
    expect(await r.pushOnce()).toBe(true);
    expect(await health()).toEqual({ ok: true, message: '上次推成在 0 秒前' });
  });

  it('【故意造出的失败】快照拼不出来（库读不到、形状不过契约）：不推、报红，不发半截', async () => {
    const hits: string[] = [];
    const url = await fakeReceiver((_req, body, res) => {
      hits.push(body);
      res.writeHead(204).end();
    });
    const broken = reporter(url, {
      snapshot: async () => {
        throw new Error('canceling statement due to statement timeout');
      },
    });
    expect(await broken.r.pushOnce()).toBe(false);
    expect(await broken.health()).toMatchObject({
      ok: false,
      message: expect.stringContaining('快照拼不出来'),
    });
    const badShape = reporter(url, { snapshot: async () => ({ home: {}, env: sampleSnapshot().env }) });
    expect(await badShape.r.pushOnce()).toBe(false);
    expect(hits).toEqual([]);
  });

  it('【故意造出的失败】起来后第一轮还没推完：报「没查成」，不当成好', async () => {
    const url = await fakeReceiver((_req, _body, res) => res.writeHead(204).end());
    const { health } = reporter(url);
    expect(await health()).toEqual({
      ok: false,
      code: 'not_yet',
      message: '没查成：起来 0 秒，第一轮还没推完',
    });
  });

  it('【故意造出的失败】循环卡住（三轮没动）：报红，不拿上一次的好冒充现在', async () => {
    const url = await fakeReceiver((_req, _body, res) => res.writeHead(204).end());
    const { r, clock, health } = reporter(url, { everyMs: 60_000, jitterMs: 15_000 });
    expect(await r.pushOnce()).toBe(true);
    clock.now = new Date(T0.getTime() + 3 * 75_000 + 1_000);
    expect(await health()).toEqual({
      ok: false,
      code: 'stalled',
      message: '3 分钟没推过了，上次推成在 3 分钟前',
    });
  });
});

describe('推送循环', () => {
  const okFetch = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

  it('没配推送地址：不建、不起循环、不发一个请求；node_report 报「未接」', async () => {
    vi.useFakeTimers();
    const fetchSpy = okFetch();
    const { log } = memLog();
    const r = nodeReporterFor(null, {
      snapshot: async () => sampleSnapshot(),
      codeSha: () => SHA,
      log,
      now: () => new Date(),
      fetch: fetchSpy,
    });
    expect(r).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
    const report = await runHealthChecks([{ name: 'node_report', ...nodeReportPart(r) }], log);
    expect(report.checks.node_report).toEqual({
      ok: true,
      status: 'not_wired',
      message: NODE_REPORT_NOT_WIRED,
    });
  });

  it('起了：第一轮在抖动之内，之后每 60 秒加抖动一轮；停了就不再推；重复 start 不起第二条', async () => {
    vi.useFakeTimers();
    const fetchSpy = okFetch();
    const { log } = memLog();
    const r = nodeReporterFor(
      { url: new URL('https://board.example.test/api/nodes/report'), token: TOKEN },
      {
        snapshot: async () => sampleSnapshot(),
        codeSha: () => SHA,
        log,
        now: () => new Date(),
        fetch: fetchSpy,
        random: () => 0.5,
      },
    );
    if (!r) throw new Error('配了目标却没建');
    r.start();
    r.start();
    await vi.advanceTimersByTimeAsync(7_499);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(67_500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    r.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('对方慢：一轮做完才排下一轮，不叠着推', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let most = 0;
    const slow = vi.fn<typeof fetch>(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 200_000));
      inFlight--;
      return new Response(null, { status: 204 });
    });
    const { log } = memLog();
    const r = createNodeReporter({
      target: { url: new URL('https://board.example.test/api/nodes/report'), token: TOKEN },
      snapshot: async () => sampleSnapshot(),
      codeSha: () => SHA,
      log,
      now: () => new Date(),
      fetch: slow,
      random: () => 0,
      timeoutMs: 500_000,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    r.stop();
    expect(most).toBe(1);
    expect(slow.mock.calls.length).toBeGreaterThan(1);
  });
});
