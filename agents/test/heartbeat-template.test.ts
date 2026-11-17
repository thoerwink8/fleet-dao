// 心跳清单是模板：不带具体单号、内网地址、盘符路径；技能文字指向它和派活脚本。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const template = readFileSync(new URL('../skills/mirasim-sessions/heartbeat.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../skills/mirasim-sessions/SKILL.md', import.meta.url), 'utf8');

describe('心跳模板', () => {
  it('技能指向模板和派活脚本', () => {
    expect(skill).toContain('heartbeat.md');
    expect(skill).toContain('scripts/dispatch.mjs');
    expect(skill).toContain('agents/test/mirasim-dispatch.test.ts');
  });

  it('不含单号、内网地址、盘符路径', () => {
    expect(template).not.toMatch(/(?<![\w/])#\d+/);
    expect(template).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(template).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(template).not.toMatch(/Users[/\\]Administrator|fleet-agent-carpool|sslip\.io/i);
    expect(template).toContain('gh pr list');
    expect(template).toContain('scripts/close.mjs');
    expect(template).toContain('scripts/sweep.mjs');
    expect(skill).toContain('scripts/sweep.mjs');
    expect(skill).toContain('每轮先列可收');
    expect(template).toContain('stopAndRun');
  });
});
