// 往公开仓写东西之前过一遍卫生检查：需求文档直写进主线（Contents API）、开 PR 的标题和正文、需求 issue 的进度段，
// 都不经 git 推送，推前扫描（push.ts）和 git 钩子都拦不到，写上去就公开了。和推前扫描同一套规则、白名单：查出真密钥
// HYGIENE_BLOCKED（不可重试：得改内容），扫不成 HYGIENE_UNSCANNED——都不写。报错只带位置（文件或「PR 标题」这类
// 名字、行、规则名），不带值。
// 只管 fleet-dao 这一个仓（创始人 2026-10-01 10:50 前后拍）：往别的仓写东西不套这套规则，按那个仓自己的标准来
// （hygiene-scope.ts）；认不出是哪个仓时明确报错，不默认放过去。
import { ALLOWLIST, formatFinding, scanFiles } from '@fleet-dao/hygiene';
import type { RepoRef } from './client.ts';
import { GitHubError } from './errors.ts';
import { guardedByHygiene } from './hygiene-scope.ts';

/** 要写出去的一段字：path 是它在仓里的位置（需求文档，名字本身也扫），不是文件的写「PR 标题」这类说明。 */
export interface PublishText {
  path: string;
  text: string;
}

/** 最多在报错信息里列几条命中（全部命中在 details 里）。 */
const MAX_LISTED = 10;

export function assertPublishable(
  repo: RepoRef,
  what: string,
  texts: readonly PublishText[],
  guard?: RepoRef,
): void {
  // 不是卫生检查管的那个仓：不扫（认不出是哪个仓时 guardedByHygiene 自己抛）
  if (!guardedByHygiene(repo, guard)) return;
  const byPath = new Map(texts.map((t) => [t.path, t.text]));
  const report = scanFiles(
    [...byPath.keys()],
    (path) => Buffer.from(byPath.get(path) ?? '', 'utf8'),
    ALLOWLIST,
  );
  // 带 NUL 的当二进制只按名字判、内容没扫：不许当成扫过没事
  if (report.binary.length > 0 || report.scanned.length !== byPath.size) {
    throw new GitHubError(
      'HYGIENE_UNSCANNED',
      `${what}之前的卫生检查没扫成：${report.binary.join('、') || '有一段'}的内容没扫到。没扫成一律不写`,
      { details: { binary: report.binary, scanned: report.scanned.length, total: byPath.size } },
    );
  }
  const { findings } = report;
  if (findings.length === 0) return;
  const listed = findings.slice(0, MAX_LISTED).map(formatFinding);
  const more = findings.length > listed.length ? `；另有 ${findings.length - listed.length} 处` : '';
  const details = { findings: findings.map((f) => ({ path: f.path, line: f.line, rule: f.rule })) };
  throw new GitHubError(
    'HYGIENE_BLOCKED',
    `${what}被卫生检查拦下：查出 ${findings.length} 处（${listed.join('；')}${more}）。公开仓写上去就公开了，改掉再写`,
    { details },
  );
}
