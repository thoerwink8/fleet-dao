// 装配入口（#555-2）的测试：取三样 → 起一次冷调用 → 贴上状态。
//
// 这一份钉死的规矩：**读了什么、卡在哪一步，都要变成贴上 GitHub 的那条状态**，绝不「什么都不贴」或「贴成成功」。
// 三条故意造出失败的路都单独测：读不到 PR、读不到单子、认不出作者族——读不到 PR 连头都没有（贴不了，照实报）；
// 后两种头是有的，**必须贴上 failure**（不贴 = 合并闸判「还没验」，人一直等一个不会来的结论）。

import { describe, expect, it } from 'vitest';
import { runColdVerifyForPr } from '../src/cold-verify-run.ts';
import type { RunRecord, RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  type ChooseModelForFamily,
  invokeVerifier,
  type VerifierInvokeOutput,
} from '../src/verifier-invoke.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);

const MODEL_PASS = ['## 问题', '（没有）', '', 'verdict: pass'].join('\n');

function fakeOneShot(scripted: SpawnOutcome): OneShotDeps {
  const runs: RunsWriter = { async record(_r: RunRecord) {} };
  return {
    spawn: async () => scripted,
    buildCommand: (input) => ({ argv: ['fake-executor', '--model', input.modelId], cwd: input.cwd }),
    runs,
    tmpDir: 'C:/temp/fleet-555-2-run-test',
  };
}

const ONE_SHOT = fakeOneShot({ exitCode: 0, stdout: MODEL_PASS, stderr: '', killed: false });
const PICK_CLAUDE: ChooseModelForFamily = async (family) =>
  family === 'claude' ? { modelId: 'claude-x' } : undefined;

function sources(over: Partial<Parameters<typeof mkSources>[0]> = {}) {
  return mkSources(over);
}

function mkSources(o: {
  pr?: () => Promise<{ head: string; baseSha: string; branch: string }>;
  diff?: () => Promise<{ diffText: string; changedFiles: string[] }>;
  spec?: () => Promise<{ taskId: string; what: string; howToFinish: string[]; specDir?: string }>;
  authors?: () => Promise<string[]>;
}) {
  return {
    pr: o.pr ?? (async () => ({ head: HEAD, baseSha: BASE, branch: 'feat/x' })),
    diff: o.diff ?? (async () => ({ diffText: '@@ -1,1 +1,1 @@\n-old\n+new', changedFiles: ['foo.ts'] })),
    spec:
      o.spec ??
      (async () => ({
        taskId: 'task-1',
        what: '要 A',
        howToFinish: ['代码里有 A'],
        specDir: 'specs/42-做A/',
      })),
    authorFamilies: o.authors ?? (async () => ['gpt']),
  };
}

/** 记下每次贴的是什么。 */
function recorder() {
  const posted: { prNumber: number; head: string; state: string; description: string }[] = [];
  return {
    posted,
    writeStatus: async ({
      prNumber,
      head,
      status,
    }: {
      prNumber: number;
      head: string;
      status: { state: string; description: string };
    }) => {
      posted.push({ prNumber, head, state: status.state, description: status.description });
    },
  };
}

describe('runColdVerifyForPr：跑通一路', () => {
  it('三样都读得到、挑得出别家、模型说 pass → 贴上 success（贴在 PR 的头上）', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('success');
    expect(r.head).toBe(HEAD);
    expect(r.sourceProblem).toBeUndefined();
    // 开跑前先贴一条 pending（闸显示「等验收」而不是「还没验」），跑完再贴结论，都贴在同一个头上
    expect(rec.posted.map((x) => [x.head, x.state])).toEqual([
      [HEAD, 'pending'],
      [HEAD, 'success'],
    ]);
    expect(rec.posted.at(-1)).toEqual({
      prNumber: 42,
      head: HEAD,
      state: 'success',
      description: '验收通过（第 1 轮冷调用）',
    });
  });

  it('模型说 fail → 贴上 failure', async () => {
    const rec = recorder();
    const failShot = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', '- 没做到验收条：单子要 A、代码做了 B', '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: invokeVerifier,
      oneShot: failShot,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(rec.posted.at(-1)?.state).toBe('failure');
    expect(rec.posted.at(-1)?.description).toContain('没做到验收条');
    // 「验了没过」不是「没验成」：sourceProblem 留给读不到那几种
    expect(r.sourceProblem).toBeUndefined();
  });

  it('不给 writeStatus（--dry-run）→ 照样跑完、回状态，只是不贴', async () => {
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
    });
    expect(r.status.state).toBe('success');
    expect(r.head).toBe(HEAD);
  });

  it('第 2 轮透传下去（轮数由调用方按 canStartRound 判）', async () => {
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: async (input) => ({ pass: true, problems: [], round: input.round }) as VerifierInvokeOutput,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      round: 2,
    });
    expect(r.status.description).toContain('第 2 轮');
  });
});

