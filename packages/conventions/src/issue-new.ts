// 开单脚本：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--mother] [--parent 母单号] [--local] [--order-after 单号]
// [--allow-pr-body-acceptance "<理由>"]
// 缺类别、里程碑，或正文里没有写了字的「## 怎么算做完」就不开（design 第三节第 35 条：以后要做的事得是一张
// 带怎么算做完和里程碑的 issue）。经 gh 开单时一次带上标签和里程碑（gh 先把名字换成编号再建单，对不上就一张也不建）。
// 里程碑＝版本（创始人 2026-09-26 拍，替代 P 阶段）：--milestone 认全名、v<N> 简写、旧的 P<N> 简写，或「未排期」——
// 未排期时不挂里程碑（建单不带 --milestone），结果里 milestone 记「未排期」。--mother 给这张单多贴「母单」标签
// （一组能一起验收的子单，用 GitHub 自带子议题挂在它下面）。--parent 开的是子单：先不带里程碑建单、挂到母单下面，
// 再挂里程碑——接活派的是独立单（design 第九节「在哪能做与接活开关」，母单、子单不派），带着当前版本先建、
// 事后再挂到母单下面的，中间那一下是一张独立单，开关开着就可能被派走。--local 给这张单多贴「本机做」标签
// （帅位留给本机做的，接活不自动派）：和类别标签在同一次建单里贴上，不事后补——开单那个事件一到，没贴的已经被派走了。
// 「怎么算做完」里写「PR 正文 / PR 描述 / PR body」就拒开（#1792 / #1764）：冷验收只看 diff 和单子，看不到 PR 正文，
// 写进去引擎永远验不过、白跑两轮。要硬开带 --allow-pr-body-acceptance "<理由>"，理由追加进那一节末尾。
// 单子正文就是需求的唯一的家（#654）：整份正文原样进 issue，不再另写一份 specs/<号>-<短名>/需求.md 镜像（两份各改各的，
// 对账、检查的活全是它引出来的）。正文放不下 GitHub 的上限的：需求一页以内，长的方案另放 specs/<号>-<短名>/方案.md，单上只留链接。
// 挂版本的母单、单独的单开好就排进那个版本里程碑说明的先后（<!-- fleet:order --> 之间，#807）：每天的 GitHub 对账查「挂在版本里
// 却没排进先后」，原来靠人记得事后补，2026-10-04 一天红了两回。默认排末尾，--order-after <号> 插在那张后面；子单在母单页面上排、
// 未排期和旧的 P 阶段没有先后，都不排。认法和对账、pnpm plan 是同一份（plan-view.ts 的 addToOrder / parseOrder）。排不进去
// （标记缺了、认不出、说明读不到、改不成）单照开、不回滚，报「开了 #N，但没排进先后」和怎么手工补，退出码非 0。
// gh 出错原样报出来，退出码非 0。
// 帅位座位整张删掉（#531）：开单时替帅位认领那一步（claimLocal）一并删——本机不再在库里认领。
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doneSection } from './debt.ts';
import { type MilestoneDetail, toMilestoneDetail } from './github-api.ts';
import type { SimilarReport } from './issue-similar.ts';
import {
  isKindLabel,
  KIND_LABELS,
  LOCAL_LABEL,
  MOTHER_LABEL,
  milestonePhase,
  milestoneVersion,
} from './labels.ts';
import { type MdDoc, norm, parseMd, sectionRange } from './markdown.ts';
import { addToOrder, type OrderParse, parseOrder } from './plan-view.ts';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Gh = (args: string[]) => Promise<GhResult>;

export interface IssueNewDeps {
  gh: Gh;
  /** --body-file 相对哪个目录（pnpm 跑脚本时是 INIT_CWD，也就是敲命令的地方）。 */
  cwd: string;
  /**
   * 开单前查「有没有可能重复的单」（issue-similar.ts 的 similarIssues，#995 拍 3）：入口传，测试不传就不查。
   * 只提示：它不抛、不拦开单，读不到就在报告里写「没查成」。
   */
  similar?: ((q: { title: string; body: string }) => Promise<SimilarReport>) | undefined;
}

