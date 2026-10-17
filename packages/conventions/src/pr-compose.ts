// pnpm pr:open 自己生成 PR 正文（母单 #1066 第二片，审计第四节第 7 条）：工人原来要先写 _tmp/pr-body.md、再单跑一次
// pnpm issue:new（62 秒）、再贴创始人原话，纸面活加起来每个 PR 约 1–1.5 分钟。现在不给 --body-file 就在这里拼好再交给 prOpen
// （pr-open.ts）——开 PR、挂单、挂里程碑、挂自动合并的闸一处不改，这里只管「正文从哪来」：
// - 「做了什么」：这条分支相对 origin/<base> 的提交说明（只取第一行；一条就是一句话，多条列成短列表）。
// - 「需求」：--closes <号> → Closes #号；--refs <号> → Refs #号（分片、关不了它）（合并收口认这几个字才不关母单）；--no-issue "<理由>" 照旧由 prOpen 写成「无：理由」；
//   --new-issue "<标题>" 当场开一张单（复用 issue-new.ts 的 issueNew，类别 --kind、里程碑 --milestone 必须给，缺了拒开）并 Closes 它。
//   这张单一律贴「本机做」（--local 加了不报错，也不多贴一次）：随 PR 开出的单已经有人在做，不靠人记得加 --local（#1199）。
// - 改标准：--founder-quote "<原话>" --at "<时间>" 在「需求」栏下面另起一行写「人闸：改标准」、再写一段「创始人原话」，并等价于
//   --founder-approved（旧的 --founder-approved 加手写段落照旧能用）。
// - 写码模型：分支上各提交带 Co-Authored-By: Claude … 尾注时，正文末尾写一行「**写码模型**：claude-haiku-5-5」（pnpm subagent:stats 靠它认 Haiku 开的 PR，#2821）；
//   没有尾注不写；读不到尾注照开 PR、提示一句。
// 给了 --body-file 就一字不动交给 prOpen（原有用法照旧）；生成用的参数和 --body-file 不能混着用，只有 --founder-quote 加 --at 例外：
// 它们把「人闸：改标准」和「创始人原话」追加到自己写的正文末尾。
// 退出码同 prOpen：0 开成了；1 用法不对、没单或单有问题（什么也没做，--new-issue 的单在 PR 之前开，PR 没开不回滚单，照报）；
// 2 没做成（提交说明读不到、路径清单读不到、gh 没跑成……）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Gh as IssueGh, issueNew } from './issue-new.ts';
import { requireAxis } from './labels.ts';
import { type Gh, loadPathLists } from './pr-arm.ts';
import { founderQuoteLine, GATE_LINE, ISSUE_COLUMN } from './pr-columns.ts';
import { branchIssue, type OpenDeps, PR_OPEN_USAGE, prOpen } from './pr-open.ts';
import { writerLine, writerModelsFromTrailers } from './subagent-stats.ts';

export interface CliDeps extends OpenDeps {
  /** 跑 git（在敲命令的目录里）：读分支上的提交说明。 */
  git: Gh;
  /** issue-new 用的 gh（异步）：--new-issue 开单。 */
  issueGh: IssueGh;
}

/** 「做了什么」里最多列几条提交说明，再多的写「……另有 N 条」。 */
const MAX_COMMITS = 8;

/** --new-issue 开的单已经有人在做：写进新单正文、PR 需求栏和命令输出。 */
export const NEW_ISSUE_LOCAL_LINE = '这张单随 PR 开出，已贴本机做，引擎不拉';

export interface BodyParts {
  /** 提交说明，从早到晚。 */
  did: readonly string[];
  closes: readonly number[];
  refs: readonly number[];
  /** 创始人原话和时间：给了就写「人闸：改标准」和「创始人原话」。 */
  founder?: { quote: string; at: string } | undefined;
  /** --new-issue：需求栏写明这张单已贴本机做、引擎不拉。 */
  withNewIssue?: boolean;
  /** 分支上各提交 Co-Authored-By 尾注里的写码模型（完整 id）：有就在正文末尾写一行「**写码模型**：…」，pnpm subagent:stats 靠它认 Haiku 开的 PR。 */
  writers?: readonly string[];
}

