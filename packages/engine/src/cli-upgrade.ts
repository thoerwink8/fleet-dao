// 法国命令行工具的升级（#1971）：空闲或发版重启窗口里换二进制，核对版本、跑一次极小冒烟，不过就装回上一版。
// 这一份不连网、不写文件：渠道、空闲、要不要再试、一轮怎么升，都在这里。真去装的是 cli-upgrade-main.ts（root），
// 引擎只在空闲时写请求（jobs/cli-upgrade.ts）。
// 改这里之前必须知道：
// - 运行中的会话会从磁盘再读可执行文件，原地替换会让它崩。sessions() > 0 就整轮拒绝，不设失败（下一轮空闲再试）。
// - 没写渠道、渠道认不出、latest 未满天数、查不到发布时间：这一轮跳过，不当成失败，不锁死。
// - 装上去核对或冒烟不过：装回上一版，并记 failure。有 failure 的工具不再装第二次，等人把状态文件里的 failure 删掉。
// - Grok 的官方指针只有版本号、没有发布时间。latest+Nd 用「这台机器第一次看见这个版本」计满 N 天，不拿猜的时间当发布日。
//   渠道写成 latest（不带天数）就这次升。
// - 冒烟只跑本地的 --help，不调模型。

export const CLI_UPGRADE_DIR = '/var/lib/fleet-dao/cli-upgrade';
export const CLI_UPGRADE_STATE_NAME = 'state.json';
export const CLI_UPGRADE_REQUEST_NAME = 'request.json';
export const CLI_UPGRADE_WANTED_NAME = 'wanted.json';
/** 请求写下这么久单元还没写回结果：撤掉排空，不再等（单元自己的时限更短，到这儿它已经被停掉）。 */
export const CLI_UPGRADE_STUCK_MS = 45 * 60_000;
/** 排空窗口：盖住单元时限，到点也不停会话（drain-control 对这个来源不叫停）。 */
export const CLI_UPGRADE_CORDON_MS = 50 * 60_000;
/** 核对过且没有要装的，这么久内不再为了升级排空。 */
export const CLI_UPGRADE_QUIET_MS = 6 * 60 * 60_000;
/** 空闲看拉单：这一小时里的 schedule_runs。 */
export const CLI_IDLE_WINDOW_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type UpgradeOutcome = 'ok' | 'current' | 'skipped' | 'failed' | 'rolled-back' | 'refused';

export interface CliToolSpec {
  id: string;
  name: string;
  /** null = 没写或认不出，这一轮不升。 */
  via: 'npm' | 'self-update' | 'tar' | null;
  version?: string;
  packageName?: string;
  bin?: string;
  user?: string;
  /** npm 装到哪个 prefix。没写就是 /usr（二进制在 /usr/bin，模块在 /usr/lib/node_modules）。 */
  prefix?: string;
  /** 原始渠道。空、没有、认不出都不升。 */
  channel?: string;
}

export interface ToolRecord {
  name: string;
  version: string | null;
  upgradedAt: string | null;
  channel: string | null;
  outcome: UpgradeOutcome;
  detail: string;
  /** 在就不再装第二次。会话还在跑的拒绝不写它。 */
  failure?: { at: string; reason: string };
}

