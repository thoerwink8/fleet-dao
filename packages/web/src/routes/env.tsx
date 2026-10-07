// 旧地址 /env（环境页，#820）。本机 WSL 撤了以后只剩法国一台（决定 0022），这一页并进法国页（#1217）。
// 打开就转到 /france，查询串（?node= 选中的远程环境）和 hash 原样带上，书签和顶栏旧链接都不留死链。
// 后端接口不动：/api/env 还是这一台的六项事实。

import { Navigate, useLocation } from 'react-router';

export default function EnvRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/france', search, hash }} replace />;
}
