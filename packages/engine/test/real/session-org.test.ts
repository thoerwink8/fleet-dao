// 会话用户此刻挂的组织（real/session-org.ts）：以会话用户跑 reclaude org list，带 * 的那行的类型 team 是拼车、personal 是
// 独享。没跑成、登录失效、封号、一个组织都认不出、没有带 *、带 * 的不止一行、类型认不出，每条都故意造一次：一律 ok: false、
// 写明原因、原因里不带编号和邮箱，不拿拼车顶。还没读完（首跑同步配置）回 pending，读在后台接着跑完。
// 起点（#335）：读成的和起点不一样、引擎没切过号，回 pending、报一次带前后两次读数的变动；回到起点照常，连着 2 分钟都是新的才认。
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserExec } from '../../src/real/exec.ts';
import {
  readSessionOrg,
  SESSION_ORG_TIMEOUT_MS,
  SESSION_ORG_TTL_MS,
  type SessionOrgEvent,
  STALE_READ_WHY,
  sessionOrgReader,
} from '../../src/real/session-org.ts';
import {
  CARPOOL_ORG_ID,
  type OrgListAnswer,
  type OrgListRig,
  orgListRig,
  orgListText,
  SOLO_ORG_ID,
} from './fixtures.ts';

let rig: OrgListRig;
beforeEach(() => {
  rig = orgListRig();
});

const RECLAUDE = ['/home/fleet-agent-carpool/.local/bin/reclaude'];
const deps = () => ({ exec: rig.exec, user: 'fleet-agent-carpool' as const, reclaude: RECLAUDE });
const WHAT = '以会话用户 fleet-agent-carpool 跑 reclaude org list';

/** 答成 out 以后读一次，要读失败；原因会进库、上驾驶舱：不许带组织编号、邮箱。 */
async function why(out: 'carpool' | 'solo' | OrgListAnswer): Promise<string> {
  rig.answer(out);
  const r = await readSessionOrg(deps());
  if (r.ok) throw new Error(`该读失败，却读成了 ${r.org}`);
  for (const bad of [
    String(CARPOOL_ORG_ID),
    String(SOLO_ORG_ID),
    'fleet-test@localhost',
    'someone@example.com',
  ]) {
    expect(r.why).not.toContain(bad);
  }
  expect(r).not.toHaveProperty('pending');
  return r.why;
}

describe('认出来', () => {
  it('带 * 的是 personal → 独享；是 team → 拼车', async () => {
    rig.answer('solo');
    expect(await readSessionOrg(deps())).toEqual({ ok: true, org: 'solo' });
    rig.answer('carpool');
    expect(await readSessionOrg(deps())).toEqual({ ok: true, org: 'carpool' });
  });

  it('前面先打一行 Syncing config…、stderr 里有提示：照样认得', async () => {
    rig.answer({
      stdout: orgListText('solo', { syncing: true }),
      stderr: 'reclaude: tip: run `reclaude setup` once, then `reclaude` works in any terminal.\n',
    });
    expect(await readSessionOrg(deps())).toEqual({ ok: true, org: 'solo' });
  });

  it('以会话用户、从 / 起、跑它家里那份 reclaude 的 org list，限时 150 秒；scope 编号合 fleet-agent-scope 的规矩、每次不一样', async () => {
    await readSessionOrg(deps());
    await readSessionOrg(deps());
    const [first, second] = rig.calls;
    expect(first).toMatchObject({
      user: 'fleet-agent-carpool',
      cwd: '/',
      argv: [...RECLAUDE, 'org', 'list'],
      timeoutMs: SESSION_ORG_TIMEOUT_MS,
    });
    expect(SESSION_ORG_TIMEOUT_MS).toBe(150_000);
    expect(first?.env).toBeUndefined();
    for (const c of rig.calls) expect(c.scopeId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);
    expect(first?.scopeId).not.toBe(second?.scopeId);
  });

  it('退出码 0 却带着 stderr 的话：只看 stdout 里那张表（有带 * 的行就认）', async () => {
    rig.answer({ stdout: orgListText('carpool'), stderr: 'warning: config sync slow' });
    expect(await readSessionOrg(deps())).toEqual({ ok: true, org: 'carpool' });
  });
});

