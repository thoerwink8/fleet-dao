# GitHub 短索引

全文在 git 历史。代码还在点名的只有这几处。

## 0

7. 旧网关的幂等账是每台机器一份的本地文件，换机不拷，正文里的幂等标记也只写不查。活动重试是至少一次，账要能按标记回查远端，避免重复写。见 `packages/github/src/idempotency.ts`。

### 1.1 发令牌

JWT：`iat` 用现在减 60 秒（抗时钟漂移），`exp` 用现在加 540 秒（9 分钟；GitHub 硬限 10 分钟）。安装令牌大约 1 小时过期，剩余不到 10 分钟就重换。见 `packages/github/src/app-auth.ts`。

### 5.2 互动限制自动续期

`GET` / `PUT /repos/{owner}/{repo}/interaction-limits`。`expiry` 不写时默认 `one_day`；续期要显式写 `six_months`。剩余不足 30 天就续，然后回读 `expires_at`，要 ≥ 现在 + 170 天。GET/PUT 失败、403、409 都是没查成，不是没事。见 `packages/github/src/interaction.ts`。

- **A8** 用 API 改仓库设置（自动合并、互动限制、分支保护），接口回 200 仍要回读该字段本身。不生效就报红。
