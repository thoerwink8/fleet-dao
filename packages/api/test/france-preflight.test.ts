// /api/france/preflight（#2021，「发版预检」）：后端进程内读事实算，不起任何子进程、不碰 home。
// 每一项事实「读到 / 读不到」各一条；读不到的算卡住并写原因（不拿 0 或「没事」冒充）；整个过程不调 node:child_process。
import { execFile, spawn } from 'node:child_process';
import type { ReleaseFactsReader } from '@fleet-dao/github';
import {
  type EngineMasterState,
  FrancePreflightResponseSchema,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it, vi } from 'vitest';
import { runFrancePreflight } from '../src/france-preflight.ts';
import type { FranceReleasePort } from '../src/france-release.ts';
import type { ReleaseCardPort } from '../src/release-card.ts';
import type { ReleaseRequestPort } from '../src/release-request.ts';
import { harness, T0 } from './harness.ts';

// 子进程一律不许起：谁调到就当场抛，并且数一下
vi.mock('node:child_process', () => {
  const boom = vi.fn(() => {
    throw new Error('发版预检不该起子进程');
  });
  return { execFile: boom, spawn: boom, spawnSync: boom, execFileSync: boom, exec: boom, fork: boom };
});

const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const AT = '2026-10-07T10:00:00.000Z';

function withSelf(): Partial<MemoryData> {
  const data = devFixtures(T0);
  return { ...data, repos: [...(data.repos ?? []), SELF] };
}

function facts(over: Partial<ReleaseFactsReader> = {}): ReleaseFactsReader {
  return {
    async mainlineHead() {
      return { sha: HEAD, title: '刷新 CI 测试耗时表 (#1230)', committedAt: AT };
    },
    async commit(_repo, sha) {
      return { sha, title: '探针每次结论落一条历史 (#1225)', committedAt: AT };
    },
    async mainCi() {
      return { state: 'green', detail: '' };
    },
    async compare() {
      return { status: 'ahead', aheadBy: 3, recent: [{ sha: 'c1', title: '刷新 (#1230)' }] };
    },
    async lastMergedPull() {
      return { number: 1230, title: 'x', body: '', mergedAt: AT };
    },
    async issueTitle(_repo, number) {
      return { number, title: 't' };
    },
    ...over,
  };
}

function card(over: Partial<ReleaseCardPort> = {}, f: Partial<ReleaseFactsReader> = {}): ReleaseCardPort {
  return {
    facts: facts(f),
    deployed: () => ({ sha: LIVE }),
    deployedAt: async () => AT,
    ...over,
  };
}

function train(over: Partial<FranceReleasePort> = {}): FranceReleasePort {
  return {
    async readStateFiles() {
      return { stateJson: null, marker: false };
    },
    async readEngineSessions() {
      return { ok: true, running: 0, names: [], engineDown: false };
    },
    ...over,
  };
}

function request(over: Partial<ReleaseRequestPort> = {}): ReleaseRequestPort {
  return {
    async receiverInstalled() {
      return { ok: true };
    },
    async pendingRequest() {
      return false;
    },
    async readLast() {
      return null;
    },
    async writeRequest() {},
    ...over,
  };
}

const MASTER_ON: EngineMasterState = { on: true };

async function run(
  o: {
    card?: ReleaseCardPort | undefined;
    train?: FranceReleasePort | undefined;
    request?: ReleaseRequestPort | undefined;
    master?: () => Promise<EngineMasterState>;
  } = {},
) {
  const h = harness({ data: withSelf() });
  const r = await runFrancePreflight({
    franceRelease: 'train' in o ? o.train : train(),
    card: 'card' in o ? o.card : card(),
    request: 'request' in o ? o.request : request(),
    readMaster: o.master ?? (async () => MASTER_ON),
    store: h.store,
    now: () => T0,
  });
  if (r.state !== 'done') throw new Error(`该是 done，实际 ${r.state}`);
  return r;
}

