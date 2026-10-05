// 钉住通用段里「创始人引导必须落盘」那条的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-03 的断链：创始人在 AI 干活中间插话给的引导（删坏工作树、AGENTS.md 太肥、继续派 subagent……），
// 被记成 absorbed_mid_turn——折进当时那一轮，不再是一个独立回合。结果是换会话、上下文被总结之后，
// 接手的 AI 在任何「回合」里都看不到这些引导，创始人只好重说一遍（本会话四条全被吸收）。
// 根子：「报进度」「进度也要落盘」两条管的是 AI 主动发的进度，没管创始人插话给进来的引导。
// 下面这几条钉住「引导也要当场落盘」，通用段改写时不能悄悄丢掉。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来）
const AGENTS = readFileSync(fileURLToPath(new URL('../../shared-rules.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几条，缺了哪条就列出哪条。 */
const DIRECTIVE_RULES: Record<string, RegExp> = {
  引导和决定要落盘: /我中途给的引导和决定/,
  记到进度单: /`pnpm progress:directive "原话" --at "时间"`/,
  接手先读: /接手先 `pnpm progress:read`/,
  别的仓的老读法: /「## 创始人引导（待处理）」/,
  会话级指令不记: /不是「这一次怎么干」那种会话级指令/,
  办完标已处理: /办完 `pnpm progress:done <评论号>`/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：创始人引导必须落盘（2026-10-03 补）', () => {
  it('通用段里这几条都在', () => {
    expect(missing(DIRECTIVE_RULES, AGENTS)).toEqual([]);
  });

  it('和「只管一次会话怎么干」那条分得开，没把它一起记进去', () => {
    // 决定 0013：会话级指令（别开子代理这类）不记；引导落盘那条要显式排除它。
    expect(AGENTS).toMatch(/不是「这一次怎么干」那种会话级指令/);
  });

  it('【故意造出的失败】把「引导和决定落盘」那半句拿掉：查得出来', () => {
    const cut = AGENTS.replace(/我中途给的引导和决定[^\n]*接手先 `pnpm progress:read`。/, '');
    expect(cut).not.toBe(AGENTS);
    expect(missing(DIRECTIVE_RULES, cut)).toEqual(Object.keys(DIRECTIVE_RULES));
  });
});
