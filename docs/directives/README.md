# 创始人引导

创始人拍的板和中途的引导，一条一个文件：`<月>/<编号>.md`。这里是记法的全文（仓根 `AGENTS.md` 只留指针），文件格式见 `packages/conventions/src/directives.ts` 开头。

- 记：当场 `pnpm progress directive`。不给原话就从本机 prompt-log 取本会话他最近一句、准确时间（+0800）和主人；取不到它会报错要你手填（`"原话" --at "时间"`）。记成 `docs/directives/<月>/<编号>.md`，自己开 PR 挂自动合并。
- 办完：在干活的工作树里 `pnpm progress done <编号>`，随那个 PR 提交；`pnpm pr:open --directive <编号>` 在正文写「引导 <编号>」，合进主线就算办完。
- 别人的：先 `pnpm progress claim <编号>`。主人会话确定已不在的，开会话钩子替指挥官会话自动认领；挂过 24 小时接不了的进「要你拍的」。
- 接手先 `pnpm progress read`。进度流水 `pnpm progress note "一句话"` 仍记在置顶单 #1055（那里也是驾驶舱「要你拍」答案的收件箱）。
- 开会话钩子读 origin/main 上「状态：待处理」的文件，只叫主人那个会话办。
- 10 位编号的是 2026-10-15 从置顶单 #1055 评论搬来的（编号沿用评论号），#1055 留作进度流水和驾驶舱答案的收件箱。
