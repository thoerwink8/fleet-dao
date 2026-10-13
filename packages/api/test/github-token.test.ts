// 各人 GitHub OAuth 令牌的加解密（#1989）：解开拿回原文、密文里读不到明文、换密钥解不开要明确失败。
import { describe, expect, it } from 'vitest';
import { decryptToken, deriveTokenKey, encryptToken, GitHubTokenCipherError } from '../src/github-token.ts';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);

describe('GitHub 令牌加解密', () => {
  it('解回来是原文', () => {
    const token = 'gho_0123456789abcdefghijklmnopqrstuvwxyz';
    const cipher = encryptToken(token, SECRET);
    expect(cipher).not.toContain(token);
    expect(cipher.startsWith('v1.')).toBe(true);
    expect(decryptToken(cipher, SECRET)).toBe(token);
  });

  it('同一个令牌两次加密密文不同（每次随机 iv），但都能解开', () => {
    const token = 'github_pat_AAAA';
    const a = encryptToken(token, SECRET);
    const b = encryptToken(token, SECRET);
    expect(a).not.toBe(b);
    expect(decryptToken(a, SECRET)).toBe(token);
    expect(decryptToken(b, SECRET)).toBe(token);
  });

  it('【故意造出的失败】换一把密钥：解不开，抛 GitHubTokenCipherError（不当成空串）', () => {
    const cipher = encryptToken('gho_secret', SECRET);
    expect(() => decryptToken(cipher, OTHER)).toThrow(GitHubTokenCipherError);
  });

  it('【故意造出的失败】密文被改过（GCM 校验不过）：抛错', () => {
    const cipher = encryptToken('gho_secret', SECRET);
    const parts = cipher.split('.');
    // 改认证标签（tag）的首字符：GCM 校验一定不过（改密文尾字符未必——base64 最后一字符可能不带数据位）。
    const tag = parts[2] ?? '';
    parts[2] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    expect(() => decryptToken(parts.join('.'), SECRET)).toThrow(GitHubTokenCipherError);
  });

  it('【故意造出的失败】格式认不出：明确抛错，不当成空', () => {
    expect(() => decryptToken('garbage', SECRET)).toThrow(GitHubTokenCipherError);
    expect(() => decryptToken('v2.a.b.c', SECRET)).toThrow(GitHubTokenCipherError);
  });

  it('【故意造出的失败】加密空串：拒绝（空令牌不该进库）', () => {
    expect(() => encryptToken('', SECRET)).toThrow(GitHubTokenCipherError);
  });

  it('派生密钥是 32 字节，换了主密钥就换一把', () => {
    expect(deriveTokenKey(SECRET).length).toBe(32);
    expect(deriveTokenKey(SECRET).equals(deriveTokenKey(OTHER))).toBe(false);
  });
});
