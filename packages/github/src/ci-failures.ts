// CI 红了之后：告诉动手的会话「哪几个 job 红了、红在哪」（#2795）。
// 只有汇总 job（必过检查 check）红的时候，检查名、结论、摘要都是空话；真正的原因在同一个头上别的红 job 里。
// 先读红 job 的日志（要 actions: read），读不了就改读检查注解（checks: read 就够，tsc、biome 这类报错常在里面）；
// 两样都没取到，意见里明写「日志没取到：原因」，不悄悄只给一句「check 红」。
// 改这里之前必须知道：一路都是尽力而为——读失败只写进文字，不许让「红」变成抛错（红是已经确认的结论）；叫停信号照常往外抛。
import { errMessage } from '@fleet-dao/shared/util';
import { type CheckRun, failedRuns } from './checks.ts';
import { enc, type RepoRef } from './client.ts';
import type { Deps } from './deps.ts';
import { isGitHubError, redact } from './errors.ts';

/** 一个 job 的日志尾巴：最多这么多行、这么多字（报错行、红了的步骤输出、尾巴三样合起来也不超过这个字数）。 */
export const JOB_LOG_MAX_LINES = 80;
export const JOB_LOG_MAX_CHARS = 4000;
/** 整段意见（所有 job 加起来）最多这么多字。 */
export const RED_TEXT_MAX_CHARS = 8000;
/** 最多展开几个红 job 的日志；多的只列名字。 */
export const RED_JOBS_EXPANDED = 6;
const LINE_MAX_CHARS = 300;
const MAX_ERROR_LINES = 8;
const MAX_BLOCKS = 3;
const BLOCK_MAX_LINES = 30;
/** 有「红了的步骤输出」时，尾巴只留这么多行（尾巴多半是红了之后照跑的汇总步骤）。 */
const TAIL_LINES_WITH_BLOCKS = 20;
const MAX_ANNOTATIONS = 10;

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// 颜色转义码：日志里是 ESC，有的转手之后是字面的「^[」两个字符，两种都去掉。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要去掉的就是终端颜色转义码
const ANSI = /(?:\u001b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const EXIT_LINE = /^Process completed with exit code/;
// 测试器（vitest、playwright）一行一个「✓ 通过」，几百行把真正红的挤出尾巴：只留红的和汇总
const PASSED_LINE = /^\s*[✓✔√]\s/;
const GROUP = '##[group]';
const END_GROUP = '##[endgroup]';

export interface JobLogExcerpt {
  /** `##[error]` 行（去掉前缀和通用的退出码行，去重，最多 8 条）。 */
  errors: string[];
  /**
   * 紧挨在某条 `##[error]` 前面收口的那个分组（这个仓的 lint job 里 biome、tsc 各占一个分组，红了的分组后面跟一行
   * 「biome 没过」）：标题和它输出的结尾。普通步骤红了没有这个，看 tail。
   */
  blocks: { title: string; body: string }[];
  /** 日志尾巴：去了 BOM、时间戳、颜色码、步骤脚本、收尾清理和失败之后的步骤；最多 80 行。 */
  tail: string;
}

function cap(line: string): string {
  return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
}

/** 去掉通过的行、折叠连续空行、截长行。 */
function squeeze(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (PASSED_LINE.test(line)) continue;
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(blank ? '' : cap(line));
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

/** 取结尾：最多 maxLines 行、maxChars 字；超字数从行边界切，前面补一个「…」。 */
function tailOf(lines: readonly string[], maxLines: number, maxChars: number): string {
  const text = lines.slice(-maxLines).join('\n');
  if (text.length <= maxChars) return text;
  const cut = text.slice(-Math.max(1, maxChars - 2));
  const nl = cut.indexOf('\n');
  return `…\n${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

/** 从一个 job 的整份日志原文里摘出最有用的部分。纯函数。maxChars 是报错行、红了的步骤输出、尾巴三样合起来的字数上限。 */
export function jobLogExcerpt(
  raw: string,
  limits: { maxLines?: number; maxChars?: number } = {},
): JobLogExcerpt {
  const maxLines = limits.maxLines ?? JOB_LOG_MAX_LINES;
  const maxChars = limits.maxChars ?? JOB_LOG_MAX_CHARS;
  // 去 BOM、时间戳、颜色码；runner 回显的 `[command]…`（checkout 的 git 命令）不是输出
  const lines = raw
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(TIMESTAMP, '').replace(ANSI, ''))
    .filter((l) => !l.startsWith('[command]'));
  // 收尾清理（Post job cleanup.）之后全是 checkout 的清理；最后一条 ##[error] 之后是失败后照跑的步骤（传产物、写摘要）
  const cleanup = lines.indexOf('Post job cleanup.');
  let region = cleanup >= 0 ? lines.slice(0, cleanup) : lines;
  const lastError = region.findLastIndex((l) => l.startsWith('##[error]'));
  if (lastError >= 0) region = region.slice(0, lastError + 1);

  const errors: string[] = [];
  for (let i = 0; i < region.length; i += 1) {
    const line = region[i] ?? '';
    if (!line.startsWith('##[error]')) continue;
    const text = cap(line.slice('##[error]'.length).trim());
    if (text === '' || EXIT_LINE.test(text) || errors.includes(text) || errors.length >= MAX_ERROR_LINES)
      continue;
    errors.push(text);
  }

  // 红了的分组：`##[group]标题 … ##[endgroup]` 后面（隔几个空行）紧跟一条 ##[error]。步骤脚本（Run …）不算
  const found: { title: string; lines: string[] }[] = [];
  for (let i = 0; i < region.length && found.length < MAX_BLOCKS; i += 1) {
    const line = region[i] ?? '';
    if (!line.startsWith('##[error]') || EXIT_LINE.test(line.slice('##[error]'.length).trim())) continue;
    let end = i - 1;
    while (end >= 0 && (region[end] ?? '').trim() === '') end -= 1;
    if (!(region[end] ?? '').startsWith(END_GROUP)) continue;
    let start = end - 1;
    while (start >= 0 && !(region[start] ?? '').startsWith(GROUP)) start -= 1;
    const header = region[start] ?? '';
    if (start < 0 || header.startsWith(`${GROUP}Run `)) continue;
    found.push({ title: header.slice(GROUP.length).trim(), lines: region.slice(start + 1, end) });
  }
  let used = errors.reduce((n, e) => n + e.length + 3, 0);
  const blockBudget = found.length > 0 ? Math.floor((maxChars - used) / 2 / found.length) : 0;
  const blocks = found
    .map((f) => ({ title: cap(f.title), body: tailOf(squeeze(f.lines), BLOCK_MAX_LINES, blockBudget) }))
    .filter((b) => b.body !== '');
  used += blocks.reduce((n, b) => n + b.title.length + b.body.length + 8, 0);

  // 尾巴：去掉分组标记、步骤脚本原文（`##[group]Run …` 到 `##[endgroup]` 是脚本和环境变量，不是输出）
  const plain: string[] = [];
  let inScript = false;
  for (const line of region) {
    if (inScript) {
      if (line.startsWith(END_GROUP)) inScript = false;
      continue;
    }
    if (line.startsWith(`${GROUP}Run `)) inScript = true;
    else if (!line.startsWith(GROUP) && !line.startsWith(END_GROUP)) plain.push(line);
  }
  const tail = tailOf(
    squeeze(plain),
    blocks.length > 0 ? Math.min(maxLines, TAIL_LINES_WITH_BLOCKS) : maxLines,
    Math.max(400, maxChars - used),
  );
  return { errors, blocks, tail };
}

interface Annotation {
  path?: unknown;
  start_line?: unknown;
  annotation_level?: unknown;
  title?: unknown;
  message?: unknown;
}

function why(err: unknown, what: 'logs' | 'annotations'): string {
  if (isGitHubError(err)) {
    if (err.status === 403) {
      return what === 'logs'
        ? 'GitHub 回 403：引擎的 App 缺 actions: read 权限（要读日志，得创始人在 GitHub 网页上给 App 加 Actions 只读并点同意）'
        : 'GitHub 回 403：引擎的 App 缺 checks: read 权限';
    }
    if (err.status === 404 || err.status === 410) {
      return what === 'logs'
        ? `GitHub 回 ${err.status}：日志已过期或被删，或这条检查不是 Actions 的 job`
        : `GitHub 回 ${err.status}：没有这条检查`;
    }
  }
  return errMessage(err);
}

function annotationLines(list: readonly Annotation[]): string[] {
  const out: string[] = [];
  for (const a of list) {
    if (a.annotation_level !== 'failure' || typeof a.message !== 'string') continue;
    if (EXIT_LINE.test(a.message.trim())) continue;
    // Actions 自己的注解挂在 .github 上、行号是日志行号，没有信息量；tsc、biome 这类的才有真文件和行
    const where =
      typeof a.path === 'string' && a.path !== '.github' && typeof a.start_line === 'number'
        ? `${a.path}:${a.start_line} `
        : '';
    const title = typeof a.title === 'string' && a.title !== '' ? `${a.title}：` : '';
    const line = cap(`${where}${title}${a.message.trim()}`);
    if (!out.includes(line)) out.push(line);
    if (out.length >= MAX_ANNOTATIONS) break;
  }
  return out;
}

async function readLog(deps: Deps, repo: RepoRef, run: CheckRun, signal?: AbortSignal): Promise<string> {
  const res = await deps.client.request<unknown>({
    method: 'GET',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/actions/jobs/${run.id}/logs`,
    auth: { as: 'engine', repo },
    signal,
  });
  if (res.data === null || res.data === undefined) return '';
  if (typeof res.data !== 'string') throw new Error('GitHub 回的日志不是文本');
  return res.data;
}

async function readAnnotations(
  deps: Deps,
  repo: RepoRef,
  run: CheckRun,
  signal?: AbortSignal,
): Promise<Annotation[]> {
  const res = await deps.client.request<unknown>({
    method: 'GET',
    path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/check-runs/${run.id}/annotations`,
    auth: { as: 'engine', repo },
    query: { per_page: 50 },
    signal,
  });
  if (!Array.isArray(res.data)) throw new Error('GitHub 回的注解不是数组');
  return res.data as Annotation[];
}

/** 一个红 job 的一段文字：日志里的报错和尾巴；日志没取到就写原因、改读注解。 */
async function describeJob(
  deps: Deps,
  repo: RepoRef,
  run: CheckRun,
  maxChars: number,
  signal?: AbortSignal,
): Promise<string> {
  const head = `【${run.name}】${run.conclusion ?? run.status}`;
  try {
    const { errors, blocks, tail } = jobLogExcerpt(await readLog(deps, repo, run, signal), {
      maxChars: Math.max(600, maxChars - head.length - 40),
    });
    const shown = `${blocks.map((b) => b.body).join('\n')}\n${tail}`;
    const extra = errors.filter((e) => !shown.includes(e));
    return [
      head,
      ...(extra.length > 0 ? ['报错：', ...extra.map((e) => `- ${e}`)] : []),
      ...blocks.map((b) => `「${b.title}」的输出结尾：\n${b.body}`),
      tail === '' ? (blocks.length > 0 ? '' : '（日志是空的）') : `日志尾巴：\n${tail}`,
    ]
      .filter((part) => part !== '')
      .join('\n');
  } catch (err) {
    if (signal?.aborted) throw err;
    const logWhy = why(err, 'logs');
    try {
      const lines = annotationLines(await readAnnotations(deps, repo, run, signal));
      return [
        head,
        `日志没取到：${logWhy}`,
        lines.length > 0
          ? `改读检查注解里的报错：\n${lines.map((l) => `- ${l}`).join('\n')}`
          : '注解里没有报错内容',
      ].join('\n');
    } catch (annErr) {
      if (signal?.aborted) throw annErr;
      return [head, `日志没取到：${logWhy}`, `注解也没取到：${why(annErr, 'annotations')}`].join('\n');
    }
  }
}

/**
 * 红了的意见：这个头上全部红 job 的名字，加每个的日志尾巴（或注解）。runs 是这个头上读到的全部检查（含不在必过名单里的 job）。
 * 返回的文字有总上限；红 job 太多只展开前几个，其余列名字。永远不抛（叫停信号除外）。
 */
export async function describeRedJobs(
  deps: Deps,
  repo: RepoRef,
  runs: readonly CheckRun[],
  required: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const failed = failedRuns(runs);
    if (failed.length === 0) {
      return '日志没取到：红的是提交状态（不是 Actions 的 job），没有日志可读';
    }
    // 真 job 在前、必过的汇总在后：名额紧的时候先给真 job
    failed.sort(
      (a, b) =>
        Number(required.includes(a.name)) - Number(required.includes(b.name)) || a.name.localeCompare(b.name),
    );
    const shown = failed.slice(0, RED_JOBS_EXPANDED);
    const header = `红的 job：${failed.map((r) => r.name).join('、')}`;
    const share = Math.floor((RED_TEXT_MAX_CHARS - header.length - 200) / shown.length);
    const parts: string[] = [header];
    for (const run of shown) {
      parts.push(await describeJob(deps, repo, run, Math.min(JOB_LOG_MAX_CHARS, share), signal));
    }
    const rest = failed.slice(RED_JOBS_EXPANDED);
    if (rest.length > 0) {
      parts.push(`另有 ${rest.length} 个红 job 没展开：${rest.map((r) => r.name).join('、')}`);
    }
    const text = redact(parts.join('\n\n'));
    return text.length > RED_TEXT_MAX_CHARS
      ? `${text.slice(0, RED_TEXT_MAX_CHARS - 12)}\n…（超长截掉）`
      : text;
  } catch (err) {
    if (signal?.aborted) throw err;
    return `日志没取到：${redact(errMessage(err))}`;
  }
}
