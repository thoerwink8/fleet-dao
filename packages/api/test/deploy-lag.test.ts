// 线上版本跟不跟得上主线（deploy-lag.ts）：每一种「不对」和「没查成」各造一次，读的时候现算；对外的话拿公开页禁用词名单的
// 同一份名单扫；状态文件拿自动发布（deploy/france/auto-release/lib.mjs）真跑一轮造出来的核对，两边字段对得上；
// 报警开一条、说法不变不改、好了解除，自动发布当场报过的不重报。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifications } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  DEPLOY_LAG_LIMITS,
  type DeployLagInput,
  DeployLagState,
  type DeployLagVerdict,
  judgeDeployLag,
  readDeployLagInput,
  watchOnce,
} from '@fleet-dao/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployLagCheck } from '../src/deploy-lag-check.ts';

// 别的包、仓里 deploy/ 下的文件：路径放变量里动态取（写成字面量 tsc 会把它们拉进本包的工程里查）
const SCAN = '../../web/src/build/scan.ts';
const AUTO_RELEASE_LIB = '../../../deploy/france/auto-release/lib.mjs';
const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const H2 = 'c'.repeat(40);
const NOW = new Date('2026-09-27T10:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

type State = DeployLagState;
/**
 * 一份刚跑完的状态：主线头 H2（10 分钟前合进来）、前面 H1（100 分钟前）、H0（5 小时前）。在用 H1 = 落后 1 个、最老的没上线的
 * 等了 10 分钟；在用 H0 = 落后 2 个、最老的没上线的（H1）等了 100 分钟。在用的由各条自己给。
 */
function state(over: Partial<State> = {}): State {
  return {
    schema: 1,
    ranAt: ago(2 * MIN),
    main: {
      checkedAt: ago(2 * MIN),
      head: H2,
      headAt: ago(10 * MIN),
      commits: [
        [H2, ago(10 * MIN)],
        [H1, ago(100 * MIN)],
        [H0, ago(300 * MIN)],
      ],
    },
    mainError: null,
    ci: { sha: H2, verdict: 'green', detail: 'CI 全绿', checkedAt: ago(2 * MIN) },
    hold: null,
    waitingSince: null,
    attempt: null,
    rules: { commit: H2, at: ago(2 * MIN), result: 'ok', detail: '' },
    system: { appliedSha: H0, behind: 0, oldestAt: null },
    last: { action: 'up-to-date', detail: '', at: ago(2 * MIN) },
    ...over,
  };
}
/** 同一份主线读数，只换「什么时候读到的」。 */
const mainAt = (checkedAt: string) => ({ ...(state().main as NonNullable<State['main']>), checkedAt });
const input = (
  current: string | null,
  st: State | { error: string } = state(),
  onMain: boolean | null = null,
) => ({ current: { sha: current }, currentOnMain: onMain, state: st }) satisfies DeployLagInput;
const codes = (v: DeployLagVerdict) => v.problems.map((p) => p.code);
const judge = (i: DeployLagInput) => judgeDeployLag(i, NOW);

describe('判定：读的时候现算', () => {
  it('跟上了：绿', () => {
    expect(judge(input(H2))).toEqual({ ok: true, problems: [] });
  });

  it('落后但在正常的等（等 CI、等空闲，最老的没上线的提交还没等满 90 分钟）：绿', () => {
    expect(judge(input(H1, state({ last: { action: 'wait-idle', detail: '', at: ago(MIN) } }))).ok).toBe(
      true,
    );
  });

  it('落后超过 90 分钟：红，写明落后几个、多久（从最老的没上线的提交合进来算）、卡在哪', () => {
    const st = state({ last: { action: 'wait-idle', detail: '17', at: ago(MIN) } });
    const v = judge(input(H0, st));
    expect(codes(v)).toEqual(['behind']);
    expect(v.problems[0]?.message).toBe('落后主线 2 个提交、1 小时 40 分钟（在等引擎空闲）');
    expect(v.problems[0]?.steady).toBe('落后主线太久（在等引擎空闲）');
  });

  it('最近一次自动发布没成：马上红，标「自动发布那边报过了」', () => {
    const st = state({
      attempt: {
        sha: H2,
        startedAt: ago(20 * MIN),
        endedAt: ago(15 * MIN),
        result: 'failed',
        detail: '迁移失败',
      },
      last: { action: 'failed-before', detail: '', at: ago(MIN) },
    });
    const v = judge(input(H1, st));
    expect(codes(v)).toEqual(['failed']);
    expect(v.problems[0]?.alreadyAlerted).toBe(true);
    expect(v.problems[0]?.detail).toContain('迁移失败');
  });

  it('没成的是往回找到的那个（主线头的 CI 没跑完，发的是更早的全绿提交）：照样马上红；比在用的旧的没成不算', () => {
    const failedAt = (sha: string) =>
      state({
        attempt: {
          sha,
          startedAt: ago(20 * MIN),
          endedAt: ago(15 * MIN),
          result: 'failed',
          detail: '迁移失败',
        },
        last: { action: 'ci-pending', detail: '', at: ago(MIN) },
      });
    // 在用 H0，发 H1（不是主线头 H2）没成
    const v = judge(input(H0, failedAt(H1)));
    expect(codes(v)).toEqual(['failed']);
    expect(v.problems[0]?.detail).toContain('迁移失败');
    // 在用 H1，没成的 H0 比它旧：不是现在的事，照落后多久判（才落后 10 分钟，绿）
    expect(judge(input(H1, failedAt(H0))).ok).toBe(true);
  });

  it('部署检出跟不上：马上红；CI 红、CI 结论读不到：落后满 30 分钟红', () => {
    expect(
      codes(judge(input(H1, state({ last: { action: 'checkout-blocked', detail: 'x', at: ago(MIN) } })))),
    ).toEqual(['checkout']);
    for (const action of ['ci-red', 'ci-unknown']) {
      const last = { action, detail: '', at: ago(MIN) };
      expect(judge(input(H1, state({ last }))).ok, `${action}：才落后 10 分钟`).toBe(true);
      const v = judge(input(H0, state({ last })));
      expect(codes(v), action).toEqual(['ci']);
      expect(v.problems[0]?.message).toMatch(action === 'ci-red' ? /没通过/ : /读不到/);
    }
  });

  it('人手动按住（退回、合并前验）：从按住那一刻起算，给人留出修的时间', () => {
    const hold = { since: ago(10 * MIN), sha: H0, event: 'rollback', unmerged: false };
    expect(judge(input(H0, state({ hold, last: { action: 'hold', detail: '', at: ago(MIN) } }))).ok).toBe(
      true,
    );
    const long = { ...hold, since: ago(100 * MIN) };
    const v = judge(input(H0, state({ hold: long, last: { action: 'hold', detail: '', at: ago(MIN) } })));
    expect(codes(v)).toEqual(['behind']);
    expect(v.problems[0]?.message).toContain('人手动切过版本');
  });

  it('在用的不在主线最近的提交里：没合进主线的（按住不久绿、久了红）、在主线上但落后太多、认不出', () => {
    const pr = 'd'.repeat(40);
    const hold = { since: ago(30 * MIN), sha: pr, event: 'release', unmerged: true };
    expect(judge(input(pr, state({ hold }), false)).ok).toBe(true);
    expect(codes(judge(input(pr, state({ hold: { ...hold, since: ago(120 * MIN) } }), false)))).toEqual([
      'unmerged',
    ]);
    expect(codes(judge(input(pr, state(), false)))).toEqual(['unmerged']);
    expect(codes(judge(input(pr, state(), true)))).toEqual(['far']);
    expect(codes(judge(input(pr, state(), null)))).toEqual(['unchecked']);
  });

  it('没查成的每一种：状态读不到、自动发布没报到、主线头读不到或没读到过、在用的读不到', () => {
    expect(codes(judge(input(H2, { error: '还没有状态文件' })))).toEqual(['unchecked']);
    const stale = judge(input(H2, state({ ranAt: ago(25 * MIN), main: mainAt(ago(25 * MIN)) })));
    expect(codes(stale)).toEqual(['stale']);
    expect(stale.problems[0]?.message).toBe('没查成：自动发布 25 分钟没报到');
    const blind = judge(input(H2, state({ main: mainAt(ago(30 * MIN)), mainError: 'git fetch 失败' })));
    expect(codes(blind)).toEqual(['unchecked']);
    expect(blind.problems[0]?.detail).toBe('git fetch 失败');
    expect(codes(judge(input(H2, state({ main: null }))))).toEqual(['unchecked']);
    expect(
      codes(judgeDeployLag({ current: { error: 'EACCES' }, currentOnMain: null, state: state() }, NOW)),
    ).toEqual(['unchecked']);
    expect(codes(judge(input(null)))).toEqual(['behind']);
  });

  it('读数旧了（没报到、主线头读不到）：不拿旧读数数落后几个', () => {
    const v = judge(input(H0, state({ ranAt: ago(3 * 60 * MIN), main: mainAt(ago(3 * 60 * MIN)) })));
    expect(codes(v)).toEqual(['stale']);
  });

  it('版本标记读不到（决定 0011 第 3 条）：标出来、写明「没有标记就不发」，自动发布那边报过了不重报', () => {
    const stuck = state({
      marker: null,
      markerError: { kind: 'none', why: '一个 v<N> 版本标记都没有', at: ago(MIN) },
      last: { action: 'marker-none', detail: '', at: ago(MIN) },
    });
    const v = judge(input(H0, stuck));
    expect(codes(v)).toEqual(['marker']);
    expect(v.problems[0]?.alreadyAlerted).toBe(true);
    expect(v.problems[0]?.steady).toBe('版本标记读不到（没有标记就不发）');
    expect(v.problems[0]?.detail).toContain('一个 v<N> 版本标记都没有');
    // 不是祖先的那一种：对外说清是「不是主线上的提交」
    const notAncestor = state({
      marker: null,
      markerError: { kind: 'not-ancestor', why: 'v2 指向的提交不是 origin/main 的祖先', at: ago(MIN) },
      last: { action: 'marker-not-ancestor', detail: '', at: ago(MIN) },
    });
    expect(judge(input(H0, notAncestor)).problems[0]?.message).toContain('不是主线上的提交');
    // 标记正常（这一轮只是在等 CI）：不报这一条
    expect(
      codes(
        judge(input(H0, state({ marker: { tag: 'v1', commit: H2, at: ago(MIN), checkedAt: ago(MIN) } }))),
      ),
    ).toEqual([]);
  });

  describe('按版本发（决定 0011 第 3 条）：线上该跟的是版本标记，不是主线头', () => {
    const marker = (commit: string, taggedAgo: number) => ({
      tag: 'v3',
      commit,
      at: ago(taggedAgo),
      taggedAt: ago(taggedAgo),
      checkedAt: ago(2 * MIN),
    });

    it('主线往前走了、标记没动，在用的就是标记那一版：绿（合进主线的提交在下一版之前本来就不上线）', () => {
      // 主线头 H2 是 10 分钟前合的，标记还指着 5 小时前的 H0；在用 H0。按老办法数这是「落后 2 个、100 分钟」，会一直红
      expect(judge(input(H0, state({ marker: marker(H0, 300 * MIN) }))).ok).toBe(true);
    });

    it('在用的比标记还新（人手动发过更新的）：绿，不当落后', () => {
      expect(judge(input(H1, state({ marker: marker(H0, 300 * MIN) }))).ok).toBe(true);
    });

    it('在用的比标记老：从标记打上那一刻起算，满 90 分钟才红；说法是「落后最新版本」，不拿主线头数', () => {
      // 标记指着 H1（主线头 H2 之前的一个），在用 H0：差 1 个提交
      expect(judge(input(H0, state({ marker: marker(H1, 30 * MIN) }))).ok).toBe(true);
      const v = judge(input(H0, state({ marker: marker(H1, 100 * MIN) })));
      expect(codes(v)).toEqual(['behind']);
      expect(v.problems[0]?.message).toBe('落后最新版本 1 个提交、1 小时 40 分钟');
      expect(v.problems[0]?.steady).toBe('落后最新版本太久');
      expect(v.problems[0]?.message).not.toContain('主线');
    });

    it('【故意造出的失败】标记没查成（null）：不拿主线头充数去数落后——只报标记那一条', () => {
      // 在用 H0 比主线头老 300 分钟：按老办法会多出一条 behind；按版本发，标记没查成时线上就该停着，不是落后
      const v = judge(
        input(
          H0,
          state({
            marker: null,
            markerError: { kind: 'none', why: '一个 v<N> 版本标记都没有', at: ago(MIN) },
            last: { action: 'marker-none', detail: '', at: ago(MIN) },
          }),
        ),
      );
      expect(codes(v)).toEqual(['marker']);
    });

    it('状态里没有 marker 这个字段（老版本自动发布写的）：照老办法按主线头数', () => {
      const old = state();
      expect('marker' in old).toBe(false);
      expect(codes(judge(input(H0, old)))).toEqual(['behind']);
    });
  });

  it('一轮里在发：按发布本身的时限（60 分钟）算，不当成没报到；超了报「跑了太久」', () => {
    const running = (m: number) =>
      state({ ranAt: ago(m * MIN), attempt: { sha: H2, startedAt: ago(m * MIN), result: 'running' } });
    expect(judge(input(H2, running(30))).ok).toBe(true);
    expect(codes(judge(input(H2, running(70))))).toEqual(['stuck']);
  });

  it('规矩同步没成（自动发布那边报过了）、规矩同步到哪没读到：红', () => {
    const failed = judge(
      input(H2, state({ rules: { commit: H2, at: ago(MIN), result: 'failed', detail: 'pilot 写不进去' } })),
    );
    expect(codes(failed)).toEqual(['rules_failed']);
    expect(failed.problems[0]?.alreadyAlerted).toBe(true);
    expect(
      codes(judge(input(H2, state({ rules: { at: ago(MIN), result: 'unchecked', detail: 'x' } })))),
    ).toEqual(['rules']);
  });

  it('装机自动档：没装成红（自动发布报过了，30 分钟后自己再试）；装成了、老状态没有这个字段：绿', () => {
    const failed = judge(
      input(
        H2,
        state({ tier: { commit: H2, at: ago(MIN), result: 'failed', detail: '退出码 1，✗ timer 没在跑' } }),
      ),
    );
    expect(codes(failed)).toEqual(['tier_failed']);
    expect(failed.problems[0]?.alreadyAlerted).toBe(true);
    expect(judge(input(H2, state({ tier: { commit: H2, at: ago(MIN), result: 'ok', detail: '' } }))).ok).toBe(
      true,
    );
    expect(judge(input(H2, state())).ok).toBe(true);
  });

  it('装机脚本：装到哪没读到马上红；落后主线满 24 小时才红（要人跑，不自动）', () => {
    expect(codes(judge(input(H2, state({ system: { error: 'france.sh 装到哪个提交没记' } }))))).toEqual([
      'system',
    ]);
    expect(
      judge(input(H2, state({ system: { appliedSha: H0, behind: 2, oldestAt: ago(2 * 60 * MIN) } }))).ok,
    ).toBe(true);
    const v = judge(
      input(H2, state({ system: { appliedSha: H0, behind: 2, oldestAt: ago(30 * 60 * MIN) } })),
    );
    expect(codes(v)).toEqual(['system']);
    expect(v.problems[0]?.message).toBe('装机脚本落后主线 2 个相关提交、30 小时，要人重跑');
  });

  it('对外的话：不带提交号、路径；和公开页禁用词名单扫', async () => {
    const scan = (await import(/* @vite-ignore */ SCAN)) as {
      BUILTIN_TERMS: readonly string[];
      scanText(file: string, text: string, terms: readonly string[]): { term: string }[];
    };
    expect(scan.BUILTIN_TERMS.length).toBeGreaterThan(0);
    const pr = 'd'.repeat(40);
    const cases: DeployLagInput[] = [
      input(H2, { error: '/srv/fleet-dao-releases/.auto/state.json 读不到' }),
      input(H2, state({ ranAt: ago(25 * MIN) })),
      input(
        H2,
        state({ attempt: { sha: H2, startedAt: ago(70 * MIN), result: 'running' }, ranAt: ago(70 * MIN) }),
      ),
      input(H2, state({ main: null, mainError: 'fatal: unable to access https://github.com/x/y' })),
      input(H2, state({ main: mainAt(ago(30 * MIN)) })),
      { current: { error: 'EACCES /srv/fleet-dao-releases/current' }, currentOnMain: null, state: state() },
      input(null),
      input(pr, state(), false),
      input(pr, state(), true),
      input(pr, state(), null),
      input(
        H1,
        state({ attempt: { sha: H2, startedAt: ago(9 * MIN), result: 'failed', log: '/srv/x.log' } }),
      ),
      input(
        H1,
        state({ last: { action: 'checkout-blocked', detail: '/srv/fleet-dao 有改动', at: ago(MIN) } }),
      ),
      input(H0, state({ last: { action: 'ci-red', detail: '', at: ago(MIN) } })),
      input(H0, state({ last: { action: 'ci-unknown', detail: '', at: ago(MIN) } })),
      input(H0, state({ last: { action: 'hold', detail: '', at: ago(MIN) } })),
      input(
        H2,
        state({ rules: { commit: H2, at: ago(MIN), result: 'failed', detail: 'fleet-agent-carpool' } }),
      ),
      input(H2, state({ rules: { at: ago(MIN), result: 'unchecked', detail: 'x' } })),
      input(H2, state({ system: { error: '/srv/fleet-dao-releases/.auto/france-applied' } })),
      input(H2, state({ system: { appliedSha: H0, behind: 3, oldestAt: ago(30 * 60 * MIN) } })),
    ];
    const seen = new Set<string>();
    for (const c of cases) {
      const v = judge(c);
      expect(v.ok).toBe(false);
      for (const p of v.problems) {
        seen.add(p.code);
        const text = `${p.message}\n${p.steady}`;
        expect(text, p.code).not.toMatch(/[0-9a-f]{7,40}|\/srv|\/etc/);
        expect(scan.scanText(p.code, text, scan.BUILTIN_TERMS), p.code).toEqual([]);
      }
    }
    // 每一种代码都造到了：新加一种要补进上面
    expect([...seen].sort()).toEqual(
      [
        'behind',
        'checkout',
        'ci',
        'failed',
        'far',
        'rules',
        'rules_failed',
        'stale',
        'stuck',
        'system',
        'unchecked',
        'unmerged',
      ].sort(),
    );
  });

  it('健康检查：不对就抛，对外一句（几件不对都列出来），细节只给日志', async () => {
    const check = deployLagCheck(
      () =>
        input(H2, state({ rules: { at: ago(MIN), result: 'unchecked', detail: '内部细节 /srv/fleet-dao' } })),
      () => NOW,
    );
    await expect(check()).rejects.toMatchObject({
      name: 'PublicHealthError',
      code: 'rules',
      message: '没查成：规矩同步到哪没读到',
      detail: '内部细节 /srv/fleet-dao',
    });
    await expect(
      deployLagCheck(
        () => input(H2),
        () => NOW,
      )(),
    ).resolves.toBeUndefined();
  });

  it('阈值：落后报警晚于「等空闲的上限 + 一轮」，装机层按天算', () => {
    expect(DEPLOY_LAG_LIMITS.behindMs).toBeGreaterThan(60 * MIN + 5 * MIN);
    expect(DEPLOY_LAG_LIMITS.systemMs).toBe(24 * 60 * MIN);
  });
});

describe('状态文件：和自动发布写的对得上', () => {
  it(
    '自动发布真跑几轮（发了、等空闲、发布没成、规矩没成）写出来的状态，这边都认得，判得出来',
    async () => {
      const lib = (await import(/* @vite-ignore */ AUTO_RELEASE_LIB)) as {
        runOnce(io: unknown, prev: unknown): Promise<unknown>;
        STATE_SCHEMA: number;
        EXIT_SESSIONS_BUSY: number;
      };
      const t = { now: Date.parse('2026-09-27T08:00:00Z'), current: H0 as string, release: 0 };
      // 版本标记（决定 0011 第 3 条）：这一段拿真跑出来的状态核对字段，所以标记也得给——不然连不上发。
      // git for-each-ref 的真样子：轻量 tag 的第三段是空的，名字和时间之间两个空格（lib.mjs 的 parseVersionTags 只认这个样子）
      const tags = (sha: string, tag = 'v1') => `${tag} ${sha}  2026-09-27T07:31:00Z\n`;
      const io = {
        now: () => new Date(t.now),
        readMain: async () => `${H1} 2026-09-27T07:30:00Z\n${H0} 2026-09-27T06:00:00Z`,
        readVersionTags: async () => tags(H1),
        isAncestorOfMain: async (c: string) => c === H1 || c === H0,
        engineOn: async () => false, // 法国现在 FLEET_SERVICES=fleet-api：引擎关着
        readSystem: async () => ({ applied: H0, log: '' }),
        readCurrent: async () => t.current,
        readHistory: async () => '',
        ciRuns: async () => ({
          status: 200,
          body: JSON.stringify({
            workflow_runs: [
              {
                head_sha: H1,
                event: 'push',
                head_branch: 'main',
                path: '.github/workflows/ci.yml@main',
                status: 'completed',
                conclusion: 'success',
                run_number: 1,
              },
            ],
          }),
        }),
        releaseBusy: async () => false,
        prepareCheckout: async () => ({ ok: true }),
        runRelease: async (sha: string) => {
          if (t.release === 0) t.current = sha;
          return { code: t.release, log: '/srv/x.log', detail: t.release ? '健康检查没过' : '' };
        },
        checkoutHead: async () => t.current,
        syncRules: async () => ({ code: 1, out: '  ✗ 写不进去' }),
        alert: async () => {},
        resolve: async () => {},
        save: async () => {},
      };
      expect(lib.STATE_SCHEMA).toBe(1);
      // 在跑的引擎不会排空、有会话在跑：发布脚本退出 76，这一轮等空闲
      t.release = lib.EXIT_SESSIONS_BUSY;
      const waiting = await lib.runOnce(io, null);
      t.release = 1;
      t.now += 5 * MIN;
      const failed = await lib.runOnce(io, waiting);
      t.release = 0;
      const roundTrip = (s: unknown) => DeployLagState.parse(JSON.parse(JSON.stringify(s)));
      const w = roundTrip(waiting);
      expect(w.last?.action).toBe('wait-idle');
      expect(w.marker?.tag).toBe('v1');
      expect(w.marker?.commit).toBe(H1);
      const f = roundTrip(failed);
      expect(f.attempt?.result).toBe('failed');
      // 第一轮在等空闲时，在用的 H0 和检出对得上，规矩同步了一次（没成）
      expect(codes(judgeDeployLag(input(H0, f), new Date(t.now)))).toEqual(['failed', 'rules_failed']);
      // 发成了、规矩没成
      const other = { ...io, readMain: async () => `${H2} 2026-09-27T08:02:00Z\n${H1} 2026-09-27T07:30:00Z` };
      other.readVersionTags = async () => tags(H2, 'v2');
      other.isAncestorOfMain = async (c: string) => c === H2 || c === H1 || c === H0;
      other.ciRuns = async () => ({
        status: 200,
        body: JSON.stringify({
          workflow_runs: [
            {
              head_sha: H2,
              event: 'push',
              head_branch: 'main',
              path: '.github/workflows/ci.yml',
              status: 'completed',
              conclusion: 'success',
              run_number: 2,
            },
          ],
        }),
      });
      t.now += 5 * MIN;
      const done = roundTrip(await lib.runOnce(other, failed));
      expect(done.attempt?.result).toBe('ok');
      expect(done.rules?.result).toBe('failed');
      expect(codes(judgeDeployLag(input(H2, done), new Date(t.now)))).toEqual(['rules_failed']);
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('读法国上的现状', () => {
  // current 是符号链接：Windows 上建不了（要管理员），那里跳过；CI 在 Linux 上跑这一段
  const canLink = process.platform !== 'win32';
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-lag-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('状态文件没有、不是 JSON、字段不对：照实带上原因，不当成没落后', () => {
    const d = join(dir, 'empty');
    mkdirSync(join(d, '.auto'), { recursive: true });
    let got = readDeployLagInput(d);
    expect(got.current).toEqual({ sha: null });
    expect(got.state).toEqual({ error: expect.stringContaining('还没有状态文件') });
    writeFileSync(join(d, '.auto', 'state.json'), '{不是 JSON');
    got = readDeployLagInput(d);
    expect(got.state).toEqual({ error: expect.stringContaining('读不出来') });
    writeFileSync(join(d, '.auto', 'state.json'), JSON.stringify({ ...state(), schema: 2 }));
    got = readDeployLagInput(d);
    expect(got.state).toEqual({ error: expect.stringContaining('认不出') });
    expect(codes(judge(got))).toContain('unchecked');
  });

  it.runIf(canLink)('current 指着谁、在用的不在主线最近的提交里时读它的完成标记', () => {
    const d = join(dir, 'real');
    const pr = 'd'.repeat(40);
    mkdirSync(join(d, '.auto'), { recursive: true });
    mkdirSync(join(d, pr));
    writeFileSync(join(d, pr, '.fleet-release'), `commit=${pr}\non_main=0\n`);
    writeFileSync(join(d, '.auto', 'state.json'), JSON.stringify(state()));
    symlinkSync(pr, join(d, 'current'));
    const got = readDeployLagInput(d);
    expect(got.current).toEqual({ sha: pr });
    expect(got.currentOnMain).toBe(false);
    rmSync(join(d, 'current'));
    symlinkSync('not-a-sha', join(d, 'current'));
    expect(readDeployLagInput(d).current).toEqual({ error: expect.stringContaining('认不出') });
  });
});

describe('「跟不上主线」报警', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());

  const open = async () => (await t.db.select().from(notifications)).filter((n) => n.resolvedAt === null);

  it('不对就开一条；说法没变不改（不每轮改卡片）；变了原地改；自动发布报过的不重报；好了解除', async () => {
    let now = NOW;
    let current: DeployLagInput = input(H2, state({ ranAt: ago(25 * MIN) }));
    const deps = { db: t.db as never, read: () => current, now: () => now };
    await watchOnce(deps);
    let rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('线上版本跟不上主线：自动发布没报到（定时器停了、没装或跑崩了）');
    expect(rows[0]?.level).toBe('alert');
    const first = rows[0];
    // 过了 5 分钟、还是没报到（时长变了，说法没变）：不改
    now = new Date(NOW.getTime() + 5 * MIN);
    await watchOnce(deps);
    rows = await open();
    expect(rows[0]?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
    // 换了一件事：原地改同一条
    current = input(H2, state({ system: { error: '没记' } }));
    await watchOnce(deps);
    rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(first?.dedupeKey);
    expect(rows[0]?.title).toContain('装机脚本装到哪没读到');
    // 只剩自动发布那边报过的（发布没成）：这边解除自己的
    current = input(H1, state({ attempt: { sha: H2, startedAt: ago(9 * MIN), result: 'failed' } }));
    await watchOnce(deps);
    expect(await open()).toEqual([]);
    // 好了再坏：新开一条（新的一件事发新卡）
    current = input(H2, state({ ranAt: ago(40 * MIN) }));
    await watchOnce(deps);
    rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).not.toBe(first?.dedupeKey);
    current = input(H2);
    await watchOnce(deps);
    expect(await open()).toEqual([]);
  });
});
