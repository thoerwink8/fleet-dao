import { startCiPostgres } from '../ci-postgres.ts';

try {
  const mode = process.argv[2];
  if ((mode !== 'test' && mode !== 'e2e') || process.argv.length !== 3 || !process.env.RUNNER_TEMP)
    throw new Error('Usage: ci-postgres.ts test|e2e (RUNNER_TEMP required)');
  startCiPostgres({ tempRoot: process.env.RUNNER_TEMP, mode });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CI PostgreSQL startup failed');
  process.exitCode = 1;
}
