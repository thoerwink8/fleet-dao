import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_PAGE_LIMITS,
  cleanupStatus,
  invokeTreeHelper,
  readCleanupNamespace,
  readTreeUsage,
  readTreeUsageDetail,
} from '../src/tree-cleanup.ts';

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
  const round = 'a'.repeat(32);
  const cursor = (n: number) => `c${n}.${String(n % 10).repeat(64)}`;
  const head = { version: 1, state: 'ok', namespace, round };
  // 首页读了前 100 桶（全是空/已结），第 2 页读完尾部 30 桶并把 130 桶全部复核：只有它是 truncated=false。
  const firstPage = {
    ...head,
    rows: [],
    truncated: true,
    page: 1,
    pass: 'read',
    from: null,
    through: hash(99),
    cursor: cursor(1),
  };
  const lastPage = {
    ...head,
    rows: [tail],
    truncated: false,
    page: 2,
    pass: 'verify',
    from: hash(99),
    through: hash(129),
  };
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

  it('完整读取：首页空行仍截断，只把帮手签发的游标原样交回，读到尾部 RECOVERY_REQUIRED', async () => {
    pages([firstPage, lastPage]);
    expect(await readCleanupNamespace(root, options)).toEqual([tail]);
    // 游标不透明：不自己拼桶名、偏移或摘要，只带上一页给的那串。
    expect(cursors()).toEqual([[], ['--cursor', cursor(1)]]);
    pages([firstPage, lastPage]);
    expect(await cleanupStatus(options)).toEqual([tail]);
  });

  it('完整读取：复核页（同一桶位、无记录）也要接续，末页才完整', async () => {
    const verify = {
      ...head,
      rows: [],
      truncated: true,
      page: 2,
      pass: 'verify',
      from: hash(129),
      through: hash(129),
      cursor: cursor(2),
    };
    const read = { ...firstPage, rows: [tail], page: 1, through: hash(129) };
    const done = { ...lastPage, rows: [], page: 3, from: hash(129) };
    pages([read, verify, done]);
    expect(await readCleanupNamespace(root, options)).toEqual([tail]);
    expect(cursors()).toEqual([[], ['--cursor', cursor(1)], ['--cursor', cursor(2)]]);
  });

  it('完整读取：翻页中命名空间变了整轮重启，不拼两轮的页', async () => {
    const fresh = { round: 'b'.repeat(32) };
    pages([
      firstPage,
      { version: 1, state: 'changed', reason: 'namespace changed during the round' },
      { ...firstPage, ...fresh, cursor: cursor(3) },
      { ...lastPage, ...fresh },
    ]);
    expect(await readCleanupNamespace(root, options)).toEqual([tail]);
    expect(cursors()).toEqual([[], ['--cursor', cursor(1)], [], ['--cursor', cursor(3)]]);
  });

  it.each([
    [
      'partial：连续变动超过轮次',
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
      'partial：旧帮手只给前缀，无轮次/游标',
      [{ ...firstPage, round: undefined, cursor: undefined }],
      '不支持分页',
    ],
    ['partial：首页冒充续页', [{ ...lastPage, page: 1 }], '接着读'],
    ['partial：截断页缺游标', [{ ...firstPage, cursor: undefined }], '游标缺失或重复'],
    ['partial：游标不是帮手格式', [{ ...firstPage, cursor: `--after ${hash(99)}` }], '游标缺失或重复'],
    ['partial：重复游标（循环）', [firstPage, { ...firstPage, page: 2, from: hash(99) }], '游标缺失或重复'],
    ['partial：页号跳了', [firstPage, { ...lastPage, page: 3 }], '本轮的下一页'],
    ['partial：混进别的轮次', [firstPage, { ...lastPage, round: 'b'.repeat(32) }], '本轮的下一页'],
    ['partial：没从上一页停下处接着读', [firstPage, { ...lastPage, from: hash(1) }], '接着读'],
    ['partial：读到的位置回退', [firstPage, { ...lastPage, through: hash(5) }], '回退'],
    ['partial：命名空间换了', [firstPage, { ...lastPage, namespace: { ...namespace, ino: '3' } }], '身份'],
    ['partial：轮次不是帮手格式', [{ ...firstPage, round: '77' }], '不支持分页'],
    [
      'partial：记录落在本页起点之前',
      [firstPage, { ...lastPage, rows: [{ ...tail, pathHash: hash(3) }] }],
      '范围',
    ],
    ['partial：记录越过本页读到的桶', [{ ...firstPage, rows: [tail] }, lastPage], '范围'],
    [
      'partial：复核页带记录',
      [
        { ...firstPage, through: hash(129) },
        { ...lastPage, from: hash(129), rows: [tail] },
      ],
      '范围',
    ],
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

  // 四种超界各自一条用例：每条只起几个帮手子进程，不再把十来个子进程攒在同一条 5 秒用例里
  // （Windows 上机器忙时 4 种合在一起实测到 3.7 秒，逼近默认 5 秒）。断言和限值都不变。
  const chain = [0, 1, 2, 3].map((i) => ({
    ...firstPage,
    page: i + 1,
    from: i ? hash(i * 10) : null,
    through: hash(i * 10 + 10),
    cursor: cursor(i + 1),
  }));
  it.each([
    ['页数', { pages: 3 }, () => chain, '页上限'],
    ['条数', { rows: 0 }, () => [firstPage, lastPage], '条数或字节'],
    ['字节', { bytes: 100 }, () => [firstPage, lastPage], '条数或字节'],
    ['整轮时间', { ms: 0 }, () => [firstPage, lastPage], '超时'],
  ])('partial：%s超界不放宽', async (_name, limit, list, why) => {
    Object.assign(CLEANUP_PAGE_LIMITS, saved, limit);
    pages(list());
    await expect(cleanupStatus(options)).rejects.toThrow(why);
  });
});

