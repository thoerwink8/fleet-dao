// GitHub 用户 OAuth 令牌的加解密（#1989）。令牌只在内存里出现，落库一律密文。
//
// 改这里之前必须知道：
// - 密钥从 FLEET_SESSION_SECRET 用 HKDF 派生（info 分开），不新加一项配置：这条链上已经有一把 32 字节以上的密钥，
//   再加一项就要动每台机器的 env 和期望配置（deploy/france/desired-config.json），代价大过收益。
// - 换了 FLEET_SESSION_SECRET 就等于换了密钥：老密文解不开（报 CIPHER_UNREADABLE），页面重授权即可，
//   所以这条路不在启动时判死，只在读的时候如实失败。
// - AES-256-GCM，格式 v1.<iv-b64url>.<tag-b64url>.<密文-b64url>；版本号留给以后换算法。
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'fleet-dao:github-oauth-token:v1';
const VERSION = 'v1';
const IV_BYTES = 12;

export class GitHubTokenCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubTokenCipherError';
  }
}

/** 从会话密钥派生这条链专用的 32 字节密钥。同一把 master 换 info 就得到互不相干的密钥。 */
export function deriveTokenKey(masterSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterSecret, 'fleet-dao:github-oauth', INFO, 32));
}

export function encryptToken(plain: string, masterSecret: string): string {
  if (!plain) throw new GitHubTokenCipherError('要加密的令牌是空的');
  const key = deriveTokenKey(masterSecret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * 解不开（格式坏了、换了密钥、被改过）抛 GitHubTokenCipherError：不拿空串冒充「没存过」——
 * 调用方要能分开「这个人没授权」和「存的那份读不出来」。
 */
export function decryptToken(stored: string, masterSecret: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new GitHubTokenCipherError('存的令牌格式认不出（不是 v1.<iv>.<tag>.<密文>）');
  }
  const [, ivPart, tagPart, bodyPart] = parts;
  if (!ivPart || !tagPart || !bodyPart) throw new GitHubTokenCipherError('存的令牌缺一段');
  let iv: Buffer;
  let tag: Buffer;
  let body: Buffer;
  try {
    iv = Buffer.from(ivPart, 'base64url');
    tag = Buffer.from(tagPart, 'base64url');
    body = Buffer.from(bodyPart, 'base64url');
  } catch {
    throw new GitHubTokenCipherError('存的令牌不是合法的 base64url');
  }
  if (iv.length !== IV_BYTES) throw new GitHubTokenCipherError(`存的令牌 iv 长度不对（${iv.length}）`);
  const key = deriveTokenKey(masterSecret);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // GCM 校验不过：密钥换了、密文被动过、库被人改过——三种都可能，都按「读不出来」处理。
    throw new GitHubTokenCipherError('存的令牌解不开（换过会话密钥，或数据被动过）：这个账号要重新授权');
  }
}
