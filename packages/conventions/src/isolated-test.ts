// 显式本机离线资源；不改变 check/CI 的选测和平台分工。
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseLinuxRunner, snapshotSource, sourceDigest, verifyLinuxReceipt } from './local-vitest.ts';
import { fsRepo } from './repo.ts';
import { createTestReport } from './test-report.ts';
import { isTestFile, listTestFiles, needsPg } from './test-split.ts';

export const ISOLATED_LIMIT_MS = 15 * 60_000;
export const RESOURCE_RECEIPT = 'FLEET_ISOLATED_RESOURCE_RECEIPT=';
const LINUX_RECEIPT = 'FLEET_LINUX_TEST_RECEIPT=';
const SHA = /^[a-f0-9]{64}$/;
const ABSOLUTE_LINUX = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\r\n\0]+$/;

interface Tool {
  path: string;
  sha256: string;
}
export interface IsolatedResource {
  schema: 1;
  runner: ReturnType<typeof parseLinuxRunner>;
  uid: number;
  helperSha256: string;
  sourceDigest: string;
  offlineFiles: string[];
  tools: {
    nodeVersion: string;
    sdkVersion: string;
    cli: Tool & { version: string };
    testServer: Tool;
  };
}

export function parseIsolatedResource(text: string): IsolatedResource {
  const x = JSON.parse(text);
  const tool = (t: Tool | undefined) =>
    t && typeof t.path === 'string' && ABSOLUTE_LINUX.test(t.path) && SHA.test(t.sha256);
  if (
    x?.schema !== 1 ||
    !Number.isInteger(x.uid) ||
    x.uid <= 0 ||
    !SHA.test(x.helperSha256) ||
    !SHA.test(x.sourceDigest) ||
    !Array.isArray(x.offlineFiles) ||
    x.offlineFiles.length === 0 ||
    x.offlineFiles.some((f: unknown) => typeof f !== 'string' || !isTestFile(f) || f.includes('..')) ||
    new Set(x.offlineFiles).size !== x.offlineFiles.length ||
    !/^v22\.\d+\.\d+$/.test(x.tools?.nodeVersion) ||
    !/^\d+\.\d+\.\d+$/.test(x.tools?.sdkVersion) ||
    !/^\d+\.\d+\.\d+$/.test(x.tools?.cli?.version) ||
    !tool(x.tools?.cli) ||
    !tool(x.tools?.testServer)
  )
    throw new Error('隔离资源必须固定源码摘要、离线完整文件、普通 UID、helper 与工具身份');
  return { ...x, runner: parseLinuxRunner(JSON.stringify(x.runner)) };
}

/** 显式完整文件 + 审阅过的完整源码身份；未知能力不自动猜成离线。 */
export function validateIsolatedSelection(
  resource: IsolatedResource,
  files: readonly string[],
  universe: readonly string[],
  digest: string,
  env: NodeJS.ProcessEnv,
) {
  if (digest !== resource.sourceDigest) throw new Error('离线能力审阅的源码摘要已过期');
  if (!files.length || new Set(files).size !== files.length)
    throw new Error('必须提供非空、不重复的完整测试文件清单');
  for (const file of files) {
    if (!universe.includes(file) || !resource.offlineFiles.includes(file) || needsPg(file))
      throw new Error(`文件未获本地离线能力确认或需要真实 PG：${file}`);
  }
  const selected = universe.filter((f) => files.some((p) => f.toLowerCase().includes(p.toLowerCase())));
  if (selected.length !== files.length || selected.some((f) => !files.includes(f)))
    throw new Error('Vitest 子串过滤会额外拉入未指定文件，请明确列全');
  const db = Object.keys(env).find(
    (key) => /^(?:DATABASE_URL|FLEET_TEST_(?:REAL_)?PG_URL|PG[A-Z_]+)$/.test(key) && env[key]?.trim(),
  );
  if (db) throw new Error(`隔离资源不能继承数据库请求：${db}；请使用原 PG 验证路径`);
  if (env.CI && !['0', 'false'].includes(env.CI.toLowerCase()))
    throw new Error('隔离资源仅用于显式本机验收，不代替 CI');
}

export function receiptLine(stdout: string, prefix: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) throw new Error(`未获得唯一完整回执：${prefix}`);
  return line.slice(prefix.length);
}

export function verifyResourceReceipt(raw: string, resource: IsolatedResource, status: number | null) {
  const r = JSON.parse(raw);
  if (
    r.schema !== 1 ||
    r.helperSha256 !== resource.helperSha256 ||
    r.uid !== resource.uid ||
    typeof r.parentNetns !== 'string' ||
    !/^net:\[\d+\]$/.test(r.netns) ||
    r.parentNetns === r.netns ||
    typeof r.parentPidns !== 'string' ||
    !/^pid:\[\d+\]$/.test(r.pidns) ||
    r.parentPidns === r.pidns ||
    r.capEff !== '0000000000000000' ||
    r.noNewPrivs !== 1 ||
    r.closed !== true ||
    r.remaining !== 0 ||
    r.orphaned !== false ||
    r.cancelled !== false ||
    r.timedOut !== false ||
    r.payloadDelivered !== true ||
    r.status !== status
  )
    throw new Error('隔离资源身份、权限、关闭或退出回执不符');
  return r;
}

