import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const dir = resolve(import.meta.dirname, '../../../_tmp/shots/3784');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 700 }, deviceScaleFactor: 1 })
).newPage();
await page.goto(pathToFileURL(resolve(dir, 'compare.html')).href);
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(dir, 'compare-omo-1440.png'), fullPage: true });
await browser.close();
console.log('ok');
