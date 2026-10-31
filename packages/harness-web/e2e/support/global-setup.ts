// 开跑前把前端打包一次（dist/ 由开发后端放在 /next/ 下）。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function globalSetup(): void {
  const cwd = resolve(import.meta.dirname, '../..');
  const r = spawnSync('npx', ['vite', 'build'], { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error('前端打包失败，e2e 不跑');
}
