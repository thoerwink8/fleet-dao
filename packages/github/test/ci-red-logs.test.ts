// CI 红了交给动手会话的意见（#2795）：红的 job 名 + 日志尾巴；取不到就明写「日志没取到：原因」。
// 夹具在 test/fixtures/ci-red/：从本仓真实的红 CI 上用 gh api 录的（2026-10-16，run 38887806286 测试红、38884880468 lint 红、
// 38892249992 e2e 红）。检查列表只留判断用到的字段；注解去掉了 blob_href；日志每个分组标记、每条 ##[error]、收尾清理之后的行
// 和收尾清理之前最后若干行原样留着（带 BOM、时间戳前缀、颜色码），其余行为了小一点截掉了（e2e (2/2) 的日志整份没放，当成日志过期）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CheckRun, evaluateChecks, failureDigest } from '../src/checks.ts';
import {
  JOB_LOG_MAX_CHARS,
  JOB_LOG_MAX_LINES,
  jobLogExcerpt,
  RED_TEXT_MAX_CHARS,
} from '../src/ci-failures.ts';
import type { CheckRunState, FakeGitHub } from './fake-github.ts';
import { repo, setup } from './helpers.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'ci-red');

/** 把一个录好的场景装进假 GitHub：这个头上的全部检查、红 job 的日志和注解。返回头的 sha。 */
function load(fake: FakeGitHub, scenario: string): string {
  const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
  const runs = (JSON.parse(read(`${scenario}.check-runs.json`)) as { check_runs: CheckRunState[] })
    .check_runs;
  fake.checkRuns.push(...runs);
  for (const file of readdirSync(DIR)) {
    const log = new RegExp(`^${scenario}\\.log-(\\d+)\\.txt$`).exec(file);
    if (log) fake.jobLogs.set(Number(log[1]), read(file));
    const ann = new RegExp(`^${scenario}\\.annotations-(\\d+)\\.json$`).exec(file);
    if (ann) fake.annotations.set(Number(ann[1]), JSON.parse(read(file)) as unknown[]);
  }
  const sha = runs[0]?.head_sha;
  if (!sha) throw new Error('夹具里没有检查');
  return sha;
}

async function red(scenario: string, tweak: (fake: FakeGitHub) => void = () => {}) {
  const { gh, fake } = setup();
  const head = load(fake, scenario);
  const pr = fake.addPull({ head: { ref: 'task/1', sha: head } });
  tweak(fake);
  const res = await gh.waitCi({ repo, prNumber: pr.number, head });
  if (res.state !== 'red') throw new Error(`应该红，实际 ${res.state}`);
  return { res, fake };
}

