import { diagnoseCiRuntime, runCiVitest } from '../ci-runtime-run.ts';

const [command, ...args] = process.argv.slice(2);
if (command === 'run') process.exitCode = await runCiVitest({ args });
else if (command === 'diagnose') process.exitCode = diagnoseCiRuntime();
else {
  console.error('CI_RUNTIME_EVIDENCE invalid-command');
  process.exitCode = 1;
}