describe('【故意造出的失败】org list 的输出认不出', () => {
  it('哪一行都不带 *：认不出现在挂的是哪个', async () => {
    expect(await why({ stdout: orgListText(null) })).toBe(`${WHAT}：没有带 * 的行，认不出现在挂的是哪个组织`);
  });

  it('带 * 的不止一行：不挑一个', async () => {
    const two = orgListText('solo').replace(`  ${CARPOOL_ORG_ID}\t`, `* ${CARPOOL_ORG_ID}\t`);
    expect(await why({ stdout: two })).toBe(`${WHAT}：带 * 的有 2 行，认不出现在挂的是哪个组织`);
  });

  it('带 * 的那行类型认不出（不是 team、personal，或空着）：不猜', async () => {
    const odd = orgListText('solo').replace('\tpersonal\t', '\tenterprise\t');
    expect(await why({ stdout: odd })).toBe(
      `${WHAT}：现在挂的那个组织类型认不出（只认 team 拼车、personal 独享）`,
    );
    const blank = orgListText('solo').replace('\tpersonal\t', '\t\t');
    expect(await why({ stdout: blank })).toContain('类型认不出');
  });

  it('一个组织都认不出（空的、只有 Syncing config…、格式变了不用制表符）', async () => {
    for (const stdout of ['', 'Syncing config…\n', `* ${SOLO_ORG_ID} <独享组织名> personal\n`]) {
      expect(await why({ stdout })).toBe(`${WHAT}：输出里一个组织都认不出（没有「编号 名字 类型」那样的行）`);
    }
  });
});

describe('【故意造出的失败】org list 没跑成', () => {
  it('登录失效（没登录、设备被撤销、401）：说要重跑 reclaude login', async () => {
    for (const stderr of ['Error: not logged in', 'device_revoked', 'unexpected status 401: unauthorized']) {
      expect(await why({ code: 1, stderr })).toBe(
        `${WHAT}：reclaude 报登录失效，要在法国上以会话用户重跑 reclaude login（docs/ops.md 第五节）`,
      );
    }
  });

  it('封号、组织失效（account_banned、403）', async () => {
    const stderr =
      'sync current account: unexpected status 403: {"error":{"code":"account_banned","message":"当前绑定账号暂不可用"}}';
    expect(await why({ code: 1, stderr })).toBe(`${WHAT}：reclaude 报账号不可用（上游封号或组织失效）`);
  });

  it('别的退出码：带上 stderr 的末尾，编号、邮箱抹掉；stdout 里的组织表一个字都不带', async () => {
    const w = await why({
      code: 2,
      stdout: orgListText('solo'),
      stderr: `org ${SOLO_ORG_ID} of someone@example.com: connection reset`,
    });
    expect(w).toMatch(
      /^以会话用户 fleet-agent-carpool 跑 reclaude org list：退出码 2（org <数> of .*connection reset）$/,
    );
    expect(w).not.toContain('独享组织名');
  });

  it('起不来、超时、被叫停、执行器自己抛：一律没读成，写明是哪种', async () => {
    expect(await why({ code: null, spawnError: 'spawn sudo ENOENT' })).toBe(
      `${WHAT}：没起来（spawn sudo ENOENT）`,
    );
    expect(await why({ code: null, timedOut: true })).toBe(`${WHAT}：150 秒没回，超时被停`);
    expect(await why({ code: null, aborted: true })).toBe(`${WHAT}：被叫停`);
    const exec: UserExec = async () => {
      throw new Error('会话用户只能是 fleet-agent-carpool 之一');
    };
    expect(await readSessionOrg({ ...deps(), exec })).toEqual({
      ok: false,
      why: `${WHAT}没跑成：会话用户只能是 fleet-agent-carpool 之一`,
    });
  });
});

