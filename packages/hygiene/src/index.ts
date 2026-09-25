// 公开仓卫生检查：规则（rules.ts）、已知敏感值名单（values.ts）、白名单（allowlist.ts）、全仓扫（scan.ts）、
// 只看新增内容的扫法（diff.ts，推送前的闸用）、判定与退出码（check.ts、prepush.ts）。
// 命令行入口：bin/check.ts 接在根目录的 pnpm check 里；bin/pre-push.ts 是 git pre-push 钩子；bin/install-hooks.ts 由 prepare 调。
export * from './allowlist.ts';
export * from './check.ts';
export * from './diff.ts';
export * from './prepush.ts';
export * from './rules.ts';
export * from './scan.ts';
export * from './values.ts';
