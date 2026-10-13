// 提需求页的小部件：头像（人员色）、参与人叠头像、需求卡。
// 人员色：规范没有「人员色」令牌，七个状态色又只能表达状态，所以只用品牌色和中性色两档区分人，
// 再配头像上的首字母和每条消息的名字：cxy＝品牌实心，fxc188＝中性描边，指挥官＝方形加图标（形状不同）。
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { StatusBadge } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { type Human, PEOPLE, type Req, statusView, type Who } from './data';

export const personAvatar: Record<Human, string> = {
  cxy: 'bg-brand text-brand-foreground',
  fxc188: 'border border-input bg-muted text-foreground',
};
/** 气泡底色，同样只用两档中性/选中色。 */
export const personBubble: Record<Human, string> = {
  cxy: 'bg-selected',
  fxc188: 'bg-muted',
};

export function Avatar({ who, size = 'md' }: { who: Who; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'size-5 text-meta' : 'size-7 text-meta';
  if (who === 'ai') {
    return (
      <span
        title="指挥官"
        className={cn('grid shrink-0 place-items-center rounded-md bg-accent text-foreground', dim)}
      >
        <Bot className={size === 'sm' ? 'size-3' : 'size-4'} aria-hidden />
      </span>
    );
  }
  return (
    <span
      title={`${PEOPLE[who].name} · ${PEOPLE[who].role}`}
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-semibold uppercase',
        dim,
        personAvatar[who],
      )}
    >
      {who.slice(0, 1)}
    </span>
  );
}

/** 发起人头像大一点，参与人小头像接在后面。 */
export function PeopleStack({ initiator, participants }: { initiator: Human; participants: Human[] }) {
  const others = participants.filter((p) => p !== initiator);
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`发起人 ${initiator}；参与 ${participants.join('、')}`}
    >
      <Avatar who={initiator} />
      {others.map((p) => (
        <Avatar key={p} who={p} size="sm" />
      ))}
    </span>
  );
}

/** 对话顶上固定的需求卡：需求号、标题、发起人、参与人、仓、状态、下一步轮到谁。compact 是手机版：两行。 */
export function RequestCard({
  req,
  action,
  lead,
  compact,
}: {
  req: Req;
  action?: ReactNode;
  lead?: ReactNode;
  compact?: boolean;
}) {
  const v = statusView(req.status, req.gh, req.issue);
  return (
    <div className={cn('border-b bg-panel px-4 py-2.5', compact && 'px-2 py-1.5')} data-intake-card>
      <div className="flex items-center gap-2">
        {lead}
        {compact ? null : <Tag mono>需求 {req.no}</Tag>}
        <h2 className="min-w-0 flex-1 truncate text-heading">{req.title}</h2>
        {action}
      </div>
      <div
        className={cn(
          'mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground',
          compact && 'px-2',
        )}
      >
        {compact ? <Tag mono>需求 {req.no}</Tag> : null}
        <StatusBadge tone={v.tone} label={v.label} variant="dot" />
        {req.waiting ? <span className="font-medium text-foreground">下一步：{req.waiting}</span> : null}
        {compact ? null : (
          <>
            <span className="inline-flex items-center gap-1.5">
              发起 <Avatar who={req.initiator} size="sm" />
              {req.initiator}
            </span>
            <span className="inline-flex items-center gap-1.5">
              参与
              {req.participants.map((p) => (
                <Avatar key={p} who={p} size="sm" />
              ))}
            </span>
            <span>{req.repo}</span>
          </>
        )}
        {req.issue ? <Tag mono>#{req.issue}</Tag> : null}
        {req.pr ? <Tag mono>PR #{req.pr}</Tag> : null}
        {req.parent ? <span>接着 需求 {req.parent} / #12</span> : null}
      </div>
    </div>
  );
}
