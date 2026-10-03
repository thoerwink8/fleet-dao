import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDocPointers, DOCS, formatProblem, type PointerKind } from '../src/doc-pointers.ts';
import { fsRepo, type RepoView } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DESIGN = [
  '# 设计',
  '',
  '## 一、一句话',
  '',
  '写任务。',
  '- **会话断了接着干**：续上原会话。',
  '',
  '## 二、为什么',
  '',
  '| 现象 | 根因 |',
  '|---|---|',
  '| 没人盯就停 | 要贴标签 |',
  '',
  '## 三、已定',
  '',
  '| # | 事项 |',
  '|---|---|',
  '| 1 | 仓 |',
  '| 2 | 结构 |',
  '',
  '### 仓库结构',
  '',
  '## 八、进度',
  '',
  '- **再主动，做成 `fleet` 命令**：只有 AI 自己知道的事才让它说。',
  '  - 为什么是命令不是 MCP：各家都会跑命令。',
  '',
  '## 十五、驾驶舱',
  '',
  '### 15.1 看板',
  '',
  '1. **随手记任务**：说一句话。',
  '2. **只推三类消息**：别的不推。',
  '',
].join('\n');

const OPS = [
  '# 运维',
  '',
  '## 一、两台机器',
  '',
  '装法在 `deploy/france.sh`。',
  '',
  '## 二、备份与恢复',
  '',
  '每晚备份。',
  '',
].join('\n');

const README = [
  '# 仓',
  '',
  '## 常用',
  '',
  '- 跑检查：`pnpm check`。',
  '',
  '## 文档各管什么',
  '',
  '| 文件 | 管什么 |',
  '',
].join('\n');

const BASE: Record<string, string> = {
  'docs/design.md': DESIGN,
  'docs/ops.md': OPS,
  'README.md': README,
  'deploy/france.sh': '',
  'deploy/hk.sh': '',
  'packages/x/src/a.ts': '',
};

/** 在某份文档末尾加几行，返回查的结果和加的第一行的行号。 */
function withLines(file: string, lines: string[], extra: Record<string, string> = {}) {
  const base = BASE[file] ?? '';
  const first = base.split('\n').length;
  const report = checkDocPointers(memRepo({ ...BASE, ...extra, [file]: `${base}${lines.join('\n')}\n` }));
  return { report, first };
}

describe('文档指针：底子本身都指得到', () => {
  it('夹具的几份文档 0 个问题', () => {
    const report = checkDocPointers(memRepo(BASE));
    expect(report.problems.map(formatProblem)).toEqual([]);
    expect(report.files).toEqual([...DOCS]);
  });
});

