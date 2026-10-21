import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
  it('每次写入都同步父目录：同一叶目录不缓存，删后立即同路径重建（同 tick 可同 ino/时间戳）也同步', () => {
    const parentIno = statSync(root).ino;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(synced.inodes).toContain(parentIno);

    // 未变的叶目录也同步：任何按叶身份的缓存都分不清它和同 tick 内重建的新目录。
    synced.inodes.length = 0;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(synced.inodes).toContain(parentIno);

    // 删掉后紧接着在同一路径建空叶目录，中间不夹任何 fsync，造出 ino 和时间戳都可能与旧目录相同的新目录项。
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { mode: 0o700 });
    synced.inodes.length = 0;
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(synced.inodes).toContain(parentIno);
  });
});
