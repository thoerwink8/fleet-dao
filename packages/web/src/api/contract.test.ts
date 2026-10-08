// 契约对账的前端那一头（母单 #902）：shared/web-api.ts 的每个接口，http.ts（真后端的实现）有没有人用。
// 后端那一头（契约里的每条后端都注册了）在 packages/api/test/web-routes-contract.test.ts。
// 契约里有、前端从没调过的，要么是前端漏做了（缺陷），要么是有意不用——有意不用的写进下面的清单并写明原因；
// 清单里的哪条哪天真被用上了，这条测试会红，逼着把它从清单里删掉（清单不会越攒越多、也不会过期还留着）。
import { readFileSync } from 'node:fs';
import { AuthRoutes, WebRoutes } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';

const http = readFileSync(new URL('./http.ts', import.meta.url), 'utf8');

/** http.ts 里用到的 `R.<名字>`（R 就是 WebRoutes）和 `AuthRoutes.<名字>`。 */
function used(prefix: string): Set<string> {
  const names = new Set<string>();
  for (const m of http.matchAll(new RegExp(`\\b${prefix}\\.([a-zA-Z]+)`, 'g'))) names.add(m[1] as string);
  return names;
}

/** 契约里有、前端（http.ts）没用的：key → 为什么。 */
/** 契约里有、页面故意不调的。groomStatus / groomNow 已由设置页接上（#1335 第 4 片），不在这里。 */
const WEB_NOT_USED: Record<string, string> = {
  // 名册差集页只展示这一句，这一片不在页面上放登记按钮
  registerChannelModel: '手工登记的写口已有，页面这一片不放按钮',
  revokeChannelModel: '撤销手工登记的写口已有，页面这一片不放按钮',
};
const AUTH_NOT_USED: Record<string, string> = {
  // 飞书登录、回调是浏览器整页跳转（<a href>），不经 http.ts 的 fetch
  feishuLogin: '浏览器整页跳转，不走 fetch',
  feishuCallback: '飞书回调，浏览器整页跳转，不走 fetch',
};

describe('契约 ↔ 前端 http.ts', () => {
  test('WebRoutes 的每个接口：前端用了，或者在「有意不用」清单里写明了原因', () => {
    const usedNow = used('R');
    const unused = Object.keys(WebRoutes).filter((k) => !usedNow.has(k));
    expect(unused.sort()).toEqual(Object.keys(WEB_NOT_USED).sort());
  });

  test('AuthRoutes 同样', () => {
    const usedNow = used('AuthRoutes');
    const unused = Object.keys(AuthRoutes).filter((k) => !usedNow.has(k));
    expect(unused.sort()).toEqual(Object.keys(AUTH_NOT_USED).sort());
  });

  test('前端引用的名字都在契约里（拼错了或契约删了它）', () => {
    for (const k of used('R')) expect(Object.keys(WebRoutes), `R.${k}`).toContain(k);
    for (const k of used('AuthRoutes')) expect(Object.keys(AuthRoutes), `AuthRoutes.${k}`).toContain(k);
  });

  test('故意造出失败：http.ts 里认不出的写法不会被当成「都用了」', () => {
    expect(used('NotARealPrefix').size).toBe(0);
    expect(used('R').size).toBeGreaterThan(10);
  });
});
