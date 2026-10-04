// 账密登录和设置页「账密」一节的白话：后端给什么错、页面怎么说。
// 规矩出处：shared/web-api/auth.ts 里 PasswordLoginRequest、UpdateCredentialsRequest 的注释（错误码、details.field、锁多久）。
// 登录错误一律不透露「这个账号在不在」：后端对没这个人、没设过密码、密码错都回同一句 bad_credentials，这里也只说那一句。
import { PASSWORD_MIN_LENGTH } from '@fleet-dao/shared';
import { z } from 'zod';
import { ApiError, errorText } from '../api/client';
import { formatClock, formatIn } from './format';

/** 登录请求字段的长度上限（和 shared 的 PasswordLoginRequest 同一个数；输入框的 maxLength 也用它们）。 */
export const USERNAME_MAX = 200;
export const PASSWORD_MAX = 1024;
export { PASSWORD_MIN_LENGTH };

const Locked = z.object({ until: z.iso.datetime({ offset: true }) });

/** 锁到什么时候：后端 details.until 是 ISO 时间；认不出就不猜具体时刻，只说「过一会儿」。 */
function lockedText(details: unknown, now: number): string {
  const parsed = Locked.safeParse(details);
  if (!parsed.success || Date.parse(parsed.data.until) <= now) {
    return '输错次数太多，已临时锁住，请过一会儿再试。';
  }
  const { until } = parsed.data;
  return `输错次数太多，已临时锁住：${formatIn(until, now)}（${formatClock(until)}）可以再试，期间输对的密码也不放行。`;
}

/** 登录页上账密登录失败时说什么：分得清「密码不对」「被锁了 / 请求太频繁」「读不到后端」「后端出错」。 */
export function loginErrorText(e: unknown, now: number = Date.now()): string {
  if (!(e instanceof ApiError)) return errorText(e);
  if (e.code === 'bad_credentials') return '用户名或密码不对，请检查后再试。';
  if (e.code === 'locked') return lockedText(e.details, now);
  if (e.status === 429) return '请求太频繁，请稍后再试。';
  if (e.status === 0 || e.code === 'network') {
    return `读不到后端，不是密码的问题：${e.message}。请确认服务在运行、网络是通的，再试一次。`;
  }
  if (e.status >= 500) return `后端出错了（${e.status}），不是密码的问题：${e.message}`;
  return e.message;
}

export type CredentialField = 'username' | 'newPassword' | 'currentPassword';

const FIELDS: readonly CredentialField[] = ['username', 'newPassword', 'currentPassword'];

export interface CredentialFailure {
  /** 错在哪一栏（后端 details.field）；没指明就是整体的错，显示在表单底部。 */
  field: CredentialField | undefined;
  message: string;
}

/** 设 / 改账密失败：按 details.field 落到对应的栏；锁了、没资格、读不到后端这类不属于某一栏的写成整体错误。 */
export function credentialFailure(e: unknown, now: number = Date.now()): CredentialFailure {
  if (!(e instanceof ApiError)) return { field: undefined, message: errorText(e) };
  if (e.code === 'locked') return { field: undefined, message: lockedText(e.details, now) };
  if (e.status === 0 || e.code === 'network') {
    return { field: undefined, message: `读不到后端，没有保存：${e.message}` };
  }
  const detail = z
    .object({ field: z.enum(FIELDS as [CredentialField, ...CredentialField[]]) })
    .safeParse(e.details);
  return { field: detail.success ? detail.data.field : undefined, message: e.message };
}
