/**
 * `pnpm progress:directive` 记完引导后当场问的一句（决定 0081）：「项目特有还是各仓通用」以前默认落在项目一侧、
 * 全靠会话里当场醒悟，同一条原则说两次都只记进了一个仓。单独一个文件、不带导入：钉它的测试
 * agents/test/rules/repo-entry.rules.test.ts 直接导入它，不把整个进度单模块拖进 agents 的类型检查。
 */
export const DIRECTIVE_SCOPE_HINT =
  '这条是各仓通用吗？创始人说的原则、偏好默认各仓通用：当场改 `agents/shared-rules.md` 开 PR（改标准）；' +
  '只此仓有效的，要他明说过，或在仓里记决定的地方写明为什么。';