export interface IssueNewResult {
  number: number;
  url: string;
  /** 实际挂上的里程碑全名；未排期时是「未排期」（建单没带 --milestone）。 */
  milestone: string;
  /** 开的是子单时，挂在哪张母单下面（--parent）。 */
  parent?: number | undefined;
  /** 贴了「本机做」（--local）时是 true。 */
  local?: true | undefined;
  /** 排进了版本的先后（挂版本的母单、单独的单）：排在第几位（从 1 数）、先后里一共几张。 */
  order?: { position: number; count: number } | undefined;
  /** 开单前查的可能重复的单（deps.similar 给了才有）；只提示，开单不受它影响。 */
  similar?: SimilarReport | undefined;
}

export const USAGE =
  '用法：pnpm issue:new --kind 需求|缺陷|杂项 --milestone v1 --title "一句话" --body-file 正文.md [--mother] [--parent 母单号] [--local] [--order-after 单号]' +
  ' [--allow-pr-body-acceptance "<理由>"]' +
  '（--milestone 认全名、v<N>、旧的 P<N>，或「未排期」；正文要带写了字的「## 场景」「## 原话」「## 已知的模块」「## 怎么算做完」四节，' +
  '涉及面一律不写（那是算出来的、不是知道的）；--mother 多贴「母单」标签；' +
  '--parent 开子单：先挂到那张母单下面再挂里程碑；--local 多贴「本机做」：帅位留给本机做，接活不自动派；' +
  '挂版本的母单、单独的单开完自动排进版本里程碑说明的先后末尾，--order-after 插在那张后面；子单、未排期不排；' +
  '「怎么算做完」里写「PR 正文 / PR 描述 / PR body」默认拒开（冷验收看不到），要硬开带 --allow-pr-body-acceptance）';

/** --milestone 写这个值：这张单没有版本（未排期）。不去查 GitHub 的里程碑列表，建单也不带 --milestone。 */
const UNSCHEDULED = '未排期';

/** GitHub 一张单的正文最多 65536 字；留一点余量，超了在这里就拒开，不让 gh 回一句看不懂的错。 */
const BODY_LIMIT = 65_000;

/**
 * 一张单必带三栏——场景、原话、已知的模块（两张创始人 2026-10-02 拍「建单那个会话把只有它知道的事写进单子」，specs/553-对题
 * 和 specs/509-需求梳理/流程重做方案 第三节）。要什么、怎么算做完照旧。各栏是小标题（## 场景 / ## 原话 / ## 已知的模块），
 * 后续段落就算它的字；缺栏、空栏拒开。涉及面一律不写：那是算出来的、不是知道的，建单的 AI 没读过代码，它写的只是猜；
 * 单子里见「涉及面」一节就拒开，并点明「那不是算出来的」。
 *
 * 原话栏允许写「（AI 发现）」：单子是 AI 发现的问题／缺陷／杂项时，没有创始人原话可抄，写明来源就好。光是
 * 「## 原话」四个字不算写了。
 */
export interface MissingSection {
  /** 缺哪一栏（拒开时报的栏目名）。 */
  label: string;
  why: string;
}

const REQUIRED_SECTIONS = ['场景', '原话', '已知的模块'] as const;
type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

const EMPTY_WHY: Record<RequiredSection, string> = {
  场景: '「## 场景」一节是空的：写清这是干什么的、为什么现在做（一段话就好）。',
  原话: '「## 原话」一节是空的：抄创始人当时的原话（逐字）；AI 自己发现的问题就写「无（AI 发现）」。',
  已知的模块:
    '「## 已知的模块」一节是空的：建单时确实知道的模块（创始人提到的、建单前聊出来的）；不知道就写「暂无」。',
};

