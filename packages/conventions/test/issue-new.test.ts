import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocPointers, formatProblem } from '../src/doc-pointers.ts';
import { type GhResult, ghRunner, issueNew, issueSummary, specsDoc } from '../src/issue-new.ts';
import { memRepo } from './helpers.ts';

const MILESTONES = JSON.stringify([{ title: 'P0 地基' }, { title: 'P1 核心闭环' }, { title: 'P4 飞书 v2' }]);
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const URL36 = 'https://github.com/o/r/issues/36';
const BODY = [
  '原话：给登录页加验证码（提出人：某某）',
  'AI 理解：登录页发短信验证码，五分钟过期。',
  '',
  '## 要什么',
  '',
  '- 登录页多一个验证码框。',
  '',
  '## 怎么算做完',
  '',
  '- 测试：过期的验证码被拒。',
  '',
].join('\n');

/** 假 gh：记下每次调用；读里程碑、开单各按给的回。 */
function setup(opts: { milestones?: GhResult; create?: GhResult; specs?: boolean; body?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-issue-new-'));
  if (opts.specs !== false) mkdirSync(join(root, 'specs'));
  writeFileSync(join(root, 'body.md'), opts.body ?? BODY);
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

  it('要建需求文档可仓根下没有 specs/：不开', async () => {
    const { calls, run } = setup({ specs: false });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow('没有 specs/ 目录');
    expect(calls).toEqual([]);
  });
});

describe('开单脚本：以后要做的事得写清怎么算做完（design 第三节第 35 条）', () => {
  it.each([
    ['正文里没有「怎么算做完」', '原话：给登录页加验证码\n', '正文里没有「## 怎么算做完」一节，单没开'],
    [
      '「怎么算做完」只有标题、下面空着',
      '原话：x\n\n## 怎么算做完\n\n\n## 现状\n\n未开工。\n',
      '正文里「怎么算做完」一节是空的，单没开',
    ],
    [
      '怎么算做完写在围栏代码块里不算小标题',
      '原话：x\n\n```\n## 怎么算做完\n- 测试\n```\n',
      '正文里没有「## 怎么算做完」一节',
    ],
  ])('%s：不开，gh 一次也不调', async (_name, body, message) => {
    const { calls, run } = setup({ body });
    await expect(run(...base)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('带 --specs 可正文开头就是小标题（没有原话和 AI 理解）：不开', async () => {
    const { calls, run } = setup({ body: '## 怎么算做完\n\n- 测试\n' });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      '--specs 时正文开头（第一个小标题之前）要写原话和 AI 理解',
    );
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

  it('开单报错：带上 gh 的原话；不说死「没开」（超时、断连时可能已经建了），给标题让人先搜再重开；需求文档不建', async () => {
    const { root, run } = setup({
      create: {
        code: 1,
        stdout: '',
        stderr: 'Post "https://api.github.com/graphql": context deadline exceeded\n',
      },
    });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      'gh 开单报错（退出码 1）：Post "https://api.github.com/graphql": context deadline exceeded。' +
        '单多半没开，可超时、断连时也可能已经建了：先去 GitHub 按标题「登录页加验证码」搜一下，没有再重开。',
    );
    expect(existsSync(join(root, 'specs', '36-登录验证码'))).toBe(false);
  });

  it('gh 说成功了可认不出单号：明说单可能开了、给标题、需求文档没建', async () => {
    const { root, run } = setup({ create: ok('Creating issue in o/r\n') });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      '认不出单号：Creating issue in o/r。单多半已经开了，去 GitHub 按标题「登录页加验证码」找一下；需求文档没建。',
    );
    expect(existsSync(join(root, 'specs', '36-登录验证码'))).toBe(false);
  });

  it('gh 起不来（没装、不在 PATH）：回非 0 和一句为什么，不抛', async () => {
    const r = await ghRunner(tmpdir(), 'fleet-no-such-gh-command')(['--version']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('找不到 fleet-no-such-gh-command 命令');
  });
});

describe('开单脚本：--specs 时完整需求进 specs/，issue 上只留原话、AI 理解和路径', () => {
  it('建 specs/<号>-<短名>/需求.md（整份正文），返回路径；issue 正文是第一个小标题之前那段加文档路径', async () => {
    const { root, calls, run } = setup();
    const r = await run(...base, '--specs', '登录验证码');
    expect(r.specsFile).toBe('specs/36-登录验证码/需求.md');
    const doc = readFileSync(join(root, 'specs', '36-登录验证码', '需求.md'), 'utf8');
    expect(doc).toBe(specsDoc('登录页加验证码', 36, 'P1 核心闭环', BODY));
    expect(doc).toContain('## 怎么算做完\n\n- 测试：过期的验证码被拒。');
    expect(doc.trimEnd().endsWith('## 现状\n\n未开工。')).toBe(true);
    const create = calls[1] ?? [];
    expect(create).not.toContain('--body-file');
    expect(create[create.indexOf('--body') + 1]).toBe(
      '原话：给登录页加验证码（提出人：某某）\nAI 理解：登录页发短信验证码，五分钟过期。\n\n' +
        '文档：`specs/<本单号>-登录验证码/需求.md`（完整需求和怎么算做完）\n',
    );
  });

  it('正文自己有「## 现状」就不再补一节', () => {
    const doc = specsDoc('t', 1, 'P1 核心闭环', `${BODY}\n## 现状\n\n依赖 #28。\n`);
    expect(doc.match(/## 现状/g)).toHaveLength(1);
    expect(doc).toContain('依赖 #28。');
  });

  it('issue 上留的那段：第一个小标题之前；没有小标题就是整份', () => {
    expect(issueSummary(BODY)).toBe(
      '原话：给登录页加验证码（提出人：某某）\nAI 理解：登录页发短信验证码，五分钟过期。',
    );
    expect(issueSummary('原话：x\r\nAI 理解：y\r\n')).toBe('原话：x\nAI 理解：y');
  });

  it('目录已经在了：不覆盖，明说单已经开了', async () => {
    const { root, run } = setup();
    mkdirSync(join(root, 'specs', '36-登录验证码'));
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      `单开了（#36 ${URL36}），可需求文档没建成：specs/36-登录验证码/ 已经在了，没覆盖。`,
    );
  });

  it('需求文档里「对应计划」的引号空着：不填就提交，文档指针检查会红', () => {
    const doc = specsDoc('登录页加验证码', 36, 'P1 核心闭环', BODY);
    expect(doc.split('\n').slice(0, 3)).toEqual(['# 登录页加验证码（#36）', '', '对应计划：plan.md P1「」']);
    const report = checkDocPointers(
      memRepo({
        'docs/plan.md': '# 计划\n\n### P1 核心闭环\n\n- 工作流：需求。\n',
        'specs/36-x/需求.md': doc,
      }),
      ['specs/36-x/需求.md'],
    );
    expect(report.problems.map(formatProblem)).toEqual([
      'specs/36-x/需求.md:3  plan.md P1「」引号里是空的，没写是哪一条',
    ]);
  });
});
