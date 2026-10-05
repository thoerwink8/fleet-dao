// 飞书进来的话怎么规范化：收原话（intent-routes.ts）和指挥官写回（intent-cli.ts）在入口统一过一遍。

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * 把孤立的半个代理对（emoji 被截成两半）换成 U+FFFD，报出换了几处。飞书这边进来的话在入口统一过一遍：
 * 不换的话，写进 text 列时驱动会悄悄换掉（和原话、幂等摘要对不上），写进 jsonb（操作记录）时整条被库拒收。
 */
export function wellFormed(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(LONE_SURROGATE, () => {
    replaced += 1;
    return '�';
  });
  return { text: out, replaced };
}
