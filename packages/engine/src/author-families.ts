// 冷验收认不出作者是哪一族的几个族名（纯常量：routing/filter.ts 会被打进工作流，这里不引任何模块）。
// 为什么：冷验收要换一个「不同的族」来验，作者族认不出就挑不出不同的族、验不了。
// cursor：Cursor Auto 背后到底是哪家不知道；unclassified：拆不出的串；jev：不是写代码的模型。
// 写码阶段不派这几家（routing/filter.ts），冷验收遇到它们按「认不出」停（cold-verify-run.ts）。
export const UNVERIFIABLE_AUTHOR_FAMILIES: ReadonlySet<string> = new Set(['cursor', 'unclassified', 'jev']);
