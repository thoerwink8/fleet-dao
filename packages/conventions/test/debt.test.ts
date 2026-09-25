import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDebtDocs,
  checkSpecsDone,
  DEFERRAL_PATTERNS,
  debtFiles,
  doneSection,
  type Finding,
  findDeferrals,
  findingMarker,
  formatDebtProblem,
  liveDebt,
  missingSpecsFindings,
  type RefState,
  refStates,
  reportFindings,
  staleRefFindings,
  untrackedDeferrals,
} from '../src/debt.ts';
import type { GitHubCommenter, GitHubReader, IssueInfo } from '../src/github-api.ts';
import { parseMd } from '../src/markdown.ts';
import { fsRepo } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const phrases = (file: string, text: string) => findDeferrals(parseMd(file, text));

function issue(number: number, extra: Partial<IssueInfo> = {}): IssueInfo {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    isPr: false,
    createdAt: '2026-09-20T00:00:00Z',
    labels: [],
    milestone: 'P1 核心闭环',
    ...extra,
  };
}

/** 假 GitHub：open 里的是开着的 issue，others 里是别的号现在的样子；不在两处的号当作没有。记下每次问了什么。 */
function fakeGh(open: IssueInfo[], others: IssueInfo[] = [], fail?: string) {
  const asked: string[] = [];
  const gh: GitHubReader = {
    async openIssues() {
      asked.push('open');
      if (fail) throw new Error(fail);
      return open;
    },
    async issue(n) {
      asked.push(`#${n}`);
      if (fail) throw new Error(fail);
      return [...open, ...others].find((i) => i.number === n);
    },
    async milestones() {
      return [];
    },
    async openInMilestone() {
      return [];
    },
  };
  return { gh, asked };
}

describe('欠账：词表里每一条都认得出推后的说法', () => {
  const cases: [string, string][] = [
    ['驾驶舱的额度页以后再做。', '以后再做'],
    ['按意思搜以后再加。', '以后再加'],
    ['这块以后要做，现在不管。', '以后要做'],
    ['issue 先不建。', '先不建'],
    ['花费先不设上限。', '先不设'],
    ['仓先不改私有。', '先不改'],
    ['旧的收件箱暂缓。', '暂缓'],
    ['第二台机器暂不接。', '暂不接'],
    ['先观察一周再定。', '观察一周再定'],
    ['挪到后面阶段做。', '后面阶段'],
    ['放到后面的阶段。', '后面的阶段'],
    ['放进后续阶段。', '后续阶段'],
    ['挂到里程碑再说——驾驶舱。', '再说'],
    ['看完账单再定月度上限。', '再定'],
    ['删不删到时问你们。', '到时问'],
    ['专用构建用户留到下一轮。', '留到下一'],
    ['真装一遍留给后续。', '留给后续'],
    ['插头接好之后再打开。', '之后再打开'],
    ['Node 26 转 LTS 之后再评估。', '之后再评估'],
    ['未开工，P1 验收后做。', '验收后做'],
  ];
  it.each(cases)('%s → %s', (text, phrase) => {
    expect(phrases('docs/x.md', text).map((d) => d.phrase)).toEqual([phrase]);
  });

  it('词表每一条上面都有例子', () => {
    const covered = DEFERRAL_PATTERNS.filter((re) => cases.some(([text]) => re.test(text)));
    expect(covered).toHaveLength(DEFERRAL_PATTERNS.length);
  });
});

describe('欠账：不是推后的，不认', () => {
  it.each([
    ['说的是能扩', '以后加机器就是加工人。'],
    ['「先说……再说」是顺序', '先说结果，再说要我做什么；'],
    ['描述行为', '健康检查没过的版本，它以后再发一次、过了，就记回健康。'],
    ['教人怎么查', '以后再查：跑 describe。'],
    ['描述行为', '撤掉之后再查就是缺失。'],
    ['观察记录是名词', '收件箱（观察记录）删掉。'],
    ['留给测试不是推后', '假实现只留给测试。'],
    ['「」引号里是在提这个词', '当初「先不建」是怕法国自动派活。'],
    ['引号套引号也算提', '写「以后再做 / 「先不」」这类话要带单号。'],
    ['反引号里的', '比如 `先不做` 这样写。'],
  ])('%s：%s', (_name, text) => {
    expect(phrases('docs/x.md', text)).toEqual([]);
  });

  it('围栏代码块、HTML 注释里的不认', () => {
    expect(phrases('docs/x.md', '```\n以后再做。\n```\n<!-- 先不建 -->\n')).toEqual([]);
  });
});

