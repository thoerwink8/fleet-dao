// 开单脚本：pnpm issue:new --kind 需求 --milestone P1 --title "…" --body-file 正文.md [--specs 短名]
// 缺类别、里程碑，或正文里没有写了字的「## 怎么算做完」就不开（design 第三节第 35 条：以后要做的事得是一张
// 带怎么算做完和里程碑的 issue）。经 gh 开单时一次带上标签和里程碑（gh 先把名字换成编号再建单，对不上就一张也不建）。
// 带 --specs 时，完整正文写进 specs/<号>-<短名>/需求.md，issue 上只留第一个小标题之前那段（原话、AI 理解）
// 和需求文档的路径（第七节：完整需求只在仓里存一份）。gh 出错原样报出来，退出码非 0。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doneSection } from './debt.ts';
import { isKindLabel, KIND_LABELS, milestonePhase } from './labels.ts';
import { parseMd } from './markdown.ts';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Gh = (args: string[]) => Promise<GhResult>;

export interface IssueNewDeps {
  gh: Gh;
  /** 仓根：specs/ 在它下面。 */
  root: string;
  /** --body-file 相对哪个目录（pnpm 跑脚本时是 INIT_CWD，也就是敲命令的地方）。 */
  cwd: string;
}

export interface IssueNewResult {
  number: number;
  url: string;
  /** 实际挂上的里程碑全名。 */
  milestone: string;
  /** 建了需求文档时，它的仓内路径。 */
  specsFile: string | undefined;
}

export const USAGE =
  '用法：pnpm issue:new --kind 需求|缺陷|杂项 --milestone P1 --title "一句话" --body-file 正文.md [--specs 短名]' +
  '（正文要有写了字的「## 怎么算做完」；带 --specs 时，第一个小标题之前写原话和 AI 理解）';

export async function issueNew(argv: readonly string[], deps: IssueNewDeps): Promise<IssueNewResult> {
  const o = parse(argv);
  const bodyPath = isAbsolute(o.bodyFile) ? o.bodyFile : resolve(deps.cwd, o.bodyFile);
  let body: string;
  try {
    body = readFileSync(bodyPath, 'utf8').replace(/\r\n?/g, '\n');
  } catch (e) {
    throw new Error(`--body-file 读不到：${bodyPath}（${message(e)}），单没开。`);
  }
  const done = doneSection(parseMd('body.md', body));
  if (done !== 'ok') {
    throw new Error(
      `正文里${done === 'missing' ? '没有「## 怎么算做完」一节' : '「怎么算做完」一节是空的'}，单没开：以后要做的事得写清怎么算做完（测试名、脚本、真机上看到什么）。`,
    );
  }
  const summary = o.specs === undefined ? undefined : issueSummary(body);
  if (summary === '') {
    throw new Error(
      '--specs 时正文开头（第一个小标题之前）要写原话和 AI 理解：issue 上只留这一段和需求文档的路径，单没开。',
    );
  }
  if (o.specs !== undefined && !isDir(join(deps.root, 'specs'))) {
    throw new Error(`仓根 ${deps.root} 下没有 specs/ 目录，--specs 建不了需求文档，单没开。`);
  }

  const milestone = await resolveMilestone(deps.gh, o.milestone);
  const created = await deps.gh([
    'issue',
    'create',
    '--title',
    o.title,
    ...(summary === undefined
      ? ['--body-file', bodyPath]
      : ['--body', `${summary}\n\n文档：\`specs/<本单号>-${o.specs}/需求.md\`（完整需求和怎么算做完）\n`]),
    '--label',
    o.kind,
    '--milestone',
    milestone,
  ]);
  // 开单这一步报错，单不一定没建：超时、断连时 GitHub 那边可能已经建好了，照着重跑会开出重复的单
  if (created.code !== 0) {
    throw new Error(
      `gh 开单报错（退出码 ${created.code}）：${detail(created)}。单多半没开，可超时、断连时也可能已经建了：先去 GitHub 按标题「${o.title}」搜一下，没有再重开。`,
    );
  }
  const url = created.stdout.trim().split('\n').pop()?.trim() ?? '';
  const n = /\/issues\/(\d+)$/.exec(url)?.[1];
  if (!n) {
    throw new Error(
      `gh 退出码是 0，可输出里认不出单号：${detail(created)}。单多半已经开了，去 GitHub 按标题「${o.title}」找一下${o.specs === undefined ? '' : '；需求文档没建'}。`,
    );
  }
  const number = Number(n);
  if (o.specs === undefined) return { number, url, milestone, specsFile: undefined };
  try {
    return {
      number,
      url,
      milestone,
      specsFile: writeSpecs(deps.root, number, o.specs, specsDoc(o.title, number, milestone, body)),
    };
  } catch (e) {
    throw new Error(`单开了（#${number} ${url}），可需求文档没建成：${message(e)}。`);
  }
}

interface Options {
  kind: string;
  milestone: string;
  title: string;
  bodyFile: string;
  specs: string | undefined;
}

