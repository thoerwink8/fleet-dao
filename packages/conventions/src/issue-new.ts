// 开单脚本：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--specs 短名] [--mother] [--parent 母单号] [--local]
// 缺类别、里程碑，或正文里没有写了字的「## 怎么算做完」就不开（design 第三节第 35 条：以后要做的事得是一张
// 带怎么算做完和里程碑的 issue）。经 gh 开单时一次带上标签和里程碑（gh 先把名字换成编号再建单，对不上就一张也不建）。
// 里程碑＝版本（创始人 2026-09-26 拍，替代 P 阶段）：--milestone 认全名、v<N> 简写、旧的 P<N> 简写，或「未排期」——
// 未排期时不挂里程碑（建单不带 --milestone），结果里 milestone 记「未排期」。--mother 给这张单多贴「母单」标签
// （一组能一起验收的子单，用 GitHub 自带子议题挂在它下面）。--parent 开的是子单：先不带里程碑建单、挂到母单下面，
// 再挂里程碑——接活只派挂在当前版本上的独立单（design 第九节「在哪能做与接活开关」，母单、子单不派），带着当前版本先建、
// 事后再挂到母单下面的，中间那一下是一张挂在当前版本上的独立单，开关开着就被派走了。--local 给这张单多贴「本机做」标签
// （帅位留给本机做的，接活不自动派）：和类别标签在同一次建单里贴上，不事后补——开单那个事件一到，没贴的已经被派走了。
// 带 --specs 时，完整正文写进 specs/<号>-<短名>/需求.md，issue 上只留第一个小标题之前那段（原话、AI 理解）
// 和需求文档的路径（第七节：完整需求只在仓里存一份）。gh 出错原样报出来，退出码非 0。
// 帅位座位整张删掉（#531）：开单时替帅位认领那一步（claimLocal）一并删——本机不再在库里认领。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doneSection } from './debt.ts';
import {
  isKindLabel,
  KIND_LABELS,
  LOCAL_LABEL,
  MOTHER_LABEL,
  milestonePhase,
  milestoneVersion,
} from './labels.ts';
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
  /** 实际挂上的里程碑全名；未排期时是「未排期」（建单没带 --milestone）。 */
  milestone: string;
  /** 建了需求文档时，它的仓内路径。 */
  specsFile: string | undefined;
  /** 开的是子单时，挂在哪张母单下面（--parent）。 */
  parent?: number | undefined;
  /** 贴了「本机做」（--local）时是 true。 */
  local?: true | undefined;
}

export const USAGE =
  '用法：pnpm issue:new --kind 需求|缺陷|杂项 --milestone v1 --title "一句话" --body-file 正文.md [--specs 短名] [--mother] [--parent 母单号] [--local]' +
  '（--milestone 认全名、v<N>、旧的 P<N>，或「未排期」；正文要有写了字的「## 怎么算做完」；' +
  '带 --specs 时，第一个小标题之前写原话和 AI 理解；--mother 多贴「母单」标签；' +
  '--parent 开子单：先挂到那张母单下面再挂里程碑；--local 多贴「本机做」：帅位留给本机做，接活不自动派）';

