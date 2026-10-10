// verifier-invoke.ts 行为测试：#555-1 验收段冷调用。
//
// happy path / 模型判 fail（没做到验收条、弄坏原有功能）→ 各自形状对；
// 故意造红的每一种——fetchDiff 抛错 / fetchDiff 返回空 / fetchSpec 抛错 / 全家族挑不出 → 必须 pass=false +
// problems 写明哪一步查不到（不许拿「查不到」当「没挡的」、不许拿默认模型顶上）。这是 specs/555 第 3 条
// （只有三种能挡）和第 4 条（读不到 PR 必填栏就明确失败）的钉子。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunRecord, RunStart, RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnCommand, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  BLOCKER_KINDS,
  type ChooseModelForFamily,
  FAMILY_ORDER,
  type FetchDiff,
  type FetchNamedFiles,
  type FetchSpec,
  invokeVerifier,
  type ModelFamily,
  namedPathsOutsideDiff,
  readVerdict,
  type VerifierInvokeInput,
} from '../src/verifier-invoke.ts';

/** 默认的「跑通了 + 模型说 pass」fake spawner 输出。 */
const MODEL_STDOUT_PASS = ['我看了单子、查了 diff。', '', '## 问题', '（没有）', '', 'verdict: pass'].join(
  '\n',
);

/** 模型判 fail：说要 A 做了 B（BLOCKER_KINDS[0]）。 */
const MODEL_STDOUT_FAIL_NOT_DONE = [
  '我看了单子、查了 diff。',
  '',
  '## 问题',
  `- ${BLOCKER_KINDS[0]}：单子要 A、代码做了 B（证据：diff 第 3 行把 A 改成了 B）`,
  '',
  'verdict: fail',
].join('\n');

/** 模型判 fail：弄坏了原有功能（BLOCKER_KINDS[1]）。 */
const MODEL_STDOUT_FAIL_BREAKS = [
  '我看了单子、查了 diff。',
  '',
  '## 问题',
  `- ${BLOCKER_KINDS[1]}：原来 exports.foo 是 string，这个 diff 把它改成了 number，调用方 packages/api/src/x.ts 还在按 string 用`,
  '',
  'verdict: fail',
].join('\n');

/** 模型提了风格意见（不该进 problems，应该被丢掉）。 */
const MODEL_STDOUT_PASS_WITH_STYLE = [
  '我看了单子、查了 diff。',
  '',
  '## 问题',
  '- 命名可以更一致一点（风格意见，specs/555 不许算挡）',
  '- 这块代码可以更短（风格意见）',
  '',
  'verdict: pass',
].join('\n');

const TASK_ID = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69';

const BASE_INPUT: VerifierInvokeInput = {
  prNumber: 42,
  branch: 'feat/x',
  baseSha: 'a'.repeat(40),
  taskId: TASK_ID,
  issueNumber: 12,
  workflowId: 'task:acme/demo#12',
  what: '要 A',
  howToFinish: ['1. 代码里有 A', '2. 还把 B 留着'],
  modelFamiliesAvoid: ['gpt'],
  round: 1,
};

const FAKE_DIFF_OK = {
  diffText: '@@ -1,1 +1,1 @@\n-old\n+new',
  changedFiles: ['foo.ts'],
};

// 一次性调用把 stdout / stderr 落在 tmpDir 下：放系统临时目录，测完删掉，别在当前目录留垃圾。
const TMP_DIR = mkdtempSync(join(tmpdir(), 'fleet-555-1-test-'));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function fakeOneShot(scripted: SpawnOutcome): {
  oneShot: OneShotDeps;
  recorded: RunRecord[];
  started: RunStart[];
  spawnedArgv: string[];
  commands: SpawnCommand[];
} {
  const spawnedArgv: string[] = [];
  const commands: SpawnCommand[] = [];
  const recorded: RunRecord[] = [];
  const started: RunStart[] = [];
  const runs: RunsWriter = {
    async start(r: RunStart) {
      started.push(r);
    },
    async record(r: RunRecord) {
      recorded.push(r);
    },
  };
  const oneShot: OneShotDeps = {
    spawn: async (cmd) => {
      commands.push(cmd);
      spawnedArgv.push(cmd.argv.join(' '));
      return scripted;
    },
    buildCommand: (input) => ({
      argv: ['fake-executor', '--model', input.modelId],
      cwd: input.cwd,
    }),
    runs,
    tmpDir: TMP_DIR,
  };
  return { oneShot, recorded, started, spawnedArgv, commands };
}

function okFetchDiff(): FetchDiff {
  return async () => FAKE_DIFF_OK;
}
function okFetchSpec(): FetchSpec {
  return async () => ({ specDir: 'specs/42-做A/' });
}
function fixedChoose(
  map: Partial<Record<ModelFamily, { modelId: string; channel?: string; routeId?: string }>>,
): ChooseModelForFamily {
  return async (family) => map[family];
}

