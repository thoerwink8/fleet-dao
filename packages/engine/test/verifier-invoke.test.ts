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
import { roomForAnother, suggestionsBody } from '../src/real/task-verify.ts';
import { NoSlotError, type RunRecord, type RunStart, type RunsWriter } from '../src/runner/not-wired.ts';
import type { OneShotDeps, SpawnCommand, SpawnOutcome } from '../src/runner/one-shot.ts';
import {
  BLOCKER_KINDS,
  BLOCKING_KIND,
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
  `- ${BLOCKER_KINDS[0]}：第 1 条：单子要 A、代码做了 B（证据：diff 第 3 行把 A 改成了 B）`,
  '',
  'verdict: fail',
].join('\n');

/** 模型判 fail：弄坏了原有功能（BLOCKER_KINDS[1]）。 */
const MODEL_STDOUT_FAIL_BREAKS = [
  '我看了单子、查了 diff。',
  '',
  '## 问题',
  `- ${BLOCKER_KINDS[1]}：第 1 条：原来 exports.foo 是 string，这个 diff 把它改成了 number，调用方 packages/api/src/x.ts 还在按 string 用`,
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

function fakeOneShot(scripted: SpawnOutcome | ((n: number) => SpawnOutcome)): {
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
  let spawned = 0;
  const oneShot: OneShotDeps = {
    spawn: async (cmd) => {
      commands.push(cmd);
      spawnedArgv.push(cmd.argv.join(' '));
      spawned += 1;
      return typeof scripted === 'function' ? scripted(spawned) : scripted;
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

  it('弄坏原有功能（BLOCKER_KINDS[1]）指出了具体文件 → 照旧挡：pass=false、problems 带它（决定 0115，#3624）', async () => {
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
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain(BLOCKER_KINDS[1]);
    expect(out.suggestions ?? []).toEqual([]);
  });

  it('安全或丢数据（BLOCKER_KINDS[2]）指出了具体位置、不带「第 N 条」 → 照旧挡，不算格式错', async () => {
    const line = `${BLOCKER_KINDS[2]}：\`scripts/clean.sh\` 第 12 行 rm -rf 没加确认，会删掉用户数据`;
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${line}`, '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([line]);
  });

  it('弄坏原有功能但没指出具体证据（只是推测）→ pass=true、进建议、不挡（决定 0115，#3624）', async () => {
    const guess = `${BLOCKER_KINDS[1]}：第 1 条：这样改可能会影响别的调用方`;
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${guess}`, '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toEqual([guess]);
    expect(out.notes).toContain('按过算');
  });

  it('纯推测、验收条以外的边界意见（不带三类前缀）→ pass=true、进建议', async () => {
    const note = '并发时可能会有竞态，最好再加个锁';
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${note}`, '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toEqual([note]);
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

  it('喂给模型的提示词里三种能挡的开头是真文字，不是没替换的占位符；允许在 PR 头的完整检出里读文件', async () => {
    const { oneShot, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    const prompt = commands[0]?.stdin ?? '';
    expect(prompt).not.toContain('${');
    expect(prompt).toContain(`- ${BLOCKING_KIND}：`);
    expect(prompt).toContain('只有三类');
    expect(prompt).toContain(`- ${BLOCKER_KINDS[1]}：`);
    expect(prompt).toContain(`- ${BLOCKER_KINDS[2]}：`);
    expect(prompt).toContain('你可以在 PR 头的完整检出里读文件');
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

  it('安全或丢数据没指出具体位置 → 进建议、不挡', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${BLOCKER_KINDS[2]}：第 1 条：删库脚本没加确认`, '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toEqual([`${BLOCKER_KINDS[2]}：第 1 条：删库脚本没加确认`]);
  });

  it('写 pass 但问题清单里还有算挡的 → 不过（自相矛盾的结论不放行），问题原样带出', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', `- ${BLOCKING_KIND}：第 1 条：单子要 A 没做`, '', 'verdict: pass'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKING_KIND}：第 1 条：单子要 A 没做`]);
    expect(out.notes).toContain('自相矛盾');
  });

  it('问题后面的结论行、空行之后的段落不并进问题的文字里（只有紧跟在某一条后面的续行才并回去）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: [
        '## 问题',
        `- ${BLOCKER_KINDS[0]}：第 1 条：单子要 A`,
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
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：第 1 条：单子要 A 代码里没有 A（续行）`]);
  });

  it('写 fail 但「## 问题」里没有「没做到验收条」（只有验收条以外的意见）→ 按过算，意见进建议，不挡（#3604）', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: ['## 问题', '- 命名不好看', '- 函数太长', '', 'verdict: fail'].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toEqual(['命名不好看', '函数太长']);
  });

  it('只有建议时的留言正文：写明通过、建议不挡合并，逐条列出（#3604）', () => {
    const body = suggestionsBody({ prNumber: 7, headSha: 'a'.repeat(40) }, [
      '并发边界没覆盖',
      '命名可以更好',
    ]);
    expect(body).toContain('PR #7');
    expect(body).toContain('通过');
    expect(body).toContain('不挡合并');
    expect(body).toContain('- 并发边界没覆盖');
    expect(body).toContain('- 命名可以更好');
  });

  it('看不到 diff 外证据判不了：写进「不归我验」，pass=true、走转人（handedOver），不判不过', async () => {
    const { oneShot } = fakeOneShot({
      exitCode: 0,
      stdout: [
        '## 问题',
        '',
        '## 不归我验',
        '- 第 2 条：要线上卡住的现场数据，diff 里看不出',
        '',
        'verdict: fail',
      ].join('\n'),
      stderr: '',
      killed: false,
    });
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.outOfScope).toEqual(['第 2 条：要线上卡住的现场数据，diff 里看不出']);
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
    expect([...models].sort()).toEqual(['claude-1', 'gpt-1']); // 两家并行起，先后不定（#1704）
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
    expect([...models].sort()).toEqual(['gpt-m', 'grok-m']);
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
    expect([...models].sort()).toEqual(['claude-1', 'gpt-1']); // 两家并行起，先后不定（#1704）
    expect(out.pass).toBe(true);
    expect(out.routeWait).toBeUndefined();
    expect(out.session).toBeUndefined();
    expect(out.sourceRunIds).toHaveLength(2);
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
    expect([...models].sort()).toEqual(['gpt-1', 'grok-1']);
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
    expect([...models].sort()).toEqual(['gpt-1', 'grok-1']);
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
    expect([...models].sort()).toEqual(['gpt-1', 'grok-1']); // 两家并行起，先后不定（#1704）
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
        `${BLOCKER_KINDS[0]}：第 1 条：单子要 A、代码做了 B（证据：diff 第 3 行把 A 改成了 B）`,
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

    it('【#3281】第一家判 fail 却一条算挡的问题都没写：不停下等人，避开它换下一家重验，用下一家的结论', async () => {
      const { oneShot, models } = scriptedOneShot({
        'grok-1': { exitCode: 0, stdout: 'verdict: fail', stderr: '', killed: false },
      });
      const { choose } = scriptedChoose({ grok: 'grok-1', claude: 'claude-1' });
      const out = await invokeVerifier(AUTHOR_GPT, deps(oneShot, choose));
      expect(models).toEqual(['grok-1', 'claude-1']);
      expect(out.pass).toBe(true);
      expect(out.session?.family).toBe('claude');
    });

    it('【#3281】每一家都判 fail 却不写问题：试遍了才回「冷调用没跑成」，写明每一家为什么没验成', async () => {
      const empty = { exitCode: 0, stdout: 'verdict: fail', stderr: '', killed: false };
      const { oneShot, models } = scriptedOneShot({ 'grok-1': empty, 'claude-1': empty, 'gpt-1': empty });
      const { choose } = scriptedChoose({ grok: 'grok-1', claude: 'claude-1', gpt: 'gpt-1' });
      const out = await invokeVerifier(AUTHOR_GPT, deps(oneShot, choose));
      expect(models).toEqual(['grok-1', 'claude-1', 'gpt-1']);
      expect(out.pass).toBe(false);
      expect(out.problems[0]?.startsWith('冷调用没跑成：试过的路由都没验成')).toBe(true);
      expect(out.problems[0]).toContain('一条都没写');
    });

    it('【#3281】第一家超时后活动剩下的时间不够再起一家：不起第二家，回等待（工作流过一会儿重验），不拖到活动超时', async () => {
      const { oneShot, models } = scriptedOneShot({ 'grok-1': hang });
      const { choose } = scriptedChoose({ grok: 'grok-1', claude: 'claude-1', gpt: 'gpt-1' });
      let asks = 0;
      const out = await invokeVerifier(AUTHOR_GPT, {
        ...deps(oneShot, choose),
        timeoutMinutes: 0.0005,
        roomForAnother: () => ++asks === 1,
      });
      expect(models).toEqual(['grok-1']);
      expect(out.pass).toBe(false);
      expect(out.session).toBeUndefined();
      expect(out.routeWait?.reason).toContain('这一次验收剩下的时间不够再起一家');
    });
  });
});

describe('roomForAnother（#3281）', () => {
  it('没有截止一直够；剩下的不够一家的限时加收尾就不够', () => {
    const now = 1_000_000;
    expect(roomForAnother(undefined, 30, now)).toBe(true);
    expect(roomForAnother(now + 33 * 60_000, 30, now)).toBe(true);
    expect(roomForAnother(now + 31 * 60_000, 30, now)).toBe(false);
  });
});

describe('invokeVerifier：两家都验时两家的会话并行起（#1704）', () => {
  const TWO: VerifierInvokeInput = { ...BASE_INPUT, modelFamiliesAvoid: [], requireTwoFamilies: true };
  const choose: ChooseModelForFamily = async (family) => ({ modelId: `${family}-m` });

  /** 假 one-shot：每个会话起时记 start、收场时记 end；两家都起了才放行（串着跑的实现在这里会卡死，测试超时变红）。 */
  function gatedOneShot(stdoutOf: (model: string) => string) {
    const events: string[] = [];
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const oneShot: OneShotDeps = {
      ...base.oneShot,
      spawn: async (cmd) => {
        const model = cmd.argv[cmd.argv.indexOf('--model') + 1] ?? '';
        events.push(`start:${model}`);
        started += 1;
        if (started === 2) release();
        await gate;
        events.push(`end:${model}`);
        return { exitCode: 0, stdout: stdoutOf(model), stderr: '', killed: false };
      },
    };
    return { oneShot, events };
  }
  const depsOf = (oneShot: OneShotDeps) => ({
    oneShot,
    fetchDiff: okFetchDiff(),
    fetchSpec: okFetchSpec(),
    chooseModelForFamily: choose,
    cwd: 'C:/work/x',
  });

  it('两家都在任何一家收场前起；都 pass 才过', async () => {
    const { oneShot, events } = gatedOneShot(() => MODEL_STDOUT_PASS);
    const out = await invokeVerifier(TWO, depsOf(oneShot));
    expect(out.pass).toBe(true);
    expect(events.slice(0, 2).sort()).toEqual(['start:gpt-m', 'start:grok-m']);
    expect(events.slice(2).every((e) => e.startsWith('end:'))).toBe(true);
  });

  it('一 pass 一 fail：回 pass:false，problems 带「〈族名〉：」前缀', async () => {
    const { oneShot, events } = gatedOneShot((m) =>
      m === 'grok-m' ? MODEL_STDOUT_FAIL_NOT_DONE : MODEL_STDOUT_PASS,
    );
    const out = await invokeVerifier(TWO, depsOf(oneShot));
    expect(events.slice(0, 2).every((e) => e.startsWith('start:'))).toBe(true);
    expect(out.pass).toBe(false);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.problems.every((p) => p.startsWith('grok：'))).toBe(true);
  });

  it('一家起不来（NO_SLOT）：另一家照常跑完、记进 runs，错原样往外抛', async () => {
    const base = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const finished: string[] = [];
    const oneShot: OneShotDeps = {
      ...base.oneShot,
      // 开跑那一行写不进去、池的名额满了：grok 那家起不来
      runs: {
        ...base.oneShot.runs,
        async start(row: RunStart) {
          if (row.model === 'grok-m') throw new NoSlotError('池满了');
        },
      },
      spawn: async (cmd) => {
        const model = cmd.argv[cmd.argv.indexOf('--model') + 1] ?? '';
        await new Promise((r) => setTimeout(r, 20));
        finished.push(model);
        return { exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false };
      },
    };
    await expect(invokeVerifier(TWO, depsOf(oneShot))).rejects.toMatchObject({ code: 'NO_SLOT' });
    expect(finished).toEqual(['gpt-m']);
    expect(base.recorded.map((r) => r.outcome)).toContain('done');
  });
});

describe('invokeVerifier：材料带 PR 正文和测试输出，只判验收条，diff 外证据转人、建议不挡（决定 0093）', () => {
  const run = async (stdout: string, input: Partial<VerifierInvokeInput> = {}) => {
    const { oneShot, commands } = fakeOneShot({ exitCode: 0, stdout, stderr: '', killed: false });
    const out = await invokeVerifier({ ...BASE_INPUT, ...input }, DEPS(oneShot));
    return { out, prompt: commands[0]?.stdin ?? '', spawned: commands.length };
  };

  it('提示词里有 PR 正文和测试输出两节，并写明 PR 正文只当线索、不许拿「PR 正文没写」挡', async () => {
    const { prompt } = await run(MODEL_STDOUT_PASS, {
      prBody: '这次把 A 加上了。\n截图见下。',
      testOutput: 'Test Files  1 passed (1)\n      Tests  3 passed (3)',
    });
    expect(prompt).toContain('## PR 正文');
    expect(prompt).toContain('这次把 A 加上了。');
    expect(prompt).toContain('## 引擎跑过的测试输出');
    expect(prompt).toContain('Tests  3 passed (3)');
    expect(prompt).toContain('不许拿「PR 正文没写」挡');
    expect(prompt).toContain('## 不归我验');
    expect(prompt).toContain('只算建议');
  });

  it('没给 PR 正文和测试输出：这两节不出现', async () => {
    const { prompt } = await run(MODEL_STDOUT_PASS);
    expect(prompt).not.toContain('## PR 正文');
    expect(prompt).not.toContain('## 引擎跑过的测试输出');
  });

  it('测试输出超长只给末尾并写明', async () => {
    const tail = 'FAIL test/x.test.ts 最后这一行';
    const { prompt } = await run(MODEL_STDOUT_PASS, { testOutput: `${'x'.repeat(40_000)}\n${tail}` });
    expect(prompt).toContain(tail);
    expect(prompt).toContain('只给末尾');
    expect(prompt).not.toContain('x'.repeat(31_000));
  });

  it('「不归我验」带出来、结论 pass：pass=true，outOfScope 是那几条，notes 写明转给人', async () => {
    const { out } = await run(
      [
        '## 问题',
        '',
        '## 不归我验',
        '- 第 2 条：要页面截图，diff 里看不出',
        '',
        '## 建议',
        '- 函数名可以再短一点',
        '',
        'verdict: pass',
      ].join('\n'),
    );
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.outOfScope).toEqual(['第 2 条：要页面截图，diff 里看不出']);
    expect(out.suggestions).toEqual(['函数名可以再短一点']);
    expect(out.notes).toContain('不归我验 1 条');
  });

  it('只有「不归我验」却写了 fail：按过算，不回炉、不当没验成换路由', async () => {
    const { out, spawned } = await run(
      ['## 问题', '', '## 不归我验', '- 第 1 条：要法国线上的数据', '', 'verdict: fail'].join('\n'),
    );
    expect(spawned).toBe(1);
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.outOfScope).toEqual(['第 1 条：要法国线上的数据']);
    expect(out.notes).toContain('按过算');
  });

  it('有算挡的问题又有「不归我验」：照常没过，outOfScope 一起带出', async () => {
    const { out } = await run(
      [
        '## 问题',
        `- ${BLOCKER_KINDS[0]}：第 1 条要 A，diff 里没有`,
        '',
        '## 不归我验',
        '- 第 2 条：要截图',
        '',
        'verdict: fail',
      ].join('\n'),
    );
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：第 1 条要 A，diff 里没有`]);
    expect(out.outOfScope).toEqual(['第 2 条：要截图']);
  });

  it('「## 问题」里混进的建议不挡，挪进 suggestions', async () => {
    const { out } = await run(MODEL_STDOUT_PASS_WITH_STYLE);
    expect(out.pass).toBe(true);
    expect(out.suggestions).toEqual([
      '命名可以更一致一点（风格意见，specs/555 不许算挡）',
      '这块代码可以更短（风格意见）',
    ]);
  });

  it('「不归我验」写「（没有）」不算一条', async () => {
    const { out } = await run(['## 问题', '', '## 不归我验', '- 无', '', 'verdict: pass'].join('\n'));
    expect(out.outOfScope).toBeUndefined();
  });

  it('两家都验：两家的「不归我验」合起来，带族名', async () => {
    const stdout = ['## 问题', '', '## 不归我验', '- 第 2 条：要截图', '', 'verdict: pass'].join('\n');
    const { oneShot } = fakeOneShot({ exitCode: 0, stdout, stderr: '', killed: false });
    const out = await invokeVerifier(
      { ...BASE_INPUT, modelFamiliesAvoid: [], requireTwoFamilies: true },
      { ...DEPS(oneShot), chooseModelForFamily: async (family) => ({ modelId: `${family}-m` }) },
    );
    expect(out.pass).toBe(true);
    expect(out.outOfScope).toEqual(['gpt：第 2 条：要截图', 'grok：第 2 条：要截图']);
  });

  it('起会话没起来（桥接连 Mirasim 超时）：换同一族下一条路由再验一次，验成了照常回结论', async () => {
    const base = fakeOneShot({ exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false });
    const tried: string[] = [];
    const oneShot: OneShotDeps = {
      ...base.oneShot,
      spawn: async (cmd) => {
        const model = cmd.argv[cmd.argv.indexOf('--model') + 1] ?? '';
        tried.push(model);
        if (model === 'claude-mirasim') {
          return { exitCode: 1, stdout: '', stderr: '没起来：桥接连 Mirasim 超时（100 秒）', killed: false };
        }
        return { exitCode: 0, stdout: MODEL_STDOUT_PASS, stderr: '', killed: false };
      },
    };
    const routes = ['claude-mirasim', 'claude-solo'];
    const out = await invokeVerifier(BASE_INPUT, {
      ...DEPS(oneShot),
      chooseModelForFamily: async (family) => {
        if (family !== 'claude') return undefined;
        const next = routes.shift();
        return next === undefined ? undefined : { modelId: next, routeId: `route-${next}` };
      },
    });
    expect(tried).toEqual(['claude-mirasim', 'claude-solo']);
    expect(out.pass).toBe(true);
    expect(out.session?.routeId).toBe('route-claude-solo');
  });
});