const NOISE = [
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 查的就是有没有终端颜色码
  /\u001b\[/, // 颜色码
  /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z/, // GitHub 日志每行的时间戳前缀（七位小数；工具自己打的时间不算）
  /Post job cleanup/,
  /\[command\]\/usr\/bin\/git/,
  /^\uFEFF/m,
];

describe('红了的 job 名和日志尾巴', () => {
  it('测试红：意见里有红的 job（test (5/8 · temporal)）和它日志里的断言行，不带颜色码、时间戳、收尾清理', async () => {
    const { res } = await red('test-red');
    expect(res.failedChecks).toEqual(['check', 'test (5/8 · temporal)']);
    expect(res.digest).toBe('check：failure：红的 job：test (5/8 · temporal)');
    const text = res.detail ?? '';
    expect(text).toContain('红的 job：test (5/8 · temporal)');
    expect(text).toContain('【test (5/8 · temporal)】');
    expect(text).toContain('AssertionError: expected false to be true // Object.is equality');
    for (const noise of NOISE) expect(text).not.toMatch(noise);
    expect(text.length).toBeLessThanOrEqual(RED_TEXT_MAX_CHARS);
  });

  it('lint 红：意见里有红了的 biome 分组的输出（不是后面照跑的步骤）和 lint 日志里的报错行', async () => {
    const { res } = await red('lint-red');
    expect(res.failedChecks).toEqual(['check', 'lint']);
    expect(res.digest).toBe('check：failure：红的 job：lint');
    const text = res.detail ?? '';
    expect(text).toContain('【lint】');
    expect(text).toContain('「biome（退出码 missing，未知 秒）」的输出结尾：');
    expect(text).toContain('Found 6 errors.');
    expect(text).toContain('biome 没过（退出码 missing）');
    expect(text).toContain('lint 里有检查不对： biome（failure，本该 success）');
    for (const noise of NOISE) expect(text).not.toMatch(noise);
  });

  it('e2e 红：两台都红都列；一台日志过期（404）就说「日志没取到」并改读注解，另一台照给尾巴', async () => {
    const { res, fake } = await red('e2e-red');
    expect(res.failedChecks).toEqual(['check', 'e2e (1/2)', 'e2e (2/2)']);
    expect(res.digest).toBe('check：failure：红的 job：e2e (1/2)、e2e (2/2)');
    const text = res.detail ?? '';
    expect(text).toContain('【e2e (1/2)】');
    expect(text).toContain('[laptop-1366] › e2e/specs/12-intake.e2e.ts');
    expect(text).toContain('【e2e (2/2)】');
    expect(text).toMatch(/日志没取到：.*404/);
    expect(text).toContain('Process completed with exit code 1');
    for (const noise of NOISE) expect(text).not.toMatch(noise);
    expect(text.length).toBeLessThanOrEqual(RED_TEXT_MAX_CHARS);
    // 只读了红的那几个 job 的日志，没去碰绿的
    const logged = fake.calls('GET', /\/actions\/jobs\/\d+\/logs$/).map((r) => r.path.split('/')[6]);
    expect(new Set(logged)).toEqual(new Set(['116944370155', '116944370113', '116946453261']));
  });

  it('令牌没有 actions: read（日志 403）：照样红，意见里写明日志没取到和缺什么权限，红的 job 名和注解都在', async () => {
    const { res } = await red('lint-red', (fake) => {
      delete fake.permissions.engine.actions;
    });
    const text = res.detail ?? '';
    expect(res.failedChecks).toEqual(['check', 'lint']);
    expect(text).toContain('日志没取到：');
    expect(text).toContain('actions: read');
    expect(text).toContain('【lint】');
    expect(text).toContain('lint 里有检查不对： biome（failure，本该 success）');
    // 注解里的 Node 20 警告、通用的退出码行都不算报错内容
    expect(text).not.toContain('Node.js 20 is deprecated');
  });

  it('日志和注解都读不到：意见里明写原因，不只剩一句 check 红', async () => {
    const { res } = await red('lint-red', (fake) => {
      fake.before.push((req) =>
        /\/(actions\/jobs\/\d+\/logs|check-runs\/\d+\/annotations)$/.test(req.path)
          ? new Response(JSON.stringify({ message: 'boom' }), {
              status: 502,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      );
    });
    const text = res.detail ?? '';
    expect(text).toContain('红的 job：lint');
    expect(text).toMatch(/日志没取到：.*502/);
    expect(text).toMatch(/注解也没取到：.*502/);
  });

  it('不是 Actions 的红检查（没有日志可读）也不炸：列名字，说日志没取到', async () => {
    const { gh, fake } = setup();
    const head = load(fake, 'lint-red');
    fake.jobLogs.clear();
    fake.annotations.clear();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: head } });
    const res = await gh.waitCi({ repo, prNumber: pr.number, head });
    expect(res).toMatchObject({ state: 'red', failedChecks: ['check', 'lint'] });
    if (res.state !== 'red') return;
    expect(res.detail).toMatch(/日志没取到：.*404/);
    expect(res.detail).toContain('红的 job：lint');
  });
});

describe('判红的纯函数', () => {
  const runs = (name: string) =>
    (JSON.parse(readFileSync(join(DIR, `${name}.check-runs.json`), 'utf8')) as { check_runs: CheckRun[] })
      .check_runs;

  it('汇总 check 红时，evaluateChecks 把同一个头上别的红 job 也列出来，failureDigest 读得到', () => {
    const e = evaluateChecks(['check'], runs('e2e-red'), []);
    expect(e.failed).toEqual(['check']);
    expect(e.failedJobs).toEqual(['e2e (1/2)', 'e2e (2/2)']);
    expect(failureDigest(e)).toBe('check：failure：红的 job：e2e (1/2)、e2e (2/2)');
  });

  it('同名的红 job 被重跑成绿了就不算红（同名取最新）', () => {
    const all = runs('lint-red');
    const lint = all.find((r) => r.name === 'lint');
    if (!lint) throw new Error('夹具里没有 lint');
    const rerun = { ...lint, id: lint.id + 1, conclusion: 'success', started_at: '2099-01-01T00:00:00Z' };
    expect(evaluateChecks(['check'], [...all, rerun], []).failedJobs).toEqual([]);
  });

  it('必过检查自己就是真 job（没有汇总）时，不在 failedJobs 里重复列', () => {
    const e = evaluateChecks(['lint'], runs('lint-red'), []);
    expect(e.failed).toEqual(['lint']);
    expect(e.failedJobs).toEqual(['check']);
  });
});