describe('读成了的留一会儿（sessionOrgReader）', () => {
  it('30 秒内不再读；过了再读，人切了号认得出（变了、没有引擎切号：先按没定下来算，见下面「起点」）', async () => {
    let now = 0;
    const reader = rig.reader({ now: () => new Date(now), ttlMs: SESSION_ORG_TTL_MS });
    rig.answer('carpool');
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    rig.answer('solo');
    now = SESSION_ORG_TTL_MS - 1;
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    expect(rig.calls).toHaveLength(1);
    now = SESSION_ORG_TTL_MS;
    expect(await reader()).toMatchObject({ ok: false, pending: true });
    expect(rig.calls).toHaveLength(2);
  });

  it('【故意造出的失败】读失败的不留：下一次照读，修好了马上认得出', async () => {
    const reader = rig.reader({ now: () => new Date(0), ttlMs: 60_000 });
    rig.answer({ code: 1, stderr: 'not logged in' });
    expect(await reader()).toMatchObject({ ok: false });
    rig.answer('solo');
    expect(await reader()).toEqual({ ok: true, org: 'solo' });
    expect(rig.calls).toHaveLength(2);
  });

  it('同时来的几次共用一次读', async () => {
    const reader = rig.reader({ now: () => new Date(0), ttlMs: 60_000 });
    const all = await Promise.all([reader(), reader(), reader()]);
    expect(all).toEqual([0, 1, 2].map(() => ({ ok: true, org: 'carpool' })));
    expect(rig.calls).toHaveLength(1);
  });

  it('给了 waitMs、没读完：回 pending（不算认不出）；读在后台接着跑完，下一次直接用上', async () => {
    let release: (() => void) | undefined;
    const slow: UserExec = async (command) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return rig.exec(command);
    };
    rig.answer('solo');
    const reader = sessionOrgReader({ ...deps(), exec: slow, now: () => new Date(0), ttlMs: 60_000 });
    const first = await reader({ waitMs: 5 });
    expect(first).toMatchObject({ ok: false, pending: true });
    expect(!first.ok && first.why).toContain('还没回（reclaude 更新后首跑先同步配置，要上百秒）');
    // 同一次读还在跑：再问也不另起
    expect(await reader({ waitMs: 5 })).toMatchObject({ pending: true });
    release?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(await reader({ waitMs: 5 })).toEqual({ ok: true, org: 'solo' });
    expect(rig.calls).toHaveLength(1);
  });

  it('不给 waitMs：等到读完（探针这样读）', async () => {
    let release: (() => void) | undefined;
    const slow: UserExec = async (command) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return rig.exec(command);
    };
    const reader = sessionOrgReader({ ...deps(), exec: slow });
    const reading = reader();
    setTimeout(() => release?.(), 20);
    expect(await reading).toEqual({ ok: true, org: 'carpool' });
  });

  it('【故意造出的失败】读法里意外抛了：回 ok: false，不抛给选路', async () => {
    const broken = {
      ...deps(),
      get timeoutMs(): number {
        throw new Error('配置坏了');
      },
    };
    expect(await sessionOrgReader(broken)()).toEqual({ ok: false, why: '读会话用户挂的组织出错：配置坏了' });
  });
});

