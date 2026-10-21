import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFailed } from 'vitest';
import {
  CLEANUP_PAGE_LIMITS,
  cleanupStatus,
  type HelperWaitStage,
  helperWaitStage,
  readCleanupNamespace,
  TreeHelperError,
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
function shown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

async function failedHelper(): Promise<never> {
  try {
    await readCleanupNamespace(root, options);
  } catch (error) {
    const message = shown(error);
    expect(message).not.toContain('fake-scope-helper');
    expect(message).not.toContain('FLEET_FAKE_SCOPE');
    expect(message).not.toContain(process.execPath);
    throw error;
  }
  throw new Error('失败被当成完成');
}

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
function reapHoldChild(): void {
  const file = process.env.FLEET_FAKE_SCOPE_HOLD_PIDFILE;
  if (!file) return;
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    // 没写出来，或子进程已经退了。
  }
}

afterEach(() => {
  reapHoldChild();
  delete process.env.FLEET_FAKE_SCOPE_CLEANUP_STDOUT;
  delete process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT;
  delete process.env.FLEET_FAKE_SCOPE_HOLD;
  delete process.env.FLEET_FAKE_SCOPE_HOLD_MS;
  delete process.env.FLEET_FAKE_SCOPE_HOLD_PIDFILE;
});

describe('cleanup-status 原帮手端口的命名空间事实', () => {
  // 首红：head fc1c891ef0d595c170e35cab1920bf814fb179aa，
  // Actions run 39492760116 attempt 1，job test (3/8)，vitest 默认 5000ms。
  // 那次日志没有启动/协议读取/退出/异步收尾。本用例再通过，也不能把当时卡在哪一段写成已经知道。
  it('正常空/已结记录不进pending；未结记录原样保留', async () => {
    onTestFailed(({ task }) => {
      const stage = TreeHelperError.pending?.stage;
      if (!stage) return;
      const timedOut = (task.result?.errors ?? []).some((error) => /timed out|5000/.test(shown(error)));
      if (!timedOut) return;
      throw new Error(
        `帮手等待阶段=${stage}。原首红 head fc1c891ef0d595c170e35cab1920bf814fb179aa、run 39492760116、attempt 1、test (3/8) 的 5000ms 没有这一段，当时卡在哪一段仍未知`,
      );
    });
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
    await expect(failedHelper()).rejects.toThrow('退出码 1');
    delete process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT;
    reply({ truncated: true });
    await expect(cleanupStatus(options)).rejects.toThrow('不完整');
  });
});

describe('帮手等待阶段', () => {
  const holdOf: Record<HelperWaitStage, string> = {
    启动: 'startup',
    协议读取: 'protocol',
    退出: 'exit',
    异步收尾: 'cleanup',
  };

  it('四段只看有没有起来、读没读完、退没退、输出关没关', () => {
    const none = { spawned: false, stdoutBytes: 0, stdoutEnded: false, exited: false, closed: false };
    expect(helperWaitStage(none)).toBe('启动');
    expect(helperWaitStage({ ...none, spawned: true })).toBe('启动');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1 })).toBe('协议读取');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, stdoutEnded: true })).toBe('退出');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, stdoutEnded: true, exited: true })).toBe(
      '异步收尾',
    );
    expect(helperWaitStage({ ...none, spawned: true, exited: true })).toBe('异步收尾');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, exited: true })).toBe('异步收尾');
  });

  async function expectHold(stage: HelperWaitStage): Promise<void> {
    process.env.FLEET_FAKE_SCOPE_HOLD = holdOf[stage];
    let dir = '';
    if (stage === '异步收尾') {
      dir = mkdtempSync(join(tmpdir(), 'fleet-cleanup-hold-'));
      process.env.FLEET_FAKE_SCOPE_HOLD_PIDFILE = join(dir, 'pid');
    }
    const stop = new AbortController();
    const pending = readCleanupNamespace(root, { ...options, signal: stop.signal }).then(
      () => {
        throw new Error(`等待阶段=${stage} 被当成完成`);
      },
      (error: unknown) => error,
    );
    try {
      const deadline = Date.now() + 4_000;
      let reached = false;
      while (Date.now() < deadline) {
        const now = TreeHelperError.pending;
        const started = stage !== '启动' || (now?.spawned === true && now.stdoutBytes === 0);
        if (now?.stage === stage && started) {
          reached = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!reached) {
        throw new Error(`4 秒内没有进入等待阶段=${stage}，停在 ${TreeHelperError.pending?.stage ?? '无'}`);
      }
      stop.abort();
      const error = await pending;
      expect(shown(error)).toContain(`等待阶段=${stage}`);
      expect(shown(error)).not.toContain('fake-scope-helper');
      expect(shown(error)).not.toContain(process.execPath);
    } finally {
      stop.abort();
      reapHoldChild();
      if (dir) rmSync(dir, { recursive: true, force: true });
      await pending.catch(() => undefined);
    }
  }

  it.each(['启动', '协议读取', '退出', '异步收尾'] as const)(
    '真帮手停在%s就拒绝，不交回空列表',
    async (stage) => {
      await expectHold(stage);
    },
  );

  it('短延迟后仍交回未结记录，不变成空', async () => {
    const rows = [{ id: 'a'.repeat(64), pathHash: 'b'.repeat(64), phase: 'DELETING' }];
    reply({ rows });
    process.env.FLEET_FAKE_SCOPE_HOLD = 'startup';
    process.env.FLEET_FAKE_SCOPE_HOLD_MS = '30';
    expect(await readCleanupNamespace(root, options)).toEqual(rows);
    expect(await cleanupStatus(options)).toEqual(rows);
  });

  it('没有输出或不完整回执不当成空', async () => {
    process.env.FLEET_FAKE_SCOPE_CLEANUP_STDOUT = '';
    await expect(readCleanupNamespace(root, options)).rejects.toThrow('回执读失败');
    process.env.FLEET_FAKE_SCOPE_CLEANUP_STDOUT = '{';
    await expect(readCleanupNamespace(root, options)).rejects.toThrow('回执读失败');
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
