# 旧系统审计短索引

> 2026-09-24/25 对旧系统（windsurf-dao、ai-gateway-stack）的审计全文在 git 历史里。路径当时的行号已经失效。这里只留代码、测试或现行文档还在点名的条目。

本目录一共 6 个文件：这份说明，加上下表 5 份，表和文件一一对应。旧引擎那份不在本目录，在 [old-engine-audit.md](../archive/old-engine-audit.md)（写的是旧引擎，现行看 `packages/engine/AGENTS.md`）。`data-jev.md`、`old-issues.md` 没有代码或测试引用，整份已删。计划不在仓里，看 `pnpm plan`。

| 手册 | 还留着什么 |
|---|---|
| [adapters.md](adapters.md) | 渠道插头还在点名的条目，和 Mirasim 第八节的帧 |
| [quota.md](quota.md) | 额度、切号、选路测试还在点名的 Q |
| [deploy.md](deploy.md) | 装机还在点名的端口、P 条、备份新鲜度 |
| [errors.md](errors.md) | S09，和第 8 节第 11 条；样本在失败夹具里 |
| [github.md](github.md) | 幂等账、发令牌、互动限制续期、回读 |

编号只在各自手册内唯一。跨手册引用写「手册名 编号」，如 `adapters CC-10`。数字是审计时的读数或旧配置，当起步值，实测后调。
