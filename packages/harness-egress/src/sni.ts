// 从 TLS ClientHello 里读 SNI（RFC 8446 4.1.2、RFC 6066 3）。只读不改，读不出一律回 null，由调用方按拒处理。
// 第一条记录不一定一次到齐：caller 攒够 needBytes 回的长度再读。

/** 判断攒到的字节够不够读出整条首记录；够了回总长，不是 TLS 握手记录回 -1，还不够回 0。 */
export function needBytes(buf: Buffer): number {
  if (buf.length < 5) return 0;
  if (buf[0] !== 0x16) return -1; // 不是握手记录
  const len = buf.readUInt16BE(3);
  if (len > 16_384 + 2048) return -1;
  return buf.length >= 5 + len ? 5 + len : 0;
}

/** 首记录里的 server_name（host_name 类型）；没有、格式不对回 null。 */
export function readSni(buf: Buffer): string | null {
  try {
    if (needBytes(buf) <= 0) return null;
    let p = 5;
    if (buf[p] !== 0x01) return null; // 不是 ClientHello
    p += 4; // 类型 1 + 长度 3
    p += 2 + 32; // 版本 + 随机数
    p += 1 + (buf[p] ?? 0); // 会话号
    p += 2 + buf.readUInt16BE(p); // 密码套件
    p += 1 + (buf[p] ?? 0); // 压缩方法
    if (p + 2 > buf.length) return null;
    const extEnd = p + 2 + buf.readUInt16BE(p);
    p += 2;
    while (p + 4 <= extEnd) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      p += 4;
      if (type === 0x0000) {
        let q = p + 2; // 列表长度
        const listEnd = p + len;
        while (q + 3 <= listEnd) {
          const nameType = buf[q];
          const nameLen = buf.readUInt16BE(q + 1);
          q += 3;
          if (nameType === 0) {
            const name = buf
              .subarray(q, q + nameLen)
              .toString('ascii')
              .toLowerCase();
            return /^[a-z0-9.-]{1,253}$/.test(name) ? name : null;
          }
          q += nameLen;
        }
        return null;
      }
      p += len;
    }
    return null;
  } catch {
    return null; // 越界：格式不对
  }
}

/** 名单一条：完全相同，或「.example.com」这样以点开头的表示它的子域（不含它自己）。 */
export function allowed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((rule) => {
    const r = rule.toLowerCase();
    return r.startsWith('.') ? h.endsWith(r) && h.length > r.length : h === r;
  });
}
