// redact：进日志、进库、进驾驶舱之前把凭据和身份抹掉，再截到末尾 max 个字。
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/quota/util.ts';

const all = (text: string) => redact(text, Number.POSITIVE_INFINITY);

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

  it('邮箱只从一段字符的开头试，认得出来的和原来一样', () => {
    expect(all('xx.someone+tag@example.com 收')).toBe('<邮箱> 收');
    expect(all('a@b@example.com')).toBe('a@<邮箱>');
    expect(all(`${'a'.repeat(50_000)} 结尾`)).toBe('<长串> 结尾');
  });

  it('截到末尾 max 个字，前面加省略号', () => {
    expect(redact(`开头${'字'.repeat(20)}结尾`, 5)).toBe('…字字字结尾');
    expect(redact('短的', 5)).toBe('短的');
  });
});
