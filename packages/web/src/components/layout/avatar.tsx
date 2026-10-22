// 头像（提需求页用，样稿里的 `.avatar`）：圆形，字是名字里的一个字（中文取最后一个字，英文取首字母）。
// 只分两档：我＝品牌实色，别人＝灰底；指挥官、引擎是方形加图标（形状就和人不一样）。不收 className 和 style。
import { Bot, Cog } from 'lucide-react';
import { nameInitial } from '../../lib/format';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';

export type AvatarSize = 'sm' | 'md' | 'lg';
const DIMS: Record<AvatarSize, string> = {
  sm: 'size-5 text-meta',
  md: 'size-6 text-meta',
  lg: 'size-10 text-body',
};

export interface AvatarPerson {
  id: string;
  name: string;
}

export function Avatar({
  person,
  me,
  size = 'md',
}: {
  person: AvatarPerson;
  /** 是不是看的这个人自己。 */
  me: boolean;
  size?: AvatarSize;
}) {
  return (
    <span
      title={person.name}
      data-avatar={me ? 'me' : 'other'}
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-medium',
        DIMS[size],
        me ? 'bg-brand text-on-brand' : 'bg-fill-3 text-ink',
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
      className={cn('grid shrink-0 place-items-center rounded-sm bg-fill-2 text-ink', DIMS[size])}
    >
      <Icon className={size === 'sm' ? 'size-3' : 'size-4'} aria-hidden />
    </span>
  );
}

/** 列表行的头像：发起人大头像，右下角叠第一个参与人的小头像。 */
export function AvatarPair({
  main,
  extra,
  meId,
  title,
}: {
  main: AvatarPerson;
  extra?: AvatarPerson | undefined;
  meId: string | undefined;
  title?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0" {...(title ? { title } : {})}>
      <Avatar person={main} me={main.id === meId} size="lg" />
      {extra ? (
        <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-card">
          <Avatar person={extra} me={extra.id === meId} size="sm" />
        </span>
      ) : null}
    </span>
  );
}

/** 头部叠起来的几个小头像。 */
export function AvatarStack({
  people,
  meId,
  ...rest
}: {
  people: readonly AvatarPerson[];
  meId: string | undefined;
} & DataAttrs) {
  return (
    <span
      className="inline-flex items-center -space-x-1.5"
      title={`参与：${people.map((p) => p.name).join('、')}`}
      {...pickData(rest)}
    >
      {people.map((p) => (
        <span key={p.id} className="rounded-full ring-2 ring-card">
          <Avatar person={p} me={p.id === meId} size="sm" />
        </span>
      ))}
    </span>
  );
}
