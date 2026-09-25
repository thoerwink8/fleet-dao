import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocPointers, formatProblem } from '../src/doc-pointers.ts';
import { type GhResult, ghRunner, issueNew, specsSkeleton } from '../src/issue-new.ts';
import { memRepo } from './helpers.ts';

const MILESTONES = JSON.stringify([{ title: 'P0 地基' }, { title: 'P1 核心闭环' }, { title: 'P4 飞书 v2' }]);
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const URL36 = 'https://github.com/o/r/issues/36';

/** 假 gh：记下每次调用；读里程碑、开单各按给的回。 */
function setup(opts: { milestones?: GhResult; create?: GhResult; specs?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-issue-new-'));
  if (opts.specs !== false) mkdirSync(join(root, 'specs'));
  writeFileSync(join(root, 'body.md'), '原话：给登录页加验证码\n');
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args[0] === 'api') return opts.milestones ?? ok(MILESTONES);
    return opts.create ?? ok(`${URL36}\n`);
  };
  const run = (...argv: string[]) => issueNew(argv, { gh, root, cwd: root });
  return { root, calls, run };
}

const base = ['--kind', '需求', '--milestone', 'P1', '--title', '登录页加验证码', '--body-file', 'body.md'];

describe('开单脚本：缺类别或里程碑就不开', () => {
  it.each([
    [
      '缺 --kind',
      ['--milestone', 'P1', '--title', 't', '--body-file', 'body.md'],
      '缺 --kind：从 需求、缺陷、杂项 里挑一个。',
    ],
    [
      '--kind 不是三个之一',
      ['--kind', 'bug', ...base.slice(2)],
      '--kind 只能是 需求、缺陷、杂项，没有「bug」。',
    ],
    [
      '缺 --milestone',
      ['--kind', '需求', '--title', 't', '--body-file', 'body.md'],
      '缺 --milestone：写这块活属于的阶段',
    ],
    ['缺 --title', ['--kind', '需求', '--milestone', 'P1', '--body-file', 'body.md'], '缺 --title'],
    ['缺 --body-file', ['--kind', '需求', '--milestone', 'P1', '--title', 't'], '缺 --body-file'],
    ['不认得的参数', [...base, '--label', 'x'], '参数不对'],
    ['--specs 的短名带斜杠', [...base, '--specs', 'a/b'], '--specs 的短名「a/b」不行'],
  ])('%s', async (_name, argv, message) => {
    const { calls, run } = setup();
    await expect(run(...argv)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('正文文件读不到：不开', async () => {
    const { calls, run } = setup();
    await expect(run(...base.slice(0, -1), 'nope.md')).rejects.toThrow(
      /--body-file 读不到：.*nope\.md.*单没开/,
    );
    expect(calls).toEqual([]);
  });

  it('要建骨架可仓根下没有 specs/：不开', async () => {
    const { calls, run } = setup({ specs: false });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow('没有 specs/ 目录');
    expect(calls).toEqual([]);
  });
});

describe('开单脚本：一次带上标签和里程碑', () => {
  it('P1 换成里程碑全名；gh issue create 只调一次，标签、里程碑都在这一次里', async () => {
    const { root, calls, run } = setup();
    await expect(run(...base)).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: 'P1 核心闭环',
      specsFile: undefined,
    });
    expect(calls).toEqual([
      ['api', 'repos/{owner}/{repo}/milestones?state=open&per_page=100'],
      [
        'issue',
        'create',
        '--title',
        '登录页加验证码',
        '--body-file',
        join(root, 'body.md'),
        '--label',
        '需求',
        '--milestone',
        'P1 核心闭环',
      ],
    ]);
  });

  it('里程碑写全名也行；前面多一个 -- 也行', async () => {
    const { calls, run } = setup();
    await run('--', ...base.slice(0, 3), 'P4 飞书 v2', ...base.slice(4));
    expect(calls[1]?.slice(-2)).toEqual(['--milestone', 'P4 飞书 v2']);
  });

  it('没有这个开放里程碑：列出开放的，不开', async () => {
    const { calls, run } = setup();
    await expect(run(...base.slice(0, 3), 'P5', ...base.slice(4))).rejects.toThrow(
      '没有叫「P5」的开放里程碑，单没开：开放的有 P0 地基、P1 核心闭环、P4 飞书 v2。',
    );
    expect(calls).toHaveLength(1);
  });

  it('P1 对上两个里程碑：要写全名，不开', async () => {
    const { calls, run } = setup({
      milestones: ok(JSON.stringify([{ title: 'P1 核心闭环' }, { title: 'P1 旧的' }])),
    });
    await expect(run(...base)).rejects.toThrow(
      '「P1」对上了好几个里程碑（P1 核心闭环、P1 旧的），单没开：写全名。',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('开单脚本：gh 出错照实报，不吞', () => {
  it('读里程碑失败：带上 gh 的原话，不开', async () => {
    const { calls, run } = setup({
      milestones: { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials\n' },
    });
    await expect(run(...base)).rejects.toThrow(
      'gh 读里程碑失败（退出码 1），单没开：HTTP 401: Bad credentials',
    );
    expect(calls).toHaveLength(1);
  });

  it('里程碑读回来不是 JSON：不开', async () => {
    const { run } = setup({ milestones: ok('<html>') });
    await expect(run(...base)).rejects.toThrow('gh 读回来的里程碑认不出');
  });

  it('开单失败：带上 gh 的原话，骨架不建', async () => {
    const { root, run } = setup({
      create: { code: 1, stdout: '', stderr: "could not add label: '需求' not found\n" },
    });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      "gh 开单失败（退出码 1），单没开：could not add label: '需求' not found",
    );
    expect(existsSync(join(root, 'specs', '36-登录验证码'))).toBe(false);
  });

  it('gh 说成功了可认不出单号：明说单可能开了、骨架没建', async () => {
    const { root, run } = setup({ create: ok('Creating issue in o/r\n') });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      '认不出单号：Creating issue in o/r。单多半已经开了，去 GitHub 上看一眼；specs 骨架没建。',
    );
    expect(existsSync(join(root, 'specs', '36-登录验证码'))).toBe(false);
  });

  it('gh 起不来（没装、不在 PATH）：回非 0 和一句为什么，不抛', async () => {
    const r = await ghRunner(tmpdir(), 'fleet-no-such-gh-command')(['--version']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('找不到 fleet-no-such-gh-command 命令');
  });
});

describe('开单脚本：--specs 按新单号建需求文档骨架', () => {
  it('建 specs/<号>-<短名>/需求.md，返回路径', async () => {
    const { root, run } = setup();
    const r = await run(...base, '--specs', '登录验证码');
    expect(r.specsFile).toBe('specs/36-登录验证码/需求.md');
    expect(readFileSync(join(root, 'specs', '36-登录验证码', '需求.md'), 'utf8')).toBe(
      specsSkeleton('登录页加验证码', 36, 'P1 核心闭环'),
    );
  });

  it('目录已经在了：不覆盖，明说单已经开了', async () => {
    const { root, run } = setup();
    mkdirSync(join(root, 'specs', '36-登录验证码'));
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      `单开了（#36 ${URL36}），可需求文档骨架没建成：specs/36-登录验证码/ 已经在了，没覆盖。`,
    );
  });

  it('骨架里「对应计划」的引号空着：不填就提交，文档指针检查会红', () => {
    const skeleton = specsSkeleton('登录页加验证码', 36, 'P1 核心闭环');
    expect(skeleton.split('\n').slice(0, 3)).toEqual([
      '# 登录页加验证码（#36）',
      '',
      '对应计划：plan.md P1「」',
    ]);
    const report = checkDocPointers(
      memRepo({
        'docs/plan.md': '# 计划\n\n### P1 核心闭环\n\n- 工作流：需求。\n',
        'specs/36-x/需求.md': skeleton,
      }),
      ['specs/36-x/需求.md'],
    );
    expect(report.problems.map(formatProblem)).toEqual([
      'specs/36-x/需求.md:3  plan.md P1「」引号里是空的，没写是哪一条',
    ]);
  });
});
