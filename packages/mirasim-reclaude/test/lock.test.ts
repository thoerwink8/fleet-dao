import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@fleet-dao/adapters/testing';
import { describe, expect, it } from 'vitest';
import { takeLock } from '../src/lock.ts';

function emptyLock(home: string, ageMs: number): string {
  const root = join(home, '.fleet-dao', 'mirasim-reclaude');
  mkdirSync(root, { recursive: true });
  const file = join(root, 'migration.lock');
  writeFileSync(file, '');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
  return file;
}

describe('迁移互斥锁', () => {
  it('空锁文件刚建（另一个进程还没写完）：只等，不误删', () => {
    const home = tempDir();
    const file = emptyLock(home, 1_000);
    expect(takeLock(home, 'migration')).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it('空锁文件超过 30 秒：创建后写入前崩溃了，按已退出回收，不再永远「另一个迁移正在进行」', () => {
    const home = tempDir();
    const file = emptyLock(home, 60_000);
    const release = takeLock(home, 'migration');
    expect(release).toBeTypeOf('function');
    release?.();
    expect(existsSync(file)).toBe(false);
  });
});