/** 拼正文：栏的写法和 .github/pull_request_template.md 一样（测试里对着模板查）。 */
export function composeBody(p: BodyParts): string {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const did =
    p.did.length === 1
      ? oneLine(p.did[0] ?? '')
      : [
          ...p.did.slice(0, MAX_COMMITS).map((s) => `- ${oneLine(s)}`),
          ...(p.did.length > MAX_COMMITS ? [`- ……另有 ${p.did.length - MAX_COMMITS} 条，见提交记录`] : []),
        ].join('\n');
  const need = [
    ...p.closes.map((n) => `Closes #${n}`),
    ...p.refs.map((n) => `Refs #${n}（分片、关不了它）`),
    ...(p.withNewIssue ? [NEW_ISSUE_LOCAL_LINE] : []),
    ...(p.founder ? [GATE_LINE] : []),
  ];
  const lines = [
    `**做了什么**：${p.did.length === 1 ? did : `\n${did}`}`,
    '',
    `**${ISSUE_COLUMN}**：`,
    ...need,
  ];
  if (p.founder) {
    lines.push('', founderQuoteLine(p.founder.quote, p.founder.at));
  }
  const writer = writerLine(p.writers ?? []);
  if (writer) lines.push('', writer);
  return `${lines.join('\n')}\n`;
}

/** 新单的正文：issue-new 要场景、原话、已知的模块、怎么算做完四节；这里能写的都从 PR 来，写不出的照它认的老实写法。 */
export function composeIssueBody(title: string, did: readonly string[], quote: string | undefined): string {
  const scene = did.map((s) => `- ${s.replace(/\s+/g, ' ').trim()}`).join('\n');
  return [
    '## 场景',
    '',
    NEW_ISSUE_LOCAL_LINE,
    '',
    `${title}（pnpm pr:open --new-issue 随 PR 一起开的单，分支上的提交：）`,
    scene,
    '',
    '## 原话',
    '',
    quote === undefined ? '无（AI 发现）' : `「${quote.replace(/\s+/g, ' ').trim()}」`,
    '',
    '## 已知的模块',
    '',
    '暂无',
    '',
    '## 怎么算做完',
    '',
    '- 随这张单开的 PR 合并，CI 全绿。',
    '',
  ].join('\n');
}

const issueNumber = (s: string): number | undefined => {
  const m = /^#?([1-9]\d*)$/.exec(s.trim());
  return m?.[1] ? Number(m[1]) : undefined;
};

