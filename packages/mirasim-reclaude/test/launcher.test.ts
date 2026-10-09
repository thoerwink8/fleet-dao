import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runChildOk } from './child.ts';

it('真实编译执行切换、权限、强杀收尾及失败路径测试', { timeout: 120_000 }, () => {
  const output = runChildOk('go', ['test', '-count=1', '.'], {
    cwd: fileURLToPath(new URL('../launcher/', import.meta.url)),
    limitMs: 110_000,
    windowsHide: true,
  });
  expect(output).toMatch(/\bok\s+reclaude-mirasim\b/);
});
