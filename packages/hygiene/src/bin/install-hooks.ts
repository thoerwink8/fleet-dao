// pnpm install 的 prepare 调它：把这个仓的 git 钩子目录设成 .githooks（里面是推送前的卫生检查）。
// 不在 git 工作树里（打包安装之类）就什么都不做；core.hooksPath 已经被设成别的目录，不覆盖，只提示怎么接。
import { spawnSync } from 'node:child_process';

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

if (git('rev-parse', '--is-inside-work-tree').stdout.trim() === 'true') {
  const current = git('config', '--get', 'core.hooksPath').stdout.trim();
  if (current === '' || current === '.githooks') {
    if (current === '') git('config', 'core.hooksPath', '.githooks');
  } else {
    console.warn(
      `core.hooksPath 已经是 ${current}，没改。推送前的卫生检查要接上：在那个目录的 pre-push 里调 node packages/hygiene/src/bin/pre-push.ts "$@"`,
    );
  }
}
