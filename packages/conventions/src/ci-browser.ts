// Hosted Ubuntu Chromium preparation. No machine-wide APT sources are rewritten.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const KEYRING = '/usr/share/keyrings/ubuntu-archive-keyring.gpg';
const MIRRORS = '/etc/apt/apt-mirrors.txt';
const REQUIRED_SUITES = ['noble', 'noble-updates', 'noble-backports', 'noble-security'];
const COMPONENTS = ['main', 'restricted', 'universe', 'multiverse'];
const ubuntuUri = (value: string) =>
  /^https?:\/\/(?:azure\.archive|archive|security)\.ubuntu\.com\/ubuntu\/?$/.test(value);

function regularText(file: string): string {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  return readFileSync(file, 'utf8');
}

function optionalText(file: string): string | null {
  try {
    return regularText(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Accept only the Ubuntu 24.04 deb822 layout used by the hosted runner. */
export function validateUbuntuSources(text: string, mirrors: string | null): void {
  const suites = new Set<string>();
  const paragraphs = text
    .replace(/^\s*#.*$/gm, '')
    .trim()
    .split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const fields = new Map<string, string[]>();
    for (const line of paragraph.split('\n')) {
      if (!line.trim()) continue;
      const m = /^([A-Za-z-]+):[ \t]+(.+?)\s*$/.exec(line);
      const key = m?.[1];
      const value = m?.[2];
      if (!key || !value || fields.has(key)) throw new Error('Unknown Ubuntu sources layout');
      fields.set(key, value.split(/\s+/));
    }
    if ([...fields.keys()].sort().join(',') !== 'Components,Signed-By,Suites,Types,URIs')
      throw new Error('Unknown Ubuntu source fields');
    if (fields.get('Types')?.join(' ') !== 'deb' || fields.get('Signed-By')?.join(' ') !== KEYRING)
      throw new Error('Ubuntu source type or signature key is unknown');
    const components = fields.get('Components') ?? [];
    if (!components.length || components.some((x) => !COMPONENTS.includes(x)))
      throw new Error('Unknown Ubuntu source components');
    for (const suite of fields.get('Suites') ?? []) {
      if (!REQUIRED_SUITES.includes(suite)) throw new Error('Unknown Ubuntu source suite');
      suites.add(suite);
    }
    for (const uri of fields.get('URIs') ?? []) {
      if (ubuntuUri(uri)) continue;
      if (uri !== `mirror+file:${MIRRORS}` || !mirrors) throw new Error('Unknown Ubuntu source URI');
      const entries = mirrors.split('\n').filter((x) => x.trim() && !x.trimStart().startsWith('#'));
      // Mirror entries are public archive URLs; name the rejected ones so a runner-image change is diagnosable.
      const bad = entries.filter(
        (x) => !/^\S+(?:\s+priority:\d+)?\s*$/.test(x) || !ubuntuUri(x.trim().split(/\s+/)[0] ?? ''),
      );
      if (!entries.length) throw new Error('Unknown Ubuntu mirror list: no entries');
      if (bad.length) throw new Error(`Unknown Ubuntu mirror list: ${JSON.stringify(bad.slice(0, 5))}`);
    }
  }
  if (REQUIRED_SUITES.some((x) => !suites.has(x))) throw new Error('Required Ubuntu suite is missing');
}

type Runner = (command: string, args: string[], env: NodeJS.ProcessEnv) => number;
export interface BrowserOptions {
  platform?: string;
  arch?: string;
  etc?: string;
  tempRoot?: string;
  cli?: string;
  run?: Runner;
}

/** System dependencies use a scoped root APT_CONFIG; browsers keep the caller's cache. */
export function prepareCiBrowser(options: BrowserOptions = {}): number {
  if ((options.platform ?? process.platform) !== 'linux' || (options.arch ?? process.arch) !== 'x64')
    throw new Error('CI browser preparation requires Ubuntu 24.04 x64');
  const etc = options.etc ?? '/etc';
  const release = readFileSync(join(etc, 'os-release'), 'utf8');
  const field = (key: string) =>
    new RegExp(`^${key}=(?:"([^"\n]+)"|([^\n]+))$`, 'm').exec(release)?.slice(1).find(Boolean);
  if (field('ID') !== 'ubuntu' || field('VERSION_ID') !== '24.04' || field('VERSION_CODENAME') !== 'noble')
    throw new Error('Unknown CI distribution');
  const apt = join(etc, 'apt');
  const legacy = optionalText(join(apt, 'sources.list'));
  if (legacy?.split('\n').some((line) => line.trim() && !line.trimStart().startsWith('#')))
    throw new Error('Unknown legacy Ubuntu source layout');
  const sources = regularText(join(apt, 'sources.list.d', 'ubuntu.sources'));
  const mirrors = sources.includes(`mirror+file:${MIRRORS}`)
    ? regularText(join(apt, 'apt-mirrors.txt'))
    : null;
  validateUbuntuSources(sources, mirrors);
  // Resolve from web, so both commands use its lockfile-selected Playwright.
  const cli =
    options.cli ?? createRequire(resolve('packages/web/package.json')).resolve('@playwright/test/cli');
  const partPaths = readdirSync(join(apt, 'apt.conf.d'))
    .filter((name) => /^[A-Za-z0-9_.-]+$/.test(name) && (!name.includes('.') || name.endsWith('.conf')))
    .sort()
    .map((name) => join(apt, 'apt.conf.d', name));
  for (const path of partPaths) regularText(path);
  const originalMain = optionalText(join(apt, 'apt.conf'));
  const run: Runner =
    options.run ??
    ((command, args, env) => {
      const r = spawnSync(command, args, { env, stdio: 'inherit' });
      if (r.error) throw r.error;
      if (r.signal || r.status === null)
        throw new Error(`Browser preparation did not exit normally: ${r.signal}`);
      return r.status;
    });
  const temp = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'fleet-ci-browser-'));
  try {
    const config = join(temp, 'apt.conf');
    const selected = join(temp, 'ubuntu.sources');
    const empty = join(temp, 'empty');
    const emptyMain = join(temp, 'empty.conf');
    mkdirSync(empty);
    writeFileSync(emptyMain, '', { mode: 0o644 });
    writeFileSync(selected, sources, { mode: 0o644 });
    // Load original Parts/Main once in APT order, then disable implicit loads.
    // A Part cannot redirect Main after the final per-process source overrides.
    const quote = (path: string) => JSON.stringify(path.replaceAll('\\', '/'));
    writeFileSync(
      config,
      [
        ...partPaths.map((path) => `#include ${quote(path)};`),
        ...(originalMain === null ? [] : [`#include ${quote(join(apt, 'apt.conf'))};`]),
        `Dir::Etc::parts ${quote(empty)};`,
        `Dir::Etc::main ${quote(emptyMain)};`,
        `Dir::Etc::sourcelist ${quote(selected)};`,
        `Dir::Etc::sourceparts ${quote(empty)};`,
        'APT::Update::Error-Mode "any";',
        // Moving Binary's source leaves also moves their empty parent values.
        // Keep the supported Ubuntu defaults for all state/cache/log/etc paths.
        'Binary::apt-get::Dir "/";',
        'Binary::apt-get::Dir::Etc "etc/apt";',
        `Binary::apt-get::Dir::Etc::sourcelist ${quote(selected)};`,
        `Binary::apt-get::Dir::Etc::sourceparts ${quote(empty)};`,
        'Binary::apt-get::APT::Update::Error-Mode "any";',
        '',
      ].join('\n'),
      { mode: 0o644 },
    );
    // Playwright sudo does not preserve APT_CONFIG; start install-deps as root.
    const deps = run(
      'sudo',
      ['--', 'env', `APT_CONFIG=${config}`, process.execPath, cli, 'install-deps', 'chromium'],
      process.env,
    );
    if (deps !== 0) return deps;
    return run(process.execPath, [cli, 'install', 'chromium'], process.env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