const ABSENT_WHY: Record<RequiredSection, string> = {
  场景: '正文里没有「## 场景」一节：单子必须写清这是干什么的、为什么现在做（创始人 2026-10-02，specs/553-对题）。',
  原话: '正文里没有「## 原话」一节：单子必须抄创始人当时的原话（逐字）；AI 自己发现的问题写「无（AI 发现）」（创始人 2026-10-02，specs/553-对题）。',
  已知的模块:
    '正文里没有「## 已知的模块」一节：单子必须写建单时确实知道的模块；不知道写「暂无」（创始人 2026-10-02，specs/553-对题）。',
};

const SURFACE_WHY =
  '涉及面一律不写：那是算出来的、不是知道的（创始人 2026-10-02「那（涉及面）是算出来的、不是知道的」，specs/553-对题）。建单的 AI 动手前没读过代码，写它只会是猜；把它整节删掉。';

/**
 * 正文里认出的小节里有没有「场景 / 原话 / 已知的模块」三栏、有没有「涉及面」不该出现的栏；缺或者写错就给一句为什么。
 * 一节下面只有标题、没有字也算缺。一级到六级小标题都算。开单拒第一条（checkRequiredSections）；派活要一次说清缺哪几处，
 * 所以这里全报：同一栏只报一次（空栏同时也算「没写字」，保留先出现的那条「是空的」）。
 */
export function requiredSectionProblems(doc: MdDoc): MissingSection[] {
  const sections = new Map<string, string>();
  for (const h of doc.headings) {
    const key = norm(h.title);
    if (!key) continue;
    const { start, end } = sectionRange(doc, h);
    const text = doc.lines
      .slice(start + 1, end)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (!sections.has(key)) sections.set(key, text);
  }
  const has = (name: string): boolean => {
    const text = sections.get(name);
    return text !== undefined && text.length > 0;
  };
  const dummy = (name: string): boolean => sections.has(name) && (sections.get(name) ?? '').length === 0;
  const found: MissingSection[] = [];
  if (sections.has('涉及面')) found.push({ label: '涉及面', why: SURFACE_WHY });
  for (const name of REQUIRED_SECTIONS) if (dummy(name)) found.push({ label: name, why: EMPTY_WHY[name] });
  for (const name of REQUIRED_SECTIONS) if (!has(name)) found.push({ label: name, why: ABSENT_WHY[name] });
  return found.filter((p, i) => found.findIndex((q) => q.label === p.label) === i);
}

/** 开单用：第一条问题（顺序：涉及面、空栏、缺栏）；没有就是齐了。 */
export function checkRequiredSections(doc: MdDoc): MissingSection | undefined {
  return requiredSectionProblems(doc)[0];
}

/**
 * 一节的原文（不含标题行）：保留换行和列表，去掉首尾空行。同名小标题取第一个；没有这一节回 undefined。
 * 比较的写法和 requiredSectionProblems 认栏是同一个（norm），所以「它认得出的栏」这里一定取得到。
 */
export function sectionText(doc: MdDoc, name: string): string | undefined {
  const h = doc.headings.find((x) => norm(x.title) === name);
  if (!h) return undefined;
  const { start, end } = sectionRange(doc, h);
  return doc.lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/** 「怎么算做完」里提到 PR 正文的写法（冷验收看不到，#1792 / #1764）。不分大小写。 */
const PR_BODY_IN_DONE = /PR\s*(?:正文|描述|body)/i;

/**
 * 「怎么算做完」一节正文里，哪些条目提到了 PR 正文／PR 描述／PR body。
 * 入参是这一节的原文（不含标题）；按列表项（`-` / `*` / `1.`）或空行分段，返回命中的条目原文（trim 后）。
 * 别的节（比如「场景」里复述往事）不进这里——调用方只传这一节。
 */
export function prBodyAcceptanceItems(doneSectionBody: string): string[] {
  return splitAcceptanceItems(doneSectionBody).filter((item) => PR_BODY_IN_DONE.test(item));
}

/** 验收条：列表项各成一条；非列表的连续非空行合成一段；空行切开。 */
function splitAcceptanceItems(text: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const t = current.join('\n').trim();
    if (t) items.push(t);
    current = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:[-*]|\d+[.)])\s+\S/.test(raw)) {
      flush();
      current.push(raw.trim());
    } else if (raw.trim() === '') {
      flush();
    } else {
      current.push(raw.trim());
    }
  }
  flush();
  return items;
}

