// 测试用的临时「机器」：假家目录、假仓、假的可执行文件。一律放系统临时目录，不碰真家目录、不出网。
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { BEGIN, END } from '../src/block.ts';
import { type Ctx, readSources, type Sources } from '../src/sync.ts';
import type { AgentId, Platform } from '../src/targets.ts';

export const PLATFORM: Platform = process.platform === 'win32' ? 'win32' : 'linux';
export const IS_ROOT = process.getuid?.() === 0;

export const SHARED_BODY = '## 怎么跟我说话\n- 说人话。\n\n## 底线\n- 没验证过不说完成。\n';
export const BLOCK = `${BEGIN}\n\n${SHARED_BODY}\n${END}`;
export const AGENTS_MD = `# 某仓的约定\n\n上半段通用，下半段只管本仓。\n\n${BLOCK}\n\n## 本仓\n- 本仓自己的规矩。\n`;

const made: string[] = [];

export function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agents-sync-${name}-`));
  made.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** 写文件（rel 用 / 分隔，相对 base），目录自动建 */
export function put(base: string, rel: string, content: string | Buffer): string {
  const file = join(base, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

export function get(base: string, rel: string): string {
  return readFileSync(join(base, ...rel.split('/')), 'utf8');
}

/** 假仓里的钩子脚本：名字和 targets.ts 登记的一样，内容是假的 */
export const HOOK_FILES: Record<string, string> = {
  'session-start.mjs': '// 假的开会话钩子\n',
  'pretool.mjs': '// 假的调工具前钩子\n',
};

/** 假仓：AGENTS.md 带通用段；skills 为 null 时没有 agents/skills/ 这个目录，hooks 为 null 时没有 agents/hooks/ */
export function makeRepo(
  skills: Record<string, Record<string, string>> | null,
  agentsMd = AGENTS_MD,
  hooks: Record<string, string> | null = HOOK_FILES,
): string {
  const repo = tempDir('repo');
  put(repo, 'AGENTS.md', agentsMd);
  if (skills !== null) {
    mkdirSync(join(repo, 'agents', 'skills'), { recursive: true });
    for (const [name, files] of Object.entries(skills)) {
      for (const [rel, content] of Object.entries(files)) put(repo, `agents/skills/${name}/${rel}`, content);
    }
  }
  if (hooks !== null) {
    mkdirSync(join(repo, 'agents', 'hooks'), { recursive: true });
    for (const [rel, content] of Object.entries(hooks)) put(repo, `agents/hooks/${rel}`, content);
  }
  return repo;
}

/** git 命令：身份、签名都写死，不读本机的配置（测试里提交用） */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** 把假仓做成 git 检出：提交一次，建一个裸仓当 origin 推上去，main 跟着 origin/main。返回裸仓的位置 */
export function gitify(repo: string): string {
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v1');
  const origin = join(tempDir('origin'), 'origin.git');
  git(repo, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return origin;
}

/** 往 origin 的 main 上多推一个提交（从另一份克隆推），检出里的 origin/main 要 fetch 了才知道 */
export function pushAhead(origin: string, rel: string, content: string): string {
  const other = join(tempDir('other'), 'clone');
  git(dirname(other), 'clone', '-q', origin, other);
  put(other, rel, content);
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', `改 ${rel}`);
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  return git(other, 'rev-parse', 'HEAD');
}

/** 读回一份 JSON 文件 */
export function getJson(base: string, rel: string): unknown {
  return JSON.parse(get(base, rel));
}

export function sources(repo: string): Sources {
  const read = readSources(repo);
  if (!read.ok) throw new Error(read.why);
  return read.value;
}

export function ctxFor(home: string, installed: AgentId[]): Ctx {
  return { home, platform: PLATFORM, installed: new Set(installed) };
}

/** 目录链接：Windows 用 junction（不要管理员），别处用软链 */
export function linkDir(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, PLATFORM === 'win32' ? 'junction' : 'dir');
}

/** 假的可执行文件：带执行位的 <名>；Windows 上另放一个 <名>.cmd（和 npm 装出来的一样两份都有） */
export function fakeBin(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  if (PLATFORM === 'win32') writeFileSync(join(dir, `${name}.cmd`), '@echo off\r\n');
}

export function kinds(lines: readonly { kind: string; key: string }[], key: string): string[] {
  return lines.filter((l) => l.key === key).map((l) => l.kind);
}

export function expectKind(lines: readonly { kind: string; key: string }[], key: string, kind: string): void {
  expect(kinds(lines, key)).toEqual([kind]);
}