export interface UpgradeState {
  schema: 1;
  /** 这份结果对应的请求时刻；发版窗口没有请求，是 null。 */
  at: string | null;
  checkedAt: string;
  why: 'idle' | 'release';
  tools: Record<string, ToolRecord>;
  /** 没有发布时间的工具：第一次看见这个版本的时刻。 */
  seen?: Record<string, { version: string; since: string }>;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface TarInstallResult extends ProcResult {
  /** 未切换：会话出现或排空状态未知；下次空闲可以重试。 */
  refused?: true;
}

export interface UpgradeIo {
  now(): Date;
  /** 固定版本 Go：完整暂存、验真、原子切换，失败保留原入口。 */
  installTar?(spec: CliToolSpec): Promise<TarInstallResult>;
  /** 大于 0 就不许换二进制（含排空状态读不到）。升级过程中会再问。 */
  sessions(): number | Promise<number>;
  /** `pkg@stable` / `pkg@latest` → 版本号。查不到抛错。 */
  npmVersion(spec: string): Promise<string>;
  /** 这个精确版本的发布时间。没有就是 null。 */
  npmPublishedAt(pkg: string, version: string): Promise<Date | null>;
  /** spec 是 `包名@版本`。prefix 是 npm --prefix（全局装在 /usr）。 */
  npmInstall(spec: string, prefix: string): Promise<ProcResult>;
  npmUninstall(pkg: string, prefix: string): Promise<ProcResult>;
  /** 官方指针上的版本。没有就是 null。 */
  grokLatestVersion(): Promise<string | null>;
  versionOf(spec: CliToolSpec): Promise<ProcResult>;
  smoke(spec: CliToolSpec): Promise<ProcResult>;
  /** 会话用户家里的二进制自己更新（grok update）。 */
  installSelf(spec: CliToolSpec): Promise<ProcResult>;
  /** 没有旧文件就 null。 */
  backup(spec: CliToolSpec): Promise<{ id: string } | null>;
  restore(spec: CliToolSpec, backup: { id: string } | null): Promise<ProcResult>;
}

export type Channel = { kind: 'stable' } | { kind: 'latest'; minAgeDays: number };

const LATEST_AGE = /^latest\+(\d+)d$/;

/** npm 全局装在这个 prefix。期望里没写就用 /usr，和 9 月 root 的 `npm i -g` 同一处。 */
export function npmPrefixOf(spec: CliToolSpec): string {
  const prefix = spec.prefix?.trim();
  return prefix ? prefix : '/usr';
}

/** stable、latest、latest+Nd。空的和认不出的返回 null（不升）。 */
export function parseChannel(raw: string | null | undefined): Channel | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (text === 'stable') return { kind: 'stable' };
  if (text === 'latest') return { kind: 'latest', minAgeDays: 0 };
  const match = LATEST_AGE.exec(text);
  if (!match || match[1] === undefined) return null;
  return { kind: 'latest', minAgeDays: Number(match[1]) };
}

