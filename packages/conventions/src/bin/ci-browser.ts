// Shared by the full and quarantine E2E workflows.
import { prepareCiBrowser } from '../ci-browser.ts';

try {
  process.exitCode = prepareCiBrowser();
} catch (e) {
  console.error(e instanceof Error ? e.message : 'CI browser preparation failed');
  process.exitCode = 1;
}
