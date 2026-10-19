import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { runLocalVitest } from '../src/local-vitest.ts';
import {
  prepareTemporalCli,
  registerTemporalCli,
  selectedNeedsTemporal,
  startTemporalTestEnvironment,
  temporalCliRegistration,
  temporalTestVersion,
} from '../src/temporal-test-cli.ts';
import { runChild } from './child.ts';
import { memRepo } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-temporal-preparation-'));
  roots.push(root);
  mkdirSync(join(root, 'deploy'));
  writeFileSync(join(root, 'deploy/france.sh'), 'TEMPORAL_CLI_VERSION=1.9.1\n');
  const home = join(root, 'home');
  const options = { home, env: {}, probe: vi.fn(() => 'temporal version 1.9.1 (Server 1.30.1, UI 2.39.0)') };
  return { root, home, options };
}

it('版本唯一来自部署固定值，缺失、重复或认不出都在准备阶段失败', () => {
  expect(temporalTestVersion(memRepo({ 'deploy/france.sh': 'TEMPORAL_CLI_VERSION=1.9.1\r\n' }))).toBe(
    '1.9.1',
  );
  for (const content of [
    '',
    'TEMPORAL_CLI_VERSION=latest',
    'TEMPORAL_CLI_VERSION=1.9.1\nTEMPORAL_CLI_VERSION=1.9.1',
    'TEMPORAL_CLI_VERSION=1.9.1\nTEMPORAL_CLI_VERSION=latest',
  ]) {
    expect(() => temporalTestVersion(memRepo({ 'deploy/france.sh': content }))).toThrow('preparation');
  }
  expect(() => temporalTestVersion(memRepo({}))).toThrow('读不到');
});

it('缺登记、坏JSON、旧版本、相对路径、文件不存在和目录都明确失败', () => {
  const { root, home, options } = fixture();
  expect(() => prepareTemporalCli(root, options)).toThrow('pnpm test:temporal --cli');
  const registration = temporalCliRegistration(home);
  mkdirSync(join(home, '.fleet-dao', 'test-tools'), { recursive: true });
  for (const content of [
    'bad json',
    '{}',
    JSON.stringify({ schema: 1, path: process.execPath, version: '1.9.0' }),
  ]) {
    writeFileSync(registration, content);
    expect(() => prepareTemporalCli(root, options)).toThrow('preparation');
  }
  for (const path of ['temporal', join(root, 'absent.exe'), root]) {
    expect(() => prepareTemporalCli(root, { ...options, env: { FLEET_TEST_TEMPORAL_CLI: path } })).toThrow(
      'preparation',
    );
  }
  expect(options.probe).not.toHaveBeenCalled();
});

it('显式路径不退回登记；错版本、伪前缀或预发布都不能冒充固定版本', () => {
  const { root, options } = fixture();
  registerTemporalCli(root, process.execPath, options);
  expect(() =>
    prepareTemporalCli(root, { ...options, env: { FLEET_TEST_TEMPORAL_CLI: join(root, 'missing') } }),
  ).toThrow('路径不可用');
  for (const output of [
    'temporal version 1.9.10',
    'temporal version 1.9.1-rc.1',
    'not temporal version 1.9.1',
    'v1.9.1',
  ]) {
    expect(() => prepareTemporalCli(root, { ...options, probe: () => output })).toThrow('版本须为 1.9.1');
  }
});

it('登记现有CLI后自动读取、每次重新核版本，核验失败保留旧登记，CI只认显式路径', () => {
  const { root, home, options } = fixture();
  const expected = { path: process.execPath, version: '1.9.1' };
  expect(registerTemporalCli(root, process.execPath, options)).toEqual(expected);
  const before = readFileSync(temporalCliRegistration(home), 'utf8');
  expect(prepareTemporalCli(root, options)).toEqual(expected);
  expect(options.probe).toHaveBeenCalledTimes(2);
  expect(() =>
    registerTemporalCli(root, process.execPath, { ...options, probe: () => 'temporal version 1.8.0' }),
  ).toThrow('版本须为');
  expect(readFileSync(temporalCliRegistration(home), 'utf8')).toBe(before);
  expect(() => prepareTemporalCli(root, { ...options, env: { CI: 'true' } })).toThrow('CI 没给');
  expect(
    prepareTemporalCli(root, { ...options, env: { CI: 'true', FLEET_TEST_TEMPORAL_CLI: process.execPath } }),
  ).toEqual(expected);
});

it('沿用能力标记，只读实际已选文件；未选真服务端不触发准备，读失败不当作无需服务', () => {
  const repo = memRepo({
    'plain.test.ts': 'createEnv()',
    'real.test.ts': ['createRealEnv', '()'].join(''),
  });
  expect(selectedNeedsTemporal(repo, ['plain.test.ts'])).toBe(false);
  expect(selectedNeedsTemporal(repo, [])).toBe(false);
  expect(selectedNeedsTemporal(repo, ['real.test.ts'])).toBe(true);
  expect(() => selectedNeedsTemporal(repo, ['real.test.ts', 'missing.test.ts'])).toThrow('读不到已选测试');
});

