// 额度测试的共用件：读夹具、造假依赖、禁网。
// 假依赖默认一碰就抛：哪个测试忘了给假的，就当场红，而不是悄悄去碰真网络、真进程、真文件。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, vi } from 'vitest';
import type {
  CommandResult,
  QuotaDeps,
  RunCommand,
  RunCommandOptions,
  WebSocketLike,
} from '../../src/quota/index.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
export const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

/** 全局 fetch 一律抛错：读取器只能用注入的 fetch。 */
export function blockNetwork(): void {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => {
      throw new Error('测试不许出网');
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

const refuse = (what: string) => () => {
  throw new Error(`测试没给假的 ${what}`);
};

export const FIXED_NOW = new Date('2026-09-24T19:00:00.000Z');

/** 假的空目录：只记下建了几个、删了几个，不碰真文件系统。 */
export const scratchLog = { made: 0, disposed: 0 };
export const SCRATCH_PATH = '/tmp/fleet-quota-scratch';

export function fakeDeps(over: QuotaDeps = {}): QuotaDeps {
  return {
    now: () => FIXED_NOW,
    fetch: refuse('fetch') as unknown as typeof fetch,
    runCommand: refuse('runCommand') as unknown as RunCommand,
    readFile: refuse('readFile') as unknown as (p: string) => Promise<string>,
    listDir: refuse('listDir') as unknown as (p: string) => Promise<string[]>,
    openWebSocket: refuse('openWebSocket') as unknown as (u: string) => WebSocketLike,
    scratchDir: async () => {
      scratchLog.made++;
      return {
        path: SCRATCH_PATH,
        dispose: async () => {
          scratchLog.disposed++;
        },
      };
    },
    homeDir: '/home/tester',
    env: { PATH: '/usr/bin', HOME: '/home/tester' },
    ...over,
  };
}

/** 按路径给文件内容；没登记的路径当 ENOENT。 */
export function fakeFiles(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path) => {
    const hit = files[path.replace(/\\/g, '/')];
    if (hit === undefined) {
      const e = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    }
    return hit;
  };
}

export interface RecordedCall {
  argv: string[];
  options: RunCommandOptions;
}

/** 假命令：按参数找答案，并记下每次调用。 */
export function fakeCommands(answer: (argv: string[]) => Partial<CommandResult>): {
  run: NonNullable<QuotaDeps['runCommand']>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run: NonNullable<QuotaDeps['runCommand']> = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, stdout: '', stderr: '', killed: false, ...answer(argv) };
  };
  return { run, calls };
}

export interface FakeResponse {
  status?: number;
  body: unknown;
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 假 fetch：按 URL 找答案，记下每次请求。答案是 Error 就当网络错抛出。 */
export function fakeFetch(answer: (url: string, init: RequestInit | undefined) => FakeResponse | Error): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const a = answer(url, init);
    if (a instanceof Error) throw a;
    const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return new Response(text, { status: a.status ?? 200 });
  };
  return { fetch: f as typeof fetch, calls };
}

/** 假 WebSocket：连上后对每条发来的消息按 reply 回帧。 */
export class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  readonly url: string;
  private readonly reply: (msg: Record<string, unknown>) => unknown[];

  constructor(
    url: string,
    reply: (msg: Record<string, unknown>) => unknown[],
    mode: 'open' | 'refuse' = 'open',
  ) {
    this.url = url;
    this.reply = reply;
    queueMicrotask(() => {
      if (mode === 'refuse') this.onerror?.({});
      else this.onopen?.({});
    });
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    for (const frame of this.reply(msg)) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }));
    }
  }

  close(): void {
    this.closed = true;
  }
}
