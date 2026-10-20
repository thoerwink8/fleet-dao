import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { keyCovers, keyRoots, sourceClosure } from '../src/ci-cache.ts';
import { readGraph } from '../src/ci-plan.ts';
import { fsRepo } from '../src/repo.ts';
import {
  downloadTestServer,
  installTestServer,
  requireTestServer,
  type TestServerArtifact,
  testServerArtifact,
  testServerPath,
} from '../src/temporal-test-server.ts';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: run,
}));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-test-server-'));
  const a: TestServerArtifact = {
    archive: 'fixture.tar.gz',
    archiveSha: digest('trusted archive'),
    binarySha: digest('trusted binary'),
    member: 'fixture/server',
  };
  const download = vi.fn(async (_url: string, path: string) => {
    writeFileSync(path, 'trusted archive');
  });
  const extract = vi.fn((_archive: string, stage: string, member: string) => {
    mkdirSync(dirname(join(stage, member)), { recursive: true });
    writeFileSync(join(stage, member), 'trusted binary');
  });
  return { root, a, download, extract };
}
it('可信缓存命中无需联网；消费端重新核binary，不信元数据', async () => {
  const f = fixture();
  const path = await installTestServer(f.a, f.root, f);
  expect(requireTestServer(f.a, f.root)).toBe(path);
  expect(await installTestServer(f.a, f.root, f)).toBe(path);
  expect(f.download).toHaveBeenCalledTimes(1);
  writeFileSync(path, 'damaged');
  expect(() => requireTestServer(f.a, f.root)).toThrow('preparation 失败');
  await expect(installTestServer(f.a, f.root, f)).rejects.toThrow('已有缓存损坏');
  expect(readFileSync(path, 'utf8')).toBe('damaged');
  expect(f.download).toHaveBeenCalledTimes(1);
});
it.each(['archive', 'binary'])('损坏%s不发布、不留下半截目标', async (part) => {
  const f = fixture();
  const a = {
    ...f.a,
    ...(part === 'archive' ? { archiveSha: digest('bad') } : { binarySha: digest('bad') }),
  };
  await expect(installTestServer(a, f.root, f)).rejects.toThrow('SHA256');
  expect(existsSync(testServerPath(a, f.root))).toBe(false);
  expect(readdirSync(dirname(testServerPath(a, f.root)))).toEqual([]);
  if (part === 'archive') expect(f.extract).not.toHaveBeenCalled();
});
it('并发发布只接收已验证赢家，等待期间消费端拒绝缺失文件', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let downloading = 0;
  const download = async (url: string, path: string) => {
    downloading++;
    await gate;
    await f.download(url, path);
  };
  const first = installTestServer(f.a, f.root, { ...f, download });
  const second = installTestServer(f.a, f.root, { ...f, download });
  expect(downloading).toBe(2);
  expect(() => requireTestServer(f.a, f.root)).toThrow('没有可用');
  release();
  const paths = await Promise.all([first, second]);
  expect(paths[0]).toBe(paths[1]);
  expect(readFileSync(paths[0] as string, 'utf8')).toBe('trusted binary');
  expect(readdirSync(dirname(paths[0] as string))).toEqual(['server']);
});
it('发布时出现非可信赢家不能覆盖、删除或接收', async () => {
  const f = fixture();
  const extract = (...args: Parameters<typeof f.extract>) => {
    f.extract(...args);
    writeFileSync(testServerPath(f.a, f.root), 'foreign');
  };
  await expect(installTestServer(f.a, f.root, { ...f, extract })).rejects.toThrow('preparation 失败');
  expect(readFileSync(testServerPath(f.a, f.root), 'utf8')).toBe('foreign');
});
it('目录或链接不当作可信binary，拒绝且不删除目标', async () => {
  const f = fixture();
  const target = testServerPath(f.a, f.root);
  mkdirSync(target, { recursive: true });
  await expect(installTestServer(f.a, f.root, f)).rejects.toThrow('已有缓存损坏');
  const second = fixture();
  const linked = testServerPath(second.a, second.root);
  mkdirSync(dirname(linked), { recursive: true });
  // Windows junction 不需要创建 symlink 的管理员权限；目录链接同样必须拒绝。
  symlinkSync(target, linked, 'junction');
  await expect(installTestServer(second.a, second.root, second)).rejects.toThrow('已有缓存损坏');
  expect(existsSync(target)).toBe(true);
  expect(second.download).not.toHaveBeenCalled();
});
it('curl有硬期限与有限429重试，失败保留原始原因、不启动提取', async () => {
  run.mockImplementation((_cmd, _args, _options, callback) =>
    callback(Object.assign(new Error('curl failed'), { code: 22 }), '', 'curl: (22) 429 Too Many Requests'),
  );
  await expect(downloadTestServer('https://fixture.invalid/a', '/fixture/out')).rejects.toThrow(
    '429 Too Many Requests',
  );
  expect(run).toHaveBeenCalledWith(
    'curl',
    expect.arrayContaining(['--retry', '2', '--max-time', '25', '--retry-max-time', '55']),
    expect.objectContaining({ timeout: 90_000, killSignal: 'SIGKILL' }),
    expect.any(Function),
  );
  const f = fixture();
  const failed = vi.fn(async () => {
    throw new Error('429 Too Many Requests');
  });
  await expect(installTestServer(f.a, f.root, { ...f, download: failed })).rejects.toThrow(
    '429 Too Many Requests',
  );
  expect(failed).toHaveBeenCalledTimes(1);
  expect(f.extract).not.toHaveBeenCalled();
  expect(existsSync(testServerPath(f.a, f.root))).toBe(false);
});
it('未知平台明确拒绝；每个受支持身份都有固定archive与binary SHA', () => {
  expect(() => testServerArtifact('freebsd', 'x64')).toThrow('未支持平台');
  for (const [os, arch] of [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
  ] as const) {
    const a = testServerArtifact(os, arch);
    expect(a.archiveSha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.binarySha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.archive).toContain('1.40.0');
  }
});