describe('欠账：一句一句认，单号要在同一句里', () => {
  it('同一句里的 #号记下；别的仓的（windsurf-dao#12、o/r#3）不算', () => {
    const [d] = phrases('docs/x.md', '月度上限看完账单再定（#37，见 windsurf-dao#12、o/r#3）。');
    expect(d).toMatchObject({ file: 'docs/x.md', line: 1, phrase: '再定', refs: [37], owner: undefined });
  });

  it('单号在下一句：这一句没有单号', () => {
    const [d] = phrases('docs/x.md', '这个以后再做。见 #37。');
    expect(d?.refs).toEqual([]);
    expect(d?.sentence).toBe('这个以后再做。');
  });

  it('句号在引号里不断句；分号、问号、叹号断句', () => {
    const found = phrases('docs/x.md', '他说「好。」以后再做；再定吗？暂缓！');
    expect(found.map((d) => d.phrase)).toEqual(['以后再做', '再定', '暂缓']);
  });

  it('specs/<号>-<短名>/ 下的文档：本单号算这一句的单', () => {
    const [d] = phrases('specs/31-拍板期/需求.md', '未开工，P1 验收后做。');
    expect(d?.owner).toBe(31);
  });
});

describe('欠账（只看文件）：推后的话同一句里要有单号', () => {
  const untracked = (file: string, text: string) =>
    untrackedDeferrals(phrases(file, text)).map(formatDebtProblem);

  it('带单号、或写在需求目录下：过（单号开没开着这里不管）', () => {
    expect(untracked('docs/x.md', '看完账单再定（#37）。')).toEqual([]);
    expect(untracked('docs/x.md', '看完账单再定（#29，早关了）。')).toEqual([]);
    expect(untracked('specs/37-浏览器端口/需求.md', '看完账单再定。')).toEqual([]);
  });

  it('没带单号：报 文件:行、原句、认出的说法和怎么改', () => {
    expect(untracked('docs/x.md', '# 标题\n\n删不删到时问你们。')).toEqual([
      'docs/x.md:3  「删不删到时问你们。」里有「到时问」，同一句里没有单号：开一张带「怎么算做完」和里程碑的 issue（pnpm issue:new）把 #号写进这一句，或者改掉推后的说法',
    ]);
  });

  it('别的仓的单号不算单号', () => {
    expect(untracked('docs/x.md', '留到下一轮（windsurf-dao#12）。')).toHaveLength(1);
  });
});

describe('欠账（定时任务）：挂的单号要是开着的 issue', () => {
  const states = new Map<number, RefState>([
    [37, 'open'],
    [29, 'closed'],
    [53, 'pr'],
    [999, 'missing'],
  ]);
  const stale = (file: string, text: string) => staleRefFindings(phrases(file, text), states);

  it('有一个开着的就过', () => {
    expect(stale('docs/x.md', '看完账单再定（#29、#37）。')).toEqual([]);
    expect(stale('specs/37-浏览器端口/需求.md', '看完账单再定。')).toEqual([]);
  });

  it.each([
    ['关了的：留言到那张关了的单上', '留到下一轮（#29）。', '#29 已经关了', 29],
    ['PR 不是 issue：没处留言', '留到下一轮（#53）。', '#53 是 PR 不是 issue', undefined],
    ['查不到这张：没处留言', '留到下一轮（#999）。', '#999 在 GitHub 上没有', undefined],
    ['号没查过：不当成开着的', '留到下一轮（#7）。', '#7 没查到', undefined],
  ])('单号是%s', (_name, text, why, target) => {
    const [f] = stale('docs/x.md', text);
    expect(f?.text).toContain(`可挂的单号都不是开着的 issue（${why}）`);
    expect(f?.issue).toBe(target);
  });

  it('需求目录的单关了、句子里又没别的单号：留言到那张单上，提醒关单时把推后的话落到新单上', () => {
    const [f] = stale('specs/29-演示版/结果.md', '真装一遍留给后续。');
    expect(f).toMatchObject({ issue: 29, key: 'ref:specs/29-演示版/结果.md:真装一遍留给后续。' });
  });
});

