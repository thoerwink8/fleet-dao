import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GhResult, ghRunner, issueNew } from '../src/issue-new.ts';

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
    body?: string;
    route?: (args: string[]) => GhResult | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-issue-new-'));
  writeFileSync(join(root, 'body.md'), opts.body ?? BODY);
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const routed = opts.route?.(args);
    if (routed) return routed;
    if (args[0] === 'api') return opts.milestones ?? ok(MILESTONES);
    return opts.create ?? ok(`${URL36}\n`);
  };
  const run = (...argv: string[]) => issueNew(argv, { gh, cwd: root });
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
    ['--specs 没有了（需求只在单子正文里，#654）', [...base, '--specs', 'x'], '参数不对'],
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

  it('【故意造出的失败】正文超过 GitHub 一张单的上限：在这里就拒开、gh 一次也不调（一页以内的需求碰不到）', async () => {
    const { calls, run } = setup({ body: `${BODY}\n${'长'.repeat(65_000)}\n` });
    await expect(run(...base)).rejects.toThrow(/正文有 \d+ 字，超过 GitHub 一张单正文的上限.*单没开/);
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

  it('帅位座位整张删掉（#531）：--local 不再替帅位在库里认领（claimLocal 一并删）', async () => {
    const { calls, run } = setup({ milestones: ok(JSON.stringify([{ title: 'v1 Fusion 接活' }])) });
    const r = await run(...base.slice(0, 3), 'v1', ...base.slice(4), '--local');
    expect(r.local).toBe(true);
    expect('claimed' in r).toBe(false);
    expect(calls.some((c) => c[0] === 'api' && JSON.stringify(c).includes('fleetClaim'))).toBe(false);
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

  it('【故意造出的失败】挂子议题报错：明说单开了、没挂上、现在没挂里程碑不会被派，给手动补的步骤；不挂里程碑', async () => {
    const link = { code: 1, stdout: '', stderr: 'HTTP 422: Validation Failed\n' };
    const { calls, run } = setup({ milestones: V1, route: routes({ link }) });
    await expect(run(...sub)).rejects.toThrow(
      `单开了（#36 ${URL36}），可没挂到 #192 下面：gh 挂子议题报错（退出码 1）：HTTP 422: Validation Failed。` +
        '它现在没挂里程碑（未排期，不会被自动派）：在 #192 页面上把它加成子议题，再 gh issue edit 36 --milestone "v1 Fusion 接活"。',
    );
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit')).toBe(false);
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

  it('开单报错：带上 gh 的原话；不说死「没开」（超时、断连时可能已经建了），给标题让人先搜再重开', async () => {
    const { run } = setup({
      create: {
        code: 1,
        stdout: '',
        stderr: 'Post "https://api.github.com/graphql": context deadline exceeded\n',
      },
    });
    await expect(run(...base)).rejects.toThrow(
      'gh 开单报错（退出码 1）：Post "https://api.github.com/graphql": context deadline exceeded。' +
        '单多半没开，可超时、断连时也可能已经建了：先去 GitHub 按标题「登录页加验证码」搜一下，没有再重开。',
    );
  });

  it('gh 说成功了可认不出单号：明说单可能开了、给标题', async () => {
    const { run } = setup({ create: ok('Creating issue in o/r\n') });
    await expect(run(...base)).rejects.toThrow(
      '认不出单号：Creating issue in o/r。单多半已经开了，去 GitHub 按标题「登录页加验证码」找一下。',
    );
  });

  it('gh 起不来（没装、不在 PATH）：回非 0 和一句为什么，不抛', async () => {
    const r = await ghRunner(tmpdir(), 'fleet-no-such-gh-command')(['--version']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('找不到 fleet-no-such-gh-command 命令');
  });
});
