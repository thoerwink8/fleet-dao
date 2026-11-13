// 装配档案 local（另一个工作环境，Windows 本机，#3858，决定 0125 第 1 条，讨论稿 6.6）：
//   存储 PGlite 落文件（用户数据目录，不在安装目录）；内核、驾驶舱口、静态页一个进程，只听 127.0.0.1；
//   本机令牌文件鉴权；没有 cgroup、没有出网关，隔离档位如实读回；没有 GitHub 写（进程里没有任何 GitHub 凭据）。
// 批次驱动的 taskFor、readMerged 仍是桩。人在驾驶舱建的工作区、单、会话走 ADE（src/ade，#3914）。
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createCockpitApi,
  createLocalGateway,
  ensureLocalToken,
  localAuthorize,
} from '@fleet-dao/harness-api';
import {
  defaultHost,
  HostdProcessHost,
  HostdPty,
  hostdBinary,
  makeHostdHost,
  makeRedactor,
} from '@fleet-dao/harness-runner';
import { openLocalDb } from '@fleet-dao/harness-store/local-db';
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '@fleet-dao/harness-workers';
import { AdeService, bindPtyHost, createAdeHandler, lazyPtyHost } from '../ade/index.ts';
import { restrictToCurrentUserWindows } from './acl.ts';
import { type Assembly, ConfigError, type Env, log, port } from './config.ts';
import { readIsolation } from './isolation.ts';
import { kernelVersion } from './version.ts';

/** 用户数据目录：Windows 是 %LOCALAPPDATA%\Fleet2，macOS 是 Application Support，其余 XDG。FLEET2_DATA_DIR 可改。 */
export function defaultDataDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (env.FLEET2_DATA_DIR) return resolve(env.FLEET2_DATA_DIR);
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Fleet2');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Fleet2');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'fleet2');
}

const NO_SOURCE = '本机装法这一片还没接任务来源';

export async function assembleLocal(
  env: Env,
): Promise<Assembly & { gateway: ReturnType<typeof createLocalGateway> }> {
  const dataDir = defaultDataDir(env);
  const uiPort = port(env, 'FLEET2_UI_PORT', 7347, true);
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
  // 页面目录由 pnpm fleet2 up 构建后传进来（base=/ 的本机版）；直接起内核没给就不起，不悄悄只剩接口
  if (!env.FLEET2_WEB_DIST) {
    throw new ConfigError('没给 FLEET2_WEB_DIST（本机版页面目录）；本机装法用 pnpm fleet2 up 起');
  }
  const distDir = resolve(env.FLEET2_WEB_DIST);
  const model = env.FLEET2_MODEL ?? 'unset';
  const version = kernelVersion();

  const store = await openLocalDb(join(dataDir, 'db'));
  const token = await ensureLocalToken(join(dataDir, 'local-token'), (file) =>
    // 当前用户名取自进程环境（给的 env 只是覆盖配置项，可以不带 USERNAME 这类系统变量）
    restrictToCurrentUserWindows(file, { ...process.env, ...env }, makeRedactor([])),
  );
  const redact = makeRedactor([token]);
  const host = env.FLEET2_HOST === 'hostd' ? makeHostdHost() : defaultHost();
  const ade = new AdeService({
    db: store.db,
    dataDir,
    host,
    env: { ...process.env, ...env },
    onScheduleError: (err) =>
      log({
        error: 'schedule',
        message: redact(err instanceof Error ? err.message : String(err)),
      }),
  });
  // 工人已经在用 hostd 就共用那一个进程；否则等第一次开终端再单独起，缺二进制只让终端 503。
  bindPtyHost(
    ade,
    host instanceof HostdProcessHost
      ? new HostdPty(host)
      : lazyPtyHost(() => {
          const bin = hostdBinary();
          if (!bin) return null;
          return new HostdPty(makeHostdHost({ bin, stateDir: join(dataDir, 'hostd') }));
        }),
  );
  await ade.recover();
  // 到点分辨率。测试不走这个间隔，直接把钟传给 runDue。
  ade.startScheduleTicker(5_000);
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
    ade: createAdeHandler(ade, token),
    status: () => ({
      profile: 'local',
      version,
      listen,
      dataDir,
      isolation,
      externalWrites: { github: false, egressGateway: false },
      ade: true,
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
      // 给人看的几行（不是日志）：登录链接带的是一次性登录码，不是令牌，5 分钟内用一次
      console.log('');
      console.log(`fleet2 已起：http://${listen}/`);
      console.log(
        `登录（一次性，5 分钟内有效）：http://${listen}/local-login?code=${gateway.issueLoginCode()}`,
      );
      console.log('Ctrl-C 退出；数据在用户数据目录，下次再起事件还在。');
    },
    startedFields: () => ({
      profile: 'local',
      ui: `http://${listen}/`,
      dataDir,
      isolation: isolation.level,
    }),
    async close() {
      ade.stopScheduleTicker();
      await gateway.close();
      await store.close();
    },
  };
}
