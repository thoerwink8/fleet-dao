// 各人自己的 GitHub 授权（#1989）：驾驶舱页面列出「我 GitHub 上能看到的仓」、把 App 装到某个仓，都要
// 用本人身份的 OAuth 用户令牌——App 机器人令牌看不到别人的个人仓，也调不了那两个「对本人安装」的接口。
//
// 改这里之前必须知道：
// - 一个人一行（user_id 唯一）：再授权就整行覆盖，不越积越多。
// - 只存密文：access_token_cipher 是 api 的 github-token.ts 用 FLEET_SESSION_SECRET 派生的密钥加密的
//   （v1.<iv>.<tag>.<密文>），明文只在内存里过一下、不落库不进日志。授权被 GitHub 撤了（401）就把这行删掉。
// - scope 记下 GitHub 回的那串（用来在页面上如实说明「只读还是能写」，不拿它当权限判断）。
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './ops.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const githubTokens = pgTable(
  'github_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** GitHub 那边的用户编号（授权时回写的 id）；换人登同一账号时对得上。 */
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    /** GitHub 的登录名（显示用，不拿它认身份）。 */
    login: text('login').notNull(),
    /** 密文，格式 v1.<iv>.<tag>.<密文>（base64url）。 */
    accessTokenCipher: text('access_token_cipher').notNull(),
    /** GitHub 回的 scope 原文（空格分隔）；只用于显示。 */
    scopes: text('scopes').notNull().default(''),
    /** 授权那一刻 GitHub 给的过期时刻；不过期的 classic PAT 这条路没有，写空。 */
    expiresAt: timestamp('expires_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz)
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('github_tokens_user_unique').on(t.userId),
    index('github_tokens_github_id_idx').on(t.githubId),
    check('github_tokens_cipher_not_empty', sql`length(${t.accessTokenCipher}) > 0`),
  ],
);