/** --milestone 写这个值：这张单没有版本（未排期）。不去查 GitHub 的里程碑列表，建单也不带 --milestone。 */
const UNSCHEDULED = '未排期';

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

  const milestone = o.milestone === UNSCHEDULED ? UNSCHEDULED : await resolveMilestone(deps.gh, o.milestone);
  if (o.parent !== undefined) await checkParent(deps.gh, o.parent);
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
    ...(o.mother ? ['--label', MOTHER_LABEL] : []),
    // 「本机做」和建单同一次贴上：开单事件一到接活就判，事后补贴的已经被派走了
    ...(o.local ? ['--label', LOCAL_LABEL] : []),
    // 子单先不带里程碑：挂到母单下面以后再挂（attachToParent）
    ...(milestone === UNSCHEDULED || o.parent !== undefined ? [] : ['--milestone', milestone]),
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
  const { parent } = o;
  const local = o.local || undefined;
  if (parent !== undefined) await attachToParent(deps.gh, { number, url, parent, milestone, specs: o.specs });
  if (o.specs === undefined) return { number, url, milestone, specsFile: undefined, parent, local };
  try {
    return {
      number,
      url,
      milestone,
      specsFile: writeSpecs(deps.root, number, o.specs, specsDoc(o.title, number, milestone, body)),
      parent,
      local,
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
  /** 多贴「母单」标签：这张单下面会挂子单（GitHub 自带子议题）。 */
  mother: boolean;
  /** 开的是子单：挂到这张母单下面。 */
  parent: number | undefined;
  /** 多贴「本机做」标签：帅位留给本机做，接活不自动派（#299 止血）。 */
  local: boolean;
}

function parse(argv: readonly string[]): Options {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        kind: { type: 'string' },
        milestone: { type: 'string' },
        title: { type: 'string' },
        'body-file': { type: 'string' },
        specs: { type: 'string' },
        mother: { type: 'boolean' },
        parent: { type: 'string' },
        local: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new Error(`参数不对（${message(e)}）。${USAGE}`);
  }
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v.trim() : undefined;
  const kind = str(values.kind);
  if (!kind) throw new Error(`缺 --kind：从 ${KIND_LABELS.join('、')} 里挑一个。${USAGE}`);
  if (!isKindLabel(kind)) throw new Error(`--kind 只能是 ${KIND_LABELS.join('、')}，没有「${kind}」。`);
  const milestone = str(values.milestone);
  if (!milestone) throw new Error(`缺 --milestone：写这块活属于的阶段，比如 --milestone P1。${USAGE}`);
  const title = str(values.title);
  if (!title) throw new Error(`缺 --title：一句话写要什么。${USAGE}`);
  const bodyFile = str(values['body-file']);
  if (!bodyFile) throw new Error(`缺 --body-file：正文写进一个文件再指过来。${USAGE}`);
  const specs = str(values.specs);
  if (values.specs !== undefined && !/^(?![.-])[^/\\\s<>:"|?*]+$/.test(specs ?? '')) {
    throw new Error(
      `--specs 的短名「${values.specs}」不行：不能空，不能带 / \\ 空格和 < > : " | ? *，也不能以 . 或 - 开头。`,
    );
  }
  const mother = values.mother === true;
  let parent: number | undefined;
  if (values.parent !== undefined) {
    const m = /^#?([1-9]\d*)$/.exec(str(values.parent) ?? '');
    if (!m?.[1])
      throw new Error(`--parent 写母单的号（比如 --parent 192），「${values.parent}」认不出。${USAGE}`);
    parent = Number(m[1]);
  }
  return { kind, milestone, title, bodyFile, specs, mother, parent, local: values.local === true };
}

/** 挂子单之前先看母单：开着的 issue、贴了「母单」标签（design 第七节：有子单的必须带）。不对就不开单。 */
async function checkParent(gh: Gh, parent: number): Promise<void> {
  const r = await gh(['api', `repos/{owner}/{repo}/issues/${parent}`]);
  if (r.code !== 0) throw new Error(`gh 读母单 #${parent} 失败（退出码 ${r.code}），单没开：${detail(r)}`);
  let issue: { state?: unknown; pull_request?: unknown; labels?: unknown };
  try {
    const data: unknown = JSON.parse(r.stdout);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('不是一张 issue');
    issue = data;
  } catch (e) {
    throw new Error(`gh 读回来的 #${parent} 认不出（${message(e)}），单没开。`);
  }
  if (issue.pull_request !== undefined) throw new Error(`#${parent} 是 PR，不是母单，单没开。`);
  if (issue.state !== 'open') throw new Error(`母单 #${parent} 已经关了，单没开：子单挂到还开着的母单下面。`);
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l: unknown) =>
        typeof l === 'object' && l !== null ? (l as { name?: unknown }).name : l,
      )
    : undefined;
  if (!labels?.every((name) => typeof name === 'string')) {
    throw new Error(`gh 读回来的 #${parent} 的标签认不出，单没开。`);
  }
  if (!labels.includes(MOTHER_LABEL)) {
    throw new Error(
      `#${parent} 没贴「${MOTHER_LABEL}」标签，单没开：有子单的必须是母单（design 第七节「标签与里程碑」），` +
        `先 gh issue edit ${parent} --add-label ${MOTHER_LABEL}，再写清它怎么算做完。`,
    );
  }
}

