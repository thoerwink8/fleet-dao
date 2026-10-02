// 三段各自的入口（对题 / 动手 / 验收）——每一段只做一件事：起一次 one-shot 会话 + 判成败。
// 调度、挑档、推分支、开 PR、合并全都不在这里。

export * from './manual.ts';
export * from './scope.ts';
export * from './verify.ts';
