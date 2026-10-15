// 香港本机的状态页。必须整页打开：/health/ 是 nginx 上的静态文件，不是驾驶舱里的路由。
import { isGatewayError } from '../api/client';

export const HEALTH_PAGE_HREF = '/health/';

/** 这类错误才出现。链过去能看见法国那台机器、隧道、数据库哪一项是红的。 */
export function GatewayHealthLink({ error }: { error: unknown }) {
  if (!isGatewayError(error)) return null;
  return (
    <a href={HEALTH_PAGE_HREF} className="mt-1 block text-body text-foreground underline underline-offset-2">
      看状态页：法国那台机器、隧道、数据库哪一项红了
    </a>
  );
}
