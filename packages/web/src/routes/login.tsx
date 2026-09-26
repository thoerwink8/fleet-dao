// 登录页（在外壳外面）。三版设计稿先并排挂着，?v=a|b|c|d 切换（#54：创始人挑定一版后收成一版）：
// a「门后就是驾驶舱」、b「先说一句」、c「你只管拍板」、d「飞书蓝」。登录怎么走三版一样，见 login/flow.tsx。
// 带了 ?v= 的是在看稿：已经登录也不跳走。

import { Navigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useMe } from '../api/client';
import { safeNext } from '../login/flow';
import { DecideLogin } from '../login/variant-decide';
import { DoorLogin } from '../login/variant-door';
import { FeishuLogin } from '../login/variant-feishu';
import { SayLogin } from '../login/variant-say';

export { safeNext };

export function meta() {
  return [{ title: brand.title('登录') }];
}

export const LOGIN_VARIANTS = ['a', 'b', 'c', 'd'] as const;
export type LoginVariant = (typeof LOGIN_VARIANTS)[number];

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const v = params.get('v');
  const preview = LOGIN_VARIANTS.includes(v as LoginVariant);
  if (me.data && !preview) return <Navigate to={next} replace />;
  if (v === 'b') return <SayLogin next={next} />;
  if (v === 'c') return <DecideLogin next={next} />;
  if (v === 'd') return <FeishuLogin next={next} />;
  return <DoorLogin next={next} />;
}
