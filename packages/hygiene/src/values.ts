// 已知敏感值名单：真实的组织编号、账号这类「光看形状认不出」的值，不进仓，放在本机、服务器和 CI 密钥里，
// 这里只管找、读、比。找的顺序（第一个存在的算数）：环境变量 FLEET_SENSITIVE_VALUES_FILE 指的文件、
// ~/.fleet-dao/sensitive-values.txt、/etc/fleet-dao/sensitive-values.txt。CI 把 Actions 密钥 FLEET_SENSITIVE_VALUES
// 写成临时文件再用环境变量指过来（.github/workflows/ci.yml）。
// 名单没读到、读不了、是空的，都不许当成「没问题」：调用方拿到 ok:false 要明确报出来，退出码和「查出问题」分开。
// 名单里的值永远不打印：命中只报文件、行和规则名。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Hit, lineLocator } from './rules.ts';

export const SENSITIVE_VALUES_ENV = 'FLEET_SENSITIVE_VALUES_FILE';

export type LoadedValues =
  | { ok: true; source: string; values: readonly string[] }
  | { ok: false; reason: string; tried: readonly string[] };

export interface LoadOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  exists?: (path: string) => boolean;
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

/** 找第一个存在的名单读进来。存在但读不了、或者读出来是空的，都算没读到（不往下一个找，免得悄悄换了名单）。 */
export function loadSensitiveValues(options: LoadOptions = {}): LoadedValues {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const tried = sensitiveValuesPaths(env, options.home ?? homedir());
  for (const path of tried) {
    if (!exists(path)) continue;
    let text: string;
    try {
      text = read(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
      return { ok: false, reason: `已知敏感值名单 ${path} 读不了（${code}）`, tried };
    }
    const values = parseSensitiveValues(text);
    if (values.length === 0) return { ok: false, reason: `已知敏感值名单 ${path} 是空的`, tried };
    return { ok: true, source: path, values };
  }
  return { ok: false, reason: `已知敏感值名单没读到（找过：${tried.join('、')}）`, tried };
}

/** 短值（少于 6 个字符）要同一行有这类词才算：三四位的组织编号直接按值比会撞上行号、端口、计数。 */
const CONTEXT_WORDS =
  /\borg\b|organi[sz]ation|account|tenant|workspace|组织|账号|账户|独享|拼车|reclaude|切到|切回|换号|切号|封号/i;
export const SHORT_VALUE_LENGTH = 6;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 整词：前后都不能紧挨着字母、数字、下划线（不许是更长数字、更长单词的一部分）。 */
function wholeWords(values: readonly string[]): RegExp | undefined {
  if (values.length === 0) return undefined;
  const alternatives = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives.join('|')})(?![A-Za-z0-9_])`, 'gi');
}

export interface ValueMatcher {
  find(text: string): Hit[];
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
        if (CONTEXT_WORDS.test(text.slice(start, end === -1 ? undefined : end))) hit(at, m[0]);
      }
      return hits;
    },
  };
}
