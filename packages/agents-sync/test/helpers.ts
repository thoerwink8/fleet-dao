// 测试用的临时「机器」：假家目录、假仓、假的可执行文件。一律放系统临时目录，不碰真家目录、不出网。
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

/** 假仓：AGENTS.md 带通用段；skills 为 null 时没有 agents/skills/ 这个目录 */
export function makeRepo(
  skills: Record<string, Record<string, string>> | null,
  agentsMd = AGENTS_MD,
): string {
  const repo = tempDir('repo');
  put(repo, 'AGENTS.md', agentsMd);
  if (skills !== null) {
    mkdirSync(join(repo, 'agents', 'skills'), { recursive: true });
    for (const [name, files] of Object.entries(skills)) {
      for (const [rel, content] of Object.entries(files)) put(repo, `agents/skills/${name}/${rel}`, content);
    }
  }
  return repo;
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