/** 把一行说明追加进「怎么算做完」节末（下一节标题之前）；没有这一节就附在文末。 */
function appendNoteToDoneSection(body: string, note: string): string {
  const doc = parseMd('body.md', body);
  const h = doc.headings.find((x) => norm(x.title).startsWith('怎么算做完'));
  if (!h) return `${body.replace(/\s*$/, '')}\n\n${note}\n`;
  const { end } = sectionRange(doc, h);
  const lines = [...doc.lines];
  const insert: string[] = [];
  if (end > 0 && (lines[end - 1] ?? '').trim() !== '') insert.push('');
  insert.push(note);
  if (end < lines.length && (lines[end] ?? '').trim() !== '') insert.push('');
  lines.splice(end, 0, ...insert);
  return lines.join('\n');
}

export async function issueNew(argv: readonly string[], deps: IssueNewDeps): Promise<IssueNewResult> {
  const o = parse(argv);
  const bodyPath = isAbsolute(o.bodyFile) ? o.bodyFile : resolve(deps.cwd, o.bodyFile);
  let body: string;
  try {
    body = readFileSync(bodyPath, 'utf8').replace(/\r\n?/g, '\n');
  } catch (e) {
    throw new Error(`--body-file 读不到：${bodyPath}（${message(e)}），单没开。`);
  }
  const doc = parseMd('body.md', body);
  const missing = checkRequiredSections(doc);
  if (missing) throw new Error(`${missing.why}，单没开。`);
  const done = doneSection(doc);
  if (done !== 'ok') {
    throw new Error(
      `正文里${done === 'missing' ? '没有「## 怎么算做完」一节' : '「怎么算做完」一节是空的'}，单没开：以后要做的事得写清怎么算做完（测试名、脚本、真机上看到什么）。`,
    );
  }
  const doneText = sectionText(doc, '怎么算做完') ?? '';
  const prBodyHits = prBodyAcceptanceItems(doneText);
  let createBodyPath = bodyPath;
  if (prBodyHits.length > 0) {
    if (o.allowPrBodyAcceptance === undefined) {
      throw new Error(
        `「怎么算做完」里有条目提到 PR 正文（冷验收只看 diff 和单子，看不到 PR 正文，按没做到算）：\n` +
          `${prBodyHits.join('\n')}\n` +
          `改成 diff 里看得见的写法（注释、文档或测试名），或带 --allow-pr-body-acceptance "<理由>"。单没开。`,
      );
    }
    body = appendNoteToDoneSection(
      body,
      `（开单时带了 --allow-pr-body-acceptance：${o.allowPrBodyAcceptance}）`,
    );
    createBodyPath = join(tmpdir(), `fleet-issue-new-body-${process.pid}-${Date.now()}.md`);
    writeFileSync(createBodyPath, body, 'utf8');
  }
  if (body.length > BODY_LIMIT) {
    throw new Error(
      `正文有 ${body.length} 字，超过 GitHub 一张单正文的上限（65536 字，这里留了余量按 ${BODY_LIMIT} 算），单没开：需求写一页以内；长的方案另放 specs/<号>-<短名>/方案.md，单上只留链接。`,
    );
  }

  // 开单之前查（开出来的新单不会和自己比）；只提示、不拦，查不动也往下开
  const similar = await deps.similar?.({ title: o.title, body });

  const picked = o.milestone === UNSCHEDULED ? undefined : await resolveMilestone(deps.gh, o.milestone);
  const milestone = picked?.title ?? UNSCHEDULED;
  // 要排进版本先后的：挂版本（v<N> 开头）、不是子单（子单在母单页面上排，不进这层）；未排期、旧的 P 阶段没有先后
  const version =
    picked !== undefined && o.parent === undefined && milestoneVersion(picked.title) !== undefined
      ? versionOf(picked)
      : undefined;
  if (o.orderAfter !== undefined) checkOrderAfter(o.orderAfter, milestone, version);
  if (o.parent !== undefined) await checkParent(deps.gh, o.parent);
  const created = await deps.gh([
    'issue',
    'create',
    '--title',
    o.title,
    '--body-file',
    createBodyPath,
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
      `gh 退出码是 0，可输出里认不出单号：${detail(created)}。单多半已经开了，去 GitHub 按标题「${o.title}」找一下。`,
    );
  }
  const number = Number(n);
  const { parent } = o;
  const local = o.local || undefined;
  if (parent !== undefined) await attachToParent(deps.gh, { number, url, parent, milestone });
  const order =
    version === undefined
      ? undefined
      : await orderIntoVersion(deps.gh, { number, url, version, after: o.orderAfter });
  return { number, url, milestone, parent, local, order, similar };
}

