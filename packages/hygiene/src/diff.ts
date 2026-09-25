// 只看新增的东西：一段 diff 里加出来的行（按文件、按连续的一段，跨行的规则如私钥正文照样认得出），
// 加上新增、改动、改名的文件名。和全仓扫同一套规则、名单、白名单。推送前逐个提交扫（history.ts）用它。
import { ALLOWLIST, type Allow } from './allowlist.ts';
import { findHits, findSecretFile } from './rules.ts';
import { applyAllowlist, type Finding } from './scan.ts';
import { maskValues, valueHitsInName, valueMatcher } from './values.ts';

export interface AddedHunk {
  path: string;
  /** 这一段第一行在新文件里是第几行（从 1 起）。 */
  startLine: number;
  text: string;
}

/** git 在路径里有特殊字符时会加引号、用 C 的转义（\t、\"、\\、八进制字节）。 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(
        ({ t: 9, n: 10, r: 13, '"': 34, '\\': 92 } as Record<string, number>)[next] ?? next.charCodeAt(0),
      );
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 从 `git diff -U0` 的输出里取出新增的行：按文件、按连续的一段拼起来，记下每段在新文件里从第几行开始。
 * 删掉的行、二进制文件（只有一句 Binary files … differ）都没有新增行。
 */
export function addedHunks(diffText: string): AddedHunk[] {
  const hunks: AddedHunk[] = [];
  let path: string | undefined;
  // 文件头（diff --git 到第一个 @@ 之间）里的 +++ 是新文件名；进了段落以后，+++ 开头的是新增的内容（例如 ++i）。
  let inHeader = false;
  let next = 0;
  let current: AddedHunk | undefined;
  const close = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  for (const raw of diffText.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      close();
      path = undefined;
      inHeader = true;
    } else if (inHeader && line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/, '');
      path = target === '/dev/null' ? undefined : unquotePath(target).replace(/^b\//, '');
    } else if (line.startsWith('@@ ')) {
      close();
      inHeader = false;
      next = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (!inHeader && line.startsWith('+') && path !== undefined) {
      if (!current) current = { path, startLine: next, text: line.slice(1) };
      else current.text += `\n${line.slice(1)}`;
      next += 1;
    } else if (!inHeader) {
      close();
      if (line.startsWith(' ')) next += 1;
    }
  }
  close();
  return hunks;
}

/** 新增的行和新出现的文件名里，有没有卫生问题。行号是新文件里的行号。 */
export function scanAdded(
  hunks: readonly AddedHunk[],
  changedPaths: readonly string[],
  options: { values: readonly string[]; allowlist?: readonly Allow[] },
): Finding[] {
  const matcher = valueMatcher(options.values);
  const found: Finding[] = [];
  // 名字里带名单上的值（推上去文件名一样公开）也算；这样的文件报出来的位置一律用打了码的名字，不把值带出去
  for (const path of changedPaths) {
    const hit = findSecretFile(path);
    if (hit) found.push({ ...hit, path: maskValues(path, matcher) });
    found.push(...valueHitsInName(path, matcher));
  }
  for (const hunk of hunks) {
    const shown = maskValues(hunk.path, matcher);
    for (const hit of [...findHits(hunk.text), ...matcher.find(hunk.text)]) {
      found.push({ ...hit, path: shown, line: hunk.startLine + hit.line - 1 });
    }
  }
  return applyAllowlist(found, options.allowlist ?? ALLOWLIST, new Set());
}