describe('tree-usage 读不出 idle/busy 时带有界的原因类别（#3557）', () => {
  const place = {
    lex: `${root}/acme_web/12-a`,
    real: `${root}/acme_web/12-a`,
    dev: '7',
    ino: '8',
    uid: '1000',
  };
  const secret = 'FLEET_TOKEN=sk-live-0123456789 /usr/bin/claude --dangerously ps-aux-list';
  const usage = (over: Record<string, unknown>) =>
    JSON.stringify({ version: 1, state: 'idle', identity: place, scanned: 3, failed: 0, ...over });
  const keys = [
    'FLEET_FAKE_SCOPE_USAGE_STDOUT',
    'FLEET_FAKE_SCOPE_USAGE_STDERR',
    'FLEET_FAKE_SCOPE_USAGE_EXIT',
    'FLEET_FAKE_SCOPE_USAGE_HANG_MS',
    'FLEET_FAKE_SCOPE_CAPABILITIES',
  ];
  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });
  /** 读数只许固定枚举和整数：不超 160 字节，不带帮手的 stderr/stdout 原文。 */
  function bounded(reading: object) {
    const text = JSON.stringify(reading);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(160);
    for (const part of ['sk-live', 'claude', 'ps-aux', 'FLEET_TOKEN', '受管', 'Error'])
      expect(text).not.toContain(part);
  }

  it('idle/busy 语义不变，readTreeUsage 仍只回三态', async () => {
    expect(await readTreeUsageDetail(place, options)).toEqual({ state: 'idle' });
    expect(await readTreeUsage(place, options)).toBe('idle');
    process.env.FLEET_FAKE_SCOPE_USAGE_STDOUT = usage({ state: 'busy' });
    expect(await readTreeUsageDetail(place, options)).toEqual({ state: 'busy' });
    expect(await readTreeUsage(place, options)).toBe('busy');
  });

  it.each([
    [
      '帮手非零退出',
      { FLEET_FAKE_SCOPE_USAGE_EXIT: '3', FLEET_FAKE_SCOPE_USAGE_STDERR: secret },
      { reason: 'call-failed', exitCode: 3 },
    ],
    ['回执不是 JSON', { FLEET_FAKE_SCOPE_USAGE_STDOUT: `not json ${secret}` }, { reason: 'protocol' }],
    ['协议版本不对', { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ version: 2 }) }, { reason: 'protocol' }],
    ['状态认不出', { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ state: secret }) }, { reason: 'protocol' }],
    [
      '能力不全',
      { FLEET_FAKE_SCOPE_CAPABILITIES: JSON.stringify({ version: 1, state: 'ok', features: [] }) },
      { reason: 'protocol' },
    ],
    [
      '帮手明确 unknown',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ state: 'unknown', note: secret }) },
      { reason: 'helper-unknown' },
    ],
    [
      '能力回执自己答 unknown 是协议无效，不是帮手明确 unknown',
      { FLEET_FAKE_SCOPE_CAPABILITIES: JSON.stringify({ version: 1, state: 'unknown', note: secret }) },
      { reason: 'protocol' },
    ],
    [
      '帮手答 unknown 但换了树：身份优先',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ state: 'unknown', identity: { ...place, ino: '9' } }) },
      { reason: 'identity' },
    ],
    [
      '帮手答 unknown 但没带身份：身份优先',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: JSON.stringify({ version: 1, state: 'unknown', note: secret }) },
      { reason: 'identity' },
    ],
    [
      '回执换了树',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ identity: { ...place, ino: '9' } }) },
      { reason: 'identity' },
    ],
    ['回执没身份', { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ identity: secret }) }, { reason: 'identity' }],
    [
      '一个进程都没扫到',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ scanned: 0 }) },
      { reason: 'incomplete', scanned: 0, failed: 0 },
    ],
    [
      '有进程没读成',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ state: 'busy', failed: 2 }) },
      { reason: 'incomplete', scanned: 3, failed: 2 },
    ],
    [
      '扫描数认不出',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ scanned: secret, failed: 1.5 }) },
      { reason: 'incomplete' },
    ],
    [
      '扫描计数为负数',
      { FLEET_FAKE_SCOPE_USAGE_STDOUT: usage({ scanned: -1, failed: -2 }) },
      { reason: 'incomplete' },
    ],
  ])('%s：unknown 带原因，不冒充 idle/busy', async (_name, env, expected) => {
    Object.assign(process.env, env);
    const reading = await readTreeUsageDetail(place, options);
    expect(reading).toEqual({ state: 'unknown', ...expected });
    bounded(reading);
    expect(await readTreeUsage(place, options)).toBe('unknown');
  });

  it('请求身份本身无效：不调帮手，记身份不符', async () => {
    const reading = await readTreeUsageDetail({ ...place, lex: 'relative', real: 'relative' }, options);
    expect(reading).toEqual({ state: 'unknown', reason: 'identity' });
  });

  it('起不来的帮手是调用失败，不是超时', async () => {
    const reading = await readTreeUsageDetail(place, {
      ...options,
      helper: '/nonexistent/fleet-agent-scope',
    });
    expect(reading.reason).toBe('call-failed');
    bounded(reading);
  });

  it('帮手错误对象也不带 stderr、stdout、命令行或取消原文', async () => {
    const secret = 'TOKEN=ghp_secret sudo -n /usr/local/sbin/fleet-agent-scope ps aux';
    process.env.FLEET_FAKE_SCOPE_USAGE_EXIT = '3';
    process.env.FLEET_FAKE_SCOPE_USAGE_STDOUT = secret;
    process.env.FLEET_FAKE_SCOPE_USAGE_STDERR = secret;
    const failed = await invokeTreeHelper(options, ['tree-usage', place.lex]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    const failedText = String((failed as Error).message);
    expect(failedText).not.toContain('ghp_secret');
    expect(failedText).not.toContain('fleet-agent-scope');
    expect(Buffer.byteLength(failedText)).toBeLessThanOrEqual(160);
    const controller = new AbortController();
    controller.abort(secret);
    const aborted = await invokeTreeHelper({ ...options, signal: controller.signal }, [
      'tree-usage',
      place.lex,
    ]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(aborted).toBeInstanceOf(Error);
    const abortedText = String((aborted as Error).message);
    expect(abortedText).not.toContain('ghp_secret');
    expect(abortedText).not.toContain('fleet-agent-scope');
  });

  it('本端期限到了杀掉帮手才算超时', async () => {
    process.env.FLEET_FAKE_SCOPE_USAGE_HANG_MS = '20000';
    const reading = await readTreeUsageDetail(place, { ...options, timeoutMs: 2500 });
    expect(reading).toEqual({ state: 'unknown', reason: 'timeout' });
  }, 15_000);

  it('调用方取消（调用前、调用中）记中止，不当超时', async () => {
    const before = new AbortController();
    before.abort();
    expect(await readTreeUsageDetail(place, { ...options, signal: before.signal })).toEqual({
      state: 'unknown',
      reason: 'aborted',
    });
    process.env.FLEET_FAKE_SCOPE_USAGE_HANG_MS = '20000';
    const during = new AbortController();
    setTimeout(() => during.abort(), 2500);
    expect(await readTreeUsageDetail(place, { ...options, signal: during.signal })).toEqual({
      state: 'unknown',
      reason: 'aborted',
    });
  }, 15_000);
});