it('异步提取关闭回执之前不发布binary；等待成功回执后再校验、原子发布', async () => {
  const f = fixture();
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    run.mockImplementation((_cmd, args, _options, callback) => {
      finish = () => {
        f.extract(args[1], args[3], args[4]);
        callback(null, '', '');
      };
      resolve();
    });
  });
  const pending = installTestServer(f.a, f.root, { download: f.download });
  await started;
  expect(existsSync(testServerPath(f.a, f.root))).toBe(false);
  finish();
  expect(await pending).toBe(testServerPath(f.a, f.root));
  expect(requireTestServer(f.a, f.root)).toBe(testServerPath(f.a, f.root));
});

it('下载body或提取超时保留期限错误，不发布也不留后台等待', async () => {
  const timeout = Object.assign(new Error('fixture timed out'), { code: 'ETIMEDOUT' });
  run.mockImplementation((_cmd, _args, _options, callback) => callback(timeout, '', ''));
  await expect(
    downloadTestServer('https://fixture.invalid/body-hangs', '/fixture/out'),
  ).rejects.toMatchObject({ cause: timeout });
  const f = fixture();
  await expect(installTestServer(f.a, f.root, { download: f.download })).rejects.toThrow('timed out');
  expect(run.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 30_000, killSignal: 'SIGKILL' });
  expect(existsSync(testServerPath(f.a, f.root))).toBe(false);
});

it('engine测试结果缓存自然覆盖manifest与准备入口，CI所有测试台无条件准备', () => {
  const repo = fsRepo(fileURLToPath(new URL('../../../', import.meta.url)));
  const graph = readGraph(repo);
  if (typeof graph === 'string') throw new Error(graph);
  const roots = keyRoots(['engine'], sourceClosure(graph, ['engine']));
  expect(keyCovers(roots, 'packages/conventions/src/temporal-test-server.ts')).toBe(true);
  expect(keyCovers(roots, 'packages/conventions/src/bin/test-temporal-server.ts')).toBe(true);
  const workflow = repo.read('.github/workflows/ci.yml');
  const parsed = parse(workflow ?? '') as { jobs: { test: { steps: Record<string, unknown>[] } } };
  const preparation = parsed.jobs.test.steps.find((step) => String(step.name).startsWith('准备时间跳跃服务'));
  expect(preparation).toBeDefined();
  expect(preparation?.run).toBe('pnpm test:temporal-server');
  expect(preparation).not.toHaveProperty('if');
  expect(workflow).toContain("hashFiles('packages/conventions/src/temporal-test-server.ts')");
});

it('两个同时活着的 OS 进程竞争发布同一制品，不读半截，两个都核验相同binary', {
  timeout: 15_000,
}, async () => {
  const f = fixture();
  const moduleUrl = new URL('../src/temporal-test-server.ts', import.meta.url).href;
  const source = `import {installTestServer} from ${JSON.stringify(moduleUrl)};
    import{writeFileSync,mkdirSync}from'node:fs';import{dirname,join}from'node:path';
    const a=${JSON.stringify(f.a)},root=${JSON.stringify(f.root)};
    const path=await installTestServer(a,root,{
      download:async(_url,path)=>{process.send('ready');await new Promise(resolve=>process.once('message',resolve));writeFileSync(path,'trusted archive');},
      extract:(_archive,stage,member)=>{mkdirSync(dirname(join(stage,member)),{recursive:true});writeFileSync(join(stage,member),'trusted binary');}
    });process.send({path});process.disconnect();`;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  );
  const pending = children.map(
    (child) =>
      new Promise<{ path: string }>((resolve, reject) => {
        let result: { path: string } | undefined;
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('message', (message) => {
          if (typeof message === 'object' && message && 'path' in message)
            result = message as { path: string };
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 && result ? resolve(result) : reject(new Error(`child exit=${code}: ${stderr}`)),
        );
      }),
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once('message', (msg) => (msg === 'ready' ? resolve() : reject(new Error('unknown ready'))));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('child exited before ready')));
      }),
  );
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 10_000);
  try {
    await Promise.all(ready);
    expect(children[0]?.pid).not.toBe(children[1]?.pid);
    expect(() => requireTestServer(f.a, f.root)).toThrow('没有可用');
    for (const child of children) child.send('release');
    const result = await Promise.all(pending);
    expect(result[0]?.path).toBe(result[1]?.path);
    expect(requireTestServer(f.a, f.root)).toBe(result[0]?.path);
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});
