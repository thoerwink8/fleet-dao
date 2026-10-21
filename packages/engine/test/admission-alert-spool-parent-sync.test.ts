import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdmissionAlertObservation } from '@fleet-dao/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 只记录每次 fsyncSync 落在哪个 inode 上，仍调真实 fsync。
const synced = vi.hoisted(() => ({ inodes: [] as number[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      synced.inodes.push(actual.fstatSync(fd).ino);
      return actual.fsyncSync(fd);
    },
  };
});

const { recordAdmissionAlert } = await import('../src/real/admission-alert-spool.ts');

let root: string, path: string;
const observation = (): AdmissionAlertObservation => ({
  identity: {
    version: 1,
    category: 'legacy_admission_unknown',
    namespace: 'parent-sync',
    workflowId: 'task:example/test#1',
    runId: randomUUID(),
  },
  firstCode: 'deadline',
});
beforeEach(() => {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0)
    throw Error('必须在真实Linux普通用户下执行，不跳过权限断言');
  root = mkdtempSync(join(homedir(), '.fleet-admission-parent-sync-'));
  path = join(root, 'spool');
  synced.inodes.length = 0;
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('叶目录项的父目录fsync', () => {
  it('叶目录被删后在同一路径重建：新目录项必须重新同步父目录', () => {
    const parentIno = statSync(root).ino;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(synced.inodes).toContain(parentIno);

    // 同一叶实例再写：父目录已同步过，不重复（创建时刻读不到的文件系统不缓存，不断言）。
    synced.inodes.length = 0;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    if (statSync(path).birthtimeMs > 0) expect(synced.inodes).not.toContain(parentIno);

    // 删掉叶目录再在同一路径重建：父 inode 没变，但这是新目录项。
    rmSync(path, { recursive: true, force: true });
    synced.inodes.length = 0;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(synced.inodes).toContain(parentIno);
  });
});
