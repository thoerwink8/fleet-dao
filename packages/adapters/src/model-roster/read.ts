// 四个渠道各读一次「现在认哪些模型」。跟额度读取同一轮里跑，但由调用方决定这一轮到没到间隔。
// 一家抛错只记这一家，不让它把另外三家的结果带走。空名单在这里改写成 bad_response。
import { errMessage } from '@fleet-dao/shared/util';
import type { MirasimWire } from '../mirasim/wire.ts';
import type { CommandResult, RunCommand } from '../quota/context.ts';
import { childEnv } from '../quota/io.ts';
import { QuotaReadError } from '../quota/types.ts';
import { modelsFromMirasimWire } from './mirasim.ts';
import { classifyModelCommand, parseListedModels, uniqueModels } from './parse.ts';
import { type ChannelModelReadResult, rosterFailed } from './types.ts';

const COMMAND_TIMEOUT_MS = 45_000;

export interface ModelRosterRequest {
  /** 读哪些渠道、记在哪个目录渠道编号下。顺序原样返回。 */
  channels: readonly { kind: string; channelId: string }[];
  commands: {
    cursor: readonly string[];
    grok: readonly string[];
  };
  runCommand: RunCommand;
  /** 传给命令的环境。会话用户那条 runCommand 会忽略它，用会话用户自己的环境。 */
  env?: Record<string, string | undefined>;
  /** 命令行渠道要空的真目录。起不来时 cursor、grok 都记 config，Mirasim、Claude 不受影响。 */
  workDir?: () => Promise<string>;
  /** 不给就不直连本机 Mirasim（测试不许连真服务）。 */
  connectMirasim?: () => Promise<MirasimWire>;
  commandTimeoutMs?: number;
  mirasimTimeoutMs?: number;
  perAgentMs?: number;
}

/** 一家一家的结果，不抛。channels 为空就返回空数组，不当成读成了。 */
export async function readChannelModelRosters(req: ModelRosterRequest): Promise<ChannelModelReadResult[]> {
  let cwd = '/';
  let cwdError: string | undefined;
  if (req.workDir) {
    try {
      cwd = await req.workDir();
    } catch (err) {
      cwdError = errMessage(err);
    }
  }
  const env = childEnv(req.env ?? {});
  return Promise.all(
    req.channels.map((channel) =>
      readOne(channel, req, cwd, cwdError, env).catch((err) =>
        err instanceof QuotaReadError
          ? rosterFailed(channel.channelId, err.code, err.message)
          : rosterFailed(channel.channelId, 'crashed', errMessage(err) || '读模型表时崩了'),
      ),
    ),
  );
}

async function readOne(
  channel: { kind: string; channelId: string },
  req: ModelRosterRequest,
  cwd: string,
  cwdError: string | undefined,
  env: Record<string, string>,
): Promise<ChannelModelReadResult> {
  const result = await dispatch(channel, req, cwd, cwdError, env);
  if (!result.ok) return result;
  const models = uniqueModels(result.models);
  if (models.length === 0) {
    return rosterFailed(channel.channelId, 'bad_response', '渠道回了空名单，不当成一个模型都没有');
  }
  const keep = new Set(models);
  const executors: { modelKey: string; executor: string }[] = [];
  const seen = new Set<string>();
  for (const row of result.executors ?? []) {
    const modelKey = row.modelKey.trim();
    const executor = row.executor.trim();
    if (!modelKey || !executor || !keep.has(modelKey) || seen.has(modelKey)) continue;
    seen.add(modelKey);
    executors.push({ modelKey, executor });
  }
  return {
    ok: true,
    channelId: channel.channelId,
    models,
    ...(executors.length > 0 ? { executors } : {}),
  };
}

async function dispatch(
  channel: { kind: string; channelId: string },
  req: ModelRosterRequest,
  cwd: string,
  cwdError: string | undefined,
  env: Record<string, string>,
): Promise<ChannelModelReadResult> {
  switch (channel.kind) {
    case 'mirasim':
      return readMirasimModelRoster(channel.channelId, req);
    case 'cursor':
      return readCursorModelRoster(channel.channelId, req, cwd, cwdError, env);
    case 'grok':
      return readGrokModelRoster(channel.channelId, req, cwd, cwdError, env);
    case 'claude':
      return readClaudeModelRoster(channel.channelId);
    default:
      return rosterFailed(channel.channelId, 'config', `不认识的渠道种类：${channel.kind}`);
  }
}