describe('文档指针：故意弄断的，逐条报 文件:行', () => {
  const cases: [name: string, file: string, line: string, message: string][] = [
    ['反引号里的路径不在', 'README.md', '- 看 `docs/nope.md`。', 'docs/nope.md 在仓里没有'],
    [
      '反引号里命令带的路径不在',
      'docs/ops.md',
      '- 跑 `bash deploy/gone.sh --check`。',
      'deploy/gone.sh 在仓里没有',
    ],
    [
      '大小写对不上（CI 在 Linux 上）',
      'README.md',
      '- 看 `deploy/France.sh`。',
      'deploy/France.sh 在仓里没有',
    ],
    ['通配一个也对不上', 'docs/ops.md', '单元是 `deploy/*.service`。', 'deploy/*.service 在仓里没有'],
    [
      '路径穿过一个文件：算没有，不算读不到',
      'docs/ops.md',
      '见 `deploy/france.sh/x`。',
      'deploy/france.sh/x 在仓里没有',
    ],
    [
      '链接指的文件不在',
      'README.md',
      '- [旧计划](docs/old.md)',
      '链接 docs/old.md 指的 docs/old.md 在仓里没有',
    ],
    [
      '相对链接按文档所在目录算',
      'docs/ops.md',
      '见 [计划](../docs/plan2.md)。',
      '链接 ../docs/plan2.md 指的 docs/plan2.md 在仓里没有',
    ],
    ['正文里不带反引号的路径不在', 'docs/ops.md', '装法见 deploy/gone.sh。', 'deploy/gone.sh 在仓里没有'],
    ['第 X 节不在', 'docs/design.md', '见第九节。', 'docs/design.md 里没有第九节'],
    ['别的文档的第 X 节不在', 'docs/design.md', '去向见 ops.md 第五节。', 'docs/ops.md 里没有第五节'],
    [
      '第 X 节后面引的话不在那一节',
      'docs/design.md',
      '见第二节「没人管就停」。',
      'docs/design.md 第二节里找不到「没人管就停」',
    ],
    ['第 X 节第 N 条不在', 'docs/design.md', '（第三节第 9 条）', 'docs/design.md 第三节里没有第 9 条'],
    ['X.Y 小节不在', 'docs/design.md', '飞书：见 15.9。', 'docs/design.md 里没有 15.9 这一小节'],
    ['X.Y 第 N 件不在', 'README.md', '见 design 15.1 第 7 件。', 'docs/design.md 15.1里没有第 7 件'],
    [
      '文档名加「标题」，标题不在',
      'docs/design.md',
      '见 README「怎么装」。',
      'README.md 里没有叫「怎么装」的标题',
    ],
    ['「标题」一节不在', 'docs/ops.md', '（「换机恢复」一节）', 'docs/ops.md 里没有叫「换机恢复」的一节'],
    // 下面两条是写法本身的问题：没说哪份、指自己这份里的标题
    [
      '没有编号小节的文档里光写「第 X 节」、没说哪份',
      'README.md',
      '设计依据：第三节。',
      '「第三节」没说是哪份文档（README.md 自己没有编号的节）：前面写上 design 或 ops',
    ],
    [
      '「「X」一节」指的是它自己的标题，自己没有这一节',
      'README.md',
      '拆分见「先后」一节。',
      'README.md 里没有叫「先后」的一节',
    ],
  ];

  it.each(cases)('%s', (_name, file, line, message) => {
    const { report, first } = withLines(file, [line]);
    expect(report.problems).toEqual([{ file, line: first, message }]);
  });

  it('引的话只认原文：写大意、小标题改了名、指到别的节都报，原文照过', () => {
    const spec = 'docs/ops.md';
    const { report, first } = withLines(spec, [
      '见 design 第八节「为什么是命令不是 MCP」。', // 原文
      '见 design 第八节「做成命令不是 MCP」。', // 上下两条拼出来的大意
      '见 design 第三节「仓库目录」。', // 「仓库结构」改名后的样子
      '见 design 第十五节「为什么是命令不是 MCP」。', // 指到别的节
    ]);
    expect(report.problems.map(formatProblem)).toEqual([
      `${spec}:${first + 1}  docs/design.md 第八节里找不到「做成命令不是 MCP」`,
      `${spec}:${first + 2}  docs/design.md 第三节里找不到「仓库目录」`,
      `${spec}:${first + 3}  docs/design.md 第十五节里找不到「为什么是命令不是 MCP」`,
    ]);
  });

  it('#41 审查在真文档上造的三种断法都报：删掉引的那一条、改掉半个标签、意思改反', () => {
    const spec = 'docs/ops.md';
    const pointers = [
      '见 design 第八节「为什么是命令不是 MCP」。',
      '见 design 第八节「再主动，做成 fleet 命令」。',
      '见 design 第一节「会话断了接着干」。',
    ];
    expect(withLines(spec, pointers).report.problems).toEqual([]);
    const broken = DESIGN.replace('  - 为什么是命令不是 MCP：各家都会跑命令。\n', '')
      .replace('做成 `fleet` 命令', '做成 `fleet` 配置')
      .replace('会话断了接着干', '会话断了从头干');
    const { report, first } = withLines(spec, pointers, { 'docs/design.md': broken });
    expect(report.problems.map(formatProblem)).toEqual([
      `${spec}:${first}  docs/design.md 第八节里找不到「为什么是命令不是 MCP」`,
      `${spec}:${first + 1}  docs/design.md 第八节里找不到「再主动，做成 fleet 命令」`,
      `${spec}:${first + 2}  docs/design.md 第一节里找不到「会话断了接着干」`,
    ]);
  });

  it('一行里前面写了哪份文档，后面光写的「第 X 节」「X.Y」也按那份查', () => {
    const file = 'docs/ops.md';
    const { report, first } = withLines(file, ['设计依据：design 第一节、第九节；15.1 第 9 件。']);
    expect(report.problems.map(formatProblem)).toEqual([
      `${file}:${first}  docs/design.md 里没有第九节`,
      `${file}:${first}  docs/design.md 15.1里没有第 9 件`,
    ]);
  });

  it('要查的文档读不到、别的文档指过去的那份读不到，都报出来，不当成没问题', () => {
    const files = { ...BASE };
    delete files['docs/ops.md'];
    const report = checkDocPointers(memRepo({ ...files, 'README.md': `${README}- 装机：ops 第一节。\n` }));
    expect(report.problems.map(formatProblem)).toEqual([
      'docs/ops.md:0  读不到这份文档',
      `README.md:${README.split('\n').length}  读不到 docs/ops.md`,
    ]);
  });
});

