// 装配档案 local（另一个工作环境，Windows 本机，#3858，决定 0125 第 1 条，讨论稿 6.6）：
//   存储 PGlite 落文件（用户数据目录，不在安装目录）；内核、驾驶舱口、静态页一个进程，只听 127.0.0.1；
//   本机令牌文件鉴权；没有 cgroup、没有出网关，隔离档位如实读回；没有 GitHub 写（进程里没有任何 GitHub 凭据）。
// 这一片不接任务来源和外送（后续片）：taskFor、readMerged 是明说"没接"的桩，没有批次时节拍什么也不做。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createCockpitApi,
  createLocalGateway,
  ensureLocalToken,
  localAuthorize,
} from '@fleet-dao/harness-api';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { openLocalDb } from '@fleet-dao/harness-store/local-db';
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '@fleet-dao/harness-workers';
import { type Assembly, ConfigError, type Env, log, port } from './config.ts';
import { readIsolation } from './isolation.ts';

/** 用户数据目录：Windows 是 %LOCALAPPDATA%\Fleet2，macOS 是 Application Support，其余 XDG。FLEET2_DATA_DIR 可改。 */
export function defaultDataDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (env.FLEET2_DATA_DIR) return resolve(env.FLEET2_DATA_DIR);
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Fleet2');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Fleet2');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'fleet2');
}

const NO_SOURCE = '本机装法这一片还没接任务来源';
const DEFAULT_DIST = new URL('../../../harness-web/dist-local', import.meta.url);

export async function assembleLocal(
  env: Env,
): Promise<Assembly & { gateway: ReturnType<typeof createLocalGateway> }> {
  const dataDir = defaultDataDir(env);
  const uiPort = port(env, 'FLEET2_UI_PORT', 7346, true);
  const commandRaw = env.FLEET2_WORKER_COMMAND ?? '["claude"]';
  const command = JSON.parse(commandRaw) as unknown;
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== 'string')) {
    throw new ConfigError('FLEET2_WORKER_COMMAND 要是非空的字符串数组（JSON），例如 ["claude"]');
  }
  // 本机同用户跑工人，权限档必须降下来（讨论稿 #3849 第一节 4）：默认 acceptEdits，不认 bypassPermissions
  const permissionMode = (env.FLEET2_PERMISSION_MODE ?? 'acceptEdits') as ClaudePermissionMode;
  if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) {
    throw new ConfigError(`FLEET2_PERMISSION_MODE 只认 ${CLAUDE_PERMISSION_MODES.join('、')}`);
  }
  if (permissionMode === 'bypassPermissions') {
    throw new ConfigError('本机装法工人和你同一个用户，不许 bypassPermissions；用 acceptEdits 或 dontAsk');
  }
  const distDir = env.FLEET2_WEB_DIST
    ? resolve(env.FLEET2_WEB_DIST)
    : decodeURIComponent(DEFAULT_DIST.pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const model = env.FLEET2_MODEL ?? 'unset';
  const version = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  ).version;

  const store = await openLocalDb(join(dataDir, 'db'));
  const token = ensureLocalToken(join(dataDir, 'local-token'));
  const cockpit = createCockpitApi({
    db: store.db,
    authorize: localAuthorize(token),
    apiPrefix: '/api',
    pollMs: 1000,
  });
  const isolation = readIsolation({
    separateUser: false,
    egressGateway: false,
    permissionMode,
    platform: process.platform,
  });
  let listen = `127.0.0.1:${uiPort}`;
  const gateway = createLocalGateway({
    cockpit,
    token,
    distDir,
    status: () => ({
      profile: 'local',
      version,
      listen,
      dataDir,
      isolation,
      externalWrites: { github: false, egressGateway: false },
      hosts: [{ id: 'local', kind: 'local', label: '本机', isolation: isolation.level }],
      settings: [
        { key: 'FLEET2_DATA_DIR', value: dataDir, note: '数据目录（用户数据目录，不在安装目录）' },
        { key: 'FLEET2_UI_PORT', value: String(uiPort), note: '页面和接口的口，只听 127.0.0.1' },
        { key: 'FLEET2_WORKER_COMMAND', value: commandRaw, note: '工人的启动命令' },
        { key: 'FLEET2_PERMISSION_MODE', value: permissionMode, note: '工人权限档（本机不许放开）' },
        { key: 'FLEET2_MODEL', value: model, note: '工人用的模型' },
        { key: '验收默认', value: '全部人工', note: '本机装法默认；本片只展示，不可改' },
      ],
    }),
  });
  const redact = makeRedactor([token]);

  return {
    profile: 'local',
    gateway,
    kernel: {
      db: store.db,
      redact,
      apiPort: 0,
      dispatcher: {
        command: command as string[],
        shell: 'claude-code',
        model,
        permissionMode,
        hostEnv: env,
        tmpRoot: join(dataDir, 'work'),
      },
      mirrorRoot: join(dataDir, 'mirror'),
      workRoot: join(dataDir, 'work'),
      workerHome: env.USERPROFILE ?? env.HOME ?? homedir(),
      egressPort: 0,
      // 本机没有影子自检要的那套隔离（没有会话用户、没有出网关）：不装自检，隔离档位由状态口如实读回"弱"
      probes: null,
      taskFor: async () => {
        throw new Error(NO_SOURCE);
      },
      readMerged: async () => {
        throw new Error(NO_SOURCE);
      },
      onSilence: () => {},
      onError: (step, err) =>
        log({ error: step, message: redact(err instanceof Error ? err.message : String(err)) }),
      tickMs: Number(env.FLEET2_TICK_MS ?? 30_000),
    },
    async afterStart() {
      const actual = await gateway.listen(uiPort);
      listen = `127.0.0.1:${actual}`;
    },
    startedFields: () => ({
      profile: 'local',
      ui: `http://${listen}/`,
      dataDir,
      isolation: isolation.level,
    }),
    async close() {
      await gateway.close();
      await store.close();
    },
  };
}
