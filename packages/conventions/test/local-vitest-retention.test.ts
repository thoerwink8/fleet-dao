import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { vitestAllStep } from '../src/check-vitest.ts';
import { LINUX_TESTS, runLocalVitest } from '../src/local-vitest.ts';
import { runChild } from './child.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-report-retention-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/conventions/test'), { recursive: true });
  mkdirSync(join(root, 'agents/test'), { recursive: true });
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n_tmp/\n');
  writeFileSync(join(root, 'packages/conventions/test/native.test.ts'), 'source dirty v1');
  writeFileSync(
    join(root, 'node_modules/vitest/vitest.mjs'),
    `
import{writeFileSync}from'node:fs';import{join}from'node:path';
const mode=process.env.FIXTURE_MODE;if(mode==='fail')process.exitCode=1;const out=process.argv.find(x=>x.startsWith('--outputFile.json='))?.slice(18);
if(['missing','missing-zero','crash'].includes(mode)){if(mode==='crash'&&out)writeFileSync(out,'{interrupted');process.exitCode=mode==='missing-zero'?0:2;}else if(out){
 const report={success:mode!=='fail',numTotalTests:1,numPassedTests:mode==='fail'?0:1,numFailedTests:mode==='fail'?1:0,numPendingTests:0,numTotalTestSuites:1,numPassedTestSuites:mode==='fail'?0:1,numFailedTestSuites:mode==='fail'?1:0,numPendingTestSuites:0,testResults:[{name:join(process.cwd(),'packages/conventions/test/native.test.ts'),status:mode==='fail'?'failed':'passed',assertionResults:[{status:mode==='fail'?'failed':'passed',duration:51,failureMessages:mode==='fail'?['original failure']:[]}]}]};
 writeFileSync(out,mode==='bad'?'{raw broken':JSON.stringify(report));process.exitCode=mode==='fail'?1:0;
}
`,
  );
  expect(runChild('git', ['init'], { cwd: root }).status).toBe(0);
  expect(runChild('git', ['add', '.'], { cwd: root }).status).toBe(0);
  return root;
}

it.each(['junction', 'file'] as const)(
  'Windows报告入口拒绝已有_tmp %s，外部内容不变且不启动测试',
  { timeout: 0 },
  (kind) => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'fleet-report-outside-'));
    roots.push(outside);
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'outside must remain unchanged');
    const parent = join(root, '_tmp');
    if (kind === 'junction') symlinkSync(outside, parent, 'junction');
    else writeFileSync(parent, 'existing file must remain unchanged');

    const result = runLocalVitest(root, ['run', 'native.test.ts'], process.env, 'win32');
    expect(result.status).not.toBe(0);
    expect(result.error?.message).toContain('_tmp 必须是本树普通目录');
    let invoked = false;
    expect(() =>
      vitestAllStep(root, 'win32', () => {
        invoked = true;
        return { status: 0 };
      }).run(),
    ).toThrow('_tmp 必须是本树普通目录');
    expect(invoked).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside must remain unchanged');
    expect(readdirSync(outside)).toEqual(['sentinel.txt']);
    if (kind === 'file') expect(readFileSync(parent, 'utf8')).toBe('existing file must remain unchanged');
  },
);

it('Windows原生真实失败报告留在唯一目录，保留duration/failureMessages与非HEAD源码身份', {
  timeout: 0,
}, () => {
  const root = fixture();
  const result = runLocalVitest(
    root,
    ['run', 'native.test.ts'],
    { ...process.env, FIXTURE_MODE: 'fail', PRIVATE_TEST_SECRET: 'never-copy' },
    'win32',
  );
  expect(result.status).toBe(1);
  const dirs = readdirSync(join(root, '_tmp')).filter((x) => x.startsWith('local-vitest-'));
  expect(dirs).toHaveLength(1);
  const dir = join(root, '_tmp', dirs[0] ?? '');
  const report = JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8'));
  expect(report.testResults[0].assertionResults[0]).toMatchObject({
    duration: 51,
    failureMessages: ['original failure'],
  });
  const metadata = readFileSync(join(dir, 'metadata.json'), 'utf8');
  expect(metadata).not.toContain('never-copy');
  expect(JSON.parse(metadata)).toMatchObject({ source: { kind: 'worktree-sha256' }, result: { status: 1 } });
});