/** keepalive 管资源生存期；EOF、取消和宿主退出都不能让 Linux 服务无限留存。 */
export async function runIsolatedTests(
  root: string,
  resource: IsolatedResource,
  selected: string[],
  env = process.env,
  signal?: AbortSignal,
) {
  const evidence = createTestReport(root, selected, 'isolated-loopback');
  let result: { status: number | null; error?: Error } = { status: null };
  try {
    const files = snapshotSource(root);
    const digest = sourceDigest(files);
    const universe = listTestFiles(fsRepo(root));
    if (typeof universe === 'string') throw new Error(universe);
    validateIsolatedSelection(resource, selected, universe, digest, env);
    if (signal?.aborted) throw new Error('隔离资源启动前已取消');
    evidence.metadata.source = { kind: 'worktree-sha256', digest, files: files.length };
    const worker = readFileSync(join(root, 'packages/conventions/src/isolated-test-worker.mjs'), 'utf8');
    const args = [...resource.runner.args, '--input-type=module', '-e', worker];
    evidence.metadata.commands.push({
      kind: 'isolated-loopback',
      command: resource.runner.command,
      args: resource.runner.args,
      startedAt: new Date().toISOString(),
      status: null,
    });
    const command = evidence.metadata.commands[0];
    if (!command) throw new Error('隔离资源执行元数据未登记');
    evidence.save();
    const rawPaths = {
      stdout: evidence.path('resource-stdout.bin'),
      stderr: evidence.path('resource-stderr.bin'),
    };
    writeFileSync(rawPaths.stdout, '');
    writeFileSync(rawPaths.stderr, '');
    const child = spawn(resource.runner.command, args, {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let transportError: Error | undefined;
    let outputBytes = 0;
    let cancelled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (!child.stdin.destroyed) child.stdin.end('cancel\n');
      stopTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', (e) => {
      transportError ??= e;
    });
    child.on('error', (e) => {
      transportError ??= e;
    });
    const append = (kind: 'stdout' | 'stderr', value: Buffer) => {
      const remaining = Math.max(0, 128 * 1024 * 1024 - outputBytes);
      appendFileSync(rawPaths[kind], value.subarray(0, remaining));
      outputBytes += value.length;
      if (outputBytes > 128 * 1024 * 1024) {
        transportError ??= new Error('隔离资源输出超过既有 Linux 运输上限');
        cancel();
      }
    };
    child.stdout.on('data', (value) => append('stdout', value));
    child.stderr.on('data', (value) => append('stderr', value));
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.stdin.write(
      `${JSON.stringify({
        files,
        digest,
        tests: selected,
        dependencyRoot: resource.runner.dependencyRoot,
        tools: resource.tools,
      })}\n`,
    );
    const pulse = setInterval(() => {
      if (!cancelled && !child.stdin.destroyed) child.stdin.write('keepalive\n');
    }, 1000);
    const limit = setTimeout(cancel, ISOLATED_LIMIT_MS);
    let status: number | null;
    try {
      status = await closed;
    } finally {
      clearInterval(pulse);
      clearTimeout(limit);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', cancel);
    }
    command.status = status;
    command.endedAt = new Date().toISOString();
    // Raw bytes survive host termination and preserve WSL's mixed stderr encodings.
    const stdout = readFileSync(rawPaths.stdout).toString('utf8');
    const stderr = readFileSync(rawPaths.stderr).toString('utf8');
    writeFileSync(evidence.path('resource-stdout.log'), stdout);
    writeFileSync(evidence.path('resource-stderr.log'), stderr);
    if (stderr) process.stderr.write(stderr);
    const rawResource = receiptLine(stdout, RESOURCE_RECEIPT);
    writeFileSync(evidence.path('resource.json'), rawResource);
    evidence.metadata.reports.resource = 'invalid';
    verifyResourceReceipt(rawResource, resource, status);
    evidence.metadata.reports.resource = 'valid';
    if (cancelled || transportError) throw transportError ?? new Error('隔离资源已取消/到达运输上限');
    const rawLinux = receiptLine(stdout, LINUX_RECEIPT);
    writeFileSync(evidence.path('linux-receipt.json'), rawLinux);
    evidence.metadata.reports.linuxReceipt = 'invalid';
    const receipt = verifyLinuxReceipt(rawLinux, selected, digest, status);
    evidence.metadata.reports.linuxReceipt = 'valid';
    writeFileSync(evidence.path('linux.json'), JSON.stringify(receipt.report));
    process.stdout.write(
      stdout
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(LINUX_RECEIPT) && !line.startsWith(RESOURCE_RECEIPT))
        .join('\n'),
    );
    const after = sourceDigest(snapshotSource(root));
    evidence.metadata.sourceAfter = { digest: after, files: files.length };
    if (after !== digest) throw new Error('隔离测试期间工作树源码改变');
    result = { status };
  } catch (error) {
    result = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    evidence.finish(result);
  }
  return result;
}

export function parseIsolatedArgs(args: string[]) {
  if (args[0] !== '--resource' || !args[1] || !isAbsolute(args[1]) || args[2] !== '--' || args.length < 4)
    throw new Error('用法：pnpm test:isolated --resource <本机资源JSON绝对路径> -- <完整测试文件...>');
  return { resource: args[1], files: args.slice(3) };
}
