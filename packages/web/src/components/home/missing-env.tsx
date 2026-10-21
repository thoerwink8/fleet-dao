// 选了远程环境、后端说没有这个环境（404）：主页和画布共用。
import { SearchX } from 'lucide-react';
import { Button } from '../layout/button';
import { EmptyState } from '../layout/empty-state';
import { Section } from '../layout/section';
import { Text } from '../layout/text';

/** 没有这个环境（后端 404）：写明，给回主页的路；不转圈、不给「重试」（重试也不会有）。 */
export function MissingEnv({ nodeId }: { nodeId: string }) {
  return (
    <Section>
      <div role="alert">
        <EmptyState
          icon={SearchX}
          title="没有这个环境"
          hint={
            <Text tone="muted">
              库里没有编号为「<Text mono>{nodeId}</Text>
              」的环境：可能链接里的编号写错了，或这个环境已经不在了。从顶栏的环境切换里重新选一台。
            </Text>
          }
          action={
            <Button size="sm" href="/">
              回主页
            </Button>
          }
        />
      </div>
    </Section>
  );
}