it.each(['missing', 'missing-zero', 'bad', 'crash'])(
  '缺失/坏报告%s不造绿，坏字节原样留下',
  { timeout: 0 },
  (mode) => {
    const root = fixture();
    const result = runLocalVitest(
      root,
      ['run', 'native.test.ts'],
      { ...process.env, FIXTURE_MODE: mode },
      'win32',
    );
    expect(result.error?.message).toContain('报告');
    expect(result.status).not.toBe(0);
    const [name] = readdirSync(join(root, '_tmp'));
    const dir = join(root, '_tmp', name ?? '');
    expect(JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')).reports.native).toBe(
      ['bad', 'crash'].includes(mode) ? 'invalid' : 'missing',
    );
    if (mode === 'bad') expect(readFileSync(join(dir, 'native.json'), 'utf8')).toBe('{raw broken');
    if (mode === 'crash') expect(readFileSync(join(dir, 'native.json'), 'utf8')).toBe('{interrupted');
  },
);

it('两次执行不互盖，源码改动对应不同digest，未收集环境', { timeout: 0 }, () => {
  const root = fixture();
  expect(runLocalVitest(root, ['run', 'native.test.ts'], process.env, 'win32').status).toBe(0);
  writeFileSync(join(root, 'packages/conventions/test/native.test.ts'), 'source dirty v2');
  expect(runLocalVitest(root, ['run', 'native.test.ts'], process.env, 'win32').status).toBe(0);
  const dirs = readdirSync(join(root, '_tmp'));
  expect(dirs).toHaveLength(2);
  const receipts = dirs.map((dir) =>
    JSON.parse(readFileSync(join(root, '_tmp', dir, 'metadata.json'), 'utf8')),
  );
  expect(new Set(receipts.map((x) => x.source.digest)).size).toBe(2);
  expect(
    receipts.every((x) => x.commands[0].startedAt && x.commands[0].endedAt && x.commands[0].status === 0),
  ).toBe(true);
});

it('check --all沿原withRetry只重试失败文件，首轮与重试各自报告和元数据不互盖', { timeout: 0 }, () => {
  const root = fixture();
  const phases: string[] = [];
  const result = vitestAllStep(root, 'win32', (args, phase) => {
    phases.push(phase);
    if (phase === 'retry') expect(args).toContain('packages/conventions/test/native.test.ts');
    return runLocalVitest(
      root,
      args,
      { ...process.env, FIXTURE_MODE: phase === 'first' ? 'fail' : 'pass' },
      'win32',
      phase,
    );
  }).run();
  expect(result).toMatchObject({ status: 0, rescued: ['packages/conventions/test/native.test.ts'] });
  expect(phases).toEqual(['first', 'retry']);
  const entries = readdirSync(join(root, '_tmp'));
  const firstRetry = entries.find((name) => name.startsWith('fleet-check-')) ?? '';
  expect(JSON.parse(readFileSync(join(root, '_tmp', firstRetry, 'result.json'), 'utf8')).success).toBe(false);
  expect(JSON.parse(readFileSync(join(root, '_tmp', firstRetry, 'retry.json'), 'utf8')).success).toBe(true);
  const receipts = entries
    .filter((name) => name.startsWith('local-vitest-'))
    .map((name) => JSON.parse(readFileSync(join(root, '_tmp', name, 'metadata.json'), 'utf8')));
  expect(receipts.map((x) => x.phase).sort()).toEqual(['first', 'retry']);
  expect(receipts.map((x) => x.result.status).sort()).toEqual([0, 1]);
});

