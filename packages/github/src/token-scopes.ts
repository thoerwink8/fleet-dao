// 安装令牌按用途降权：每次换令牌都在请求体里写明只要哪几项权限，令牌不再等于「App 被装上的全部授权」。
//
// 改这里之前必须知道：
// - 每一项都有依据（GitHub REST 文档里该接口要的权限）；拿不准的不缩。缩错的后果是线上对应的调用 403。
// - 只许往小里改：「引擎」的 administration:write 只有续互动限制要（interaction.ts），所以单独成 'admin'，
//   不和日常的 'api' 令牌混用；git 子进程拿到的令牌（'git' / 'git-read'）只有 contents，别的一概不带。
// - REQUIRED_PERMISSIONS（github.ts，自检用）由这里各用途的并集算出，两边不会漂；加新用途时先在这里写清依据。
import type { AppRole } from './credentials.ts';
import { GitHubError } from './errors.ts';

export type PermissionLevel = 'read' | 'write';
export type PermissionSet = Readonly<Record<string, PermissionLevel>>;

/**
 * api = 平时调 REST / GraphQL 的令牌（默认）；git = 交给 git 子进程推送的令牌；git-read = 只抓取的 git 令牌；
 * admin = 只有互动限制这类要 Administration 的接口用。
 */
export type TokenScope = 'api' | 'git' | 'git-read' | 'admin';

export const TOKEN_SCOPES: Record<AppRole, Partial<Record<TokenScope, PermissionSet>>> = {
  agent: {
    // 开 PR、找分支上的 PR、读 PR、读仓信息：pull_requests（写）+ metadata（读）；contents 只读是给读提交留的余量，不给写
    api: { contents: 'read', pull_requests: 'write', metadata: 'read' },
    // 推分支、并主线后推回：只要 contents 写
    git: { contents: 'write', metadata: 'read' },
    // 抓主线 / 分支头进镜像：只读
    'git-read': { contents: 'read', metadata: 'read' },
  },
  engine: {
    // 合并（contents + pull_requests 写）、改 issue / 里程碑 / 评论（issues 写）、读 CI（checks、actions 读）、
    // 贴「认领对得上」（statuses 写，#299）、读分支规则（只要 metadata，见 repos.ts）。没有 administration。
    api: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
      actions: 'read',
      statuses: 'write',
      metadata: 'read',
    },
    // 续互动限制（interaction.ts：GET/PUT interaction-limits）要 Administration 写
    admin: { administration: 'write', metadata: 'read' },
  },
};

const RANK: Record<PermissionLevel, number> = { read: 1, write: 2 };

/** 这个身份在这个用途下要哪几项权限；没定义的组合是写错了（不给「全部权限」兜底）。 */
export function scopePermissions(role: AppRole, scope: TokenScope): PermissionSet {
  const set = TOKEN_SCOPES[role][scope];
  if (!set)
    throw new GitHubError('BAD_INPUT', `${role} 没有「${scope}」这种令牌用途（token-scopes.ts 里没定义）`);
  return set;
}

/**
 * 只要装上的授权里有的：App 设置里还没勾（或还没接受）的那一项不请求，对应的调用照旧各自 403，
 * 不会因为请求了没授权的权限让整张令牌换不出来（GitHub 对这种请求回 422）。
 * granted 是 GitHub 回写的权限表；等级拿两边较低的（装的是 read 就别请求 write）。
 */
export function narrowToGranted(
  want: PermissionSet,
  granted: Readonly<Record<string, string>>,
): PermissionSet {
  const out: Record<string, PermissionLevel> = {};
  for (const [name, level] of Object.entries(want)) {
    const have = granted[name];
    if (have !== 'read' && have !== 'write') {
      if (have === 'admin') out[name] = level;
      continue;
    }
    out[name] = RANK[have] < RANK[level] ? have : level;
  }
  return out;
}

/** 一个身份各用途要的权限取并集（同一项取最高等级）：自检的「必须有」。 */
export function requiredPermissions(role: AppRole): Record<string, PermissionLevel> {
  const out: Record<string, PermissionLevel> = {};
  for (const set of Object.values(TOKEN_SCOPES[role])) {
    for (const [name, level] of Object.entries(set ?? {})) {
      const seen = out[name];
      if (seen === undefined || RANK[seen] < RANK[level]) out[name] = level;
    }
  }
  return out;
}
