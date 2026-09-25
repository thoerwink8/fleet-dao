// 测试夹具：假 GitHub + 假时钟（sleep 只拨表不真等）+ 内存账本。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, type GitHubOptions } from '../src/github.ts';
import { memoryLedger } from '../src/ledger.ts';
import { API, FakeGitHub, OWNER, REPO } from './fake-github.ts';

export const repo = { owner: OWNER, name: REPO };
export const REPO_ID = '00000000-0000-4000-8000-000000000001';
export const sha = (c: string) => c.repeat(40).slice(0, 40);

export function setup(overrides: Partial<GitHubOptions> = {}) {
  let now = new Date('2026-09-25T12:00:00Z');
  const clock = {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  const fake = new FakeGitHub(clock.now);
  const sleeps: number[] = [];
  const logs: { level: string; message: string; fields?: Record<string, unknown> | undefined }[] = [];
  const ledger = memoryLedger({ repos: [{ id: REPO_ID, ...repo }] });
  const gh = createGitHub({
    ledger,
    apps: fake.apps,
    apiUrl: API,
    fetch: fake.fetch,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    env: {},
    stateDir: mkdtempSync(join(tmpdir(), 'fleet-gh-state-')),
    log: {
      info: (message, fields) => logs.push({ level: 'info', message, fields }),
      warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
      error: (message, fields) => logs.push({ level: 'error', message, fields }),
    },
    // 推分支前卫生检查的名单用假的：测试不读本机真名单（没有也不该因此红）。
    sensitiveValues: () => ({ ok: true, source: '测试名单', values: ['fake-org-778899'] }),
    ...overrides,
  });
  return { gh, fake, clock, sleeps, ledger, logs };
}

export function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
