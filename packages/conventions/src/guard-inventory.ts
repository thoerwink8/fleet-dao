// 只读周报：文件数不等于逻辑护栏数；未知拦截次数不等于零，不作删除或准合裁决。
import type { RepoView } from './repo.ts';

export const GUARD_REGISTRY_PATH = 'packages/conventions/guards.json';
const ALARM_SOURCE = 'packages/engine/src/jobs/reconcile-checks.ts';
const KINDS = ['hook', 'workflow', 'alarm'] as const;
type InventoryKind = (typeof KINDS)[number];
export interface GuardEntry {
  id: string;
  kind: InventoryKind | 'command';
  path: string;
  evidence: string[];
  proposer: string;
  expires: string;
  keepIf: string;
  hitSource: string | null;
  outFor: string | null;
  whyNotRemove: string | null;
}
export interface GuardInventory {
  asOf: string | null;
  measuredAt: string;
  counts: Record<InventoryKind, { actual: number | null; registered: number | null; net: number | null }>;
  items: Record<InventoryKind, string[] | null>;
  entries: GuardEntry[];
  advisories: string[];
  problems: string[];
}

const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readRegistry(repo: RepoView, problems: string[]): { asOf: string; entries: GuardEntry[] } | null {
  try {
    const raw = repo.read(GUARD_REGISTRY_PATH);
    if (raw === undefined) throw new Error('读不到');
    const registry: unknown = JSON.parse(raw);
    if (!object(registry) || !date(registry.asOf) || !Array.isArray(registry.entries)) {
      throw new Error('缺少有效 asOf / entries');
    }
    const ids = new Set<string>();
    for (const [index, entry] of registry.entries.entries()) {
      if (
        !object(entry) ||
        !['hook', 'workflow', 'alarm', 'command'].includes(String(entry.kind)) ||
        !['id', 'path', 'proposer', 'keepIf'].every((key) => text(entry[key])) ||
        !date(entry.expires) ||
        !Array.isArray(entry.evidence) ||
        !entry.evidence.every(text) ||
        !['hitSource', 'outFor', 'whyNotRemove'].every((key) => nullableText(entry[key]))
      ) {
        throw new Error(`entries[${index}] 缺字段或字段格式错误`);
      }
      const id = String(entry.id);
      if (ids.has(id)) throw new Error(`重复 id：${id}`);
      ids.add(id);
    }
    return { asOf: registry.asOf, entries: registry.entries as GuardEntry[] };
  } catch (error) {
    problems.push(`${GUARD_REGISTRY_PATH} 没查成：${error instanceof Error ? error.message : '读取失败'}`);
    return null;
  }
}

function fileItems(repo: RepoView, dir: string, pattern: RegExp, problems: string[]): string[] | null {
  try {
    const names = repo.list(dir);
    if (names === undefined) throw new Error('列不出目录');
    return names
      .filter((name) => pattern.test(name) && !repo.isDir(`${dir}/${name}`))
      .map((name) => `${dir}/${name}`)
      .sort();
  } catch {
    problems.push(`${dir} 没查成：列不出顶层文件`);
    return null;
  }
}

function alarmItems(repo: RepoView, problems: string[]): string[] | null {
  try {
    const source = repo.read(ALARM_SOURCE);
    if (source === undefined) throw new Error('读不到源码');
    // 遮掉注释及字符串正文，保留引号，避免把注释/模板中的示例误数成声明。
    const code = source.replace(
      /'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      (token) => {
        const mask = (part: string) => part.replace(/[^\r\n]/g, ' ');
        return token.startsWith('/') ? mask(token) : token[0] + mask(token.slice(1, -1)) + token.at(-1);
      },
    );
    const declarations = [...code.matchAll(/^\s*(?:export\s+)?const\s+(\w+_ALERT_PREFIX)\s*=\s*([^;]+);/gm)];
    // 此口径只读完整 const literal 声明；不猜动态值、不把不支持的源码当零。
    const mentions = [...code.matchAll(/^\s*(?:export\s+)?const\s+(\w+_ALERT_PREFIX)\b/gm)];
    if (declarations.length !== mentions.length) throw new Error('有不支持的声明');
    for (const [, name, expression] of declarations) {
      if (!/^('[^'\\\r\n]*'|"[^"\\\r\n]*")$/.test(expression?.trim() ?? '')) {
        throw new Error(`${name} 不是支持的静态字符串`);
      }
    }
    return declarations.map(([, name]) => `${ALARM_SOURCE}#${name}`).sort();
  } catch (error) {
    problems.push(`${ALARM_SOURCE} 报警前缀没查成：${error instanceof Error ? error.message : '读取失败'}`);
    return null;
  }
}

