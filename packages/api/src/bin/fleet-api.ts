// 后端管理命令的入口：node packages/api/src/bin/fleet-api.ts <命令> ...（法国上经 packages/api/bin/fleet-api 跑）。
import { main } from '../cli.ts';

process.exitCode = await main(process.argv.slice(2));
