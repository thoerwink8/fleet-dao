import { expect, it } from 'vitest';
import {
  parseIsolatedArgs,
  parseIsolatedResource,
  receiptLine,
  validateIsolatedSelection,
  verifyResourceReceipt,
} from '../src/isolated-test.ts';

const first = 'packages/engine/test/example.test.ts';
const second = 'packages/engine/test/other.test.ts';
const sha = 'a'.repeat(64);
const make = () => ({
  schema: 1,
  runner: { command: 'wsl.exe', args: ['explicit-helper', '/node'], dependencyRoot: '/deps' },
  uid: 1000,
  helperSha256: sha,
  sourceDigest: sha,
  offlineFiles: [first, second],
  tools: {
    nodeVersion: 'v22.23.2',
    sdkVersion: '1.24.0',
    cli: { path: '/tools/temporal', version: '1.9.1', sha256: sha },
    testServer: { path: '/tmp/temporal-test-server-sdk-typescript-1.24.0', sha256: sha },
  },
});
const resource = () => parseIsolatedResource(JSON.stringify(make()));

it('资源固定源码、完整离线文件、普通 UID 与已准备工具；未知不猜', () => {
  expect(resource().uid).toBe(1000);
  const good = make();
  for (const value of [
    {},
    { ...good, uid: 0 },
    { ...good, sourceDigest: 'old' },
    { ...good, offlineFiles: [] },
    { ...good, offlineFiles: [first, first] },
    { ...good, offlineFiles: ['packages/engine/'] },
    { ...good, tools: { ...good.tools, cli: { ...good.tools.cli, sha256: 'unknown' } } },
    { ...good, tools: { ...good.tools, cli: { ...good.tools.cli, path: '/tools/../temporal' } } },
  ])
    expect(() => parseIsolatedResource(JSON.stringify(value))).toThrow();
});

it('过期审阅、未列明文件、真实 PG、额外子串文件与数据库环境均明确拒跑', () => {
  const check = (files = [first], universe = [first, second], digest = sha, env = {}) =>
    validateIsolatedSelection(resource(), files, universe, digest, env);
  expect(() => check()).not.toThrow();
  for (const run of [
    () => check([], []),
    () => check([first, first]),
    () => check([first], [first], 'b'.repeat(64)),
    () => check(['packages/engine/test/unknown.test.ts'], ['packages/engine/test/unknown.test.ts']),
    () => check([first], [first, `${first}x`]),
    () => check([first], [first], sha, { FLEET_TEST_PG_URL: 'postgres://requested' }),
    () => check([first], [first], sha, { DATABASE_URL: 'postgres://requested' }),
    () => check([first], [first], sha, { CI: 'true' }),
    () => {
      const r = resource();
      r.offlineFiles = ['packages/db/test/migrate.test.ts'];
      validateIsolatedSelection(r, r.offlineFiles, r.offlineFiles, sha, {});
    },
  ])
    expect(run).toThrow();
});

it('只有唯一回执且真实降权、不同 namespace、无孤儿并关闭才可验测试结果', () => {
  const r = resource();
  const good = {
    schema: 1,
    helperSha256: sha,
    uid: 1000,
    parentNetns: 'net:[1]',
    netns: 'net:[2]',
    parentPidns: 'pid:[3]',
    pidns: 'pid:[4]',
    capEff: '0000000000000000',
    noNewPrivs: 1,
    closed: true,
    orphaned: false,
    remaining: 0,
    cancelled: false,
    timedOut: false,
    payloadDelivered: true,
    status: 0,
  };
  expect(verifyResourceReceipt(JSON.stringify(good), r, 0).closed).toBe(true);
  for (const bad of [
    { ...good, uid: 0 },
    { ...good, netns: good.parentNetns },
    { ...good, pidns: good.parentPidns },
    { ...good, helperSha256: 'wrong' },
    { ...good, capEff: '0000000000000001' },
    { ...good, noNewPrivs: 0 },
    { ...good, closed: false },
    { ...good, remaining: 1 },
    { ...good, orphaned: true },
    { ...good, cancelled: true },
    { ...good, timedOut: true },
    { ...good, payloadDelivered: false },
    { ...good, status: 1 },
  ])
    expect(() => verifyResourceReceipt(JSON.stringify(bad), r, 0)).toThrow();
  expect(receiptLine('noise\nR={}\n', 'R=')).toBe('{}');
  expect(() => receiptLine('R={}\nR={}\n', 'R=')).toThrow();
  expect(() => receiptLine('no report', 'R=')).toThrow();
});

it('入口只收显式绝对资源与完整文件，不支持 all、目录或缺失清单', () => {
  const absolute = process.platform === 'win32' ? 'C:/resource.json' : '/resource.json';
  expect(parseIsolatedArgs(['--resource', absolute, '--', first]).files).toEqual([first]);
  for (const args of [[], ['--all'], ['--resource', 'relative', '--', first], ['--resource', absolute, '--']])
    expect(() => parseIsolatedArgs(args)).toThrow();
});