/** 提示词里钉死的那一条：测试/检查通过类验收条归合并闸的 CI，冷验收不因输出里没出现它拒。 */
const CI_OWNS_PASS_RULE =
  '「怎么算做完」里只要求「某某测试/检查/构建/类型检查通过」的条目，一律由合并闸的 CI 保证，你不核对、不因测试输出里没出现它判不过；只有测试输出里明确出现失败时才作为问题写出。';

describe('invokeVerifier：测试/检查通过类验收条归 CI，不因测试输出里没出现它拒', () => {
  const run = async (input: Partial<VerifierInvokeInput>) => {
    const { oneShot, commands } = fakeOneShot({
      exitCode: 0,
      stdout: MODEL_STDOUT_PASS,
      stderr: '',
      killed: false,
    });
    await invokeVerifier({ ...BASE_INPUT, ...input }, DEPS(oneShot));
    return commands[0]?.stdin ?? '';
  };

  it('验收条「adapters 全部测试通过」、测试输出里没有 adapters：提示词含归 CI 的规则，且「找不到就不放行」只管 diff', async () => {
    const prompt = await run({
      howToFinish: ['adapters 全部测试通过'],
      testOutput: 'pnpm test:changed\nTest Files  1 passed (1)\n',
    });
    expect(prompt).toContain('1. adapters 全部测试通过');
    const outputSection = prompt.split('## 引擎跑过的测试输出')[1]?.split('## diff')[0] ?? '';
    expect(outputSection).not.toContain('adapters');
    expect(prompt).toContain(CI_OWNS_PASS_RULE);
    expect(prompt).toContain('这一句只管 diff 能看见的内容');
    expect(prompt).toContain('不包括只要求测试、检查、构建或类型检查通过的条目');
    expect(prompt).not.toContain('本该在 diff、测试输出里看得见却找不到');
    expect(prompt).toContain('输出里写「没跑」「跳过」、或没有这一条的输出，不算失败，不写进问题。');
  });

  it('测试输出明确写了失败：提示词仍要求把失败写成问题', async () => {
    const prompt = await run({
      howToFinish: ['adapters 全部测试通过'],
      testOutput: 'FAIL packages/adapters/test/x.test.ts\n Test Files  1 failed (1)\n',
    });
    expect(prompt).toContain('FAIL packages/adapters/test/x.test.ts');
    expect(prompt).toContain('只有测试输出里明确出现失败时才作为问题写出');
    expect(prompt).toContain('只有测试输出里明确出现失败才写');
  });
});

