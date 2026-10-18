// 公开机器只读契约，不属于浏览器 FleetApi，不提供写口。
export const PublicAcceptanceRoute = {
  method: 'GET',
  path: '/api/public/acceptance/v1/repos/:githubId/issues/:issue',
} as const;
