// 停滞判断：按有没有进展判「在等 / 在绕圈 / 死了」，不看报错长什么样。场景取自旧系统的真事，时刻是造的。
import { describe, expect, it } from 'vitest';
import {
  type JevReply,
  judgeStall,
  judgeStallWithJev,
  longestRepeat,
  type StallChoice,
  type StallFacts,
} from '../../src/failure/index.ts';

const T0 = Date.parse('2026-09-25T00:00:00.000Z');
/** 开工后第几秒。 */
const s = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const m = (minutes: number) => s(minutes * 60);
/** 默认过程记录读到了、还没有事件（lastEventAt: null）；「没读成」的场景单独写。 */
const facts = (now: string, more: Partial<StallFacts> = {}): StallFacts => ({
  now,
  startedAt: s(0),
  lastEventAt: null,
  ...more,
});
const bash = (summary: string, ok = false) => ({ name: 'Bash', summary, action: 'run', ok });
const edit = (path: string) => ({ name: 'Edit', summary: path, action: 'edit', ok: true });

describe('有进展', () => {
  it('刚有新事件、刚推进过：不算停滞', () => {
    const v = judgeStall(facts(m(10), { lastEventAt: m(9.5), lastStepAt: m(8) }));
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'progressing', rule: 'G1' });
    expect(v.basis).toBe('30 秒前还有动静，2 分钟前有推进');
  });

  it('步骤清单 100 秒前刚推进、过程记录里还没有事件：不算死（沉默从最近的动静算起）', () => {
    const v = judgeStall(facts(m(20), { lastStepAt: s(20 * 60 - 100) }));
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'progressing', rule: 'G1' });
    // 刚提交、刚改过文件也算动静。
    expect(judgeStall(facts(m(20), { lastEventAt: m(5), lastCommitAt: s(20 * 60 - 60) })).state).toBe(
      'progressing',
    );
    expect(judgeStall(facts(m(20), { lastEventAt: m(5), lastFileChangeAt: s(20 * 60 - 60) })).state).toBe(
      'progressing',
    );
  });

  it('过程记录没读成：报「没查成」，不当成一直没动静去判死', () => {
    const v = judgeStall({ now: m(20), startedAt: s(0), lastStepAt: s(20 * 60 - 100) });
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'unscanned', rule: 'U1' });
    expect(v.basis).toContain('没查成');
    // 不靠过程记录也判得出的照判：进程退了、在等人。
    expect(judgeStall({ now: m(20), startedAt: s(0), processAlive: false }).state).toBe('dead');
    expect(judgeStall({ now: m(20), startedAt: s(0), waiting: { on: 'human', since: m(19) } }).state).toBe(
      'waiting',
    );
  });

  it('策略参数给了但不对：报错，不悄悄换成默认值', () => {
    expect(() => judgeStall(facts(m(1)), { repeatThreshold: 1 })).toThrow(
      '停滞判断策略的 repeatThreshold 不对：要不小于 2 的整数，给的是 1',
    );
    expect(() => judgeStall(facts(m(1)), { silentSeconds: 0 })).toThrow('silentSeconds 不对：要大于 0 的数');
    expect(() => judgeStall(facts(m(1)), { jevConfidenceFloor: 1.5 })).toThrow(
      'jevConfidenceFloor 不对：要在 0 到 1 之间',
    );
  });

  it('时刻读坏了：报错，不当成「刚有动静」也不当成「没动静」', () => {
    expect(() => judgeStall({ now: 'bad', startedAt: s(0) })).toThrow('now 的时刻认不出（bad）');
    expect(() => judgeStall(facts(m(10), { lastEventAt: '昨天' }))).toThrow('lastEventAt 的时刻认不出');
    expect(() => judgeStall(facts(m(10), { toolsInFlight: [{ name: 'Bash', since: '' }] }))).toThrow(
      'toolsInFlight[0].since 的时刻认不出',
    );
    expect(() => judgeStall(facts(m(10), { waiting: { on: 'human', since: 'x' } }))).toThrow(
      'waiting.since 的时刻认不出',
    );
  });
});

