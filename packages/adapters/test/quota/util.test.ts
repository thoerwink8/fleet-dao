// redact：进日志、进库、进驾驶舱之前把凭据和身份抹掉，再截到末尾 max 个字。
import { describe, expect, it } from 'vitest';
import { maskEmails, redact } from '../../src/quota/util.ts';

const all = (text: string) => redact(text, Number.POSITIVE_INFINITY);

/** 旧写法：整段一个正则、逐位重试。只拿来对拍，结果要和它一样。 */
const OLD_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 固定种子的伪随机数，对拍的样本每次都一样。 */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

describe('redact', () => {
  it('老几类照旧抹：Bearer 令牌、邮箱、JWT、sk- 密钥、查询参数里的令牌、IP、40 位以上的长串', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
    expect(all('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer <令牌>');
    expect(all('发给 someone@example.com 了')).toBe('发给 <邮箱> 了');
    expect(all(`token ${jwt} 过期`)).toBe('token <令牌> 过期');
    expect(all('key=sk-abcdefgh1234 用完')).toBe('key=<密钥> 用完');
    expect(all('GET /x?access_token=abc123&y=1')).toBe('GET /x?access_token=<令牌>&y=1');
    expect(all('连不上 10.2.3.4:443')).toBe('连不上 <IP>:443');
    expect(all(`签名 ${'Q'.repeat(40)} 结束`)).toBe('签名 <长串> 结束');
  });

  it('新补的三类：tvly- 密钥、AKIA 开头的 AWS 访问密钥、32 位十六进制', () => {
    expect(all('搜索用 tvly-dev-abcdefgh12345678 调的')).toBe('搜索用 <密钥> 调的');
    expect(all('AWS AKIAIOSFODNN7EXAMPLE 泄漏')).toBe('AWS <密钥> 泄漏');
    expect(all('key=0123456789abcdef0123456789ABCDEF;')).toBe('key=<长串>;');
    // 长度不对的不算这一类：短的十六进制（提交号缩写）、不是 AKIA 开头的大写串照常显示。
    expect(all('提交 deadbeef1234 已推')).toBe('提交 deadbeef1234 已推');
    expect(all('编号 ABCDIOSFODNN7EXAMPLE')).toBe('编号 ABCDIOSFODNN7EXAMPLE');
  });

  it('reclaude 的 API Key（rck_ 开头，下划线连着）', () => {
    expect(all('key rck_abcDEF12_-xyz 失效')).toBe('key <密钥> 失效');
  });

  it('几个邮箱连着写、中间没有分隔：一个个都抹掉（只在一段开头试一遍，第二个起会漏）', () => {
    expect(all('a@b.com_c@d.com')).toBe('<邮箱><邮箱>');
    expect(all('a@b.com+c@d.com')).toBe('<邮箱><邮箱>');
    // 跑两遍也不够：三个连写时，两遍之后还剩「_c@」。
    expect(all('a@b.com_c@d.com_e@f.com')).toBe('<邮箱><邮箱><邮箱>');
    expect(all('xx.someone+tag@example.com 收')).toBe('<邮箱> 收');
    expect(all('a@b@example.com')).toBe('a@<邮箱>');
    expect(all(`${'a'.repeat(50_000)} 结尾`)).toBe('<长串> 结尾');
  });

  it('邮箱和密钥之间没有分隔：密钥照样整段抹掉（先抹密钥、后抹邮箱）', () => {
    expect(all('a@b.com.sk-ABCDEFGHIJK')).toBe('<邮箱>.<密钥>');
    expect(all('a@b.com.tvly-ABCDEFGHIJK 尾')).toBe('<邮箱>.<密钥> 尾');
    // 反过来密钥紧贴着邮箱的前半截：前半截跟着密钥抹掉，剩下的「@域名」也不露。
    expect(all('sk-ABCDEFGHIJKuser@example.com 尾')).toBe('<密钥><邮箱> 尾');
    expect(all('Bearer abc.def@example.com')).toBe('Bearer <令牌><邮箱>');
  });

  it('抹邮箱和旧写法（整段一个正则）对拍：随机拼出来的两万条结果都一样', () => {
    const pieces = [
      'a@b.co',
      'x.y+z@q-r.io',
      '9x@y.com',
      'user@corp.io',
      '@',
      '.',
      '_',
      '+',
      '%',
      '-',
      ' ',
      ',',
      'ab',
      'c9',
      '.com',
    ];
    const rand = seeded(20_260_925);
    const differ: string[] = [];
    let glued = 0;
    for (let i = 0; i < 20_000; i++) {
      let s = '';
      for (let n = 1 + Math.floor(rand() * 8); n > 0; n--) s += pieces[Math.floor(rand() * pieces.length)];
      const want = s.replace(OLD_EMAIL, '<邮箱>');
      if (want.includes('<邮箱><邮箱>')) glued += 1;
      if (maskEmails(s) !== want) differ.push(s);
    }
    expect(differ.slice(0, 5)).toEqual([]);
    // 对拍要真的拼出过连写的邮箱，否则「全一样」说明不了什么。
    expect(glued).toBeGreaterThan(100);
  });

  it('截到末尾 max 个字，前面加省略号', () => {
    expect(redact(`开头${'字'.repeat(20)}结尾`, 5)).toBe('…字字字结尾');
    expect(redact('短的', 5)).toBe('短的');
  });
});