describe('切号用的三样（hold、forget、engineSwitched，real/org-switch.ts 用）', () => {
  it('hold：之后的读都回 pending、写明原因，不去读；引擎切过号再解除：丢掉留着的读数，切完读成的就是新起点', async () => {
    const events: SessionOrgEvent[] = [];
    const reader = rig.reader({
      now: () => new Date(0),
      ttlMs: 60_000,
      onEvent: (e) => void events.push(e),
    });
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    const release = reader.hold('正在把会话用户从拼车组织切到独享组织');
    expect(await reader({ waitMs: 5 })).toEqual({
      ok: false,
      pending: true,
      why: '正在把会话用户从拼车组织切到独享组织',
    });
    expect(await reader()).toMatchObject({ ok: false, pending: true });
    expect(rig.calls).toHaveLength(1);
    rig.answer('solo');
    await reader.engineSwitched();
    release();
    expect(await reader()).toEqual({ ok: true, org: 'solo' });
    expect(rig.calls).toHaveLength(2);
    // 引擎自己切的号不算没记录的变动
    expect(events).toEqual([]);
    // 解过了再解：不动别的（也不丢刚读的）
    release();
    expect(await reader()).toEqual({ ok: true, org: 'solo' });
    expect(rig.calls).toHaveLength(2);
  });

  it('【故意造出的失败】hold 解除了、没说引擎切过号：读到不一样的照样算没记录的变动，不当成切好了', async () => {
    const reader = rig.reader({ now: () => new Date(0), ttlMs: 60_000 });
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    const release = reader.hold('正在切');
    rig.answer('solo');
    release();
    expect(await reader()).toMatchObject({
      ok: false,
      pending: true,
      why: expect.stringContaining('引擎没切过号'),
    });
  });

  it('解除只解自己上的那一道：后上的那一道还停着', async () => {
    const reader = rig.reader({ now: () => new Date(0), ttlMs: 60_000 });
    const first = reader.hold('第一道');
    reader.hold('第二道');
    first();
    expect(await reader()).toEqual({ ok: false, pending: true, why: '第二道' });
  });

  it('forget：丢掉留着的读数，下一次现读；起点不动（人刚切过号：认得出变了，按没定下来算）', async () => {
    const reader = rig.reader({ now: () => new Date(0), ttlMs: 60_000 });
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    rig.answer('solo');
    expect(await reader()).toEqual({ ok: true, org: 'carpool' });
    reader.forget();
    expect(await reader()).toMatchObject({
      ok: false,
      pending: true,
      why: expect.stringContaining('读到独享'),
    });
    expect(rig.calls).toHaveLength(2);
  });

  it('【故意造出的失败】forget 之前起的读晚回来：读数不算（回 pending），不留、不当起点（切号前的读数不当成切号后的）', async () => {
    const releases: (() => void)[] = [];
    const slow: UserExec = async (command) => {
      const answer = await rig.exec(command);
      await new Promise<void>((r) => {
        releases.push(r);
      });
      return answer;
    };
    rig.answer('carpool');
    const reader = sessionOrgReader({ ...deps(), exec: slow, now: () => new Date(0), ttlMs: 60_000 });
    const before = reader();
    await new Promise((r) => setTimeout(r, 0));
    reader.forget();
    rig.answer('solo');
    const after = reader();
    await new Promise((r) => setTimeout(r, 0));
    // 切号前起的那次先回来：读数不算——等它的人拿到的是「这会儿定不下来」，不是切号前的那个组织；也不留、不当起点
    releases[0]?.();
    expect(await before).toEqual({ ok: false, pending: true, why: STALE_READ_WHY });
    releases[1]?.();
    expect(await after).toEqual({ ok: true, org: 'solo' });
    expect(await reader()).toEqual({ ok: true, org: 'solo' });
    expect(rig.calls).toHaveLength(2);
  });

  it('【故意造出的失败】切号前起的读晚回来、读失败了：原样给失败，不当成定下来', async () => {
    const releases: (() => void)[] = [];
    const slow: UserExec = async (command) => {
      const answer = await rig.exec(command);
      await new Promise<void>((r) => {
        releases.push(r);
      });
      return answer;
    };
    rig.answer({ code: 1, stderr: 'not logged in' });
    const reader = sessionOrgReader({ ...deps(), exec: slow, now: () => new Date(0), ttlMs: 60_000 });
    const before = reader();
    await new Promise((r) => setTimeout(r, 0));
    reader.forget();
    releases[0]?.();
    expect(await before).toMatchObject({ ok: false, why: expect.stringContaining('登录失效') });
    expect(await before).not.toHaveProperty('pending');
  });
});