interface Options {
  kind: string;
  milestone: string;
  title: string;
  bodyFile: string;
  /** 多贴「母单」标签：这张单下面会挂子单（GitHub 自带子议题）。 */
  mother: boolean;
  /** 开的是子单：挂到这张母单下面。 */
  parent: number | undefined;
  /** 多贴「本机做」标签：帅位留给本机做，接活不自动派（#299 止血）。 */
  local: boolean;
  /** 排进版本先后时插在这张后面；没给排末尾。 */
  orderAfter: number | undefined;
  /**
   * 「怎么算做完」里写了 PR 正文仍要开单时的理由（#1792）。
   * 没给且命中就拒开；给了就照开并把这句话追加进那一节末尾。
   */
  allowPrBodyAcceptance: string | undefined;
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
        mother: { type: 'boolean' },
        parent: { type: 'string' },
        local: { type: 'boolean' },
        'order-after': { type: 'string' },
        'allow-pr-body-acceptance': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new Error(`参数不对（${message(e)}）。${USAGE}`);
  }
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v.trim() : undefined;
  /** 单号参数：写成 192 或 #192；没给是 undefined，认不出就拒（还没调 gh）。 */
  const issueArg = (flag: 'parent' | 'order-after', what: string, example: number): number | undefined => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    const m = /^#?([1-9]\d*)$/.exec(str(raw) ?? '');
    if (!m?.[1])
      throw new Error(`--${flag} 写${what}的号（比如 --${flag} ${example}），「${raw}」认不出。${USAGE}`);
    return Number(m[1]);
  };
  const kind = str(values.kind);
  if (!kind) throw new Error(`缺 --kind：从 ${KIND_LABELS.join('、')} 里挑一个。${USAGE}`);
  if (!isKindLabel(kind)) throw new Error(`--kind 只能是 ${KIND_LABELS.join('、')}，没有「${kind}」。`);
  const milestone = str(values.milestone);
  if (!milestone) throw new Error(`缺 --milestone：写这块活属于的阶段，比如 --milestone P1。${USAGE}`);
  const title = str(values.title);
  if (!title) throw new Error(`缺 --title：一句话写要什么。${USAGE}`);
  const bodyFile = str(values['body-file']);
  if (!bodyFile) throw new Error(`缺 --body-file：正文写进一个文件再指过来。${USAGE}`);
  const mother = values.mother === true;
  const parent = issueArg('parent', '母单', 192);
  const orderAfter = issueArg('order-after', '先后里排在它前面的那张单', 450);
  if (orderAfter !== undefined && parent !== undefined) {
    throw new Error(
      `--order-after 和 --parent 不能一起用：子单不进版本的先后，在母单 #${parent} 页面上排。${USAGE}`,
    );
  }
  if (orderAfter !== undefined && milestone === UNSCHEDULED) {
    throw new Error(`--order-after 和 --milestone ${UNSCHEDULED} 不能一起用：未排期的单没有先后。${USAGE}`);
  }
  const allowRaw = values['allow-pr-body-acceptance'];
  const allowPrBodyAcceptance = allowRaw === undefined ? undefined : str(allowRaw);
  if (allowRaw !== undefined && !allowPrBodyAcceptance) {
    throw new Error(`--allow-pr-body-acceptance 要写理由（非空），单没开。${USAGE}`);
  }
  return {
    kind,
    milestone,
    title,
    bodyFile,
    mother,
    parent,
    local: values.local === true,
    orderAfter,
    allowPrBodyAcceptance,
  };
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
  a: { number: number; url: string; parent: number; milestone: string },
): Promise<void> {
  const thenMilestone =
    a.milestone === UNSCHEDULED ? '' : `，再 gh issue edit ${a.number} --milestone "${a.milestone}"`;
  const unlinked = (why: string) =>
    new Error(
      `单开了（#${a.number} ${a.url}），可没挂到 #${a.parent} 下面：${why}。它现在没挂里程碑（未排期，不会被自动派）：` +
        `在 #${a.parent} 页面上把它加成子议题${thenMilestone}。`,
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
        `${detail(edit)}。手动补：gh issue edit ${a.number} --milestone "${a.milestone}"。`,
    );
  }
}

