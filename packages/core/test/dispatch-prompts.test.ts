// 验收：packages 和 docs/ops.md 里不再出现已经删掉的交单命令。扫的是整棵树，不是某几句文案。
// 字面量拆开写：测试文件自己带上那一串，验收那条 grep 又对上了。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const phrase = ['fleet-api', 'handover'].join(' ');

describe('已删的交单命令不再出现在提示里', () => {
  it('packages 和 docs/ops.md 里 grep 不到这句', () => {
    const r = spawnSync('grep', ['-rn', phrase, 'packages', 'docs/ops.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.error, 'grep 没跑成').toBeUndefined();
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toBe('');
  });
});