describe('起点（#335）：读数变了、引擎没切过号，不悄悄照新的来', () => {
  const BY = { by: '选路' };
  /** 按分钟走的钟：t 分钟时读。 */
  function tracker(over: { onEvent?: (e: SessionOrgEvent) => Promise<void> | void } = {}) {
    let minutes = 0;
    const events: SessionOrgEvent[] = [];
    const logs: string[] = [];
    const reader = rig.reader({
      // 北京时间 2026-09-27 21:52:00 起
      now: () => new Date(Date.parse('2026-09-27T13:52:00.000Z') + minutes * 60_000),
      ttlMs: 0,
      onEvent:
        over.onEvent ??
        ((e) => {
          events.push(e);
        }),
      log: (level, text) => void logs.push(`${level}:${text}`),
    });
    return {
      reader,
      events,
      logs,
      at: (m: number) => {
        minutes = m;
      },
    };
  }

  it('第一次读成的就是起点；一样的照常', async () => {
    const t = tracker();
    rig.answer('carpool');
    expect(await t.reader({ by: '路由探针' })).toEqual({ ok: true, org: 'carpool' });
    t.at(1);
    expect(await t.reader(BY)).toEqual({ ok: true, org: 'carpool' });
    expect(t.events).toEqual([]);
  });

  it('【故意造出的失败】读成的和起点不一样、没有引擎切号：回 pending（不是 ok），原因里是前后两次读数；报一次 drift，没到 2 分钟再读还是新的也不认、不重报', async () => {
    const t = tracker();
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    const first = await t.reader(BY);
    expect(first).toEqual({
      ok: false,
      pending: true,
      why: '会话用户挂的组织和上一次读的不一样，引擎没切过号：09-27 21:52:00 路由探针读到拼车，09-27 21:54:00 选路读到独享（北京时间）。等读数定下来再照它：连着 2 分钟都是独享才认，回到拼车就照常',
    });
    for (const bad of [String(CARPOOL_ORG_ID), String(SOLO_ORG_ID), 'fleet-test@localhost']) {
      expect(!first.ok && first.why).not.toContain(bad);
    }
    expect(t.events).toEqual([
      {
        kind: 'drift',
        from: { org: 'carpool', at: new Date('2026-09-27T13:52:00.000Z'), by: '路由探针' },
        to: { org: 'solo', at: new Date('2026-09-27T13:54:00.000Z'), by: '选路' },
      },
    ]);
    t.at(3.5);
    const again = await t.reader(BY);
    expect(again).toMatchObject({ ok: false, pending: true });
    expect(!again.ok && again.why).toContain('09-27 21:55:30 选路再读还是独享');
    expect(t.events).toHaveLength(1);
  });

  it('读数回到起点：马上照常，报 settled back（21:53 切过去、21:55 切回来那次）', async () => {
    const t = tracker();
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    await t.reader(BY);
    t.at(3);
    rig.answer('carpool');
    expect(await t.reader(BY)).toEqual({ ok: true, org: 'carpool' });
    expect(t.events.map((e) => (e.kind === 'settled' ? `settled:${e.how}` : e.kind))).toEqual([
      'drift',
      'settled:back',
    ]);
    const settled = t.events[1];
    expect(settled?.kind === 'settled' && settled.last).toEqual({
      org: 'carpool',
      at: new Date('2026-09-27T13:55:00.000Z'),
      by: '选路',
    });
  });

  it('连着 2 分钟都是新的：认它当起点（ok），报 settled accepted；之后读到它照常，再变回去又算一次变动', async () => {
    const t = tracker();
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    await t.reader(BY);
    t.at(3.9);
    expect(await t.reader(BY)).toMatchObject({ ok: false, pending: true });
    t.at(4);
    expect(await t.reader(BY)).toEqual({ ok: true, org: 'solo' });
    t.at(5);
    expect(await t.reader(BY)).toEqual({ ok: true, org: 'solo' });
    t.at(6);
    rig.answer('carpool');
    expect(await t.reader(BY)).toMatchObject({ ok: false, pending: true });
    expect(t.events.map((e) => (e.kind === 'settled' ? `settled:${e.how}` : e.kind))).toEqual([
      'drift',
      'settled:accepted',
      'drift',
    ]);
  });

  it('变动中引擎切了号：以切完读成的为准，报 settled engine', async () => {
    const t = tracker();
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    await t.reader(BY);
    rig.answer('carpool');
    await t.reader.engineSwitched();
    t.at(3);
    rig.answer('solo');
    expect(await t.reader({ by: '路由探针' })).toEqual({ ok: true, org: 'solo' });
    expect(t.events.map((e) => (e.kind === 'settled' ? `settled:${e.how}` : e.kind))).toEqual([
      'drift',
      'settled:engine',
    ]);
  });

  it('【故意造出的失败】中间夹着读失败：原样给失败，不当成定下来；之后照旧按第一次读到新组织的时刻算', async () => {
    const t = tracker();
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    await t.reader(BY);
    t.at(3);
    rig.answer({ code: 1, stderr: 'not logged in' });
    expect(await t.reader(BY)).toMatchObject({ ok: false, why: expect.stringContaining('登录失效') });
    t.at(4);
    rig.answer('solo');
    expect(await t.reader(BY)).toEqual({ ok: true, org: 'solo' });
    expect(t.events.map((e) => e.kind)).toEqual(['drift', 'settled']);
  });

  it('【故意造出的失败】提醒没写进库（onEvent 抛了）：读数照样是 pending，不当成 ok；记错误日志', async () => {
    const t = tracker({
      onEvent: () => {
        throw new Error('库连不上');
      },
    });
    rig.answer('carpool');
    await t.reader({ by: '路由探针' });
    t.at(2);
    rig.answer('solo');
    expect(await t.reader(BY)).toMatchObject({ ok: false, pending: true });
    expect(t.logs.some((l) => l.startsWith('error:') && l.includes('起点变动没记下'))).toBe(true);
  });
});
