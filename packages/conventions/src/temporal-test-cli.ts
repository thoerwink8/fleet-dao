// 真 Temporal 测试只用已准备好的固定 CLI；网络下载不属于测试生命周期。
import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fsRepo, type RepoView } from './repo.ts';
import { TEMPORAL_MARKER } from './test-split.ts';

const REPAIR = 'pnpm temporal:install；或 pnpm test:temporal --cli <已安装的固定版本CLI绝对路径>';
export const TEMPORAL_PROBE_LIMIT_MS = 5_000;

function preparationError(detail: string, cause?: unknown): Error {
  return new Error(`Temporal preparation 失败：${detail}。修复后重试：${REPAIR}`, { cause });
}

export function temporalTestVersion(repo: RepoView): string {
  const text = repo.read('deploy/france.sh');
  if (text === undefined) throw preparationError('读不到 deploy/france.sh 的固定版本');
  const matches = [...text.matchAll(/^TEMPORAL_CLI_VERSION=([^\r\n]*)\r?$/gm)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0]?.[1] ?? ''))
    throw preparationError('deploy/france.sh 的固定版本不唯一或认不出');
  return matches[0]?.[1] as string;
}

/** 只探 --version，不起服务端。SIGKILL 防止忽略普通终止信号的探测进程拖住调用方。 */
export function temporalVersionOutput(
  path: string,
  limitMs = TEMPORAL_PROBE_LIMIT_MS,
  run: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string> = spawnSync,
): string {
  const result = run(path, ['--version'], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: limitMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const detail =
      code === 'ETIMEDOUT'
        ? `--version 在 ${limitMs}ms 内未退出，探测进程已终止`
        : `--version 没有成功退出（exit=${result.status}, signal=${result.signal}）：${result.error?.message ?? result.stderr?.trim().slice(0, 500)}`;
    throw preparationError(detail, result.error);
  }
  return result.stdout.trim();
}

export interface TemporalCliOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 测试只替换 --version 探测，不替换路径、登记或固定版本判法。 */
  probe?: (path: string) => string;
}

export interface PreparedTemporalCli {
  path: string;
  version: string;
}

export function temporalCliRegistration(home = homedir()): string {
  return join(home, '.fleet-dao', 'test-tools', `temporal-cli-${process.platform}-${process.arch}.json`);
}

export function verifyTemporalCli(
  path: string,
  version: string,
  options: TemporalCliOptions,
): PreparedTemporalCli {
  if (!isAbsolute(path)) throw preparationError('CLI 路径必须是绝对路径');
  try {
    if (!statSync(path).isFile()) throw new Error('不是普通文件');
  } catch (cause) {
    throw preparationError(`CLI 路径不可用：${path}`, cause);
  }
  const output = (options.probe ?? temporalVersionOutput)(path);
  const actual = /^temporal version (\d+\.\d+\.\d+)(?=\s|$)/i.exec(output)?.[1];
  if (actual !== version)
    throw preparationError(`CLI 版本须为 ${version}，实际输出：${output.slice(0, 500)}`);
  return { path, version };
}

export function prepareTemporalCli(root: string, options: TemporalCliOptions = {}): PreparedTemporalCli {
  const version = temporalTestVersion(fsRepo(root));
  const env = options.env ?? process.env;
  const explicit = env.FLEET_TEST_TEMPORAL_CLI?.trim();
  if (explicit) return verifyTemporalCli(explicit, version, options);
  // CI 的 CLI 由工作流按固定制品准备，不能拿机器上残留的登记掩盖它没装成。
  if (env.CI) throw preparationError('CI 没给 FLEET_TEST_TEMPORAL_CLI');
  const registration = temporalCliRegistration(options.home);
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(registration, 'utf8'));
  } catch (cause) {
    throw preparationError(`没有可读的本机 CLI 登记：${registration}`, cause);
  }
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('schema' in saved) ||
    saved.schema !== 1 ||
    !('path' in saved) ||
    typeof saved.path !== 'string' ||
    !('version' in saved) ||
    saved.version !== version
  )
    throw preparationError(`本机 CLI 登记无效或版本已变成 ${version}`);
  return verifyTemporalCli(saved.path, version, options);
}

/** 登记现有程序，不安装、不下载、不改 PATH；写完前失败保留原登记。 */
export function registerTemporalCli(
  root: string,
  path: string,
  options: TemporalCliOptions = {},
): PreparedTemporalCli {
  const prepared = verifyTemporalCli(path, temporalTestVersion(fsRepo(root)), options);
  const target = temporalCliRegistration(options.home);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ schema: 1, ...prepared })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } catch (cause) {
    throw preparationError(`写本机 CLI 登记失败：${target}`, cause);
  } finally {
    rmSync(temporary, { force: true });
  }
  return prepared;
}

/** 与 CI 共用能力标记；读不到任何已选文件都报错，不冒充「不需要真服务端」。 */
export function selectedNeedsTemporal(repo: RepoView, selected: readonly string[]): boolean {
  let needed = false;
  for (const file of selected) {
    const text = repo.read(file);
    if (text === undefined) throw preparationError(`读不到已选测试 ${file}`);
    if (TEMPORAL_MARKER.test(text)) needed = true;
  }
  return needed;
}

/** SDK 没公开启动/连接分阶段状态；这一个 await 只报 start-or-connect，不假拆、不脱离生命周期竞速。 */
export async function startTemporalTestEnvironment<T>(
  cli: PreparedTemporalCli,
  start: (path: string) => Promise<T>,
  log: (line: string) => void = console.log,
): Promise<T> {
  const started = Date.now();
  log(`Temporal preparation 完成：CLI=${cli.path} version=${cli.version}`);
  log('Temporal start-or-connect 开始（SDK 内部启动/连接细分阶段未知）');
  try {
    const environment = await start(cli.path);
    log(`Temporal start-or-connect 完成：${Date.now() - started}ms`);
    return environment;
  } catch (cause) {
    throw new Error(
      `Temporal start-or-connect 失败（${Date.now() - started}ms；SDK 内部细分阶段未知）：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
