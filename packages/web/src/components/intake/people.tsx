// 提需求页的头像（#2062）。规范没有「人员色」令牌、状态色只表达状态，所以只分两档：我＝品牌实心，别人＝中性描边；
// 再配名字里的一个字（中文名取最后一个字，英文取首字母）和每组消息上方的名字。指挥官、引擎是方形加图标（形状就和人不一样）。
import { Bot, Cog } from 'lucide-react';
import type { RequestPerson } from '../../api/types';
import { nameInitial } from '../../lib/format';
import { cn } from '../../lib/utils';

export type AvatarSize = 'sm' | 'md' | 'lg';
const dims: Record<AvatarSize, string> = {
  sm: 'size-5 text-meta',
  md: 'size-6 text-meta',
  lg: 'size-10 text-body',
};

export function PersonAvatar({
  person,
  me,
  size = 'md',
}: {
  person: RequestPerson;
  /** 是不是看的这个人自己（品牌色）。 */
  me: boolean;
  size?: AvatarSize;
}) {
  return (
    <span
      title={person.name}
      data-avatar={me ? 'me' : 'other'}
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-semibold',
        dims[size],
        me ? 'bg-brand text-brand-foreground' : 'border border-input bg-muted text-foreground',
      )}
    >
      {nameInitial(person.name)}
    </span>
  );
}

export function BotAvatar({ who, size = 'md' }: { who: 'commander' | 'engine'; size?: AvatarSize }) {
  const Icon = who === 'commander' ? Bot : Cog;
  return (
    <span
      title={who === 'commander' ? '指挥官' : '引擎'}
      className={cn('grid shrink-0 place-items-center rounded-md bg-accent text-foreground', dims[size])}
    >
      <Icon className={size === 'sm' ? 'size-3' : 'size-4'} aria-hidden />
    </span>
  );
}

/** 列表行的头像：发起人大头像，右下角叠第一个参与人的小头像（像微信群头像）。 */
export function ListAvatar({
  initiator,
  participants,
  meId,
}: {
  initiator: RequestPerson;
  participants: readonly RequestPerson[];
  meId: string | undefined;
}) {
  const other = participants[0];
  return (
    <span
      className="relative inline-flex shrink-0"
      title={`发起人 ${initiator.name}${participants.length ? `；参与 ${participants.map((p) => p.name).join('、')}` : ''}`}
    >
      <PersonAvatar person={initiator} me={initiator.id === meId} size="lg" />
      {other ? (
        <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-panel">
          <PersonAvatar person={other} me={other.id === meId} size="sm" />
        </span>
      ) : null}
    </span>
  );
}

/** 对话头部叠起来的参与人小头像。 */
export function Overlap({ people, meId }: { people: readonly RequestPerson[]; meId: string | undefined }) {
  return (
    <span
      className="inline-flex items-center -space-x-1.5"
      title={`参与：${people.map((p) => p.name).join('、')}`}
    >
      {people.map((p) => (
        <span key={p.id} className="rounded-full ring-2 ring-background">
          <PersonAvatar person={p} me={p.id === meId} size="sm" />
        </span>
      ))}
    </span>
  );
}