/** 选中的开放里程碑：全名，和接口回的那一项原样（要排先后的再按 toMilestoneDetail 认编号和说明，不排的不多挑）。 */
interface Picked {
  title: string;
  raw: unknown;
}

/**
 * 「v1」「P1」（旧）→ 开放里程碑里那个简写开头的那一个；给的就是全名也行。
 * 「未排期」不经过这里：issueNew 里直接处理，不查里程碑列表。
 */
async function resolveMilestone(gh: Gh, want: string): Promise<Picked> {
  const r = await gh(['api', 'repos/{owner}/{repo}/milestones?state=open&per_page=100']);
  if (r.code !== 0) throw new Error(`gh 读里程碑失败（退出码 ${r.code}），单没开：${detail(r)}`);
  let items: Picked[];
  try {
    const data: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(data)) throw new Error('不是列表');
    items = data.map((m: unknown) => {
      const title = typeof m === 'object' && m !== null ? (m as { title?: unknown }).title : undefined;
      if (typeof title !== 'string') throw new Error('有一项没有 title');
      return { title, raw: m };
    });
  } catch (e) {
    throw new Error(`gh 读回来的里程碑认不出（${message(e)}），单没开。`);
  }
  const exact = items.filter((m) => m.title === want);
  const phase = /^P\d+$/.test(want) ? Number(want.slice(1)) : undefined;
  const version = /^v\d+$/.test(want) ? Number(want.slice(1)) : undefined;
  const shorthand =
    phase !== undefined
      ? items.filter((m) => milestonePhase(m.title) === phase)
      : version !== undefined
        ? items.filter((m) => milestoneVersion(m.title) === version)
        : undefined;
  const matches = exact.length || shorthand === undefined ? exact : shorthand;
  const [only, ...more] = matches;
  if (only !== undefined && more.length === 0) return only;
  if (only === undefined) {
    const open = items.map((m) => m.title).join('、') || '（一个也没有）';
    throw new Error(`没有叫「${want}」的开放里程碑，单没开：开放的有 ${open}。`);
  }
  throw new Error(
    `「${want}」对上了好几个里程碑（${matches.map((m) => m.title).join('、')}），单没开：写全名。`,
  );
}

