// 公开仓卫生检查：规则（rules.ts，只管真密钥）、白名单（allowlist.ts）、全仓扫（scan.ts）、
// 只看新增内容的扫法（diff.ts）和逐个提交扫（history.ts，推送前的闸用）、判定与退出码（check.ts、prepush.ts）、
// CI 专用的按提交扫（ci-history.ts，只报警、不挡合并：见 packages/conventions 的 ci-plan.ts）。
// 命令行入口：bin/check.ts 接在根目录的 pnpm check 里；bin/pre-push.ts 是 git pre-push 钩子；bin/install-hooks.ts 由
// prepare 调；bin/ci-history.ts 接在 .github/workflows/ci.yml 里。
export * from './allowlist.ts';
export * from './check.ts';
export * from './ci-history.ts';
export * from './diff.ts';
export * from './history.ts';
export * from './prepush.ts';
export * from './redact.ts';
export * from './rules.ts';
export * from './scan.ts';
