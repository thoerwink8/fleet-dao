// Windows 的本机选测：需要 Linux FD/进程语义的文件在显式配置的 Linux Node 下跑。
// 各平台先核所选真 Temporal 测试的 CLI；不安装 Linux、不跳过测试、不使用旧检出冒充当前源码。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRun } from './ci-box.ts';
import { fsRepo } from './repo.ts';
import { prepareTemporalCli, selectedNeedsTemporal } from './temporal-test-cli.ts';
import { listTestFiles } from './test-split.ts';

export const LINUX_TESTS = [
  'packages/engine/test/real/complex-preserve.test.ts',
  'packages/engine/test/real/github-ports.test.ts',
  'packages/engine/test/real/hourly-reconcile.test.ts',
  'packages/engine/test/real/preserve-worktree.test.ts',
] as const;

export interface LinuxRunner {
  command: string;
  args: string[];
  dependencyRoot: string;
}

export function parseLinuxRunner(text: string): LinuxRunner {
  const x = JSON.parse(text);
  if (
    !x ||
    typeof x !== 'object' ||
    Array.isArray(x) ||
    typeof x.command !== 'string' ||
    !x.command.trim() ||
    !Array.isArray(x.args) ||
    !x.args.every((a: unknown) => typeof a === 'string') ||
    typeof x.dependencyRoot !== 'string' ||
    !x.dependencyRoot.startsWith('/')
  )
    throw new Error('Linux runner 配置需要 command、args（Linux Node 的启动参数）和绝对 dependencyRoot');
  return { command: x.command, args: x.args, dependencyRoot: x.dependencyRoot };
}

export function splitLocalTests(universe: string[], filters: string[]) {
  const selected = universe.filter(
    (f) =>
      filters.length === 0 ||
      filters.some((p) => f.toLowerCase().includes(p.replaceAll('\\', '/').toLowerCase())),
  );
  return {
    linux: selected.filter((f) => (LINUX_TESTS as readonly string[]).includes(f)),
    native: selected.filter((f) => !(LINUX_TESTS as readonly string[]).includes(f)),
  };
}

export interface SourceFile {
  path: string;
  data: string;
  mode: number;
}
export function sourceDigest(files: SourceFile[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** 读取工作树字节，而非 HEAD archive：暂存/未暂存/新文件都在，已删的文件不复活。 */
export function snapshotSource(root: string): SourceFile[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`枚举当前源码失败：${r.error?.message ?? r.stderr}`);
  return [...new Set(r.stdout.split('\0').filter(Boolean))].sort().flatMap((path) => {
    const absolute = join(root, path);
    let ancestor = root;
    for (const part of path.split('/').slice(0, -1)) {
      ancestor = join(ancestor, part);
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
        throw new Error(`源码快照拒绝符号链接父目录：${path}`);
    }
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`源码快照拒绝符号链接：${path}`);
    if (!existsSync(absolute)) return [];
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`源码快照不支持目录或符号链接：${path}`);
    return [{ path, data: readFileSync(absolute).toString('base64'), mode: stat.mode & 0o777 }];
  });
}

type Result = { status: number | null; signal?: string | null; error?: Error | undefined };
const RECEIPT = 'FLEET_LINUX_TEST_RECEIPT=';

/** 运输成功不等于测试通过：复用 CI 的实际文件集核对，再核真实执行和退出码。 */
export function verifyLinuxReceipt(
  text: string,
  assigned: readonly string[],
  digest: string,
  status: number | null,
) {
  const receipt = JSON.parse(text);
  if (
    receipt.digest !== digest ||
    receipt.platform !== 'linux' ||
    !Number.isInteger(receipt.uid) ||
    receipt.uid <= 0 ||
    typeof receipt.root !== 'string' ||
    !receipt.root.startsWith('/')
  )
    throw new Error('Linux 回执的源码摘要/平台/普通用户不符');
  const report = receipt.report;
  if (!report || !Array.isArray(report.testResults)) throw new Error('Linux 没有 Vitest JSON 报告');
  const reported = new Set<string>(
    report.testResults.map((t: { name: string }) => {
      if (typeof t.name !== 'string' || !t.name.startsWith(`${receipt.root}/`))
        throw new Error('Linux 报告包含快照目录以外的文件');
      return t.name.slice(receipt.root.length + 1);
    }),
  );
  const verified = verifyRun({ assigned, mode: '', reported, stateText: undefined });
  if (!verified.ok) throw new Error(verified.problems.join('；'));
  if (!Number.isInteger(receipt.status) || receipt.status !== status)
    throw new Error('Linux 退出码与回执不符');
  const assertions = report.testResults.flatMap(
    (t: { assertionResults?: unknown[] }) => t.assertionResults ?? [],
  );
  if (
    report.numPendingTests !== 0 ||
    report.numTotalTests < 1 ||
    assertions.length !== report.numTotalTests ||
    assertions.some((a: { status?: string }) => a.status !== 'passed' && a.status !== 'failed')
  )
    throw new Error('Linux 安全测试有跳过或未执行');
  if (
    receipt.status === 0 &&
    (report.success !== true ||
      report.numFailedTests !== 0 ||
      assertions.some((a: { status?: string }) => a.status !== 'passed'))
  )
    throw new Error('Linux 退出成功但报告未通过');
  return receipt;
}

