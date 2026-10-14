// 选了远程环境、后端说没有这个环境（404）：主页和画布共用。
import { SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '../layout/empty-state';
import { Section } from '../layout/section';
import { Button } from '../ui/button';

/** 没有这个环境（后端 404）：写明，给回主页的路；不转圈、不给「重试」（重试也不会有）。 */
export function MissingEnv({ nodeId }: { nodeId: string }) {
  return (
    <Section>
      <div role="alert">
        <EmptyState
          icon={SearchX}
          title="没有这个环境"
          hint={
            <>
              <span className="block">
                库里没有编号为「<span className="num">{nodeId}</span>
                」的环境：可能链接里的编号写错了，或这个环境已经不在了。
              </span>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/">回主页</Link>
              </Button>
            </>
          }
        />
      </div>
    </Section>
  );
}