describe('invokeVerifier：happy path', () => {
  it('模型说 pass，diff 拉到了，家族跳过了 gpt → pass=true、problems=[]', async () => {
    const { oneShot, recorded } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const chosen: ModelFamily[] = [];
    const choose: ChooseModelForFamily = async (family) => {
      chosen.push(family);
      if (family === 'claude') return { modelId: 'claude-x', channel: 'cli' };
      return undefined; // 其它都不可用
    };
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: choose,
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.round).toBe(1);
    expect(out.notes ?? '').toContain('claude');
    // 家族选择顺序：跳过 gpt（avoid），第一家问 gpt 之后的 grok（grok 没有，再问 claude）
    expect(chosen.slice(0, 2)).toEqual(['grok', 'claude']);
    // runs 记了一笔
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.segment).toBe('verify');
    expect(recorded[0]?.model).toBe('claude-x');
    expect(recorded[0]?.outcome).toBe('done');
  });

  it('模型说 pass：diff 拉到了、家族照 0006 顺序挑（avoid = claude → 第一家是 gpt）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const chosen: ModelFamily[] = [];
    const choose: ChooseModelForFamily = async (family) => {
      chosen.push(family);
      if (family === 'gpt') return { modelId: 'gpt-1' };
      return undefined;
    };
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['claude'] },
      {
        oneShot,
        fetchDiff: okFetchDiff(),
        fetchSpec: okFetchSpec(),
        chooseModelForFamily: choose,
        cwd: 'C:/work/x',
      },
    );
    expect(out.pass).toBe(true);
    expect(chosen).toEqual(['gpt']); // 第一个问的就是 gpt、claude 跳过了
  });

  it('顺序钉死（2026-10-05 起 gpt、grok 在前）', () => {
    expect([...FAMILY_ORDER]).toEqual(['gpt', 'grok', 'claude', 'deepseek', 'kimi']);
  });

  it('0006 顺序 + avoid = kimi：应该挑 gpt → grok → claude → deepseek，kimi 不出现', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const chosen: ModelFamily[] = [];
    // 都不给：让所有 family 都被问一遍、然后回等待（一个模型都派不出，#1731）
    const choose: ChooseModelForFamily = async (family) => {
      chosen.push(family);
      return undefined;
    };
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['kimi'] },
      {
        oneShot,
        fetchDiff: okFetchDiff(),
        fetchSpec: okFetchSpec(),
        chooseModelForFamily: choose,
        cwd: 'C:/work/x',
      },
    );
    expect(out.pass).toBe(false);
    expect(out.routeWait?.reason).toContain('一个模型都派不出');
    // 其余四个按 FAMILY_ORDER 顺序都问了一遍；都挑不出才改两家都验，轮到避开的 kimi（也挑不出）
    expect(chosen).toEqual([...FAMILY_ORDER.filter((f) => f !== 'kimi'), 'kimi']);
  });
});

describe('invokeVerifier：模型判 fail（三种能挡之一 → problems 必带）', () => {
  it('说要 A、做了 B（BLOCKER_KINDS[0] 没做到验收条）→ pass=false、problems 至少 1 条带这个 kind', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_FAIL_NOT_DONE,
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['gpt'] },
      {
        oneShot,
        fetchDiff: okFetchDiff(),
        fetchSpec: okFetchSpec(),
        chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
        cwd: 'C:/work/x',
      },
    );
    expect(out.pass).toBe(false);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems[0]).toContain(BLOCKER_KINDS[0]);
  });

  it('有证据弄坏原有功能（BLOCKER_KINDS[1]）→ pass=false、problems 至少 1 条带这个 kind', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_FAIL_BREAKS,
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems[0]).toContain(BLOCKER_KINDS[1]);
  });

  it('模型顺手写了风格意见（不是三种能挡的开头）→ 被丢掉，不进 problems', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS_WITH_STYLE,
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]); // 风格意见不许算挡
  });
});

describe('invokeVerifier：故意造红 → 必须明确失败（不许拿「查不到」当「没挡的」）', () => {
  it('fetchDiff 抛错 → pass=false、problems 写明读不到 diff', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const failingFetchDiff: FetchDiff = async () => {
      throw new Error('gh api 401');
    };
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: failingFetchDiff,
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).toContain('读不到 diff');
    expect(out.problems.join('\n')).toContain('gh api 401');
  });

  it('fetchDiff 返回空 diffText → pass=false、problems 写明空 diff', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const emptyDiff: FetchDiff = async () => ({ diffText: '   ', changedFiles: ['foo.ts'] });
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: emptyDiff,
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).toContain('空 diff');
  });

  it('fetchDiff 返回空 changedFiles → pass=false、problems 写明空 changedFiles', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const emptyFiles: FetchDiff = async () => ({ diffText: '@@ -1 +1 @@\n-a\n+b', changedFiles: [] });
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: emptyFiles,
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).toContain('空 changedFiles');
  });

  it('fetchSpec 抛错 → pass=false、problems 写明读不到单子', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const failingFetchSpec: FetchSpec = async () => {
      throw new Error('db down');
    };
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: failingFetchSpec,
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).toContain('读不到单子');
    expect(out.problems.join('\n')).toContain('db down');
  });

  it('全家族挑不出（avoid + 剩下全 undefined）→ pass=false、回等待（一个模型都派不出），不回没讨论成（#1731）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const nothingAvailable: ChooseModelForFamily = async () => undefined;
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: nothingAvailable,
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.routeWait?.reason).toContain('一个模型都派不出');
    expect(out.problems.join('\n')).not.toContain('没讨论成');
    expect(out.session).toBeUndefined();
    // 别拿默认模型顶上
    expect(out.problems.join('\n')).not.toContain('gpt-x');
  });

  it('one-shot outcome != done（fake exit=1）→ pass=false、problems 写明没跑成（不让空当 pass）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 1,
      stdout: '',
      stderr: 'process crashed',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, {
      oneShot,
      fetchDiff: okFetchDiff(),
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: fixedChoose({ claude: { modelId: 'claude-x' } }),
      cwd: 'C:/work/x',
    });
    expect(out.pass).toBe(false);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems.join('\n')).toContain('冷调用没跑成');
  });
});

