// 卫生检查的白名单：每条只放行一种规则在一类文件里的命中，并写明为什么这不算泄漏。
// 一处都没用上的条目只提示、不判红（别的分支、以后的夹具可能还用得上），但该删的就删：白名单只许越来越短。
// match 里用 (?:…) 把原文拆开写，这个文件自己才不会被扫出来。
import type { RuleId } from './rules.ts';

export interface Allow {
  rule: RuleId;
  /** 相对仓库根的路径。 */
  path: RegExp;
  /** 只放行原文再对上这一条的命中；不写就是这类文件里这条规则的命中都放行。 */
  match?: RegExp;
  /** 为什么这不算泄漏。必填。 */
  reason: string;
}

export const ALLOWLIST: readonly Allow[] = [
  {
    rule: 'request-id',
    path: /^packages\/adapters\/test\/fixtures\/claude-code\//,
    reason:
      '插头真跑录下来的请求号：上游给每次请求起的一次性编号，不指向账号或机器（原 fixtures-clean 测试的约定）。',
  },
  {
    rule: 'request-id',
    path: /^packages\/jev\/exams\/error-route\.json$/,
    reason: '判断题考题里原样收的上游报错：请求号是上游给每次请求起的一次性编号，和插头夹具同一个约定。',
  },
];
