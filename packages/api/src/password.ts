// 账密登录的密码哈希与规则（#120）。只用 Node 自带的 crypto.scrypt：加盐、慢、吃内存。
// 存进库的格式：`scrypt$<N>$<r>$<p>$<盐 base64url>$<哈希 base64url>`——参数跟着哈希走，以后调参数旧哈希照样验得了。
// 参数取 OWASP《Password Storage Cheat Sheet》scrypt 那一节列的等强度组合之一：N=2^15、r=8、p=3
// （https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt）。
// 选它不选 N=2^17、p=1：每次算要的内存是 128·N·r 字节，N=2^15、r=8 是 32 MiB（2^17 是 128 MiB）；
// libuv 线程池默认 4 个线程，同时最多 4 个在算，最坏也就 128 MiB，法国那台机器扛得住。
// 改这里之前必须知道：库里已有的哈希按它自己带的参数验，改默认参数只影响以后设的密码。
import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 库里读出来的参数不许超过这些：哈希被人改大了，也不能拿它把后端内存吃光。 */
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 16;

export const PASSWORD_MIN_CHARS = 10;
/** 按字节限：scrypt 对长输入不慢，但请求体、日志里不该有这么长的东西。 */
export const PASSWORD_MAX_BYTES = 256;
/** 用户名：字母或数字开头，3–32 位，只含字母、数字、点、下划线、连字符。大小写不敏感。 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

/** 库里的哈希格式认不出：不是「密码错」，是数据坏了，要报出来。 */
export class PasswordHashFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordHashFormatError';
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 128·N·r 是 scrypt 要的内存；Node 默认上限 32 MiB 刚好卡在边上，给两倍余量。 */
const maxmem = (N: number, r: number) => 2 * 128 * N * r + 1024 * 1024;

/** 统一成 NFC：同一串字在不同设备上可能编码成不同的码点序列。 */
function normalize(password: string): string {
  return password.normalize('NFC');
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(normalize(password), salt, KEY_BYTES, { N, r, p, maxmem: maxmem(N, r) });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parseHash(stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new PasswordHashFormatError('不是 scrypt 哈希');
  const [N, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,8}$/.test(x ?? '') ? Number(x) : Number.NaN));
  if (
    N === undefined ||
    r === undefined ||
    p === undefined ||
    !Number.isInteger(N) ||
    N < 2 ||
    N > MAX_N ||
    (N & (N - 1)) !== 0 ||
    !(r >= 1 && r <= MAX_R) ||
    !(p >= 1 && p <= MAX_P)
  ) {
    throw new PasswordHashFormatError('scrypt 参数认不出或超出上限');
  }
  const salt = strictBase64url(parts[4] ?? '');
  const key = strictBase64url(parts[5] ?? '');
  if (salt.length < SALT_BYTES || key.length < KEY_BYTES) throw new PasswordHashFormatError('盐或哈希太短');
  return { N, r, p, salt, key };
}

/**
 * Buffer.from(…, 'base64url') 遇到非法字符会悄悄跳过：盐后面多个「!」也能照常解出来、照常验过。
 * 这里只认规范写法（只含 base64url 字符、解出来再编回去一字不差），否则按格式认不出处理。
 */
function strictBase64url(text: string): Buffer {
  const buf = Buffer.from(text, 'base64url');
  if (!/^[A-Za-z0-9_-]+$/.test(text) || buf.toString('base64url') !== text) {
    throw new PasswordHashFormatError('盐或哈希不是规范的 base64url');
  }
  return buf;
}

/** 对不对；库里的哈希格式认不出时抛 PasswordHashFormatError（不当成「密码错」糊过去）。比较用 timingSafeEqual。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const { N, r, p, salt, key } = parseHash(stored);
  const got = await scryptAsync(normalize(password), salt, key.length, { N, r, p, maxmem: maxmem(N, r) });
  return timingSafeEqual(got, key);
}

let dummy: Promise<string> | undefined;
/**
 * 没这个用户、或这人还没设过密码时也照样算一次哈希再说「不对」：两种情况花的时间和「密码错」一样，
 * 别人没法凭响应快慢试出哪些用户名存在。
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('base64url'));
  await verifyPassword(password, await dummy);
}

export type CredentialProblem =
  | { code: 'weak_password' | 'password_too_long'; field: 'newPassword'; message: string }
  | { code: 'invalid_username'; field: 'username'; message: string };

export function checkNewPassword(password: string): CredentialProblem | null {
  if ([...normalize(password)].length < PASSWORD_MIN_CHARS) {
    return { code: 'weak_password', field: 'newPassword', message: `密码至少 ${PASSWORD_MIN_CHARS} 位` };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return {
      code: 'password_too_long',
      field: 'newPassword',
      message: `密码最长 ${PASSWORD_MAX_BYTES} 字节`,
    };
  }
  return null;
}

export function checkUsername(username: string): CredentialProblem | null {
  if (!USERNAME_PATTERN.test(username)) {
    return {
      code: 'invalid_username',
      field: 'username',
      message: '用户名 3–32 位，字母或数字开头，只能用字母、数字、点、下划线、连字符',
    };
  }
  return null;
}
