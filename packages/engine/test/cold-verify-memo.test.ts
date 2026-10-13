// #2007：总开关关着、没有能派的路由时，验收每圈重来，不能每圈都改写同一个头上的 cold-verify
// （每次写入都触发一轮 merge-gate，实测 30 分钟 59 次）。这一份钉死：相同状态不重复写、「跑着」只在真挑中路由时写、
// 写失败不记、头变了作废。每条「改前」的数字都是同一个测试里不给记忆跑出来的。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ColdVerifyDeps, runColdVerifyForPr } from '../src/cold-verify-run.ts';
import { createStatusMemo } from '../src/cold-verify-status.ts';
import type { OneShotDeps } from '../src/runner/one-shot.ts';
import type {
  ChooseModelForFamily,
  VerifierInvokeInput,
  VerifierInvokeOutput,
} from '../src/verifier-invoke.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const MASTER_OFF = '引擎总开关关着';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'fleet-2007-memo-test-'));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));
const ONE_SHOT = { tmpDir: TMP_DIR } as unknown as OneShotDeps;

interface Posted {
  head: string;
  state: string;
  description: string;
}

function recorder() {
  const posted: Posted[] = [];
  return {
    posted,
    writeStatus: async ({
      head,
      status,
    }: {
      head: string;
      status: { state: string; description: string };
    }) => {
      posted.push({ head, state: status.state, description: status.description });
    },
  };
}

function sources(head: string = HEAD): ColdVerifyDeps['sources'] {
  return {
    pr: async () => ({ head, baseSha: BASE, branch: 'fleet/12-t12345678' }),
    diff: async () => ({ diffText: '@@ -1 +1 @@\n-a\n+b', changedFiles: ['a.ts'] }),
    spec: async () => ({
      taskId: '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69',
      issueNumber: 12,
      workflowId: 'task:acme/demo#12',
      what: '要 A',
      howToFinish: ['有 A'],
    }),
    authorFamilies: async () => ['gpt'],
  };
}

/** 没有路由：像真的一样问一次选路，选路回「在等」，invoke 回 routeWait。 */
const waitingInvoke: ColdVerifyDeps['invoke'] = async (input: VerifierInvokeInput, deps) => {
  await deps.chooseModelForFamily('claude');
  return {
    pass: false,
    problems: [`没讨论成：要派的族这会儿派不出、等得来（${MASTER_OFF}）`],
    round: input.round,
    routeWait: { families: ['claude'], reason: MASTER_OFF },
  };
};
/** 路由有了：选路挑中一条，invoke 通过。 */
const routedInvoke: ColdVerifyDeps['invoke'] = async (input, deps) => {
  await deps.chooseModelForFamily('claude');
  return { pass: true, problems: [], round: input.round } as VerifierInvokeOutput;
};
const NO_ROUTE: ChooseModelForFamily = async () => ({ wait: MASTER_OFF });
const HAS_ROUTE: ChooseModelForFamily = async () => ({ modelId: 'claude-x' });

const waitReason: NonNullable<ColdVerifyDeps['waitReason']> = (v) =>
  v.routeWait === undefined ? undefined : `这会儿没有能派的验收路由：${v.routeWait.reason}`;

function deps(over: Partial<ColdVerifyDeps> = {}): ColdVerifyDeps {
  return {
    sources: sources(),
    invoke: waitingInvoke,
    oneShot: ONE_SHOT,
    chooseModelForFamily: NO_ROUTE,
    cwd: 'C:/work/x',
    waitReason,
    ...over,
  };
}

