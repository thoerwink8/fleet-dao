// 引擎自己的 git（抓主线、推分支、导入会话交来的包）出网用的父环境：本机档登记了会话代理（FLEET_SESSION_PROXY，经 Windows 上的
// Clash）就带上 http(s)_proxy 那几个变量——WSL 直连 github.com 时通时不通（Connection reset，动手前建工作树就卡在抓主线上，
// #786 同一个根）；法国不登记，环境原样。git 子进程的环境由 packages/github 的 gitEnv 照搬父环境（只去掉凭据一类），所以
// 代理变量放在这里的父环境里就够；引擎进程自己的环境和起会话的环境（只从白名单抄）都不动。
// 改这里之前必须知道：代理值认不出（带账号密码、socks）直接抛（sessionProxyEnv → parseSessionProxy），不悄悄改成直连。
import { sessionProxyEnv } from '@fleet-dao/adapters';

export function gitNetworkEnv(
  env: Readonly<Record<string, string | undefined>>,
  proxy: string | undefined,
): Record<string, string | undefined> {
  return { ...env, ...(proxy === undefined ? {} : sessionProxyEnv(proxy)) };
}
