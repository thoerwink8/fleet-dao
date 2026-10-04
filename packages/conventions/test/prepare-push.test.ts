// 推送前预检（src/prepare-push.ts）：跑什么由 ci-plan 现算（和 CI 同一份判法），跑不成一律当「没查成」拒推。

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readGraph } from '../src/ci-plan.ts';
import { preparePush } from '../src/prepare-push.ts';
import { fsRepo } from '../src/repo.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GRAPH = readGraph(fsRepo(ROOT));

interface Ran {
  cmd: string;
  args: string[];
}

/** preparePush 返回 { code, lines }；world 只留了 code，这里换个更直白的包法。 */
function run(changed: string[] | Error, over: { fail?: string; missing?: string } = {}) {
  const ran: Ran[] = [];
  const r = preparePush({
    changed: () => {
      if (changed instanceof Error) throw changed;
      return changed;
    },
    repo: fsRepo(ROOT),
    graph: () => GRAPH,
    run(cmd, args) {
      ran.push({ cmd, args: [...args] });
      if (over.missing === cmd) return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
      // 真跑到了检查才会有的结果行（biome 的汇总行 / tsc 的 error TS）：判「没过」要看到它
      if (over.fail === cmd) {
        const ranMark = cmd === 'biome' ? 'Checked 3 files in 5ms.' : 'a.ts(1,1): error TS2322: x';
        return { status: 1, stdout: `${ranMark}\n第一行\n第二行\n第三行`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  return { ...r, ran };
}

describe('推送前预检', () => {
  it('只改文档：什么都不跑，也不当成「查过代码」', () => {
    const r = run(['docs/ops.md', 'specs/574-路由两层DB/需求.md']);
    expect(r.code).toBe(0);
    expect(r.ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('不需要代码检查');
  });

  it('改到一个包：只跑 biome 和 tsc，参数带着那个包，不跑别的', () => {
    const r = run(['packages/conventions/src/plan.ts']);
    expect(r.code).toBe(0);
    expect(r.ran.map((x) => x.cmd)).toEqual(['biome', 'tsc']);
    expect(r.ran[0]?.args).toEqual(['check', '.']);
    expect(r.ran[1]?.args[0]).toBe('-b');
  });

  it('改了根配置（所有包都受影响）：tsc 用整棵树（-b 不带项目）', () => {
    const r = run(['pnpm-lock.yaml']);
    expect(r.code).toBe(0);
    expect(r.ran[1]?.args).toEqual(['-b']);
  });

  it('【故意造出的失败】格式没过：退出码 1，把命令的输出末几行带出来', () => {
    const r = run(['packages/conventions/src/plan.ts'], { fail: 'biome' });
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('biome 格式检查 没过');
    expect(r.lines.join('\n')).toContain('第三行');
    expect(r.ran.map((x) => x.cmd)).toEqual(['biome']); // 前面红了就不往下跑
  });

  it('【故意造出的失败】biome 没装（起不来）：退出码 2，说明是没查成、不是过了', () => {
    const r = run(['packages/conventions/src/plan.ts'], { missing: 'biome' });
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('没查成');
    expect(r.lines.join('\n')).toContain('pnpm install');
  });

  it('【故意造出的失败】启动器在、包没装全（MODULE_NOT_FOUND 退 1）：退出码 2 没查成，不当成代码没过', () => {
    const r = preparePush({
      changed: () => ['packages/conventions/src/plan.ts'],
      repo: fsRepo(ROOT),
      graph: () => GRAPH,
      run: () => ({
        status: 1,
        stdout: '',
        stderr: "Error: Cannot find module 'x/bin/biome' { code: 'MODULE_NOT_FOUND' }",
      }),
    });
    expect(r.code).toBe(2);
    expect(r.lines.join(' ')).toContain('没查成');
  });

  it('【故意造出的失败】#789 新工作树没装依赖：cmd 报「系统找不到指定的路径」退 1、没有检查结果 → 退 2「没查成」，不说格式没过', () => {
    const r = preparePush({
      changed: () => ['packages/conventions/src/plan.ts'],
      repo: fsRepo(ROOT),
      graph: () => GRAPH,
      run: () => ({ status: 1, stdout: '', stderr: 'The system cannot find the path specified.\r\n' }),
    });
    const text = r.lines.join('\n');
    expect(r.code).toBe(2);
    expect(text).toContain('biome 格式检查 没查成');
    expect(text).toContain('没跑起来');
    expect(text).toContain('pnpm install');
    expect(text).toContain('The system cannot find the path specified'); // 原输出带出来，不吞
    expect(text).not.toContain('没过');
  });

  it('【故意造出的失败】biome 汇总行写着查了 0 个文件（路径/配置不对）：也是没查成，不是格式没过', () => {
    const r = preparePush({
      changed: () => ['packages/conventions/src/plan.ts'],
      repo: fsRepo(ROOT),
      graph: () => GRAPH,
      run: () => ({ status: 1, stdout: 'Checked 0 files in 1779µs. No fixes applied.', stderr: '' }),
    });
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('没查成');
  });

  it('【故意造出的失败】tsc 退 1 但没有 error TS（起不来）：退 2；有 error TS 才是类型没过退 1', () => {
    const mk = (out: string) =>
      preparePush({
        changed: () => ['packages/conventions/src/plan.ts'],
        repo: fsRepo(ROOT),
        graph: () => GRAPH,
        run: (cmd) =>
          cmd === 'tsc' ? { status: 1, stdout: out, stderr: '' } : { status: 0, stdout: '', stderr: '' },
      });
    const broken = mk("'tsc' is not recognized as an internal or external command");
    expect(broken.code).toBe(2);
    expect(broken.lines.join('\n')).toContain('tsc 类型检查 没查成');
    const real = mk('a.ts(1,1): error TS2322: Type string is not assignable to number');
    expect(real.code).toBe(1);
    expect(real.lines.join('\n')).toContain('tsc 类型检查 没过');
  });

  it('【故意造出的失败】算改动就失败（git 读不到基准）：退出码 2，一个检查都不跑', () => {
    const r = run(new Error('认不出 origin/main：先 git fetch origin'));
    expect(r.code).toBe(2);
    expect(r.ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('没查成');
  });

  it('【故意造出的失败】依赖图读不出（planCi 判全跑）：照跑全量，不静默少跑', () => {
    const ran: Ran[] = [];
    const r = preparePush({
      changed: () => ['packages/conventions/src/plan.ts'],
      repo: fsRepo(ROOT),
      graph: () => '列不出 packages/',
      run(cmd, args) {
        ran.push({ cmd, args: [...args] });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(r.code).toBe(0);
    expect(ran[1]?.args).toEqual(['-b']);
  });
});