describe('cold-verify 贴状态的记忆（#2007）', () => {
  it('【故意造出的失败】总开关关着连调 10 圈：没给记忆（改前）写 20 条、「跑着」「在等」来回跳；给了记忆（改后）只写 1 条「在等」', async () => {
    const before = recorder();
    for (let i = 0; i < 10; i++) await runColdVerifyForPr(42, deps({ writeStatus: before.writeStatus }));
    expect(before.posted).toHaveLength(20);
    expect(new Set(before.posted.map((x) => x.description)).size).toBe(2);

    const after = recorder();
    const memo = createStatusMemo().scoped('acme/demo#42');
    for (let i = 0; i < 10; i++) {
      await runColdVerifyForPr(42, deps({ writeStatus: after.writeStatus, statusMemo: memo }));
    }
    expect(after.posted).toHaveLength(1);
    expect(after.posted[0]?.description).toContain(`验收在等：这会儿没有能派的验收路由：${MASTER_OFF}`);
    expect(after.posted.some((x) => x.description.includes('跑着'))).toBe(false);
  });

  it('【故意造出的失败】相同 state+description 连续两次：第二次不写', async () => {
    const rec = recorder();
    const memo = createStatusMemo().scoped('acme/demo#42');
    await runColdVerifyForPr(42, deps({ writeStatus: rec.writeStatus, statusMemo: memo }));
    await runColdVerifyForPr(42, deps({ writeStatus: rec.writeStatus, statusMemo: memo }));
    expect(rec.posted).toHaveLength(1);
  });

  it('「在等」之后路由有了、真起会话：先写「跑着」，再写结论；起会话之前就已经贴上了', async () => {
    const rec = recorder();
    const memo = createStatusMemo().scoped('acme/demo#42');
    await runColdVerifyForPr(42, deps({ writeStatus: rec.writeStatus, statusMemo: memo }));
    const r = await runColdVerifyForPr(
      42,
      deps({
        writeStatus: rec.writeStatus,
        statusMemo: memo,
        invoke: async (input, d) => {
          const picked = await d.chooseModelForFamily('claude');
          expect(picked).toMatchObject({ modelId: 'claude-x' });
          // 选到路由、还没出结论时，「跑着」已经在 GitHub 上了
          expect(rec.posted.at(-1)?.description).toContain('跑着');
          return { pass: true, problems: [], round: input.round } as VerifierInvokeOutput;
        },
        chooseModelForFamily: HAS_ROUTE,
      }),
    );
    expect(r.status.state).toBe('success');
    expect(rec.posted.map((x) => x.state)).toEqual(['pending', 'pending', 'success']);
  });

  it('【故意造出的失败】写「跑着」抛错：不花模型调用（invoke 里选路那一下就抛出去）', async () => {
    let ran = 0;
    const memo = createStatusMemo().scoped('acme/demo#42');
    await expect(
      runColdVerifyForPr(
        42,
        deps({
          statusMemo: memo,
          chooseModelForFamily: HAS_ROUTE,
          writeStatus: async () => {
            throw new Error('GitHub 不通');
          },
          invoke: async (input, d) => {
            await d.chooseModelForFamily('claude');
            ran += 1;
            return { pass: true, problems: [], round: input.round } as VerifierInvokeOutput;
          },
        }),
      ),
    ).rejects.toThrow('GitHub 不通');
    expect(ran).toBe(0);
    expect(memo.get(HEAD)).toBeUndefined();
  });

  it('【故意造出的失败】写状态抛错：记忆不更新，下一圈照写', async () => {
    const posted: string[] = [];
    let fail = true;
    const memo = createStatusMemo().scoped('acme/demo#42');
    const d = deps({
      statusMemo: memo,
      writeStatus: async ({ status }) => {
        if (fail) throw new Error('GitHub 不通');
        posted.push(status.description);
      },
    });
    await expect(runColdVerifyForPr(42, d)).rejects.toThrow('GitHub 不通');
    expect(memo.get(HEAD)).toBeUndefined();
    fail = false;
    await runColdVerifyForPr(42, d);
    expect(posted).toHaveLength(1);
  });

  it('头变了（推了新提交）：记忆作废，新头上照写；一个 PR 只记最新的头', async () => {
    const rec = recorder();
    const memo = createStatusMemo().scoped('acme/demo#42');
    await runColdVerifyForPr(42, deps({ writeStatus: rec.writeStatus, statusMemo: memo }));
    const moved = deps({ writeStatus: rec.writeStatus, statusMemo: memo, sources: sources(NEW_HEAD) });
    await runColdVerifyForPr(42, moved);
    await runColdVerifyForPr(42, moved);
    expect(rec.posted.map((x) => x.head)).toEqual([HEAD, NEW_HEAD]);
    expect(memo.get(HEAD)).toBeUndefined();
  });

  it('记忆有上限：超过就丢最早的；forget 能丢掉某个 PR', () => {
    const m = createStatusMemo(2);
    const st = { state: 'pending' as const, description: 'x' };
    m.scoped('a#1').set(HEAD, st);
    m.scoped('a#2').set(HEAD, st);
    m.scoped('a#3').set(HEAD, st);
    expect(m.size()).toBe(2);
    expect(m.scoped('a#1').get(HEAD)).toBeUndefined();
    m.forget('a#3');
    expect(m.size()).toBe(1);
  });

  it('没给记忆（老调用方）：照旧每圈先贴「跑着」', async () => {
    const rec = recorder();
    await runColdVerifyForPr(
      42,
      deps({ writeStatus: rec.writeStatus, invoke: routedInvoke, chooseModelForFamily: HAS_ROUTE }),
    );
    expect(rec.posted.map((x) => x.state)).toEqual(['pending', 'success']);
  });
});
