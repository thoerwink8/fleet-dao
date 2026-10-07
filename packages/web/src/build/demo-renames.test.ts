// 演示版的包里要换掉的几处：全局禁令的理由（本项目自己的规矩原话）每一条都换掉，换完扫不出东西。
import { HARD_BANS, ROUTING_PURPOSES } from '@fleet-dao/shared';
import { expect, test } from 'vitest';
import { demoRenamed } from './demo-renames';
import { BUILTIN_TERMS, scanText } from './scan';

const flagged = (text: string) => BUILTIN_TERMS.filter((t) => text.toLowerCase().includes(t.toLowerCase()));

test('每条全局禁令的理由都换成了样例说法：改了 shared/bans.ts 的原话、这张表没跟上就红', () => {
  for (const ban of HARD_BANS) {
    const renamed = demoRenamed(ban.reason);
    expect(renamed, ban.id).not.toBe(ban.reason);
    expect(flagged(renamed), ban.id).toEqual([]);
  }
});

test('执行方式的编号整词换成 relay，别的词里碰巧含它的不动', () => {
  expect(demoRenamed('kind:"mirasim",x:"mirasimx"')).toBe('kind:"relay",x:"mirasimx"');
});

test('路由用途的显示名换完扫不出禁用词：shared 改了说法、这张表没跟上就红', () => {
  for (const row of ROUTING_PURPOSES) {
    expect(scanText(row.purpose, demoRenamed(row.label)), row.purpose).toEqual([]);
  }
  // 正式版这一格就叫「Jev 判断」；换掉的是演示版包里的那份，不是对照本身。
  expect(ROUTING_PURPOSES.find((p) => p.purpose === 'judge')?.label).toBe('Jev 判断');
  expect(demoRenamed('label:`Jev 判断`,aside')).toBe('label:`判断题`,aside');
});
