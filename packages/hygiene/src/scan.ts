// 全仓扫：进 git 的每个文件（外加还没提交、也没被忽略的新文件）先按文件名判是不是密钥文件，
// 再把内容过一遍 rules.ts 和已知敏感值名单（values.ts），最后按 allowlist.ts 放行。
// 只读本地文件、跑一次 git ls-files，不出网。任何输出只报文件、行和规则名，不打命中的值。
import { execFileSync } from 'node:child_process';
import { ALLOWLIST, type Allow } from './allowlist.ts';
import { findHits, findSecretFile, type Hit } from './rules.ts';
import { valueMatcher } from './values.ts';

export interface Finding extends Hit {
  /** 相对仓库根。 */
  path: string;
}

export interface ScanReport {
  /** 扫了的文本文件。 */
  scanned: string[];
  /** 二进制文件，只按文件名判、没扫内容（单列出来，免得「没扫」混进「扫了没事」）。 */
  binary: string[];
  /** 列在 git 里、工作树里已经删掉的文件。 */
  missing: string[];
  findings: Finding[];
  /** 白名单里这次一处都没用上的条目（只提示：别的分支、别的文件可能还用得上）。 */
  unusedAllows: Allow[];
}

/** 仓库里要扫的文件：进 git 的，加上还没提交、也没被 .gitignore 忽略的新文件（本地跑时新文件也要查）。 */
export function listRepoFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

/** 前 8000 字节里有 NUL 就当二进制（和 git 判二进制的办法一样）。 */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** 按白名单过滤命中：用上的条目记进 used。 */
export function applyAllowlist(
  hits: readonly Finding[],
  allowlist: readonly Allow[],
  used: Set<Allow>,
): Finding[] {
  return hits.filter((hit) => {
    const allow = allowlist.find(
      (a) =>
        a.rule === hit.rule && a.path.test(hit.path) && (a.match === undefined || a.match.test(hit.match)),
    );
    if (allow) used.add(allow);
    return !allow;
  });
}

/** 一段文本里的全部命中：规则表加名单。 */
export function hitsIn(text: string, values: readonly string[]): Hit[] {
  return [...findHits(text), ...valueMatcher(values).find(text)];
}

export function scanFiles(
  paths: readonly string[],
  read: (path: string) => Buffer,
  allowlist: readonly Allow[] = ALLOWLIST,
  values: readonly string[] = [],
): ScanReport {
  const report: ScanReport = { scanned: [], binary: [], missing: [], findings: [], unusedAllows: [] };
  const used = new Set<Allow>();
  const matcher = valueMatcher(values);
  for (const path of paths) {
    const hits: Finding[] = [];
    // 先按文件名判：密钥文件不管是不是二进制、工作树里还在不在（还在 git 里就算），都要拦。
    const secretFile = findSecretFile(path);
    if (secretFile) hits.push({ ...secretFile, path });
    let content: Buffer | undefined;
    try {
      content = read(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      report.missing.push(path);
    }
    if (content && isBinary(content)) report.binary.push(path);
    else if (content) {
      report.scanned.push(path);
      const text = content.toString('utf8');
      for (const hit of [...findHits(text), ...matcher.find(text)]) hits.push({ ...hit, path });
    }
    report.findings.push(...applyAllowlist(hits, allowlist, used));
  }
  report.unusedAllows = allowlist.filter((a) => !used.has(a));
  return report;
}

/** 一条命中打成一行：只有文件、行和规则名，值一律不打（检查的输出会进 CI 日志、会话记录）。 */
export function formatFinding(f: Pick<Finding, 'path' | 'line' | 'label'>): string {
  return `${f.line > 0 ? `${f.path}:${f.line}` : f.path} ${f.label}`;
}
