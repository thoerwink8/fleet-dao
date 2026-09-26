// 飞书草稿开单（draft-opening.ts）：时限自己掐（实现不回也不卡住等它的人）、超时之后开成了照样记上、
// 同一张草稿不同时开两次、补开一轮没跑完不叠第二轮、健康检查（draft_opener / draft_backlog）如实报红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import {
  createDraftOpenRunner,
  DRAFT_BACKLOG_ALERT_MS,
  draftBacklogCheck,
  notWiredDraftOpener,
} from '../src/draft-opening.ts';
import { silentLogger } from '../src/log.ts';
import { createMemoryStore, type FeishuDraftRow } from '../src/memory-store.ts';
import type { DraftOpener, DraftRecord, Logger, Store } from '../src/ports.ts';
import { FEISHU_IDS, feishuData, T0 } from './store-contract-feishu.ts';

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pendingDraft(over: Partial<DraftRecord> = {}): DraftRecord {
  const at = T0.toISOString();
  return {
    id: FEISHU_IDS.draft1,
    revision: 1,
    status: 'confirmed',
    sourceMessageId: 'om_1',
    chatType: 'p2p',
    rawText: '给登录页加手机验证码',
    understanding: '给登录页加手机验证码',
    unsure: true,
    repoId: IDS.repo,
    proposedBy: IDS.founderA,
    confirmedBy: IDS.founderB,
    confirmedAt: at,
    opening: { attempts: 0 },
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/** 只实现开单用得到的几个方法的假 Store，记下开成了什么、没成记了什么。 */
function fakeStore(draft: DraftRecord = pendingDraft()) {
  const failures: { draftId: string; error: string }[] = [];
  const opened: { draftId: string; taskId: string }[] = [];
  const store = {
    async getDraft(id: string) {
      return id === draft.id ? draft : null;
    },
    async getRepo(id: string) {
      return { id, owner: 'example', name: 'canary', defaultBranch: 'main', testCommand: 'pnpm test' };
    },
    async getUser(id: string) {
      return { id, displayName: id, role: 'founder', active: true };
    },
    async listDraftsToOpen(limit: number) {
      return [draft].slice(0, limit);
    },
    async recordDraftOpened(input: { draftId: string; taskId: string }) {
      opened.push(input);
      return 'ok';
    },
    async recordDraftOpenFailure(input: { draftId: string; error: string }) {
      failures.push(input);
    },
  } as unknown as Store;
  return { store, failures, opened };
}

/** 开了就一直不回的实现。 */
function neverReturns() {
  const calls: string[] = [];
  const opener: DraftOpener = {
    async open(request) {
      calls.push(request.draftId);
      return new Promise(() => {});
    },
    async check() {},
  };
  return { opener, calls };
}

function runner(store: Store, opener: DraftOpener, limits: { confirmWaitMs: number; callLimitMs: number }) {
  return createDraftOpenRunner({ store, opener, log: silentLogger, now: () => new Date(T0), limits });
}

describe('开单的时限（假计时器：拨到哪个时刻就看那个时刻，机器忙也不会偶发红）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** 拨钟：先让排着的 promise 跑完（真的一轮事件循环），拨过去，再跑完一轮。 */
  const advance = async (ms: number) => {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((r) => setImmediate(r));
  };

  it('实现永远不回：只等到给的时限就返回「没等到」；到一次开单的时限记「开单超时」、算一次没成', async () => {
    const fake = fakeStore();
    const never = neverReturns();
    const r = runner(fake.store, never.opener, { confirmWaitMs: 20, callLimitMs: 60 });
    const opening = r.openOne(FEISHU_IDS.draft1);
    await advance(20);
    expect(await opening).toBe('pending');
    expect(fake.failures).toEqual([]);
    await advance(39);
    expect(fake.failures).toEqual([]);
    await advance(1);
    expect(fake.failures).toEqual([{ draftId: FEISHU_IDS.draft1, error: '开单超时：0.06 秒没回' }]);
    expect(fake.opened).toEqual([]);
    expect(never.calls).toEqual([FEISHU_IDS.draft1]);
  });

  it('超时之后实现才开成：照样记上任务（那次调用留着跑到头）', async () => {
    const fake = fakeStore();
    const slow: DraftOpener = {
      async open() {
        await sleep(150);
        return { taskId: 'task-44', issueNumber: 44 };
      },
      async check() {},
    };
    const r = runner(fake.store, slow, { confirmWaitMs: 20, callLimitMs: 60 });
    const opening = r.openOne(FEISHU_IDS.draft1);
    await advance(20);
    expect(await opening).toBe('pending');
    await advance(40);
    expect(fake.failures).toEqual([{ draftId: FEISHU_IDS.draft1, error: '开单超时：0.06 秒没回' }]);
    expect(fake.opened).toEqual([]);
    await advance(90);
    expect(fake.opened).toEqual([{ draftId: FEISHU_IDS.draft1, taskId: 'task-44' }]);
  });

  it('上一次超时还挂着：再开、补开都不调第二次，也不干等（不拨钟就回来）', async () => {
    const fake = fakeStore();
    const never = neverReturns();
    const r = runner(fake.store, never.opener, { confirmWaitMs: 200, callLimitMs: 20 });
    const opening = r.openOne(FEISHU_IDS.draft1);
    await advance(20);
    expect(await opening).toBe('failed');
    expect(await r.openOne(FEISHU_IDS.draft1)).toBe('skipped');
    expect(await r.runPending(true)).toEqual({ opened: 0, failed: 0 });
    expect(never.calls).toEqual([FEISHU_IDS.draft1]);
    expect(fake.failures).toHaveLength(1);
  });

  it('补开上一轮还没跑完：这一轮跳过，只提一次；跑完了下一轮照常', async () => {
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    let lists = 0;
    let release: (drafts: DraftRecord[]) => void = () => {};
    const store = {
      async listDraftsToOpen() {
        lists += 1;
        if (lists === 1) {
          return new Promise<DraftRecord[]>((resolve) => {
            release = resolve;
          });
        }
        return [];
      },
    } as unknown as Store;
    const r = createDraftOpenRunner({
      store,
      opener: notWiredDraftOpener(),
      log,
      now: () => new Date(T0),
    });
    const stop = r.start(10);
    await advance(35);
    expect(lists).toBe(1);
    expect(warnings.filter((m) => m.includes('上一轮还没跑完'))).toHaveLength(1);
    release([]);
    await advance(10);
    stop();
    expect(lists).toBe(2);
  });
});

describe('重启、重读', () => {
  it('进程重启（新的开单器、同一个库）：上一次调用没回的草稿一起来就再调一次——所以实现必须按草稿编号幂等、记在库里', async () => {
    const fake = fakeStore();
    const never = neverReturns();
    const before = runner(fake.store, never.opener, { confirmWaitMs: 20, callLimitMs: 60_000 });
    // 重启前：调出去了、一直没回（issue 可能已经在 GitHub 上开出来了），「正在开」只记在这个进程里。
    expect(await before.openOne(FEISHU_IDS.draft1)).toBe('pending');
    expect(never.calls).toEqual([FEISHU_IDS.draft1]);

    const again: string[] = [];
    const afterRestart = createDraftOpenRunner({
      store: fake.store,
      opener: {
        async open(request) {
          again.push(request.draftId);
          return { taskId: 'task-44', issueNumber: 44 };
        },
        async check() {},
      },
      log: silentLogger,
      now: () => new Date(T0),
    });
    const stop = afterRestart.start(60_000);
    for (let i = 0; i < 100 && fake.opened.length === 0; i++) await sleep(10);
    stop();
    // 同一张草稿又交给实现一次：实现要认出上一次开的那张 issue，交回它，不开第二张。
    expect(again).toEqual([FEISHU_IDS.draft1]);
    expect(fake.opened).toEqual([{ draftId: FEISHU_IDS.draft1, taskId: 'task-44' }]);
  });

  it('开之前重读草稿：列出来之后已经开成了的不再开', async () => {
    const fake = fakeStore(pendingDraft({ taskId: 'task-1' }));
    const calls: string[] = [];
    const opener: DraftOpener = {
      async open(request) {
        calls.push(request.draftId);
        return { taskId: 'task-2', issueNumber: 2 };
      },
      async check() {},
    };
    const r = runner(fake.store, opener, { confirmWaitMs: 50, callLimitMs: 100 });
    expect(await r.openOne(FEISHU_IDS.draft1)).toBe('skipped');
    expect(calls).toEqual([]);
  });
});

describe('健康检查', () => {
  it('开单没接上：open 如实没成、check 报 not_wired（不装作好了）', async () => {
    const opener = notWiredDraftOpener();
    await expect(opener.check()).rejects.toMatchObject({ name: 'PublicHealthError', code: 'not_wired' });
    expect(opener.notWired).toBe('飞书草稿开成 issue 还没接上（#91）');
    await expect(opener.open(pendingDraft() as never, new AbortController().signal)).rejects.toMatchObject({
      name: 'DraftOpenerUnavailableError',
    });
  });

  it('最早的待开单等太久就报红；没有积压、等得不久都是好的', async () => {
    const store = createMemoryStore(feishuData(), { now: () => new Date(T0) });
    const now = () => new Date(T0);
    const check = draftBacklogCheck(store, now);
    await expect(check()).resolves.toBeUndefined();

    const row: FeishuDraftRow = {
      id: FEISHU_IDS.draft1,
      revision: 1,
      status: 'confirmed',
      sourceMessageId: 'om_1',
      chatType: 'p2p',
      rawText: '给登录页加手机验证码',
      understanding: '给登录页加手机验证码',
      unsure: true,
      repoId: IDS.repo,
      proposedBy: IDS.founderA,
      confirmedBy: IDS.founderB,
      confirmedAt: new Date(T0.getTime() - 5 * MIN).toISOString(),
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      openAttempts: 3,
    };
    store.data.feishuDrafts.push(row);
    await expect(check()).resolves.toBeUndefined();

    row.confirmedAt = new Date(T0.getTime() - DRAFT_BACKLOG_ALERT_MS - MIN).toISOString();
    await expect(check()).rejects.toMatchObject({
      name: 'PublicHealthError',
      code: 'backlog',
      message: '最早一张待开单已经等了 16 分钟还没开成',
    });
  });

  it('库读不到、确认时刻认不出：照样报红，不当成「没有积压」', async () => {
    const now = () => new Date(T0);
    const down = {
      async listDraftsToOpen() {
        throw new Error('connection refused');
      },
    } as unknown as Store;
    await expect(draftBacklogCheck(down, now)()).rejects.toThrow('connection refused');
    const broken = {
      async listDraftsToOpen() {
        return [pendingDraft({ confirmedAt: '看不出来' })];
      },
    } as unknown as Store;
    await expect(draftBacklogCheck(broken, now)()).rejects.toThrow('确认时刻认不出');
  });
});