describe('runColdVerifyForPr：【故意造出的失败】每条「读不到」都贴 failure，不许什么都不贴', () => {
  it('读不到 PR（头都没有）→ 报没验成，贴不了（head 为 null），不许假装验过', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources({
        pr: async () => {
          throw new Error('gh api 404');
        },
      }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.head).toBeNull();
    expect(r.sourceProblem).toContain('读不到 PR');
    expect(r.status.description).toContain('gh api 404');
    expect(rec.posted).toEqual([]); // 连头都没有，贴不了（照实报出来）
  });

  it('读不到单子 → 贴上 failure（头有，必须贴：不贴=闸判「还没验」）', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources({
        spec: async () => {
          throw new Error('需求文档目录读不出来');
        },
      }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.sourceProblem).toContain('读不到单子');
    expect(rec.posted.map((x) => x.state)).toEqual(['pending', 'failure']);
    expect(rec.posted.at(-1)).toEqual(
      expect.objectContaining({ prNumber: 42, head: HEAD, state: 'failure' }),
    );
    expect(rec.posted.at(-1)?.description).toContain('需求文档目录读不出来');
  });

  it('读不到作者族 → 贴 failure（认不出就挑不出「不同族」，硬跑就是同族自审）', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources({
        authors: async () => {
          throw new Error('库里查不到这张单起过哪个族的会话');
        },
      }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.sourceProblem).toContain('读不到单子');
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('作者族认不出（不在 0006 那五个里）→ 贴 failure，不硬跑', async () => {
    const rec = recorder();
    let invoked = 0;
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['gemini'] }),
      invoke: async (input, deps) => {
        invoked += 1;
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.status.description).toContain('认不出');
    expect(invoked).toBe(0); // 压根没起调用
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】拉 diff 时炸了 → 贴 failure、算「没验成」（sourceProblem 有值）', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources({
        diff: async () => {
          throw new Error('读 PR 的 diff 超时');
        },
      }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.sourceProblem).toContain('读不到 diff');
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】没有家族可挑 → 贴 failure、算「没验成」', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: async () => undefined,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.status.description).toContain('没讨论成');
    expect(r.sourceProblem).toContain('没讨论成');
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】冷调用本体抛错（起进程炸了）→ 贴 failure', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: async () => {
        throw new Error('spawn EACCES');
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.status.description).toContain('spawn EACCES');
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】贴状态本身失败 → 抛出去，不当成「验过了」（闸看不到就是没验过）', async () => {
    await expect(
      runColdVerifyForPr(42, {
        sources: sources(),
        invoke: invokeVerifier,
        oneShot: ONE_SHOT,
        chooseModelForFamily: PICK_CLAUDE,
        cwd: 'C:/work/x',
        writeStatus: async () => {
          throw new Error('GitHub 回了 403');
        },
      }),
    ).rejects.toThrow('GitHub 回了 403');
  });
});

describe('runColdVerifyForPr：作者族是一张表；开跑前先贴 pending；过一会儿再来的不贴 failure', () => {
  it('写过这张单的族不止一个：全部跳过再选（先 gpt 后 claude 写的 → 验的是 deepseek，前两家压根没被问）', async () => {
    const asked: string[] = [];
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['gpt', ' Claude '] }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: async (family) => {
        asked.push(family);
        return family === 'deepseek' ? { modelId: 'ds-x' } : undefined;
      },
      cwd: 'C:/work/x',
    });
    expect(r.status.state).toBe('success');
    expect(asked).toEqual(['deepseek']);
  });

  it('【故意造出的失败】一个作者族都没记下 → 贴 failure、不起调用（不知道该避开谁，就没法保证换了家族）', async () => {
    const rec = recorder();
    let invoked = 0;
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => [] }),
      invoke: async (input, deps) => {
        invoked += 1;
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.status.description).toContain('没有记下是哪一族写的');
    expect(r.sourceProblem).toContain('作者族认不出');
    expect(invoked).toBe(0);
    expect(rec.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】作者族里有一个认不出（claude + gemini）→ 贴 failure、不起调用：认不出的可能就是某个已知族的别名', async () => {
    const rec = recorder();
    let invoked = 0;
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['claude', 'gemini'] }),
      invoke: async (input, deps) => {
        invoked += 1;
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('failure');
    expect(r.status.description).toContain('gemini');
    expect(invoked).toBe(0);
  });

  it('【故意造出的失败】开跑前那条 pending 贴不上 → 抛出去，一次模型调用都没起（别花一次调用再发现结论贴不上）', async () => {
    let invoked = 0;
    await expect(
      runColdVerifyForPr(42, {
        sources: sources(),
        invoke: async (input, deps) => {
          invoked += 1;
          return await invokeVerifier(input, deps);
        },
        oneShot: ONE_SHOT,
        chooseModelForFamily: PICK_CLAUDE,
        cwd: 'C:/work/x',
        writeStatus: async () => {
          throw new Error('没有 statuses 写权限');
        },
      }),
    ).rejects.toThrow('没有 statuses 写权限');
    expect(invoked).toBe(0);
  });

  it('waitReason 认出「过一会儿再来」（内存放不下没派出去）→ 贴 pending 写明在等什么，不贴 failure，也不算 sourceProblem', async () => {
    const rec = recorder();
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: async (input) => ({
        pass: false,
        problems: ['冷调用没跑成：outcome=admission_blocked，不是 done'],
        round: input.round,
        session: { runId: 'run-1', outcome: 'admission_blocked', family: 'claude', modelId: 'claude-x' },
      }),
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
      waitReason: (v) => (v.session?.outcome === 'admission_blocked' ? '机器内存放不下新会话' : undefined),
    });
    expect(r.status.state).toBe('pending');
    expect(r.wait).toBe('机器内存放不下新会话');
    expect(r.sourceProblem).toBeUndefined();
    expect(rec.posted.map((x) => x.state)).toEqual(['pending', 'pending']);
    expect(rec.posted.at(-1)?.description).toContain('机器内存放不下新会话');
  });

  it('waitReason 没认出（验了、没过）→ 照常贴 failure，不被当成「在等」', async () => {
    const rec = recorder();
    const failShot = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', '- 没做到验收条：单子要 A、代码做了 B', '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: invokeVerifier,
      oneShot: failShot,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
      waitReason: (v) => (v.session?.outcome === 'admission_blocked' ? '机器内存放不下新会话' : undefined),
    });
    expect(r.status.state).toBe('failure');
    expect(r.wait).toBeUndefined();
  });
});
