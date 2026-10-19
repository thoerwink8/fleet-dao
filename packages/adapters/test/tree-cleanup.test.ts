import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupStatus, readCleanupNamespace } from '../src/tree-cleanup.ts';

const root = '/var/lib/fleet-work';
const options = {
  helper: join(dirname(fileURLToPath(import.meta.url)), 'fake-scope-helper.ts'),
  sudo: [process.execPath],
};
const namespace = {
  lex: `${root}/.cleanup-transactions`,
  real: `${root}/.cleanup-transactions`,
  dev: '1',
  ino: '2',
  uid: '0',
};
function reply(over: Record<string, unknown> = {}) {
  process.env.FLEET_FAKE_SCOPE_CLEANUP_STDOUT = JSON.stringify({
    version: 1,
    state: 'ok',
    rows: [],
    truncated: false,
    namespace,
    ...over,
  });
}
afterEach(() => {
  delete process.env.FLEET_FAKE_SCOPE_CLEANUP_STDOUT;
  delete process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT;
});

describe('cleanup-status 原帮手端口的命名空间事实', () => {
  it('正常空/已结记录不进pending；未结记录原样保留', async () => {
    reply();
    expect(await readCleanupNamespace(root, options)).toEqual([]);
    const rows = [{ id: 'a'.repeat(64), phase: 'DELETING' }];
    reply({ rows });
    expect(await readCleanupNamespace(root, options)).toEqual(rows);
    expect(await cleanupStatus(options)).toEqual(rows);
  });

  it.each([
    ['旧帮手没有命名空间事实', { namespace: undefined }],
    ['目录不存在', { namespace: null }],
    ['错路径', { namespace: { ...namespace, lex: '/other', real: '/other' } }],
    ['不是原物理路径', { namespace: { ...namespace, real: '/other' } }],
    ['错属主', { namespace: { ...namespace, uid: '1000' } }],
    ['截断', { truncated: true }],
    ['坏列表', { rows: null }],
    ['读取未知', { state: 'unknown' }],
  ])('%s 不授权跳过根分类', async (_name, over) => {
    reply(over);
    await expect(readCleanupNamespace(root, options)).rejects.toThrow();
  });

  it('帮手因文件/链接/权限/坏记录失败，不当成空；原cleanupStatus截断仍拒绝', async () => {
    reply();
    process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT = '1';
    await expect(readCleanupNamespace(root, options)).rejects.toThrow();
    delete process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT;
    reply({ truncated: true });
    await expect(cleanupStatus(options)).rejects.toThrow('不完整');
  });
});