/**
 * 子单建好以后：挂到母单下面（GitHub 子议题），再挂里程碑。顺序不能反（见文件头）：没挂到母单下面之前它没有里程碑，
 * 自动派把它当未排期、不派。哪一步没成都照实报、说清停在哪一步和怎么手动补完，不重开单（会开出重复的）。
 */
async function attachToParent(
  gh: Gh,
  a: { number: number; url: string; parent: number; milestone: string; specs: string | undefined },
): Promise<void> {
  const thenMilestone =
    a.milestone === UNSCHEDULED ? '' : `，再 gh issue edit ${a.number} --milestone "${a.milestone}"`;
  const noDoc =
    a.specs === undefined ? '' : `；需求文档还没建，挂好以后补上 specs/${a.number}-${a.specs}/需求.md`;
  const unlinked = (why: string) =>
    new Error(
      `单开了（#${a.number} ${a.url}），可没挂到 #${a.parent} 下面：${why}。它现在没挂里程碑（未排期，不会被自动派）：` +
        `在 #${a.parent} 页面上把它加成子议题${thenMilestone}${noDoc}。`,
    );
  const read = await gh(['api', `repos/{owner}/{repo}/issues/${a.number}`]);
  if (read.code !== 0) throw unlinked(`gh 读它的 id 失败（退出码 ${read.code}）：${detail(read)}`);
  let id: unknown;
  try {
    id = (JSON.parse(read.stdout) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw unlinked('gh 读回来的这张单认不出 id');
  }
  const link = await gh([
    'api',
    '-X',
    'POST',
    `repos/{owner}/{repo}/issues/${a.parent}/sub_issues`,
    '-F',
    `sub_issue_id=${id}`,
  ]);
  if (link.code !== 0) throw unlinked(`gh 挂子议题报错（退出码 ${link.code}）：${detail(link)}`);
  if (a.milestone === UNSCHEDULED) return;
  const edit = await gh(['issue', 'edit', String(a.number), '--milestone', a.milestone]);
  if (edit.code !== 0) {
    throw new Error(
      `单开了、挂到 #${a.parent} 下面了（#${a.number} ${a.url}），可里程碑「${a.milestone}」没挂上（退出码 ${edit.code}）：` +
        `${detail(edit)}。手动补：gh issue edit ${a.number} --milestone "${a.milestone}"${noDoc}。`,
    );
  }
}

/**
 * 「v1」「P1」（旧）→ 开放里程碑里那个简写开头的那一个的全名；给的就是全名也行。
 * 「未排期」不经过这里：issueNew 里直接处理，不查里程碑列表。
 */
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
  const version = /^v\d+$/.test(want) ? Number(want.slice(1)) : undefined;
  const shorthand =
    phase !== undefined
      ? titles.filter((t) => milestonePhase(t) === phase)
      : version !== undefined
        ? titles.filter((t) => milestoneVersion(t) === version)
        : undefined;
  const matches = exact.length || shorthand === undefined ? exact : shorthand;
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
 * 正文里没有「## 现状」就补一节「未开工。」。里程碑是 P 阶段（旧写法）时「对应计划」的引号故意空着：不填就提交，
 * 文档指针检查会红；里程碑是版本或未排期时直接写版本全名或「未排期」，不用 plan.md 那一套核。
 */
export function specsDoc(title: string, number: number, milestone: string, body: string): string {
  const phase = milestonePhase(milestone);
  const plan = phase === undefined ? milestone : `plan.md P${phase}「」`;
  const text = body.replace(/\r\n?/g, '\n').trim();
  const hasStatus = parseMd('body.md', text).headings.some((h) => h.title.trim() === '现状');
  return [
    `# ${title}（#${number}）`,
    '',
    `对应计划：${plan}`,
    '设计依据：',
    '',
    text,
    ...(hasStatus ? [] : ['', '## 现状', '', '未开工。']),
    '',
  ].join('\n');
}

/** 建了需求文档后 bin 打的提示：P 阶段（旧写法）还要去 plan.md 那一条的引号里填字，版本、未排期不用。 */
export function specsHint(milestone: string): string {
  return milestonePhase(milestone) === undefined
    ? '「设计依据」写上 design 哪一节再提交'
    : '「对应计划」的引号里填上 plan.md 那一条、「设计依据」写上 design 哪一节再提交';
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
