// 写库之前的脱敏只抹开头一段：证据、上游报错可能有几万字，而库里只留开头，整段过 redact 白花时间。
// 截断处要避开令牌：先截再脱敏，跨过截断处的令牌会剩下认不出的半截，半截就原样漏进库。
import { redact } from '@fleet-dao/adapters';

/** 令牌、密钥、邮箱、IP、长串都只由这些字符组成：截在别的字符处，截处两边不会各留半截。 */
const TOKEN_CHAR = /[A-Za-z0-9._~+/=%@-]/;
/** 窗口从 4 倍 max 起（脱敏会把长串缩短，留些余量）往后最多找这么多字，去找能截的地方。 */
const SCAN = 2_000;

/**
 * 取脱敏后的开头至多 max 个字。只脱敏开头一个窗口：窗口截在 4 倍 max 之后第一个不会出现在令牌里的字符处；
 * 往后 SCAN 个字都找不到（一整串不断开），就退回到那之前最后一个能截的地方，这一整串不要了（一个都没有就只留「<长串>」）。
 */
export function scrubHead(text: string, max: number): string {
  let end = text.length;
  const from = max * 4;
  if (text.length > from) {
    const limit = Math.min(text.length, from + SCAN);
    let cut = -1;
    for (let i = from; i < limit; i++) {
      if (!TOKEN_CHAR.test(text.charAt(i))) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) end = cut;
    else if (limit < text.length) {
      end = from;
      while (end > 0 && TOKEN_CHAR.test(text.charAt(end - 1))) end -= 1;
      if (end === 0) return '<长串>';
    }
  }
  return redact(text.slice(0, end), Number.POSITIVE_INFINITY).slice(0, max);
}
