// 测试夹具：假 GitHub + 假时钟（sleep 只拨表不真等）+ 内存账本。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { createGitHub, type GitHubOptions } from '../src/github.ts';
import { memoryLedger } from '../src/ledger.ts';
import { API, FakeGitHub, OWNER, REPO } from './fake-github.ts';

export const repo = { owner: OWNER, name: REPO };
export const REPO_ID = '00000000-0000-4000-8000-000000000001';
export const sha = (c: string) => c.repeat(40).slice(0, 40);

// 每个测试文件建的临时目录（每次 setup 一个状态目录、真 git 的远端和检出）在这个文件跑完时删掉：
// 不删的话每跑一轮就在 /tmp 留下上百个 fleet-gh-state-*（法国上攒了 774 个）。
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 建一个临时目录，这个测试文件跑完就删。 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

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
    stateDir: tempDir('fleet-gh-state-'),
    // 卫生检查只管一个仓（默认 fleet-dao 自己）：夹具用的是 acme/widgets，指过去，测试才测得到扫不扫
    hygieneRepo: repo,
    log: {
      info: (message, fields) => logs.push({ level: 'info', message, fields }),
      warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
      error: (message, fields) => logs.push({ level: 'error', message, fields }),
    },
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