/** 要排先后的版本里程碑：认出编号和说明（排的时候要按编号改它的说明）；认不出就不开单——开了也排不进去。 */
function versionOf(picked: Picked): MilestoneDetail {
  try {
    return toMilestoneDetail(picked.raw);
  } catch (e) {
    throw new Error(
      `gh 读回来的里程碑「${picked.title}」认不出（${message(e)}），单没开：排先后要用它的编号和说明。`,
    );
  }
}

/**
 * --order-after 开单之前先核（写错了开单前就拦下；开完再发现只能手工补）：只给要排进版本先后的单用，插到谁后面它得在先后里。
 * 说明现在就认不出先后的不在这里拦：开单后排先后那一步照实报。
 */
function checkOrderAfter(after: number, milestone: string, version: MilestoneDetail | undefined): void {
  if (version === undefined) {
    throw new Error(
      `「${milestone}」不是版本（v<N> 开头的里程碑），没有先后，--order-after 用不上，单没开。${USAGE}`,
    );
  }
  const now = parseOrder(version.description);
  if (now.ok && !now.order.includes(after)) {
    throw new Error(
      `--order-after #${after} 不在「${version.title}」的先后里（现在排的是 ${now.order.map((n) => `#${n}`).join('、')}），` +
        '单没开：写先后里有的单号；不写就排到末尾。',
    );
  }
}

/**
 * 挂版本的母单、单独的单开好以后，排进那个版本里程碑说明的先后（#807）。读最新的说明 → addToOrder（和对账、pnpm plan 同一份
 * 认法）→ PATCH → 拿回包核一遍真排进去了，不拿「退出码 0」当排好了。哪一步没成都不回滚单（单已经开了，重开会开出重复的），
 * 照实报「开了 #N，但没排进先后」、原因和怎么手工补。
 */
async function orderIntoVersion(
  gh: Gh,
  a: { number: number; url: string; version: MilestoneDetail; after: number | undefined },
): Promise<{ position: number; count: number }> {
  const page = a.url.replace(/\/issues\/\d+$/, `/milestone/${a.version.number}`);
  const where = a.after === undefined ? '末尾加一行' : `#${a.after} 后面插一行（后面的序号顺延）`;
  const unordered = (why: string) =>
    new Error(
      `开了 #${a.number}（${a.url}），但没排进「${a.version.title}」的先后：${why}。自己去里程碑说明里补：` +
        `打开 ${page} → Edit milestone，在 <!-- fleet:order --> 和 <!-- /fleet:order --> 之间${where}「<序号>. #${a.number}」。`,
    );
  const path = `repos/{owner}/{repo}/milestones/${a.version.number}`;
  const read = await gh(['api', path]);
  if (read.code !== 0) throw unordered(`gh 读里程碑说明失败（退出码 ${read.code}）：${detail(read)}`);
  let description: string;
  try {
    description = toMilestoneDetail(JSON.parse(read.stdout)).description;
  } catch (e) {
    throw unordered(`gh 读回来的里程碑认不出（${message(e)}）`);
  }
  const added = addToOrder(description, a.number, a.after);
  if (!added.ok) throw unordered(added.problem);
  if (added.changed) {
    const patch = await gh(['api', '-X', 'PATCH', path, '-f', `description=${added.description}`]);
    if (patch.code !== 0) throw unordered(`gh 改里程碑说明报错（退出码 ${patch.code}）：${detail(patch)}`);
    let back: OrderParse | undefined;
    try {
      back = parseOrder(toMilestoneDetail(JSON.parse(patch.stdout)).description);
    } catch {
      back = undefined;
    }
    if (!back?.ok || !back.order.includes(a.number)) {
      throw unordered('gh 说改好了，可改完回来的说明里认不出它（可能已经改了一半）：先打开看一眼');
    }
  }
  return { position: added.order.indexOf(a.number) + 1, count: added.order.length };
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
