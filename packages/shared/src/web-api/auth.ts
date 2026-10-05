// 驾驶舱接口约定（web-api）：登录与当前用户、凭据。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { EnvNameSchema } from './env.ts';
import { Id, Time } from './internal.ts';

// —— 登录与当前用户 ——

/**
 * 驾驶舱只放行创始人。以后要放别人进来，给 users 加一个显式字段（比如 cockpitAccess），不按角色推断。
 * （users 表同时是 GitHub 作者白名单，那边协作者和自家机器人照样算数。）
 */
export const UserRoleSchema = z.enum(['founder']);

export const MeResponse = z.object({
  user: z.object({
    id: Id,
    displayName: z.string(),
    role: UserRoleSchema,
    avatarUrl: z.string().optional(),
  }),
  /** 写操作放进请求头 `X-CSRF-Token`。 */
  csrfToken: z.string(),
  /**
   * 这一台环境叫什么（和环境页标题同一项，api.env 的 FLEET_MACHINE_NAME）：顶栏徽标只要这个名字，跟着 /me 一起带回，
   * 不为它每分钟去拉整份环境页（那一页每次都跑全套健康检查）。没配时照实给「认不出」+ 原因。
   */
  env: EnvNameSchema,
});

/**
 * 登录页要知道的：飞书应用编号（tt.requestAccess 要用；飞书登录没配置时没有）、开发环境免登是否开着、
 * 账密登录开没开（#120；后端恒为 true。可选只为兼容还不认这一项的旧后端：没有就当没开）。
 */
export const AuthConfigResponse = z.object({
  feishuAppId: z.string().optional(),
  devLogin: z.boolean(),
  passwordLogin: z.boolean().optional(),
});

/** 飞书客户端内免登：前端调 `tt.requestAccess` 拿到 code 交给后端换登录态。 */
export const FeishuAccessRequest = z.object({ code: z.string().min(1).max(1024) });

/** 只在开发环境存在的免登入口；userId 仍须在白名单里。 */
export const DevLoginRequest = z.object({ userId: Id });

/**
 * 账密登录（#120）：成功 204 + 和飞书登录同一种会话 Cookie（再 GET /api/me 取 CSRF 令牌）。
 * 失败都是统一的错误体（ApiErrorBody）：
 * - 401 code=bad_credentials：没这个人、没设过密码、密码错、不在白名单，一律这一句，不区分；
 * - 429 code=locked，details.until = 锁到什么时候（同一用户名或同一来源连续输错 5 次，锁 15 分钟；锁期内对的密码也不放）。
 * 字段只限长度，格式不合（比如用户名写错了格式）也按 401 答，不提示。
 */
export const PasswordLoginRequest = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export const PASSWORD_MIN_LENGTH = 10;

/**
 * 设置页看账密登录的状态。canSetWithoutCurrent：还没设过密码、且这次会话是 10 分钟内飞书登录的——
 * 只有这时能不带当前密码设第一次；过了 10 分钟要重新用飞书登录一次。
 */
export const CredentialsResponse = z.object({
  hasPassword: z.boolean(),
  username: z.string().nullable(),
  passwordChangedAt: Time.nullable(),
  canSetWithoutCurrent: z.boolean(),
});

/**
 * 设或改用户名、密码（PUT，写操作带 X-CSRF-Token），成功 204。已设过密码的，改什么都要带 currentPassword。
 * 设、改了密码：这个人别处已登的会话全部作废（接口回 401 session_revoked）；这一处的响应里换上新 Cookie，CSRF 令牌不变。
 * 用户名 3–32 位（字母或数字开头，字母、数字、点、下划线、连字符），大小写不敏感地唯一；密码至少 10 位。
 * 失败（ApiErrorBody，details.field 指明哪一栏）：
 * - 400 invalid_username / username_taken（field=username）、username_required（第一次设密码没给用户名，field=username）；
 * - 400 weak_password / password_too_long（field=newPassword）、nothing_to_change（两样都没给）；
 * - 400 current_password_required（field=currentPassword）；401 bad_current_password（field=currentPassword，也计入输错次数）；
 * - 403 recent_feishu_login_required：没设过密码、这次会话不是 10 分钟内飞书登录的；
 * - 429 locked（details.until）。
 */
export const UpdateCredentialsRequest = z.object({
  username: z.string().max(200).optional(),
  newPassword: z.string().max(1024).optional(),
  currentPassword: z.string().max(1024).optional(),
});
