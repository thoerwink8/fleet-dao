// 候选代码只在普通用户/私有网络中执行；依赖/快照与判绿继续交原 Linux worker。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(readFileSync(0, 'utf8'));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const source = (path) => {
  const file = input.files.find((f) => f.path === path);
  if (!file) throw new Error(`快照缺少 ${path}`);
  return Buffer.from(file.data, 'base64').toString();
};
async function tcp(host) {
  const server = createServer();
  let client, peer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    const port = server.address().port;
    await Promise.all([
      new Promise((resolve, reject) => {
        server.once('connection', (socket) => {
          peer = socket;
          resolve();
        });
        server.once('error', reject);
      }),
      new Promise((resolve, reject) => {
        client = connect({ host, port });
        client.setTimeout(5000, () => client.destroy(new Error('TCP preflight timeout')));
        client.once('connect', resolve);
        client.once('error', reject);
      }),
    ]);
    return { host, port, connected: true, accepted: true };
  } finally {
    client?.destroy();
    peer?.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

try {
  if (process.platform !== 'linux' || process.getuid() <= 0 || process.version !== input.tools.nodeVersion)
    throw new Error('隔离 Node 平台/普通用户/固定版本不符');
  const actualDigest = createHash('sha256').update(JSON.stringify(input.files)).digest('hex');
  if (actualDigest !== input.digest) throw new Error('隔离源码快照摘要不符');
  for (const tool of [input.tools.cli, input.tools.testServer])
    if (sha(tool.path) !== tool.sha256) throw new Error(`隔离工具 SHA 不符：${tool.path}`);
  const version = spawnSync(input.tools.cli.path, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (version.status !== 0 || !version.stdout.startsWith(`temporal version ${input.tools.cli.version} `))
    throw new Error('隔离 CLI 固定版本不符');
  const require = createRequire(join(input.dependencyRoot, 'packages/engine/package.json'));
  const sdk = require('@temporalio/testing/package.json');
  if (sdk.version !== input.tools.sdkVersion) throw new Error('隔离 SDK 固定版本不符');
  // 旧 SDK 的预热缓存必须已存在且精确校验；不能靠隔离环境尝试下载再等待超时。
  if (
    basename(input.tools.testServer.path) !== `temporal-test-server-sdk-typescript-${sdk.version}` ||
    dirname(input.tools.testServer.path) !== tmpdir()
  )
    throw new Error('SDK 预热缓存与资源 TMPDIR 不符');
  const ports = [await tcp('127.0.0.1'), await tcp('::1')];
  const { TestWorkflowEnvironment } = await import(
    pathToFileURL(require.resolve('@temporalio/testing')).href
  );
  const { Runtime } = await import(pathToFileURL(require.resolve('@temporalio/worker')).href);
  const services = [];
  try {
    for (const mode of ['time-skipping', 'local']) {
      let environment;
      try {
        const path = mode === 'local' ? input.tools.cli.path : input.tools.testServer.path;
        const options = { server: { executable: { type: 'existing-path', path } } };
        environment = await (mode === 'local'
          ? TestWorkflowEnvironment.createLocal(options)
          : TestWorkflowEnvironment.createTimeSkipping(options));
        const health = await environment.connection.healthService.check({ service: '' });
        if (health.status !== 1) throw new Error(`Temporal ${mode} health is not SERVING`);
        services.push({ mode, address: environment.address, health });
      } finally {
        await environment?.teardown();
      }
    }
  } finally {
    await Runtime.instance().shutdown();
  }
  console.log(
    `FLEET_ISOLATED_PREFLIGHT=${JSON.stringify({ node: process.version, sdk: sdk.version, netns: readlinkSync('/proc/self/ns/net'), ports, services })}`,
  );
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source('packages/conventions/src/linux-test-worker.mjs')],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, FLEET_TEST_TEMPORAL_CLI: input.tools.cli.path },
    },
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status === null)
    throw child.error ?? new Error(`Linux worker signal ${child.signal}`);
  process.exitCode = child.status;
} catch (error) {
  console.error(`隔离资源准备/执行失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}
