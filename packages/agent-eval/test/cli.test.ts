import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_CASES } from '../src/cases/index.ts';
import { dryRunLines, main, parseArgs, selectCases, sessionCount, UsageError } from '../src/cli.ts';
import { loadAgentDefinitions } from '../src/definitions.ts';
import type { LaunchResult } from '../src/launcher.ts';
import { renderReport } from '../src/report.ts';
import type { CaseResult } from '../src/runner.ts';
import type { EvalCase } from '../src/types.ts';
import { REPO_ROOT } from '../src/types.ts';
import { prepareRepoSnapshot } from '../src/workspace.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'agent-eval-cli-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const defs = new Map(loadAgentDefinitions(join(REPO_ROOT, '.claude', 'agents')).map((d) => [d.name, d]));

describe('parseArgs', () => {
  it('默认三档都跑；--model 映射；--case --scenario --out --dry-run', () => {
    expect(parseArgs([]).models).toEqual(['haiku', 'sonnet', 'opus']);
    expect(parseArgs(['--model', 'sonnet']).models).toEqual(['sonnet']);
    expect(parseArgs(['--model', 'all']).models).toEqual(['haiku', 'sonnet', 'opus']);
    expect(parseArgs(['--case', 'x', '--scenario', 'y', '--out', 'o', '--dry-run'])).toMatchObject({
      caseName: 'x',
      scenario: 'y',
      out: 'o',
      dryRun: true,
    });
  });
  it('--effort 只认 claude 的五档，不给是 undefined（照定义）', () => {
    expect(parseArgs([]).effort).toBeUndefined();
    expect(parseArgs(['--effort', 'high']).effort).toBe('high');
    expect(() => parseArgs(['--effort', 'turbo'])).toThrow(/只认/);
  });
  it('不认识的参数、缺值、不认识的模型：UsageError', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--case'])).toThrow(/后面要跟值/);
    expect(() => parseArgs(['--model', 'gpt'])).toThrow(/只认/);
  });
});

describe('selectCases', () => {
  it('按完整 id、题名、场景选；选不出报错', () => {
    expect(
      selectCases(ALL_CASES, { caseName: 'fixer/slugify', scenario: undefined }).map((c) => c.id),
    ).toEqual(['fixer/slugify']);
    expect(selectCases(ALL_CASES, { caseName: 'slugify', scenario: undefined })).toHaveLength(1);
    expect(selectCases(ALL_CASES, { caseName: undefined, scenario: 'reviewer' })).toHaveLength(2);
    expect(() => selectCases(ALL_CASES, { caseName: 'nope', scenario: undefined })).toThrow(UsageError);
  });
});

describe('--dry-run', () => {
  it('列出要跑哪些、用什么命令和参数，不起会话；合计次数把裁判会话算进去', async () => {
    const out: string[] = [];
    let launched = 0;
    const code = await main(['--dry-run', '--model', 'all', '--scenario', 'architect'], {
      log: (l) => out.push(l),
      launch: async () => {
        launched++;
        throw new Error('dry-run 不该起会话');
      },
    });
    expect(code).toBe(0);
    expect(launched).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('命令：reclaude');
    expect(text).toContain(
      '[1/3] architect/engine-concurrency-limit · fleet-architect · claude-haiku-5-5 · 加一次裁判会话',
    );
    expect(text).toContain(
      '--model claude-opus-5-5 --effort high --output-format stream-json --verbose --no-session-persistence --setting-sources project --strict-mcp-config --permission-mode dontAsk --allowedTools Read,Grep,Glob,Write,Bash,WebSearch,WebFetch --append-system-prompt <定义正文',
    );
    expect(text).toContain('合计：1 道题 × 3 个模型 = 3 次被测会话，加 3 次裁判会话，共 6 次');
    expect(text).toContain('不做：ui-builder');
    expect(text).toContain('要浏览器，自动探查不做');
  });

  it('全量：每种场景都在，次数 = 题数 × 模型数 + 裁判', () => {
    const lines = dryRunLines(ALL_CASES, ['haiku', 'sonnet', 'opus'], defs, 'reclaude');
    const s = sessionCount(ALL_CASES, ['haiku', 'sonnet', 'opus']);
    expect(s.run).toBe(ALL_CASES.length * 3);
    expect(lines.some((l) => l.includes(`共 ${s.run + s.judge} 次`))).toBe(true);
    for (const sc of new Set(ALL_CASES.map((c) => c.scenario)))
      expect(lines.join('\n')).toContain(`] ${sc}/`);
  });

  it('只跑一档、一道题', async () => {
    const out: string[] = [];
    await main(['--dry-run', '--case', 'scout/route-probe-entry', '--model', 'haiku'], {
      log: (l) => out.push(l),
    });
    expect(out.filter((l) => l.startsWith('['))).toHaveLength(1);
    expect(out.join('\n')).toContain('git archive 1c125c51faee829dfdda48f881c8ec89ff115c97 的快照');
  });

  it('参数不对：退出码 1', async () => {
    const err: string[] = [];
    expect(await main(['--model', 'x'], { err: (l) => err.push(l) })).toBe(1);
    expect(await main(['--case', 'nope'], { err: (l) => err.push(l) })).toBe(1);
  });
});

