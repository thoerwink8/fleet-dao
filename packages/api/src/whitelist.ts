// GitHub 作者白名单（design 第三节第 4 条：两位创始人、协作者、自家机器人）：由 users 表拼出来。
// 公开仓里陌生人也能开单、评论；设计删了「进门标签」，这道白名单就是唯一的门，所以在代码里强制，不靠互动限制。
import { z } from 'zod';
import type { Actor, User } from './ports.ts';

export const GhUser = z.object({ login: z.string(), id: z.number(), type: z.string() });
export type GhUser = z.infer<typeof GhUser>;

export interface GithubWhitelist {
  /** 有数字编号的人只按编号认。 */
  userIds: ReadonlySet<number>;
  /** 没登记数字编号的人才按登录名认（小写）。 */
  logins: ReadonlySet<string>;
  /** 自家机器人：只按数字编号认，且 type 必须是 Bot。 */
  botIds: ReadonlySet<number>;
}

export function githubWhitelist(users: User[]): GithubWhitelist {
  const userIds = new Set<number>();
  const logins = new Set<string>();
  const botIds = new Set<number>();
  for (const u of users) {
    if (!u.active) continue;
    if (u.role === 'bot') {
      if (u.githubId !== undefined) botIds.add(u.githubId);
    } else if (u.githubId !== undefined) {
      userIds.add(u.githubId);
    } else if (u.githubLogin) {
      logins.add(u.githubLogin.toLowerCase());
    }
  }
  return { userIds, logins, botIds };
}

export function isTrusted(user: GhUser | null | undefined, w: GithubWhitelist): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return w.botIds.has(user.id);
  if (user.type !== 'User') return false;
  return w.userIds.has(user.id) || w.logins.has(user.login.toLowerCase());
}

/** 这个 GitHub 用户是成员里的哪一位（认法和 isTrusted 一样）；不在白名单里是 null。 */
export function memberFor(users: User[], user: GhUser | null | undefined): User | null {
  if (!user) return null;
  const active = users.filter((u) => u.active);
  if (user.type === 'Bot') return active.find((u) => u.role === 'bot' && u.githubId === user.id) ?? null;
  if (user.type !== 'User') return null;
  const people = active.filter((u) => u.role !== 'bot');
  return (
    people.find((u) => u.githubId === user.id) ??
    people.find(
      (u) => u.githubId === undefined && u.githubLogin?.toLowerCase() === user.login.toLowerCase(),
    ) ??
    null
  );
}

/** 操作记录里的「谁做的」：人记成员编号；自家机器人记成引擎；认不出的（补收时看不到是谁）记成引擎的 github 入口。 */
export function actorFor(member: User | null): Actor {
  if (!member) return { kind: 'engine', id: 'github' };
  return member.role === 'bot' ? { kind: 'engine', id: member.id } : { kind: 'user', id: member.id };
}
