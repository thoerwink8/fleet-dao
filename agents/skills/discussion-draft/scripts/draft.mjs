// 讨论稿的起稿和推前检查。八节、状态行和五步写在模板里（默认是上一层的 template.md）。
// 单文件、零依赖、不写死哪个仓的约定：可以原样拷进别的仓用，各仓的差异写在仓根 package.json，改这份时别加只对一个仓成立的东西。
//
//   node draft.mjs new <短名> --ask "需求方提了什么" [--title 标题] [--date YYYY-MM-DD] [--root 仓根]
//   node draft.mjs check [文件…] [--today YYYY-MM-DD] [--root 仓根]
//
// 配置：仓根 package.json 的 "discussionDraft"，每项都可不写：
//   dir        稿放哪个目录（仓根相对），默认 docs；文件名 YYYY-MM-DD-<短名><suffix>
//   suffix     文件名后缀，默认 -survey.md
//   template   模板（仓根相对），默认本脚本上一层的 template.md；拷进别的仓后那里没有，要写
//   decisions  决定放哪（目录或单个文件，可写数组），默认 docs/decisions 和 docs/decisions.md
//   task       任务编号的正则（字符串），默认 GitHub 单号 #123
//   since      只查文件名日期不早于这天的稿（YYYY-MM-DD），用模板之前的旧稿靠它跳过；默认全查
//   staleDays  「讨论中」超过几天提醒，默认 7
//
// new：按模板起稿，去掉模板开头那段说明注释，填好 {{标题}} {{日期}} {{起因}} {{代码版本}}，状态是模板里的「讨论中」。
//   同短名已有稿（不论哪天）就报出那份、不新建，退出 1：同一个主题只留一份稿，接着改旧稿。
// check：「讨论中」的稿模板的「## 」标题要齐；「已定」的结论节（模板最后一个「## 」）要有指得到的决定链接和任务编号；
//   状态认不出也算不合规。不合规退出 1，推前钩子见非 0 就拒推。「讨论中」超过 staleDays 天只提醒、不影响退出码。
//   不给文件就查目录里全部的稿；给了只查其中是稿的那几份（钩子可以只传这次推的文件）。
// 退出码：0 过；1 不合规或拒绝新建；2 没查成（读不到配置、模板、目录，参数不对，找不到仓根）——没查成不算过。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = [
  '用法：',
  '  node draft.mjs new <短名> --ask "需求方提了什么" [--title 标题] [--date YYYY-MM-DD] [--root 仓根]',
  '  node draft.mjs check [文件…] [--today YYYY-MM-DD] [--root 仓根]',
].join('\n');

export const STATUSES = ['讨论中', '已定', '搁置'];
const DEFAULT_TEMPLATE = fileURLToPath(new URL('../template.md', import.meta.url));

/**
 * @typedef {{ dir: string; suffix: string; template: string | null; decisions: string[]; task: RegExp; since: string | null; staleDays: number }} Config
 * @typedef {{ errors: string[]; reminders: string[] }} DraftCheck
 */

/** 配置或模板不对：不是稿不合规，是没法查（退出 2）。 */
export class SetupError extends Error {}

/** @param {unknown} v */
const isDate = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;

/** @param {string} a @param {string} b 两个日期差几天（b − a）。 */
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** 本机当天（不用 UTC：北京时间早上 8 点前 UTC 还是前一天）。 */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 读仓根 package.json 的 discussionDraft；没有 package.json 或没写这一项就全用默认。认不出的键、类型不对都抛 SetupError：
 * 写错的配置被悄悄忽略，等于按默认查了一个不是这个仓约定的位置。
 * @param {unknown} raw package.json 里 discussionDraft 的值（undefined 表示没写）
 * @returns {Config}
 */
