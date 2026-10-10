// 子代理定义文件（real/subagents-file.ts，#1641 第 4b 片）：从发布目录的 .claude/agents/ 生成一次、文件名带内容哈希、
// 会话用户读得到；生成不成明确抛错。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lazyOnSuccess,
  prepareSubagents,
  readSubagentGuard,
  subagentsOnce,
} from '../../src/real/subagents-file.ts';

const DEF = (name: string, extra = '') => `---
name: ${name}
description: 演示 ${name}
model: claude-haiku-5-5
tools: Read, Grep
${extra}---
你是 ${name}。
`;

let root: string;
let src: string;
let out: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-subagents-file-'));
  src = join(root, 'agents');
  out = join(root, 'out', 'agents');
  mkdirSync(src);
  writeFileSync(join(src, 'fleet-a.md'), DEF('fleet-a'));
  writeFileSync(join(src, 'fleet-b.md'), DEF('fleet-b', 'isolation: worktree\n'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepareSubagents', () => {
  it('从定义目录生成 JSON 写到输出目录：文件名带内容哈希，内容是 --agents 的对象，带 isolation 的单独列出来', async () => {
    const set = await prepareSubagents({ sourceDir: src, outDir: out });
    expect(set.file).toMatch(/subagents-[0-9a-f]{16}\.json$/);
    expect(set.file.startsWith(out)).toBe(true);
    expect(set.names).toEqual(['fleet-a', 'fleet-b']);
    expect(set.isolated).toEqual(['fleet-b']);
    const json = JSON.parse(readFileSync(set.file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(Object.keys(json)).toEqual(['fleet-a', 'fleet-b']);
    expect(json['fleet-a']).toMatchObject({
      model: 'claude-haiku-5-5',
      tools: ['Read', 'Grep'],
      prompt: '你是 fleet-a。',
    });
    expect(json['fleet-b']).not.toHaveProperty('isolation');
  });

  it('会话用户读得到：文件 644、目录 755（Windows 上没有这个概念，不查）', async () => {
    const set = await prepareSubagents({ sourceDir: src, outDir: out });
    if (process.platform === 'win32') return;
    expect(statSync(set.file).mode & 0o777).toBe(0o644);
    expect(statSync(out).mode & 0o777).toBe(0o755);
  });

  it('同样的内容重复生成得到同一个文件；改了定义就是新文件，旧文件不动（正在跑的会话读的是旧的）', async () => {
    const first = await prepareSubagents({ sourceDir: src, outDir: out });
    const again = await prepareSubagents({ sourceDir: src, outDir: out });
    expect(again.file).toBe(first.file);
    expect(readdirSync(out)).toHaveLength(1);
    writeFileSync(join(src, 'fleet-a.md'), DEF('fleet-a').replace('演示', '改过的'));
    const changed = await prepareSubagents({ sourceDir: src, outDir: out });
    expect(changed.file).not.toBe(first.file);
    expect(readdirSync(out)).toHaveLength(2);
  });

  it('【故意造出的失败】定义目录不在、有一份坏的、输出目录建不出来：都抛错，原因里有路径或文件名，不悄悄返回空文件', async () => {
    await expect(prepareSubagents({ sourceDir: join(root, '不在'), outDir: out })).rejects.toThrow(
      /子代理定义文件生成不成.*子代理定义的目录读不了/,
    );
    writeFileSync(join(src, 'fleet-bad.md'), '---\nname: fleet-bad\nmodel: claude-haiku-5-5\n---\n正文\n');
    await expect(prepareSubagents({ sourceDir: src, outDir: out })).rejects.toThrow(
      'fleet-bad.md：缺 description',
    );
    rmSync(join(src, 'fleet-bad.md'));
    // 输出目录的上一级是个文件：建不出来
    writeFileSync(join(root, 'blocker'), 'x');
    await expect(
      prepareSubagents({ sourceDir: src, outDir: join(root, 'blocker', 'agents') }),
    ).rejects.toThrow('子代理定义文件生成不成');
  });
});

describe('readSubagentGuard、subagentsOnce、lazyOnSuccess', () => {
  it('readSubagentGuard 只读不落盘；读不到抛错', async () => {
    expect(await readSubagentGuard(src)).toEqual({ names: ['fleet-a', 'fleet-b'], isolated: ['fleet-b'] });
    await expect(readSubagentGuard(join(root, '不在'))).rejects.toThrow('子代理定义读不到');
  });

  it('subagentsOnce：启动时只生成一次，之后每次取都是同一个结果；失败时先记一次日志、取的时候才抛', async () => {
    let calls = 0;
    const ok = subagentsOnce(async () => {
      calls += 1;
      return { file: '/x/a.json', names: [], isolated: [] };
    });
    expect((await ok()).file).toBe('/x/a.json');
    expect((await ok()).file).toBe('/x/a.json');
    expect(calls).toBe(1);

    const seen: string[] = [];
    const bad = subagentsOnce(
      async () => {
        throw new Error('写不了');
      },
      (e) => seen.push(e.message),
    );
    await expect(bad()).rejects.toThrow('写不了');
    expect(seen).toEqual(['写不了']);
  });

  it('lazyOnSuccess：成功的记住，失败的不记（下次再试）', async () => {
    let n = 0;
    const get = lazyOnSuccess(async () => {
      n += 1;
      if (n === 1) throw new Error('第一次读不到');
      return n;
    });
    await expect(get()).rejects.toThrow('第一次读不到');
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
    expect(n).toBe(2);
  });
});
