// 重做另起新一代按历代累计动手轮数封顶（#3625）的判据：数 manual+done 的笔数，到上限就判交回本机。
import { describe, expect, it } from 'vitest';
import { implementRoundsDone, totalRoundsHoldOf } from '../src/total-rounds-hold.ts';

const LIMIT = 6;

describe('implementRoundsDone', () => {
  it('只数 manual 且 done 的笔：被杀、起不来、验收段、对题段、还没结束的都不算', () => {
    expect(
      implementRoundsDone([
        { segment: 'manual', outcome: 'done' },
        { segment: 'manual', outcome: 'done' },
        { segment: 'manual', outcome: 'killed' },
        { segment: 'manual', outcome: 'spawn_failed' },
        { segment: 'manual', outcome: 'org_switch' },
        { segment: 'manual' },
        { segment: 'verify', outcome: 'done' },
        { segment: 'scope', outcome: 'done' },
      ]),
    ).toBe(2);
    expect(implementRoundsDone([])).toBe(0);
  });
});

describe('totalRoundsHoldOf', () => {
  it('没到上限回 null，照常起新一代', () => {
    expect(totalRoundsHoldOf(0, 'task.redo', LIMIT)).toBeNull();
    expect(totalRoundsHoldOf(LIMIT - 1, 'commander.redo', LIMIT)).toBeNull();
  });

  it('到了上限回判决：写明累计数、入口，留言幂等键按入口和累计数区分', () => {
    const a = totalRoundsHoldOf(LIMIT, 'task.redo', LIMIT);
    const b = totalRoundsHoldOf(LIMIT + 2, 'commander.redo', LIMIT);
    expect(a).toMatchObject({ rounds: LIMIT, limit: LIMIT });
    expect(a?.why).toContain('task.redo 重做');
    expect(a?.why).toContain('已交回本机做');
    expect(a?.comment).toContain('本机做');
    expect(b?.why).toContain('指挥官重做');
    expect(a?.key).toBe(`total-rounds-hold:task.redo:${LIMIT}`);
    expect(b?.key).not.toBe(a?.key);
  });
});
