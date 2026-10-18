// root 跑的升级入口（#1971）：发版脚本在排空之后直接调，空闲时由 fleet-cli-upgrade.path 看见请求再调。
// 不引用 @fleet-dao/*：发版还没切 current，这一版的依赖可能还没装好，只靠 Node 自己。
// 引擎用户没有 root，装不到 /usr/lib/node_modules，也不许改会话用户家里的 grok。请求文件只当触发器用，装什么看期望文件。
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLI_UPGRADE_DIR,
  CLI_UPGRADE_REQUEST_NAME,
  CLI_UPGRADE_STATE_NAME,
  type CliToolSpec,
  type ProcResult,
  parseUpgradeState,
  readCliToolsConfig,
  runUpgrade,
  type UpgradeState,
} from './cli-upgrade.ts';
import { installGoTar } from './cli-upgrade-go.ts';
import { writeAtomicOwnedByDir } from './write-owned-by-dir.ts';

const NPM_MS = 10 * 60_000;
const VERSION_MS = 20_000;
const SMOKE_MS = 20_000;
const GROK_MS = 15 * 60_000;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** 不继承调用方的环境：npm、核对、冒烟都只看见系统目录。 */
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    npm_config_update_notifier: 'false',
  };
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr} ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const killed = code === 124 || code === 137;
      resolve({ code, stdout, stderr, timedOut: timedOut || killed });
    });
  });
}

async function homeOf(user: string): Promise<string> {
  const got = await exec('getent', ['passwd', user], 5_000);
  const home = got.stdout.split(':')[5] ?? '';
  if (got.code !== 0 || home === '') throw new Error(`getent 查不到 ${user} 的家目录`);
  return home;
}

async function asUser(user: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  const home = await homeOf(user);
  const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return exec(
    'runuser',
    [
      '-u',
      user,
      '--',
      'env',
      '-i',
      `HOME=${home}`,
      `USER=${user}`,
      `LOGNAME=${user}`,
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'SHELL=/bin/sh',
      'LANG=C.UTF-8',
      '/usr/bin/setsid',
      '-w',
      '/usr/bin/timeout',
      '-k',
      '5',
      secs,
      ...args,
    ],
    timeoutMs + 15_000,
  );
}

async function runBin(spec: CliToolSpec, args: string[], timeoutMs: number): Promise<ProcResult> {
  if (!spec.bin) return { code: 127, stdout: '', stderr: '没写命令' };
  if (spec.user) return asUser(spec.user, [spec.bin, ...args], timeoutMs);
  return exec(spec.bin, args, timeoutMs);
}

async function sessions(releaseWindow: boolean): Promise<number> {
  const file = join(process.env.FLEET_ENGINE_STATE_DIR ?? '/var/lib/fleet-dao/engine', 'drain.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    console.error(`排空状态读不到（${file}）：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let parsed: { schema?: unknown; sessions?: unknown; cordon?: { source?: string } | null };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    console.error('排空状态不是 JSON');
    return 1;
  }
  if (parsed.schema !== 2 || !Array.isArray(parsed.sessions)) {
    console.error('排空状态的格式不对');
    return 1;
  }
  if (parsed.sessions.length > 0) return parsed.sessions.length;
  // 空闲这一路必须看见引擎自己挂上的升级排空。发版时引擎已经停了，排空状态里不一定还挂着。
  if (!releaseWindow && parsed.cordon?.source !== 'cli-upgrade') return 1;
  return 0;
}

async function grokLatestVersion(): Promise<string | null> {
  const urls = [
    'https://x.ai/cli/stable',
    'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z0-9._]+)?$/.test(text)) return text;
    } catch {
      // 换下一个指针
    }
  }
  return null;
}

