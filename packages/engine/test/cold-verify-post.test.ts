// 冷调用这一遍的**每条「读不到」都要变成 failure 状态**（#555-2；通用段底线第三条：不许拿空、0 或 ok 冒充没事）。
//
// 这一份和 cold-verify-status.test.ts 的分工：那一份测「结论 → 状态」的翻译和轮数；这一份把 **verifier-invoke
// 真的接进来**（不是 fake invoke），逐条制造它的每一条明确失败路径，断言最后贴在 GitHub 上的那条状态是
// failure、而且描述里写明卡在哪一步。少一条这样的测试，「读不到就当过了」就会悄悄回来——它是本切片最贵的错。

import { describe, expect, it } from 'vitest';
import { runColdVerifyAndPost } from '../src/cold-verify-post.ts';
import type { RunRecord, RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  type ChooseModelForFamily,
  FAMILY_ORDER,
  type FetchDiff,
  type FetchSpec,
  invokeVerifier,
  type ModelFamily,
  type VerifierInvokeInput,
} from '../src/verifier-invoke.ts';

const HEAD = 'a'.repeat(40);
const INPUT: VerifierInvokeInput = {
  prNumber: 42,
  branch: 'feat/x',
  baseSha: 'b'.repeat(40),
  taskId: '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69',
  issueNumber: 12,
  what: '要 A',
  howToFinish: ['代码里有 A'],
  modelFamiliesAvoid: ['gpt'],
  round: 1,
};

const MODEL_PASS = ['## 问题', '（没有）', '', 'verdict: pass'].join('\n');
const MODEL_FAIL = ['## 问题', '- 没做到验收条：单子要 A、代码做了 B', '', 'verdict: fail'].join('\n');

function fakeOneShot(scripted: SpawnOutcome): OneShotDeps {
  const runs: RunsWriter = {
    async start() {},
    async record(_r: RunRecord) {},
  };
  return {
    spawn: async () => scripted,
    buildCommand: (input) => ({ argv: ['fake-executor', '--model', input.modelId], cwd: input.cwd }),
    runs,
    tmpDir: 'C:/temp/fleet-555-2-test',
  };
}

const OK_DIFF: FetchDiff = async () => ({
  diffText: '@@ -1,1 +1,1 @@\n-old\n+new',
  changedFiles: ['foo.ts'],
});
const OK_SPEC: FetchSpec = async () => ({ specDir: 'specs/42-做A/' });
const PICK_CLAUDE: ChooseModelForFamily = async (family: ModelFamily) =>
  family === 'claude' ? { modelId: 'claude-x' } : undefined;

/** 起一次真调用（invokeVerifier 本体）、把结论经装配侧贴出去，回这次写上的状态。 */
async function postWith(
  deps: {
    fetchDiff?: FetchDiff;
    fetchSpec?: FetchSpec;
    choose?: ChooseModelForFamily;
    scripted?: SpawnOutcome;
  } = {},
): Promise<{ state: string; description: string }> {
  const written: { state: string; description: string }[] = [];
  const out = await runColdVerifyAndPost(
    INPUT,
    { prNumber: 42, head: HEAD },
    {
      invoke: (input) =>
        invokeVerifier(input, {
          oneShot: fakeOneShot(
            deps.scripted ?? { exitCode: 0, stdout: MODEL_PASS, stderr: '', killed: false },
          ),
          fetchDiff: deps.fetchDiff ?? OK_DIFF,
          fetchSpec: deps.fetchSpec ?? OK_SPEC,
          chooseModelForFamily: deps.choose ?? PICK_CLAUDE,
          cwd: 'C:/work/x',
        }),
      writeStatus: async ({ status }) => {
        written.push({ state: status.state, description: status.description });
      },
    },
  );
  expect(written).toHaveLength(1);
  const one = written[0] as { state: string; description: string };
  expect(out.status.state).toBe(one.state);
  return one;
}

describe('冷调用的每条「读不到」都变成 failure 状态，不许吞成通过', () => {
  it('基线：拉得到 diff、挑得出别家、模型说 pass → success', async () => {
    const s = await postWith();
    expect(s.state).toBe('success');
  });

  it('模型说 fail（单子要 A、代码做了 B）→ failure，描述里带那条问题', async () => {
    const s = await postWith({
      scripted: { exitCode: 0, stdout: MODEL_FAIL, stderr: '', killed: false },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('没做到验收条');
  });

  it('【故意造出的失败】拉不到 diff（fetchDiff 抛）→ failure，写明读不到 diff', async () => {
    const s = await postWith({
      fetchDiff: async () => {
        throw new Error('gh api 401');
      },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('读不到 diff');
    expect(s.description).toContain('gh api 401');
  });

  it('【故意造出的失败】diff 是空的 → failure（不许拿「没改动所以没挡的」当通过）', async () => {
    const s = await postWith({ fetchDiff: async () => ({ diffText: '  \n ', changedFiles: ['x.ts'] }) });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('空 diff');
  });

  it('【故意造出的失败】changedFiles 是空的 → failure（没改任何文件就是没干活）', async () => {
    const s = await postWith({ fetchDiff: async () => ({ diffText: '@@ -1 +1 @@', changedFiles: [] }) });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('空 changedFiles');
  });

  it('【故意造出的失败】拉不到单子（fetchSpec 抛）→ failure，写明读不到单子', async () => {
    const s = await postWith({
      fetchSpec: async () => {
        throw new Error('db down');
      },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('读不到单子');
    expect(s.description).toContain('db down');
  });

  it('【故意造出的失败】跳过作者族之后一家都没有 → failure，写明没讨论成（不许拿默认模型顶上）', async () => {
    const asked: string[] = [];
    const s = await postWith({
      choose: async (family) => {
        asked.push(family);
        return undefined;
      },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('没讨论成');
    // 先按 0006 的顺序问别家；都挑不出才改两家都验，轮到被避开的作者族 gpt（也挑不出）
    expect(asked).toEqual([...FAMILY_ORDER.filter((f) => f !== 'gpt'), 'gpt']);
  });

  it('【故意造出的失败】冷调用根本没跑成（进程 exit=1、stdout 空）→ failure', async () => {
    const s = await postWith({
      scripted: { exitCode: 1, stdout: '', stderr: 'crashed', killed: false },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('冷调用没跑成');
  });

  it('【故意造出的失败】结论行没说清 pass/fail → failure（不许猜）', async () => {
    const s = await postWith({
      scripted: { exitCode: 0, stdout: '我看了 diff，还行吧', stderr: '', killed: false },
    });
    expect(s.state).toBe('failure');
    expect(s.description).toContain('冷调用没跑成');
  });
});
