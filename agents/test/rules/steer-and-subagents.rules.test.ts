// 钉住创始人 2026-10-12 17:14「选1」（决定 0083；改标准：改这个文件要创始人同意）。
// 人在场：新话在下一刀之前先回；还有子代理或下一刀就别收这一轮；活没干完不许写成收工。
// 子代理一律后台跑，单次前台等待不超过 60 秒。只有无人值守才由收尾钩子把回合挂住。
// 0078 的钩子中转（从 diag 取原文、不用结束这一轮、前面已回）删掉了。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const SHARED = read('../../shared-rules.md');
const SKILL = read('../../skills/commander/SKILL.md');

/** 以这个开头的那一条（整行）；没有就是空串。 */
const bullet = (text: string, head: string) => text.split('\n').find((l) => l.startsWith(head)) ?? '';

const SHARED_RULES: Record<string, (t: string) => boolean> = {
  调工具前先回引导: (t) => {
    const l = bullet(t, '- 我中途的引导');
    return l.includes('一送到，先回我一句再调工具') && l.includes('新话在下一刀之前先回');
  },
  活没干完不许写成收工: (t) => bullet(t, '- 我中途的引导').includes('活没干完不许写成收工'),
  子代理一律后台跑: (t) => {
    const l = bullet(t, '- Agent 子代理');
    return (
      l.includes('一律后台跑') &&
      l.includes('还有子代理或下一刀就别收这一轮') &&
      l.includes('单次前台等待不超过 60 秒') &&
      l.includes('只有无人值守才由收尾钩子把回合挂住')
    );
  },
  引导用SendMessage转给子代理: (t) =>
    bullet(t, '- 我中途的引导').includes('涉及在跑的子代理，用 `SendMessage` 原话转它'),
};

function missing(rules: Record<string, (t: string) => boolean>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, ok]) => !ok(text))
    .map(([name]) => name);
}

/** 已删的旧说法：再出现就红 */
const STALE = [
  '钩子转来的 Mirasim 引导',
  '不用结束这一轮',
  '这条前面已回',
  '派了它这一轮就不结束',
  '派了这一轮不结束、等完成通知',
  '马上结束这一轮',
  '轮次结束或进程重开就跟着死',
];

describe('规矩：人在场别收、新话先回（决定 0083）', () => {
  it('通用段里都在', () => {
    expect(missing(SHARED_RULES, SHARED)).toEqual([]);
  });

  it('钩子中转和「不分无人值守都不结束」已删', () => {
    expect(STALE.filter((s) => SHARED.includes(s) || SKILL.includes(s))).toEqual([]);
  });

  it('等待上限只有一个数：通用段只写一次 60 秒，技能里不再写 55 秒', () => {
    expect(bullet(SHARED, '- 无人值守')).not.toContain('前台等待');
    expect(SHARED.match(/前台等待不超过 \d+ 秒/g)).toEqual(['前台等待不超过 60 秒']);
    expect(SKILL).not.toMatch(/前台单次等待不超过 55 秒/);
  });

  it('【故意造出的失败】把「别收」改回可以收尾、删掉先回：查得出缺', () => {
    const mayEnd = SHARED.replace('还有子代理或下一刀就别收这一轮', '派完可以收尾');
    expect(mayEnd).not.toBe(SHARED);
    expect(missing(SHARED_RULES, mayEnd)).toEqual(['子代理一律后台跑']);
    const noReply = SHARED.replace('先回我一句再调工具', '接着调工具');
    expect(missing(SHARED_RULES, noReply)).toEqual(['调工具前先回引导']);
    const relay = `${SKILL}\n不用结束这一轮`;
    expect(STALE.filter((s) => relay.includes(s))).toContain('不用结束这一轮');
  });
});
