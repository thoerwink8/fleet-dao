// 旧地址 /efforts。思考档位并进了路由页（#1914 第 5 轮，「路由和思考档位能合并」）：
// 整张表在路由页的「思考档位」页签，每条路由展开后也能就地改（components/routing-efforts.tsx）。
// 打开就转到 /routing?tab=efforts。查询串里别的参数和 hash 原样带上，tab 固定成 efforts，不留死链。

import { Navigate, useLocation } from 'react-router';

export default function EffortsRedirect() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set('tab', 'efforts');
  return <Navigate to={{ pathname: '/routing', search: `?${params.toString()}`, hash }} replace />;
}