export function versionMatches(output: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9A-Za-z.])${escaped}(?=$|[^0-9A-Za-z.])`).test(output);
}

export function semverOf(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(output);
  return match?.[1] ?? null;
}

/**
 * 空闲：没有在跑的会话，并且这一小时拉单没有发现候选。
 * 总开关关着（拉单停）时，没有「发现过候选」就算空闲。
 * 总开关开着时，还要这一小时里至少有一轮拉单、而且每一轮 found 都是 0——一轮都没有，不能把「还没看」当成「没有候选」。
 */
export function isIdle(input: {
  inFlight: number;
  masterOn: boolean;
  intakeFound: readonly (number | null)[];
}): boolean {
  if (input.inFlight > 0) return false;
  if (input.intakeFound.some((n) => n !== null && n > 0)) return false;
  if (!input.masterOn) return true;
  if (input.intakeFound.length === 0) return false;
  return input.intakeFound.every((n) => n === 0);
}

export interface TickInput {
  now: Date;
  inFlight: number;
  masterOn: boolean;
  intakeFound: readonly (number | null)[];
  /** 引擎此刻的排空。没有就是 null。 */
  cordon: { source: string; since: string } | null;
  /** 引擎写下、单元还没回报的那一次（wanted.json 的 at）。没有就是 null。 */
  pendingAt: string | null;
  state: UpgradeState | null;
}

export type TickDecision =
  | { kind: 'wait'; why: string }
  | { kind: 'hold'; why: string }
  | { kind: 'request'; at: string; until: string }
  | { kind: 'finish' }
  | { kind: 'stuck' };

function hasFailure(state: UpgradeState | null): boolean {
  if (!state) return false;
  return Object.values(state.tools).some((tool) => tool.failure !== undefined);
}

function settled(state: UpgradeState | null, now: Date): boolean {
  if (!state?.checkedAt) return false;
  const at = Date.parse(state.checkedAt);
  if (Number.isNaN(at) || now.getTime() - at >= CLI_UPGRADE_QUIET_MS) return false;
  const tools = Object.values(state.tools);
  if (tools.length === 0) return false;
  return tools.every(
    (tool) =>
      !tool.failure && (tool.outcome === 'ok' || tool.outcome === 'current' || tool.outcome === 'skipped'),
  );
}

/** 这一轮引擎要不要写请求、撤排空，还是继续等。不碰文件。 */
export function decide(input: TickInput): TickDecision {
  const nowMs = input.now.getTime();
  const ours = input.cordon?.source === 'cli-upgrade' ? input.cordon : null;
  if (ours) {
    const since = Date.parse(ours.since);
    const checked = input.state?.checkedAt ? Date.parse(input.state.checkedAt) : Number.NaN;
    const reported =
      input.state != null &&
      !Number.isNaN(checked) &&
      checked >= since &&
      input.pendingAt != null &&
      input.state.at === input.pendingAt;
    if (reported) return { kind: 'finish' };
    const pending = input.pendingAt ? Date.parse(input.pendingAt) : Number.NaN;
    if (!Number.isNaN(pending) && nowMs - pending >= CLI_UPGRADE_STUCK_MS) return { kind: 'stuck' };
    return { kind: 'hold', why: '升级请求已写下，等 root 单元回报' };
  }
  if (input.cordon) return { kind: 'wait', why: '发布或停机在排空，这轮不另起升级' };
  // 排空丢了（引擎重启没挂回去）但请求还在：结果对上就收尾，太久就当单元没来，否则不另写一份。
  if (input.pendingAt) {
    const checked = input.state?.checkedAt ? Date.parse(input.state.checkedAt) : Number.NaN;
    if (input.state != null && input.state.at === input.pendingAt && !Number.isNaN(checked)) {
      return { kind: 'finish' };
    }
    const pending = Date.parse(input.pendingAt);
    if (!Number.isNaN(pending) && nowMs - pending >= CLI_UPGRADE_STUCK_MS) return { kind: 'stuck' };
    return { kind: 'hold', why: '升级请求还在，等 root 单元回报' };
  }
  if (hasFailure(input.state)) return { kind: 'wait', why: '有工具上次升级没成，不再重试' };
  if (!isIdle({ inFlight: input.inFlight, masterOn: input.masterOn, intakeFound: input.intakeFound })) {
    return {
      kind: 'wait',
      why: '不空闲：有会话在跑，或这一小时拉单发现过候选，或总开关开着却没有一轮拉单证明没有候选',
    };
  }
  if (settled(input.state, input.now)) return { kind: 'wait', why: '刚核对过，6 小时内不重复排空' };
  return {
    kind: 'request',
    at: input.now.toISOString(),
    until: new Date(nowMs + CLI_UPGRADE_CORDON_MS).toISOString(),
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '（没有输出）';
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function record(
  spec: CliToolSpec,
  outcome: UpgradeOutcome,
  detail: string,
  extra: Partial<ToolRecord> = {},
): ToolRecord {
  return {
    name: spec.name,
    version: extra.version ?? null,
    upgradedAt: extra.upgradedAt ?? null,
    channel: spec.channel?.trim() || null,
    outcome,
    detail,
    ...(extra.failure ? { failure: extra.failure } : {}),
  };
}

function kept(
  previous: ToolRecord | undefined,
  version: string | null,
  at: string | null,
): Partial<ToolRecord> {
  return { version: version ?? previous?.version ?? null, upgradedAt: previous?.upgradedAt ?? at };
}

interface Resolved {
  version: string | null;
  skip?: string;
}

async function resolveTarget(
  spec: CliToolSpec,
  channel: Channel,
  io: UpgradeIo,
  seen: { version: string; since: string } | undefined,
  now: Date,
): Promise<{ resolved: Resolved; seen?: { version: string; since: string } }> {
  if (spec.via === 'npm') {
    if (!spec.packageName) return { resolved: { version: null, skip: '没写 npm 包名，不升' } };
    const specText = channel.kind === 'stable' ? `${spec.packageName}@stable` : `${spec.packageName}@latest`;
    let version: string;
    try {
      version = (await io.npmVersion(specText)).trim();
    } catch (err) {
      return {
        resolved: {
          version: null,
          skip: `查不到目标版本：${clip(err instanceof Error ? err.message : String(err))}`,
        },
      };
    }
    if (!semverOf(version)) return { resolved: { version: null, skip: `目标版本认不出：${clip(version)}` } };
    if (channel.kind === 'latest' && channel.minAgeDays > 0) {
      let published: Date | null;
      try {
        published = await io.npmPublishedAt(spec.packageName, version);
      } catch (err) {
        return {
          resolved: {
            version: null,
            skip: `查不到发布时间：${clip(err instanceof Error ? err.message : String(err))}`,
          },
        };
      }
      if (!published || Number.isNaN(published.getTime())) {
        return { resolved: { version: null, skip: `${version} 没有发布时间，这轮不升` } };
      }
      const age = now.getTime() - published.getTime();
      if (age < channel.minAgeDays * DAY_MS) {
        return {
          resolved: { version: null, skip: `${version} 发布未满 ${channel.minAgeDays} 天，这轮不升` },
        };
      }
    }
    return { resolved: { version } };
  }
  if (spec.via === 'self-update') {
    let version: string | null;
    try {
      version = await io.grokLatestVersion();
    } catch (err) {
      return {
        resolved: {
          version: null,
          skip: `查不到目标版本：${clip(err instanceof Error ? err.message : String(err))}`,
        },
      };
    }
    if (!version || !semverOf(version))
      return { resolved: { version: null, skip: '官方指针没有可用的版本，这轮不升' } };
    const minAge = channel.kind === 'latest' ? channel.minAgeDays : 0;
    if (minAge <= 0)
      return {
        resolved: { version },
        seen: seen?.version === version ? seen : { version, since: now.toISOString() },
      };
    if (!seen || seen.version !== version || Number.isNaN(Date.parse(seen.since))) {
      return {
        resolved: {
          version: null,
          skip: `第一次看见 ${version}，满 ${minAge} 天再升（官方指针没有发布时间）`,
        },
        seen: { version, since: now.toISOString() },
      };
    }
    const age = now.getTime() - Date.parse(seen.since);
    if (age < minAge * DAY_MS) {
      return {
        resolved: {
          version: null,
          skip: `${version} 看见了 ${Math.floor(age / DAY_MS)} 天，未满 ${minAge} 天`,
        },
        seen,
      };
    }
    return { resolved: { version }, seen };
  }
  return { resolved: { version: null, skip: '没写安装方式，不升' } };
}

async function rollback(
  spec: CliToolSpec,
  io: UpgradeIo,
  previousVersion: string | null,
  backup: { id: string } | null,
): Promise<string | null> {
  if (spec.via === 'npm') {
    if (!spec.packageName) return '没有包名，退不回去';
    const proc = previousVersion
      ? await io.npmInstall(`${spec.packageName}@${previousVersion}`, npmPrefixOf(spec))
      : await io.npmUninstall(spec.packageName, npmPrefixOf(spec));
    if (proc.code !== 0) return `退回失败：${clip(proc.stderr || proc.stdout)}`;
    const again = await io.versionOf(spec);
    if (previousVersion) {
      if (!versionMatches(again.stdout, previousVersion)) return `退回后版本不是 ${previousVersion}`;
      return null;
    }
    if (again.code === 0 && semverOf(again.stdout)) return '卸掉以后命令还在';
    return null;
  }
  const proc = await io.restore(spec, backup);
  if (proc.code !== 0) return `退回失败：${clip(proc.stderr || proc.stdout)}`;
  const again = await io.versionOf(spec);
  if (previousVersion) {
    if (!versionMatches(again.stdout, previousVersion)) return `退回后版本不是 ${previousVersion}`;
    return null;
  }
  if (again.code === 0 && semverOf(again.stdout)) return '退回后仍是一个新版本';
  return null;
}

function failed(
  spec: CliToolSpec,
  now: Date,
  version: string | null,
  previous: ToolRecord | undefined,
  detail: string,
): ToolRecord {
  return record(spec, 'failed', detail, {
    version,
    upgradedAt: previous?.upgradedAt ?? null,
    failure: { at: now.toISOString(), reason: detail },
  });
}

/**
 * 升一轮。sessions() > 0 时一个二进制都不换。某个工具带 failure 时跳过它，别的照常。
 * 核对或冒烟不过就装回上一版；退不回去记 failed，退回去记 rolled-back，两种都写 failure。
 */
export async function runUpgrade(input: {
  tools: readonly CliToolSpec[];
  previous: UpgradeState | null;
  io: UpgradeIo;
  why: 'idle' | 'release';
  requestAt: string | null;
}): Promise<UpgradeState> {
  const now = input.io.now();
  const seen: NonNullable<UpgradeState['seen']> = { ...(input.previous?.seen ?? {}) };
  const tools: Record<string, ToolRecord> = {};
  const base = (): UpgradeState => ({
    schema: 1,
    at: input.requestAt,
    checkedAt: now.toISOString(),
    why: input.why,
    tools,
    ...(Object.keys(seen).length > 0 ? { seen } : {}),
  });

  if ((await input.io.sessions()) > 0) {
    for (const spec of input.tools) {
      const prev = input.previous?.tools[spec.id];
      tools[spec.id] = record(spec, 'refused', '有会话在跑或排空状态读不到，不替换二进制', {
        version: prev?.version ?? null,
        upgradedAt: prev?.upgradedAt ?? null,
      });
    }
    return base();
  }

  for (const spec of input.tools) {
    const prev = input.previous?.tools[spec.id];
    if (prev?.failure) {
      tools[spec.id] = prev;
      continue;
    }
    if (spec.via === 'tar') {
      const current = await input.io.versionOf(spec);
      const oldVersion = current.code === 0 ? semverOf(current.stdout) : null;
      if ((await input.io.sessions()) > 0) {
        tools[spec.id] = record(
          spec,
          'refused',
          '升级过程中出现会话，不替换二进制',
          kept(prev, oldVersion, null),
        );
        continue;
      }
      let result: TarInstallResult;
      try {
        result = input.io.installTar
          ? await input.io.installTar(spec)
          : { code: 1, stdout: '', stderr: '固定版本 tar 安装端口未接线' };
      } catch (err) {
        result = { code: 1, stdout: '', stderr: String(err) };
      }
      if (result.refused) {
        tools[spec.id] = record(
          spec,
          'refused',
          clip(result.stderr || result.stdout),
          kept(prev, oldVersion, null),
        );
        continue;
      }
      tools[spec.id] =
        result.code === 0 && !result.timedOut
          ? record(spec, oldVersion === spec.version ? 'current' : 'ok', clip(result.stdout), {
              version: spec.version ?? null,
              upgradedAt:
                oldVersion === spec.version ? (prev?.upgradedAt ?? now.toISOString()) : now.toISOString(),
            })
          : failed(spec, now, oldVersion, prev, `固定版本安装失败：${clip(result.stderr || result.stdout)}`);
      continue;
    }
    const channel = parseChannel(spec.channel);
    if (!channel) {
      const why = spec.channel?.trim() ? `渠道「${spec.channel.trim()}」认不出，不升` : '没写渠道，不升';
      // 不换二进制，但读一下现版本，驾驶舱才看得到 Cursor、reclaude。
      const shown = spec.bin ? await input.io.versionOf(spec) : null;
      const version =
        shown && shown.code === 0
          ? (semverOf(shown.stdout) ?? prev?.version ?? null)
          : (prev?.version ?? null);
      tools[spec.id] = record(spec, 'skipped', why, { version, upgradedAt: prev?.upgradedAt ?? null });
      continue;
    }
    if (spec.via === 'npm' && !spec.bin) {
      tools[spec.id] = record(spec, 'skipped', '没写命令，不升', kept(prev, null, null));
      continue;
    }
    if (spec.via === 'self-update' && !spec.bin) {
      tools[spec.id] = record(spec, 'skipped', '没写命令，不升', kept(prev, null, null));
      continue;
    }
    const target = await resolveTarget(spec, channel, input.io, seen[spec.id], now);
    if (target.seen) seen[spec.id] = target.seen;
    if (target.resolved.skip || !target.resolved.version) {
      tools[spec.id] = record(spec, 'skipped', target.resolved.skip ?? '这轮不升', kept(prev, null, null));
      continue;
    }
    const version = target.resolved.version;
    const current = await input.io.versionOf(spec);
    const previousVersion = current.code === 0 ? semverOf(current.stdout) : null;
    if (previousVersion && versionMatches(current.stdout, version)) {
      // 记过「这一版核对通过」才直接跳过。磁盘上已经是目标、记录还是旧的（升级被掐断）：先冒烟，不过就装回记下的上一版。
      const recorded =
        prev != null &&
        prev.version === version &&
        prev.failure == null &&
        (prev.outcome === 'ok' || prev.outcome === 'current');
      if (recorded) {
        tools[spec.id] = record(spec, 'current', `已是 ${version}`, {
          version,
          upgradedAt: prev.upgradedAt,
        });
        continue;
      }
      if ((await input.io.sessions()) > 0) {
        tools[spec.id] = record(spec, 'refused', '升级过程中出现会话，剩下的不换', {
          version: prev?.version ?? null,
          upgradedAt: prev?.upgradedAt ?? null,
        });
        continue;
      }
      const smokeNow = await input.io.smoke(spec);
      if (smokeNow.code !== 0 || smokeNow.timedOut) {
        const why = smokeNow.timedOut ? '冒烟超时' : `冒烟失败：${clip(smokeNow.stderr || smokeNow.stdout)}`;
        const rollbackTo = prev?.version && prev.version !== version ? prev.version : null;
        const back =
          spec.via === 'self-update'
            ? '没有留下上一份二进制，退不回去'
            : await rollback(spec, input.io, rollbackTo, null);
        tools[spec.id] = back
          ? failed(
              spec,
              now,
              rollbackTo ?? previousVersion,
              prev,
              `${why}；磁盘上已是 ${version}，但没记过冒烟通过；${back}`,
            )
          : record(spec, 'rolled-back', `${why}；已装回 ${rollbackTo ?? '未安装'}`, {
              version: rollbackTo,
              upgradedAt: prev?.upgradedAt ?? null,
              failure: { at: now.toISOString(), reason: why },
            });
        continue;
      }
      tools[spec.id] = record(spec, 'current', `已是 ${version}，冒烟通过`, {
        version,
        upgradedAt: prev?.upgradedAt ?? now.toISOString(),
      });
      continue;
    }
    if ((await input.io.sessions()) > 0) {
      tools[spec.id] = record(spec, 'refused', '升级过程中出现会话，剩下的不换', {
        version: prev?.version ?? null,
        upgradedAt: prev?.upgradedAt ?? null,
      });
      continue;
    }
    const backup = spec.via === 'self-update' ? await input.io.backup(spec) : null;
    const installed =
      spec.via === 'npm' && spec.packageName
        ? await input.io.npmInstall(`${spec.packageName}@${version}`, npmPrefixOf(spec))
        : await input.io.installSelf(spec);
    if (installed.code !== 0 || installed.timedOut) {
      const why = `安装失败：${clip(installed.stderr || installed.stdout)}`;
      const back = await rollback(spec, input.io, previousVersion, backup);
      tools[spec.id] = back
        ? failed(spec, now, previousVersion, prev, `${why}；${back}`)
        : record(spec, 'rolled-back', `${why}；已装回 ${previousVersion ?? '未安装'}`, {
            version: previousVersion,
            upgradedAt: prev?.upgradedAt ?? null,
            failure: { at: now.toISOString(), reason: why },
          });
      continue;
    }
    const after = await input.io.versionOf(spec);
    if (after.code !== 0 || !versionMatches(after.stdout, version)) {
      const why = `装完版本不是 ${version}：${clip(after.stdout || after.stderr)}`;
      const back = await rollback(spec, input.io, previousVersion, backup);
      tools[spec.id] = back
        ? failed(spec, now, previousVersion, prev, `${why}；${back}`)
        : record(spec, 'rolled-back', `${why}；已装回 ${previousVersion ?? '未安装'}`, {
            version: previousVersion,
            upgradedAt: prev?.upgradedAt ?? null,
            failure: { at: now.toISOString(), reason: why },
          });
      continue;
    }
    const smoke = await input.io.smoke(spec);
    if (smoke.code !== 0 || smoke.timedOut) {
      const why = smoke.timedOut ? '冒烟超时' : `冒烟失败：${clip(smoke.stderr || smoke.stdout)}`;
      const back = await rollback(spec, input.io, previousVersion, backup);
      tools[spec.id] = back
        ? failed(spec, now, previousVersion, prev, `${why}；${back}`)
        : record(spec, 'rolled-back', `${why}；已装回 ${previousVersion ?? '未安装'}`, {
            version: previousVersion,
            upgradedAt: prev?.upgradedAt ?? null,
            failure: { at: now.toISOString(), reason: why },
          });
      continue;
    }
    tools[spec.id] = record(spec, 'ok', `升到 ${version}`, { version, upgradedAt: now.toISOString() });
  }
  return base();
}

/** 期望文件里的 cliTools。认不出返回 error，调用方不要升。没有这一块就是空名单。 */
export function readCliToolsConfig(
  raw: unknown,
): { ok: true; tools: CliToolSpec[] } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: '期望文件不是对象' };
  const cli = (raw as { cliTools?: unknown }).cliTools;
  if (cli === undefined) return { ok: true, tools: [] };
  if (typeof cli !== 'object' || cli === null || Array.isArray(cli))
    return { ok: false, error: 'cliTools 不是对象' };
  const toolsRaw = (cli as { tools?: unknown }).tools;
  if (typeof toolsRaw !== 'object' || toolsRaw === null || Array.isArray(toolsRaw)) {
    return { ok: false, error: 'cliTools.tools 不是对象' };
  }
  const tools: CliToolSpec[] = [];
  for (const [id, value] of Object.entries(toolsRaw)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: `cliTools.${id} 不是对象` };
    }
    const tool = value as Record<string, unknown>;
    const via = tool.via === 'npm' || tool.via === 'self-update' || tool.via === 'tar' ? tool.via : null;
    const text = (key: string): string | undefined =>
      typeof tool[key] === 'string' ? (tool[key] as string) : undefined;
    const spec: CliToolSpec = { id, name: text('name')?.trim() || id, via };
    const version = text('version');
    if (
      via === 'tar' &&
      (id !== 'go' ||
        !version ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        text('bin') !== '/usr/local/bin/go' ||
        text('user'))
    ) {
      return { ok: false, error: `cliTools.${id} tar 仅支持固定版本 Go 和 /usr/local/bin/go` };
    }
    if (version) spec.version = version;
    const packageName = text('package');
    const bin = text('bin');
    const user = text('user');
    const prefix = text('prefix');
    const channel = text('channel');
    if (packageName) spec.packageName = packageName;
    if (bin) spec.bin = bin;
    if (user) spec.user = user;
    if (prefix) spec.prefix = prefix;
    if (channel !== undefined) spec.channel = channel;
    tools.push(spec);
  }
  return { ok: true, tools };
}

export function parseUpgradeState(raw: unknown): UpgradeState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Partial<UpgradeState>;
  if (o.schema !== 1 || typeof o.checkedAt !== 'string' || typeof o.tools !== 'object' || o.tools === null)
    return null;
  if (o.why !== 'idle' && o.why !== 'release') return null;
  return o as UpgradeState;
}
