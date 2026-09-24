// Claude 订阅（经 reclaude）：跑 Claude Code 自带的 /usage。
// /usage 在无头模式下是本地命令：不调模型、不花额度（实测 num_turns 0、cost 0），数据来自官方的 plan usage 接口，
// stream-json 里带一份结构化的 usage_report——服务端给几行就是几行，新出的窗口不用改代码就能收下。
// 只能读「这台机器当前挂的组织」：切号是整台机器的设置，读取器绝不切号。
import type { CommandResult, Reader, ReaderContext, ReaderOutput } from '../context.ts';
import { childEnv } from '../io.ts';
import type { ClaudeOrgKind, ClaudeUsageConfig, QuotaReading } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { isRecord, num, pruned, redact, toIso } from '../util.ts';
import { normalizeStatus, type WindowClass } from '../windows.ts';

const SOURCE = 'claude-usage';

export function usageArgs(): string[] {
  // --setting-sources project：不加载用户级设置，不跑用户的开机钩子；不能用 --bare（经 reclaude 会认证失败）。
  return ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '/usage'];
}

export interface OrgRow {
  kind: ClaudeOrgKind | null;
  current: boolean;
}

/**
 * 解析 `reclaude org list`：制表符分列，`*` 标当前组织，第三列类型 team = 拼车、personal = 独享。
 * 只留类型和是否当前——组织编号、名字、邮箱一律不往外带。认不出的类型记 null，不猜。
 */
export function parseOrgList(text: string): OrgRow[] {
  const rows: OrgRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\*?)\s*\d+\t(.*)$/.exec(line);
    if (!m) continue;
    const type = (m[2]?.split('\t')[1] ?? '').trim().toLowerCase();
    rows.push({
      kind: type === 'team' ? 'carpool' : type === 'personal' ? 'solo' : null,
      current: m[1] === '*',
    });
  }
  return rows;
}

const ORG_NAME: Record<ClaudeOrgKind, string> = { solo: '独享', carpool: '拼车' };

/** Claude 用量行的 kind → 窗口归类。按 kind 归，不按展示文字归（服务端原话：classify a row on this, never on a label）。 */
function classifyUsageRow(kind: string, scopeName: string | undefined): WindowClass {
  if (kind === 'session') return { window: '5h' };
  if (kind === 'weekly_all') return { window: '7d' };
  if (kind === 'weekly_scoped' && scopeName) return { window: '7d_model', scope: scopeName };
  return scopeName ? { window: 'other', scope: scopeName } : { window: 'other' };
}

function scopeNameOf(scope: unknown): string | undefined {
  if (!isRecord(scope)) return undefined;
  for (const key of ['model', 'surface']) {
    const part = scope[key];
    if (isRecord(part) && typeof part.display_name === 'string' && part.display_name.trim()) {
      const name = part.display_name.trim().toLowerCase();
      return key === 'model' ? name : `${key}:${name}`;
    }
  }
  return undefined;
}

/** 从 stream-json 输出里找 /usage 的结构化结果。找不到返回 undefined。 */
export function findUsageReport(stdout: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('usage_report')) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(t);
    } catch {
      continue;
    }
    if (isRecord(doc) && isRecord(doc.usage_report)) found = doc.usage_report;
  }
  return found;
}

/**
 * usage_report → 窗口读数。
 * rate_limits 为 null = CLI 没拿到（接口失败或令牌没有 profile 权限）→ 抛错，不当成「没有窗口」；
 * limits 为 [] = 服务端明说没有额度行 → 零个窗口，正常返回。
 */
export function readingsFromUsageReport(
  report: Record<string, unknown>,
  ctx: { poolId: string; readAt: string },
): ReaderOutput {
  const rateLimits = report.rate_limits;
  if (!isRecord(rateLimits)) {
    throw new QuotaReadError(
      'upstream',
      'Claude Code 没拿到套餐用量（usage 接口失败，或令牌缺 profile 权限）',
    );
  }
  const limits = rateLimits.limits;
  if (!Array.isArray(limits)) {
    throw new QuotaReadError('upstream', 'Claude Code 的用量结果里没有额度行（limits 为空值）');
  }
  const windows: QuotaReading[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const [i, row] of limits.entries()) {
    if (!isRecord(row) || typeof row.kind !== 'string' || !row.kind) {
      notes.push(`第 ${i + 1} 行额度认不出，没收`);
      continue;
    }
    const percent = num(row.percent);
    const scopeName = scopeNameOf(row.scope);
    const cls = classifyUsageRow(row.kind, scopeName);
    let label = scopeName ? `${row.kind}:${scopeName}` : row.kind;
    if (seen.has(label)) label = `${label}#${i + 1}`;
    seen.add(label);
    windows.push(
      pruned<QuotaReading>({
        poolId: ctx.poolId,
        window: cls.window,
        scope: cls.scope,
        label,
        unit: 'percent',
        used: percent,
        limit: percent === undefined ? undefined : 100,
        utilization: percent === undefined ? undefined : percent / 100,
        resetsAt: toIso(row.resets_at),
        ...normalizeStatus(row.severity),
        reading: 'measured',
        readAt: ctx.readAt,
        source: SOURCE,
      }),
    );
  }
  if (limits.length === 0) notes.push('服务端说这个组织没有额度行');

  const extra = rateLimits.extra_usage;
  if (isRecord(extra)) {
    const limit = num(extra.monthly_limit);
    const used = num(extra.used_credits);
    const currency = typeof extra.currency === 'string' ? extra.currency.toUpperCase() : undefined;
    if (extra.is_enabled === true && limit !== undefined && (currency === undefined || currency === 'USD')) {
      // 金额是最小货币单位（美分）。
      windows.push(
        pruned<QuotaReading>({
          poolId: ctx.poolId,
          window: 'month_usd',
          label: 'extra_usage',
          unit: 'usd',
          used: used === undefined ? undefined : used / 100,
          limit: limit / 100,
          utilization: num(extra.utilization),
          reading: 'measured',
          readAt: ctx.readAt,
          source: SOURCE,
        }),
      );
      notes.push('额外用量（超出套餐按量付费）开着：用满套餐后会继续花钱');
    } else if (extra.is_enabled === true) {
      notes.push(`额外用量开着，但上限或币种认不出（currency=${currency ?? '空'}）`);
    } else if (extra.is_enabled === false) {
      notes.push('额外用量没开：超出套餐不会自动扣钱');
    }
  }
  return { windows, notes };
}

