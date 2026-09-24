// 测试共用：读夹具、建临时目录、起假执行体、跑与全局配置隔离的 git。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { FakeScript } from './fake-agent.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, 'fixtures');
export const FAKE_AGENT = join(here, 'fake-agent.ts');

/** 夹具：法国 VPS 上真跑的过程记录（见同名 .meta.json 里的命令行）。 */
export function fixturePath(host: string, name: string): string {
  return join(FIXTURES, host, `${name}.ndjson`);
}

export function fixtureLines(host: string, name: string): string[] {
  return readFileSync(fixturePath(host, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
}

export function fixtureFrames(host: string, name: string): Record<string, unknown>[] {
  return fixtureLines(host, name).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 夹具里 init 帧的会话号和工作目录。 */
export function fixtureInit(name: string): { sessionId: string; cwd: string } {
  const init = fixtureFrames('claude-code', name).find((f) => f.subtype === 'init');
  return { sessionId: String(init?.session_id), cwd: String(init?.cwd) };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'fleet-adapters-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** 写好脚本，返回起假执行体的命令。 */
export function fakeAgent(script: FakeScript): string[] {
  const file = join(tempDir('fleet-fake-'), 'script.json');
  writeFileSync(file, JSON.stringify(script));
  return [process.execPath, FAKE_AGENT, file];
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** git 只读这里给的配置：不受开发机全局配置（签名、凭据助手、钩子）影响。 */
export function isolatedGitEnv(globalConfig = ''): Record<string, string> {
  const dir = tempDir('fleet-gitcfg-');
  const file = join(dir, 'gitconfig');
  writeFileSync(file, globalConfig);
  const keep = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return {
    ...keep,
    GIT_CONFIG_GLOBAL: file,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fleet-test',
    GIT_AUTHOR_EMAIL: 'fleet-test',
    GIT_COMMITTER_NAME: 'fleet-test',
    GIT_COMMITTER_EMAIL: 'fleet-test',
  };
}

export function git(cwd: string, args: string[], env: Record<string, string>, input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}
