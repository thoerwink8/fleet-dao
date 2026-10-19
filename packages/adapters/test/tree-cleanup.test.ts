import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLEANUP_PAGE_LIMITS, cleanupStatus, readCleanupNamespace } from '../src/tree-cleanup.ts';

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
    const rows = [{ id: 'a'.repeat(64), pathHash: 'b'.repeat(64), phase: 'DELETING' }];
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

describe('cleanup-status 分页：只有全部页读完才算完整', () => {
  const hash = (n: number) => n.toString(16).padStart(64, '0');
  const tail = { id: 'e'.repeat(64), pathHash: hash(129), phase: 'RECOVERY_REQUIRED' };
  const gen = (c: string) => c.repeat(64);
  const head = { version: 1, state: 'ok', namespace, generation: gen('a') };
  const firstPage = { ...head, rows: [], truncated: true, after: null, next: hash(99), proof: gen('9') };
  const lastPage = { ...head, rows: [tail], truncated: false, after: hash(99), next: null };
  let dir = '';
  const saved = { ...CLEANUP_PAGE_LIMITS };

  function pages(list: unknown[]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'fleet-cleanup-pages-'));
    process.env.FLEET_FAKE_SCOPE_CLEANUP_PAGES = JSON.stringify(list);
    process.env.FLEET_FAKE_SCOPE_CLEANUP_COUNTER = join(dir, 'counter');
    process.env.FLEET_FAKE_SCOPE_LOG = join(dir, 'log');
  }
  const cursors = () =>
    readFileSync(join(dir, 'log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string; args: string[] })
      .filter((call) => call.action === 'cleanup-status')
      .map((call) => call.args);
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_CLEANUP_PAGES;
    delete process.env.FLEET_FAKE_SCOPE_CLEANUP_COUNTER;
    delete process.env.FLEET_FAKE_SCOPE_LOG;
    Object.assign(CLEANUP_PAGE_LIMITS, saved);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('完整读取：首页空行仍截断，带绑定身份和代次的游标读到尾部 RECOVERY_REQUIRED', async () => {
    pages([firstPage, lastPage]);
    expect(await readCleanupNamespace(root, options)).toEqual([tail]);
    expect(cursors()).toEqual([
      [],
      ['--after', hash(99), '--dev', '1', '--ino', '2', '--generation', gen('a'), '--proof', gen('9')],
    ]);
    pages([firstPage, lastPage]);
    expect(await cleanupStatus(options)).toEqual([tail]);
  });

  it('完整读取：翻页中换代整轮重启，不拼两份列表', async () => {
    const fresh = { generation: gen('b') };
    pages([
      firstPage,
      { version: 1, state: 'changed', namespace },
      { ...firstPage, ...fresh },
      { ...lastPage, ...fresh },
    ]);
    expect(await readCleanupNamespace(root, options)).toEqual([tail]);
    expect(cursors().map((args) => args.at(-3) ?? 'first')).toEqual(['first', gen('a'), 'first', gen('b')]);
  });

  it.each([
    [
      'partial：连续换代超过轮次',
      [
        firstPage,
        { version: 1, state: 'changed' },
        firstPage,
        { version: 1, state: 'changed' },
        firstPage,
        { version: 1, state: 'changed' },
      ],
      '换代',
    ],
    ['partial：缺页（第二页读失败）', [firstPage], '读失败'],
    [
      'partial：旧帮手只给前缀，无代次/游标',
      [{ ...firstPage, generation: undefined, next: undefined }],
      '不支持分页',
    ],
    ['partial：首页冒充续页', [{ ...lastPage }], '首页回执带了游标'],
    ['partial：截断页缺游标', [{ ...firstPage, next: undefined }], '游标'],
    ['partial：截断页缺游标证明，不能续读', [{ ...firstPage, proof: undefined }], '缺游标证明'],
    ['partial：游标证明不是摘要', [{ ...firstPage, proof: '12' }], '缺游标证明'],
    ['partial：重复页/循环游标', [firstPage, { ...firstPage, after: hash(99) }], '重复或回退'],
    ['partial：游标回退', [firstPage, { ...firstPage, after: hash(99), next: hash(5) }], '重复或回退'],
    ['partial：回执不是所请求游标之后', [firstPage, { ...lastPage, after: hash(1) }], '所请求游标'],
    ['partial：命名空间换了', [firstPage, { ...lastPage, namespace: { ...namespace, ino: '3' } }], '身份'],
    ['partial：代次变了却仍报 ok', [firstPage, { ...lastPage, generation: gen('c') }], '代次'],
    ['partial：旧格式代次（非摘要）不认', [{ ...firstPage, generation: '77.130' }], '不支持分页'],
    [
      'partial：记录落在游标之前',
      [firstPage, { ...lastPage, rows: [{ ...tail, pathHash: hash(3) }] }],
      '范围',
    ],
    ['partial：记录越过本页游标', [{ ...firstPage, rows: [tail] }, lastPage], '范围'],
    ['partial：跨页重复记录', [{ ...firstPage, rows: [{ ...tail, pathHash: hash(9) }] }, lastPage], '重复'],
    ['partial：坏记录', [firstPage, { ...lastPage, rows: [{ phase: 'DELETING' }] }], '坏记录'],
    ['partial：坏回执', [firstPage, { ...lastPage, rows: null }], '回执不完整'],
  ])(
    '%s',
    async (_name, list, why) => {
      pages(list as unknown[]);
      await expect(readCleanupNamespace(root, options)).rejects.toThrow(why);
    },
    30_000,
  ); // 每页起两个子进程，机器忙时轮次用尽的那条会超默认 5 秒

  it('partial：页数、条数、字节、整轮时间超界不放宽', async () => {
    const chain = [0, 1, 2, 3].map((i) => ({
      ...firstPage,
      after: i ? hash(i * 10) : null,
      next: hash(i * 10 + 10),
      proof: gen(String(i)),
    }));
    CLEANUP_PAGE_LIMITS.pages = 3;
    pages(chain);
    await expect(cleanupStatus(options)).rejects.toThrow('页上限');
    Object.assign(CLEANUP_PAGE_LIMITS, saved, { rows: 0 });
    pages([firstPage, lastPage]);
    await expect(cleanupStatus(options)).rejects.toThrow('条数或字节');
    Object.assign(CLEANUP_PAGE_LIMITS, saved, { bytes: 100 });
    pages([firstPage, lastPage]);
    await expect(cleanupStatus(options)).rejects.toThrow('条数或字节');
    Object.assign(CLEANUP_PAGE_LIMITS, saved, { ms: 0 });
    pages([firstPage, lastPage]);
    await expect(cleanupStatus(options)).rejects.toThrow('超时');
  });
});
