import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // 三步各起两次帮手（capabilities + cleanup-status）。超时只报一个阶段分不清是一次卡死还是六次都慢，
    // 所以连第几步、哪个动作、这一段等了多久、整条用例用了多久一起报。
    const begun = Date.now();
    let step = '';
    onTestFailed(({ task }) => {
      const now = TreeHelperError.pending;
      if (!now) return;
      const timedOut = (task.result?.errors ?? []).some((error) => /timed out|5000/.test(shown(error)));
      if (!timedOut) return;
      const at = Date.now();
      throw new Error(
        `帮手等待：步骤=${step} 动作=${now.action} 阶段=${now.stage} 已启动=${now.spawned ? '是' : '否'} 已读字节=${now.stdoutBytes} 本段已等${at - now.stageAt}ms 本次调用${at - now.startedAt}ms 用例共${at - begun}ms。原首红 head fc1c891ef0d595c170e35cab1920bf814fb179aa、run 39492760116、attempt 1、test (3/8) 的 5000ms 没有这些，当时卡在哪一段仍未知`,
      );
    });
    step = '1/3 读空';
    reply();
    expect(await readCleanupNamespace(root, options)).toEqual([]);
    const rows = [{ id: 'a'.repeat(64), pathHash: 'b'.repeat(64), phase: 'DELETING' }];
    reply({ rows });
    step = '2/3 读未结';
    expect(await readCleanupNamespace(root, options)).toEqual(rows);
    step = '3/3 cleanupStatus';
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
    // 先过了 capabilities，失败要记在真正退出非 0 的 cleanup-status 上。
    await expect(failedHelper()).rejects.toThrow(
      /动作=cleanup-status 等待阶段=\S+ 已启动=是 已读字节=\d+ 本段已等\d+ms 共\d+ms/,
    );
    delete process.env.FLEET_FAKE_SCOPE_CLEANUP_EXIT;
    reply({ truncated: true });
    await expect(cleanupStatus(options)).rejects.toThrow('不完整');
  });
});