function parse(argv: readonly string[]): Options {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        kind: { type: 'string' },
        milestone: { type: 'string' },
        title: { type: 'string' },
        'body-file': { type: 'string' },
        specs: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new Error(`参数不对（${message(e)}）。${USAGE}`);
  }
  const kind = values.kind?.trim();
  if (!kind) throw new Error(`缺 --kind：从 ${KIND_LABELS.join('、')} 里挑一个。${USAGE}`);
  if (!isKindLabel(kind)) throw new Error(`--kind 只能是 ${KIND_LABELS.join('、')}，没有「${kind}」。`);
  const milestone = values.milestone?.trim();
  if (!milestone) throw new Error(`缺 --milestone：写这块活属于的阶段，比如 --milestone P1。${USAGE}`);
  const title = values.title?.trim();
  if (!title) throw new Error(`缺 --title：一句话写要什么。${USAGE}`);
  const bodyFile = values['body-file']?.trim();
  if (!bodyFile) throw new Error(`缺 --body-file：正文写进一个文件再指过来。${USAGE}`);
  const specs = values.specs?.trim();
  if (values.specs !== undefined && !/^(?![.-])[^/\\\s<>:"|?*]+$/.test(specs ?? '')) {
    throw new Error(
      `--specs 的短名「${values.specs}」不行：不能空，不能带 / \\ 空格和 < > : " | ? *，也不能以 . 或 - 开头。`,
    );
  }
  return { kind, milestone, title, bodyFile, specs };
}

/** 「P1」→ 开放里程碑里 P1 开头的那一个的全名；给的就是全名也行。 */
async function resolveMilestone(gh: Gh, want: string): Promise<string> {
  const r = await gh(['api', 'repos/{owner}/{repo}/milestones?state=open&per_page=100']);
  if (r.code !== 0) throw new Error(`gh 读里程碑失败（退出码 ${r.code}），单没开：${detail(r)}`);
  let titles: string[];
  try {
    const data: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(data)) throw new Error('不是列表');
    titles = data.map((m: unknown) => {
      const title = typeof m === 'object' && m !== null ? (m as { title?: unknown }).title : undefined;
      if (typeof title !== 'string') throw new Error('有一项没有 title');
      return title;
    });
  } catch (e) {
    throw new Error(`gh 读回来的里程碑认不出（${message(e)}），单没开。`);
  }
  const exact = titles.filter((t) => t === want);
  const phase = /^P\d+$/.test(want) ? Number(want.slice(1)) : undefined;
  const matches =
    exact.length || phase === undefined ? exact : titles.filter((t) => milestonePhase(t) === phase);
  const [only, ...more] = matches;
  if (only !== undefined && more.length === 0) return only;
  if (only === undefined) {
    throw new Error(
      `没有叫「${want}」的开放里程碑，单没开：开放的有 ${titles.join('、') || '（一个也没有）'}。`,
    );
  }
  throw new Error(`「${want}」对上了好几个里程碑（${matches.join('、')}），单没开：写全名。`);
}

/** 正文里第一个小标题之前的那段（原话、AI 理解），去掉首尾空白。 */
export function issueSummary(body: string): string {
  const first = parseMd('body.md', body).headings[0];
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, first ? first.line - 1 : undefined)
    .join('\n')
    .trim();
}

/**
 * 需求文档，照 specs/ 下已有的几份的样子：标题、「对应计划」「设计依据」两行，接着是整份正文；
 * 正文里没有「## 现状」就补一节「未开工。」。「对应计划」的引号故意空着：不填就提交，文档指针检查会红。
 */
export function specsDoc(title: string, number: number, milestone: string, body: string): string {
  const phase = milestonePhase(milestone);
  const text = body.replace(/\r\n?/g, '\n').trim();
  const hasStatus = parseMd('body.md', text).headings.some((h) => h.title.trim() === '现状');
  return [
    `# ${title}（#${number}）`,
    '',
    `对应计划：${phase === undefined ? '' : `plan.md P${phase}「」`}`,
    '设计依据：',
    '',
    text,
    ...(hasStatus ? [] : ['', '## 现状', '', '未开工。']),
    '',
  ].join('\n');
}

function writeSpecs(root: string, number: number, short: string, text: string): string {
  const name = `${number}-${short}`;
  const dir = join(root, 'specs', name);
  if (existsSync(dir)) throw new Error(`specs/${name}/ 已经在了，没覆盖`);
  mkdirSync(dir);
  writeFileSync(join(dir, '需求.md'), text, { flag: 'wx' });
  return `specs/${name}/需求.md`;
}

/** 真的 gh：不经 shell，参数原样传；gh 起不来（没装、不在 PATH）也回一个非 0 的结果，不抛。 */
export function ghRunner(root: string, command = 'gh'): Gh {
  return (args) =>
    new Promise((done) => {
      execFile(
        command,
        args,
        { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return done({ code: 0, stdout, stderr });
          if (err.code === 'ENOENT') {
            return done({ code: 127, stdout, stderr: `找不到 ${command} 命令（没装，或者不在 PATH 里）` });
          }
          done({ code: typeof err.code === 'number' ? err.code : 1, stdout, stderr: stderr || err.message });
        },
      );
    });
}

function detail(r: GhResult): string {
  return (r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ');
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
