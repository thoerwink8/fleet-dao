// pnpm check 每个子进程外面的看守。不要直接跑；由 step-process.ts 的 runCheckedChild 拉起。
import { superviseCli } from '../step-process.ts';

await superviseCli(process.argv.slice(2));
