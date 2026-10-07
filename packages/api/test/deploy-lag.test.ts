// 线上读数跟不跟得上（deploy-lag.ts）：每一种「不对」和「没查成」各造一次，读的时候现算；落后主线几个提交不算毛病（发布只走驾驶舱按钮，0032）；
// 对外的话拿演示版打包扫描的同一份名单扫；状态文件拿自动发布单元（deploy/france/auto-release/lib.mjs）真跑一轮造出来的核对，两边字段对得上；
// 报警开一条、说法不变不改、好了解除，自动发布单元当场报过的不重报。
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
 * 一份刚跑完的状态：主线头 H2（10 分钟前合进来）、前面 H1（100 分钟前）、H0（5 小时前）。在用 H1 = 落后 1 个；在用 H0 = 落后 2 个。
 * 在用的由各条自己给。
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
    rules: { commit: H2, at: ago(2 * MIN), result: 'ok', detail: '' },
    system: { appliedSha: H0, behind: 0, oldestAt: null },
    last: { action: 'up-to-date', detail: '', at: ago(2 * MIN) },
    ...over,
  };
}
/** 同一份主线读数，只换「什么时候读到的」。 */
const mainAt = (checkedAt: string) => ({ ...(state().main as NonNullable<State['main']>), checkedAt });
const input = (current: string | null, st: State | { error: string } = state()) =>
  ({ current: { sha: current }, state: st }) satisfies DeployLagInput;
const codes = (v: DeployLagVerdict) => v.problems.map((p) => p.code);
const judge = (i: DeployLagInput) => judgeDeployLag(i, NOW);