describe('欠账：单号的状态从 GitHub 现读', () => {
  it('开着的一次读完，其余逐个问；PR、关了、没有分开记', async () => {
    const { gh, asked } = fakeGh([issue(37)], [issue(29, { state: 'closed' }), issue(53, { isPr: true })]);
    const states = await refStates([37, 29, 53, 999, 37], gh);
    expect([...states]).toEqual([
      [29, 'closed'],
      [37, 'open'],
      [53, 'pr'],
      [999, 'missing'],
    ]);
    expect(asked).toEqual(['open', '#29', '#53', '#999']);
  });

  it('一个号都没有：不去读 GitHub', async () => {
    const { gh, asked } = fakeGh([]);
    expect((await refStates([], gh)).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('读不到：抛出来，不当成都关了或都开着', async () => {
    const { gh } = fakeGh([], [], '连不上 GitHub（fetch failed）');
    await expect(refStates([37], gh)).rejects.toThrow('连不上 GitHub');
  });
});

describe('欠账：需求.md 要写怎么算做完', () => {
  it('doneSection：有字、只有标题、没有这一节', () => {
    expect(doneSection(parseMd('a.md', '## 怎么算做完\n\n- 测试 x\n'))).toBe('ok');
    expect(doneSection(parseMd('a.md', '## 怎么算做完（二选一）\n\n- 测试 x\n'))).toBe('ok');
    expect(doneSection(parseMd('a.md', '## 怎么算做完\n\n\n## 现状\n\n未开工。\n'))).toBe('empty');
    expect(doneSection(parseMd('a.md', '## 要什么\n\n怎么算做完：随便\n'))).toBe('missing');
  });

  it('逐个目录查：缺文件、缺一节、空一节、目录名没有单号，各报一条', () => {
    const repo = memRepo({
      'specs/1-好的/需求.md': '# x\n\n## 怎么算做完\n\n- 测试 a\n',
      'specs/2-没写/需求.md': '# x\n\n## 要什么\n\n- a\n',
      'specs/3-空的/需求.md': '# x\n\n## 怎么算做完\n\n## 现状\n',
      'specs/4-没需求/方案.md': '# x\n',
      'specs/草稿/需求.md': '# x\n',
    });
    const r = checkSpecsDone(repo);
    expect(r.checked).toBe(3);
    expect(r.problems.map(formatDebtProblem)).toEqual([
      'specs/2-没写/需求.md  没有「## 怎么算做完」一节：写成能检查的样子（测试名、脚本、真机上看到什么）',
      'specs/3-空的/需求.md  「怎么算做完」一节是空的：写成能检查的样子（测试名、脚本、真机上看到什么）',
      'specs/4-没需求/  没有 需求.md（或读不到）',
      'specs/草稿/  目录名认不出单号：要叫 specs/<号>-<短名>/',
    ]);
  });

  it('列不出 specs/：报出来，不当成没有需求目录', () => {
    expect(checkSpecsDone(memRepo({ 'README.md': '' })).problems.map(formatDebtProblem)).toEqual([
      'specs/  列不出 specs/ 下的目录',
    ]);
  });
});

describe('欠账（定时任务）：开着的 issue 在主线上要有需求文档', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const repo = memRepo({ 'specs/28-接真端口/需求.md': '#', 'specs/40-只有方案/方案.md': '#' });

  it('有的过；没有的开单超过一天记一条、留言到那张单上，一天内只提醒；PR 不管', () => {
    const r = missingSpecsFindings(
      repo,
      [
        issue(28),
        issue(40, { title: '按用途分钥匙' }),
        issue(75, { createdAt: '2026-09-26T02:30:00Z' }),
        issue(77, { isPr: true }),
      ],
      now,
    );
    expect(r.findings).toEqual([
      {
        issue: 40,
        key: 'specs:40',
        text: '#40「按用途分钥匙」开着，主线上还没有 specs/40-<短名>/需求.md（开单超过一天）：照 issue 写一份，完整需求只在仓里存一处，issue 上留原话、AI 理解和链接',
      },
    ]);
    expect(r.notes).toEqual(['#75 还没有需求文档，开单 9 小时，一天内补上就行']);
  });

  it('开单时间认不出：当作欠着，不当成新开的', () => {
    const r = missingSpecsFindings(repo, [issue(41, { createdAt: '昨天' })], now);
    expect(r.findings[0]?.text).toContain('开单时间认不出（昨天），当作欠着');
  });

  it('列不出 specs/：报出来', () => {
    const r = missingSpecsFindings(memRepo({}), [issue(28)], now);
    expect(r.problems.map(formatDebtProblem)).toEqual(['specs/  列不出 specs/ 下的目录']);
  });
});

const FILES: Record<string, string> = {
  'AGENTS.md': '# 约定\n\n先说结果，再说要我做什么。\n',
  'README.md': '# 仓\n',
  'docs/design.md': '# 设计\n\n花费看完账单再定（#37）。\n',
  'docs/reference/old.md': '旧系统这块以后再做。\n',
  'specs/37-浏览器端口/需求.md': '# x（#37）\n\n## 怎么算做完\n\n- 测试 a\n\n## 现状\n\nP1 验收后做。\n',
};

describe('欠账（只看文件，pnpm check 里跑）：退出码 0 / 1 / 2', () => {
  it('都齐了：0，说清查了几份、几句', () => {
    const r = checkDebtDocs(memRepo(FILES));
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      '欠账检查（只看文件）过了：4 份文档里 2 句推后的话都带着单号；1 份需求.md 都写了怎么算做完。',
    ]);
  });

  it('docs/reference/ 不查（旧系统审计的快照）', () => {
    expect(debtFiles(memRepo(FILES)).files).toEqual([
      'AGENTS.md',
      'README.md',
      'docs/design.md',
      'specs/37-浏览器端口/需求.md',
    ]);
  });

  it('有欠账：1，逐条列出', () => {
    const r = checkDebtDocs(memRepo({ ...FILES, 'docs/plan.md': '# 计划\n\n删不删到时问你们。\n' }));
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^docs\/plan\.md:3 {2}「删不删到时问你们。」里有「到时问」/);
  });

  it('需求.md 没写怎么算做完：1', () => {
    const r = checkDebtDocs(memRepo({ ...FILES, 'specs/37-浏览器端口/需求.md': '# x\n' }));
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([
      'specs/37-浏览器端口/需求.md  没有「## 怎么算做完」一节：写成能检查的样子（测试名、脚本、真机上看到什么）',
    ]);
  });

  it('一份文档、一份需求.md 都没读到：2，不是「0 个问题」', () => {
    const r = checkDebtDocs(memRepo({ 'specs/': '' }));
    expect(r.code).toBe(2);
    expect(r.lines).toEqual([
      'AGENTS.md  读不到这份文档',
      'README.md  读不到这份文档',
      'docs/  列不出这个目录下的文件，里面的文档没查',
      '没查成：一份文档也没读到。',
      '没查成：specs/ 下一份 需求.md 也没读到。',
    ]);
  });
});