it('混合Linux/native保留原始回执、native原字节和合并副本，失败退出码不被绿覆盖', { timeout: 0 }, () => {
  const root = fixture();
  const linux = LINUX_TESTS[0];
  mkdirSync(join(root, 'packages/engine/test/real'), { recursive: true });
  writeFileSync(join(root, linux), 'linux fixture source');
  mkdirSync(join(root, 'packages/conventions/src'), { recursive: true });
  writeFileSync(join(root, 'packages/conventions/src/linux-test-worker.mjs'), '// transport fixture');
  const runner = join(root, 'runner.mjs');
  writeFileSync(
    runner,
    `
import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));
const report={success:false,numTotalTests:1,numPassedTests:0,numFailedTests:1,numPendingTests:0,numTotalTestSuites:1,numPassedTestSuites:0,numFailedTestSuites:1,numPendingTestSuites:0,testResults:[{name:'/snapshot/'+input.tests[0],status:'failed',assertionResults:[{status:'failed',duration:77,failureMessages:['linux original failure']}]}]};
console.log('FLEET_LINUX_TEST_RECEIPT='+JSON.stringify({digest:input.digest,platform:'linux',uid:1000,root:'/snapshot',status:1,report}));process.exitCode=1;
`,
  );
  mkdirSync(join(root, '_tmp'), { recursive: true });
  const config = join(root, '_tmp/runner.json');
  writeFileSync(
    config,
    JSON.stringify({ command: process.execPath, args: [runner], dependencyRoot: '/deps' }),
  );
  const consumer = join(root, '_tmp/consumer.json');
  expect(
    runLocalVitest(
      root,
      ['run', `--outputFile.json=${consumer}`],
      { ...process.env, FLEET_TEST_LINUX_RUNNER: config },
      'win32',
    ).status,
  ).toBe(1);
  const [name] = readdirSync(join(root, '_tmp')).filter((name) => name.startsWith('local-vitest-'));
  const dir = join(root, '_tmp', name ?? '');
  const receipt = JSON.parse(readFileSync(join(dir, 'linux-receipt.json'), 'utf8'));
  expect(receipt.report.testResults[0].name).toBe(`/snapshot/${linux}`);
  expect(
    JSON.parse(readFileSync(join(dir, 'native.json'), 'utf8')).testResults[0].assertionResults[0].duration,
  ).toBe(51);
  const merged = JSON.parse(readFileSync(join(dir, 'merged.json'), 'utf8'));
  expect(merged.testResults[0].name).toBe(join(root, linux));
  expect(merged.numFailedTests).toBe(1);
  expect(merged.numPassedTests).toBe(1);
  expect(readFileSync(consumer, 'utf8')).toBe(readFileSync(join(dir, 'merged.json'), 'utf8'));
  expect(
    JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')).commands.map(
      (x: { kind: string }) => x.kind,
    ),
  ).toEqual(['linux', 'native']);
});

it('非Windows保持直接执行、原重试参数与临时清理合同', { timeout: 0 }, () => {
  const root = fixture();
  expect(
    runLocalVitest(root, ['run', 'native.test.ts'], { ...process.env, FIXTURE_MODE: 'fail' }, 'linux').status,
  ).toBe(1);
  expect(existsSync(join(root, '_tmp'))).toBe(false);
  let json = '';
  const result = vitestAllStep(root, 'linux', (args, phase) => {
    if (phase === 'first') {
      json = args.find((x) => x.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length) ?? '';
      writeFileSync(
        json,
        JSON.stringify({
          testResults: [{ name: join(root, 'packages/conventions/test/native.test.ts'), status: 'failed' }],
        }),
      );
      return { status: 1 };
    }
    expect(args).toEqual(['run', 'packages/conventions/test/native.test.ts']);
    return { status: 0 };
  }).run();
  expect(result.status).toBe(0);
  expect(existsSync(json)).toBe(false);
  expect(existsSync(join(root, '_tmp'))).toBe(false);
});
