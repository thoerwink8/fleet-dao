// 装配入口（#555-2）的测试：取三样 → 起一次冷调用 → 贴上状态。
//
// 这一份钉死的规矩：**读了什么、卡在哪一步，都要变成贴上 GitHub 的那条状态**，绝不「什么都不贴」或「贴成成功」。
// 三条故意造出失败的路都单独测：读不到 PR、读不到单子、认不出作者族——读不到 PR 连头都没有（贴不了，照实报）；
// 后两种头是有的，**必须贴上 failure**（不贴 = 合并闸判「还没验」，人一直等一个不会来的结论）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ColdVerifySpec, runColdVerifyForPr } from '../src/cold-verify-run.ts';
import type { RunRecord, RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  type ChooseModelForFamily,
  invokeVerifier,
  type VerifierInvokeInput,
  type VerifierInvokeOutput,
} from '../src/verifier-invoke.ts';
import { runChildOk } from './child.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const TASK_ID = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69';

const MODEL_PASS = ['## 问题', '（没有）', '', 'verdict: pass'].join('\n');

// 一次性调用把 stdout / stderr 落在 tmpDir 下：放系统临时目录，测完删掉，别在当前目录留垃圾。
const TMP_DIR = mkdtempSync(join(tmpdir(), 'fleet-555-2-run-test-'));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function fakeOneShot(scripted: SpawnOutcome): OneShotDeps {
  const runs: RunsWriter = { async start() {}, async record(_r: RunRecord) {} };
  return {
    spawn: async () => scripted,
    buildCommand: (input) => ({ argv: ['fake-executor', '--model', input.modelId], cwd: input.cwd }),
    runs,
    tmpDir: TMP_DIR,
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
  spec?: () => Promise<ColdVerifySpec>;
  authors?: () => Promise<string[]>;
}) {
  return {
    pr: o.pr ?? (async () => ({ head: HEAD, baseSha: BASE, branch: 'feat/x' })),
    diff: o.diff ?? (async () => ({ diffText: '@@ -1,1 +1,1 @@\n-old\n+new', changedFiles: ['foo.ts'] })),
    spec:
      o.spec ??
      (async () => ({
        taskId: TASK_ID,
        issueNumber: 12,
        workflowId: 'task:acme/demo#12',
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

/** 用假的 invoke 记下交给冷调用的入参：看作者族怎么翻成避让和 requireTwoFamilies。 */
async function invokeWithAuthors(authors: string[]) {
  const rec = recorder();
  const seen: VerifierInvokeInput[] = [];
  const r = await runColdVerifyForPr(42, {
    sources: sources({ authors: async () => authors }),
    invoke: async (input) => {
      seen.push(input);
      return { pass: true, problems: [], round: input.round } as VerifierInvokeOutput;
    },
    oneShot: ONE_SHOT,
    chooseModelForFamily: PICK_CLAUDE,
    cwd: 'C:/work/x',
    writeStatus: rec.writeStatus,
  });
  return { r, seen, rec };
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

  it('单子是哪张（tasks.id、单号、工作流编号）连同 PR 号、分支原样交给冷调用：验收那一笔记进 runs 挂得上单（#216）', async () => {
    const seen: VerifierInvokeInput[] = [];
    const r = await runColdVerifyForPr(42, {
      sources: sources(),
      invoke: async (input, deps) => {
        seen.push(input);
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
    });
    expect(r.status.state).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskId: TASK_ID,
      issueNumber: 12,
      workflowId: 'task:acme/demo#12',
      prNumber: 42,
      branch: 'feat/x',
    });
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

  it('(f) 作者族认不出（cursor）→ 不停下，照常调用，requireTwoFamilies 为 true、避让族为空', async () => {
    const { r, seen, rec } = await invokeWithAuthors(['cursor']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requireTwoFamilies).toBe(true);
    expect(seen[0]?.modelFamiliesAvoid).toEqual([]);
    expect(r.status.description).not.toContain('作者族认不出');
    expect(r.sourceProblem).toBeUndefined();
    expect(rec.posted.at(-1)?.state).toBe('success');
  });

  it('(g) 作者族是 grok 加 cursor → 避让只放 grok，requireTwoFamilies 为 true', async () => {
    const { seen } = await invokeWithAuthors(['grok', 'cursor']);
    expect(seen[0]?.modelFamiliesAvoid).toEqual(['grok']);
    expect(seen[0]?.requireTwoFamilies).toBe(true);
  });

  it('(h) 作者族是 grok → 不带 requireTwoFamilies，和以前一样', async () => {
    const { seen } = await invokeWithAuthors(['grok']);
    expect(seen[0]?.modelFamiliesAvoid).toEqual(['grok']);
    expect(seen[0]?.requireTwoFamilies).toBeUndefined();
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
  it('写过这张单的族不止一个：全部跳过再选（先 gpt 后 claude 写的 → 先问 grok 没有、再到 deepseek，gpt、claude 压根没被问）', async () => {
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
    expect(asked).toEqual(['grok', 'deepseek']);
  });

  it('一个作者族都没记下 → 不停下，照常调用，requireTwoFamilies 为 true', async () => {
    const { r, seen } = await invokeWithAuthors([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requireTwoFamilies).toBe(true);
    expect(seen[0]?.modelFamiliesAvoid).toEqual([]);
    expect(r.sourceProblem).toBeUndefined();
  });

  it('作者族里有一个认不出（claude + cursor）→ 避让只放 claude，两家都验', async () => {
    const { r, seen } = await invokeWithAuthors(['claude', 'cursor']);
    expect(seen[0]?.modelFamiliesAvoid).toEqual(['claude']);
    expect(seen[0]?.requireTwoFamilies).toBe(true);
    expect(r.status.state).toBe('success');
  });

  it('作者是 glm（目录里有、不是验收族）→ 起得了验收，验收人不是 glm，避让名单里没有 glm 也没崩', async () => {
    const rec = recorder();
    const seen: VerifierInvokeInput[] = [];
    const asked: string[] = [];
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['glm'] }),
      invoke: async (input, deps) => {
        seen.push(input);
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: async (family) => {
        asked.push(family);
        return family === 'gpt' ? { modelId: 'gpt-x' } : undefined;
      },
      cwd: 'C:/work/x',
      writeStatus: rec.writeStatus,
    });
    expect(r.status.state).toBe('success');
    expect(r.sourceProblem).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.modelFamiliesAvoid).toEqual([]);
    expect(seen[0]?.otherAuthorFamilies).toEqual(['glm']);
    expect(asked).not.toContain('glm');
    expect(asked[0]).toBe('gpt'); // 验收人从 0006 的顺序里挑，第一个就是 gpt
  });

  it('gemini、muse 作者同样认得（目录里的族）', async () => {
    for (const author of ['gemini', ' Muse ']) {
      const r = await runColdVerifyForPr(42, {
        sources: sources({ authors: async () => [author] }),
        invoke: invokeVerifier,
        oneShot: ONE_SHOT,
        chooseModelForFamily: PICK_CLAUDE,
        cwd: 'C:/work/x',
      });
      expect(r.status.state).toBe('success');
      expect(r.sourceProblem).toBeUndefined();
    }
  });

  it('glm + gpt 混合作者 → 避让 gpt（glm 不进避让），验收人不是 gpt', async () => {
    const seen: VerifierInvokeInput[] = [];
    const asked: string[] = [];
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['glm', 'gpt', 'glm'] }),
      invoke: async (input, deps) => {
        seen.push(input);
        return await invokeVerifier(input, deps);
      },
      oneShot: ONE_SHOT,
      chooseModelForFamily: async (family) => {
        asked.push(family);
        return family === 'grok' ? { modelId: 'grok-x' } : undefined;
      },
      cwd: 'C:/work/x',
    });
    expect(r.status.state).toBe('success');
    expect(seen[0]?.modelFamiliesAvoid).toEqual(['gpt']);
    expect(seen[0]?.otherAuthorFamilies).toEqual(['glm']);
    expect(asked).toEqual(['grok']); // gpt 被跳过，直接问 grok
  });

  it('glm + cursor 混合 → 照常调用，otherAuthorFamilies 带 glm，requireTwoFamilies 为 true', async () => {
    const { seen } = await invokeWithAuthors(['glm', 'cursor']);
    expect(seen[0]?.otherAuthorFamilies).toEqual(['glm']);
    expect(seen[0]?.requireTwoFamilies).toBe(true);
  });

  it('unclassified、jev、拼写不认识的串也走两家都验，不停下', async () => {
    for (const author of ['unclassified', 'jev', 'gpt5']) {
      const { r, seen } = await invokeWithAuthors([author]);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.requireTwoFamilies).toBe(true);
      expect(seen[0]?.modelFamiliesAvoid).toEqual([]);
      expect(r.sourceProblem).toBeUndefined();
    }
  });

  it('【故意造出的失败】glm 作者不得返回 sourceProblem（把 glm 当成「认不出」时这条必须红）', async () => {
    const r = await runColdVerifyForPr(42, {
      sources: sources({ authors: async () => ['glm'] }),
      invoke: invokeVerifier,
      oneShot: ONE_SHOT,
      chooseModelForFamily: PICK_CLAUDE,
      cwd: 'C:/work/x',
    });
    expect(r.sourceProblem).toBeUndefined();
    expect(r.status.description).not.toContain('认不出');
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

const NAMED_HEADING = '## 单子点名但这次没改的文件（只读，当前内容）';

function capturingShot() {
  const prompts: string[] = [];
  const base = fakeOneShot({ exitCode: 0, stdout: MODEL_PASS, stderr: '', killed: false });
  return {
    prompts,
    oneShot: {
      ...base,
      spawn: async (cmd: Parameters<typeof base.spawn>[0]) => {
        prompts.push(cmd.stdin);
        return base.spawn(cmd);
      },
    },
  };
}

async function withStateDir(dir: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env.FLEET_GITHUB_STATE_DIR;
  process.env.FLEET_GITHUB_STATE_DIR = dir;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.FLEET_GITHUB_STATE_DIR;
    else process.env.FLEET_GITHUB_STATE_DIR = prev;
  }
}

describe('runColdVerifyForPr：单子点名的文件从引擎镜像读', () => {
  it('生产接线下点名文件读失败时，验收仍返回结论而不是抛错', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'fleet-named-missing-'));
    const shot = capturingShot();
    try {
      await withStateDir(empty, async () => {
        const r = await runColdVerifyForPr(42, {
          sources: sources({
            spec: async () => ({
              taskId: TASK_ID,
              issueNumber: 12,
              workflowId: 'task:acme/demo#12',
              what: '核对端口',
              howToFinish: ['区块里的端口要和 `deploy/france.sh` 逐行对应'],
            }),
          }),
          invoke: invokeVerifier,
          oneShot: shot.oneShot,
          chooseModelForFamily: PICK_CLAUDE,
          cwd: 'C:/work/x',
        });
        expect(r.verdict?.pass).toBe(true);
        expect(r.status.state).toBe('success');
        expect(r.sourceProblem).toBeUndefined();
        const prompt = shot.prompts[0] ?? '';
        expect(prompt).toContain(NAMED_HEADING);
        expect(prompt).toContain('deploy/france.sh');
        expect(prompt).toContain('读不到');
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('生产接线读得到 PR 头上的文件时，内容进 prompt；头上没有的路径标不存在', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-named-mirror-'));
    const work = join(stateDir, 'work');
    const mirror = join(stateDir, 'mirrors', 'acme', 'demo.git');
    mkdirSync(work, { recursive: true });
    mkdirSync(join(stateDir, 'mirrors', 'acme'), { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (cwd: string, args: string[]) =>
      runChildOk('git', args, { cwd, env, encoding: 'utf8' }).trim();
    try {
      git(work, ['init', '-q', '-b', 'main']);
      mkdirSync(join(work, 'deploy'));
      writeFileSync(join(work, 'deploy', 'france.sh'), 'PORT=2201\n');
      git(work, ['add', 'deploy/france.sh']);
      git(work, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add']);
      const head = git(work, ['rev-parse', 'HEAD']);
      git(work, ['clone', '--bare', '-q', work, mirror]);
      const shot = capturingShot();
      await withStateDir(stateDir, async () => {
        const r = await runColdVerifyForPr(42, {
          sources: sources({
            pr: async () => ({ head, baseSha: BASE, branch: 'feat/x' }),
            spec: async () => ({
              taskId: TASK_ID,
              issueNumber: 12,
              workflowId: 'task:acme/demo#12',
              what: '核对端口',
              howToFinish: ['对照 `deploy/france.sh` 和 `deploy/hk.sh`'],
            }),
          }),
          invoke: invokeVerifier,
          oneShot: shot.oneShot,
          chooseModelForFamily: PICK_CLAUDE,
          cwd: 'C:/work/x',
        });
        expect(r.verdict?.pass).toBe(true);
        const prompt = shot.prompts[0] ?? '';
        expect(prompt).toContain(NAMED_HEADING);
        expect(prompt).toContain('PORT=2201');
        expect(prompt).toContain('deploy/hk.sh');
        expect(prompt).toContain('这个路径在 PR 头上不存在');
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
