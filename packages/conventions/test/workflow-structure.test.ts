// ci.yml 的结构化比对（src/workflow-structure.ts）：碰到信任的每一类都要抓到，不碰信任的提速改动一律放过。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workflowDiff } from '../src/workflow-structure.ts';

const REAL = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

const BASE = [
  'name: ci',
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize]',
  'permissions:',
  '  contents: read',
  'concurrency:',
  '  group: ci-x',
  'jobs:',
  '  test:',
  '    needs: changes',
  "    if: needs.changes.outputs.tests != '[]'",
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 10',
  '    strategy:',
  '      matrix:',
  '        shard: [1, 2, 3]',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with:',
  '          persist-credentials: false',
  '      - name: 测试',
  '        run: pnpm exec vitest run',
  '  changes:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: node ci-plan.ts',
  '  check:',
  '    if: always()',
  '    needs: [changes, test]',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: node ci-verdict.ts',
  '',
].join('\n');

const swap = (from: string, to: string) => {
  if (!BASE.includes(from)) throw new Error(`样本里没有「${from}」，测试写错了`);
  return BASE.replace(from, to);
};

describe('不碰信任的改动：放过（这是提速改动的常态）', () => {
  it('一字没改：空', async () => {
    expect(await workflowDiff(BASE, BASE)).toEqual([]);
  });

  it('超时、分台（matrix）、步骤名字、注释、键的先后、加一步普通命令：都是空', async () => {
    for (const after of [
      swap('timeout-minutes: 10', 'timeout-minutes: 15'),
      swap('shard: [1, 2, 3]', 'shard: [1, 2, 3, 4, 5, 6]'),
      swap('- name: 测试', '- name: 跑测试'),
      swap('name: ci', 'name: ci\n# 只加一行注释'),
      swap(
        '    runs-on: ubuntu-latest\n    timeout-minutes: 10',
        '    timeout-minutes: 10\n    runs-on: ubuntu-latest',
      ),
      swap(
        '        run: pnpm exec vitest run',
        '        run: pnpm exec vitest run\n      - run: echo 多一步',
      ),
      swap('        run: pnpm exec vitest run', '        run: pnpm exec vitest run --reporter=dot'),
    ]) {
      expect(await workflowDiff(BASE, after), after).toEqual([]);
    }
  });

  it('真 ci.yml 跟自己比、只改它的超时：空（拿真文件确认这些比对项不会把日常改动全拦下）', async () => {
    expect(await workflowDiff(REAL, REAL)).toEqual([]);
    const tweaked = REAL.replace(
      /timeout-minutes: (\d+)/,
      (_m, n: string) => `timeout-minutes: ${Number(n) + 5}`,
    );
    expect(tweaked).not.toBe(REAL);
    expect(await workflowDiff(REAL, tweaked)).toEqual([]);
  });
});

