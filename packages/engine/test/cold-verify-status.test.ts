// 装配侧（#555-2）的测试：把冷调用的结论贴成 mergate 认的 cold-verify 状态。
//
// 这一份钉的是「**一条都不许悄悄变成 success**」（通用段底线第三条 + specs/555 第 4 条）：
// verifier-invoke 的每条明确失败路径（读不到 diff、空 diff、空 changedFiles、读不到单子、没家族可挑、
// 冷调用没跑成）都要**真的走到状态上**、而且都是 failure；装配侧自己起不来（invoke 抛错）也是 failure；
// 写状态写不成**必须抛**（吞掉就是「验过了但合并闸看不到」= 死锁）。

import { describe, expect, it } from 'vitest';
import {
  type ColdVerifyRunDeps,
  ColdVerifyWriteError,
  runColdVerifyAndPost,
} from '../src/cold-verify-post.ts';
import {
  COLD_VERIFY_ROUNDS_MAX,
  canStartRound,
  coldVerifyExhausted,
  coldVerifyNotRun,
  coldVerifyPending,
  coldVerifyStatus,
  nextRound,
} from '../src/cold-verify-status.ts';
import type { VerifierInvokeInput, VerifierInvokeOutput } from '../src/verifier-invoke.ts';

const HEAD = 'a'.repeat(40);
const INPUT: VerifierInvokeInput = {
  prNumber: 42,
  branch: 'feat/x',
  baseSha: 'b'.repeat(40),
  taskId: 'task-1',
  what: '要 A',
  howToFinish: ['代码里有 A'],
  modelFamilyAvoid: 'gpt',
  round: 1,
};

const PASS: VerifierInvokeOutput = { pass: true, problems: [], round: 1 };
const FAIL_NOT_DONE: VerifierInvokeOutput = {
  pass: false,
  problems: ['没做到验收条：单子要 A、代码做了 B'],
  round: 1,
};

describe('coldVerifyStatus：结论 → 状态（只有 pass 才是 success）', () => {
  it('pass=true → success', () => {
    expect(coldVerifyStatus(PASS)).toEqual({
      state: 'success',
      description: '验收通过（第 1 轮冷调用）',
    });
  });

  it('pass=false → failure，把第一条问题写进 description', () => {
    const s = coldVerifyStatus(FAIL_NOT_DONE);
    expect(s.state).toBe('failure');
    expect(s.description).toContain('没做到验收条');
  });

  it('pass=false 又一条问题都没有 → 照样 failure（不许因为没话说就当过）', () => {
    const s = coldVerifyStatus({ pass: false, problems: ['', '  '], round: 2 });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('验收没过');
  });

  it('description 截到 140 个字符（GitHub 的上限）', () => {
    const s = coldVerifyStatus({
      pass: false,
      problems: [`没做到验收条：${'很长'.repeat(200)}`],
      round: 1,
    });
    expect([...s.description].length).toBeLessThanOrEqual(140);
    expect(s.description.endsWith('…')).toBe(true);
  });

  it('【故意造出的失败】装配侧起不来 → failure，不是 pending、更不是 success', () => {
    const s = coldVerifyNotRun('gh api 401');
    expect(s.state).toBe('failure');
    expect(s.description).toContain('没跑起来');
    expect(s.description).toContain('gh api 401');
  });

  it('【故意造出的失败】「没跑成」和「还在跑」是两回事：pending 只说还在跑', () => {
    expect(coldVerifyPending(1).state).toBe('pending');
    expect(coldVerifyPending(1).description).not.toContain('没跑起来');
  });
});

describe('轮数：默认 1 轮、最多 2 轮（specs/555 第 3 条）', () => {
  it('跑完 0 轮 → 下一轮是第 1 轮', () => {
    expect(nextRound(0)).toBe(1);
    expect(canStartRound(0)).toBe(true);
  });

  it('跑完 1 轮（默认轮数）→ 还能起第 2 轮（上限）', () => {
    expect(COLD_VERIFY_ROUNDS_MAX).toBe(2);
    expect(nextRound(1)).toBe(2);
  });

  it('【故意造出的失败】跑完 2 轮（到上限）→ 不再起第 3 轮：不许拿新一轮盖掉结论', () => {
    expect(canStartRound(COLD_VERIFY_ROUNDS_MAX)).toBe(false);
    expect(nextRound(2)).toBeNull();
    expect(coldVerifyExhausted(2).state).toBe('failure');
    expect(coldVerifyExhausted(2).description).toContain('交人看');
  });

  it('【故意造出的失败】跑过头了（3 轮）也回 null，不会绕成第 1 轮重来（自循环）', () => {
    expect(nextRound(3)).toBeNull();
    expect(canStartRound(3)).toBe(false);
  });
});

