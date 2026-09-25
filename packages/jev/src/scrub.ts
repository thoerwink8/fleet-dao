// 写库之前的脱敏只抹开头一段：证据、上游报错可能有几万字，而库里只留开头，整段过 redact 白花时间。
// 截断处要避开令牌：先截再脱敏，跨过截断处的令牌会剩下认不出的半截，半截就原样漏进库。
// 写进库的字都要收得下：jsonb 不收落单的代理项（emoji 截在一半）和 NUL，text 列不收 NUL，碰上整行写不进库。
import { redact } from '@fleet-dao/adapters';

/** 令牌、密钥、邮箱、IP、长串都只由这些字符组成：截在别的字符处，截处两边不会各留半截。 */
const TOKEN_CHAR = /[A-Za-z0-9._~+/=%@-]/;
/** 窗口从 4 倍 max 起（脱敏会把长串缩短，留些余量）往后最多找这么多字，去找能截的地方。 */
const SCAN = 2_000;
/** 替换字符 U+FFFD。 */
const REPLACEMENT = String.fromCharCode(0xfffd);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 截到至多 max 个码元；截在 emoji 这类代理对中间时，把落单的前一半也去掉。 */
export function cutAt(text: string, max: number): string {
  const cut = text.slice(0, max);
  return isHigh(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

/**
 * 库收不下的字换成 U+FFFD，免得整行写不进库：落单的代理项（编码坏了的输入）、NUL（命令输出里常混进来）。
 * 成对的代理项（emoji）原样留着。
 */
export function wellFormed(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    let bad = c === 0 || isLow(c);
    if (isHigh(c)) {
      if (isLow(text.charCodeAt(i + 1))) i += 1;
      else bad = true;
    }
    if (bad) {
      out += `${text.slice(from, i)}${REPLACEMENT}`;
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * 调用方给的引用写进 jsonb 之前：先转成 JSON 再解析回来（日期变成字符串，函数、undefined 去掉），
 * 再把里面每个字符串（连同键）过一遍 wellFormed。转不了的（BigInt、循环引用）交回原因，引用不要了。
 */
export function storableRef(ref: unknown): { ref: unknown } | { problem: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(ref);
  } catch (err) {
    // 原因也写进库：toJSON 自己抛出来的什么字都可能有，一样要收得下。
    const why = err instanceof Error ? err.message : String(err);
    return { problem: cutAt(wellFormed(`转不成 JSON：${why}`), 200) };
  }
  if (json === undefined) return { problem: '转不成 JSON（是函数或 undefined）' };
  return { ref: wellFormedDeep(JSON.parse(json)) };
}

function wellFormedDeep(value: unknown): unknown {
  if (typeof value === 'string') return wellFormed(value);
  if (Array.isArray(value)) return value.map(wellFormedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [wellFormed(k), wellFormedDeep(v)]));
  }
  return value;
}

/**
 * 取脱敏后的开头至多 max 个码元。只脱敏开头一个窗口：窗口截在 4 倍 max 之后第一个不会出现在令牌里的字符处；
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
  return cutAt(wellFormed(redact(text.slice(0, end), Number.POSITIVE_INFINITY)), max);
}