describe('日志摘录', () => {
  const stamp = (i: number) => `2026-10-16T10:00:${String(i % 60).padStart(2, '0')}.1234567Z`;
  const raw = (lines: string[]) => `\uFEFF${lines.map((l, i) => `${stamp(i)} ${l}`).join('\n')}\n`;

  it('去掉 BOM、时间戳、颜色码，切掉收尾清理和失败之后的步骤', () => {
    const out = jobLogExcerpt(
      raw([
        '##[group]Run pnpm test',
        'pnpm test',
        'env:',
        '  SECRET_LOOKING: x',
        '##[endgroup]',
        ' ✓ ok.test.ts (3 tests) 12ms',
        '\u001b[31mFAIL\u001b[39m a.test.ts > 少了一行',
        'expected 1 to be 2',
        '##[error]Process completed with exit code 1.',
        '##[group]Run actions/upload-artifact@v4',
        'Uploaded bytes 1',
        '##[endgroup]',
        'Post job cleanup.',
        '[command]/usr/bin/git version',
      ]),
    );
    expect(out.tail).toBe(
      'FAIL a.test.ts > 少了一行\nexpected 1 to be 2\n##[error]Process completed with exit code 1.',
    );
    expect(out.errors).toEqual([]);
  });

  it('报错行单列：##[error] 开头的，不含「Process completed」，去重、最多 8 条', () => {
    const lines = ['x'];
    for (let i = 0; i < 12; i += 1) lines.push(`##[error]第 ${i % 10} 个检查没过`);
    lines.push('##[error]Process completed with exit code 1.');
    const out = jobLogExcerpt(raw(lines));
    expect(out.errors).toHaveLength(8);
    expect(new Set(out.errors).size).toBe(8);
    expect(out.errors[0]).toBe('第 0 个检查没过');
  });

  it('紧挨 ##[error] 前面收口的分组是红了的那一步：标题和输出结尾单列，尾巴只留 20 行', () => {
    const lines = [
      '##[group]biome（退出码 1，12 秒）',
      ...Array.from({ length: 60 }, (_, i) => `诊断 ${i}`),
      'Found 6 errors.',
      '##[endgroup]',
      '##[error]biome 没过（退出码 1）',
      '##[group]tsc（退出码 0，54 秒）',
      '##[endgroup]',
      ...Array.from({ length: 50 }, (_, i) => `后面照跑的步骤 ${i}`),
      '##[error]lint 里有检查不对： biome（failure，本该 success）',
      '##[error]Process completed with exit code 1.',
    ];
    const out = jobLogExcerpt(raw(lines));
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]?.title).toBe('biome（退出码 1，12 秒）');
    expect(out.blocks[0]?.body.split('\n').at(-1)).toBe('Found 6 errors.');
    expect(out.blocks[0]?.body.split('\n').length).toBeLessThanOrEqual(30);
    expect(out.errors).toEqual([
      'biome 没过（退出码 1）',
      'lint 里有检查不对： biome（failure，本该 success）',
    ]);
    expect(out.tail.split('\n').length).toBeLessThanOrEqual(20);
    expect(out.tail).toContain('lint 里有检查不对');
  });

  it('红了的分组 + 报错行 + 尾巴合起来不超字数上限', () => {
    const big = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w} ${i} ${'z'.repeat(250)}`);
    const out = jobLogExcerpt(
      raw([
        '##[group]biome',
        ...big(100, '诊断'),
        '##[endgroup]',
        '##[error]biome 没过',
        ...big(100, '后面'),
        '##[error]汇总红了',
      ]),
      { maxChars: 3000 },
    );
    const total =
      out.errors.join('').length +
      out.blocks.reduce((n, b) => n + b.title.length + b.body.length, 0) +
      out.tail.length;
    expect(total).toBeLessThanOrEqual(3000);
    expect(out.blocks[0]?.body.length).toBeGreaterThan(300);
  });

  it('行数、字数、单行长度都有上限，留的是结尾', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(500)}`);
    const out = jobLogExcerpt(raw(lines));
    const kept = out.tail.split('\n');
    expect(kept.length).toBeLessThanOrEqual(JOB_LOG_MAX_LINES);
    expect(out.tail.length).toBeLessThanOrEqual(JOB_LOG_MAX_CHARS);
    expect(kept.at(-1)).toMatch(/^line 4999 /);
    expect(Math.max(...kept.map((l) => l.length))).toBeLessThanOrEqual(310);
  });

  it('没有收尾清理、没有 ##[error]（被取消、超时）也照取结尾', () => {
    const out = jobLogExcerpt(raw(['a', 'b', 'The operation was canceled.']));
    expect(out.tail).toBe('a\nb\nThe operation was canceled.');
  });
});

describe('总量上限', () => {
  it('红了一堆 job：每个有份额、合起来不超总上限、没展开的列名字', async () => {
    const { gh, fake } = setup();
    const head = 'c'.repeat(40);
    const pr = fake.addPull({ head: { ref: 'task/1', sha: head } });
    fake.addCheck(head, 'check', 'failure');
    const big = Array.from(
      { length: 3000 },
      (_, i) => `2026-10-16T10:00:00.0000000Z 行 ${i} ${'y'.repeat(200)}`,
    ).join('\n');
    for (let i = 1; i <= 9; i += 1) {
      const run = fake.addCheck(head, `test (${i}/9)`, 'failure');
      fake.jobLogs.set(run.id, big);
    }
    const res = await gh.waitCi({ repo, prNumber: pr.number, head });
    if (res.state !== 'red') throw new Error('应该红');
    const text = res.detail ?? '';
    expect(text.length).toBeLessThanOrEqual(RED_TEXT_MAX_CHARS);
    expect(text).toContain('另有');
    expect(text).toContain('没展开');
    expect(res.failedChecks).toHaveLength(10);
  });
});
