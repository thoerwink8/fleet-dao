// 法国页「命令行工具」：目录、版本比较、发布源解析、把库里的读数现算成状态。
// 落后不入库。发布源没给版本列表时 releaseVersions 是 null，不许用只含最新版的单元素列表冒充。

export const CLI_SESSION_USERS = ['fleet-agent-carpool', 'pilot'] as const;
export type CliSessionUser = (typeof CLI_SESSION_USERS)[number];

export const CLI_USER_TOOLS = [
  { id: 'claude', name: 'Claude Code', release: 'npm', npm: '@anthropic-ai/claude-code' },
  { id: 'codex', name: 'Codex', release: 'npm', npm: '@openai/codex' },
  { id: 'grok', name: 'Grok', release: 'npm', npm: '@xai-official/grok' },
  { id: 'cursor-agent', name: 'Cursor Agent', release: 'cursor' },
  { id: 'reclaude', name: 'reclaude', release: 'reclaude' },
  { id: 'mirasim-server', name: 'Mirasim 服务端', release: 'mirasim' },
] as const;

/**
 * 每个用户上真装着哪些工具。pilot 是创始人登录用的系统用户，只装了 Claude Code、Codex、reclaude；Grok、Cursor Agent、
 * Mirasim 服务端从来没装在它家里，每小时探一遍只会得到「没有这个文件」——那是名单列错了，不是读失败（cli-versions 过去 30 天
 * 对 pilot 读 100% 失败的根子）。会话用户装全。名单只收真装着的：以后在 pilot 上装了新工具，来这里加一行。
 */
const CLI_TOOLS_ON_PILOT: readonly CliUserToolId[] = ['claude', 'codex', 'reclaude'];

export function cliUserToolsOf(user: CliSessionUser): readonly (typeof CLI_USER_TOOLS)[number][] {
  return user === 'pilot' ? CLI_USER_TOOLS.filter((t) => CLI_TOOLS_ON_PILOT.includes(t.id)) : CLI_USER_TOOLS;
}

export const CLI_NPM_TOOLS = [
  { id: 'kimi-code', name: 'Kimi', npm: '@moonshot-ai/kimi-code' },
  { id: 'dsh', name: 'DeepSeek dsh', npm: '@deepseek-ai/dsh' },
  { id: 'pi', name: 'pi', npm: '@earendil-works/pi-coding-agent' },
] as const;

export type CliUserToolId = (typeof CLI_USER_TOOLS)[number]['id'];
export type CliNpmToolId = (typeof CLI_NPM_TOOLS)[number]['id'];
export type CliToolId = CliUserToolId | CliNpmToolId;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** null = 正式版。日期版（年.月.日-hash）比较时丢掉 hash，这里也是 null。 */
  pre: string[] | null;
  /** major≥2000 且月、日合法：只比日期。 */
  date: boolean;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const date = major >= 2000 && minor >= 1 && minor <= 12 && patch >= 1 && patch <= 31;
  const pre = date || !m[4] ? null : m[4].split('.');
  return { major, minor, patch, pre, date };
}

function cmpNum(a: number, b: number): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 预发布：数字段小于非数字段；正式版大于任何预发布。 */
function cmpPre(a: string[] | null, b: string[] | null): -1 | 0 | 1 {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) {
      const c = cmpNum(Number(x), Number(y));
      if (c !== 0) return c;
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x < y) return -1;
    else if (x > y) return 1;
  }
  return 0;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const c = cmpNum(a.major, b.major) || cmpNum(a.minor, b.minor) || cmpNum(a.patch, b.patch);
  if (c !== 0) return c;
  if (a.date || b.date) return 0;
  return cmpPre(a.pre, b.pre);
}

/**
 * 比在用新、又不比官方最新新的正式版有几个。null = 源没给列表。
 * 日期版按日期去重。预发布、比 latest 还新的（alpha 渠道）不计入。
 */