export function collectGuardInventory(repo: RepoView, now: Date): GuardInventory {
  const problems: string[] = [];
  const advisories: string[] = [];
  const registry = readRegistry(repo, problems);
  const items = {
    hook: fileItems(repo, 'agents/hooks', /\.mjs$/, problems),
    workflow: fileItems(repo, '.github/workflows', /\.ya?ml$/, problems),
    alarm: alarmItems(repo, problems),
  };
  const counts = {} as GuardInventory['counts'];
  for (const kind of KINDS) {
    const actual = items[kind]?.length ?? null;
    const registered = registry?.entries.filter((entry) => entry.kind === kind).length ?? null;
    counts[kind] = {
      actual,
      registered,
      net: actual === null || registered === null ? null : actual - registered,
    };
    if (registry && items[kind]) {
      const paths = new Set(
        registry.entries.filter((entry) => entry.kind === kind).map((entry) => entry.path),
      );
      const unregistered = items[kind]?.filter((path) => !paths.has(path)).length ?? 0;
      if (unregistered) advisories.push(`${kind} 有 ${unregistered} 个当前文件/前缀未登记（只告知）`);
    }
  }
  const entries = registry?.entries ?? [];
  const warn = (label: string, selected: GuardEntry[]) => {
    if (selected.length) advisories.push(`${label}：${selected.length} 条（只告知，不自动删除或拦 PR）`);
  };
  warn(
    'evidence 缺真实证据，存量未自证',
    entries.filter(
      (entry) => !entry.evidence.length || entry.evidence.every((evidence) => evidence === '存量未自证'),
    ),
  );
  warn(
    'proposer unknown，无法归因',
    entries.filter((entry) => entry.proposer === 'unknown'),
  );
  warn(
    'hitSource 未接，拦截次数未知，不能当 0',
    entries.filter((entry) => entry.hitSource === null),
  );
  warn(
    '未记录一进一出或保留理由',
    entries.filter((entry) => !entry.outFor && !entry.whyNotRemove),
  );
  if (registry) {
    warn(
      'expires 超出登记日起 30 天或早于登记日',
      entries.filter((entry) => {
        const days = (Date.parse(entry.expires) - Date.parse(registry.asOf)) / 86_400_000;
        return days < 0 || days > 30;
      }),
    );
  }
  const validNow = Number.isFinite(now.getTime());
  if (!validNow) problems.push('当前时间没查成：无效 Date');
  else
    warn(
      '已到期，待复审（未读取拦截次数）',
      entries.filter((entry) => Date.parse(entry.expires) <= now.getTime()),
    );
  return {
    asOf: registry?.asOf ?? null,
    measuredAt: validNow ? now.toISOString() : 'unknown',
    counts,
    items,
    entries,
    advisories,
    problems,
  };
}

export function renderGuardInventory(report: GuardInventory): string {
  const n = (value: number | null) => (value === null ? 'unknown' : String(value));
  const counts = KINDS.map((kind) => {
    const count = report.counts[kind];
    const net = count.net === null ? 'unknown' : `${count.net >= 0 ? '+' : ''}${count.net}`;
    return `${kind} ${n(count.actual)}（登记 ${n(count.registered)}，净变 ${net}）`;
  });
  return [
    `护栏库存 ${report.measuredAt}：${counts.join('；')}。`,
    `净变相对登记基线 ${report.asOf ?? 'unknown'}，不是滚动一周；hooks/workflows 为顶层文件数，alarm 仅 reconcile-checks.ts 的静态 *_ALERT_PREFIX 声明数；command 未扫描。`,
    ...report.advisories,
    ...report.problems.map((problem) => `没查成：${problem}`),
  ].join('\n');
}