function stream(answer: string): LaunchResult {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: answer,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  return { exitCode: 0, stdout: line, stderr: '', timedOut: false };
}

describe('跑完写 results.json 和 report.md；退出码', () => {
  const cases: EvalCase[] = ALL_CASES.filter(
    (c) => c.id === 'log-digest/three-failures' || c.id === 'groomer/four-issues-a',
  );

  it('全跑成了（不管过不过）是 0', async () => {
    const out = join(tmp(), 'o');
    const log: string[] = [];
    const code = await main(['--model', 'all', '--out', out], {
      cases,
      log: (l) => log.push(l),
      // 对 groomer 的题回对的，对 log-digest 回错的：有过有没过，退出码仍是 0
      launch: async (req) =>
        stream(
          req.stdin.includes('issues.md') ? '#101: 做完\n#102: 没做完\n#103: 过期\n#104: 没做完' : '没有',
        ),
    });
    expect(code).toBe(0);
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as {
      results: CaseResult[];
      skipped: { scenario: string }[];
    };
    expect(json.results).toHaveLength(6);
    expect(json.results.filter((r) => r.status === 'pass')).toHaveLength(3);
    expect(json.results.filter((r) => r.status === 'fail')).toHaveLength(3);
    expect(json.skipped.map((s) => s.scenario)).toEqual(['ui-builder', 'ui-verifier']);
    const md = readFileSync(join(out, 'report.md'), 'utf8');
    expect(md).toContain('| 场景 | haiku | sonnet | opus |');
    expect(md).toMatch(/\| groomer \| 过 1 \/ 跑 1 遍；均 .* 秒；均 15 token；全过 \|/);
    expect(md).toMatch(/\| log-digest \| 过 0 \/ 跑 1 遍；/);
    expect(md).toContain('<details><summary>groomer/four-issues-a · haiku · 第 1 遍 · 过</summary>');
    expect(md).toContain('提示词：');
    expect(md).toContain('ui-builder（fleet-ui-builder）：要浏览器，自动探查不做');
    expect(log.at(-1)).toContain('没跑成 0');
  });

  it('会话流原样存到 streams/<场景>__<题>__<模型>__<第几次>.jsonl，路径记进 results.json', async () => {
    const out = join(tmp(), 'os');
    const raw = stream('#101: 做完\n#102: 没做完\n#103: 过期\n#104: 没做完').stdout;
    await main(['--model', 'haiku', '--case', 'groomer/four-issues-a', '--out', out], {
      cases,
      log: () => {},
      launch: async () => ({ exitCode: 0, stdout: raw, stderr: '', timedOut: false }),
    });
    const file = join(out, 'streams', 'groomer__four-issues-a__haiku__1.jsonl');
    expect(readFileSync(file, 'utf8')).toBe(raw);
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as { results: CaseResult[] };
    expect(json.results[0]).toMatchObject({
      attempt: 1,
      streamFile: 'streams/groomer__four-issues-a__haiku__1.jsonl',
    });
  });

  it('--repeat 2：每题每模型跑两遍，attempt 1、2，报表写「过 x / 跑 y 遍」；某遍没过「全过」判否', async () => {
    const out = join(tmp(), 'or');
    let n = 0;
    await main(['--model', 'haiku', '--case', 'groomer/four-issues-a', '--repeat', '2', '--out', out], {
      cases,
      log: () => {},
      launch: async () => stream(++n === 1 ? '#101: 做完\n#102: 没做完\n#103: 过期\n#104: 没做完' : '没有'),
    });
    expect(n).toBe(2);
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as { results: CaseResult[] };
    expect(json.results.map((r) => [r.attempt, r.status, r.streamFile])).toEqual([
      [1, 'pass', 'streams/groomer__four-issues-a__haiku__1.jsonl'],
      [2, 'fail', 'streams/groomer__four-issues-a__haiku__2.jsonl'],
    ]);
    expect(existsSync(join(out, 'streams', 'groomer__four-issues-a__haiku__2.jsonl'))).toBe(true);
    const md = readFileSync(join(out, 'report.md'), 'utf8');
    expect(md).toMatch(/\| groomer \| 过 1 \/ 跑 2 遍；.*没全过 \|/);
    expect(md).toContain('| groomer/four-issues-a | 2 |');
  });

  it('--repeat 要正整数；dry-run 合计带遍数', () => {
    expect(parseArgs([]).repeat).toBe(1);
    expect(parseArgs(['--repeat', '3']).repeat).toBe(3);
    expect(() => parseArgs(['--repeat', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--repeat', 'x'])).toThrow(UsageError);
    expect(sessionCount(cases, ['haiku'], 2).run).toBe(4);
  });

  it('有没跑成的是 2，结果里记「没跑成」', async () => {
    const out = join(tmp(), 'o2');
    let n = 0;
    const code = await main(['--model', 'haiku', '--out', out], {
      cases,
      log: () => {},
      launch: async () =>
        ++n === 1
          ? { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' }
          : stream('#101: 做完\n#102: 没做完\n#103: 过期\n#104: 没做完'),
    });
    expect(code).toBe(2);
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as { results: CaseResult[] };
    expect(json.results.map((r) => r.status).sort()).toEqual(['not-run', 'pass']);
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('1 道没跑成');
  });

  it('一次只跑一个会话：上一个没回来，下一个不起', async () => {
    let running = 0;
    let peak = 0;
    await main(['--model', 'all', '--out', join(tmp(), 'o3')], {
      cases,
      log: () => {},
      launch: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return stream('x');
      },
    });
    expect(peak).toBe(1);
  });

  it('默认输出目录是 _tmp/agent-eval/<时刻>/', async () => {
    const root = tmp();
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    for (const d of defs.values())
      writeFileSync(join(root, '.claude', 'agents', `${d.name}.md`), readFileSync(d.file, 'utf8'));
    await main(['--model', 'haiku'], {
      cases: cases.slice(0, 1),
      repoRoot: root,
      now: () => new Date(2026, 9, 9, 8, 7, 6),
      log: () => {},
      launch: async () => stream('x'),
    });
    expect(existsSync(join(root, '_tmp', 'agent-eval', '20261009-080706', 'results.json'))).toBe(true);
    expect(existsSync(join(root, '_tmp', 'agent-eval', '20261009-080706', 'report.md'))).toBe(true);
  });
});

describe('renderReport', () => {
  it('产出里有三个反引号时围栏自动加长，折叠不会被打断', () => {
    const r: CaseResult = {
      caseId: 'a/b',
      scenario: 'a',
      agent: 'x',
      model: 'haiku',
      modelId: 'claude-haiku-5-5',
      effort: 'medium',
      status: 'pass',
      pass: true,
      reason: '好',
      durationMs: 1500,
      inputTokens: 1200,
      outputTokens: 300,
      maxTurns: null,
      turnBudget: 40,
      numTurns: 2,
      prompt: 'p',
      output: '```ts\nx\n```',
      outputTruncated: true,
      judgeUsed: false,
      observedModel: 'claude-haiku-5-5',
      initModel: 'claude-haiku-5-5',
      assistantModel: 'claude-haiku-5-5',
      attempt: 1,
      streamFile: null,
      judgeStreamFiles: [],
    };
    const md = renderReport([r], { startedAt: 't', models: ['haiku'] });
    expect(md).toContain('effort 照各定义');
    expect(md).toContain('模型：claude-haiku-5-5；effort：medium');
    expect(renderReport([r], { startedAt: 't', models: ['haiku'], effort: 'high' })).toContain(
      'effort 一律 high（命令行盖过定义）',
    );
    expect(md).toContain('````text\n```ts\nx\n```\n````');
    expect(md).toContain('产出（已截断）');
    expect(md).toContain('| a | 过 1 / 跑 1 遍；均 1.5 秒；均 1.5k token；全过 | — | — |');
    expect(md).toContain('| a/b | 1 | claude-haiku-5-5 | claude-haiku-5-5 | 过 | 1.5 秒 |');
  });

  it('模型对不上的单列，不算进过几道，读不到的写没读到', () => {
    const base = {
      caseId: 'a/b',
      scenario: 'a',
      agent: 'x',
      model: 'haiku',
      modelId: 'claude-haiku-5-5',
      effort: null,
      durationMs: 1000,
      inputTokens: 1,
      outputTokens: 1,
      maxTurns: null,
      turnBudget: 40,
      numTurns: 1,
      prompt: 'p',
      output: 'o',
      outputTruncated: false,
      judgeUsed: false,
      initModel: null,
      assistantModel: null,
      attempt: 1,
      streamFile: null,
      judgeStreamFiles: [] as string[],
    } as const;
    const mism: CaseResult = {
      ...base,
      status: 'model-mismatch',
      pass: null,
      reason: '点名 haiku，实际 sonnet',
      observedModel: 'claude-sonnet-5-5',
    };
    const unknown: CaseResult = {
      ...base,
      caseId: 'a/c',
      status: 'pass',
      pass: true,
      reason: '好；没读到实际模型',
      observedModel: null,
    };
    const md = renderReport([mism, unknown], { startedAt: 't', models: ['haiku'] });
    expect(md).toContain('## 模型对不上（不算过也不算没过）');
    expect(md).toContain('| a | 过 1 / 跑 1 遍；均 1.0 秒；均 2 token；1 道模型对不上；没全过 | — | — |');
    expect(md).toContain('| a/c | 1 | claude-haiku-5-5 | 没读到 | 过 | 1.0 秒 |');
  });

  it('多遍：场景表写「过 x / 跑 y 遍」，某一遍没过「全过」判否，单题行每遍一行，写明全过的含义', () => {
    const mk = (attempt: number, pass: boolean): CaseResult => ({
      caseId: 'a/b',
      scenario: 'a',
      agent: 'x',
      model: 'haiku',
      modelId: 'claude-haiku-5-5',
      effort: null,
      status: pass ? 'pass' : 'fail',
      pass,
      reason: pass ? '好' : '差',
      durationMs: 1000,
      inputTokens: 1,
      outputTokens: 1,
      maxTurns: null,
      turnBudget: 40,
      numTurns: 1,
      prompt: 'p',
      output: 'o',
      outputTruncated: false,
      judgeUsed: false,
      observedModel: 'claude-haiku-5-5',
      initModel: null,
      assistantModel: null,
      attempt,
      streamFile: `streams/a__b__haiku__${attempt}.jsonl`,
      judgeStreamFiles: [],
    });
    const md = renderReport([mk(1, true), mk(2, false)], { startedAt: 't', models: ['haiku'] });
    expect(md).toContain('| a | 过 1 / 跑 2 遍；均 1.0 秒；均 2 token；没全过 | — | — |');
    expect(md).toContain('| a/b | 1 | claude-haiku-5-5 | claude-haiku-5-5 | 过 | 1.0 秒 |');
    expect(md).toContain('| a/b | 2 | claude-haiku-5-5 | claude-haiku-5-5 | 没过 | 1.0 秒 |');
    expect(md).toContain('多跑几遍时「全过」指每一遍都过');
    expect(md).toContain('- 原始会话流：streams/a__b__haiku__2.jsonl');
    const all = renderReport([mk(1, true), mk(2, true)], { startedAt: 't', models: ['haiku'] });
    expect(all).toContain('过 2 / 跑 2 遍；均 1.0 秒；均 2 token；全过');
  });
});

describe('prepareRepoSnapshot（git archive 导快照，不带 .git）', () => {
  it('从固定提交导出，之后仓里再改也不影响快照', () => {
    const repo = tmp();
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}：${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.email', 'a@example.invalid');
    git('config', 'user.name', 'a');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const ws = prepareRepoSnapshot(sha, repo, tmpdir());
    try {
      // Windows 上 core.autocrlf 会让导出的文件带 CRLF，只比内容。
      expect(readFileSync(join(ws.dir, 'src', 'a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(
        'export const a = 1;\n',
      );
      expect(existsSync(join(ws.dir, '.git'))).toBe(false);
      expect(ws.dir.startsWith(repo)).toBe(false);
    } finally {
      ws.cleanup();
    }
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('提交不存在：抛错（跑题时记成没跑成）', () => {
    const repo = tmp();
    spawnSync('git', ['-C', repo, 'init', '-q']);
    expect(() => prepareRepoSnapshot('0000000000000000000000000000000000000000', repo)).toThrow(
      /git archive/,
    );
  });
});
