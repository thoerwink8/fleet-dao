// /api/release/version（#725）：/changelog 页「这一版」的版本号。已发布的号来自仓根 CHANGELOG.md 的 ## [vN] - 日期
// （splitChangelog 的 released；发布收尾打的 git tag 不在这条接口里读）。这一版的候选是开着的 v<N> 里程碑里 N 最小的那张。
// 同一个号不能既在 released 里、又当这一版：有发布标记就判成已发布，这一版取下一个还没有标记的号。
// 故意造出的失败：读不到里程碑、一张版本里程碑都没开、CHANGELOG.md 读不了或认不出、已经发到比候选还新、
// 受管的仓里没有 fleet-dao、没接上、读超时——都照实回 unreadable / blocked 带原因，不回 v1、不回 0。
import { ReleaseVersionResponse, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type ReleaseSource, readReleaseVersion } from '../src/release-version.ts';
import { type Harness, harness, T0 } from './harness.ts';

const PATH = WEB_API_PREFIX + WebRoutes.releaseVersion.path;

/** 受管的仓里的 fleet-dao 自己（样例数据里只有 example/canary）。 */
const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};

const V3 = { number: 31, title: 'v3 三段一条龙' };
const V4 = { number: 32, title: 'v4 驾驶舱' };
/** 不是版本的里程碑（老的阶段里程碑）：不算当前版本，也不列进「还开着的别的版本」。 */
const P1 = { number: 7, title: 'P1 核心闭环' };

/** 一版没发过的 CHANGELOG.md（仓里现在就是这样）。 */
const NEVER_RELEASED = '# Changelog\n\n## [Unreleased]\n\n- 加了发布按钮\n';

function withSelf(): Partial<MemoryData> {
  const data = devFixtures(T0);
  return { ...data, repos: [...(data.repos ?? []), SELF] };
}

/** 读里程碑和 CHANGELOG.md 的替身：记下去哪个仓读了。 */
function source(
  over: Partial<ReleaseSource> = {},
): ReleaseSource & { reads: { owner: string; name: string }[] } {
  const reads: { owner: string; name: string }[] = [];
  return {
    reads,
    async openMilestones(repo) {
      reads.push(repo);
      return [V3];
    },
    async changelog() {
      return NEVER_RELEASED;
    },
    ...over,
  };
}

