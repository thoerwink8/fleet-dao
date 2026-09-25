// 往公开仓写东西之前过一遍卫生检查：需求文档直写进主线（Contents API）、开 PR 的标题和正文、需求 issue 的进度段，都不经 git 推送，
// 推前扫描（push.ts）和 git 钩子都拦不到，写上去就公开了。和推前扫描同一套规则、白名单和已知敏感值名单：
// 查出来 HYGIENE_BLOCKED（不可重试：得改内容），名单没读到 HYGIENE_LIST_MISSING，扫不成 HYGIENE_UNSCANNED——都不写。
// 报错只带位置（文件或「PR 标题」这类名字、行、规则名），不带值。
import {
  ALLOWLIST,
  formatFinding,
  type LoadedValues,
  loadSensitiveValues,
  scanFiles,
} from '@fleet-dao/hygiene';
import { GitHubError } from './errors.ts';

/** 要写出去的一段字：path 是它在仓里的位置（需求文档），不是文件的写「PR 标题」这类名字。 */
export interface PublishText {
  path: string;
  text: string;
}

/** 最多在报错信息里列几条命中（全部命中在 details 里）。 */
const MAX_LISTED = 10;

export function assertPublishable(
  what: string,
  texts: readonly PublishText[],
  load: () => LoadedValues = () => loadSensitiveValues(),
): void {
  const values = load();
  if (!values.ok) {
    throw new GitHubError(
      'HYGIENE_LIST_MISSING',
      `${what}之前的卫生检查没法做：${values.reason}。名单放好之前一律不写（引擎读 /etc/fleet-dao/sensitive-values.txt）`,
      { details: { tried: values.tried } },
    );
  }
  const byPath = new Map(texts.map((t) => [t.path, t.text]));
  const report = scanFiles(
    [...byPath.keys()],
    (path) => Buffer.from(byPath.get(path) ?? '', 'utf8'),
    ALLOWLIST,
    values.values,
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
  throw new GitHubError(
    'HYGIENE_BLOCKED',
    `${what}被卫生检查拦下：查出 ${findings.length} 处（${listed.join('；')}${more}）。公开仓写上去就公开了，改掉再写`,
    { details: { findings: findings.map((f) => ({ path: f.path, line: f.line, rule: f.rule })) } },
  );
}
