// 由本机检查入口通过显式配置的 Linux Node 启动；stdin 只含本次源码快照。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

let root;
try {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0)
    throw new Error('需要真实 Linux 普通用户；root 无法验证权限拒绝断言');
  if (!existsSync('/proc/self/fd')) throw new Error('Linux runner 缺少 /proc/self/fd');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22))
    throw new Error('Linux Node 需要 >=22.22，与仓根 engines 一致');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(input.files)).digest('hex');
  if (digest !== input.digest) throw new Error('源码快照摘要不符');
  root = mkdtempSync(join(tmpdir(), 'fleet-current-source-'));
  const manifests = [];
  for (const file of input.files) {
    const target = resolve(root, file.path);
    if (
      !target.startsWith(`${root}/`) ||
      file.path.split('/').includes('node_modules') ||
      file.path.split('/').includes('.git')
    )
      throw new Error(`非法快照路径：${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    const data = Buffer.from(file.data, 'base64');
    writeFileSync(target, data, { mode: file.mode });
    if (
      file.path === 'pnpm-lock.yaml' ||
      file.path === 'pnpm-workspace.yaml' ||
      file.path.endsWith('package.json')
    ) {
      const installed = readFileSync(join(input.dependencyRoot, file.path));
      const dependencyFields = (bytes) => {
        const value = JSON.parse(bytes.toString());
        return JSON.stringify(
          [
            'name',
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
            'pnpm',
            'packageManager',
          ].map((key) => value[key] ?? null),
        );
      };
      const same = file.path.endsWith('package.json')
        ? dependencyFields(installed) === dependencyFields(data)
        : installed.equals(data);
      if (!same)
        throw new Error(
          `Linux 依赖与当前源码不一致：${file.path}；先在该 Linux 依赖目录 pnpm install --frozen-lockfile`,
        );
      if (file.path.endsWith('package.json')) manifests.push(file.path);
    }
  }
  const workspace = new Map(
    manifests.map((path) => [JSON.parse(readFileSync(join(root, path), 'utf8')).name, dirname(path)]),
  );
  for (const manifest of manifests) {
    const installed = join(input.dependencyRoot, dirname(manifest), 'node_modules');
    if (!existsSync(installed)) continue;
    const target = join(root, dirname(manifest), 'node_modules');
    mkdirSync(target, { recursive: true });
    const link = (name) => {
      const source = join(installed, name);
      const packageDir = workspace.get(name);
      // 每个 workspace 包一律指向本次快照，绝不沿旧依赖根的 workspace symlink 回旧源码。
      const destination = packageDir === undefined ? realpathSync(source) : join(root, packageDir);
      if (packageDir === undefined && destination.startsWith(`${input.dependencyRoot}/packages/`))
        throw new Error(`未识别的 workspace 链接：${name}`);
      symlinkSync(destination, join(target, name), 'dir');
    };
    for (const name of readdirSync(installed)) {
      if (name === '.bin') continue;
      if (name.startsWith('@')) {
        mkdirSync(join(target, name), { recursive: true });
        for (const child of readdirSync(join(installed, name))) link(`${name}/${child}`);
      } else link(name);
    }
  }
  const json = join(root, '.linux-result.json');
  const r = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      ...input.tests,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${json}`,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, VITEST_MAX_WORKERS: '1', FLEET_ENV: 'development' },
    },
  );
  if (r.error || r.status === null) throw r.error ?? new Error(`Vitest 被 ${r.signal} 中止`);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  console.log(
    `FLEET_LINUX_TEST_RECEIPT=${JSON.stringify({ platform: process.platform, uid: process.getuid(), digest, root, status: r.status, report })}`,
  );
  process.exitCode = r.status;
} catch (e) {
  console.error(`Linux 测试没跑成：${e instanceof Error ? e.message : e}`);
  process.exitCode = 2;
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
}
