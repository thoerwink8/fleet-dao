// 提需求页的小部件：头像（人员色）、参与人叠头像。
// 人员色：规范没有「人员色」令牌，七个状态色又只能表达状态，所以只用品牌色和中性色两档区分人，
// 再配头像上的首字母和每组消息上方的名字：cxy＝品牌实心，fxc188＝中性描边，指挥官＝方形加机器人图标（形状不同）。
import { Bot, Cog } from 'lucide-react';
import { cn } from '../../lib/utils';
import { type Human, PEOPLE, type Who } from './data';

export const personAvatar: Record<Human, string> = {
  cxy: 'bg-brand text-brand-foreground',
  fxc188: 'border border-input bg-muted text-foreground',
};
/** 我发的气泡底色（我在右边，只有一档）。 */
export const mineBubble = 'bg-selected';

export type AvatarSize = 'sm' | 'md' | 'lg';
const dims: Record<AvatarSize, string> = {
  sm: 'size-5 text-meta',
  md: 'size-6 text-meta',
  lg: 'size-10 text-body',
};

export function Avatar({ who, size = 'md' }: { who: Who | 'engine'; size?: AvatarSize }) {
  if (who === 'ai' || who === 'engine') {
    const Icon = who === 'ai' ? Bot : Cog;
    return (
      <span
        title={who === 'ai' ? '指挥官' : '引擎'}
        className={cn('grid shrink-0 place-items-center rounded-md bg-accent text-foreground', dims[size])}
      >
        <Icon className={size === 'sm' ? 'size-3' : 'size-4'} aria-hidden />
      </span>
    );
  }
  return (
    <span
      title={`${PEOPLE[who].name} · ${PEOPLE[who].role}`}
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-semibold uppercase',
        dims[size],
        personAvatar[who],
      )}
    >
      {who.slice(0, 1)}
    </span>
  );
}

/** 叠起来的小头像（对话头部的参与人）。 */
export function Overlap({ people }: { people: Human[] }) {
  return (
    <span className="inline-flex items-center -space-x-1.5" title={`参与：${people.join('、')}`}>
      {people.map((p) => (
        <span key={p} className="rounded-full ring-2 ring-panel">
          <Avatar who={p} size="sm" />
        </span>
      ))}
    </span>
  );
}

/** 列表行里的头像：发起人大头像，右下角叠一个参与人小角标（像微信群头像）。 */
export function ListAvatar({ initiator, participants }: { initiator: Human; participants: Human[] }) {
  const other = participants.find((p) => p !== initiator);
  return (
    <span
      className="relative inline-flex shrink-0"
      title={`发起人 ${initiator}；参与 ${participants.join('、')}`}
    >
      <Avatar who={initiator} size="lg" />
      {other ? (
        <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-panel">
          <Avatar who={other} size="sm" />
        </span>
      ) : null}
    </span>
  );
}