const done = (stdout: string): SpawnOutcome => ({ exitCode: 0, stdout, stderr: '', killed: false });

describe('问题带验收条编号；没有编号判格式错、重跑一次', () => {
  it('第一次没带编号、重跑这一次带了：用第二次的问题', async () => {
    const first = ['## 问题', `- ${BLOCKER_KINDS[0]}：单子要 A、代码做了 B`, '', 'verdict: fail'].join('\n');
    const second = [
      '## 问题',
      `- ${BLOCKER_KINDS[0]}：第 1 条：单子要 A、代码做了 B`,
      '',
      'verdict: fail',
    ].join('\n');
    const { oneShot, commands } = fakeOneShot((n) => done(n === 1 ? first : second));
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(commands).toHaveLength(2);
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：第 1 条：单子要 A、代码做了 B`]);
    expect(out.notes).toContain('格式错重跑了一次');
  });

  it('重跑一次仍没有编号：不算没过的问题，冷调用没跑成', async () => {
    const bad = ['## 问题', `- ${BLOCKER_KINDS[0]}：单子要 A`, '', 'verdict: fail'].join('\n');
    const { oneShot, commands } = fakeOneShot(() => done(bad));
    const out = await invokeVerifier(BASE_INPUT, DEPS(oneShot));
    expect(commands).toHaveLength(2);
    expect(out.pass).toBe(false);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('冷调用没跑成');
    expect(out.problems[0]).toContain('验收条编号');
  });

  it('第一家格式错后换到另一家：整次验收仍只重跑一次', async () => {
    const bad = ['## 问题', `- ${BLOCKER_KINDS[0]}：单子要 A`, '', 'verdict: fail'].join('\n');
    const { oneShot, commands } = fakeOneShot(() => done(bad));
    const asked: ModelFamily[] = [];
    const out = await invokeVerifier(BASE_INPUT, {
      ...DEPS(oneShot),
      chooseModelForFamily: async (family) => {
        asked.push(family);
        if (family === 'grok' && asked.filter((f) => f === 'grok').length === 1) {
          return { modelId: 'grok-1' };
        }
        if (family === 'claude') return { modelId: 'claude-1' };
        return undefined;
      },
    });
    expect(commands).toHaveLength(3);
    expect(asked).toContain('claude');
    expect(out.problems[0]).toContain('试过的路由都没验成');
  });
});

describe('第 2 轮只复核上轮没过的条和增量', () => {
  const recheck = {
    failedCriteria: [1],
    priorProblems: ['没做到验收条：第 1 条：没有 A'],
  };

  it('旧工作流第 2 轮没有复核材料：仍可按旧输入兼容运行', async () => {
    const { oneShot } = fakeOneShot(done(MODEL_STDOUT_PASS));
    const out = await invokeVerifier({ ...BASE_INPUT, round: 2 }, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.round).toBe(2);
  });

  it('第 2 轮头没变：空的增量 diff 仍按复核材料运行，不当成读不到 diff', async () => {
    const { oneShot } = fakeOneShot(done(MODEL_STDOUT_PASS));
    const out = await invokeVerifier(
      { ...BASE_INPUT, round: 2, recheck },
      {
        ...DEPS(oneShot),
        fetchDiff: async () => ({ diffText: '', changedFiles: [] }),
      },
    );
    expect(out.pass).toBe(true);
    expect(out.round).toBe(2);
  });

  it('提示词带上轮没过的条、增量 diff，判法写成只复核那一句；并允许在 PR 头的完整检出里读文件', async () => {
    const { oneShot, commands } = fakeOneShot(done(MODEL_STDOUT_PASS));
    await invokeVerifier(
      { ...BASE_INPUT, round: 2, recheck: { failedCriteria: [2], priorProblems: recheck.priorProblems } },
      DEPS(oneShot),
    );
    const prompt = commands[0]?.stdin ?? '';
    expect(prompt).toContain('你可以在 PR 头的完整检出里读文件');
    expect(prompt).toContain('## 上一轮没过的条');
    expect(prompt).toContain('- 第 2 条：2. 还把 B 留着');
    expect(prompt).toContain('## 这一轮的增量 diff（unified patch）');
    expect(prompt).toContain('只复核上轮没过的条和增量里的改动，新提出的、不在增量里的问题只记备注、不拒');
    expect(prompt).toContain('标了「主线同步」的是可信主线进入这棵树的变动，留作上下文，不是本单新增');
    expect(prompt).toContain('不要要求本单把主线已经删掉的模块加回去');
    expect(prompt).toContain('最终内容和主线一致的路径，是上一轮之后作者提交改过、结果碰巧和主线相同');
  });

  it('新提出的、不在上轮没过的条里、也没标增量：只记备注、不拒', async () => {
    const stdout = [
      '## 问题',
      `- ${BLOCKER_KINDS[0]}：第 1 条：A 还是没有`,
      `- ${BLOCKER_KINDS[1]}：第 2 条：顺手发现 B 的名字不好`,
      '',
      'verdict: fail',
    ].join('\n');
    const { oneShot } = fakeOneShot(done(stdout));
    const out = await invokeVerifier({ ...BASE_INPUT, round: 2, recheck }, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：第 1 条：A 还是没有`]);
    expect(out.suggestions).toEqual([`${BLOCKER_KINDS[1]}：第 2 条：顺手发现 B 的名字不好`]);
    expect(out.notes).toContain('不挡合并');
  });

  it('增量里新改坏的（正文写了增量）仍然拒', async () => {
    const stdout = [
      '## 问题',
      `- ${BLOCKER_KINDS[0]}：第 2 条：增量文件：\`foo.ts\`，把 B 删了`,
      '',
      'verdict: fail',
    ].join('\n');
    const { oneShot } = fakeOneShot(done(stdout));
    const out = await invokeVerifier({ ...BASE_INPUT, round: 2, recheck }, DEPS(oneShot));
    expect(out.pass).toBe(false);
    expect(out.problems).toEqual([`${BLOCKER_KINDS[0]}：第 2 条：增量文件：\`foo.ts\`，把 B 删了`]);
  });

  it('只写「增量」但没有对上本轮改动文件：只记备注、不拒', async () => {
    const stdout = [
      '## 问题',
      `- ${BLOCKER_KINDS[1]}：第 2 条：增量里发现 B 的名字不好，但不是本轮改动`,
      '',
      'verdict: fail',
    ].join('\n');
    const { oneShot } = fakeOneShot(done(stdout));
    const out = await invokeVerifier({ ...BASE_INPUT, round: 2, recheck }, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toEqual([
      `${BLOCKER_KINDS[1]}：第 2 条：增量里发现 B 的名字不好，但不是本轮改动`,
    ]);
  });

  it('新问题全被改记备注：按过算，不挡', async () => {
    const stdout = ['## 问题', `- ${BLOCKER_KINDS[0]}：第 2 条：B 的注释可以更好`, '', 'verdict: fail'].join(
      '\n',
    );
    const { oneShot } = fakeOneShot(done(stdout));
    const out = await invokeVerifier({ ...BASE_INPUT, round: 2, recheck }, DEPS(oneShot));
    expect(out.pass).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.suggestions).toContain(`${BLOCKER_KINDS[0]}：第 2 条：B 的注释可以更好`);
    expect(out.notes).toContain('按过算');
  });
});