async function read(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request(PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ReleaseVersionResponse.parse(await res.json());
}

describe('/api/release/version：定得出', () => {
  it('当前版本里程碑是 v3、更新日志一版没发过：是 v3，不是按「上一版 +1」的 v1', async () => {
    const src = source();
    const body = await read(harness({ data: withSelf(), release: src }));
    expect(body).toEqual({ state: 'ok', version: 'v3', milestone: V3, others: [], asOf: T0.toISOString() });
    expect(src.reads).toEqual([{ owner: 'thoerwink8', name: 'fleet-dao' }]);
  });

  it('开着几张版本里程碑：取 N 最小的那张，别的列出来（和发布 PR 正文一致）；不是版本的里程碑不算', async () => {
    const body = await read(
      harness({ data: withSelf(), release: source({ openMilestones: async () => [V4, P1, V3] }) }),
    );
    expect(body).toMatchObject({ state: 'ok', version: 'v3', milestone: V3, others: [V4] });
  });

  it('同一版本既有发布标记又被当成这一版：判成已发布，这一版取下一个号', async () => {
    // 开着的只有 v3，CHANGELOG 里已经有 ## [v3]。不能回 v3，也不能整段 blocked 把「这一版」空着。
    const changelog = `${NEVER_RELEASED}\n## [v3] - 2026-10-05\n\n- 第一版\n`;
    const body = await read(
      harness({ data: withSelf(), release: source({ changelog: async () => changelog }) }),
    );
    expect(body.state).toBe('ok');
    if (body.state !== 'ok') throw new Error('不该定不出');
    expect(body.version).not.toBe('v3');
    expect(body.version).toBe('v4');
    expect(body.milestone).toEqual({ number: 4, title: 'v4' });
    expect(body.others).toEqual([]);
  });

  it('v3 已有发布标记、v4 也开着：这一版用 v4 那张，已发布的 v3 不再列进还开着的', async () => {
    const changelog = `${NEVER_RELEASED}\n## [v3] - 2026-10-05\n\n- 第一版\n`;
    const body = await read(
      harness({
        data: withSelf(),
        release: source({
          changelog: async () => changelog,
          openMilestones: async () => [V4, P1, V3],
        }),
      }),
    );
    expect(body).toMatchObject({ state: 'ok', version: 'v4', milestone: V4, others: [] });
  });

  it('下一个号也有发布标记：继续往后，直到这一版不再是已发布', async () => {
    const changelog = `${NEVER_RELEASED}\n## [v4] - 2026-10-06\n\n- 四\n\n## [v3] - 2026-10-05\n\n- 三\n`;
    const body = await read(
      harness({ data: withSelf(), release: source({ changelog: async () => changelog }) }),
    );
    expect(body.state).toBe('ok');
    if (body.state !== 'ok') throw new Error('不该定不出');
    expect(body.version).toBe('v5');
    expect(body.milestone).toEqual({ number: 5, title: 'v5' });
  });

  it('更早的号发过、当前里程碑自己没有标记：这一版仍是它，不按已发布的最大号 +1', async () => {
    const changelog = `${NEVER_RELEASED}\n## [v1] - 2026-09-01\n\n- 旧的\n`;
    const body = await read(
      harness({ data: withSelf(), release: source({ changelog: async () => changelog }) }),
    );
    expect(body).toMatchObject({ state: 'ok', version: 'v3', milestone: V3, others: [] });
  });
});

describe('/api/release/version：故意造出的失败照实说', () => {
  it('读不到里程碑：unreadable，写明哪个仓、为什么，不给版本号', async () => {
    const h = harness({
      data: withSelf(),
      release: source({
        openMilestones: async () => {
          throw new Error('连不上 GitHub（ECONNRESET）');
        },
      }),
    });
    const body = await read(h);
    expect(body.state).toBe('unreadable');
    expect(body).not.toHaveProperty('version');
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('thoerwink8/fleet-dao');
    expect(body.why).toContain('连不上 GitHub（ECONNRESET）');
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('里程碑'))).toBe(true);
  });

  it('一张开着的里程碑都没有：blocked，带判法原话（这时跑 publish:pr 一样被拒），不猜 v1', async () => {
    const body = await read(
      harness({ data: withSelf(), release: source({ openMilestones: async () => [] }) }),
    );
    expect(body.state).toBe('blocked');
    if (body.state !== 'blocked') throw new Error('不该定得出');
    expect(body.why).toMatch(/没有版本里程碑/);
    expect(JSON.stringify(body)).not.toContain('v1');
  });

  it('开着的只有不是版本的里程碑：一样算一张版本里程碑都没有', async () => {
    const body = await read(
      harness({ data: withSelf(), release: source({ openMilestones: async () => [P1] }) }),
    );
    expect(body.state).toBe('blocked');
  });

  it('CHANGELOG 已经发到比开着的里程碑还新、而这一版自己没有标记：blocked，不改口叫成下一个号', async () => {
    const changelog = `${NEVER_RELEASED}\n## [v5] - 2026-10-01\n\n- 更后的一版\n`;
    const body = await read(
      harness({ data: withSelf(), release: source({ changelog: async () => changelog }) }),
    );
    expect(body.state).toBe('blocked');
    if (body.state !== 'blocked') throw new Error('不该定得出');
    expect(body.why).toContain('已经发到 v5');
    expect('version' in body).toBe(false);
  });

  it('CHANGELOG.md 读不了：unreadable', async () => {
    const body = await read(
      harness({
        data: withSelf(),
        release: source({
          changelog: async () => {
            throw new Error('ENOENT: no such file');
          },
        }),
      }),
    );
    expect(body).toMatchObject({ state: 'unreadable' });
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('CHANGELOG.md');
    expect(body.why).toContain('ENOENT');
  });

  it('CHANGELOG.md 认不出模样（缺 Unreleased 标题）：unreadable，不当成「一版没发过」', async () => {
    const body = await read(
      harness({ data: withSelf(), release: source({ changelog: async () => '# Changelog\n\n## 乱写的\n' }) }),
    );
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('缺 ## [Unreleased]');
  });

  it('这台后端没接上（开发环境、内存版）：unreadable 写明没接上', async () => {
    const body = await read(harness({ data: withSelf() }));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('没接上');
  });

  it('受管的仓里没有 fleet-dao：unreadable，也不去别的仓读', async () => {
    const src = source();
    const body = await read(harness({ release: src }));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('受管的仓里没有 fleet-dao');
    expect(src.reads).toEqual([]);
  });

  it('里程碑读不完（实现连 signal 都不认）：到时限按读不到报，写明几秒', async () => {
    const h = harness({ data: withSelf() });
    const hang = source({ openMilestones: () => new Promise(() => {}) });
    const body = await readReleaseVersion({
      source: hang,
      store: h.store,
      log: h.deps.log,
      now: h.deps.now,
      timeoutMs: 20,
    });
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('不该定得出');
    expect(body.why).toContain('0.02 秒没读完');
  });

  it('没登录：401，不替陌生人去读 GitHub', async () => {
    const src = source();
    const h = harness({ data: withSelf(), release: src });
    const res = await h.cockpit.request(PATH);
    expect(res.status).toBe(401);
    expect(src.reads).toEqual([]);
  });
});