/** 记下每次写的是哪条状态；可以按需要让写抛错。 */
function writer(broken = false) {
  const written: { prNumber: number; head: string; state: string; description: string }[] = [];
  const writeStatus: ColdVerifyRunDeps['writeStatus'] = async ({ prNumber, head, status }) => {
    if (broken) throw new Error('GitHub 回了 422');
    written.push({ prNumber, head, state: status.state, description: status.description });
  };
  return { written, writeStatus };
}

describe('runColdVerifyAndPost：跑一轮、把结论贴到头上', () => {
  it('invoke 说 pass → 贴上 success', async () => {
    const w = writer();
    const r = await runColdVerifyAndPost(
      INPUT,
      { prNumber: 42, head: HEAD },
      {
        invoke: async () => PASS,
        writeStatus: w.writeStatus,
      },
    );
    expect(r.status.state).toBe('success');
    expect(w.written).toEqual([
      { prNumber: 42, head: HEAD, state: 'success', description: '验收通过（第 1 轮冷调用）' },
    ]);
  });

  it('invoke 说 fail → 贴上 failure（不吞）', async () => {
    const w = writer();
    await runColdVerifyAndPost(
      INPUT,
      { prNumber: 42, head: HEAD },
      {
        invoke: async () => FAIL_NOT_DONE,
        writeStatus: w.writeStatus,
      },
    );
    expect(w.written).toEqual([expect.objectContaining({ state: 'failure', head: HEAD })]);
    expect(w.written[0]?.description).toContain('没做到验收条');
  });

  it('【故意造出的失败】invoke 自己抛错（起进程就炸了）→ 贴 failure，状态不许空着', async () => {
    const w = writer();
    const r = await runColdVerifyAndPost(
      INPUT,
      { prNumber: 42, head: HEAD },
      {
        invoke: async () => {
          throw new Error('spawn EACCES');
        },
        writeStatus: w.writeStatus,
      },
    );
    expect(r.status.state).toBe('failure');
    expect(w.written).toHaveLength(1);
    expect(w.written[0]?.state).toBe('failure');
    expect(w.written[0]?.description).toContain('spawn EACCES');
    // 起不来就不该有「结论」这一说
    expect(r.verdict).toBeUndefined();
  });

  it('【故意造出的失败】写状态写不成 → 抛 ColdVerifyWriteError，不吞（吞了就是验过了但闸看不到）', async () => {
    const w = writer(true);
    await expect(
      runColdVerifyAndPost(
        INPUT,
        { prNumber: 42, head: HEAD },
        {
          invoke: async () => PASS,
          writeStatus: w.writeStatus,
        },
      ),
    ).rejects.toBeInstanceOf(ColdVerifyWriteError);
    // 写不成时不许留下「写过了」的记录
    expect(w.written).toEqual([]);
  });

  it('【故意造出的失败】写不成时抛出的错里带上头（人要照它查是哪一条）', async () => {
    const w = writer(true);
    const err = await runColdVerifyAndPost(
      INPUT,
      { prNumber: 42, head: HEAD },
      {
        invoke: async () => PASS,
        writeStatus: w.writeStatus,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColdVerifyWriteError);
    expect((err as ColdVerifyWriteError).head).toBe(HEAD);
    expect((err as ColdVerifyWriteError).prNumber).toBe(42);
    expect((err as Error).message).toContain('422');
  });

  it('贴上的是「被验的那个头」，不是别的头（头变了旧状态自然不算）', async () => {
    const other = 'c'.repeat(40);
    const w = writer();
    await runColdVerifyAndPost(
      INPUT,
      { prNumber: 7, head: other },
      {
        invoke: async () => PASS,
        writeStatus: w.writeStatus,
      },
    );
    expect(w.written[0]?.head).toBe(other);
    expect(w.written[0]?.prNumber).toBe(7);
  });
});
