import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocPointers, formatProblem } from '../src/doc-pointers.ts';
import {
  type GhResult,
  ghRunner,
  hasSeatRecord,
  issueNew,
  issueSummary,
  type LocalClaim,
  specsDoc,
  specsHint,
} from '../src/issue-new.ts';
import { memRepo } from './helpers.ts';

const MILESTONES = JSON.stringify([{ title: 'P0 地基' }, { title: 'P1 核心闭环' }, { title: 'P4 飞书 v2' }]);
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const URL36 = 'https://github.com/o/r/issues/36';
const BODY = [
  '原话：给登录页加验证码（提出人：某某）',
  'AI 理解：登录页发短信验证码，五分钟过期。',
  '',
  '## 场景',
  '',
  '登录页现在只有密码，被撞库；先加一道验证码。',
  '',
  '## 原话',
  '',
  '「登录页加验证码。」（创始人 2026-09-26）',
  '',
  '## 已知的模块',
  '',
  '- packages/web 的登录页。',
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

/** 假 gh：记下每次调用；读里程碑、开单各按给的回；route 回了的按它（挂子单那几步用）。 */
function setup(
  opts: {
    milestones?: GhResult;
    create?: GhResult;
    specs?: boolean;
    body?: string;
    route?: (args: string[]) => GhResult | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-issue-new-'));
  if (opts.specs !== false) mkdirSync(join(root, 'specs'));
  writeFileSync(join(root, 'body.md'), opts.body ?? BODY);
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const routed = opts.route?.(args);
    if (routed) return routed;
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
  // 三栏（场景、原话、已知的模块）先用最小写法撑住，让「怎么算做完」那一节是要被拦下的那一节
  const PROLOGUE = '## 场景\n\n登录页要加验证码。\n\n## 原话\n\n「加验证码。」\n\n## 已知的模块\n\n暂无。\n';
  it.each([
    [
      '正文里没有「怎么算做完」',
      `原话：给登录页加验证码\n\n${PROLOGUE}`,
      '正文里没有「## 怎么算做完」一节，单没开',
    ],
    [
      '「怎么算做完」只有标题、下面空着',
      `${PROLOGUE}\n## 怎么算做完\n\n\n## 现状\n\n未开工。\n`,
      '正文里「怎么算做完」一节是空的，单没开',
    ],
    [
      '怎么算做完写在围栏代码块里不算小标题',
      `${PROLOGUE}\n\`\`\`\n## 怎么算做完\n- 测试\n\`\`\`\n`,
      '正文里没有「## 怎么算做完」一节',
    ],
  ])('%s：不开，gh 一次也不调', async (_name, body, message) => {
    const { calls, run } = setup({ body });
    await expect(run(...base)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('带 --specs 可正文开头就是小标题（没有原话和 AI 理解）：不开', async () => {
    const { calls, run } = setup({
      body: `${PROLOGUE}\n## 怎么算做完\n\n- 测试\n`,
    });
    await expect(run(...base, '--specs', '登录验证码')).rejects.toThrow(
      '--specs 时正文开头（第一个小标题之前）要写原话和 AI 理解',
    );
    expect(calls).toEqual([]);
  });
});

describe('开单脚本：单子必带场景、原话、已知的模块（specs/553-对题；创始人 2026-10-02）', () => {
  // 最小可开单的正文骨架：四个必填小节都写了字、不写涉及面。砍掉一节、留空一节、加一节涉及面，各成一类故意造出的失败。
  const full = (
    cut: Partial<Record<'场景' | '原话' | '已知的模块' | '怎么算做完' | '涉及面', string | 'omit'>>,
  ) => {
    const blocks: string[] = [];
    const push = (head: string, value: string | 'omit' | undefined, fallback: string) => {
      if (value === 'omit') return;
      blocks.push(head, '', value === undefined ? fallback : value, '');
    };
    push('## 场景', cut['场景'], '登录页要加验证码，被撞库。');
    push('## 原话', cut['原话'], '「登录页加验证码。」（创始人 2026-09-26）');
    push('## 已知的模块', cut['已知的模块'], '- packages/web 的登录页。');
    if (cut['涉及面'] !== undefined) push('## 涉及面', cut['涉及面'], '');
    push('## 怎么算做完', cut['怎么算做完'], '- 测试 x。');
    return blocks.join('\n');
  };

  it('四节都有字：能开', async () => {
    const { calls, run } = setup({ body: full({}) });
    await run(...base);
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each([
    ['场景', '正文里没有「## 场景」一节'],
    ['原话', '正文里没有「## 原话」一节'],
    ['已知的模块', '正文里没有「## 已知的模块」一节'],
  ])('【故意造出的失败】没有「%s」这一节：拒开，gh 一次也不调', async (name, message) => {
    const { calls, run } = setup({ body: full({ [name]: 'omit' }) });
    await expect(run(...base)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it.each([
    ['场景', '「## 场景」一节是空的'],
    ['原话', '「## 原话」一节是空的'],
    ['已知的模块', '「## 已知的模块」一节是空的'],
  ])('【故意造出的失败】「%s」只有标题、下面空着：拒开，gh 一次也不调', async (name, message) => {
    const { calls, run } = setup({ body: full({ [name]: '' }) });
    await expect(run(...base)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('【故意造出的失败】写了「## 涉及面」一节：拒开，明说「那不是算出来的」', async () => {
    const { calls, run } = setup({ body: full({ 涉及面: 'packages/web、packages/api 都要改。' }) });
    await expect(run(...base)).rejects.toThrow(
      '涉及面一律不写：那是算出来的、不是知道的（创始人 2026-10-02「那（涉及面）是算出来的、不是知道的」，specs/553-对题）。建单的 AI 动手前没读过代码，写它只会是猜；把它整节删掉。',
    );
    expect(calls).toEqual([]);
  });

  it('「## 涉及面」只有标题、下面空着也拒开', async () => {
    const { calls, run } = setup({ body: full({ 涉及面: '' }) });
    await expect(run(...base)).rejects.toThrow('涉及面一律不写');
    expect(calls).toEqual([]);
  });

  it('原话写「无（AI 发现）」：能开（单子是 AI 发现的，没有创始人原话可抄）', async () => {
    const { calls, run } = setup({ body: full({ 原话: '无（AI 发现）。' }) });
    await run(...base);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('已知的模块写「暂无」：能开（建单时确实不知道的就照实写）', async () => {
    const { calls, run } = setup({ body: full({ 已知的模块: '暂无。' }) });
    await run(...base);
    expect(calls.length).toBeGreaterThan(0);
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

  it('v1 换成版本全名（里程碑＝版本，创始人 2026-09-26 拍，替代 P 阶段）', async () => {
    const { calls, run } = setup({
      milestones: ok(JSON.stringify([{ title: 'P1 核心闭环' }, { title: 'v1 Fusion 接活' }])),
    });
    await expect(run(...base.slice(0, 3), 'v1', ...base.slice(4))).resolves.toMatchObject({
      milestone: 'v1 Fusion 接活',
    });
    expect(calls[1]?.slice(-2)).toEqual(['--milestone', 'v1 Fusion 接活']);
  });

  it('v1 对上两个版本：要写全名，不开', async () => {
    const { calls, run } = setup({
      milestones: ok(JSON.stringify([{ title: 'v1 Fusion 接活' }, { title: 'v1 旧的' }])),
    });
    await expect(run(...base.slice(0, 3), 'v1', ...base.slice(4))).rejects.toThrow(
      '「v1」对上了好几个里程碑（v1 Fusion 接活、v1 旧的），单没开：写全名。',
    );
    expect(calls).toHaveLength(1);
  });

  it('没有这个开放版本：列出开放的，不开', async () => {
    const { calls, run } = setup({
      milestones: ok(JSON.stringify([{ title: 'v1 Fusion 接活' }])),
    });
    await expect(run(...base.slice(0, 3), 'v9', ...base.slice(4))).rejects.toThrow(
      '没有叫「v9」的开放里程碑，单没开：开放的有 v1 Fusion 接活。',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('开单脚本：--milestone 未排期，不挂里程碑', () => {
  it('不查里程碑列表、建单不带 --milestone，结果里 milestone 记「未排期」', async () => {
    const { root, calls, run } = setup();
    await expect(run(...base.slice(0, 3), '未排期', ...base.slice(4))).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: '未排期',
      specsFile: undefined,
    });
    expect(calls).toEqual([
      [
        'issue',
        'create',
        '--title',
        '登录页加验证码',
        '--body-file',
        join(root, 'body.md'),
        '--label',
        '需求',
      ],
    ]);
  });
});

describe('开单脚本：--mother 多贴「母单」标签', () => {
  it('同一次 gh issue create 里多带 --label 母单；类别标签还是只有一个', async () => {
    const { root, calls, run } = setup();
    await run(...base, '--mother');
    expect(calls[1]).toEqual([
      'issue',
      'create',
      '--title',
      '登录页加验证码',
      '--body-file',
      join(root, 'body.md'),
      '--label',
      '需求',
      '--label',
      '母单',
      '--milestone',
      'P1 核心闭环',
    ]);
  });
});

describe('开单脚本：--local 多贴「本机做」（#299 止血：帅位留给本机做，接活不自动派）', () => {
  it('【故意造出的失败】「本机做」和类别标签、里程碑在同一次 gh issue create 里贴上，不事后补；结果里记 local', async () => {
    const { root, calls, run } = setup({ milestones: ok(JSON.stringify([{ title: 'v1 Fusion 接活' }])) });
    await expect(run(...base.slice(0, 3), 'v1', ...base.slice(4), '--local')).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: 'v1 Fusion 接活',
      specsFile: undefined,
      local: true,
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
        '--label',
        '本机做',
        '--milestone',
        'v1 Fusion 接活',
      ],
    ]);
  });

  it('不带 --local 不贴，结果里也不记', async () => {
    const { calls, run } = setup();
    const r = await run(...base);
    expect(r.local).toBeUndefined();
    expect(calls[1]).not.toContain('本机做');
  });

  it('--local 开完单当场替帅位认领（#299）：单开了才认，认领的结果（认上了、没接过帅位、没认成）原样交回；不带 --local 不认', async () => {
    const { calls, root } = setup({ milestones: ok(JSON.stringify([{ title: 'v1 Fusion 接活' }])) });
    const asked: { issue: number; afterCreate: boolean }[] = [];
    const deps = (result: LocalClaim) => ({
      gh: async (args: string[]): Promise<GhResult> => {
        calls.push(args);
        return args[0] === 'api' ? ok(JSON.stringify([{ title: 'v1 Fusion 接活' }])) : ok(`${URL36}\n`);
      },
      root,
      cwd: root,
      claimLocal: async (issue: number) => {
        asked.push({ issue, afterCreate: calls.some((c) => c[1] === 'create') });
        return result;
      },
    });
    const argv = [...base.slice(0, 3), 'v1', ...base.slice(4), '--local'];
    const claimed: LocalClaim = { state: 'claimed', text: '认领了 o/r#36：认领号 x' };
    expect((await issueNew(argv, deps(claimed))).claimed).toEqual(claimed);
    const failed: LocalClaim = { state: 'failed', why: '没认领上：ssh 连不上 contabo' };
    expect((await issueNew(argv, deps(failed))).claimed).toEqual(failed);
    expect(asked).toEqual([
      { issue: 36, afterCreate: true },
      { issue: 36, afterCreate: true },
    ]);
    expect(
      (await issueNew(base.slice(0, 3).concat('v1', ...base.slice(4)), deps(claimed))).claimed,
    ).toBeUndefined();
    expect(asked).toHaveLength(2);
  });

  it('这台接没接过帅位：~/.fleet-dao/seat/ 里有 main 的记录才算；目录不在是没接过；【故意造出的失败】读不了、名字认不出算「可能接过」（交给 claim.mjs 照实报）', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-seat-home-'));
    expect(hasSeatRecord(home)).toBe(false);
    const dir = join(home, '.fleet-dao', 'seat');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${encodeURIComponent('drill:299__a1')}.json`), '{}');
    expect(hasSeatRecord(home)).toBe(false);
    expect(hasSeatRecord(home, 'drill:299')).toBe(true);
    writeFileSync(join(dir, `${encodeURIComponent('main__s1')}.json`), '{}');
    expect(hasSeatRecord(home)).toBe(true);
    const other = mkdtempSync(join(tmpdir(), 'fleet-seat-home-'));
    mkdirSync(join(other, '.fleet-dao'), { recursive: true });
    writeFileSync(join(other, '.fleet-dao', 'seat'), '不是目录');
    expect(hasSeatRecord(other)).toBe(true);
    const bad = mkdtempSync(join(tmpdir(), 'fleet-seat-home-'));
    mkdirSync(join(bad, '.fleet-dao', 'seat'), { recursive: true });
    writeFileSync(join(bad, '.fleet-dao', 'seat', '%E0%A4%A.json'), '{}');
    expect(hasSeatRecord(bad)).toBe(true);
  });
});

describe('开单脚本：--parent 开子单，先挂到母单下面再挂里程碑（接活不派母单、子单，design 第九节）', () => {
  const V1 = ok(JSON.stringify([{ title: 'P1 核心闭环' }, { title: 'v1 Fusion 接活' }]));
  const sub = [...base.slice(0, 3), 'v1', ...base.slice(4), '--parent', '192'];
  const mother = (over: Record<string, unknown> = {}) =>
    ok(JSON.stringify({ number: 192, state: 'open', labels: [{ name: '需求' }, { name: '母单' }], ...over }));
  /** 母单 #192、新开的 #36（id 9036）；挂子议题、挂里程碑按给的回。 */
  const routes =
    (o: { parent?: GhResult; link?: GhResult; edit?: GhResult } = {}) =>
    (args: string[]): GhResult | undefined => {
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/issues/192') return o.parent ?? mother();
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/issues/36')
        return ok(JSON.stringify({ number: 36, id: 9036 }));
      if (args[0] === 'api' && args[1] === '-X') return o.link ?? ok('{}');
      if (args[0] === 'issue' && args[1] === 'edit') return o.edit ?? ok(`${URL36}\n`);
      return undefined;
    };

  it('【故意造出的失败】建单不带里程碑 → 挂到母单下面 → 再挂里程碑：中间哪一下都不是挂在当前版本上的独立单', async () => {
    const { root, calls, run } = setup({ milestones: V1, route: routes() });
    await expect(run(...sub)).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: 'v1 Fusion 接活',
      specsFile: undefined,
      parent: 192,
    });
    expect(calls).toEqual([
      ['api', 'repos/{owner}/{repo}/milestones?state=open&per_page=100'],
      ['api', 'repos/{owner}/{repo}/issues/192'],
      [
        'issue',
        'create',
        '--title',
        '登录页加验证码',
        '--body-file',
        join(root, 'body.md'),
        '--label',
        '需求',
      ],
      ['api', 'repos/{owner}/{repo}/issues/36'],
      ['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/192/sub_issues', '-F', 'sub_issue_id=9036'],
      ['issue', 'edit', '36', '--milestone', 'v1 Fusion 接活'],
    ]);
  });

  it('写成 #192 也行；未排期的子单挂完就停，不挂里程碑', async () => {
    const { calls, run } = setup({ route: routes() });
    await run(...base.slice(0, 3), '未排期', ...base.slice(4), '--parent', '#192');
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ['api', 'repos/{owner}/{repo}/issues/192'],
      ['issue', 'create', '--title'],
      ['api', 'repos/{owner}/{repo}/issues/36'],
      ['api', '-X', 'POST'],
    ]);
  });

  it('子单带 --local：「本机做」在建单那一次就贴上，挂到母单下面、挂里程碑照旧', async () => {
    const { calls, run } = setup({ milestones: V1, route: routes() });
    await expect(run(...sub, '--local')).resolves.toMatchObject({ number: 36, parent: 192, local: true });
    const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
    expect(create?.slice(-4)).toEqual(['--label', '需求', '--label', '本机做']);
    expect(calls.at(-1)).toEqual(['issue', 'edit', '36', '--milestone', 'v1 Fusion 接活']);
  });

  it.each([
    ['号认不出', 'abc'],
    ['号是 0', '0'],
    ['空的', ''],
  ])('【故意造出的失败】--parent %s：不开，gh 一次也不调', async (_name, value) => {
    const { calls, run } = setup({ route: routes() });
    await expect(run(...base, '--parent', value)).rejects.toThrow('--parent 写母单的号');
    expect(calls).toEqual([]);
  });

  it.each([
    ['是 PR', mother({ pull_request: { url: 'x' } }), '#192 是 PR，不是母单，单没开。'],
    ['已经关了', mother({ state: 'closed' }), '母单 #192 已经关了，单没开'],
    [
      '没贴「母单」',
      mother({ labels: [{ name: '需求' }] }),
      '#192 没贴「母单」标签，单没开：有子单的必须是母单',
    ],
    [
      '读不到',
      { code: 1, stdout: '', stderr: 'HTTP 404: Not Found\n' },
      'gh 读母单 #192 失败（退出码 1），单没开：HTTP 404: Not Found',
    ],
    ['读回来认不出', ok('<html>'), 'gh 读回来的 #192 认不出'],
    ['标签认不出', mother({ labels: 'x' }), 'gh 读回来的 #192 的标签认不出，单没开。'],
  ])('【故意造出的失败】母单%s：不开单', async (_name, parent, message) => {
    const { calls, run } = setup({ milestones: V1, route: routes({ parent }) });
    await expect(run(...sub)).rejects.toThrow(message);
    expect(calls.some((c) => c[0] === 'issue')).toBe(false);
  });

  it('【故意造出的失败】挂子议题报错：明说单开了、没挂上、现在没挂里程碑不会被派，给手动补的步骤；不挂里程碑、需求文档不建', async () => {
    const link = { code: 1, stdout: '', stderr: 'HTTP 422: Validation Failed\n' };
    const { root, calls, run } = setup({ milestones: V1, route: routes({ link }) });
    await expect(run(...sub, '--specs', '登录验证码')).rejects.toThrow(
      `单开了（#36 ${URL36}），可没挂到 #192 下面：gh 挂子议题报错（退出码 1）：HTTP 422: Validation Failed。` +
        '它现在没挂里程碑（未排期，不会被自动派）：在 #192 页面上把它加成子议题，再 gh issue edit 36 --milestone "v1 Fusion 接活"' +
        '；需求文档还没建，挂好以后补上 specs/36-登录验证码/需求.md。',
    );
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit')).toBe(false);
    expect(existsSync(join(root, 'specs', '36-登录验证码'))).toBe(false);
  });

  it('【故意造出的失败】新单的 id 认不出：不挂、照实报', async () => {
    const route = (args: string[]) =>
      args[1] === 'repos/{owner}/{repo}/issues/36' ? ok('{"number":36}') : routes()(args);
    const { calls, run } = setup({ milestones: V1, route });
    await expect(run(...sub)).rejects.toThrow('可没挂到 #192 下面：gh 读回来的这张单认不出 id。');
    expect(calls.some((c) => c[1] === '-X')).toBe(false);
  });

  it('【故意造出的失败】挂上了、里程碑没挂上：明说停在哪一步和怎么补', async () => {
    const edit = { code: 1, stdout: '', stderr: "could not add to milestone 'v1 Fusion 接活'\n" };
    const { run } = setup({ milestones: V1, route: routes({ edit }) });
    await expect(run(...sub)).rejects.toThrow(
      `单开了、挂到 #192 下面了（#36 ${URL36}），可里程碑「v1 Fusion 接活」没挂上（退出码 1）：` +
        'could not add to milestone \'v1 Fusion 接活\'。手动补：gh issue edit 36 --milestone "v1 Fusion 接活"。',
    );
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

  it('里程碑是版本或未排期：「对应计划」直接写版本全名或「未排期」，不留 plan.md 的空引号', () => {
    expect(specsDoc('t', 1, 'v1 Fusion 接活', BODY).split('\n')[2]).toBe('对应计划：v1 Fusion 接活');
    expect(specsDoc('t', 1, '未排期', BODY).split('\n')[2]).toBe('对应计划：未排期');
  });

  it('specsHint：P 阶段（旧写法）才提示填 plan.md 的引号，版本、未排期不用', () => {
    expect(specsHint('P1 核心闭环')).toBe(
      '「对应计划」的引号里填上 plan.md 那一条、「设计依据」写上 design 哪一节再提交',
    );
    expect(specsHint('v1 Fusion 接活')).toBe('「设计依据」写上 design 哪一节再提交');
    expect(specsHint('未排期')).toBe('「设计依据」写上 design 哪一节再提交');
  });
});