describe('【故意造出的失败】碰到信任的每一类：都要抓到，并说清是哪一类', () => {
  const cases: [string, string, string][] = [
    ['权限放宽', swap('contents: read', 'contents: write'), '顶层 permissions'],
    ['权限键名加引号也一样', swap('contents: read', '"contents": write'), '顶层 permissions'],
    ['加触发事件', swap('  pull_request:\n', '  pull_request:\n  workflow_dispatch:\n'), '顶层 on'],
    ['改触发过滤', swap('types: [opened, synchronize]', 'types: [opened, synchronize, edited]'), '顶层 on'],
    ['改并发组', swap('group: ci-x', 'group: ci-y'), '顶层 concurrency'],
    ['加顶层环境变量', swap('concurrency:', 'env:\n  X: "1"\nconcurrency:'), '顶层 env'],
    [
      '新增 job',
      `${BASE}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`,
      '新增 job：extra',
    ],
    [
      '删掉 job',
      swap('  changes:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node ci-plan.ts\n', ''),
      '删了 job：changes',
    ],
    ['改 job 的 if', swap("if: needs.changes.outputs.tests != '[]'", 'if: false'), 'job test 的 if'],
    ['改 needs', swap('needs: [changes, test]', 'needs: [changes]'), 'job check 的 needs'],
    [
      '换机器',
      swap('    timeout-minutes: 10', '    timeout-minutes: 10').replace(
        'runs-on: ubuntu-latest',
        'runs-on: self-hosted',
      ),
      'runs-on',
    ],
    [
      '给 job 加权限',
      swap('    timeout-minutes: 10', '    timeout-minutes: 10\n    permissions:\n      contents: write'),
      'job test 的 permissions',
    ],
    ['换 action', swap('actions/checkout@v4', 'evil/checkout@v1'), '步骤用到的 action'],
    [
      '加一个 action 步骤',
      swap('      - name: 测试', '      - uses: some/action@v1\n      - name: 测试'),
      '步骤用到的 action',
    ],
    ['检出带上令牌', swap('persist-credentials: false', 'persist-credentials: true'), '检出方式'],
    [
      '检出换成别的提交（卫生检查就可能跑 PR 自己的代码）',
      swap(
        '          persist-credentials: false',
        '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}',
      ),
      '检出方式',
    ],
    [
      '检出换目录',
      swap(
        '          persist-credentials: false',
        '          persist-credentials: false\n          path: trusted',
      ),
      '检出方式',
    ],
    [
      '步骤放过失败',
      swap('      - name: 测试\n', '      - name: 测试\n        continue-on-error: true\n'),
      'continue-on-error',
    ],
    [
      '步骤加 if',
      swap('      - name: 测试\n', "      - name: 测试\n        if: github.event_name == 'push'\n"),
      'if',
    ],
    ['检查命令换成别的', swap('run: pnpm exec vitest run', 'run: echo 跳过'), '检查命令「vitest」'],
    ['汇总脚本改了', swap('run: node ci-verdict.ts', 'run: node ci-verdict.ts || true'), '汇总判红的脚本'],
    [
      '往步骤输出里写东西',
      swap('run: node ci-plan.ts', 'run: node ci-plan.ts && echo "tests=[]" >> "$GITHUB_OUTPUT"'),
      'GITHUB_OUTPUT',
    ],
    ['用上密钥', swap('run: pnpm exec vitest run', 'run: pnpm exec vitest run ${{ secrets.X }}'), 'secrets.'],
  ];
  for (const [what, after, expected] of cases) {
    it(what, async () => {
      const got = await workflowDiff(BASE, after);
      expect(Array.isArray(got), String(got)).toBe(true);
      expect((got as string[]).join('；')).toContain(expected);
    });
  }

  it('真 ci.yml 上动一处权限、删一个 job：都抓到', async () => {
    const perm = REAL.replace('permissions:\n  contents: read', 'permissions:\n  contents: write');
    expect(perm).not.toBe(REAL);
    expect(((await workflowDiff(REAL, perm)) as string[]).join('；')).toContain('顶层 permissions');
    const noWeb = REAL.replace(/\n {2}web:\n[\s\S]*?(?=\n {2}[\w-]+:\n)/, '\n');
    expect(noWeb).not.toBe(REAL);
    expect(((await workflowDiff(REAL, noWeb)) as string[]).join('；')).toContain('删了 job：web');
  });
});

describe('【故意造出的失败】读不懂：回一句话（调用方当「碰了」），不当成「没变」', () => {
  it('YAML 坏了、顶层不是键值对、没有 jobs', async () => {
    expect(await workflowDiff(BASE, 'jobs: [: :')).toMatch(/改动后的工作流读不懂/);
    expect(await workflowDiff('- a\n- b\n', BASE)).toMatch(/改动前的工作流顶层不是键值对/);
    expect(await workflowDiff(BASE, 'name: x\n')).toMatch(/改动后的工作流没有 jobs/);
  });
});
