// 名册读成之后跟目录比基名（#1352）。只提醒：不改目录、不开路由、不起会话去试。
// Claude 订阅没有列模型的只读命令，不在这里补一次读取；别的渠道名册里出现 claude-* 时，正文写明怎么推断。
// 档位、fast、thinking 是同一家族的变体。读失败的渠道不进差集，也不能当成「没有新模型」。
// 撤只看目录里有没有这个基名，不看这一轮名册还列不列它：读失败的渠道没有名单，不能据此撤。
// 键上还带着方括号参数的旧提醒，基名对得上目录、或对得上这一轮要推的那条时撤掉，同一家族只留一条。

/** 跟 MODEL_ROSTER_CHANNELS 同一个先后，正文里渠道按这个排。 */
const CHANNEL_ORDER = ['mirasim', 'cursor', 'xai', 'claude-sub'] as const;

/**
 * 变体后缀，连同前面的连字符整段去掉，反复剥（thinking-high、fast-xhigh 都要剥干净）。
 * `-high` 对不上 `-xhigh` 的结尾，所以 xhigh 单独列。档位：low、medium、high、xhigh、max。
 */
const VARIANT_SUFFIXES = ['thinking', 'fast', 'xhigh', 'max', 'high', 'medium', 'low'] as const;

export const CATALOG_NEW_MODEL_PREFIX = 'catalog-new-model:';

/** 别的渠道名册里出现 claude-* 新基名时，原句加进通知正文。不在读取里起会话。 */
export const CLAUDE_SUB_INFERENCE =
  'Claude 订阅渠道读不了名册，按 Cursor/Mirasim 推断可能也有：补目录时给 claude-solo、claude-carpool 各加一条关着的路由，开之前用路由页「立即探测」验一次';

export interface CatalogNewModelAlert {
  key: string;
  level: 'decision';
  title: string;
  body: string;
}

export interface CatalogNewModelPlan {
  raise: CatalogNewModelAlert[];
  resolve: string[];
  /** 空串 = 这一轮没有读失败。有失败时照路由页 modelRosterUnavailable 的「渠道模型表没读成」写明哪家。 */
  unreadNote: string;
}

export type CatalogRosterResult =
  | { ok: true; channelId: string; models: readonly string[] }
  | { ok: false; channelId: string; error: { code: string; message: string } };

/**
 * 家族基名。先去掉方括号及里面的路由参数（context、effort、1m），再剥档位、fast、thinking。
 * 这些都是同一家族的写法，不另算一个模型。通知正文仍写各渠道的原始串。
 */
export function modelBaseName(raw: string): string {
  const trimmed = raw.trim();
  const bracket = trimmed.indexOf('[');
  let head = (bracket >= 0 ? trimmed.slice(0, bracket) : trimmed).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of VARIANT_SUFFIXES) {
      const mark = `-${suffix}`;
      if (head.endsWith(mark) && head.length > mark.length) {
        head = head.slice(0, -mark.length);
        changed = true;
        break;
      }
    }
  }
  return head;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (!t) return '没有写原因';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function unreadNote(failed: readonly Extract<CatalogRosterResult, { ok: false }>[]): string {
  if (failed.length === 0) return '';
  const parts = failed.map(
    (row) => `${row.channelId} 没读成（${clip(row.error.code, 80)}）：${clip(row.error.message, 1500)}`,
  );
  return `渠道模型表没读成：${parts.join('；')}。不参与差集，不能当成没有新模型。`;
}

function channelRank(channelId: string): number {
  for (let i = 0; i < CHANNEL_ORDER.length; i++) {
    if (CHANNEL_ORDER[i] === channelId) return i;
  }
  return CHANNEL_ORDER.length;
}

function bodyFor(base: string, channels: ReadonlyMap<string, ReadonlySet<string>>, note: string): string {
  const ids = [...channels.keys()].sort((a, b) => {
    const byRank = channelRank(a) - channelRank(b);
    if (byRank !== 0) return byRank;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const lines = ids.map((id) => `${id} 认：${[...(channels.get(id) ?? [])].sort().join('、')}`);
  if (base.startsWith('claude-')) lines.push(CLAUDE_SUB_INFERENCE);
  if (note) lines.push(note);
  return lines.join('\n');
}

/** 读成的渠道对目录做差集。同一个基名一条；目录里已有这个基名的不推，开着的那条撤掉。 */
export function planCatalogNewModelAlerts(input: {
  results: readonly CatalogRosterResult[];
  catalogStrings: readonly string[];
  openKeys: readonly string[];
}): CatalogNewModelPlan {
  const catalog = new Set<string>();
  for (const raw of input.catalogStrings) {
    const base = modelBaseName(raw);
    if (base) catalog.add(base);
  }
  const failed = input.results.filter((row): row is Extract<CatalogRosterResult, { ok: false }> => !row.ok);
  const note = unreadNote(failed);
  const seen = new Map<string, Map<string, Set<string>>>();
  for (const result of input.results) {
    if (!result.ok) continue;
    for (const raw of result.models) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const base = modelBaseName(trimmed);
      if (!base || catalog.has(base)) continue;
      let byChannel = seen.get(base);
      if (!byChannel) {
        byChannel = new Map();
        seen.set(base, byChannel);
      }
      let raws = byChannel.get(result.channelId);
      if (!raws) {
        raws = new Set();
        byChannel.set(result.channelId, raws);
      }
      raws.add(trimmed);
    }
  }
  const raise = [...seen.keys()].sort().map((base) => ({
    key: `${CATALOG_NEW_MODEL_PREFIX}${base}`,
    level: 'decision' as const,
    title: `目录里还没有 ${base}`,
    body: bodyFor(base, seen.get(base) ?? new Map(), note),
  }));
  const raising = new Set(raise.map((alert) => alert.key));
  const resolve: string[] = [];
  const resolveSeen = new Set<string>();
  for (const key of input.openKeys) {
    if (!key.startsWith(CATALOG_NEW_MODEL_PREFIX) || resolveSeen.has(key)) continue;
    const base = modelBaseName(key.slice(CATALOG_NEW_MODEL_PREFIX.length));
    if (!base) continue;
    const canonical = `${CATALOG_NEW_MODEL_PREFIX}${base}`;
    const inCatalog = catalog.has(base);
    // 旧键把方括号参数算进基名。这一轮已按去掉参数的基名另推一条时，把旧键撤掉。
    const replaced = raising.has(canonical) && key !== canonical;
    if (!inCatalog && !replaced) continue;
    resolveSeen.add(key);
    resolve.push(key);
  }
  resolve.sort();
  return { raise, resolve, unreadNote: note };
}
