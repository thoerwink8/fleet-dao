// 过渡转发：白名单搬到 @fleet-dao/store 了（引擎也要用，不能反着依赖 api）。github.ts 还从这里取；
// 那份文件碰公网入口、改它要先审，等它搬进 store 时一并删掉这个转发（specs/865-分层纠正/方案.md 第 3 步）。
export { GhUser, type GithubWhitelist, githubWhitelist, isTrusted } from '@fleet-dao/store';
