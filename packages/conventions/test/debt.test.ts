import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDebtDocs,
  DEFERRAL_PATTERNS,
  debtFiles,
  doneSection,
  findDeferrals,
  formatDebtProblem,
  liveDebt,
  type RefState,
  refStates,
  staleRefFindings,
  untrackedDeferrals,
} from '../src/debt.ts';
import type { GitHubReader, PlanIssue } from '../src/github-api.ts';
import { parseMd } from '../src/markdown.ts';
import { fsRepo } from '../src/repo.ts';
import { runChild } from './child.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const phrases = (file: string, text: string) => findDeferrals(parseMd(file, text));

function issue(number: number, extra: Partial<PlanIssue> = {}): PlanIssue {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    isPr: false,
    createdAt: '2026-09-20T00:00:00Z',
    labels: [],
    milestone: 'P1 核心闭环',
    stateReason: null,
    subIssues: 0,
    ...extra,
  };
}

/** 假 GitHub：open 里的是开着的 issue，others 里是别的号现在的样子；不在两处的号当作没有。记下每次问了什么。 */
function fakeGh(open: PlanIssue[], others: PlanIssue[] = [], fail?: string) {
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
    async milestoneIssues() {
      return [];
    },
    async subIssues() {
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
    expect(d).toMatchObject({ file: 'docs/x.md', line: 1, phrase: '再定', refs: [37] });
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
});