describe('判定：读的时候现算', () => {
  it('跟上了：绿', () => {
    expect(judge(input(H2))).toEqual({ ok: true, problems: [] });
  });

  it('【故意造出的失败】落后主线几个提交、落了好几个钟头：照样绿（发布只走驾驶舱按钮，没人去发它，报警只会天天挂着）', () => {
    // 在用 H0：落后 2 个、最早没上线的已经等了 100 分钟；以前超过 90 分钟就红
    expect(judge(input(H0)).ok).toBe(true);
    // 在用的不在主线最近的提交里（没合进主线的、落后太多的）也不是毛病
    expect(judge(input('d'.repeat(40))).ok).toBe(true);
    // 主线头的 CI 红、这一轮卡在什么上：以前的「CI 红」「部署检出」「在发」那些，状态里已经没有这些字段，也不报
    expect(
      judge(
        input(
          H0,
          state({ ci: { sha: H2, verdict: 'red', detail: 'CI 结论是 failure', checkedAt: ago(MIN) } }),
        ),
      ).ok,
    ).toBe(true);
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
    expect(codes(judgeDeployLag({ current: { error: 'EACCES' }, state: state() }, NOW))).toEqual([
      'unchecked',
    ]);
    expect(codes(judge(input(null)))).toEqual(['not_released']);
  });

  it('读数旧了（没报到、主线头读不到）：不拿旧读数数落后几个', () => {
    const v = judge(input(H0, state({ ranAt: ago(3 * 60 * MIN), main: mainAt(ago(3 * 60 * MIN)) })));
    expect(codes(v)).toEqual(['stale']);
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

  it('对外的话：不带提交号、路径；和演示版打包扫描同一份名单扫', async () => {
    const scan = (await import(/* @vite-ignore */ SCAN)) as {
      BUILTIN_TERMS: readonly string[];
      scanText(file: string, text: string, terms: readonly string[]): { term: string }[];
    };
    expect(scan.BUILTIN_TERMS.length).toBeGreaterThan(0);
    const cases: DeployLagInput[] = [
      input(H2, { error: '/srv/fleet-dao-releases/.auto/state.json 读不到' }),
      input(H2, state({ ranAt: ago(25 * MIN) })),
      input(H2, state({ main: null, mainError: 'fatal: unable to access https://github.com/x/y' })),
      input(H2, state({ main: mainAt(ago(30 * MIN)) })),
      { current: { error: 'EACCES /srv/fleet-dao-releases/current' }, state: state() },
      input(null),
      input(
        H2,
        state({ tier: { commit: H2, at: ago(MIN), result: 'failed', detail: '退出码 1，✗ /srv/x 没装上' } }),
      ),
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
      ['not_released', 'rules', 'rules_failed', 'stale', 'system', 'tier_failed', 'unchecked'].sort(),
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

  it('阈值：单元和主线头 20 分钟没报到算停了（比 5 分钟一轮宽松），装机层按天算；没有「落后多久报警」这一档', () => {
    expect(DEPLOY_LAG_LIMITS.reportMs).toBe(20 * MIN);
    expect(DEPLOY_LAG_LIMITS.mainMs).toBe(20 * MIN);
    expect(DEPLOY_LAG_LIMITS.systemMs).toBe(24 * 60 * MIN);
    expect('behindMs' in DEPLOY_LAG_LIMITS).toBe(false);
  });
});

describe('状态文件：和自动发布单元写的对得上', () => {
  it(
    '单元真跑几轮（落后、规矩没成、驾驶舱按钮发完规矩成了）写出来的状态，这边都认得，判得出来；仓上没有任何 v<N> 标记',
    async () => {
      const lib = (await import(/* @vite-ignore */ AUTO_RELEASE_LIB)) as {
        runOnce(io: unknown, prev: unknown): Promise<unknown>;
        STATE_SCHEMA: number;
      };
      const t = { now: Date.parse('2026-09-27T08:00:00Z'), current: H0 as string };
      const io = {
        now: () => new Date(t.now),
        readMain: async () => `${H1} 2026-09-27T07:30:00Z
${H0} 2026-09-27T06:00:00Z`,
        readSystem: async () => ({ applied: H0, log: '' }),
        readCurrent: async () => t.current,
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
        checkoutHead: async () => t.current,
        syncRules: async () => ({ code: 1, out: '  ✗ 写不进去' }),
        alert: async () => {},
        resolve: async () => {},
        resolveKey: async () => {},
        save: async () => {},
      };
      expect(lib.STATE_SCHEMA).toBe(1);
      const roundTrip = (s: unknown) => DeployLagState.parse(JSON.parse(JSON.stringify(s)));
      // 在用 H0、主线头 H1（落后 1 个）：规矩同步没成。落后不算毛病，只有规矩那一条
      const first = await lib.runOnce(io, null);
      const f = roundTrip(first);
      expect(f.last?.action).toBe('behind');
      expect(f.main?.head).toBe(H1);
      expect(f.ci?.verdict).toBe('green');
      expect(codes(judgeDeployLag(input(H0, f), new Date(t.now)))).toEqual(['rules_failed']);
      // 驾驶舱按钮发了 H1、规矩这回成了：全绿
      t.current = H1;
      t.now += 5 * MIN;
      const ok = { ...io, syncRules: async () => ({ code: 0, out: '  ✓ 一致' }) };
      const second = roundTrip(await lib.runOnce(ok, first));
      expect(second.last?.action).toBe('up-to-date');
      expect(second.rules?.result).toBe('ok');
      expect(judgeDeployLag(input(H1, second), new Date(t.now))).toEqual({ ok: true, problems: [] });
      // 以前按标记发时写的那几样，新状态里一样都没有
      for (const k of ['marker', 'markerError', 'attempt', 'hold', 'waitingSince'])
        expect(k in (second as object), k).toBe(false);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('老单元写的状态（带 marker、attempt、hold、waitingSince）这边也认得：多出来的字段不管', () => {
    const old = {
      ...state(),
      marker: { tag: 'v3', commit: H1, at: ago(MIN), checkedAt: ago(MIN) },
      markerError: null,
      attempt: { sha: H1, startedAt: ago(20 * MIN), result: 'failed', detail: '迁移失败' },
      hold: null,
      waitingSince: null,
    };
    const parsed = DeployLagState.parse(old);
    // 老状态里的「发布没成」不再让这边报红（发布不归这个单元了）
    expect(judge(input(H0, parsed)).ok).toBe(true);
  });
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

  it.runIf(canLink)(
    'current 指着谁、发布历史里这个提交最近一次切上去的时刻；历史没有、读不出就是 null',
    () => {
      const d = join(dir, 'real');
      const pr = 'd'.repeat(40);
      mkdirSync(join(d, '.auto'), { recursive: true });
      mkdirSync(join(d, pr));
      writeFileSync(join(d, '.auto', 'state.json'), JSON.stringify(state()));
      symlinkSync(pr, join(d, 'current'));
      // 没有 .history：不猜
      let got = readDeployLagInput(d);
      expect(got.current).toEqual({ sha: pr });
      expect(got.deployedAt).toBeNull();
      writeFileSync(
        join(d, '.history'),
        `2026-10-06T03:00:00Z ${pr} release
2026-10-06T03:30:00Z ${pr} unhealthy
2026-10-06T04:00:00Z ${pr} rollback
`,
      );
      got = readDeployLagInput(d);
      expect(got.deployedAt).toBe('2026-10-06T04:00:00Z');
      // 时间认不出：不猜，也不拖垮别的读数
      writeFileSync(
        join(d, '.history'),
        `坏时间 ${pr} release
`,
      );
      got = readDeployLagInput(d);
      expect(got.deployedAt).toBeNull();
      expect(got.state).not.toHaveProperty('error');
      rmSync(join(d, 'current'));
      symlinkSync('not-a-sha', join(d, 'current'));
      expect(readDeployLagInput(d).current).toEqual({ error: expect.stringContaining('认不出') });
    },
  );
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
    // 只剩自动发布单元那边报过的（装机自动档没成）：这边解除自己的
    current = input(H1, state({ tier: { commit: H1, at: ago(9 * MIN), result: 'failed', detail: 'x' } }));
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
