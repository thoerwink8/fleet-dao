import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GhResult, ghRunner, issueNew, prBodyAcceptanceItems } from '../src/issue-new.ts';
import { parseOrder } from '../src/plan-view.ts';
import { order } from './fake-github.ts';

const MILESTONES = JSON.stringify([{ title: 'P0 地基' }, { title: 'P1 核心闭环' }, { title: 'P4 飞书 v2' }]);
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr: `${stderr}\n` });
const URL36 = 'https://github.com/o/r/issues/36';

const V1_TITLE = 'v1 Fusion 接活';
/** v1（里程碑 8）的说明：先后里已经排了 #20、#30，标记前后还有别的话。 */
const V1_DESC = `目标：Fusion 接活。\n\n先后：\n${order(20, 30)}\n\n收尾：做完就关。`;
const LIST = 'repos/{owner}/{repo}/milestones?state=open&per_page=100';
const MS8 = 'repos/{owner}/{repo}/milestones/8';

interface FakeMilestone {
  number: number;
  title: string;
  description: string | null;
}
/** 接口回的一个开放里程碑（gh api 读回来的样子）。 */
const msJson = (m: FakeMilestone) => ({ ...m, state: 'open', closed_at: null });

/**
 * 假 GitHub 上的开放里程碑：列表、读一个、改说明（gh api -X PATCH … -f description=…）都按 store 回，改了就记进 store。
 * read、patch 给了就按给的回；patchBody 给了，改照改、回包换成它（故意造出的失败用）。
 */