describe('文档指针：认得出的写法', () => {
  const good = [
    '见第二节「没人盯就停」，（第三节第 2 条）。', // 章节 + 引的话、第 N 条
    '按 15.1：说一句话；重做（15.1）；见 design 15.1 第 2 件。', // X.Y 的几种写法
    '见 README「文档各管什么」，见 design「随手记任务」，`docs/design.md`「三、已定」。', // 标题、加粗的字
    '设计依据：design 第一节、第十五节「随手记任务」；15.1 第 1 件。', // 同一行后面接着写的也算 design 的
    '装法：`deploy/france.sh`、`deploy/*.sh`、packages/x/src/a.ts，[运维](../docs/ops.md)。', // 路径、通配、链接
  ];

  it('都指得到，每一种都认出来了', () => {
    const { report, first } = withLines('docs/design.md', good);
    expect(report.problems.map(formatProblem)).toEqual([]);
    const mine = report.pointers.filter((p) => p.file === 'docs/design.md' && p.line >= first);
    const kinds = new Set<PointerKind>(mine.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(
      ['item', 'link', 'path', 'quote', 'section', 'subsection', 'title'].sort(),
    );
    expect(mine.map((p) => p.text)).toEqual(
      expect.arrayContaining([
        'docs/design.md「三、已定」',
        'docs/design.md 15.1 第 1 件',
        'deploy/*.sh',
        '../docs/ops.md',
      ]),
    );
  });

  it('ops 自己的「「备份与恢复」一节」按 ops 的标题认', () => {
    const { report, first } = withLines('docs/ops.md', ['（「备份与恢复」一节）']);
    expect(report.problems).toEqual([]);
    expect(report.pointers).toContainEqual({
      kind: 'title',
      file: 'docs/ops.md',
      line: first,
      text: 'docs/ops.md「备份与恢复」一节',
    });
  });
});

describe('文档指针：故意不查的', () => {
  const ignored: [name: string, file: string, lines: string[]][] = [
    ['围栏代码块里的示例', 'docs/design.md', ['```', 'edge/  以后才有', '见第九节 `docs/nope.md`', '```']],
    ['HTML 注释里的占位', 'README.md', ['<!-- 见第九节，`docs/nope.md` -->']],
    ['别的仓的路径', 'docs/ops.md', ['按 windsurf-dao 仓 `docs/decisions/x.md` 的「先观测」。']],
    [
      '版本号、小数不当小节号',
      'docs/design.md',
      ['用 Opus 5.5（先用订阅）、Node 22.23、内存先按 1.2–1.6G 估。'],
    ],
    ['没有小节编号的文档里，括号里的小数也不当', 'docs/ops.md', ['最高是 16（16.6）。']],
    [
      '别的仓 README 的「…」两节',
      'README.md',
      ['见那个仓 README 的「解开一个文件」和「法国整机没了怎么恢复」两节。'],
    ],
    [
      '机器上的路径、家目录、标签名、占位',
      'docs/ops.md',
      ['`/etc/fleet-dao/x.env`、`~/.fleet-dao/k.txt`、`model/`、`kind/bug`、`specs/<号>-<短名>/`、`hk.env`'],
    ],
    ['外面的链接', 'README.md', ['[里程碑](https://github.com/o/r/milestones)、[这一段](#常用)']],
    ['路径后面紧跟中文，截不准的不查', 'docs/ops.md', ['放 specs/99-不存在/ 下面']],
    ['不是指针的「节」', 'docs/design.md', ['见 docs/ops.md 的 PX 一节；前面各节；验证环节；第一个里程碑。']],
  ];

  it.each(ignored)('%s', (_name, file, lines) => {
    const { report, first } = withLines(file, lines);
    expect(report.problems.map(formatProblem)).toEqual([]);
    const mine = report.pointers.filter((p) => p.file === file && p.line >= first);
    // 「不是指针」那条里的 docs/ops.md 本身是个真路径，照查；别的一条都不该认
    expect(mine.filter((p) => p.text !== 'docs/ops.md')).toEqual([]);
  });

  it('引擎会话在检出里落的 .fleet-out/（不进仓）不当仓里的顶层目录：指到里面的文件不报「没有」', () => {
    const { report, first } = withLines('docs/design.md', ['结论写 `.fleet-out/verify.json`。'], {
      '.fleet-out/lead-brief.json': '{}',
    });
    expect(report.problems.map(formatProblem)).toEqual([]);
    expect(report.pointers.filter((p) => p.file === 'docs/design.md' && p.line >= first)).toEqual([]);
  });
});

describe('文档指针：读不到的明确报「没查成」，不当成「没有」', () => {
  // 列目录回 undefined 有两种：不是目录（路径穿过了一个文件，算没有）、是目录却读不到（在不在没查成）。
  // 读不到不能当成「没有」悄悄吞掉（#162 合并后补审）。
  function broken(file: string, lines: string[], breakRepo: (repo: RepoView) => RepoView) {
    const base = BASE[file] ?? '';
    const first = base.split('\n').length;
    const repo = memRepo({ ...BASE, [file]: `${base}${lines.join('\n')}\n` });
    return { report: checkDocPointers(breakRepo(repo)), first };
  }
  /** dir 是目录，却列不出来。 */
  const unlistable =
    (dir: string) =>
    (repo: RepoView): RepoView => ({ ...repo, list: (rel) => (rel === dir ? undefined : repo.list(rel)) });

  it.each(['README.md', 'docs/design.md'])('%s：路径、链接经过的目录列不出来', (file) => {
    const link = `${'../'.repeat(file.split('/').length - 1)}packages/x/README.md`;
    const { report, first } = broken(
      file,
      ['新建 `packages/x/src/new.ts`。', `见 [说明](${link})。`],
      unlistable('packages/x'),
    );
    expect(report.problems.map(formatProblem)).toEqual([
      `${file}:${first}  packages/x/src/new.ts 在不在没查成：读不到 packages/x/`,
      `${file}:${first + 1}  链接 ${link} 指的 packages/x/README.md 在不在没查成：读不到 packages/x/`,
    ]);
  });

  it('指的是目录、却连它是不是目录都看不出（stat 失灵）', () => {
    const statBroken = (repo: RepoView): RepoView => ({
      ...repo,
      isDir: (rel) => rel !== 'deploy' && repo.isDir(rel),
      exists: (rel) => rel !== 'deploy' && repo.exists(rel),
    });
    const { report, first } = broken('README.md', ['装法放 `deploy/` 下。'], statBroken);
    expect(report.problems.map(formatProblem)).toEqual([
      `README.md:${first}  deploy/ 在不在没查成：读不到 deploy/`,
    ]);
  });

  it('仓根列不出来：报出来，不当成「没有路径指针」', () => {
    const { report } = broken('docs/ops.md', ['装法在 `deploy/nope.sh`。'], unlistable(''));
    expect(report.problems.map(formatProblem)).toEqual(['.:0  列不出仓根下的文件：路径、链接指针都没法查']);
  });
});

describe('全仓的文档（main 上现有的，加上本 PR 改的）', () => {
  const report = checkDocPointers(fsRepo(ROOT));

  it('只查 design、ops、README 这几份活文档，specs/ 和 docs/decisions/ 是历史记录不查（#654）', () => {
    expect(report.files).toEqual([...DOCS]);
  });

  // 每一类先断言「认出了至少一个」：规则认不出了，和「全都指得到」看起来一样是绿的，得分开。
  // 某一类指针在文档里真的删光了，就把它从这里去掉。
  it('每一类指针都认出了至少一个', () => {
    const empty = Object.entries(report.checked).filter(([, n]) => n === 0);
    expect(empty).toEqual([]);
  });

  it('都指得到', () => {
    expect(report.problems.map(formatProblem)).toEqual([]);
  });
});
