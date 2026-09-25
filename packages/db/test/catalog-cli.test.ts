// 目录装载器的命令行（发布脚本在迁移之后调它，只认退出码）：文件读不到、格式认不出、没给库，一律退出非 0、说清原因，
// 标准输出里不出「装好了」那一类话。这几条都到不了库：环境里只给 PATH，没有 DATABASE_URL。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../src/bin/catalog.ts', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../../deploy/examples/catalog.example.json', import.meta.url));
/** 起一个 node 要装载 zod、drizzle，机器忙时几秒。 */
const SPAWN_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fleet-catalog-cli-'));
  dirs.push(d);
  return d;
};

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: SPAWN_MS,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('装载器命令行：装不成就退出非 0（发布脚本只认退出码）', () => {
  it(
    '文件不在：退出 1，说文件不存在、不当成空目录',
    () => {
      const r = run(join(temp(), 'catalog.json'));
      expect(r.code).toBe(1);
      expect(r.err).toContain('文件不存在；装载器不会当成空目录继续');
      expect(r.out).toBe('');
    },
    SPAWN_MS,
  );

  it(
    '不是 JSON、是空的、缺整块：退出 1，说清哪里不对',
    () => {
      const dir = temp();
      for (const [name, text, why] of [
        ['half.json', '{ "channels": [', '不是合法的 JSON'],
        ['empty.json', '', '不是合法的 JSON'],
        ['bare.json', '{}', '格式不对'],
      ] as const) {
        writeFileSync(join(dir, name), text);
        const r = run(join(dir, name));
        expect([name, r.code]).toEqual([name, 1]);
        expect(r.err).toContain(why);
        expect(r.out).toBe('');
      }
    },
    SPAWN_MS,
  );

  it(
    '配置没问题、但没给库（DATABASE_URL 没设）：退出 1，不当成装好了',
    () => {
      const r = run(EXAMPLE);
      expect(r.code).toBe(1);
      expect(r.err).toContain('DATABASE_URL 没设');
      expect(r.out).toBe('');
    },
    SPAWN_MS,
  );
});
