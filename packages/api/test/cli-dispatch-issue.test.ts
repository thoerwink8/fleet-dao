// fleet-api dispatch-issue（#1337）在后端这一头只剩两件事：--help 里列得出来；没经 bin/fleet-api 直接跑要明确拒绝（退出码 2）。
// 本体在引擎包（packages/engine/test/dispatch-issue.test.ts 测），由 bin/fleet-api 按命令名转过去：转发这一行用读文件钉住。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    openStore: async () => {
      throw new Error('不该连库');
    },
    now: () => new Date('2026-10-08T00:00:00.000Z'),
  };
  return { deps, out, err };
}

describe('fleet-api dispatch-issue（后端这一头）', () => {
  it('--help 总览里列出它，并指向引擎包里的本体', async () => {
    const { deps, out } = capture();
    expect(await main(['--help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('fleet-api dispatch-issue <owner/仓名> <单号>');
  });

  it('没经 bin/fleet-api 直接跑：退出码 2，说清要经哪里，不连库', async () => {
    const { deps, err } = capture();
    expect(await main(['dispatch-issue', 'acme/demo', '12'], deps)).toBe(2);
    expect(err.join('\n')).toContain('packages/api/bin/fleet-api');
  });

  it('bin/fleet-api 把 dispatch-issue 转给引擎包的入口，别的命令仍走后端自己的', () => {
    const wrapper = readFileSync(fileURLToPath(new URL('../bin/fleet-api', import.meta.url)), 'utf8');
    expect(wrapper).toMatch(/"\$\{1:-\}" == "dispatch-issue"/);
    expect(wrapper).toContain('packages/engine/src/bin/dispatch-issue.ts');
    expect(wrapper).toContain('packages/api/src/bin/fleet-api.ts');
  });
});
