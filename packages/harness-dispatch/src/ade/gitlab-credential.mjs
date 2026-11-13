// git 要口令时读数据目录里的令牌文件。脚本本身没有令牌。
// git 把动作放在第一个参数上（get），描述从标准输入进来。
import { readFileSync } from 'node:fs';

const file = process.env.FLEET2_GITLAB_TOKEN_FILE;
if (!file) process.exit(1);

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  if (process.argv[2] !== 'get') return;
  const token = readFileSync(file, 'utf8').trim();
  if (!token) process.exit(1);
  process.stdout.write(`username=oauth2\npassword=${token}\n`);
});
