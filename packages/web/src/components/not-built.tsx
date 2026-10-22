// 「待实现」占位：一块功能还没做（后端装配时给的 NotWired，和 /healthz 的「未接」同一个做法），整块换成它，
// 写明排在哪个阶段、哪张单。不许用「没查成」「离线」说还没做的东西——那两个词只留给真去读了、读失败的。

import type { NotWired } from '@fleet-dao/shared';
import { DraftingCompass } from 'lucide-react';
import { EmptyState } from './layout/empty-state';
import { Inset } from './layout/inset';
import { RepoLink } from './repo-link';

export function NotBuilt({ notWired, compact }: { notWired: NotWired; compact?: boolean }) {
  const label = `#${notWired.issue}`;
  return (
    <div role="note" data-not-built={notWired.issue}>
      <Inset look="dashed">
        <EmptyState
          size={compact ? 'inline' : 'section'}
          icon={DraftingCompass}
          title={`${notWired.what} · 待实现`}
          hint={
            <>
              这块还没做，排在 {notWired.phase} ·{' '}
              {notWired.issueRepo ? (
                <RepoLink repo={notWired.issueRepo} kind="issues" n={notWired.issue}>
                  {label}
                </RepoLink>
              ) : (
                <span className="num">{label}</span>
              )}
            </>
          }
        />
      </Inset>
    </div>
  );
}
