// 驾驶舱导入仓库用的纯函数：解析 GitHub 的仓列表、从仓里的文件推出测试命令、拼授权地址、读令牌回应、决定怎么把 App 装到仓上。
// 不发请求。HTTP 在 user-github.ts。

export type OwnerKind = 'user' | 'org';

export interface ListedGithubRepo {
  id: number;
  owner: string;
  name: string;
  ownerKind: OwnerKind;
  accountId: number;
  /** 空字符串 = GitHub 没给默认分支，导入时要拒绝，不编一个 main。 */
  defaultBranch: string;
  canAdmin: boolean;
}

export type ParseOk<T> = { ok: true } & T;
export type ParseFail = { ok: false; reason: string };

export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountId: number;
  repositorySelection: 'all' | 'selected';
}

const RUNNER = /^(pnpm|npm|yarn|bun|make)(\s|$)/;
const PACKAGE_MANAGER = /^(pnpm|npm|yarn|bun)(?:@|$)/;
const LOCK_TO_PM: readonly [string, 'pnpm' | 'yarn' | 'npm' | 'bun'][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseRepoPage(body: unknown): ParseOk<{ repos: ListedGithubRepo[] }> | ParseFail {
  if (!Array.isArray(body)) return { ok: false, reason: '仓列表不是数组' };
  const repos: ListedGithubRepo[] = [];
  for (const item of body) {
    if (!isRecord(item)) continue;
    const id = positiveInt(item.id);
    const name = typeof item.name === 'string' ? item.name : '';
    const owner = isRecord(item.owner) ? item.owner : undefined;
    const login = owner && typeof owner.login === 'string' ? owner.login : '';
    const accountId = owner ? positiveInt(owner.id) : undefined;
    const kind = owner?.type === 'Organization' ? 'org' : owner?.type === 'User' ? 'user' : undefined;
    if (id === undefined || name === '' || login === '' || accountId === undefined || kind === undefined)
      continue;
    const branch = typeof item.default_branch === 'string' ? item.default_branch : '';
    const permissions = isRecord(item.permissions) ? item.permissions : undefined;
    repos.push({
      id,
      owner: login,
      name,
      ownerKind: kind,
      accountId,
      defaultBranch: branch,
      canAdmin: permissions?.admin === true,
    });
  }
  return { ok: true, repos };
}

function packageManagerOf(
  raw: unknown,
  names: readonly string[],
): 'pnpm' | 'npm' | 'yarn' | 'bun' | undefined {
  if (typeof raw === 'string') {
    const name = PACKAGE_MANAGER.exec(raw.trim())?.[1];
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name;
  }
  for (const [file, pm] of LOCK_TO_PM) {
    if (names.includes(file)) return pm;
  }
  return undefined;
}

function scriptOf(scripts: unknown, key: 'test' | 'check'): string | undefined {
  if (!isRecord(scripts)) return undefined;
  const value = scripts[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 从仓根的文件推出测试命令。有 package.json 就只看它，不退回 Makefile。认不出就不编一条 pnpm test。 */
export function testCommandFromRepo(input: {
  packageJson: string | null;
  names: readonly string[];
  makefile?: string | null;
}): { ok: true; command: string } | ParseFail {
  if (input.packageJson !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.packageJson);
    } catch {
      return { ok: false, reason: 'package.json 认不出' };
    }
    if (!isRecord(raw)) return { ok: false, reason: 'package.json 认不出' };
    const test = scriptOf(raw.scripts, 'test');
    const check = scriptOf(raw.scripts, 'check');
    const script = test ?? check;
    const which = test ? 'test' : 'check';
    if (!script) return { ok: false, reason: 'package.json 里没有 test 或 check 脚本' };
    const pm = packageManagerOf(raw.packageManager, input.names);
    if (pm) return { ok: true, command: `${pm} ${which}` };
    if (RUNNER.test(script)) return { ok: true, command: script };
    return { ok: false, reason: '认不出包管理器，不能编一条测试命令' };
  }
  if (input.makefile && /^test\s*:/m.test(input.makefile)) return { ok: true, command: 'make test' };
  return { ok: false, reason: '仓里没有能认出的测试命令' };
}

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('…');
  }
  return out;
}

export function parseAccessToken(
  body: unknown,
): { ok: true; accessToken: string; refreshToken?: string; expiresIn?: number } | ParseFail {
  if (!isRecord(body)) return { ok: false, reason: '令牌回应认不出' };
  const access = typeof body.access_token === 'string' ? body.access_token : '';
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  const secrets = [access, refresh].filter((s) => s.length > 0);
  if (typeof body.error === 'string' && body.error !== '') {
    const description = typeof body.error_description === 'string' ? body.error_description : body.error;
    const reason = scrub(description, secrets).trim();
    return { ok: false, reason: reason === '' ? '授权没换成令牌' : reason };
  }
  if (access === '') return { ok: false, reason: '令牌回应里没有访问令牌' };
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : undefined;
  return {
    ok: true,
    accessToken: access,
    ...(refresh === '' ? {} : { refreshToken: refresh }),
    ...(expiresIn === undefined ? {} : { expiresIn }),
  };
}

export function parseInstallationList(
  body: unknown,
): ParseOk<{ installations: UserInstallation[] }> | ParseFail {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.installations)
      ? body.installations
      : undefined;
  if (!list) return { ok: false, reason: '安装列表认不出' };
  const installations: UserInstallation[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = positiveInt(item.id);
    const account = isRecord(item.account) ? item.account : undefined;
    const login = account && typeof account.login === 'string' ? account.login : '';
    const accountId = account ? positiveInt(account.id) : undefined;
    const selection = item.repository_selection;
    if (selection !== 'all' && selection !== 'selected') {
      if (selection !== undefined) return { ok: false, reason: '认不出的安装范围' };
      continue;
    }
    if (id === undefined || login === '' || accountId === undefined) continue;
    installations.push({ id, accountLogin: login, accountId, repositorySelection: selection });
  }
  return { ok: true, installations };
}

export function installPlan(input: {
  slug: string;
  repo: { id: number; accountId: number; owner: string };
  installations: readonly UserInstallation[];
  state: string;
}):
  | { kind: 'put'; installationId: number }
  | { kind: 'covered'; installationId: number }
  | { kind: 'browser'; url: string } {
  const owner = input.repo.owner.toLowerCase();
  const hit = input.installations.find(
    (item) => item.accountId === input.repo.accountId || item.accountLogin.toLowerCase() === owner,
  );
  // 装了「全部仓」时这个仓已经在里面。对这种安装再 PUT 单个仓，GitHub 会拒。
  if (hit?.repositorySelection === 'all') return { kind: 'covered', installationId: hit.id };
  if (hit) return { kind: 'put', installationId: hit.id };
  const url = new URL(`https://github.com/apps/${input.slug}/installations/new/permissions`);
  url.searchParams.set('target_id', String(input.repo.accountId));
  url.searchParams.append('repository_ids[]', String(input.repo.id));
  url.searchParams.set('state', input.state);
  return { kind: 'browser', url: url.toString() };
}

/** 还没把这个 App 装到任何账号时，去 GitHub 的安装页让人自己选账号和仓。 */
export function newInstallationUrl(input: { slug: string; state: string }): string {
  const url = new URL(`https://github.com/apps/${input.slug}/installations/new`);
  url.searchParams.set('state', input.state);
  return url.toString();
}