export function countBehind(
  installed: ParsedVersion,
  latest: ParsedVersion,
  versions: readonly string[] | null,
): number | null {
  if (versions === null) return null;
  const seen = new Set<string>();
  let n = 0;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (!v) continue;
    if (v.pre !== null) continue;
    if (compareVersions(v, latest) > 0) continue;
    if (compareVersions(v, installed) <= 0) continue;
    const key = `${v.major}.${v.minor}.${v.patch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
  }
  return n;
}

export interface CliReadingInput {
  installedVersion: string | null;
  installedError: string | null;
  latestVersion: string | null;
  latestError: string | null;
  /** null = 发布源没给版本列表。不要用只含最新版的数组冒充。 */
  releaseVersions: readonly string[] | null;
}

export type CliToolStatus =
  | { kind: 'current' }
  | { kind: 'behind'; count: number }
  | { kind: 'behind-uncounted'; reason: string }
  | { kind: 'unread'; reason: string }
  | { kind: 'unreadable'; reason: string };

const NO_LIST = '发布源只给了最新版，没有版本列表，数不出落后几个';

/** 读的时候现算。reading 为 null = 从没读过，是没查成，不是读不到。 */
export function cliToolStatus(reading: CliReadingInput | null): CliToolStatus {
  if (!reading) return { kind: 'unreadable', reason: '还没读过' };
  if (reading.installedError) return { kind: 'unread', reason: reading.installedError };
  if (!reading.installedVersion) return { kind: 'unread', reason: '在用版本是空的' };
  if (reading.latestError) return { kind: 'unreadable', reason: reading.latestError };
  if (!reading.latestVersion) return { kind: 'unreadable', reason: '官方最新版是空的' };
  const installed = parseVersion(reading.installedVersion);
  const latest = parseVersion(reading.latestVersion);
  if (!installed) return { kind: 'unreadable', reason: `在用版本认不出：${reading.installedVersion}` };
  if (!latest) return { kind: 'unreadable', reason: `官方最新版认不出：${reading.latestVersion}` };
  const cmp = compareVersions(installed, latest);
  if (cmp === 0) return { kind: 'current' };
  if (cmp > 0) return { kind: 'unreadable', reason: '在用版本比发布源上的最新还新' };
  const count = countBehind(installed, latest, reading.releaseVersions);
  if (count === null) return { kind: 'behind-uncounted', reason: NO_LIST };
  if (count === 0)
    return { kind: 'behind-uncounted', reason: '版本列表里数不出比在用新、又不比官方最新新的正式版' };
  return { kind: 'behind', count };
}

export function cliStatusLabel(status: CliToolStatus): string {
  switch (status.kind) {
    case 'current':
      return '最新';
    case 'behind':
      return `落后 ${status.count} 个版本`;
    case 'behind-uncounted':
      return '落后（数不出几个）';
    case 'unread':
      return '读不到';
    case 'unreadable':
      return '没查成';
  }
}

export function parseInstalledOutput(tool: string, stdout: string): string | null {
  const text = stdout.trim();
  if (tool === 'grok') {
    const m =
      /^grok ([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._]+)?)(?: \([0-9a-f]+\))?(?:[ \t]+\[[A-Za-z0-9._-]+\])?$/m.exec(
        text,
      );
    return m?.[1] ?? null;
  }
  if (tool === 'cursor-agent') {
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^(\d{4}\.\d{2}\.\d{2}-[0-9A-Za-z]+)$/.exec(lines[i] ?? '');
      if (m?.[1]) return m[1];
    }
    return null;
  }
  if (tool === 'mirasim-server') {
    const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(text);
    return m?.[1] ?? null;
  }
  if (tool === 'codex') {
    const m = /codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/i.exec(text);
    return m?.[1] ?? null;
  }
  if (tool === 'reclaude') {
    // reclaude --version 打的是被包装的 Claude Code 版本（「2.1.308 (Claude Code)」），不是它自己的；目前没有任何经证实的
    // reclaude 自身版本输出格式，所以这里什么都不认：裸 semver、「reclaude x.y.z」之类没证实的写法一律当来源不明，
    // 等有了可信的只读来源（见 deploy/france/fleet-agent-scope.sh 的 probe_reclaude）再按证实的格式加。
    return null;
  }
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text);
  return m?.[1] ?? null;
}

export function parseNpmGlobal(
  jsonText: string,
  packageName: string,
): { version: string } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { error: '全局 npm 的清单不是 JSON' };
  }
  if (!data || typeof data !== 'object') return { error: '全局 npm 的清单认不出' };
  const deps = (data as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== 'object') return { error: `全局 npm 里没有 ${packageName}` };
  const pkg = (deps as Record<string, unknown>)[packageName];
  if (!pkg || typeof pkg !== 'object') return { error: `全局 npm 里没有 ${packageName}` };
  const version = (pkg as { version?: unknown }).version;
  if (typeof version !== 'string' || version.trim() === '') return { error: `${packageName} 的版本是空的` };
  return { version };
}

export function parseNpmRegistry(body: string): { latest: string; versions: string[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'npm 注册表的响应不是 JSON' };
  }
  if (!data || typeof data !== 'object') return { error: 'npm 注册表的响应认不出' };
  const tags = (data as { 'dist-tags'?: unknown })['dist-tags'];
  if (!tags || typeof tags !== 'object') return { error: 'npm 注册表没有渠道标签' };
  const latest = (tags as { latest?: unknown }).latest;
  if (typeof latest !== 'string' || latest.trim() === '') return { error: 'npm 注册表没有 latest 渠道标签' };
  const versionsObj = (data as { versions?: unknown }).versions;
  if (!versionsObj || typeof versionsObj !== 'object') return { error: 'npm 注册表没有版本列表' };
  const versions = Object.keys(versionsObj);
  if (versions.length === 0) return { error: 'npm 注册表的版本列表是空的' };
  return { latest, versions };
}

export function parseReclaudeStable(body: string): { latest: string; versions: null } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'reclaude 的 stable.json 不是 JSON' };
  }
  const version = data && typeof data === 'object' ? (data as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version.trim() === '')
    return { error: 'reclaude 的 stable.json 没有 version' };
  const cleaned = version.trim().replace(/^v/, '');
  if (!parseVersion(cleaned)) return { error: `reclaude 的版本认不出：${version}` };
  return { latest: cleaned, versions: null };
}

export function parseCursorChangelog(md: string): { latest: string; versions: string[] } | { error: string } {
  // 带 Accept: text/markdown 时是「## v2026.10.08」；不带时是 HTML 里的「v2026.10.08」。都按出现顺序，先出现的是最新。
  const found: string[] = [];
  for (const m of md.matchAll(/v(\d{4}\.\d{2}\.\d{2})\b/g)) {
    if (m[1] && !found.includes(m[1])) found.push(m[1]);
  }
  if (found.length === 0) return { error: 'Cursor 更新日志里没认出版本号' };
  return { latest: found[0] ?? '', versions: found };
}

export function parseCursorInstallScript(sh: string): { latest: string; versions: null } | { error: string } {
  // 安装脚本把版本写死在下载地址里（lab/2026.10.01-e373342），没有版本列表。
  const m = /(\d{4}\.\d{2}\.\d{2}-[0-9A-Za-z]+)/.exec(sh);
  if (!m?.[1]) return { error: 'Cursor 安装脚本里没认出版本号' };
  return { latest: m[1], versions: null };
}

export function resolveCursorRelease(
  changelog: { ok: true; body: string } | { ok: false; error: string },
  install: { ok: true; body: string } | { ok: false; error: string },
): { latest: string; versions: string[] | null } | { error: string } {
  const changelogError = changelog.ok ? null : changelog.error;
  let parsedLog: { latest: string; versions: string[] } | { error: string } | null = null;
  if (changelog.ok) {
    parsedLog = parseCursorChangelog(changelog.body);
    if (!('error' in parsedLog)) return parsedLog;
  }
  const logWhy = parsedLog && 'error' in parsedLog ? parsedLog.error : (changelogError ?? '更新日志没抓到');
  if (install.ok) {
    const inst = parseCursorInstallScript(install.body);
    if (!('error' in inst)) return inst;
    return { error: `更新日志：${logWhy}；安装脚本：${inst.error}` };
  }
  return { error: `更新日志：${logWhy}；安装脚本：${install.error}` };
}

/** latest.json 的顶层 version 是最新渠道。里面的 stable 是旧一档，不拿来当官方最新。这个文件不给历史列表。 */
export function parseMirasimLatest(body: string): { latest: string; versions: null } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Mirasim 的 latest.json 不是 JSON' };
  }
  const version = data && typeof data === 'object' ? (data as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version.trim() === '')
    return { error: 'Mirasim 的 latest.json 没有 version' };
  const cleaned = version.trim();
  if (!parseVersion(cleaned)) return { error: `Mirasim 的版本认不出：${version}` };
  return { latest: cleaned, versions: null };
}

export function parseMirasimChangelog(
  html: string,
): { latest: string; versions: string[] } | { error: string } {
  // 页面是 Version<span>0.0.479</span>，标签去掉才有空格。列表会跳号（0.0.479 下一条是 0.0.465），不能拿来当「落后几个」。
  const text = html.replace(/<[^>]+>/g, ' ');
  const set = new Set<string>();
  const re = /(?:Version|版本)\s+(\d+\.\d+\.\d+)/gi;
  for (const m of text.matchAll(re)) {
    if (m[1]) set.add(m[1]);
  }
  if (set.size === 0) return { error: '更新日志里没认出版本号' };
  const versions = [...set].sort((a, b) => {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return 0;
    return compareVersions(pb, pa);
  });
  const latest = versions[0];
  if (!latest) return { error: '更新日志里没认出版本号' };
  return { latest, versions };
}

export interface CliToolReading {
  scope: 'user' | 'npm';
  owner: string;
  tool: string;
  installedVersion: string | null;
  installedError: string | null;
  latestVersion: string | null;
  latestError: string | null;
  releaseVersions: readonly string[] | null;
  checkedAt: Date | string;
}

type Cell =
  | { state: 'ok'; version: string }
  | { state: 'unread'; why: string }
  | { state: 'unreadable'; why: string };

function installedCell(reading: CliToolReading | undefined): Cell {
  if (!reading) return { state: 'unreadable', why: '还没读过' };
  if (reading.installedError) return { state: 'unread', why: reading.installedError };
  if (reading.installedVersion) return { state: 'ok', version: reading.installedVersion };
  return { state: 'unread', why: '在用版本是空的' };
}

function latestCell(reading: CliToolReading | undefined): Cell {
  if (!reading) return { state: 'unreadable', why: '还没读过' };
  if (reading.latestError) return { state: 'unreadable', why: reading.latestError };
  if (reading.latestVersion) return { state: 'ok', version: reading.latestVersion };
  return { state: 'unreadable', why: '官方最新版是空的' };
}

function statusOf(reading: CliToolReading | undefined) {
  const status = cliToolStatus(
    reading
      ? {
          installedVersion: reading.installedVersion,
          installedError: reading.installedError,
          latestVersion: reading.latestVersion,
          latestError: reading.latestError,
          releaseVersions: reading.releaseVersions,
        }
      : null,
  );
  if (status.kind === 'behind') return { ...status, label: cliStatusLabel(status) };
  if (status.kind === 'behind-uncounted')
    return {
      kind: status.kind,
      reason: status.reason,
      label: cliStatusLabel(status) as '落后（数不出几个）',
    };
  if (status.kind === 'unread') return { kind: status.kind, reason: status.reason, label: '读不到' as const };
  if (status.kind === 'unreadable')
    return { kind: status.kind, reason: status.reason, label: '没查成' as const };
  return { kind: 'current' as const, label: '最新' as const };
}

function iso(at: Date | string): string {
  return typeof at === 'string' ? at : at.toISOString();
}

/** 按固定目录补齐。多出来的读数不另起行。落后在这里现算。 */
export function buildCliToolsResponse(readings: readonly CliToolReading[], asOf: Date | string) {
  const byKey = new Map(readings.map((r) => [`${r.scope}\t${r.owner}\t${r.tool}`, r]));
  const row = (scope: 'user' | 'npm', owner: string, tool: string, name: string) => {
    const reading = byKey.get(`${scope}\t${owner}\t${tool}`);
    return {
      scope,
      owner,
      tool,
      name,
      installed: installedCell(reading),
      latest: latestCell(reading),
      status: statusOf(reading),
      checkedAt: reading ? iso(reading.checkedAt) : null,
      upgrade: null as CliUpgradeStamp | null,
    };
  };
  return {
    state: 'ok' as const,
    upgradeNote: null as string | null,
    groups: [
      ...CLI_SESSION_USERS.map((user) => ({
        scope: 'user' as const,
        owner: user,
        title: user,
        rows: cliUserToolsOf(user).map((tool) => row('user', user, tool.id, tool.name)),
      })),
      {
        scope: 'npm' as const,
        owner: '',
        title: '全局 npm',
        rows: CLI_NPM_TOOLS.map((tool) => row('npm', '', tool.id, tool.name)),
      },
    ],
    asOf: iso(asOf),
  };
}

export const CLI_UPGRADE_OUTCOMES = ['ok', 'current', 'skipped', 'failed', 'rolled-back', 'refused'] as const;
export type CliUpgradeOutcome = (typeof CLI_UPGRADE_OUTCOMES)[number];

export interface CliUpgradeStamp {
  upgradedAt: string | null;
  outcome: CliUpgradeOutcome | null;
  version: string | null;
  detail: string;
}

/** 升级结果里的工具编号对到版本表的哪一行。没写的不挂。Claude、Codex 是全局二进制，两个用户都挂。 */
const UPGRADE_LINKS: Record<string, { tool: string; owners?: readonly string[] }> = {
  'claude-code': { tool: 'claude' },
  codex: { tool: 'codex' },
  grok: { tool: 'grok', owners: ['fleet-agent-carpool'] },
  'cursor-agent': { tool: 'cursor-agent', owners: ['fleet-agent-carpool'] },
  reclaude: { tool: 'reclaude', owners: ['fleet-agent-carpool'] },
};

export interface CliUpgradeAttachInput {
  state: 'ok' | 'unreadable';
  reason: string | null;
  tools: readonly {
    id: string;
    version: string | null;
    upgradedAt: string | null;
    outcome: CliUpgradeOutcome | null;
    detail: string;
  }[];
}

type UpgradeRow = { scope: 'user' | 'npm'; owner: string; tool: string; upgrade: CliUpgradeStamp | null };
type UpgradeView = {
  state: 'ok';
  upgradeNote: string | null;
  groups: { rows: UpgradeRow[]; scope: 'user' | 'npm'; owner: string }[];
};

/**
 * 把升级结果挂到版本表的对应行上。版本读数不动。
 * 升级结果认不出：upgradeNote 写原因，行上不挂，不当成还没升过。
 */
export function attachCliUpgrade<T extends UpgradeView>(view: T, upgrade: CliUpgradeAttachInput): T {
  if (upgrade.state === 'unreadable') {
    return { ...view, upgradeNote: upgrade.reason?.trim() || '升级结果读不到' };
  }
  const stamps = new Map<string, CliUpgradeStamp>();
  for (const tool of upgrade.tools) {
    if (!UPGRADE_LINKS[tool.id]) continue;
    stamps.set(tool.id, {
      upgradedAt: tool.upgradedAt,
      outcome: tool.outcome,
      version: tool.version,
      detail: tool.detail,
    });
  }
  return {
    ...view,
    upgradeNote: null,
    groups: view.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        if (row.scope !== 'user') return { ...row, upgrade: null };
        for (const [id, stamp] of stamps) {
          const link = UPGRADE_LINKS[id];
          if (!link || link.tool !== row.tool) continue;
          if (link.owners && !link.owners.includes(row.owner)) continue;
          return { ...row, upgrade: stamp };
        }
        return { ...row, upgrade: null };
      }),
    })),
  };
}