export async function prOpenCli(argv: string[], deps: CliDeps): Promise<number> {
  const { out, err } = deps;
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        title: { type: 'string', short: 't' },
        'body-file': { type: 'string', short: 'F' },
        draft: { type: 'boolean', short: 'd' },
        base: { type: 'string', short: 'B' },
        'founder-approved': { type: 'boolean' },
        'no-automerge': { type: 'boolean' },
        'no-issue': { type: 'string' },
        closes: { type: 'string', multiple: true },
        refs: { type: 'string', multiple: true },
        'new-issue': { type: 'string' },
        kind: { type: 'string' },
        milestone: { type: 'string' },
        local: { type: 'boolean' },
        domain: { type: 'string' },
        nature: { type: 'string' },
        'founder-quote': { type: 'string' },
        at: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n${PR_OPEN_USAGE}`);
    return 1;
  }
  if (values.help) {
    out(PR_OPEN_USAGE);
    return 0;
  }
  const axis = requireAxis(
    typeof values.domain === 'string' ? values.domain : undefined,
    typeof values.nature === 'string' ? values.nature : undefined,
  );
  if ('error' in axis) {
    err(`${axis.error}\n${PR_OPEN_USAGE}`);
    return 1;
  }
  const axisArgs = ['--domain', axis.domain, '--nature', axis.nature];
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const closesRaw = strs(values.closes);
  const refsRaw = strs(values.refs);
  const newIssue = typeof values['new-issue'] === 'string' ? values['new-issue'].trim() : undefined;

  // 给了 --body-file：原有用法，一字不动交给 prOpen
  if (typeof values['body-file'] === 'string') {
    const generatingBody =
      closesRaw.length > 0 ||
      refsRaw.length > 0 ||
      values['new-issue'] !== undefined ||
      values.kind !== undefined ||
      values.milestone !== undefined ||
      values.local !== undefined;
    if (generatingBody) {
      err(
        '--closes / --refs / --new-issue / --kind / --milestone / --local 是让命令生成正文用的，' +
          '不能和 --body-file 一起用：要么去掉 --body-file 让它生成，要么把这些写进你自己的正文。什么也没做。',
      );
      return 1;
    }
    const q = typeof values['founder-quote'] === 'string' ? values['founder-quote'].trim() : undefined;
    const t = typeof values.at === 'string' ? values.at.trim() : undefined;
    if (values['founder-quote'] === undefined && values.at === undefined) return prOpen(argv, deps);
    if (!q || !t) {
      err(
        '--founder-quote "<原话>" 和 --at "<时间>" 要一起给、都不能是空的（正文里要写明创始人哪天哪时说的）：什么也没做。',
      );
      return 1;
    }
    // 自己写的正文：人闸一行和原话追加到末尾，再交给 prOpen（等价于 --founder-approved）
    const srcPath = isAbsolute(values['body-file'])
      ? values['body-file']
      : resolve(deps.cwd, values['body-file']);
    let src: string;
    try {
      src = readFileSync(srcPath, 'utf8');
    } catch (e) {
      err(`正文文件读不到（${srcPath}）：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const tmp = mkdtempSync(join(tmpdir(), 'pr-open-fq-'));
    try {
      const merged = join(tmp, 'body.md');
      writeFileSync(
        merged,
        `${src.replace(/\r\n?/g, '\n').trimEnd()}\n\n${GATE_LINE}\n\n${founderQuoteLine(q, t)}\n`,
      );
      return prOpen(
        [
          '--title',
          typeof values.title === 'string' ? values.title : '',
          '--body-file',
          merged,
          '--founder-approved',
          ...axisArgs,
          ...(values.draft === true ? ['--draft'] : []),
          ...(typeof values.base === 'string' ? ['--base', values.base] : []),
          ...(values['no-automerge'] === true ? ['--no-automerge'] : []),
          ...(typeof values['no-issue'] === 'string' ? ['--no-issue', values['no-issue']] : []),
        ],
        deps,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const title = typeof values.title === 'string' ? values.title.trim() : '';
  if (!title) {
    err(`要带 --title（不进交互）。\n${PR_OPEN_USAGE}`);
    return 1;
  }
  const closes = closesRaw.map(issueNumber);
  const refs = refsRaw.map(issueNumber);
  const bad = [
    ...closesRaw.filter((_, i) => closes[i] === undefined),
    ...refsRaw.filter((_, i) => refs[i] === undefined),
  ];
  if (bad.length > 0) {
    err(
      `--closes / --refs 要写单号（比如 --closes 12 或 --closes #12），「${bad.join('」「')}」认不出：什么也没做。`,
    );
    return 1;
  }
  const noIssue = typeof values['no-issue'] === 'string';
  const sources = [closes.length + refs.length > 0, newIssue !== undefined, noIssue].filter(Boolean).length;
  // 分支是 local/<单号>-、fleet/<单号>-：分支已经对应一张单，什么都不给就由 prOpen 自动补 Closes #单号；再开一张新单对不上
  let onIssueBranch: ReturnType<typeof branchIssue>;
  try {
    onIssueBranch = branchIssue(deps.git);
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}：没开 PR。`);
    return 2;
  }
  if (onIssueBranch && newIssue !== undefined) {
    err(
      `当前分支 ${onIssueBranch.branch} 已经对应单 #${onIssueBranch.issue}，不能再 --new-issue 开一张新单：去掉它（需求栏会自动补 Closes #${onIssueBranch.issue}）。什么也没做。`,
    );
    return 1;
  }
  if (sources === 0 && !onIssueBranch) {
    err(
      '没给 --body-file、也没说需求栏挂哪张单：每个 PR 都要挂单，里程碑页才看得出进展（#1052）。\n' +
        '  这个 PR 做完就关单 → --closes <号>；母单的分片、关不了它 → --refs <号>；这个 PR 就是一张新单 → --new-issue "<标题>" --kind … --milestone …；\n' +
        '  确实没有单 → --no-issue "<为什么不挂单>"。没开 PR，什么也没做。',
    );
    return 1;
  }
  if (sources > 1) {
    err(
      '--closes / --refs、--new-issue、--no-issue 只能用一种：需求栏要么挂已有的单、要么开新单、要么写没有单的理由。什么也没做。',
    );
    return 1;
  }
  if (
    newIssue === undefined &&
    (values.kind !== undefined || values.milestone !== undefined || values.local !== undefined)
  ) {
    err(
      '--kind / --milestone / --local 只配 --new-issue 用（给新开的单挂类别、里程碑；「本机做」随单自动贴）：什么也没做。',
    );
    return 1;
  }
  if (newIssue !== undefined) {
    const missing = [
      ...(!newIssue ? ['--new-issue 后面的标题'] : []),
      ...(typeof values.kind !== 'string' || !values.kind.trim() ? ['--kind（需求、缺陷、杂项）'] : []),
      ...(typeof values.milestone !== 'string' || !values.milestone.trim()
        ? ['--milestone（当前、版本全名、v<N> 或 未排期）']
        : []),
    ];
    if (missing.length > 0) {
      err(`--new-issue 要开单，缺 ${missing.join('、')}：单没开、PR 也没开。`);
      return 1;
    }
  }
  const quote = typeof values['founder-quote'] === 'string' ? values['founder-quote'].trim() : undefined;
  const at = typeof values.at === 'string' ? values.at.trim() : undefined;
  if ((values['founder-quote'] !== undefined || values.at !== undefined) && (!quote || !at)) {
    err(
      '--founder-quote "<原话>" 和 --at "<时间>" 要一起给、都不能是空的（正文里要写明创始人哪天哪时说的）：什么也没做。',
    );
    return 1;
  }

  // 「做了什么」：分支上的提交说明
  const base = typeof values.base === 'string' ? values.base : 'main';
  const log = deps.git(['log', '--no-merges', '--reverse', '--format=%s', `origin/${base}..HEAD`]);
  if (log.code !== 0) {
    err(
      `读不到这条分支相对 origin/${base} 的提交说明（git log 退出码 ${log.code}：${(log.stderr.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 200)}）：没开 PR。` +
        '先 git fetch，或者用 --body-file 自己写正文。',
    );
    return 2;
  }
  const did = log.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (did.length === 0) {
    err(`这条分支相对 origin/${base} 没有提交（先 commit、git push），没东西可写进「做了什么」：没开 PR。`);
    return 2;
  }

  // 写码模型：各提交的 Co-Authored-By: Claude … 尾注。读不到不拦开 PR（pnpm subagent:stats 还会认提交尾注），只提示一句
  let writers: string[] = [];
  const full = deps.git(['log', '--no-merges', '--format=%B%x1e', `origin/${base}..HEAD`]);
  if (full.code === 0) writers = writerModelsFromTrailers(full.stdout);
  else {
    err(
      `没读到提交尾注（git log 退出码 ${full.code}：${(full.stderr.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 120)}），正文里没写「写码模型」；` +
        'pnpm subagent:stats 还会认提交里的 Co-Authored-By 尾注。',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'pr-open-gen-'));
  try {
    let closeNumbers = closes.filter((n): n is number => n !== undefined);
    if (newIssue !== undefined) {
      try {
        loadPathLists(deps.root); // 路径清单读不到 prOpen 会拒开 PR：先判，免得单开了 PR 开不成
      } catch (e) {
        err(`判不了要不要挂自动合并，单和 PR 都没开：${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      const issueBody = join(dir, 'issue.md');
      writeFileSync(issueBody, composeIssueBody(newIssue, did, quote));
      try {
        const r = await issueNew(
          [
            '--kind',
            String(values.kind),
            '--milestone',
            String(values.milestone),
            '--title',
            newIssue,
            '--body-file',
            issueBody,
            ...axisArgs,
            // 一律贴「本机做」，和建单同一次；人再加 --local 也只传一次，不报错
            '--local',
          ],
          { gh: deps.issueGh, cwd: deps.cwd },
        );
        out(`开了单 #${r.number}（${r.milestone}）：${r.url}`);
        out(NEW_ISSUE_LOCAL_LINE);
        closeNumbers = [r.number];
      } catch (e) {
        err(
          `${e instanceof Error ? e.message : String(e)}\n没开 PR（单要是已经开了，用 --closes <号> 接着开）。`,
        );
        return 1;
      }
    }
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      composeBody({
        did,
        closes: closeNumbers,
        refs: refs.filter((n): n is number => n !== undefined),
        founder: quote && at ? { quote, at } : undefined,
        withNewIssue: newIssue !== undefined,
        writers,
      }),
    );
    return prOpen(
      [
        '--title',
        title,
        '--body-file',
        bodyFile,
        ...axisArgs,
        ...(values.draft === true ? ['--draft'] : []),
        ...(typeof values.base === 'string' ? ['--base', values.base] : []),
        ...(values['founder-approved'] === true || quote ? ['--founder-approved'] : []),
        ...(values['no-automerge'] === true ? ['--no-automerge'] : []),
        ...(noIssue ? ['--no-issue', String(values['no-issue'])] : []),
      ],
      deps,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