describe('死了', () => {
  it('没有工具在跑、过程记录 6 分钟没新事件（fleet 任务 #1608 g1：做了 4 个动作后卡住，没有任何错误字样）', () => {
    const v = judgeStall(
      facts(m(20), {
        lastEventAt: s(20 * 60 - 361),
        recentTools: [bash('ls'), edit('a.ts'), bash('pnpm test'), edit('b.ts')],
      }),
    );
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'dead', rule: 'D5' });
    expect(v.basis).toBe('6 分钟没有任何动静（新事件、步骤、提交、改文件都没有），也没有工具在跑');
    // 差一秒不到线。
    expect(judgeStall(facts(m(20), { lastEventAt: s(20 * 60 - 359) })).state).toBe('progressing');
  });

  it('起来之后一条事件、一次推进都没有：从开工时刻算沉默', () => {
    expect(judgeStall(facts(s(400))).rule).toBe('D5');
  });

  it('进程已经退了', () => {
    expect(judgeStall(facts(m(1), { processAlive: false, lastEventAt: m(1) })).rule).toBe('D1');
  });

  it('工具跑了 31 分钟还没完：超过上限算死', () => {
    const v = judgeStall(facts(m(40), { toolsInFlight: [{ name: 'Bash', since: m(9) }] }));
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'dead', rule: 'D3' });
  });

  it('上游一直重试、连不上 10 分钟（codex 连不上时一直打 Reconnecting，自己不退）', () => {
    const v = judgeStall(
      facts(m(30), {
        lastEventAt: m(30),
        waiting: { on: 'upstream', since: m(20), detail: 'Reconnecting...' },
      }),
    );
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'dead', rule: 'D4' });
  });

  it('等权限批准 6 分钟：无头会话没人会批（fleet 任务 #1748 g2 就停在这，2 分钟后被取消只记了 failed）', () => {
    const v = judgeStall(facts(m(10), { lastEventAt: m(4), waiting: { on: 'permission', since: m(4) } }));
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'dead', rule: 'D2' });
  });
});

describe('在等', () => {
  it('在等人回答：等多久都不算死，也不重开（fleet 任务 #1560 g1：连起 11 个会话全停在等人）', () => {
    const v = judgeStall(
      facts(m(600), {
        lastEventAt: m(10),
        waiting: { on: 'human', since: m(10), detail: '登录页要不要验证码？' },
      }),
    );
    expect({ state: v.state, waitingOn: v.waitingOn, rule: v.rule }).toEqual({
      state: 'waiting',
      waitingOn: 'human',
      rule: 'W1',
    });
    expect(v.basis).toContain('登录页要不要验证码？');
  });

  it('测试在跑、十几分钟不出字：在等工具，不算沉默', () => {
    const v = judgeStall(
      facts(m(30), { lastEventAt: m(15), toolsInFlight: [{ name: 'Bash', since: m(15) }] }),
    );
    expect({ state: v.state, waitingOn: v.waitingOn }).toEqual({ state: 'waiting', waitingOn: 'tool' });
  });

  it('上游在重试（没到上限）、刚请求权限：在等', () => {
    const upstream = judgeStall(
      facts(m(10), { lastEventAt: m(10), waiting: { on: 'upstream', since: m(7) } }),
    );
    expect({ state: upstream.state, waitingOn: upstream.waitingOn }).toEqual({
      state: 'waiting',
      waitingOn: 'upstream',
    });
    const permission = judgeStall(
      facts(m(10), { lastEventAt: m(9), waiting: { on: 'permission', since: m(9) } }),
    );
    expect(permission.rule).toBe('W2');
  });
});

