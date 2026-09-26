// PR 标题、正文按内容扫：CI 专用（本地没有「PR 标题」这回事，pre-push、全仓扫都不管它）。复用全仓扫同一套规则
// （rules.ts）和已知敏感值名单（values.ts，经 hitsIn），标题、正文当两段独立的文本：不查文件名规则（没有文件名），
// 也不过 allowlist.ts——那份名单按文件路径配，管不到 PR 标题正文，误判要么改规则本身、要么改标题正文。
// 退出码和别的卫生检查一样：0 干净；1 查出了；2 没扫全（已知敏感值名单没读到）。
import type { CheckResult } from './check.ts';
import { formatFinding, hitsIn } from './scan.ts';
import type { LoadedValues } from './values.ts';

export interface CiTextInput {
  title: string;
  body: string;
  values: LoadedValues;
}

export function ciTextCheck(input: CiTextInput): CheckResult {
  const { title, body, values } = input;
  const pool = values.ok ? values.values : [];
  const findings = [
    ...hitsIn(title, pool).map((h) => ({ ...h, path: 'PR 标题' })),
    ...hitsIn(body, pool).map((h) => ({ ...h, path: 'PR 正文' })),
  ];
  const lines = [`卫生检查（PR 标题和正文）：查出 ${findings.length} 条`, ...findings.map(formatFinding)];
  if (findings.length > 0) {
    lines.push(
      'PR 标题、正文推上去也公开了：把命中的内容改掉（gh pr edit 或网页编辑），改完 CI 自己重跑；这里不设白名单。',
    );
  }
  if (!values.ok) {
    lines.push(`没扫全：${values.reason}。真实的组织编号、账号靠这份名单才认得出，名单没读到不算干净。`);
    return { code: 2, lines };
  }
  return { code: findings.length > 0 ? 1 : 0, lines };
}