describe('欠账：必过检查必须确定（#87）', () => {
  const repo = memRepo({
    ...FILES,
    'docs/plan.md': '# 计划\n\n留到下一轮（#29）。\n',
    'specs/29-演示版/需求.md': '# x\n\n## 怎么算做完\n\n- 测试 b\n',
  });
  const now = new Date('2026-09-30T00:00:00Z');

  it('同一份代码，#29 开着、关了：只看文件的结果一模一样；定时任务那一半才看得出差别', async () => {
    const whenOpen = fakeGh([issue(37), issue(29)]);
    const whenClosed = fakeGh([issue(37)], [issue(29, { state: 'closed' })]);
    const before = checkDebtDocs(repo);
    const after = checkDebtDocs(repo);
    expect({ code: after.code, lines: after.lines }).toEqual({ code: before.code, lines: before.lines });
    expect(before.code).toBe(0);
    expect(whenOpen.asked).toEqual([]);

    expect((await liveDebt({ repo, gh: whenOpen.gh, now })).findings).toEqual([]);
    const closed = await liveDebt({ repo, gh: whenClosed.gh, now });
    expect(closed.findings.map((f) => f.issue)).toEqual([29]);
    expect(closed.docs.code).toBe(0);
  });

  it('本机没网：只看文件的那一半照常跑完（不读 GitHub）；定时任务那一半判没查成，不当成没欠账', async () => {
    expect(checkDebtDocs(repo).code).toBe(0);
    const offline = fakeGh([], [], '连不上 GitHub（fetch failed）');
    const r = await liveDebt({ repo, gh: offline.gh, now });
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([
      '读不到 GitHub 上单子的状态（连不上 GitHub（fetch failed）），推后的句子挂的单号没核',
      '读不到开着的 issue（连不上 GitHub（fetch failed）），没核它们有没有需求文档',
    ]);
  });

  it('入口不带 --live：真起一个进程、把 fetch 换成一碰就炸的，照样跑完、退出码和进程里一样', () => {
    const bin = fileURLToPath(new URL('../src/bin/debt-check.ts', import.meta.url));
    const noNet = `data:text/javascript,globalThis.fetch=()=>{throw new Error('不许出网')}`;
    const r = spawnSync(process.execPath, ['--import', noNet, bin], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_API_URL: 'http://127.0.0.1:9' },
    });
    const expected = checkDebtDocs(fsRepo(ROOT));
    expect(r.stderr).not.toContain('不许出网');
    expect(r.status).toBe(expected.code);
  });
});

