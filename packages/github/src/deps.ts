// 包内共用的依赖与小工具：活动上下文、机器人身份（数字编号、提交身份）、锁。
import { z } from 'zod';
import type { GitHubClient, Logger, RepoRef } from './client.ts';
import { enc, unexpected } from './client.ts';
import { type AppRole, botLogin, isBot } from './credentials.ts';
import type { Ledger } from './ledger.ts';
import type { RepoFactsCache } from './repos.ts';

/** 和引擎的 PortContext 同形（取子集）：叫停信号、心跳、上一次尝试的心跳内容。 */
export interface ActivityContext {
  signal?: AbortSignal | undefined;
  heartbeat?: ((details?: unknown) => void) | undefined;
  lastHeartbeat?: unknown;
}

export interface Locker {
  /** 同一个键同时只让一个 fn 在跑（跨工人时用 pgLocker）。 */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function memoryLocker(): Locker {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async withLock(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const settled = run.catch(() => undefined);
      tails.set(key, settled);
      try {
        return await run;
      } finally {
        if (tails.get(key) === settled) tails.delete(key);
      }
    },
  };
}

const UserSchema = z.object({ login: z.string(), id: z.number(), type: z.string() });

export interface BotIdentity {
  login: string;
  userId: number;
  /** git 提交用的名字与邮箱：邮箱前缀是机器人的用户编号（不是 App 编号，拼错了提交挂不到机器人名下，A4）。 */
  name: string;
  email: string;
}

export class Bots {
  private readonly client: GitHubClient;
  private readonly ids = new Map<AppRole, number>();
  constructor(client: GitHubClient) {
    this.client = client;
  }

  /** 机器人账号的数字编号（GET /users/<slug>[bot]），缓存。 */
  async identity(role: AppRole, repo: RepoRef, signal?: AbortSignal): Promise<BotIdentity> {
    const app = this.client.apps[role];
    const login = botLogin(app);
    let id = this.ids.get(role);
    if (id === undefined) {
      const res = await this.client.request({
        method: 'GET',
        path: `/users/${enc(login)}`,
        auth: { as: role, repo },
        signal,
      });
      const parsed = UserSchema.safeParse(res.data);
      if (!parsed.success || parsed.data.type !== 'Bot') throw unexpected(`查 ${login} 的账号`, res.data);
      id = parsed.data.id;
      this.ids.set(role, id);
    }
    return { login, userId: id, name: login, email: `${id}+${login}@users.noreply.github.com` };
  }

  /** 这个 GitHub 用户是不是这个机器人（查过编号就按编号认）。 */
  is(
    role: AppRole,
    user: { login?: string | null; id?: number | null; type?: string | null } | null | undefined,
  ) {
    return isBot(this.client.apps[role], user, this.ids.get(role));
  }
}

export interface Deps {
  client: GitHubClient;
  facts: RepoFactsCache;
  ledger: Ledger;
  locker: Locker;
  bots: Bots;
  log: Logger;
  /** 防重复写的占用多久续一次（不给用默认 30 秒；测试调短）。 */
  leaseRenewMs?: number | undefined;
}
