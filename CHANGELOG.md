# Changelog

写给人看的更新日志（#227）：格式照 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，小标题用白话。平时把要发出去的更新写进下面的 `[Unreleased]`。

发布一版（决定 0011 第 3、4 条）：版本号取当前版本里程碑（GitHub 上开着的 `v<N> 一句目标` 里 N 最小的那张），不按这里「上一版 +1」算。在 `release/v<N>` 分支上跑 `pnpm publish:pr`：它把 Unreleased 段收进 `## [v<N>] - <日期>`、提交、推，开一张「发布 v<N>」PR；创始人合并之后，`.github/workflows/release.yml` 核对版本里程碑、打 tag、建 GitHub Release、关这张里程碑、推飞书。

## [Unreleased]