export function runLocalVitest(
  root: string,
  args: string[],
  env = process.env,
  platform = process.platform,
): Result {
  const direct = (argv: string[]) => {
    const r = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), ...argv], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    return { status: r.status, signal: r.signal, error: r.error };
  };
  let temporary: string | undefined;
  try {
    const universe = listTestFiles(fsRepo(root));
    if (typeof universe === 'string') throw new Error(universe);
    // 调用入口只传 run、文件过滤和 = 形式的 reporter/outputFile 选项。
    const filters = args.slice(1).filter((a) => !a.startsWith('--'));
    const split = splitLocalTests(universe, filters);
    if (selectedNeedsTemporal(fsRepo(root), [...split.native, ...split.linux])) {
      const cli = prepareTemporalCli(root, { env });
      env = { ...env, FLEET_TEST_TEMPORAL_CLI: cli.path };
      console.log(`Temporal preparation 通过：CLI=${cli.path} version=${cli.version}`);
    }
    if (platform !== 'win32') return direct(args);
    if (!split.linux.length) return direct(args);
    const config = env.FLEET_TEST_LINUX_RUNNER;
    if (!config)
      throw new Error(
        '这些测试依赖真实 Linux 安全归档/进程语义。先显式设置 FLEET_TEST_LINUX_RUNNER 为本机 runner JSON 文件，再执行 pnpm test:linux 或 pnpm check；未跑测试，不算通过',
      );
    const runner = parseLinuxRunner(readFileSync(config, 'utf8'));
    const files = snapshotSource(root);
    const digest = sourceDigest(files);
    const worker = readFileSync(join(root, 'packages/conventions/src/linux-test-worker.mjs'), 'utf8');
    console.log(`Linux 转交 ${split.linux.length} 个文件；当前工作树快照 sha256=${digest}`);
    const r = spawnSync(runner.command, [...runner.args, '--input-type=module', '-e', worker], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      input: JSON.stringify({ files, digest, tests: split.linux, dependencyRoot: runner.dependencyRoot }),
    });
    if (r.stderr) process.stderr.write(r.stderr);
    const start = r.stdout?.lastIndexOf(RECEIPT) ?? -1;
    if (start < 0)
      throw new Error(`Linux runner 没有真实测试回执：${r.error?.message ?? r.stdout ?? r.status}`);
    process.stdout.write(r.stdout.slice(0, start));
    const receipt = verifyLinuxReceipt(
      r.stdout.slice(start + RECEIPT.length).trim(),
      split.linux,
      digest,
      r.status,
    );
    const report = receipt.report;
    for (const t of report.testResults) t.name = join(root, t.name.slice(receipt.root.length + 1));
    let native: Result = { status: 0 };
    const output = args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
    if (split.native.length) {
      temporary = mkdtempSync(join(tmpdir(), 'fleet-native-tests-'));
      const json = join(temporary, 'result.json');
      native = direct([
        ...args.filter((a) => !a.startsWith('--reporter=') && !a.startsWith('--outputFile.json=')),
        ...split.linux.map((f) => `--exclude=${f}`),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${json}`,
      ]);
      const nativeReport = JSON.parse(readFileSync(json, 'utf8'));
      const nativeVerification = verifyRun({
        assigned: split.native,
        mode: '',
        reported: new Set(
          nativeReport.testResults.map((t: { name: string }) =>
            t.name.replaceAll('\\', '/').slice(root.replaceAll('\\', '/').replace(/\/$/, '').length + 1),
          ),
        ),
        stateText: undefined,
      });
      if (!nativeVerification.ok) throw new Error(nativeVerification.problems.join('；'));
      report.testResults.push(...nativeReport.testResults);
      for (const field of [
        'numTotalTests',
        'numPassedTests',
        'numFailedTests',
        'numPendingTests',
        'numTotalTestSuites',
        'numPassedTestSuites',
        'numFailedTestSuites',
        'numPendingTestSuites',
      ])
        report[field] += nativeReport[field];
      report.success = report.success && nativeReport.success;
    }
    // check --all 的重试仍从同一份失败文件清单读取，Linux 路径转换回本机树。
    if (output) writeFileSync(output, JSON.stringify(report));
    if (sourceDigest(snapshotSource(root)) !== digest)
      throw new Error('测试期间当前工作树源码发生变化；本次结果不能证明新源码通过，请重新执行 pnpm check');
    return native.status !== 0 || native.error ? native : { status: receipt.status };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