function failedState(why: 'idle' | 'release', requestAt: string | null, detail: string): UpgradeState {
  const at = new Date().toISOString();
  return {
    schema: 1,
    at: requestAt,
    checkedAt: at,
    why,
    tools: {
      config: {
        name: '期望',
        version: null,
        upgradedAt: null,
        channel: null,
        outcome: 'failed',
        detail,
        failure: { at, reason: detail },
      },
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node cli-upgrade-main.ts [--release-window] [--config 期望文件] [--dir 状态目录]');
    return 0;
  }
  const releaseWindow = argv.includes('--release-window');
  const configPath =
    arg(argv, '--config') ??
    process.env.FLEET_CLI_UPGRADE_CONFIG ??
    '/srv/fleet-dao-releases/current/deploy/france/desired-config.json';
  const dir = arg(argv, '--dir') ?? process.env.FLEET_CLI_UPGRADE_DIR ?? CLI_UPGRADE_DIR;
  const requestPath = join(dir, CLI_UPGRADE_REQUEST_NAME);
  const statePath = join(dir, CLI_UPGRADE_STATE_NAME);
  let requestAt: string | null = null;
  if (!releaseWindow) {
    let text: string;
    try {
      text = await readFile(requestPath, 'utf8');
    } catch (err) {
      console.error(`没有升级请求（${requestPath}）：${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    let req: { schema?: unknown; at?: unknown };
    try {
      req = JSON.parse(text) as typeof req;
    } catch {
      console.error('升级请求不是 JSON');
      return 2;
    }
    if (req.schema !== 1 || typeof req.at !== 'string') {
      console.error('升级请求认不出');
      return 2;
    }
    requestAt = req.at;
    // 先删掉，path 单元才不会因为文件还在再起一次。引擎认的是 wanted.json，不靠这份还在。
    await rm(requestPath, { force: true });
  }

  const why = releaseWindow ? 'release' : 'idle';
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    const detail = `期望文件读不到：${err instanceof Error ? err.message : String(err)}`;
    await writeAtomicOwnedByDir(
      statePath,
      `${JSON.stringify(failedState(why, requestAt, detail), null, 1)}\n`,
    );
    console.error(detail);
    return 1;
  }
  const tools = readCliToolsConfig(raw);
  if (!tools.ok) {
    await writeAtomicOwnedByDir(
      statePath,
      `${JSON.stringify(failedState(why, requestAt, tools.error), null, 1)}\n`,
    );
    console.error(tools.error);
    return 1;
  }

  let previous: UpgradeState | null = null;
  try {
    previous = parseUpgradeState(JSON.parse(await readFile(statePath, 'utf8')));
  } catch {
    previous = null;
  }

  const backupDir = join(dir, 'backup');
  const state = await runUpgrade({
    tools: tools.tools,
    previous,
    why,
    requestAt,
    io: {
      now: () => new Date(),
      sessions: () => sessions(releaseWindow),
      npmVersion: async (spec) => {
        const got = await exec('npm', ['view', spec, 'version'], 60_000);
        if (got.code !== 0) throw new Error(clip(got.stderr || got.stdout));
        return (got.stdout.trim().split('\n').pop() ?? '').trim();
      },
      npmPublishedAt: async (pkg, version) => {
        const got = await exec('npm', ['view', pkg, 'time', '--json'], 60_000);
        if (got.code !== 0) throw new Error(clip(got.stderr || got.stdout));
        const json = JSON.parse(got.stdout) as Record<string, unknown>;
        const rawTime = json[version];
        if (typeof rawTime !== 'string') return null;
        const at = new Date(rawTime);
        return Number.isNaN(at.getTime()) ? null : at;
      },
      npmInstall: (spec, prefix) =>
        exec('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', spec], NPM_MS),
      npmUninstall: (pkg, prefix) => exec('npm', ['uninstall', '-g', '--prefix', prefix, pkg], NPM_MS),
      grokLatestVersion,
      installTar: (spec) => installGoTar(spec, { exec, sessions: () => sessions(releaseWindow) }),
      versionOf: (spec) => runBin(spec, spec.via === 'tar' ? ['version'] : ['--version'], VERSION_MS),
      smoke: (spec) => runBin(spec, ['--help'], SMOKE_MS),
      installSelf: (spec) => runBin(spec, ['update'], GROK_MS),
      backup: async (spec) => {
        if (!spec.bin) return null;
        try {
          await access(spec.bin);
        } catch {
          return null;
        }
        const id = join(backupDir, spec.id);
        await mkdir(dirname(id), { recursive: true });
        await copyFile(spec.bin, id);
        return { id };
      },
      restore: async (spec, backup) => {
        if (!spec.bin) return { code: 1, stdout: '', stderr: '没写命令' };
        if (!backup) {
          await rm(spec.bin, { force: true });
          return { code: 0, stdout: '', stderr: '' };
        }
        await copyFile(backup.id, spec.bin);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await writeAtomicOwnedByDir(statePath, `${JSON.stringify(state, null, 1)}\n`);
  for (const [id, tool] of Object.entries(state.tools)) {
    console.log(`${tool.outcome} ${id} ${tool.version ?? '-'} ${tool.detail}`);
  }
  return Object.values(state.tools).some((tool) => tool.outcome === 'failed') ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