const DEPS = (
  oneShot: OneShotDeps,
  choose: ChooseModelForFamily = fixedChoose({ claude: { modelId: 'claude-x' } }),
) => ({
  oneShot,
  fetchDiff: okFetchDiff(),
  fetchSpec: okFetchSpec(),
  chooseModelForFamily: choose,
  cwd: 'C:/work/x',
});

describe('invokeVerifier：写过这张单的族不止一个、路由编号、会话结局', () => {
  it('先 gpt 后 claude 写的：两族都跳过，顺序里 grok 没有、下一个是 deepseek（gpt、claude 不被问）', async () => {
    const { oneShot } = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const asked: ModelFamily[] = [];
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['gpt', 'claude'] },
      DEPS(oneShot, async (family) => {
        asked.push(family);
        return family === 'deepseek' ? { modelId: 'ds-x' } : undefined;
      }),
    );
    expect(out.pass).toBe(true);
    expect(asked).toEqual(['grok', 'deepseek']);
    expect(out.session?.family).toBe('deepseek');
  });

  it('【故意造出的失败】一个作者族都不给 → 输入就不合格，抛出来（不知道该避开谁，不许当成「谁都可以」）', async () => {
    const { oneShot } = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    await expect(invokeVerifier({ ...BASE_INPUT, modelFamiliesAvoid: [] }, DEPS(oneShot))).rejects.toThrow();
  });

  it('剩下的族全被避开、且一家都派不出 → 回等待（一个模型都派不出，过一会儿重来），不回没讨论成（#1731）', async () => {
    const { oneShot } = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: [...FAMILY_ORDER] },
      DEPS(oneShot, async () => undefined),
    );
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).not.toContain('没讨论成');
    expect(out.routeWait).toEqual({
      families: [],
      reason: expect.stringContaining('一个模型都派不出，过一会儿重来'),
    });
    expect(out.session).toBeUndefined(); // 没起会话
  });

  it('选中的路由编号、渠道进 one-shot 的入参（生产 Spawner 靠 routeId 查执行方式和会话用户）；会话结局带回来', async () => {
    const { oneShot, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(
      BASE_INPUT,
      DEPS(
        oneShot,
        fixedChoose({ claude: { modelId: 'claude-x', channel: 'pool-a', routeId: 'route-claude-1' } }),
      ),
    );
    expect(commands[0]?.input).toMatchObject({
      segment: 'verify',
      routeId: 'route-claude-1',
      channel: 'pool-a',
      modelId: 'claude-x',
    });
    expect(out.session).toMatchObject({
      outcome: 'done',
      family: 'claude',
      modelId: 'claude-x',
      routeId: 'route-claude-1',
    });
    expect(out.session?.runId).toBeTruthy();
  });

  it('喂给模型的提示词里三种能挡的开头是真文字，不是没替换的占位符；也说清了手上没有仓库检出', async () => {
    const { oneShot, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    const prompt = commands[0]?.stdin ?? '';
    expect(prompt).not.toContain('${');
    for (const kind of BLOCKER_KINDS) expect(prompt).toContain(`- ${kind}：`);
    expect(prompt).toContain('没有仓库的检出');
    expect(prompt).toContain('verdict: pass');
  });
});