function milestoneApi(
  list: FakeMilestone[] = [
    { number: 1, title: 'P1 核心闭环', description: null },
    { number: 8, title: V1_TITLE, description: V1_DESC },
  ],
  f: { read?: GhResult; patch?: GhResult; patchBody?: string } = {},
) {
  const store = new Map(list.map((m) => [m.number, { ...m }]));
  const route = (args: string[]): GhResult | undefined => {
    if (args[0] !== 'api') return undefined;
    if (args[1] === LIST) return ok(JSON.stringify([...store.values()].map(msJson)));
    const read = /^repos\/\{owner\}\/\{repo\}\/milestones\/(\d+)$/.exec(args[1] ?? '');
    if (read) {
      const m = store.get(Number(read[1]));
      return f.read ?? (m ? ok(JSON.stringify(msJson(m))) : fail('HTTP 404: Not Found'));
    }
    if (args[1] === '-X' && args[2] === 'PATCH') {
      if (f.patch) return f.patch;
      const m = store.get(Number(/\/milestones\/(\d+)$/.exec(args[3] ?? '')?.[1]));
      const field = args[5] ?? '';
      if (!m || args.length !== 6 || args[4] !== '-f' || !field.startsWith('description=')) {
        return fail(`假 GitHub 认不出这次改里程碑：${JSON.stringify(args)}`);
      }
      m.description = field.slice('description='.length);
      return ok(f.patchBody ?? JSON.stringify(msJson(m)));
    }
    return undefined;
  };
  return { route, description: (n: number) => store.get(n)?.description };
}
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
    similar?: NonNullable<Parameters<typeof issueNew>[1]['similar']>;
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
  const deps = { gh, cwd: root, similar: opts.similar };
  const run = (...argv: string[]) => issueNew(argv, deps);
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
    const { calls, run } = setup({ route: milestoneApi().route });
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
    const { root, calls, run } = setup({ route: milestoneApi().route });
    await expect(run(...base.slice(0, 3), 'v1', ...base.slice(4), '--local')).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: 'v1 Fusion 接活',
      local: true,
      order: { position: 3, count: 3 },
    });
    expect(calls.slice(0, 2)).toEqual([
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
    const { calls, run } = setup({ route: milestoneApi().route });
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

describe('开单脚本：挂版本的母单、单独的单开完排进版本的先后（#807：每天对账查「挂在版本里却没排进先后」）', () => {
  const v1 = [...base.slice(0, 3), 'v1', ...base.slice(4)];
  const created = (calls: string[][]) => calls.some((c) => c[0] === 'issue' && c[1] === 'create');
  const patched = (calls: string[][]) => calls.some((c) => c.includes('PATCH'));
  /** 开了、没排进去时报的话：说清开了哪张、为什么没排进、去哪补（末尾补一行）。 */
  const unordered = (why: string) =>
    `开了 #36（${URL36}），但没排进「v1 Fusion 接活」的先后：${why}。自己去里程碑说明里补：` +
    '打开 https://github.com/o/r/milestone/8 → Edit milestone，在 <!-- fleet:order --> 和 <!-- /fleet:order --> 之间末尾加一行「<序号>. #36」。';

  it('单独的单：先后末尾多一行「3. #36」，标记之外一个字不动；开完读最新的说明再改，结果里记排第几位', async () => {
    const api = milestoneApi();
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).resolves.toEqual({
      number: 36,
      url: URL36,
      milestone: V1_TITLE,
      order: { position: 3, count: 3 },
    });
    expect(api.description(8)).toBe(V1_DESC.replace('2. #30\n', '2. #30\n3. #36\n'));
    expect(calls.map((c) => c.slice(0, 4))).toEqual([
      ['api', LIST],
      ['issue', 'create', '--title', '登录页加验证码'],
      ['api', MS8],
      ['api', '-X', 'PATCH', MS8],
    ]);
    expect(calls.at(-1)?.slice(4)).toEqual(['-f', `description=${api.description(8)}`]);
  });

  it('写进去的就是对账、pnpm plan 认的格式：parseOrder 读回来是 #20、#30、#36，标记前后的话照旧', async () => {
    const api = milestoneApi();
    const { run } = setup({ route: api.route });
    await run(...v1);
    expect(parseOrder(api.description(8) ?? '')).toEqual({
      ok: true,
      order: [20, 30, 36],
      before: '目标：Fusion 接活。\n\n先后：',
      after: '收尾：做完就关。',
    });
  });

  it('--order-after #20：插在 #20 后面，后面的序号顺延', async () => {
    const api = milestoneApi();
    const { run } = setup({ route: api.route });
    await expect(run(...v1, '--order-after', '#20')).resolves.toMatchObject({
      order: { position: 2, count: 3 },
    });
    expect(api.description(8)).toBe(V1_DESC.replace('1. #20\n2. #30\n', '1. #20\n2. #36\n3. #30\n'));
  });

  it('母单（--mother）照样排；--milestone 写版本全名也排', async () => {
    const api = milestoneApi();
    const { run } = setup({ route: api.route });
    await expect(run(...base.slice(0, 3), V1_TITLE, ...base.slice(4), '--mother')).resolves.toMatchObject({
      order: { position: 3, count: 3 },
    });
    expect(parseOrder(api.description(8) ?? '')).toMatchObject({ ok: true, order: [20, 30, 36] });
  });

  it('先后标记之间还空着（新版本）：排成第一张', async () => {
    const empty = '目标。\n<!-- fleet:order -->\n<!-- /fleet:order -->';
    const api = milestoneApi([{ number: 8, title: V1_TITLE, description: empty }]);
    const { run } = setup({ route: api.route });
    await expect(run(...v1)).resolves.toMatchObject({ order: { position: 1, count: 1 } });
    expect(api.description(8)).toBe('目标。\n<!-- fleet:order -->\n1. #36\n<!-- /fleet:order -->');
  });

  it('先后里已经有它（开单和改说明之间有人抢先补了）：不再写一遍，不改说明', async () => {
    const api = milestoneApi([{ number: 8, title: V1_TITLE, description: order(20, 36) }]);
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).resolves.toMatchObject({ order: { position: 2, count: 2 } });
    expect(api.description(8)).toBe(order(20, 36));
    expect(patched(calls)).toBe(false);
  });

  it('子单（--parent）不排：子单在母单页面上排，不读、不改里程碑说明', async () => {
    const api = milestoneApi();
    const parentRoute = (args: string[]): GhResult | undefined => {
      if (args[1] === 'repos/{owner}/{repo}/issues/192') {
        return ok(
          JSON.stringify({ number: 192, state: 'open', labels: [{ name: '需求' }, { name: '母单' }] }),
        );
      }
      if (args[1] === 'repos/{owner}/{repo}/issues/36') return ok(JSON.stringify({ number: 36, id: 9036 }));
      if (args[1] === '-X' && args[2] === 'POST') return ok('{}');
      return undefined;
    };
    const { calls, run } = setup({ route: (args) => parentRoute(args) ?? api.route(args) });
    const r = await run(...v1, '--parent', '192');
    expect(r).toMatchObject({ parent: 192, milestone: V1_TITLE });
    expect(r.order).toBeUndefined();
    expect(api.description(8)).toBe(V1_DESC);
    expect(calls.some((c) => c[1] === MS8)).toBe(false);
    expect(patched(calls)).toBe(false);
  });

  it('未排期不排：没有先后，里程碑一次也不读', async () => {
    const api = milestoneApi();
    const { calls, run } = setup({ route: api.route });
    const r = await run(...base.slice(0, 3), '未排期', ...base.slice(4));
    expect(r.order).toBeUndefined();
    expect(calls.filter((c) => c[0] === 'api')).toEqual([]);
    expect(api.description(8)).toBe(V1_DESC);
  });

  it('旧的 P 阶段不排：没有先后', async () => {
    const api = milestoneApi();
    const { calls, run } = setup({ route: api.route });
    const r = await run(...base);
    expect(r).toMatchObject({ milestone: 'P1 核心闭环' });
    expect(r.order).toBeUndefined();
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['api', LIST],
      ['issue', 'create'],
    ]);
  });

  it('【故意造出的失败】说明里找不到先后标记：单照开、不回滚，明说开了、没排进、怎么补；不改说明', async () => {
    const api = milestoneApi([{ number: 8, title: V1_TITLE, description: '目标：只写了目标，忘了先后' }]);
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).rejects.toThrow(
      unordered(
        '说明里没有先后标记（<!-- fleet:order --> 和 <!-- /fleet:order --> 两行，之间一行一张写「1. #单号」）',
      ),
    );
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['api', LIST],
      ['issue', 'create'],
      ['api', MS8],
    ]);
  });

  it('【故意造出的失败】改里程碑说明失败：单照开，明说没排进、带上 gh 的原话', async () => {
    const api = milestoneApi(undefined, { patch: fail('HTTP 403: Resource not accessible by integration') });
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).rejects.toThrow(
      unordered('gh 改里程碑说明报错（退出码 1）：HTTP 403: Resource not accessible by integration'),
    );
    expect(created(calls)).toBe(true);
    expect(api.description(8)).toBe(V1_DESC);
  });

  it('【故意造出的失败】里程碑说明读不到：单照开，明说没排进，不改说明', async () => {
    const api = milestoneApi(undefined, { read: fail('HTTP 502: Bad Gateway') });
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).rejects.toThrow(
      unordered('gh 读里程碑说明失败（退出码 1）：HTTP 502: Bad Gateway'),
    );
    expect(created(calls)).toBe(true);
    expect(patched(calls)).toBe(false);
  });

  it('【故意造出的失败】里程碑读回来认不出：不当成「没有先后」去瞎改', async () => {
    const api = milestoneApi(undefined, { read: ok('<html>') });
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).rejects.toThrow(
      `开了 #36（${URL36}），但没排进「v1 Fusion 接活」的先后：gh 读回来的里程碑认不出（`,
    );
    expect(patched(calls)).toBe(false);
  });

  it('【故意造出的失败】先后认不出（序号跳了）：不猜着改，照实报', async () => {
    const skipped = '<!-- fleet:order -->\n1. #20\n3. #30\n<!-- /fleet:order -->';
    const api = milestoneApi([{ number: 8, title: V1_TITLE, description: skipped }]);
    const { calls, run } = setup({ route: api.route });
    await expect(run(...v1)).rejects.toThrow(unordered('先后第 2 行的序号写成了 3：从 1 起挨着排'));
    expect(patched(calls)).toBe(false);
    expect(api.description(8)).toBe(skipped);
  });

  it('【故意造出的失败】gh 说改好了、回包里却没有它：不拿退出码 0 当排好了', async () => {
    const stale = JSON.stringify(msJson({ number: 8, title: V1_TITLE, description: V1_DESC }));
    const { run } = setup({ route: milestoneApi(undefined, { patchBody: stale }).route });
    await expect(run(...v1)).rejects.toThrow(
      unordered('gh 说改好了，可改完回来的说明里认不出它（可能已经改了一半）：先打开看一眼'),
    );
  });

  it('【故意造出的失败】--order-after 的单不在先后里：开单前就拦下，gh issue create 一次也不调', async () => {
    const { calls, run } = setup({ route: milestoneApi().route });
    await expect(run(...v1, '--order-after', '99')).rejects.toThrow(
      '--order-after #99 不在「v1 Fusion 接活」的先后里（现在排的是 #20、#30），单没开：写先后里有的单号；不写就排到末尾。',
    );
    expect(calls).toEqual([['api', LIST]]);
  });

  it.each([
    [
      '和 --parent 一起',
      [...v1, '--order-after', '20', '--parent', '192'],
      '--order-after 和 --parent 不能一起用：子单不进版本的先后，在母单 #192 页面上排。',
    ],
    [
      '配未排期',
      [...base.slice(0, 3), '未排期', ...base.slice(4), '--order-after', '20'],
      '--order-after 和 --milestone 未排期 不能一起用：未排期的单没有先后。',
    ],
    [
      '号认不出',
      [...v1, '--order-after', 'abc'],
      '--order-after 写先后里排在它前面的那张单的号（比如 --order-after 450），「abc」认不出。',
    ],
  ])('【故意造出的失败】--order-after %s：不开，gh 一次也不调', async (_name, argv, message) => {
    const { calls, run } = setup({ route: milestoneApi().route });
    await expect(run(...argv)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('【故意造出的失败】--order-after 配旧的 P 阶段：读完里程碑就拦下，不开', async () => {
    const { calls, run } = setup({ route: milestoneApi().route });
    await expect(run(...base, '--order-after', '20')).rejects.toThrow(
      '「P1 核心闭环」不是版本（v<N> 开头的里程碑），没有先后，--order-after 用不上，单没开。',
    );
    expect(calls).toEqual([['api', LIST]]);
  });

  it('【故意造出的失败】版本里程碑读回来缺编号：开单前就拦下（开了也排不进去）', async () => {
    const { calls, run } = setup({
      milestones: ok(JSON.stringify([{ title: V1_TITLE, description: V1_DESC }])),
    });
    await expect(run(...v1)).rejects.toThrow('gh 读回来的里程碑「v1 Fusion 接活」认不出（');
    expect(calls).toEqual([['api', LIST]]);
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

describe('开单脚本：开单前查可能重复的单（#995 拍 3）：只提示，不拦', () => {
  const hit = {
    number: 353,
    title: '登录页加验证码（旧）',
    kind: 'issue' as const,
    score: 0.8,
    why: '标题里都有「验证码」',
  };
  it('查到像的：单照开，结果里带着它；查的时候拿到的是这张单的标题和正文', async () => {
    const asked: { title: string; body: string }[] = [];
    const { calls, run } = setup({
      similar: async (q) => {
        asked.push(q);
        return { found: [hit] };
      },
    });
    const r = await run(...base);
    expect(r.number).toBe(36);
    expect(r.similar).toEqual({ found: [hit] });
    expect(asked).toEqual([{ title: '登录页加验证码', body: BODY }]);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'create')).toBe(true);
  });

  it('【故意造出的失败】没查成：单照开，没查成的原因原样带在结果里（不当成没有重复）', async () => {
    const { run } = setup({ similar: async () => ({ found: [], unchecked: '读开着的单失败' }) });
    const r = await run(...base);
    expect(r.number).toBe(36);
    expect(r.similar).toEqual({ found: [], unchecked: '读开着的单失败' });
  });

  it('不传就不查（别的调用方、别的测试的 gh 调用不多一次）：结果里没有 similar', async () => {
    const { run } = setup();
    expect((await run(...base)).similar).toBeUndefined();
  });

  it('正文不合格（缺「怎么算做完」）：先拒开，连查都不查', async () => {
    let asked = 0;
    const { run } = setup({
      body: '没有任何小节',
      similar: async () => {
        asked += 1;
        return { found: [] };
      },
    });
    await expect(run(...base)).rejects.toThrow();
    expect(asked).toBe(0);
  });
});

describe('开单脚本：怎么算做完里提 PR 正文就拦（冷验收看不到 PR 正文，#1792 / #1764）', () => {
  const withDone = (done: string, scene = '登录页要加验证码。') =>
    [
      '## 场景',
      '',
      scene,
      '',
      '## 原话',
      '',
      '「登录页加验证码。」',
      '',
      '## 已知的模块',
      '',
      '- packages/web 的登录页。',
      '',
      '## 怎么算做完',
      '',
      done,
      '',
    ].join('\n');

  describe('prBodyAcceptanceItems', () => {
    it.each([
      ['PR 正文', '- PR 正文写清根因', '- PR 正文写清根因'],
      ['PR 描述', '1. PR 描述贴 20 次实跑结果', '1. PR 描述贴 20 次实跑结果'],
      ['PR body', '- Mention root cause in the PR body', '- Mention root cause in the PR body'],
      ['pr body 大小写', '- see PR BODY for details', '- see PR BODY for details'],
    ])('中英文写法都能命中：%s', (_name, line, hit) => {
      expect(prBodyAcceptanceItems(`${line}\n- 测试：过期的验证码被拒。`)).toEqual([hit]);
    });

    it('没命中：空列表', () => {
      expect(prBodyAcceptanceItems('- 测试：过期的验证码被拒。\n- 注释里写清根因。')).toEqual([]);
    });
  });

  it('【故意造出的失败】怎么算做完里写「PR 正文」：拒开，gh 一次也不调，报错点明哪一条和冷验收看不到', async () => {
    const { calls, run } = setup({
      body: withDone('- PR 正文写清根因\n- 测试：过期的验证码被拒。'),
    });
    await expect(run(...base)).rejects.toThrow(
      /怎么算做完[\s\S]*看不到 PR 正文[\s\S]*PR 正文写清根因[\s\S]*注释、文档或测试名[\s\S]*单没开/,
    );
    expect(calls).toEqual([]);
  });

  it('带 --allow-pr-body-acceptance：照开，理由追加进怎么算做完末尾', async () => {
    const { calls, run } = setup({
      body: `${withDone('- PR 正文写清根因\n- 测试：过期的验证码被拒。')}## 现状\n\n未开工。\n`,
    });
    await expect(
      run(...base, '--allow-pr-body-acceptance', '这张单人手验 PR 正文，不进引擎'),
    ).resolves.toMatchObject({ number: 36 });
    const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
    const bodyFile = create?.[create.indexOf('--body-file') + 1];
    if (typeof bodyFile !== 'string') throw new Error('没把 --body-file 交给 gh');
    const createdBody = readFileSync(bodyFile, 'utf8');
    expect(createdBody).toMatch(
      /## 怎么算做完[\s\S]*测试：过期的验证码被拒。\n+（开单时带了 --allow-pr-body-acceptance：这张单人手验 PR 正文，不进引擎）\n+## 现状/,
    );
  });

  it('「场景」节里提到 PR 正文不算：怎么算做完干净就能开', async () => {
    const { calls, run } = setup({
      body: withDone(
        '- 测试：过期的验证码被拒。',
        '上次 #1764 验收条写「PR 正文」导致冷验收白跑两轮，这次别再犯。',
      ),
    });
    await expect(run(...base)).resolves.toMatchObject({ number: 36 });
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'create')).toBe(true);
  });
});