describe('帮手等待阶段', () => {
  // silence：子进程已经起来，先不写。这不是启动。启动只发生在父进程还没 exec 之前。
  const holdOf: Record<Exclude<HelperWaitStage, '启动'>, string> = {
    协议读取: 'silence',
    退出: 'exit',
    异步收尾: 'cleanup',
  };

  it('四段只看进程出现没有、读没读完、退没退', () => {
    const none = { spawned: false, stdoutBytes: 0, stdoutEnded: false, exited: false, closed: false };
    // 还没出现才是启动。已经出现但一个字都没有，是在等协议，不是还在启动。
    expect(helperWaitStage(none)).toBe('启动');
    expect(helperWaitStage({ ...none, stdoutBytes: 1 })).toBe('启动');
    expect(helperWaitStage({ ...none, spawned: true })).toBe('协议读取');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1 })).toBe('协议读取');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, stdoutEnded: true })).toBe('退出');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, stdoutEnded: true, exited: true })).toBe(
      '异步收尾',
    );
    expect(helperWaitStage({ ...none, spawned: true, exited: true })).toBe('异步收尾');
    expect(helperWaitStage({ ...none, spawned: true, stdoutBytes: 1, exited: true })).toBe('异步收尾');
    expect(helperWaitStage({ ...none, spawned: true, stdoutEnded: true, exited: true, closed: true })).toBe(
      '异步收尾',
    );
  });

  async function expectHold(stage: HelperWaitStage): Promise<void> {
    let dir = '';
    let release = () => {};
    let log = '';
    if (stage !== '启动') process.env.FLEET_FAKE_SCOPE_HOLD = holdOf[stage];
    if (stage === '异步收尾' || stage === '启动') {
      dir = mkdtempSync(join(tmpdir(), 'fleet-cleanup-hold-'));
    }
    if (stage === '异步收尾') process.env.FLEET_FAKE_SCOPE_HOLD_PIDFILE = join(dir, 'pid');
    if (stage === '启动') {
      log = join(dir, 'log');
      process.env.FLEET_FAKE_SCOPE_LOG = log;
    }
    const stop = new AbortController();
    const pending = readCleanupNamespace(root, {
      ...options,
      signal: stop.signal,
      ...(stage === '启动'
        ? {
            beforeSpawn: () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          }
        : {}),
    }).then(
      () => {
        throw new Error(`等待阶段=${stage} 被当成完成`);
      },
      (error: unknown) => error,
    );
    try {
      let reached: NonNullable<typeof TreeHelperError.pending> | null = null;
      if (stage === '启动') {
        const now = TreeHelperError.pending;
        if (now?.stage !== '启动' || now.spawned !== false || now.stdoutBytes !== 0) {
          throw new Error(
            `启动应停在进程出现前：阶段=${now?.stage ?? '无'} 已启动=${String(now?.spawned)} 已读字节=${now?.stdoutBytes ?? '无'}`,
          );
        }
        reached = now;
      } else {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const now = TreeHelperError.pending;
          const silent = stage !== '协议读取' || (now?.spawned === true && now.stdoutBytes === 0);
          if (now?.stage === stage && now.spawned === true && silent) {
            reached = now;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      if (!reached) {
        const now = TreeHelperError.pending;
        throw new Error(
          `4 秒内没有进入等待阶段=${stage}，停在 ${now?.stage ?? '无'} 已启动=${String(now?.spawned)} 已读字节=${now?.stdoutBytes ?? '无'}`,
        );
      }
      // 假帮手对每个动作都停，第一次就是 capabilities；进入这一段的时刻不早于调用开始。
      expect(reached.action).toBe('capabilities');
      expect(reached.stageAt).toBeGreaterThanOrEqual(reached.startedAt);
      if (stage === '协议读取') {
        expect(reached.spawned).toBe(true);
        expect(reached.stdoutBytes).toBe(0);
      }
      stop.abort();
      const error = await pending;
      expect(shown(error)).toMatch(
        new RegExp(
          `动作=capabilities 等待阶段=${stage} 已启动=(?:是|否) 已读字节=\\d+ 本段已等\\d+ms 共\\d+ms`,
        ),
      );
      expect(shown(error)).toContain(stage === '启动' ? '已启动=否' : '已启动=是');
      expect(shown(error)).not.toContain('fake-scope-helper');
      expect(shown(error)).not.toContain(process.execPath);
      if (log) expect(existsSync(log)).toBe(false);
    } finally {
      release();
      stop.abort();
      reapHoldChild();
      delete process.env.FLEET_FAKE_SCOPE_LOG;
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
    // silence 是进程起来之后才睡，睡完仍要把未结记录交回来。
    process.env.FLEET_FAKE_SCOPE_HOLD = 'silence';
    process.env.FLEET_FAKE_SCOPE_HOLD_MS = '30';
    expect(await readCleanupNamespace(root, options)).toEqual(rows);
    expect(await cleanupStatus(options)).toEqual(rows);
  });

  it('只吐半截时停在协议读取且已有字节，不当成空', async () => {
    process.env.FLEET_FAKE_SCOPE_HOLD = 'protocol';
    const stop = new AbortController();
    const pending = readCleanupNamespace(root, { ...options, signal: stop.signal }).then(
      () => {
        throw new Error('半截回执被当成完成');
      },
      (error: unknown) => error,
    );
    try {
      const deadline = Date.now() + 4_000;
      let reached: NonNullable<typeof TreeHelperError.pending> | null = null;
      while (Date.now() < deadline) {
        const now = TreeHelperError.pending;
        if (now?.stage === '协议读取' && now.spawned && now.stdoutBytes > 0) {
          reached = now;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!reached) {
        const now = TreeHelperError.pending;
        throw new Error(
          `4 秒内没有读到半截，停在 ${now?.stage ?? '无'} 已读字节=${now?.stdoutBytes ?? '无'}`,
        );
      }
      expect(reached.action).toBe('capabilities');
      stop.abort();
      const error = await pending;
      expect(shown(error)).toMatch(/动作=capabilities 等待阶段=协议读取 已启动=是 已读字节=[1-9]\d*/);
      expect(shown(error)).not.toContain('fake-scope-helper');
      expect(shown(error)).not.toContain(process.execPath);
    } finally {
      stop.abort();
      await pending.catch(() => undefined);
    }
  });

  it('可执行文件不存在就停在启动并拒绝，不当成空', async () => {
    const error = await readCleanupNamespace(root, { ...options, sudo: ['/no/such/fleet-sudo'] }).then(
      () => {
        throw new Error('启动失败被当成完成');
      },
      (caught: unknown) => caught,
    );
    expect(shown(error)).toMatch(/动作=capabilities 等待阶段=启动 已启动=否 已读字节=0/);
    expect(shown(error)).not.toContain('/no/such');
    expect(shown(error)).not.toContain(process.execPath);
    expect(shown(error)).not.toContain('fake-scope-helper');
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
