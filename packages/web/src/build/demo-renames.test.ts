// 演示版的包里要换掉的几处：全局禁令的理由（本项目自己的规矩原话）每一条都换掉，换完扫不出东西。
import { HARD_BANS } from '@fleet-dao/shared';
import { expect, test } from 'vitest';
import { demoRenamed } from './demo-renames';
import { BUILTIN_TERMS } from './scan';

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
