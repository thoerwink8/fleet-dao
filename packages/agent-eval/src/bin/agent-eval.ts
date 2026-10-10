// pnpm agent-eval：子代理能力探查入口（#1641）。退出码见 ../cli.ts。
import { main } from '../cli.ts';

process.exitCode = await main(process.argv.slice(2));