describe('invokeVerifier：这一次验收记进 runs 挂得上单（#216）', () => {
  it('开跑那一行、收场那一笔都带 tasks.id、单号、工作流编号、PR 号、分支；验收是冷调用，不带派工档', async () => {
    const { oneShot, started, recorded } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    const owner = {
      segment: 'verify',
      taskId: TASK_ID,
      issueNumber: 12,
      workflowId: 'task:acme/demo#12',
      prNumber: 42,
      branch: 'feat/x',
    };
    expect(started).toEqual([expect.objectContaining(owner)]);
    expect(recorded).toEqual([expect.objectContaining({ ...owner, outcome: 'done' })]);
    expect(started[0]).not.toHaveProperty('tier');
    expect(recorded[0]).not.toHaveProperty('tier');
  });

  it('不在任务工作流里验的（没给工作流编号）：这一列不写，不拿空串顶', async () => {
    const { oneShot, recorded } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const { workflowId: _drop, ...noWorkflow } = BASE_INPUT;
    await invokeVerifier(noWorkflow, DEPS(oneShot));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).not.toHaveProperty('workflowId');
    expect(recorded[0]).toMatchObject({ taskId: TASK_ID, issueNumber: 12 });
  });

  it('【故意造出的失败】没给单号：一进来就报错，不拉 diff、不挑模型、不起会话，runs 里一笔不记', async () => {
    const { oneShot, started, recorded, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    let diffs = 0;
    let picks = 0;
    const { issueNumber: _drop, ...noIssue } = BASE_INPUT;
    const err = await invokeVerifier(noIssue as VerifierInvokeInput, {
      oneShot,
      fetchDiff: async () => {
        diffs += 1;
        return FAKE_DIFF_OK;
      },
      fetchSpec: okFetchSpec(),
      chooseModelForFamily: async () => {
        picks += 1;
        return { modelId: 'claude-x' };
      },
      cwd: 'C:/work/x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain('issueNumber');
    expect([diffs, picks, commands.length, started.length, recorded.length]).toEqual([0, 0, 0, 0, 0]);
  });

  it('【故意造出的失败】taskId 不是库里 tasks.id 的样子（不是 uuid）：一进来就报错、不起会话，免得记一笔挂不上单的', async () => {
    const { oneShot, started, recorded, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    await expect(invokeVerifier({ ...BASE_INPUT, taskId: 'task-1' }, DEPS(oneShot))).rejects.toThrow(
      /taskId/,
    );
    expect([commands.length, started.length, recorded.length]).toEqual([0, 0, 0]);
  });
});

describe('invokeVerifier：结论不自相矛盾、不含糊（拿不准的一律不放行）', () => {
  it.each([
    ['verdict: pass', 'pass'],
    ['verdict: fail', 'fail'],
    ['  **verdict: pass**  ', 'pass'],
    ['`verdict: fail`', 'fail'],
    ['Verdict：PASS。', 'pass'],
  ])('readVerdict(%j) → %s', (line, want) => {
    expect(readVerdict(line)).toBe(want);
  });

  it.each([
    'verdict: not pass',
    'verdict: pass or fail',
    'verdict: pass, fail',
    'pass',
    '结论：通过',
    'verdict:',
    '',
  ])('【故意造出的失败】readVerdict(%j) → null（不是固定写法）', (line) => {
    expect(readVerdict(line)).toBeNull();
  });

  it('结论行写成「verdict: not pass」→ 冷调用没跑成（judgeVerify 只看有没有 pass 这个词，这里不放）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', '', 'verdict: not pass'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems[0]).toContain('冷调用没跑成');
    expect(out.problems[0]).toContain('固定写法');
  });

  it('写 pass 但问题清单里还有算挡的 → 不过（自相矛盾的结论不放行），问题原样带出', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${BLOCKER_KINDS[2]}：删库脚本没加确认`, '', 'verdict: pass'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKER_KINDS[2]}：删库脚本没加确认`]);
    expect(out.notes).toContain('自相矛盾');
  });

  it('问题后面的结论行、空行之后的段落不并进问题的文字里（只有紧跟在某一条后面的续行才并回去）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: [
        '## 问题',
        `- ${BLOCKER_KINDS[0]}：单子要 A`,
        '  代码里没有 A（续行）',
        '',
        '补充说明一段话。',
        '',
        'verdict: fail',
      ].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：单子要 A 代码里没有 A（续行）`]);
  });

  it('写 fail 但「## 问题」里一条算挡的都没有（只有风格意见）→ 冷调用没跑成：要人看，不当成过，也不让写代码的会话白改', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', '- 命名不好看', '- 函数太长', '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('冷调用没跑成');
    expect(out.problems[0]).toContain('写了 2 条不算挡的意见');
  });

  it('写 fail 且「## 问题」整段都没写 → 同样是冷调用没跑成，写明它一条都没写', async () => {
    const { oneShot } = fakeOneShot({ exitCode: 0, stdout: 'verdict: fail', stderr: '', killed: false });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems[0]).toContain('冷调用没跑成');
    expect(out.problems[0]).toContain('一条都没写');
  });

  it('会话没跑成：执行体报的原因码和原话（额度用完）写进问题里，人一眼看得出怎么回事；结局带回来', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 1,
      stdout: '',
      stderr: 'quota',
      killed: false,
      facts: { reason: 'quota_exhausted', detail: '这个号的额度用完了', quotaExhausted: true },
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems[0]).toContain('冷调用没跑成');
    expect(out.problems[0]).toContain('原因码 quota_exhausted');
    expect(out.problems[0]).toContain('这个号的额度用完了');
    expect(out.session?.outcome).toBe('failed');
  });
});

const NAMED_HEADING = '## 单子点名但这次没改的文件（只读，当前内容）';

function promptOf(commands: { stdin: string }[]): string {
  return commands[0]?.stdin ?? '';
}

/** 「改了哪些文件」之后、diff 之前的那一节。没有这一节就是空串。 */
function namedSection(prompt: string): string {
  const start = prompt.indexOf(NAMED_HEADING);
  const end = prompt.indexOf('## diff（unified patch）');
  if (start < 0 || end < 0 || end < start) return '';
  return prompt.slice(start, end);
}

const PASS_SHOT = { exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false } as const;

describe('invokeVerifier：单子点名但这次没改的文件', () => {
  it('howToFinish 点名了 deploy/france.sh 而 diff 没改它时，传给模型的 prompt 含这一节和该文件内容', async () => {
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    const seen: string[][] = [];
    const fetchNamedFiles: FetchNamedFiles = async (paths) => {
      seen.push(paths);
      return paths.map((path) => ({
        path,
        kind: 'content',
        content: path === 'deploy/france.sh' ? 'PORT=2201\n' : 'export const y = 1;\n',
      }));
    };
    const out = await invokeVerifier(
      {
        ...BASE_INPUT,
        what: '对照 deploy/hk.sh（没有反引号）和 `foo.ts`。',
        howToFinish: ['区块里的端口要和 `deploy/france.sh` 逐行对应，也看 `packages/x/y.ts`'],
      },
      { ...DEPS(oneShot), fetchNamedFiles },
    );
    expect(out.pass).toBe(true);
    expect(seen).toEqual([['deploy/france.sh', 'packages/x/y.ts']]);
    const prompt = promptOf(commands);
    const filesAt = prompt.indexOf('## 改了哪些文件');
    const namedAt = prompt.indexOf(NAMED_HEADING);
    const diffAt = prompt.indexOf('## diff（unified patch）');
    expect(filesAt).toBeGreaterThan(-1);
    expect(namedAt).toBeGreaterThan(filesAt);
    expect(diffAt).toBeGreaterThan(namedAt);
    const section = namedSection(prompt);
    expect(section).toContain('deploy/france.sh');
    expect(section).toContain('PORT=2201');
    expect(section).toContain('packages/x/y.ts');
    expect(section).toContain('export const y = 1;');
    expect(section).not.toContain('deploy/hk.sh');
    expect(section).not.toContain('foo.ts');
  });

  it('点名的文件 diff 里已经改了时不重复出现', async () => {
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    const seen: string[][] = [];
    const fetchNamedFiles: FetchNamedFiles = async (paths) => {
      seen.push(paths);
      return paths.map((path) => ({ path, kind: 'content', content: `${path} 正文\n` }));
    };
    await invokeVerifier(
      {
        ...BASE_INPUT,
        what: '要什么',
        howToFinish: ['端口要和 `deploy/france.sh`、`deploy/hk.sh` 逐行对应'],
      },
      {
        ...DEPS(oneShot),
        fetchDiff: async () => ({ diffText: FAKE_DIFF_OK.diffText, changedFiles: ['deploy/france.sh'] }),
        fetchNamedFiles,
      },
    );
    expect(seen).toEqual([['deploy/hk.sh']]);
    const prompt = promptOf(commands);
    expect(prompt).toContain('- deploy/france.sh');
    const section = namedSection(prompt);
    expect(section).toContain('deploy/hk.sh');
    expect(section).toContain('deploy/hk.sh 正文');
    expect(section).not.toContain('deploy/france.sh');
  });

  it('点名的文件全都已经在 diff 里时，不出这一节', async () => {
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    let called = 0;
    await invokeVerifier(
      { ...BASE_INPUT, what: '要什么', howToFinish: ['对照 `deploy/france.sh`'] },
      {
        ...DEPS(oneShot),
        fetchDiff: async () => ({ diffText: FAKE_DIFF_OK.diffText, changedFiles: ['deploy/france.sh'] }),
        fetchNamedFiles: async () => {
          called += 1;
          return [];
        },
      },
    );
    expect(called).toBe(0);
    expect(promptOf(commands)).not.toContain(NAMED_HEADING);
  });

  it('超过 200 行的文件被截断并写明省略', async () => {
    const lines = Array.from({ length: 230 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`);
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    await invokeVerifier(
      { ...BASE_INPUT, what: '要什么', howToFinish: ['对照 `deploy/france.sh`'] },
      {
        ...DEPS(oneShot),
        fetchNamedFiles: async () => [
          { path: 'deploy/france.sh', kind: 'content', content: lines.join('\n') },
        ],
      },
    );
    const section = namedSection(promptOf(commands));
    expect(section).toContain('省略');
    expect(section).toContain('line-001');
    expect(section).toContain('line-100');
    expect(section).toContain('line-131');
    expect(section).toContain('line-230');
    expect(section).not.toContain('line-101');
    expect(section).not.toContain('line-115');
    expect(section).not.toContain('line-130');
  });

  it('读不到的文件在 prompt 里标「读不到」，没回的路径也不丢掉', async () => {
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    const out = await invokeVerifier(
      {
        ...BASE_INPUT,
        what: '要什么',
        howToFinish: ['对照 `deploy/france.sh` 和 `deploy/hk.sh`'],
      },
      {
        ...DEPS(oneShot),
        fetchNamedFiles: async () => [
          { path: 'deploy/france.sh', kind: 'unreadable', reason: '镜像里没有这个提交' },
        ],
      },
    );
    expect(out.pass).toBe(true);
    const section = namedSection(promptOf(commands));
    expect(section).toContain('deploy/france.sh');
    expect(section).toContain('读不到：镜像里没有这个提交');
    expect(section).toContain('deploy/hk.sh');
    expect(section).toContain('读不到：没有回这个路径');
  });

  it('读文件这一步抛错时，验收仍把该文件标成读不到并继续问模型', async () => {
    const { oneShot, commands } = fakeOneShot(PASS_SHOT);
    const out = await invokeVerifier(
      { ...BASE_INPUT, what: '要什么', howToFinish: ['对照 `deploy/france.sh`'] },
      {
        ...DEPS(oneShot),
        fetchNamedFiles: async () => {
          throw new Error('镜像锁没拿到');
        },
      },
    );
    expect(out.pass).toBe(true);
    expect(namedSection(promptOf(commands))).toContain('读不到：镜像锁没拿到');
  });

  it('从 howToFinish 和 what 的反引号里取仓内路径，去掉 diff 已改的，最多 5 个', () => {
    expect(
      namedPathsOutsideDiff(
        '还有 `packages/a/b.ts`，以及没包反引号的 deploy/hk.sh、`foo.ts`',
        ['对照 `deploy/france.sh`', '以及 `packages/x/y.ts` 和 `foo.ts`'],
        ['deploy/france.sh'],
      ),
    ).toEqual(['packages/x/y.ts', 'packages/a/b.ts']);
    expect(namedPathsOutsideDiff('`deploy/france.sh`', ['`deploy/france.sh`'], [])).toEqual([
      'deploy/france.sh',
    ]);
    const many = Array.from({ length: 6 }, (_, i) => `pkg/f${i}.ts`);
    expect(
      namedPathsOutsideDiff(
        'x',
        many.map((p) => `看 \`${p}\``),
        [],
      ),
    ).toEqual(many.slice(0, 5));
  });
});

