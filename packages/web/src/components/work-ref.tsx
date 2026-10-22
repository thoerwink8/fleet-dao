// 仓里的单、PR 的引用（「acme/orbit#17」「PR #16」）：品牌给了外链就是蓝色链接（新窗口、带外链小箭头），没给就是一段等宽文字。
// 通知中心的「谁在处理」和看门狗修复区共用；页面只拼 components/layout 的件。
import { TextLink } from './layout/link';
import { Text } from './layout/text';
import { repoHref } from './repo-link';

export function WorkRef({
  repo,
  kind,
  n,
  label,
}: {
  repo: { owner: string; name: string };
  kind: 'issues' | 'pull';
  n: number;
  label: string;
}) {
  const href = repoHref(repo, kind, n);
  return href ? (
    <TextLink href={href} mono>
      {label}
    </TextLink>
  ) : (
    <Text mono>{label}</Text>
  );
}