export function parseConfig(raw) {
  /** @type {Config} */
  const config = {
    dir: 'docs',
    suffix: '-survey.md',
    template: null,
    decisions: ['docs/decisions', 'docs/decisions.md'],
    task: /(?<![\w&])#\d+\b/,
    since: null,
    staleDays: 7,
  };
  if (raw === undefined) return config;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SetupError('package.json 的 discussionDraft 要是一个对象');
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const text = (/** @type {string} */ key) => {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '')
      throw new SetupError(`discussionDraft.${key} 要是非空字符串`);
    return v.trim();
  };
  for (const key of Object.keys(obj)) {
    if (key === 'dir' || key === 'suffix') config[key] = text(key).replace(/\\/g, '/');
    else if (key === 'template') config.template = text(key).replace(/\\/g, '/');
    else if (key === 'decisions') {
      const v = obj.decisions;
      const list = typeof v === 'string' ? [v] : v;
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.every((x) => typeof x === 'string' && x.trim() !== '')
      ) {
        throw new SetupError('discussionDraft.decisions 要是路径或非空的路径数组');
      }
      config.decisions = list.map((x) => String(x).trim().replace(/\\/g, '/').replace(/\/+$/, ''));
    } else if (key === 'task') {
      try {
        config.task = new RegExp(text(key), 'u');
      } catch (e) {
        throw new SetupError(
          `discussionDraft.task 不是合法的正则：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else if (key === 'since') {
      if (!isDate(obj.since)) throw new SetupError('discussionDraft.since 要是 YYYY-MM-DD');
      config.since = /** @type {string} */ (obj.since);
    } else if (key === 'staleDays') {
      const v = obj.staleDays;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
        throw new SetupError('discussionDraft.staleDays 要是正整数');
      config.staleDays = v;
    } else {
      throw new SetupError(
        `discussionDraft 里不认识「${key}」（认得的：dir、suffix、template、decisions、task、since、staleDays）`,
      );
    }
  }
  return config;
}

/** @param {string} root @returns {Config} */
export function loadConfig(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return parseConfig(undefined);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SetupError(`读不了 package.json：${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(pkg?.discussionDraft);
}

/** HTML 注释整段去掉（跨行的也算），换行留着，行号不乱。 @param {string} text */
export const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ''));

/** 正文里的「## 」标题（注释里的不算），去掉两头空白。 @param {string} text */
export const headingsOf = (text) =>
  stripComments(text.replace(/\r\n/g, '\n'))
    .split('\n')
    .filter((line) => /^## \S/.test(line))
    .map((line) => line.trim());

/**
 * 头部（第一个「## 」之前）的状态行认出来的状态；没有状态行返回 null，有但不认识返回原文。
 * @param {string} text
 */
export function statusOf(text) {
  const head = stripComments(text.replace(/\r\n/g, '\n')).split(/^## /m)[0] ?? '';
  const m = /^- 状态：\s*(.*)$/m.exec(head);
  if (!m) return null;
  const value = (m[1] ?? '').trim();
  return STATUSES.find((s) => value.startsWith(s)) ?? value;
}

/**
 * 某个「## 」标题下面到下一个「## 」之前的正文（注释去掉）；没有这一节返回 null。
 * @param {string} text @param {string} heading
 */
export function sectionOf(text, heading) {
  const lines = stripComments(text.replace(/\r\n/g, '\n')).split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \S/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * 链接目标换成仓根相对路径：相对稿所在目录解析，去掉 #锚点 和 ?参数，%XX 解码；外链、站内锚点返回 null。
 * @param {string} draft 稿的仓根相对路径（/ 分隔） @param {string} target
 */
export function linkTarget(draft, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return null;
  let path = target.replace(/[#?].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // 解不了的照原样比
  }
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(draft), path);
  return posix.normalize(joined).replace(/\/+$/, '');
}

/**
 * 查一份稿。
 * @param {{ path: string; text: string; headings: string[]; config: Config; exists: (repoPath: string) => boolean; today: string }} input
 *   path 是仓根相对路径；headings 是模板的「## 」标题，最后一个当结论节。
 * @returns {DraftCheck}
 */
export function checkDraft({ path, text, headings, config, exists, today }) {
  /** @type {DraftCheck} */
  const out = { errors: [], reminders: [] };
  const status = statusOf(text);
  if (status === null) {
    out.errors.push('头部没有「- 状态：」行（讨论中 / 已定 / 搁置）');
    return out;
  }
  if (!STATUSES.includes(status)) {
    out.errors.push(`状态「${status}」认不出，要以讨论中 / 已定 / 搁置开头`);
    return out;
  }
  const have = new Set(headingsOf(text));
  if (status === '讨论中') {
    const missing = headings.filter((h) => !have.has(h));
    if (missing.length)
      out.errors.push(`讨论中的稿缺这几节标题（照模板原样写，用不上写「无」）：${missing.join('、')}`);
    const started = posix.basename(path).slice(0, 10);
    if (isDate(started) && daysBetween(started, today) > config.staleDays) {
      out.reminders.push(
        `讨论中已经 ${daysBetween(started, today)} 天（${started} 起稿）：该拍板就拍，放下了改「搁置（原因、什么时候再看）」`,
      );
    }
  }
  if (status === '已定') {
    const conclusion = headings.at(-1) ?? '';
    const body = sectionOf(text, conclusion);
    if (body === null) {
      out.errors.push(`已定的稿缺结论节「${conclusion}」`);
      return out;
    }
    const decisions = config.decisions;
    const links = [...body.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)]
      .map((m) => linkTarget(path, m[1] ?? ''))
      .filter((t) => t !== null);
    const toDecisions = links.filter((t) => decisions.some((d) => t === d || t.startsWith(`${d}/`)));
    const broken = toDecisions.filter((t) => !exists(t));
    if (toDecisions.length === 0) {
      out.errors.push(`已定的稿「${conclusion}」里没有指向决定（${decisions.join(' 或 ')}）的链接`);
    } else if (broken.length === toDecisions.length) {
      out.errors.push(`「${conclusion}」里的决定链接指不到文件：${broken.join('、')}`);
    }
    if (!config.task.test(body)) {
      out.errors.push(`已定的稿「${conclusion}」里没有任务编号（要匹配 ${config.task.source}）`);
    }
  }
  return out;
}

/**
 * 是不是讨论稿：在 dir 下（不进子目录）、文件名 YYYY-MM-DD-<短名><suffix>、日期不早于 since。
 * @param {string} repoPath @param {Config} config
 */
export function isDraftPath(repoPath, config) {
  const p = repoPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (posix.dirname(p) !== posix.normalize(config.dir)) return false;
  const name = posix.basename(p);
  if (!name.endsWith(config.suffix)) return false;
  const date = name.slice(0, 10);
  if (!isDate(date) || name[10] !== '-' || name.length <= 11 + config.suffix.length) return false;
  return config.since === null || date >= config.since;
}

/** 短名只许字母数字（含中文）和单个连字符：要进文件名，也要拿来认同主题的旧稿。 @param {string} short */
export const validShort = (short) => /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(short);

/**
 * 模板填好：去掉开头那段说明注释，换掉 {{…}}。模板缺状态行、缺占位、读不出「## 」标题都抛 SetupError。
 * @param {string} template @param {Record<string, string>} vars
 */
export function fillTemplate(template, vars) {
  const text = template.replace(/\r\n/g, '\n').replace(/^\s*<!--[\s\S]*?-->\s*\n/, '');
  if (statusOf(text) !== '讨论中') throw new SetupError('模板头部要有「- 状态：讨论中」');
  if (headingsOf(text).length === 0) throw new SetupError('模板里没有「## 」标题');
  const absent = Object.keys(vars).filter((key) => !text.includes(`{{${key}}}`));
  if (absent.length)
    throw new SetupError(`模板里缺占位 ${absent.map((k) => `{{${k}}}`).join('、')}，起稿命令填不上`);
  const filled = text.replace(/\{\{([^{}]+)\}\}/g, (whole, key) => vars[key] ?? whole);
  const left = [...filled.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[0]);
  if (left.length) throw new SetupError(`模板里有起稿命令不认识的占位：${[...new Set(left)].join('、')}`);
  return filled;
}

/** @param {string} root @param {Config} config */
function readTemplate(root, config) {
  const file = config.template ? join(root, config.template) : DEFAULT_TEMPLATE;
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    const hint = config.template
      ? ''
      : '（脚本拷进别的仓后要在 package.json 的 discussionDraft.template 写模板在哪）';
    throw new SetupError(`读不到模板 ${file}${hint}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0)
    return { ok: false, text: (r.stderr || r.error?.message || '没输出').trim() };
  return { ok: true, text: r.stdout.trim() };
}

/** 代码版本：短提交号，package.json 有 version 就带上；git 读不到照实写「没读到」，不留空。 @param {string} root */
export function codeVersion(root) {
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  if (!head.ok)
    return { text: `没读到（git rev-parse 失败：${head.text}）`, warning: `代码版本没读到：${head.text}` };
  let version = '';
  try {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.version;
    if (typeof v === 'string' && v.trim()) version = `（${v.trim()}）`;
  } catch {
    // 没有 package.json 就只写提交号
  }
  return { text: `\`${head.text}\`${version}`, warning: null };
}

/** @param {string} root @param {Config} config */
function listDir(root, config) {
  const dir = join(root, config.dir);
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
  } catch (e) {
    throw new SetupError(`读不了稿的目录 ${config.dir}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 起稿。返回要报给人的几行和退出码；真写文件。
 * @param {{ root: string; short: string; ask: string; title?: string | undefined; date: string }} opts
 */
export function newDraft({ root, short, ask, title, date }) {
  const config = loadConfig(root);
  const existing = existsSync(join(root, config.dir))
    ? listDir(root, config).filter(
        (name) => isDate(name.slice(0, 10)) && name.slice(11) === `${short}${config.suffix}`,
      )
    : [];
  if (existing.length) {
    const paths = existing.map((name) => posix.join(config.dir, name));
    return {
      code: 1,
      lines: [
        `同主题已有稿：${paths.join('、')}。接着改这份（起因里补上新提的、改日期和代码版本），不新建。`,
      ],
    };
  }
  const version = codeVersion(root);
  const text = fillTemplate(readTemplate(root, config), {
    标题: title ?? short,
    日期: date,
    起因: `需求方 ${date} 提了：${ask}`,
    代码版本: version.text,
  });
  const rel = posix.join(config.dir, `${date}-${short}${config.suffix}`);
  if (!existsSync(join(root, config.dir))) throw new SetupError(`稿的目录 ${config.dir} 不在`);
  writeFileSync(join(root, rel), text, 'utf8');
  return {
    code: 0,
    lines: [
      ...(version.warning ? [`注意：${version.warning}`] : []),
      `起好了：${rel}（状态：讨论中）。先写头和第一节，查完补二、三；只拿第五节去问需求方。`,
    ],
  };
}

/**
 * 查稿。files 不给就查目录里全部的稿。
 * @param {{ root: string; today: string; files?: string[] | undefined }} opts
 */
export function checkDrafts({ root, today, files }) {
  const config = loadConfig(root);
  const headings = headingsOf(readTemplate(root, config));
  if (headings.length === 0) throw new SetupError('模板里没有「## 」标题，没法核对');
  const rels = (
    files?.length
      ? files.map((f) => posix.normalize(f.replace(/\\/g, '/')))
      : existsSync(join(root, config.dir))
        ? listDir(root, config).map((name) => posix.join(config.dir, name))
        : []
  ).filter((p) => isDraftPath(p, config));
  const lines = [];
  let bad = 0;
  for (const rel of rels.sort()) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch (e) {
      // 推的文件里有被删掉的稿：不在了就没什么可查
      if (files?.length && !existsSync(join(root, rel))) continue;
      throw new SetupError(`读不了 ${rel}：${e instanceof Error ? e.message : String(e)}`);
    }
    const r = checkDraft({
      path: rel,
      text,
      headings,
      config,
      today,
      exists: (p) => existsSync(join(root, p)),
    });
    if (r.errors.length) bad++;
    for (const e of r.errors) lines.push(`✗ ${rel}：${e}`);
    for (const m of r.reminders) lines.push(`! ${rel}：${m}`);
  }
  lines.push(
    bad
      ? `讨论稿检查没过：${rels.length} 份里 ${bad} 份不合规（模板见 ${config.template ?? '脚本上一层的 template.md'}）`
      : `讨论稿检查过了：${rels.length} 份`,
  );
  return { code: bad ? 1 : 0, lines };
}

/** @param {string | undefined} given */
function findRoot(given) {
  if (given) return resolve(given);
  const r = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!r.ok || !r.text)
    throw new SetupError(`找不到仓根（git rev-parse --show-toplevel：${r.text}），用 --root 指定`);
  return r.text;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const args = argv.filter((a) => a !== '--');
  const [cmd, ...rest] = args;
  /** @type {Record<string, string>} */
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (a.startsWith('--')) {
      const v = rest[i + 1];
      if (v === undefined) {
        console.error(`${a} 后面要跟值\n${USAGE}`);
        return 2;
      }
      opts[a.slice(2)] = v;
      i++;
    } else positional.push(a);
  }
  const allowed = cmd === 'new' ? ['ask', 'title', 'date', 'root'] : ['today', 'root'];
  const unknown = Object.keys(opts).filter((k) => !allowed.includes(k));
  if ((cmd !== 'new' && cmd !== 'check') || unknown.length) {
    console.error(`${unknown.length ? `不认识的参数：--${unknown.join('、--')}\n` : ''}${USAGE}`);
    return 2;
  }
  try {
    const root = findRoot(opts.root);
    let r;
    if (cmd === 'new') {
      const [short, ...extra] = positional;
      const date = opts.date ?? localToday();
      if (!short || extra.length || !opts.ask?.trim()) {
        console.error(`起稿要一个短名和 --ask\n${USAGE}`);
        return 2;
      }
      if (!validShort(short)) {
        console.error(`短名「${short}」只能是字母、数字和单个连字符（进文件名，也用来认同主题的旧稿）`);
        return 2;
      }
      if (!isDate(date)) {
        console.error(`--date 要是 YYYY-MM-DD，现在是「${date}」`);
        return 2;
      }
      r = newDraft({ root, short, ask: opts.ask.trim(), title: opts.title?.trim() || undefined, date });
    } else {
      const today = opts.today ?? localToday();
      if (!isDate(today)) {
        console.error(`--today 要是 YYYY-MM-DD，现在是「${today}」`);
        return 2;
      }
      r = checkDrafts({ root, today, files: positional });
    }
    (r.code === 0 ? console.log : console.error)(r.lines.join('\n'));
    return r.code;
  } catch (e) {
    console.error(
      `讨论稿${cmd === 'new' ? '起稿' : '检查'}没成：${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }
}

// 入口判定：Node 自带的 import.meta.main 不受软链接影响；旧 Node 退回比真实路径
const invoked =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) process.exitCode = main(process.argv.slice(2));