describe('invokeVerifier：两家都验（#1681）', () => {
  /** 按模型号回不同的结论：model 名在 failModels 里的那家判 fail，其余 pass。 */
  function perModelOneShot(failModels: string[] = []): { oneShot: OneShotDeps; models: string[] } {
    const models: string[] = [];
    const base = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const oneShot: OneShotDeps = {
      ...base.oneShot,
      spawn: async (cmd) => {
        const model = cmd.argv[cmd.argv.indexOf('--model') + 1] ?? '';
        models.push(model);
        return {
          exitCode: 0,
          stdout: failModels.includes(model) ? MODEL_STDOUT_FAIL_NOT_DONE : MODEL_STDOUT_PASS,
          stderr: '',
          killed: false,
        };
      },
    };
    return { oneShot, models };
  }
  const deps = (oneShot: OneShotDeps, choose: ChooseModelForFamily) => ({
    oneShot,
    fetchDiff: okFetchDiff(),
    fetchSpec: okFetchSpec(),
    chooseModelForFamily: choose,
    cwd: 'C:/work/x',
  });
  const THREE_AVOID: ModelFamily[] = ['gpt', 'claude', 'deepseek'];
  const ONLY_GPT_CLAUDE = fixedChoose({ gpt: { modelId: 'gpt-1' }, claude: { modelId: 'claude-1' } });

  it('(a) 别家全派不出：gpt、claude 各验一遍，两家都 pass → pass=true，notes 写明两家都验', async () => {
    const { oneShot, models } = perModelOneShot();
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: THREE_AVOID },
      deps(oneShot, ONLY_GPT_CLAUDE),
    );
    expect(models).toEqual(['gpt-1', 'claude-1']);
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.notes).toContain('两家都验');
    expect(out.notes).toContain('gpt');
    expect(out.notes).toContain('claude-1');
  });

  it('(b) 同样设置，claude 那家 fail → pass=false，problems 每条以「claude：」开头', async () => {
    const { oneShot } = perModelOneShot(['claude-1']);
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: THREE_AVOID },
      deps(oneShot, ONLY_GPT_CLAUDE),
    );
    expect(out.pass).toBe(false);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems.every((p) => p.startsWith('claude：'))).toBe(true);
  });

  it('(c) requireTwoFamilies、避让为空：起两次会话、两个族不同，两家都 pass 才过', async () => {
    const { oneShot, models } = perModelOneShot();
    const choose: ChooseModelForFamily = async (family) => ({ modelId: `${family}-m` });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: [], requireTwoFamilies: true },
      deps(oneShot, choose),
    );
    expect(models).toEqual(['gpt-m', 'grok-m']);
    expect(out.pass).toBe(true);

    const second = perModelOneShot(['grok-m']);
    const bad = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: [], requireTwoFamilies: true },
      deps(second.oneShot, choose),
    );
    expect(bad.pass).toBe(false);
    expect(bad.problems.every((p) => p.startsWith('grok：'))).toBe(true);
  });

  it('(d) 只有一个族挑得出模型 → 同族兜底验：起一次会话，结论照常，notes 以「同族兜底验：」开头（#1731）', async () => {
    const { oneShot, models } = perModelOneShot();
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: THREE_AVOID },
      deps(oneShot, fixedChoose({ gpt: { modelId: 'gpt-1' } })),
    );
    expect(models).toEqual(['gpt-1']);
    expect(out.pass).toBe(true);
    expect(out.problems.join('\n')).not.toContain('没讨论成');
    expect(out.notes?.startsWith('同族兜底验：')).toBe(true);
    expect(out.session?.family).toBe('gpt');
  });

  it('(e) 有别家可挑：照旧一家验，只起一次会话', async () => {
    const { oneShot, models } = perModelOneShot();
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['gpt'] },
      deps(oneShot, fixedChoose({ grok: { modelId: 'grok-1' }, claude: { modelId: 'claude-1' } })),
    );
    expect(models).toEqual(['grok-1']);
    expect(out.pass).toBe(true);
    expect(out.notes ?? '').not.toContain('两家都验');
  });

  it('没有 requireTwoFamilies、避让和别的作者族都为空 → 照旧在入参校验就抛', async () => {
    const { oneShot } = perModelOneShot();
    await expect(
      invokeVerifier({ ...BASE_INPUT, modelFamiliesAvoid: [] }, deps(oneShot, ONLY_GPT_CLAUDE)),
    ).rejects.toThrow();
  });
});

