// 启动时读两个 App 的用户授权凭据。读不到不挡启动：导入仓库的接口会把原因原样说出来。
import {
  appFilesFromEnv,
  createAppCoverage,
  createGithubUserClient,
  GitHubClient,
  loadAppOAuth,
  loadApps,
} from '@fleet-dao/github';
import type { Deps } from './deps.ts';
import type { Logger } from './ports.ts';

export function loadGithubUserDeps(log: Logger): Pick<Deps, 'githubUser' | 'appCoverage' | 'githubUserProblem'> {
  try {
    const files = appFilesFromEnv();
    const oauth = {
      agent: loadAppOAuth('agent', files.agent),
      engine: loadAppOAuth('engine', files.engine),
    };
    const apps = loadApps(files);
    const client = new GitHubClient({ apps, log });
    return {
      githubUser: createGithubUserClient({ oauth }),
      appCoverage: createAppCoverage({ client }),
    };
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    log.warn('GitHub 用户授权没接上', { error: problem });
    return { githubUserProblem: problem };
  }
}