it('真实探测进程正常退出只透传 --version，非零退出及起不来都报 preparation', { timeout: 0 }, () => {
  const result = probeChild(`
    const execute = script => temporalVersionOutput(process.execPath, 5_000, (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['--version']);
      assert.equal(options.shell, false);
      return spawnSync(process.execPath, ['-e', script, '--', ...args], options);
    });
    assert.equal(execute("console.log('temporal version 1.9.1')"), 'temporal version 1.9.1');
    assert.throws(() => execute("console.error('fixture-denied'); process.exitCode = 9"), /exit=9/);
    assert.throws(() => temporalVersionOutput(${JSON.stringify(join(tmpdir(), 'fleet-does-not-exist-temporal.exe'))}), /preparation/);
    console.log('probe cases passed');
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('probe cases passed');
});

it('卡住的真实版本探测被有界终止并保留 ETIMEDOUT 原因，不留迟到运行的进程', { timeout: 0 }, () => {
  const result = probeChild(`
    let pid = 0;
    let failure;
    try {
      temporalVersionOutput(process.execPath, 500, (_command, _args, options) => {
        const result = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        pid = result.pid;
        return result;
      });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /500ms/);
    assert.equal(failure.cause?.code, 'ETIMEDOUT');
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0));
    console.log(JSON.stringify({ pid, code: failure.cause.code }));
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ pid: expect.any(Number), code: 'ETIMEDOUT' });
});

function probeChild(source: string) {
  const module = fileURLToPath(new URL('../src/temporal-test-cli.ts', import.meta.url));
  return runChild(process.execPath, ['--input-type=module'], {
    input: `
      import assert from 'node:assert/strict';
      import {spawnSync} from 'node:child_process';
      import {pathToFileURL} from 'node:url';
      const {temporalVersionOutput} = await import(pathToFileURL(${JSON.stringify(module)}).href);
      ${source}
    `,
  });
}

it('SDK创建保留同一资源与原错误，准确报合并阶段，只尝试一次', async () => {
  const cli = { path: process.execPath, version: '1.9.1' };
  const environment = { teardown: vi.fn() };
  const start = vi.fn(async () => environment);
  const log = vi.fn();
  expect(await startTemporalTestEnvironment(cli, start, log)).toBe(environment);
  expect(start).toHaveBeenCalledExactlyOnceWith(cli.path);
  expect(environment.teardown).not.toHaveBeenCalled();
  expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('细分阶段未知');
  const original = new Error('native refused');
  const reject = vi.fn(async () => {
    throw original;
  });
  await expect(startTemporalTestEnvironment(cli, reject, log)).rejects.toMatchObject({
    cause: original,
    message: expect.stringContaining('start-or-connect 失败'),
  });
  expect(reject).toHaveBeenCalledTimes(1);
});

it('正规选测只为真正选到的文件准备 CLI；缺 CLI 在启动 Vitest 前失败', { timeout: 0 }, () => {
  const { root } = fixture();
  const testRoot = join(root, 'packages/example/test');
  const vitestRoot = join(root, 'node_modules/vitest');
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(root, 'agents/test'), { recursive: true });
  mkdirSync(vitestRoot, { recursive: true });
  writeFileSync(join(testRoot, 'plain.test.ts'), 'createEnv()');
  writeFileSync(join(testRoot, 'real.test.ts'), ['createRealEnv', '()'].join(''));
  const executed = join(root, 'executed');
  writeFileSync(
    join(vitestRoot, 'vitest.mjs'),
    `import{writeFileSync}from'node:fs';import{join}from'node:path';
     writeFileSync(${JSON.stringify(executed)}, 'ran');
     const output=process.argv.find(arg=>arg.startsWith('--outputFile.json='))?.slice(18);
     if(output)writeFileSync(output,JSON.stringify({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,testResults:[{name:join(process.cwd(),'packages/example/test/plain.test.ts'),status:'passed',assertionResults:[{status:'passed'}]}]}));`,
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n_tmp/\nexecuted\n');
  expect(runChild('git', ['init'], { cwd: root }).status).toBe(0);
  expect(runChild('git', ['add', '.'], { cwd: root }).status).toBe(0);
  // 显式坏路径排除机器原有登记的影响；plain 不应碰它。
  const env = { ...process.env, FLEET_TEST_TEMPORAL_CLI: join(root, 'absent-cli') };
  expect(runLocalVitest(root, ['run', 'plain.test.ts'], env).status).toBe(0);
  expect(existsSync(executed)).toBe(true);
  rmSync(executed);
  for (const platform of ['win32', 'linux'] as const) {
    const result = runLocalVitest(root, ['run', 'real.test.ts'], env, platform);
    expect(result.error?.message).toContain('Temporal preparation');
    expect(result.status).toBeNull();
    expect(existsSync(executed)).toBe(false);
  }
});