describe('在绕圈', () => {
  it('有动静但 20 分钟没推进，同一条失败的命令中间没改文件跑了 3 次', () => {
    const v = judgeStall(
      facts(m(25), {
        lastEventAt: m(24.9),
        lastStepAt: m(5),
        recentTools: [edit('a.ts'), bash('pnpm test'), bash('pnpm test'), bash('pnpm test')],
      }),
    );
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'looping', rule: 'L1' });
    expect(v.basis).toBe('20 分钟没推进，同一个动作做了 3 次：Bash pnpm test');
  });

  it('边改边跑测试不算绕圈：改了文件就重新数', () => {
    const tools = [bash('pnpm test'), edit('a.ts'), bash('pnpm test'), edit('a.ts'), bash('pnpm test')];
    expect(longestRepeat(tools)?.count).toBe(1);
    // 没有步骤清单时改文件就算推进。
    const v = judgeStall(facts(m(25), { lastEventAt: m(24.9), lastFileChangeAt: m(24), recentTools: tools }));
    expect(v.rule).toBe('G1');
  });

  it('有动静但 45 分钟没推进：Jev 不在也判绕圈', () => {
    const v = judgeStall(facts(m(50), { lastEventAt: m(49.9), lastStepAt: m(5) }));
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'looping', rule: 'L2' });
  });
});

describe('拿不准的留给 Jev', () => {
  // 有步骤清单时，改来改去不推进步骤不算进展；也看不出在重复。
  const unsure = facts(m(25), {
    lastEventAt: m(24.9),
    lastStepAt: m(5),
    lastFileChangeAt: m(24),
    recentTools: [edit('a.ts'), bash('pnpm test'), edit('b.ts'), bash('pnpm lint')],
    transcriptTail: ['我再试一个办法……'],
  });
  const withJev = (reply: JevReply<StallChoice>) => judgeStall({ ...unsure, jev: reply });

  it('默认先不动，出一道停滞预判题（带最近的工具和过程记录）', () => {
    const v = judgeStall(unsure);
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'progressing', rule: 'G2' });
    expect(v.jevQuestion?.questionId).toBe('stall-predict');
    expect(v.jevQuestion?.options).toEqual(['waiting', 'looping', 'dead', 'unclear']);
    expect(v.jevQuestion?.sample).toContain('我再试一个办法……');
    expect(v.jevQuestion?.sample).toContain('pnpm lint');
  });

  it('Jev 有把握判绕圈或死了：按它的', () => {
    const looping = withJev({ asked: true, ok: true, choice: 'looping', confidence: 0.8, shadow: false });
    expect({ state: looping.state, rule: looping.rule, via: looping.via }).toEqual({
      state: 'looping',
      rule: 'LJ',
      via: 'jev',
    });
    expect(withJev({ asked: true, ok: true, choice: 'dead', confidence: 0.8, shadow: false }).state).toBe(
      'dead',
    );
  });

  it('Jev 只能判停滞、不能判正常；把握低、只记不拦都不算数', () => {
    const cases: [JevReply<StallChoice>, string][] = [
      [{ asked: true, ok: true, choice: 'waiting', confidence: 0.95, shadow: false }, '不改结论'],
      [{ asked: true, ok: true, choice: 'looping', confidence: 0.5, shadow: false }, '低于 0.7'],
      [{ asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: true }, '只记不拦'],
      [{ asked: true, ok: false, reason: '超时' }, '没判出来'],
    ];
    for (const [reply, why] of cases) {
      const v = withJev(reply);
      expect({ state: v.state, rule: v.rule }).toEqual({ state: 'progressing', rule: 'G2' });
      expect(v.basis).toContain(why);
      expect(v.jevQuestion).toBeUndefined();
    }
  });

  it('默认实现不问：结论和没接 Jev 一样', async () => {
    const v = await judgeStallWithJev(unsure);
    expect({ state: v.state, rule: v.rule }).toEqual({ state: 'progressing', rule: 'G2' });
    expect(v.basis).toContain('没接 Jev');
  });

  it('接上 Jev：拿不准时才问', async () => {
    let asked = 0;
    const jev = {
      ask: async () => {
        asked += 1;
        return { asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: false } as never;
      },
    };
    expect((await judgeStallWithJev(unsure, { jev })).state).toBe('looping');
    expect(
      (await judgeStallWithJev(facts(m(10), { lastEventAt: m(9.5), lastStepAt: m(8) }), { jev })).state,
    ).toBe('progressing');
    expect(asked).toBe(1);
  });
});