describe('欠账（只看文件）：推后的话同一句里要有单号', () => {
  const untracked = (file: string, text: string) =>
    untrackedDeferrals(phrases(file, text)).map(formatDebtProblem);

  it('带单号：过（单号开没开着这里不管）', () => {
    expect(untracked('docs/x.md', '看完账单再定（#37）。')).toEqual([]);
    expect(untracked('docs/x.md', '看完账单再定（#29，早关了）。')).toEqual([]);
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

describe('欠账：doneSection 认「怎么算做完」那一节（pnpm issue:new 开单时用）', () => {
  it('doneSection：有字、只有标题、没有这一节', () => {
    expect(doneSection(parseMd('a.md', '## 怎么算做完\n\n- 测试 x\n'))).toBe('ok');
    expect(doneSection(parseMd('a.md', '## 怎么算做完（二选一）\n\n- 测试 x\n'))).toBe('ok');
    expect(doneSection(parseMd('a.md', '## 怎么算做完\n\n\n## 现状\n\n未开工。\n'))).toBe('empty');
    expect(doneSection(parseMd('a.md', '## 要什么\n\n怎么算做完：随便\n'))).toBe('missing');
  });
});

const FILES: Record<string, string> = {
  'AGENTS.md': '# 约定\n\n先说结果，再说要我做什么。\n',
  'README.md': '# 仓\n',
  'agents/shared-rules.md': '# 所有仓通用的规矩\n\n没验证过不说完成。\n',
  'docs/design.md': '# 设计\n\n花费看完账单再定（#37）。\n',
  'docs/reference/old.md': '旧系统这块以后再做。\n',
  // 历史记录不查（#654）：下面两份里推后的话都没带单号，也不报
  'docs/decisions/0001-x.md': '当时拍板：这块以后再做。\n',
  // 进度归档页（#901）是原样搬来的历史节，不改字，所以也不查
  'docs/archive/progress-2026-10-01.md': '## 2026-10-01\n\n下一步：这块以后再做。\n',
  'specs/37-浏览器端口/需求.md': '# x（#37）\n\n## 怎么算做完\n\n- 测试 a\n\n## 现状\n\nP1 验收后做。\n',
};

describe('欠账（只看文件）：退出码 0 / 1 / 2', () => {
  it('都齐了：0，说清查了几份、几句', () => {
    const r = checkDebtDocs(memRepo(FILES));
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['欠账检查（只看文件）过了：4 份文档里 1 句推后的话都带着单号。']);
  });

  it('docs/reference/、docs/decisions/、docs/archive/、specs/ 不查（旧系统快照、历史决定、搬走的历史进度、历史需求）', () => {
    expect(debtFiles(memRepo(FILES)).files).toEqual([
      'AGENTS.md',
      'README.md',
      'agents/shared-rules.md',
      'docs/design.md',
    ]);
  });

  it('通用段原件里推后的话没带单号：照样报（通用段挪出 AGENTS.md 后不能漏查）', () => {
    const r = checkDebtDocs(
      memRepo({ ...FILES, 'agents/shared-rules.md': '# 所有仓通用的规矩\n\n这条以后再加。\n' }),
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^agents\/shared-rules\.md:3 /);
  });

  it('有欠账：1，逐条列出', () => {
    const r = checkDebtDocs(memRepo({ ...FILES, 'docs/notes.md': '# 笔记\n\n删不删到时问你们。\n' }));
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^docs\/notes\.md:3 {2}「删不删到时问你们。」里有「到时问」/);
  });

  it('一份文档都没读到：2，不是「0 个问题」', () => {
    const r = checkDebtDocs(memRepo({}));
    expect(r.code).toBe(2);
    expect(r.lines).toEqual([
      'AGENTS.md  读不到这份文档',
      'README.md  读不到这份文档',
      'agents/shared-rules.md  读不到这份文档',
      'docs/  列不出这个目录下的文件，里面的文档没查',
      '没查成：一份文档也没读到。',
    ]);
  });
});

describe('欠账：必过检查必须确定（#87）', () => {
  const repo = memRepo({
    ...FILES,
    'docs/notes.md': '# 笔记\n\n留到下一轮（#29）。\n',
  });

  it('同一份代码，#29 开着、关了：只看文件的结果一模一样；定时任务那一半才看得出差别', async () => {
    const whenOpen = fakeGh([issue(37), issue(29)]);
    const whenClosed = fakeGh([issue(37)], [issue(29, { state: 'closed' })]);
    const before = checkDebtDocs(repo);
    const after = checkDebtDocs(repo);
    expect({ code: after.code, lines: after.lines }).toEqual({ code: before.code, lines: before.lines });
    expect(before.code).toBe(0);
    expect(whenOpen.asked).toEqual([]);

    expect((await liveDebt({ repo, gh: whenOpen.gh })).findings).toEqual([]);
    const closed = await liveDebt({ repo, gh: whenClosed.gh });
    expect(closed.findings.map((f) => f.issue)).toEqual([29]);
    expect(closed.docs.code).toBe(0);
  });

  it('本机没网：只看文件的那一半照常跑完（不读 GitHub）；定时任务那一半判没查成，不当成没欠账', async () => {
    expect(checkDebtDocs(repo).code).toBe(0);
    const offline = fakeGh([], [], '连不上 GitHub（fetch failed）');
    const r = await liveDebt({ repo, gh: offline.gh });
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([
      '读不到 GitHub 上单子的状态（连不上 GitHub（fetch failed）），推后的句子挂的单号没核',
    ]);
  });

  // 同步起子进程：不靠 vitest 的 5 秒限时，子进程自带上限（child.ts）
  it('入口不带 --live：真起一个进程、把 fetch 换成一碰就炸的，照样跑完、退出码和进程里一样', {
    timeout: 0,
  }, () => {
    const bin = fileURLToPath(new URL('../src/bin/debt-check.ts', import.meta.url));
    const noNet = `data:text/javascript,globalThis.fetch=()=>{throw new Error('不许出网')}`;
    const r = runChild(process.execPath, ['--import', noNet, bin], {
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_API_URL: 'http://127.0.0.1:9' },
    });
    const expected = checkDebtDocs(fsRepo(ROOT));
    expect(r.stderr).not.toContain('不许出网');
    expect(r.status).toBe(expected.code);
  });
});

describe('欠账只报告、不挡 PR（创始人 2026-09-26「流程只为快」）', () => {
  const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

  it('pnpm check 里不跑欠账检查；只看文件的那一半在 debt.yml 里跑（主线推送和每天，不在 PR 上跑，#654），失败不把运行标红', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toBeDefined();
    expect(pkg.scripts.check).not.toContain('debt-check');
    const yml = read('.github/workflows/debt.yml');
    expect(yml).not.toMatch(/^ {2}pull_request:/m);
    expect(yml).toMatch(/^ {2}push:/m);
    expect(yml).toMatch(/^ {2}schedule:/m);
    const docs = yml.slice(yml.indexOf('  debt-docs:'), yml.indexOf('  debt-live:'));
    expect(docs).toContain('continue-on-error: true');
    expect(docs).toMatch(/run: node packages\/conventions\/src\/bin\/debt-check\.ts\s*$/m);
    expect(docs).not.toMatch(/^ {4}if: /m);
  });

  /** debt-live 这一段的 job 级 if；写法换了（没有 debt-live、没有 if）直接抛，不当成「没限制」。 */
  function liveCondition(yml: string): string {
    const at = yml.indexOf('  debt-live:');
    if (at < 0) throw new Error('debt.yml 里找不到 debt-live：写法换了，这条测试跟着改');
    const cond = /^ {4}if: (.+)$/m.exec(yml.slice(at))?.[1];
    if (cond === undefined) throw new Error('debt-live 没有 job 级 if：推主线也会起它');
    return cond.trim();
  }

  it('看 GitHub 现状那一半（debt-live）推主线不起，只在每天定时和手动运行里跑；看文件那一半（debt-docs）推主线照跑', () => {
    const yml = read('.github/workflows/debt.yml');
    expect(liveCondition(yml)).toBe("github.event_name != 'push'");
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('【故意造出的失败】debt-live 的 if 被摘掉、或没有 debt-live：抛错，不当成「没限制」', () => {
    const yml = read('.github/workflows/debt.yml');
    const noIf = yml.replace(/^ {4}if: github\.event_name != 'push'\n/m, '');
    expect(noIf).not.toBe(yml);
    expect(() => liveCondition(noIf)).toThrow('没有 job 级 if');
    expect(() => liveCondition(yml.replace('  debt-live:', '  debt-liv:'))).toThrow('找不到 debt-live');
  });
});
