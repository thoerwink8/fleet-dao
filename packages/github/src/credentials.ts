// 两个 GitHub App 的凭据：机器本地的 json（建 App 时 GitHub 回的那份，含 id、slug、pem），不进 git。
// 缺文件 = 这台机器没装（NOT_INSTALLED）；读不了 = 运行用户不对（CREDENTIALS_UNREADABLE）；缺字段、私钥坏了 = 配置错了（BAD_CONFIG）。
// 三种处置不同，别混成一种（windsurf-dao#573 ①）。报错里只写文件路径和缺哪个字段，绝不带文件内容。
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GitHubError } from './errors.ts';

/** agent = 「干活的」（只推分支、开 PR）；engine = 「引擎」（合并、改 issue、续互动限制）。 */
export type AppRole = 'agent' | 'engine';

export const ROLE_NAMES: Record<AppRole, string> = { agent: '「干活的」机器人', engine: '「引擎」机器人' };

export interface AppCredentials {
  role: AppRole;
  appId: number;
  /** JWT 的 iss 优先用它（官方推荐），没有才用 appId。 */
  clientId?: string | undefined;
  slug: string;
  privateKey: KeyObject;
  /** 凭据文件在哪；只给人看报错用。 */
  source: string;
}

export interface AppFiles {
  agent: string;
  engine: string;
}

export const DEFAULT_APP_DIR = '/etc/fleet-dao/github';

/** 凭据文件的位置：默认在 /etc/fleet-dao/github（root:fleet 640，只有引擎的运行用户读得到），环境变量可改。 */
export function appFilesFromEnv(env: Record<string, string | undefined> = process.env): AppFiles {
  const dir = (env.FLEET_GITHUB_APP_DIR || DEFAULT_APP_DIR).replace(/[\\/]+$/, '');
  return {
    agent: env.FLEET_GITHUB_AGENT_APP_FILE || `${dir}/gh-app-fleet-dao-agent.json`,
    engine: env.FLEET_GITHUB_ENGINE_APP_FILE || `${dir}/gh-app-fleet-dao-engine.json`,
  };
}

type ReadFile = (path: string) => string;
const readUtf8: ReadFile = (path) => readFileSync(path, 'utf8');

export function loadAppCredentials(role: AppRole, file: string, read: ReadFile = readUtf8): AppCredentials {
  const who = ROLE_NAMES[role];
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new GitHubError('NOT_INSTALLED', `这台机器没装${who}的凭据：${file} 不存在`, {
        details: { role, file },
      });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new GitHubError(
        'CREDENTIALS_UNREADABLE',
        `读不了${who}的凭据 ${file}（权限不够：只有引擎的运行用户读得到，别用 root 或会话身份跑）`,
        { details: { role, file } },
      );
    }
    throw new GitHubError('CREDENTIALS_UNREADABLE', `读${who}的凭据 ${file} 失败（${code ?? '未知错误'}）`, {
      details: { role, file },
    });
  }

  const bad = (what: string) =>
    new GitHubError('BAD_CONFIG', `${who}的凭据配置错了（${file}）：${what}`, { details: { role, file } });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad('不是合法的 JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw bad('顶层不是对象');
  const o = raw as Record<string, unknown>;

  const appId = Number(o.id ?? o.app_id);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw bad('缺 id（App 的数字编号）');
  const slug = o.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw bad('缺 slug（App 的短名）');
  const clientId = typeof o.client_id === 'string' && o.client_id ? o.client_id : undefined;

  let pem: string;
  if (typeof o.pem === 'string' && o.pem.trim()) {
    pem = o.pem;
  } else if (typeof o.private_key_path === 'string' && o.private_key_path) {
    try {
      pem = read(o.private_key_path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new GitHubError('NOT_INSTALLED', `这台机器没装${who}的私钥：${o.private_key_path} 不存在`, {
          details: { role, file: o.private_key_path },
        });
      }
      throw new GitHubError('CREDENTIALS_UNREADABLE', `读不了${who}的私钥 ${o.private_key_path}（${code}）`, {
        details: { role, file: o.private_key_path },
      });
    }
  } else {
    throw bad('缺私钥（pem 或 private_key_path）');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw bad('私钥不是合法的 PEM');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw bad('私钥不是 RSA（GitHub App 只签 RS256）');
  return { role, appId, clientId, slug, privateKey, source: file };
}

export function loadApps(
  files: AppFiles = appFilesFromEnv(),
  read?: ReadFile,
): Record<AppRole, AppCredentials> {
  return {
    agent: loadAppCredentials('agent', files.agent, read),
    engine: loadAppCredentials('engine', files.engine, read),
  };
}

/** 机器人在 GitHub 上的登录名（REST 写法）。 */
export function botLogin(app: Pick<AppCredentials, 'slug'>): string {
  return `${app.slug}[bot]`;
}

/**
 * 按「是不是这个机器人」认作者：REST 的 `<slug>[bot]`、gh 的 `app/<slug>`、GraphQL 的 `<slug>` 三种写法都认。
 * 有数字编号和类型时优先按它们认（编号不会被别人注册走）。
 */
export function isBot(
  app: Pick<AppCredentials, 'slug'>,
  user: { login?: string | null; id?: number | null; type?: string | null } | null | undefined,
  botUserId?: number,
): boolean {
  if (!user) return false;
  if (botUserId !== undefined && typeof user.id === 'number') return user.id === botUserId;
  if (user.type !== undefined && user.type !== null && user.type !== 'Bot') return false;
  const login = (user.login ?? '').toLowerCase();
  const slug = app.slug.toLowerCase();
  return login === `${slug}[bot]` || login === `app/${slug}` || login === slug;
}
