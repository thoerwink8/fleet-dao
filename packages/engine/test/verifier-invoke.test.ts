// verifier-invoke.ts 行为测试：#555-1 验收段冷调用。
//
// happy path / 模型判 fail（没做到验收条、弄坏原有功能）→ 各自形状对；
// 故意造红的每一种——fetchDiff 抛错 / fetchDiff 返回空 / fetchSpec 抛错 / 全家族挑不出 → 必须 pass=false +
// problems 写明哪一步查不到（不许拿「查不到」当「没挡的」、不许拿默认模型顶上）。这是 specs/555 第 3 条
// （只有三种能挡）和第 4 条（读不到 PR 必填栏就明确失败）的钉子。

import { describe, expect, it } from 'vitest';
import type { RunRecord, RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  BLOCKER_KINDS,
  type ChooseModelForFamily,
  FAMILY_ORDER,
  type FetchDiff,
  type FetchSpec,
  invokeVerifier,
  type ModelFamily,
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

const BASE_INPUT: VerifierInvokeInput = {
  prNumber: 42,
  branch: 'feat/x',
  baseSha: 'a'.repeat(40),
  taskId: 'task-1',
  what: '要 A',
  howToFinish: ['1. 代码里有 A', '2. 还把 B 留着'],
  modelFamilyAvoid: 'gpt',
  round: 1,
};

const FAKE_DIFF_OK = {
  diffText: '@@ -1,1 +1,1 @@\n-old\n+new',
  changedFiles: ['foo.ts'],
};

function fakeOneShot(scripted: SpawnOutcome): {
  oneShot: OneShotDeps;
  recorded: RunRecord[];
  spawnedArgv: string[];
} {
  const spawnedArgv: string[] = [];
  const recorded: RunRecord[] = [];
  const runs: RunsWriter = {
    async record(r: RunRecord) {
      recorded.push(r);
    },
  };
  const oneShot: OneShotDeps = {
    spawn: async (cmd) => {
      spawnedArgv.push(cmd.argv.join(' '));
      return scripted;
    },
    buildCommand: (input) => ({
      argv: ['fake-executor', '--model', input.modelId],
      cwd: input.cwd,
    }),
    runs,
    tmpDir: 'C:/temp/fleet-555-1-test',
  };
  return { oneShot, recorded, spawnedArgv };
}

function okFetchDiff(): FetchDiff {
  return async () => FAKE_DIFF_OK;
}
function okFetchSpec(): FetchSpec {
  return async () => ({ specDir: 'specs/42-做A/' });
}
function fixedChoose(
  map: Partial<Record<ModelFamily, { modelId: string; channel?: string }>>,
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
    // 家族选择顺序：跳过 gpt（avoid），第一家问 gpt 之后的 claude
    expect(chosen[0]).toBe('claude');
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
      { ...BASE_INPUT, modelFamilyAvoid: 'claude' },
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

  it('0006 顺序 + avoid = kimi：应该挑 gpt → claude → deepseek → grok，kimi 不出现', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    const chosen: ModelFamily[] = [];
    // 都不给：让所有 family 都被问一遍、然后 expect 「没讨论成」
    const choose: ChooseModelForFamily = async (family) => {
      chosen.push(family);
      return undefined;
    };
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamilyAvoid: 'kimi' },
      {
        oneShot,
        fetchDiff: okFetchDiff(),
        fetchSpec: okFetchSpec(),
        chooseModelForFamily: choose,
        cwd: 'C:/work/x',
      },
    );
    expect(out.pass).toBe(false);
    expect(out.problems.join('\n')).toContain('没讨论成');
    // kimi 跳过了；其余四个按 FAMILY_ORDER 顺序都问了一遍
    expect(chosen).toEqual(FAMILY_ORDER.filter((f) => f !== 'kimi'));
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
      { ...BASE_INPUT, modelFamilyAvoid: 'gpt' },
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

  it('全家族挑不出（avoid + 剩下全 undefined）→ pass=false、problems 写明没讨论成', async () => {
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
    expect(out.problems.join('\n')).toContain('没讨论成');
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