describe('invokeVerifier：别家在等先等；两家都验先挑齐再起会话（#1697）', () => {
  /** 按模型号回脚本里的结局；没写的模型回 pass。models 记下起过会话的模型（按先后）。 */
  function scriptedOneShot(
    byModel: Record<string, SpawnOutcome | ((cmd: SpawnCommand) => Promise<SpawnOutcome>)> = {},
  ): {
    oneShot: OneShotDeps;
    models: string[];
  } {
    const models: string[] = [];
    const base = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const oneShot: OneShotDeps = {
      ...base.oneShot,
      spawn: async (cmd) => {
        const model = cmd.argv[cmd.argv.indexOf('--model') + 1] ?? '';
        models.push(model);
        const got = byModel[model];
        if (typeof got === 'function') return got(cmd);
        return got ?? { exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false };
      },
    };
    return { oneShot, models };
  }
  /** 选路剧本：写了模型号的能派，写了 wait 的在等，没写的一条路由都没有。asked 记下问过的族。 */
  function scriptedChoose(script: Partial<Record<ModelFamily, string | { wait: string }>>): {
    choose: ChooseModelForFamily;
    asked: ModelFamily[];
  } {
    const asked: ModelFamily[] = [];
    return {
      asked,
      choose: async (family) => {
        asked.push(family);
        const got = script[family];
        if (got === undefined) return undefined;
        return typeof got === 'string' ? { modelId: got, reservationId: `res-${family}` } : got;
      },
    };
  }
  const deps = (oneShot: OneShotDeps, choose: ChooseModelForFamily) => ({
    oneShot,
    fetchDiff: okFetchDiff(),
    fetchSpec: okFetchSpec(),
    chooseModelForFamily: choose,
    cwd: 'C:/work/x',
  });
  const TWO: VerifierInvokeInput = { ...BASE_INPUT, modelFamiliesAvoid: [], requireTwoFamilies: true };

  it('(a) 作者认不出、gpt 能派、grok 在等空位：一个会话都不起，回等待（routeWait 写明在等 grok），不回没讨论成的做不出来', async () => {
    const { oneShot, models } = scriptedOneShot();
    const { choose } = scriptedChoose({ gpt: 'gpt-1', grok: { wait: 'cursor 池并发满了（4/4）' } });
    const out = await invokeVerifier(TWO, deps(oneShot, choose));
    expect(models).toEqual([]);
    expect(out.pass).toBe(false);
    expect(out.session).toBeUndefined();
    expect(out.routeWait).toEqual({
      families: ['grok'],
      reason: expect.stringContaining('cursor 池并发满了'),
    });
    expect(out.problems.join('\n')).toMatch(/^没讨论成：/);
  });

  it('(b) 作者 gpt、claude，别家全在等空位：不起会话、回等待，不去问 gpt、claude（不改成作者族互验）', async () => {
    const { oneShot, models } = scriptedOneShot();
    const { choose, asked } = scriptedChoose({
      gpt: 'gpt-1',
      claude: 'claude-1',
      grok: { wait: '没空位' },
      deepseek: { wait: '没空位' },
      kimi: { wait: '没空位' },
    });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['gpt', 'claude'] },
      deps(oneShot, choose),
    );
    expect(models).toEqual([]);
    expect(asked).toEqual(['grok', 'deepseek', 'kimi']);
    expect(out.session).toBeUndefined();
    expect(out.routeWait?.families).toEqual(['grok', 'deepseek', 'kimi']);
  });

  it('(c) 作者 gpt、claude，别家全都没路由、两家都能派：起两次会话，族是 gpt 和 claude', async () => {
    const { oneShot, models } = scriptedOneShot();
    const { choose } = scriptedChoose({ gpt: 'gpt-1', claude: 'claude-1' });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: ['gpt', 'claude'] },
      deps(oneShot, choose),
    );
    expect(models).toEqual(['gpt-1', 'claude-1']);
    expect(out.pass).toBe(true);
    expect(out.routeWait).toBeUndefined();
    expect(out.session?.family).toBe('claude');
    expect(out.notes).toContain('两家都验：gpt（model gpt-1）、claude（model claude-1）');
  });

  it('(d) 两家都验，第一家 pass、第二家撞上游临时故障（429 限流）：回 upstreamRetry，不回 pass', async () => {
    const { oneShot, models } = scriptedOneShot({
      'grok-1': {
        exitCode: 1,
        stdout: '',
        stderr: '429 Too Many Requests',
        killed: false,
        facts: { detail: '429 Too Many Requests', rawError: '429 Too Many Requests' },
      },
    });
    const { choose } = scriptedChoose({ gpt: 'gpt-1', grok: 'grok-1' });
    const out = await invokeVerifier(TWO, deps(oneShot, choose));
    expect(models).toEqual(['gpt-1', 'grok-1']);
    expect(out.pass).toBe(false);
    expect(out.upstreamRetry?.afterSeconds).toBeGreaterThan(0);
    expect(out.session?.family).toBe('grok');
  });

  it('(e) 两家都验，第一家 pass、第二家会话超时、再没有别的族：不停下，按同族兜底验用第一家的结论（#1731）', async () => {
    // 第二家一直不回，等到限时被杀（限时调到约 30 毫秒）
    const { oneShot, models } = scriptedOneShot({
      'grok-1': (cmd) =>
        new Promise<SpawnOutcome>((resolve) => {
          cmd.signal.addEventListener(
            'abort',
            () => resolve({ exitCode: null, stdout: '', stderr: '', killed: true }),
            { once: true },
          );
        }),
    });
    const { choose } = scriptedChoose({ gpt: 'gpt-1', grok: 'grok-1' });
    const out = await invokeVerifier(TWO, { ...deps(oneShot, choose), timeoutMinutes: 0.0005 });
    expect(models).toEqual(['gpt-1', 'grok-1']);
    expect(out.pass).toBe(true);
    expect(out.session?.family).toBe('gpt');
    expect(out.notes?.startsWith('同族兜底验：')).toBe(true);
    expect(out.notes).toContain('grok-1');
    expect(out.problems.join('\n')).not.toContain('冷调用没跑成');
  });

  it('(f) 两家都验，第一家 pass、第二家结论行写法不对：不停下，按同族兜底验用第一家的结论，notes 记下结论行不是固定写法（#1731）', async () => {
    const { oneShot, models } = scriptedOneShot({
      'grok-1': {
        exitCode: 0,
        stdout: ['## 问题', '', 'verdict: not pass'].join('\n'),
        stderr: '',
        killed: false,
      },
    });
    const { choose } = scriptedChoose({ gpt: 'gpt-1', grok: 'grok-1' });
    const out = await invokeVerifier(TWO, deps(oneShot, choose));
    expect(models).toEqual(['gpt-1', 'grok-1']);
    expect(out.pass).toBe(true);
    expect(out.notes?.startsWith('同族兜底验：')).toBe(true);
    expect(out.notes).toContain('结论行不是固定写法');
  });

  it('两家都挑不到、也没有在等的：回等待（一个模型都派不出），不回没讨论成（#1731）', async () => {
    const { oneShot, models } = scriptedOneShot();
    const out = await invokeVerifier(TWO, deps(oneShot, scriptedChoose({}).choose));
    expect(models).toEqual([]);
    expect(out.routeWait?.families).toEqual([]);
    expect(out.routeWait?.reason).toContain('一个模型都派不出');
    expect(out.problems.join('\n')).not.toContain('没讨论成');
  });

  it('一家验：前面的族在等、后面的族能派，照旧派给能派的那家（不为等的那家停下）', async () => {
    const { oneShot, models } = scriptedOneShot();
    const { choose } = scriptedChoose({ grok: { wait: '没空位' }, claude: 'claude-1' });
    const out = await invokeVerifier(BASE_INPUT, deps(oneShot, choose));
    expect(models).toEqual(['claude-1']);
    expect(out.pass).toBe(true);
    expect(out.routeWait).toBeUndefined();
  });

  describe('验不出来自己兜到底：同族兜底验、换候选重试、没模型就等（#1731）', () => {
    const AUTHOR_GPT: VerifierInvokeInput = { ...BASE_INPUT, modelFamiliesAvoid: ['gpt'] };
    /** 会话一直不回，等到限时被杀（限时调到约 30 毫秒）。 */
    const hang = (cmd: SpawnCommand) =>
      new Promise<SpawnOutcome>((resolve) => {
        cmd.signal.addEventListener(
          'abort',
          () => resolve({ exitCode: null, stdout: '', stderr: '', killed: true }),
          { once: true },
        );
      });

    it('(a) 作者族 gpt、别家都没路由、gpt 能派：同族兜底验起一次会话，族 gpt，pass 就是 pass，notes 以「同族兜底验：」开头', async () => {
      const { oneShot, models } = scriptedOneShot();
      const { choose } = scriptedChoose({ gpt: 'gpt-1' });
      const out = await invokeVerifier(AUTHOR_GPT, deps(oneShot, choose));
      expect(models).toEqual(['gpt-1']);
      expect(out.session?.family).toBe('gpt');
      expect(out.pass).toBe(true);
      expect(out.problems).toEqual([]);
      expect(out.notes?.startsWith('同族兜底验：')).toBe(true);
      expect(out.notes).toContain('gpt');
      expect(out.notes).toContain('gpt-1');
      expect(out.routeWait).toBeUndefined();
    });

    it('(b) 同上、gpt 判 fail：pass: false，问题照常带出', async () => {
      const { oneShot, models } = scriptedOneShot({
        'gpt-1': { exitCode: 0, stdout: MODEL_STDOUT_FAIL_NOT_DONE, stderr: '', killed: false },
      });
      const { choose } = scriptedChoose({ gpt: 'gpt-1' });
      const out = await invokeVerifier(AUTHOR_GPT, deps(oneShot, choose));
      expect(models).toEqual(['gpt-1']);
      expect(out.pass).toBe(false);
      expect(out.problems).toEqual([
        `${BLOCKER_KINDS[0]}：单子要 A、代码做了 B（证据：diff 第 3 行把 A 改成了 B）`,
      ]);
      expect(out.notes?.startsWith('同族兜底验：')).toBe(true);
    });

    it('(c) 一个族都派不出：回 routeWait，不起会话，problems 里没有「没讨论成」', async () => {
      const { oneShot, models } = scriptedOneShot();
      const { choose, asked } = scriptedChoose({});
      const out = await invokeVerifier(AUTHOR_GPT, deps(oneShot, choose));
      expect(models).toEqual([]);
      expect(asked).toEqual([...FAMILY_ORDER.filter((f) => f !== 'gpt'), 'gpt']);
      expect(out.session).toBeUndefined();
      expect(out.pass).toBe(false);
      expect(out.routeWait).toEqual({
        families: [],
        reason: expect.stringContaining('一个模型都派不出，过一会儿重来'),
      });
      expect(out.problems.join('\n')).not.toContain('没讨论成');
    });

    it('(d) 第一个候选会话超时、第二个候选给出 pass：回 pass: true，起了两次会话', async () => {
      const { oneShot, models } = scriptedOneShot({ 'grok-1': hang });
      const { choose } = scriptedChoose({ grok: 'grok-1', claude: 'claude-1' });
      const out = await invokeVerifier(AUTHOR_GPT, { ...deps(oneShot, choose), timeoutMinutes: 0.0005 });
      expect(models).toEqual(['grok-1', 'claude-1']);
      expect(out.pass).toBe(true);
      expect(out.session?.family).toBe('claude');
    });

    it('(e) 所有候选会话都超时（别家、作者族兜底都试过）：回「冷调用没跑成：试过的路由都没验成」', async () => {
      const { oneShot, models } = scriptedOneShot({ 'grok-1': hang, 'claude-1': hang, 'gpt-1': hang });
      const { choose } = scriptedChoose({ grok: 'grok-1', claude: 'claude-1', gpt: 'gpt-1' });
      const out = await invokeVerifier(AUTHOR_GPT, { ...deps(oneShot, choose), timeoutMinutes: 0.0005 });
      expect(models).toEqual(['grok-1', 'claude-1', 'gpt-1']);
      expect(out.pass).toBe(false);
      expect(out.problems).toHaveLength(1);
      expect(out.problems[0]?.startsWith('冷调用没跑成：试过的路由都没验成')).toBe(true);
      expect(out.problems[0]).toContain('grok/grok-1');
      expect(out.problems[0]).toContain('gpt/gpt-1');
      expect(out.routeWait).toBeUndefined();
    });
  });
});
