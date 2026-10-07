import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 钉住一条规矩（创始人 2026-10-07 夜：看到子代理清单里一长串 `cd rel-card && sed/grep`，问「应该有更佳的 grep 吧」）：
// 子代理交代里要写明读工作树里的文件用 Read、Grep 加绝对路径，Bash 里进工作树用 git -C / pnpm --dir，不用 cd 加 sed/grep。
// 原因：codegraph 索引在主检出、工作树里没有，原来只写「先用 codegraph」拦不住这条 cd 链。
const REQUIRED = [
  'Read、Grep',
  '绝对路径',
  '`cd <工作树> && sed/grep`',
  '`git -C <路径>`',
  '`pnpm --dir <路径>`',
];

describe('子代理交代：读工作树文件不用 cd 加 sed/grep 链', () => {
  const skill = readFileSync(join(import.meta.dirname, '../../skills/commander/SKILL.md'), 'utf8');

  it('「子代理的交代要瘦」一节写明 Read/Grep 加绝对路径、git -C、pnpm --dir', () => {
    const start = skill.indexOf('**子代理的交代要瘦**');
    const end = skill.indexOf('**脱离会话的工人（例外）**');
    expect(start, '找不到子代理交代那一条').toBeGreaterThan(-1);
    expect(end, '找不到下一条').toBeGreaterThan(start);
    const section = skill.slice(start, end);
    for (const s of REQUIRED) expect(section, `交代那一节缺了「${s}」`).toContain(s);
  });

  it('【故意造出的失败】旧写法（只说先用 codegraph、少用 grep）必须被判不合格', () => {
    const old = '① 第一条「读代码先用 `mcp__codegraph__codegraph_explore`，少用 grep 加 Read 来回翻」；';
    const missing = REQUIRED.filter((s) => !old.includes(s));
    expect(missing.length).toBeGreaterThan(0);
  });
});