describe('发版预检：全都读到', () => {
  it('每项通过：退出码 0、结论「能发」、stderr 空、不起子进程', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('结论：能发');
    expect(r.stdout).toContain('[通过] 主线 CI：绿');
    expect(r.stdout).toContain('落后主线 3 个提交');
    expect(r.stdout).toContain('[留意] 引擎总开关');
    expect(r.stdout).toContain('[留意] 法国在跑的会话：0 个');
    expect(r.stdout).not.toContain('[卡住]');
    expect(r.stderr).toBe('');
    expect(r.command).not.toContain('pnpm');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('引擎总开关关着、法国有会话在跑：只报事实，不拦', async () => {
    const r = await run({
      master: async () => ({ on: false, why: 'set' }),
      train: train({
        readEngineSessions: async () => ({
          ok: true,
          running: 2,
          names: ['worker(abcdef12)', '会话(12345678)'],
          engineDown: false,
        }),
      }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('引擎总开关：');
    expect(r.stdout).toContain('保持关');
    expect(r.stdout).toContain('法国在跑的会话：2 个（worker(abcdef12)、会话(12345678)');
  });

  it('引擎没在跑：会话 0 个并写明', async () => {
    const r = await run({
      train: train({
        readEngineSessions: async () => ({ ok: true, running: 0, names: [], engineDown: true }),
      }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 个（引擎没在跑）');
  });
});

describe('发版预检：每项读不到 / 不对都算卡住，写原因', () => {
  const blocked = async (o: Parameters<typeof run>[0], ...words: string[]) => {
    const r = await run(o);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('结论：不能发（1 项卡住）');
    for (const w of words) {
      expect(r.stdout).toContain(w);
      expect(r.stderr).toContain(w);
    }
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  };

  it('主线 CI 红', () =>
    blocked(
      { card: card({}, { mainCi: async () => ({ state: 'red', detail: 'check 红' }) }) },
      '主线 CI：红',
      'check 红',
    ));
  it('主线 CI 还在跑', () =>
    blocked(
      { card: card({}, { mainCi: async () => ({ state: 'pending', detail: '2 项在跑' }) }) },
      '主线 CI：还在跑',
    ));
  it('主线 CI 读不到', () =>
    blocked(
      {
        card: card(
          {},
          {
            mainCi: async () => {
              throw new Error('GitHub 502');
            },
          },
        ),
      },
      '主线 CI：读不到',
      'GitHub 502',
    ));
  it('主线头读不到（落后几个也跟着算不出，这是两项）', async () => {
    const r = await run({
      card: card(
        {},
        {
          mainlineHead: async () => {
            throw new Error('GitHub 断了');
          },
        },
      ),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('主线头：读不到');
    expect(r.stderr).toContain('GitHub 断了');
    expect(r.stderr).toContain('落后几个：读不到');
  });
  it('法国在用的提交读不到', async () => {
    const r = await run({ card: card({ deployed: () => ({ error: 'current 链接坏了' }) }) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('法国在用的提交：读不到');
    expect(r.stderr).toContain('current 链接坏了');
  });
  it('法国已是最新：没有要发的', () =>
    blocked({ card: card({ deployed: () => ({ sha: HEAD }) }) }, '法国已经是最新'));

  it('别的发布在走', async () => {
    const r = await run({
      train: train({
        readStateFiles: async () => ({
          stateJson: JSON.stringify({
            schema: 1,
            phase: 3,
            status: 'running',
            target: { kind: 'sha', value: HEAD },
          }),
          marker: true,
        }),
      }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('别的发布：有一趟还没了结');
  });
  it('进度记录读不到', () =>
    blocked(
      {
        train: train({
          readStateFiles: async () => {
            throw new Error('EACCES 测试故意造的');
          },
        }),
      },
      '别的发布：读不到进度记录',
      'EACCES',
    ));
  it('留着孤儿暂停标记', () =>
    blocked(
      { train: train({ readStateFiles: async () => ({ stateJson: null, marker: true }) }) },
      '暂停标记还留着',
    ));

  it('发版接活单元没装', () =>
    blocked(
      {
        request: request({
          receiverInstalled: async () => ({ ok: false, why: '缺 fleet-release-request.path' }),
        }),
      },
      '发版接活单元：缺 fleet-release-request.path',
    ));
  it('上一份请求还没被接走', () =>
    blocked({ request: request({ pendingRequest: async () => true }) }, '还没被法国接走'));
  it('读上一份请求失败', () =>
    blocked(
      {
        request: request({
          pendingRequest: async () => {
            throw new Error('目录读不了');
          },
        }),
      },
      '上一份发布请求：读不到',
      '目录读不了',
    ));

  it('引擎总开关读不到', () =>
    blocked(
      {
        master: async () => {
          throw new Error('设置表断了');
        },
      },
      '引擎总开关：读不到',
      '设置表断了',
    ));

  it('引擎会话数读不到', () =>
    blocked(
      { train: train({ readEngineSessions: async () => ({ ok: false, why: 'drain.json 读不到' }) }) },
      '法国在跑的会话：读不到',
      'drain.json 读不到',
    ));
  it('引擎会话数读取抛错', () =>
    blocked(
      {
        train: train({
          readEngineSessions: async () => {
            throw new Error('EACCES');
          },
        }),
      },
      '法国在跑的会话：读不到',
      'EACCES',
    ));
});

describe('POST /api/france/preflight', () => {
  const path = WEB_API_PREFIX + WebRoutes.francePreflight.path;
  async function post(h: ReturnType<typeof harness>) {
    const { cookie, csrf } = await h.login();
    const res = await h.cockpit.request(path, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
    return { status: res.status, body: FrancePreflightResponseSchema.parse(await res.json()) };
  }

  it('三样都接上：200，done，能发', async () => {
    const { status, body } = await post(
      harness({ data: withSelf(), franceRelease: train(), releaseCard: card(), releaseRequest: request() }),
    );
    expect(status).toBe(200);
    expect(body.state).toBe('done');
    if (body.state === 'done') expect(body.code).toBe(0);
  });

  it('没接上（开发、内存版）：unreadable + 原因，不拿「预检过了」顶', async () => {
    const { body } = await post(harness({}));
    expect(body.state).toBe('unreadable');
    if (body.state === 'unreadable') expect(body.why).toContain('没接上');
  });

  it('缺一样也算没接上', async () => {
    const { body } = await post(harness({ data: withSelf(), franceRelease: train(), releaseCard: card() }));
    expect(body.state).toBe('unreadable');
  });
});
