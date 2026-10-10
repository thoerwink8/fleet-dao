// redactSecrets（#1640）：和推送前的闸共用 RULES，命中的整段打码，别的原样。
// 违规样本在运行时拼起来（值用固定种子的伪随机串）：源码里不出现整段，全仓检查不会扫到这个文件自己。
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.ts';
import { findHits } from '../src/rules.ts';
import { pseudoRandom } from './helpers.ts';

const TOKEN = ['ghp', pseudoRandom(36, 9)].join('_');
const SECRET_LINE = `FEISHU_APP_SECRET=${pseudoRandom(32, 21)}`;

describe('redactSecrets', () => {
  it('令牌换成标记，前后原样', () => {
    const got = redactSecrets(`push 用 ${TOKEN} 做的，继续`);
    expect(got.count).toBe(1);
    expect(got.text).toBe('push 用 [已打码：令牌] 做的，继续');
  });

  it('键名像密钥的赋值整条打码；打码后再扫一遍没有命中', () => {
    const got = redactSecrets(`export A=1\n${SECRET_LINE}\necho done`);
    expect(got.count).toBe(1);
    expect(got.text).toContain('[已打码：像密钥的赋值]');
    expect(got.text).not.toContain(SECRET_LINE.slice(-20));
    expect(findHits(got.text)).toEqual([]);
  });

  it('同一类密钥出现两次，两处都打', () => {
    const second = ['ghp', pseudoRandom(36, 33)].join('_');
    const got = redactSecrets(`${TOKEN} 然后 ${second}`);
    expect(got.count).toBe(2);
    expect(got.text).toBe('[已打码：令牌] 然后 [已打码：令牌]');
  });

  it('没有密钥的文本原样返回，count 是 0', () => {
    const text = '改了 packages/engine/src/real/hosts.ts，跑了 pnpm check';
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it('明显编出来的值不算（和闸的口径一致）', () => {
    const text = 'token = ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(redactSecrets(text).count).toBe(0);
  });
});