describe('欠账（定时任务）：查出来的留言到单上，同一条只留一次', () => {
  function fakeCommenter(existing: Record<number, string[]>, failOn?: number) {
    const posted: { n: number; body: string }[] = [];
    const gh: GitHubCommenter = {
      async comments(n) {
        if (n === failOn) throw new Error('GitHub 回了 502');
        return existing[n] ?? [];
      },
      async comment(n, body) {
        posted.push({ n, body });
      },
    };
    return { gh, posted };
  }
  const a: Finding = { issue: 29, key: 'ref:a', text: '甲' };
  const b: Finding = { issue: 29, key: 'ref:b', text: '乙' };
  const c: Finding = { issue: 40, key: 'specs:40', text: '丙' };
  const loose: Finding = { issue: undefined, key: 'ref:c', text: '丁' };

  it('一张单一条留言，带记号；以前留过的不再留；没处留言的交回', async () => {
    const { gh, posted } = fakeCommenter({ 40: [`以前的留言${findingMarker('specs:40')}`] });
    const r = await reportFindings([a, b, c, loose], gh);
    expect(r).toEqual({ posted: [29], already: 1, unattached: [loose], errors: [] });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.n).toBe(29);
    expect(posted[0]?.body).toContain(`- 甲${findingMarker('ref:a')}`);
    expect(posted[0]?.body).toContain(`- 乙${findingMarker('ref:b')}`);
  });

  it('读留言失败：记进 errors，不当成留过了', async () => {
    const { gh, posted } = fakeCommenter({}, 29);
    const r = await reportFindings([a, c], gh);
    expect(r.errors).toEqual(['#29 上留言没留成（GitHub 回了 502）']);
    expect(r.posted).toEqual([40]);
    expect(posted.map((p) => p.n)).toEqual([40]);
  });
});

describe('欠账只报告、不挡 PR（创始人 2026-09-26「流程只为快」）', () => {
  const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

  it('pnpm check 里不跑欠账检查；只看文件的那一半在 debt.yml 里跑，失败不把 PR 标红', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toBeDefined();
    expect(pkg.scripts.check).not.toContain('debt-check');
    const yml = read('.github/workflows/debt.yml');
    expect(yml).toMatch(/^ {2}pull_request:/m);
    const docs = yml.slice(yml.indexOf('  debt-docs:'), yml.indexOf('  debt-live:'));
    expect(docs).toContain('continue-on-error: true');
    expect(docs).toMatch(/run: node packages\/conventions\/src\/bin\/debt-check\.ts\s*$/m);
  });
});