/** Mirasim：经桥接问每个执行体的名册。没给桥接就报 config，不开到本机端口的连接。 */
export async function readMirasimModelRoster(
  channelId: string,
  req: Pick<ModelRosterRequest, 'connectMirasim' | 'mirasimTimeoutMs' | 'perAgentMs'>,
): Promise<ChannelModelReadResult> {
  if (!req.connectMirasim) {
    return rosterFailed(channelId, 'config', '没有 Mirasim 桥接（connectMirasim），不直连本机的 Mirasim');
  }
  const parsed = await modelsFromMirasimWire(req.connectMirasim, {
    ...(req.mirasimTimeoutMs !== undefined ? { timeoutMs: req.mirasimTimeoutMs } : {}),
    ...(req.perAgentMs !== undefined ? { perAgentMs: req.perAgentMs } : {}),
  });
  if (!parsed.ok) return rosterFailed(channelId, parsed.code, parsed.message);
  return {
    ok: true,
    channelId,
    models: parsed.models,
    ...(parsed.executors && parsed.executors.length > 0 ? { executors: parsed.executors } : {}),
  };
}

/** cursor-agent models。密钥没放好、二进制不在，分别是 no_credentials、config。 */
export function readCursorModelRoster(
  channelId: string,
  req: ModelRosterRequest,
  cwd: string,
  cwdError: string | undefined,
  env: Record<string, string>,
): Promise<ChannelModelReadResult> {
  return readCli(channelId, 'cursor', req.commands.cursor, req, cwd, cwdError, env);
}

/** grok models。没登录且没有 Available models 段是 auth；列出了模型就算读成。 */
export function readGrokModelRoster(
  channelId: string,
  req: ModelRosterRequest,
  cwd: string,
  cwdError: string | undefined,
  env: Record<string, string>,
): Promise<ChannelModelReadResult> {
  return readCli(channelId, 'grok', req.commands.grok, req, cwd, cwdError, env);
}

/**
 * Claude：官方命令行（reclaude 包的就是它）没有列模型的子命令。`reclaude models` 会把 models 当成提示词，
 * 起一个真会话、可能扣额度，所以不跑它。读不成就明说读不成，不拿空名单、也不拿 API 的 /v1/models 冒充对得上。
 * 以后有了只读的列模型来源再接这里。
 */
export function readClaudeModelRoster(channelId: string): Promise<ChannelModelReadResult> {
  return Promise.resolve(
    rosterFailed(
      channelId,
      'config',
      'Claude 命令行没有列模型的只读命令（reclaude models 会被当成提示词起一个会话），这个渠道的模型表读不了',
    ),
  );
}

async function readCli(
  channelId: string,
  kind: 'cursor' | 'grok',
  argv: readonly string[],
  req: ModelRosterRequest,
  cwd: string,
  cwdError: string | undefined,
  env: Record<string, string>,
): Promise<ChannelModelReadResult> {
  if (cwdError) return rosterFailed(channelId, 'config', `工作目录起不来：${cwdError}`);
  if (argv.length === 0) return rosterFailed(channelId, 'config', '没有启动命令');
  const run = await runBounded(
    req.runCommand,
    [...argv, 'models'],
    { cwd, env },
    req.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
  );
  const classified = classifyModelCommand(kind, run);
  if (classified !== 'parse') return rosterFailed(channelId, classified.code, classified.message);
  const parsed = parseListedModels(kind, `${run.stdout}\n${run.stderr}`);
  if (!parsed.ok) return rosterFailed(channelId, parsed.code, parsed.message);
  return { ok: true, channelId, models: parsed.models };
}

function runBounded(
  run: RunCommand,
  argv: string[],
  base: { cwd: string; env: Record<string, string> },
  timeoutMs: number,
): Promise<CommandResult> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<CommandResult>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ code: null, stdout: '', stderr: '', killed: true });
    }, timeoutMs);
  });
  return Promise.race([
    run(argv, { cwd: base.cwd, env: base.env, signal: ac.signal }).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timed,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
