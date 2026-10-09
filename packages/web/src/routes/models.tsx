// 旧地址 /models。模型目录做在路由页的「模型目录」标签里，这一页不再写「还没做」。
// 打开就转到 /routing?tab=models。查询串里别的参数和 hash 原样带上，tab 固定成 models。

import { Navigate, useLocation } from 'react-router';

export default function ModelsRedirect() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set('tab', 'models');
  const next = params.toString();
  return <Navigate to={{ pathname: '/routing', search: next ? `?${next}` : '', hash }} replace />;
}
