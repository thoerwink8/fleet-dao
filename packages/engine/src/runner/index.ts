// 无头一次性子进程段 runner（#554 切片 554-1；#509 流程重做骨架）：
// 三段一条龙（对题 / 动手 / 验收）各自一次「起 → 喂 brief → 收 → 记 runs」的公共架子。
//
// - one-shot：起子进程 + 超时 kill + 落盘 + 记 runs。
// - brief：三份交代类型 + 渲染（对题 / 动手 / 验收）。
// - verdict：跑完以后的判定（按段给最小证据）。**不许拿空 stdout 当跑完**。
// - not-wired：runs 表还没建（#556）时的占位写入（落 JSONL + 标 notWired）。
// - tier：按改动面分档判据（纯函数；不接 engine、不读 git）。

export * from './brief.ts';
export * from './not-wired.ts';
export * from './one-shot.ts';
export * from './tier.ts';
export * from './verdict.ts';
