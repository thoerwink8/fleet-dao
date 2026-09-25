// 往公开仓写东西之前过一遍卫生检查：需求文档直写进主线（Contents API）、开 PR 的标题和正文、需求 issue 的进度段，都不经 git 推送，
// 推前扫描（push.ts）和 git 钩子都拦不到，写上去就公开了。和推前扫描同一套规则、白名单和已知敏感值名单：
// 查出来 HYGIENE_BLOCKED（不可重试：得改内容），名单没读到 HYGIENE_LIST_MISSING，扫不成 HYGIENE_UNSCANNED——都不写。
// 名字（文档路径、分支名）一样公开，也按名单比；名字是引擎开工时按 issue 标题、子任务的 key 定下的，会话改不了、
// 重试还是它：名字里查出来的报 HYGIENE_NAME_BLOCKED（挂起等人），不和「内容被拦、退回会话改」混成一个码。
// 报错只带位置（文件或「PR 标题」这类名字、行、规则名），不带值；名字里的值打了码再报。
import {
  ALLOWLIST,
  applyAllowlist,
  type Finding,
  formatFinding,
  type LoadedValues,
  loadSensitiveValues,
  maskValues,
  scanFiles,
  valueHitsInName,
  valueMatcher,
} from '@fleet-dao/hygiene';
import { GitHubError } from './errors.ts';

/** 要写出去的一段字：path 是它在仓里的位置（需求文档，名字本身也扫），不是文件的写「PR 标题」这类说明。 */
export interface PublishText {
  path: string;
  text: string;
}

/** 要公开的名字（分支名、进度段里的文档路径）：label 说它是什么，报出来是「分支名 fleet/12-〔名单上的值〕」这样。 */
export interface PublishName {
  label: string;
  name: string;
}

/** 最多在报错信息里列几条命中（全部命中在 details 里）。 */
const MAX_LISTED = 10;

export function assertPublishable(
  what: string,
  texts: readonly PublishText[],
  load: () => LoadedValues = () => loadSensitiveValues(),
  names: readonly PublishName[] = [],
): void {
  const values = load();
  if (!values.ok) {
    throw new GitHubError(
      'HYGIENE_LIST_MISSING',
      `${what}之前的卫生检查没法做：${values.reason}。名单放好之前一律不写（引擎读 /etc/fleet-dao/sensitive-values.txt）`,
      { details: { tried: values.tried } },
    );
  }
  const matcher = valueMatcher(values.values);
  // what 里常带着路径、分支名：报错里一律用打了码的
  const shown = maskValues(what, matcher);
  const byPath = new Map(texts.map((t) => [t.path, t.text]));
  const report = scanFiles(
    [...byPath.keys()],
    (path) => Buffer.from(byPath.get(path) ?? '', 'utf8'),
    ALLOWLIST,
    values.values,
  );
  // 带 NUL 的当二进制只按名字判、内容没扫：不许当成扫过没事
  if (report.binary.length > 0 || report.scanned.length !== byPath.size) {
    const binary = report.binary.map((p) => maskValues(p, matcher));
    throw new GitHubError(
      'HYGIENE_UNSCANNED',
      `${shown}之前的卫生检查没扫成：${binary.join('、') || '有一段'}的内容没扫到。没扫成一律不写`,
      { details: { binary, scanned: report.scanned.length, total: byPath.size } },
    );
  }
  const named: Finding[] = names.flatMap((n) =>
    valueHitsInName(n.name, matcher).map((hit) => ({ ...hit, path: `${n.label} ${hit.path}` })),
  );
  // 名字里的命中（line 0：文件名、分支名）排在前面
  const findings = [...applyAllowlist(named, ALLOWLIST, new Set()), ...report.findings].sort(
    (a, b) => Number(a.line > 0) - Number(b.line > 0),
  );
  if (findings.length === 0) return;
  const listed = findings.slice(0, MAX_LISTED).map(formatFinding);
  const more = findings.length > listed.length ? `；另有 ${findings.length - listed.length} 处` : '';
  const details = { findings: findings.map((f) => ({ path: f.path, line: f.line, rule: f.rule })) };
  if (findings.some((f) => f.line === 0)) {
    throw new GitHubError(
      'HYGIENE_NAME_BLOCKED',
      `${shown}被卫生检查拦下：名字里就有（${listed.join('；')}${more}）。名字是开工时按 issue 标题、子任务的 key 定下的，会话改不了，原样重试还是它`,
      { details },
    );
  }
  throw new GitHubError(
    'HYGIENE_BLOCKED',
    `${shown}被卫生检查拦下：查出 ${findings.length} 处（${listed.join('；')}${more}）。公开仓写上去就公开了，改掉再写`,
    { details },
  );
}
