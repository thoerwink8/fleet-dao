// 后端（@fleet-dao/api）和引擎（@fleet-dao/engine）共用、不碰 HTTP 的那一层。依赖方向只许 api → store、engine → store，
// store 不许依赖 api、engine（packages/conventions/test/package-layers.test.ts 钉住）。
export { isSerial, isUuid, parseCursor } from './ids.ts';
export { jsonLogger, silentLogger } from './log.ts';
export * from './ports.ts';
export {
  actorFor,
  GhUser,
  type GithubWhitelist,
  githubWhitelist,
  isTrusted,
  memberFor,
} from './whitelist.ts';
