// 已知敏感值名单：真实的组织编号、账号这类「光看形状认不出」的值，不进仓，放在本机、服务器和 CI 密钥里，
// 这里只管找、读、比。找的顺序（第一个存在的算数）：环境变量 FLEET_SENSITIVE_VALUES_FILE 指的文件、
// ~/.fleet-dao/sensitive-values.txt、/etc/fleet-dao/sensitive-values.txt。CI 把 Actions 密钥 FLEET_SENSITIVE_VALUES
// 写成临时文件再用环境变量指过来（.github/workflows/ci.yml）。
// 名单没读到、读不了、是空的，都不许当成「没问题」：调用方拿到 ok:false 要明确报出来，退出码和「查出问题」分开。
// 三处都没有、也没设环境变量时 absent 为 true：这台机器压根没放名单。本机推前的钩子据此改成「明说没查名单、交给 CI」
// （创始人 2026-09-26 拍）；CI、引擎推分支、写单子照旧必须有名单。放了但读不了、是空的、环境变量指错，都不算 absent。
// 名单里的值永远不打印：命中只报文件、行和规则名。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Hit, lineLocator } from './rules.ts';

export const SENSITIVE_VALUES_ENV = 'FLEET_SENSITIVE_VALUES_FILE';

export type LoadedValues =
  | { ok: true; source: string; values: readonly string[] }
  | { ok: false; reason: string; tried: readonly string[]; absent?: true };

export interface LoadOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  read?: (path: string) => string;
}

/** 按顺序要找的几个位置。 */
export function sensitiveValuesPaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string[] {
  const fromEnv = env[SENSITIVE_VALUES_ENV]?.trim();
  return [
    ...(fromEnv ? [fromEnv] : []),
    join(home, '.fleet-dao', 'sensitive-values.txt'),
    '/etc/fleet-dao/sensitive-values.txt',
  ];
}

/** 一行一个值；空行、# 开头的行不算；首尾空白去掉。 */
export function parseSensitiveValues(text: string): string[] {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return [...new Set(values)];
}

/**
 * 找第一个存在的名单读进来。存在但读不了、或者读出来是空的，都算没读到（不往下一个找，免得悄悄换了名单）；
 * 环境变量指了文件、文件却不在，也算没读到（多半是路径写错了，同样不能悄悄换成家目录那份）。
 * 「在不在」靠直接读、看错误码判，不用 existsSync：目录没权限时 existsSync 也回 false，放了读不了的名单会被当成没放
 * （#184 第二意见）。只有 ENOENT、ENOTDIR 算没有这个文件；EACCES 这类都算放了却读不了。
 */
export function loadSensitiveValues(options: LoadOptions = {}): LoadedValues {
  const env = options.env ?? process.env;
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const fromEnv = env[SENSITIVE_VALUES_ENV]?.trim();
  const tried = sensitiveValuesPaths(env, options.home ?? homedir());
  for (const path of tried) {
    let text: string;
    try {
      text = read(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
      const missing = code === 'ENOENT' || code === 'ENOTDIR';
      if (missing && fromEnv && path === fromEnv)
        return {
          ok: false,
          reason: `环境变量 ${SENSITIVE_VALUES_ENV} 指的已知敏感值名单 ${fromEnv} 不在`,
          tried: [fromEnv],
        };
      if (missing) continue;
      return { ok: false, reason: `已知敏感值名单 ${path} 读不了（${code}）`, tried };
    }
    const values = parseSensitiveValues(text);
    if (values.length === 0) return { ok: false, reason: `已知敏感值名单 ${path} 是空的`, tried };
    return { ok: true, source: path, values };
  }
  return { ok: false, reason: `已知敏感值名单没读到（找过：${tried.join('、')}）`, tried, absent: true };
}

/**
 * 短值（少于 6 个字符）要同一行有这类词才算：三四位的组织编号直接按值比会撞上行号、端口、计数。
 * org 前后只拦字母数字（organ、morgan 不算）：不用 \b，\b 把下划线当单词的一部分，ANTHROPIC_ORG_ID=、CLAUDE_ORG= 会漏；
 * 驼峰的键名先拆开再比（anthropicOrgId 当 anthropic Org Id）。
 */
const CONTEXT_WORDS =
  /(?<![A-Za-z0-9])orgs?(?![A-Za-z0-9])|organi[sz]ation|account|tenant|workspace|组织|账号|账户|独享|拼车|reclaude|切到|切回|换号|切号|封号/i;
const splitCamel = (line: string) => line.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
export const SHORT_VALUE_LENGTH = 6;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 整词：前后都不能紧挨着字母、数字（不许是更长数字、更长单词的一部分），也不许是小数、带点分段的编号的一截（1.4821、4821.5）。
 * 下划线、连字符算分隔：ORG_4821、org-4821 里的 4821 照样算。
 */
function wholeWords(values: readonly string[]): RegExp | undefined {
  if (values.length === 0) return undefined;
  const alternatives = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9]|\\d\\.)(?:${alternatives.join('|')})(?![A-Za-z0-9]|\\.\\d)`, 'gi');
}

export interface ValueMatcher {
  find(text: string): Hit[];
}

/** 名字（文件路径、分支名）里名单上的值打码后的写法：报出来的位置里不能带着值。 */
const MASK = '〔名单上的值〕';

/** 把名字里名单上的值换成打码的写法（报错、日志里要写名字的地方用）。 */
export function maskValues(name: string, matcher: ValueMatcher): string {
  let masked = name;
  for (const hit of matcher.find(name)) masked = masked.split(hit.match).join(MASK);
  return masked;
}

/**
 * 名字本身带名单上的值（文件路径、要直写进主线的文档路径）：内容另有地方扫，名字要是只按「是不是密钥文件」判，
 * 「specs/<组织编号>-…/需求.md」「src/<账号>.ts」这种就放过去了，推上去、写上去照样公开。
 * 命中记在打了码的名字上（line = 0 表示名字本身），报出来的位置不带值。
 */
export function valueHitsInName(name: string, matcher: ValueMatcher): (Hit & { path: string })[] {
  const hits = matcher.find(name);
  if (hits.length === 0) return [];
  const path = maskValues(name, matcher);
  return hits.map((hit) => ({ ...hit, line: 0, path }));
}

/** 把名单编成一个比对器：6 个字符及以上的整词出现就算；更短的还要同一行有上下文词。 */
export function valueMatcher(values: readonly string[]): ValueMatcher {
  const long = wholeWords(values.filter((v) => v.length >= SHORT_VALUE_LENGTH));
  const short = wholeWords(values.filter((v) => v.length < SHORT_VALUE_LENGTH));
  return {
    find(text) {
      const lineOf = lineLocator(text);
      const hits: Hit[] = [];
      const hit = (index: number, match: string) =>
        hits.push({ rule: 'known-value', label: '名单里的敏感值', match, line: lineOf(index) });
      for (const m of long ? text.matchAll(long) : []) hit(m.index ?? 0, m[0]);
      for (const m of short ? text.matchAll(short) : []) {
        const at = m.index ?? 0;
        const start = text.lastIndexOf('\n', at) + 1;
        const end = text.indexOf('\n', at);
        if (CONTEXT_WORDS.test(splitCamel(text.slice(start, end === -1 ? undefined : end)))) hit(at, m[0]);
      }
      return hits;
    },
  };
}
