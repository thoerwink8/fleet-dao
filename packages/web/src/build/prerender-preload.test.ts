// 预渲染前先把服务端产物放进模块缓存：同一条 file URL 再 import 不重新执行；
// 产物还没有不挡预览；载入失败原样抛，不吞。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { prerenderServerEntry, prerenderServerPreload } from './prerender-preload';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'prerender-preload-'));
  dirs.push(d);
  return d;
}

async function runHook(serverEntry: string): Promise<void> {
  const plugin = prerenderServerPreload(serverEntry);
  const hook = plugin.configurePreviewServer;
  if (typeof hook !== 'function')
    throw new Error('configurePreviewServer 应是函数，好让 vite 在开听之前 await');
  await hook.call(undefined as never, {} as never);
}

describe('预渲染前预载服务端产物', () => {
  test('路径和框架默认的 dist/server/index.js 是同一个绝对路径', () => {
    expect(prerenderServerEntry('/srv/web')).toBe(resolve('/srv/web', 'dist/server/index.js'));
  });

  test('vite 配置把预载接在预览服务上，根目录用配置文件所在目录', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('prerenderServerPreload(prerenderServerEntry(import.meta.dirname))');
  });

  test('同一条 file URL 预载之后再 import，模块只执行一次', async () => {
    const dir = tempDir();
    const file = join(dir, 'entry.mjs');
    const key = `preload_${dir.replace(/\W/g, '_')}`;
    writeFileSync(
      file,
      `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;\nexport {};\n`,
    );
    await runHook(file);
    await import(pathToFileURL(file).href);
    const bag = globalThis as unknown as Record<string, number>;
    expect(bag[key]).toBe(1);
  });

  test('产物文件还不在：不抛，预览照旧能起', async () => {
    await expect(runHook(join(tempDir(), 'missing.js'))).resolves.toBeUndefined();
  });

  test('产物载入失败：抛出去，原因留在 cause 里', async () => {
    const dir = tempDir();
    const file = join(dir, 'entry.mjs');
    writeFileSync(file, 'throw new Error("preload-boom");\n');
    await expect(runHook(file)).rejects.toThrow(`预渲染前载入服务端产物失败（${file}）`);
    try {
      await runHook(file);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toContain('preload-boom');
    }
  });
});