function failureFromRun(what: string, run: CommandResult): QuotaReadError {
  if (run.spawnError) {
    const code = /ENOENT|not found/i.test(run.spawnError) ? 'config' : 'unreachable';
    return new QuotaReadError(code, `${what} 起不来：${redact(run.spawnError)}`);
  }
  if (run.killed) return new QuotaReadError('timeout', `${what} 超时被停`);
  const text = `${run.stderr}\n${run.stdout}`;
  if (/not logged in|device_revoked|unauthori[sz]ed|\b401\b|login required|invalid.*token/i.test(text)) {
    return new QuotaReadError('auth', `${what} 报登录失效：${redact(text)}`);
  }
  if (/account_banned|暂不可用|\b403\b/i.test(text)) {
    return new QuotaReadError('upstream', `${what} 报账号不可用（上游封号或组织失效）：${redact(text)}`);
  }
  // 退出 0 却没有结构化结果：多半是 Claude Code 太旧，/usage 还不带 usage_report（2.1.281 起有）。
  const hint = run.code === 0 ? '（没有结构化的 usage_report，Claude Code 可能太旧）' : '';
  return new QuotaReadError(
    'bad_response',
    `${what} 退出码 ${run.code ?? '空'}${hint}：${redact(text) || '没有输出'}`,
  );
}

/** 没配 cwd 就在一个新建的空目录里跑：在 /tmp 或家目录里起，会把那里的项目设置（含钩子）一起加载。 */
async function run(ctx: ReaderContext, pool: ClaudeUsageConfig, extraArgs: string[]): Promise<CommandResult> {
  const scratch = pool.cwd === undefined ? await ctx.scratchDir() : undefined;
  try {
    return await ctx.runCommand([...pool.command, ...extraArgs], {
      cwd: pool.cwd ?? scratch?.path ?? '.',
      env: childEnv(ctx.env, pool.env ?? {}),
      signal: ctx.signal,
    });
  } finally {
    await scratch?.dispose();
  }
}

export const readClaudeUsage: Reader = async (ctx) => {
  const pool = ctx.pool as ClaudeUsageConfig;
  // 同一条命令、同一目录、同一环境的池共用一次调用：两个组织只跑一次 org list、一次 /usage。
  const key = JSON.stringify([pool.command, pool.cwd ?? '', pool.env ?? {}]);
  const notes: string[] = [];

  if (pool.orgKind) {
    const orgRun = await ctx.shared(`claude-org:${key}`, () => run(ctx, pool, ['org', 'list']));
    if (orgRun.code !== 0) throw failureFromRun('reclaude org list', orgRun);
    const current = parseOrgList(orgRun.stdout).find((r) => r.current);
    if (!current) throw new QuotaReadError('bad_response', 'reclaude org list 里认不出当前组织');
    if (current.kind !== pool.orgKind) {
      const now = current.kind ? `${ORG_NAME[current.kind]}组织` : '认不出类型的组织';
      throw new QuotaReadError(
        'not_current',
        `这台机器当前挂的是${now}，读不到${ORG_NAME[pool.orgKind]}组织：额度只能读当前组织，切号会影响这台机器上所有会话，读取器不切号`,
      );
    }
    notes.push(`当前组织：${ORG_NAME[pool.orgKind]}`);
  }

  const usageRun = await ctx.shared(`claude-usage:${key}`, () => run(ctx, pool, usageArgs()));
  const report = findUsageReport(usageRun.stdout);
  if (!report) throw failureFromRun('Claude Code /usage', usageRun);
  const out = readingsFromUsageReport(report, { poolId: pool.poolId, readAt: ctx.fetchedAt });

  if (pool.orgKind) {
    // 读的这十来秒里组织被切走了，读数就不知道算谁的——作废，不记到错的池上。
    const after = await ctx.shared(`claude-org-after:${key}`, () => run(ctx, pool, ['org', 'list']));
    const still = after.code === 0 ? parseOrgList(after.stdout).find((r) => r.current) : undefined;
    if (still?.kind !== pool.orgKind) {
      throw new QuotaReadError('upstream', '读额度的过程中这台机器的组织变了（或核对不了），这次读数作废');
    }
  }
  return { windows: out.windows, notes: [...notes, ...(out.notes ?? [])] };
};
