// 测试用的「像真的」随机串：固定种子，每次跑出来一样（测试不飘），但源码里不出现整段，全仓检查不会扫到测试自己。

/** 固定种子的伪随机串（xorshift32），字符取自 alphabet。 */
export function pseudoRandom(length: number, seed: number, alphabet = BASE62): string {
  let x = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

export const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const HEX = '0123456789abcdef';

/** 像真的 UUID（固定种子）。 */
export function pseudoUuid(seed: number): string {
  const h = pseudoRandom(32, seed, HEX);
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join(
    '-',
  );
}

/** 像真的四位组织编号（固定种子）：不是 1234、1111 这种一眼就假的。 */
export function pseudoNumber(digits: number, seed: number): string {
  return pseudoRandom(digits, seed, '0123456789').replace(/^0/, '7');
}
