import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareCiBrowser, validateUbuntuSources } from '../src/ci-browser.ts';
import { runChild } from './child.ts';

const UBUNTU = `Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-browser-test-'));
  roots.push(root);
  const etc = join(root, 'etc');
  const apt = join(etc, 'apt');
  mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
  mkdirSync(join(apt, 'apt.conf.d'));
  writeFileSync(join(etc, 'os-release'), 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n');
  const ubuntu = join(apt, 'sources.list.d', 'ubuntu.sources');
  writeFileSync(ubuntu, UBUNTU);
  const microsoft = join(apt, 'sources.list.d', 'microsoft-prod.list');
  writeFileSync(microsoft, 'deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n');
  const calls: Array<{ command: string; args: string[] }> = [];
  // A real subprocess models the locked CLI's APT child and browser installer.
  // It reads the real helper's files, refuses unscoped sources, and returns failures.
  const cli = join(root, 'fake-playwright.cjs');
  writeFileSync(
    cli,
    `
const fs=require('node:fs');
const command=process.argv[2];
if(command==='install-deps') {
 const conf=fs.readFileSync(process.env.APT_CONFIG,'utf8');
 const source=JSON.parse(/Dir::Etc::sourcelist ("[^\\n]+?");/.exec(conf)[1]);
 const parts=JSON.parse(/Dir::Etc::sourceparts ("[^\\n]+?");/.exec(conf)[1]);
 const text=fs.readFileSync(source,'utf8');
 if(fs.readdirSync(parts).length||text.includes('microsoft')||!text.includes('noble-security')) process.exit(99);
 if(!conf.includes('APT::Update::Error-Mode "any";'))process.exit(98);
 fs.writeFileSync(process.env.QUERIED_SOURCES,text);
 process.exit(Number(process.env.DEPS_EXIT||0));
}
if(command!=='install'||process.argv[3]!=='chromium')process.exit(97);
process.exit(Number(process.env.BROWSER_EXIT||0));
`,
  );
  const queried = join(root, 'queried.sources');
  const prepare = (deps = 0, browser = 0) =>
    prepareCiBrowser({
      etc,
      platform: 'linux',
      arch: 'x64',
      tempRoot: root,
      cli,
      run(command, args, env) {
        calls.push({ command, args });
        if (command === 'sudo') {
          expect(args.slice(0, 2)).toEqual(['--', 'env']);
          expect(args.slice(3)).toEqual([process.execPath, cli, 'install-deps', 'chromium']);
          const aptConfig = (args[2] ?? '').slice('APT_CONFIG='.length);
          expect(args[2]).toMatch(/^APT_CONFIG=/);
          const result = runChild(process.execPath, [cli, 'install-deps', 'chromium'], {
            env: { ...env, APT_CONFIG: aptConfig, QUERIED_SOURCES: queried, DEPS_EXIT: String(deps) },
          });
          return result.status;
        }
        expect(command).toBe(process.execPath);
        const result = runChild(command, args, {
          env: { ...env, BROWSER_EXIT: String(browser) },
        });
        return result.status;
      },
    });
  return { root, etc, apt, ubuntu, microsoft, cli, calls, queried, prepare };
}

describe('CI browser preparation', () => {
  it('uses Ubuntu sources without querying the failing Microsoft source; preserves originals and user browser cache', () => {
    const f = fixture();
    const before = readFileSync(f.microsoft, 'utf8');
    expect(f.prepare()).toBe(0);
    expect(readFileSync(f.queried, 'utf8')).toBe(UBUNTU);
    expect(readFileSync(f.microsoft, 'utf8')).toBe(before);
    expect(readFileSync(f.ubuntu, 'utf8')).toBe(UBUNTU);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual({ command: process.execPath, args: [f.cli, 'install', 'chromium'] });
    expect(readdirSync(f.root).filter((x) => x.startsWith('fleet-ci-browser-'))).toEqual([]);
  });
  it.each([100, 42])(
    'propagates required-source/signature or missing-package failure %s and never attempts browsers',
    (code) => {
      const f = fixture();
      expect(f.prepare(code)).toBe(code);
      expect(f.calls).toHaveLength(1);
      expect(readdirSync(f.root).filter((x) => x.startsWith('fleet-ci-browser-'))).toEqual([]);
    },
  );
  it('propagates real browser installer failure after dependencies', () => {
    const f = fixture();
    expect(f.prepare(0, 23)).toBe(23);
    expect(f.calls).toHaveLength(2);
  });
  it('cleans scoped configuration when launching the dependency process fails', () => {
    const f = fixture();
    expect(() =>
      prepareCiBrowser({
        etc: f.etc,
        platform: 'linux',
        arch: 'x64',
        tempRoot: f.root,
        cli: f.cli,
        run() {
          throw Error('ENOENT');
        },
      }),
    ).toThrow('ENOENT');
    expect(readdirSync(f.root).filter((x) => x.startsWith('fleet-ci-browser-'))).toEqual([]);
  });
  it.each(['win32', 'darwin'])('refuses unknown platform %s before install', (platform) => {
    expect(() => prepareCiBrowser({ platform })).toThrow('requires Ubuntu');
  });
  it('refuses unsupported architecture or distribution', () => {
    const f = fixture();
    expect(() => prepareCiBrowser({ platform: 'linux', arch: 'arm64' })).toThrow('requires Ubuntu');
    writeFileSync(join(f.etc, 'os-release'), 'ID=ubuntu\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\n');
    expect(() => f.prepare()).toThrow('Unknown CI distribution');
    expect(f.calls).toHaveLength(0);
  });
  it('refuses missing/legacy source layout before install', () => {
    const f = fixture();
    rmSync(f.ubuntu);
    expect(() => f.prepare()).toThrow();
    writeFileSync(f.ubuntu, UBUNTU);
    writeFileSync(join(f.apt, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main');
    expect(() => f.prepare()).toThrow('legacy');
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    UBUNTU.replace('noble-security', ''),
    UBUNTU.replace('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg', 'Trusted: yes'),
    UBUNTU.replace('azure.archive.ubuntu.com', 'packages.microsoft.com'),
    `${UBUNTU}Allow-Insecure: yes\n`,
    UBUNTU.replace('Types: deb', 'Types: deb\nTypes: deb'),
    UBUNTU.replace('Suites: noble', 'Suites: jammy'),
  ])('rejects malformed, untrusted or incomplete Ubuntu source %s', (text) => {
    expect(() => validateUbuntuSources(text, null)).toThrow();
  });
  it('accepts the runner official mirror+file list, rejects unknown/missing mirror contents', () => {
    const s = UBUNTU.replace(
      'http://azure.archive.ubuntu.com/ubuntu/',
      'mirror+file:/etc/apt/apt-mirrors.txt',
    );
    expect(() =>
      validateUbuntuSources(
        s,
        'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/ priority:2\nhttps://security.ubuntu.com/ubuntu/ priority:3\n',
      ),
    ).not.toThrow();
    expect(() =>
      validateUbuntuSources(s, 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\n'),
    ).not.toThrow();
    expect(() =>
      validateUbuntuSources(s, 'http://evil.ec2.archive.ubuntu.com.example.org/ubuntu/ priority:1'),
    ).toThrow('Unknown Ubuntu mirror list');
    expect(() => validateUbuntuSources(s, null)).toThrow();
    expect(() => validateUbuntuSources(s, 'https://example.org/ubuntu priority:1')).toThrow(
      'Unknown Ubuntu mirror list: ["https://example.org/ubuntu priority:1"]',
    );
    expect(() => validateUbuntuSources(s, '# only a comment\n')).toThrow(
      'Unknown Ubuntu mirror list: no entries',
    );
  });
  it('loads original Parts/Main once before disabling implicit loads and applying final source settings', () => {
    const f = fixture();
    writeFileSync(join(f.apt, 'apt.conf'), 'Dir::Etc::sourceparts "unrelated";\n');
    writeFileSync(join(f.apt, 'apt.conf.d', '10-first'), 'APT::Marker "first";\n');
    writeFileSync(join(f.apt, 'apt.conf.d', '99-last.conf'), 'APT::Marker "last";\n');
    writeFileSync(join(f.apt, 'apt.conf.d', '99-last.conf.bak'), 'APT::Marker "ignored";\n');
    prepareCiBrowser({
      etc: f.etc,
      platform: 'linux',
      arch: 'x64',
      tempRoot: f.root,
      cli: f.cli,
      run(command, args) {
        if (command === 'sudo') {
          const config = readFileSync((args[2] ?? '').slice('APT_CONFIG='.length), 'utf8');
          expect(config.indexOf('#include')).toBeLessThan(config.indexOf('Dir::Etc::sourceparts'));
          expect(config.indexOf('10-first')).toBeLessThan(config.indexOf('99-last.conf'));
          expect(config).not.toContain('99-last.conf.bak');
          expect(config).toContain('empty.conf');
          expect(config).toContain('Dir::Etc::main');
          expect(existsSync((args[2] ?? '').slice('APT_CONFIG='.length))).toBe(true);
        }
        return 0;
      },
    });
  });
  it.skipIf(process.platform !== 'linux')(
    'real APT ignores later source/Main/Binary redirection while preserving original Parts/Main options (offline)',
    () => {
      const f = fixture();
      // apt-config normally applies its own Binary subtree. This alias applies
      // apt-get's subtree, including its parent values, just like the installer.
      const aptConfigPath = runChild('which', ['apt-config']);
      expect(aptConfigPath.status).toBe(0);
      const aptGetConfig = join(f.root, 'apt-get');
      symlinkSync(aptConfigPath.stdout.trim(), aptGetConfig);
      const paths = [
        'ROOT',
        'Dir/d',
        'ETC',
        'Dir::Etc/d',
        'STATE',
        'Dir::State/d',
        'LISTS',
        'Dir::State::lists/d',
        'CACHE',
        'Dir::Cache/d',
        'ARCHIVES',
        'Dir::Cache::archives/d',
        'LOG',
        'Dir::Log/d',
        'STATUS',
        'Dir::State::status/f',
        'METHODS',
        'Dir::Bin::methods/d',
        'TRUSTED',
        'Dir::Etc::trustedparts/d',
        'PREFERENCES',
        'Dir::Etc::preferences/f',
      ];
      const baseline = runChild(aptGetConfig, ['shell', ...paths], {
        env: { ...process.env, APT_CONFIG: undefined },
      });
      expect(baseline.status).toBe(0);
      const bad = join(f.apt, 'microsoft.list');
      const redirected = join(f.apt, 'redirected.conf');
      writeFileSync(bad, 'deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n');
      writeFileSync(redirected, `Dir::Etc::sourcelist "${bad}";\nAPT::UnexpectedMain "loaded";\n`);
      writeFileSync(
        join(f.apt, 'apt.conf.d', '50-redirect.conf'),
        [
          'APT::FixtureParts "loaded";',
          `Dir::Etc::main "${redirected}";`,
          `Dir::Etc::sourcelist "${bad}";`,
          `Binary::apt-get::Dir::Etc::main "${redirected}";`,
          `Binary::apt-get::Dir::Etc::sourcelist "${bad}";`,
        ].join('\n'),
      );
      writeFileSync(
        join(f.apt, 'apt.conf'),
        [
          'APT::FixtureMain "loaded";',
          `Dir::Etc::sourceparts "${join(f.apt, 'sources.list.d')}";`,
          `Binary::apt-get::Dir::Etc::sourceparts "${join(f.apt, 'sources.list.d')}";`,
          'Binary::apt-get::APT::Update::Error-Mode "persistent";',
        ].join('\n'),
      );
      let observed = false;
      expect(
        prepareCiBrowser({
          etc: f.etc,
          platform: 'linux',
          arch: 'x64',
          tempRoot: f.root,
          cli: f.cli,
          run(command, args, env) {
            if (command !== 'sudo') return 0;
            const childEnv = { ...env, APT_CONFIG: (args[2] ?? '').slice('APT_CONFIG='.length) };
            const dump = runChild(aptGetConfig, ['dump'], { env: childEnv });
            expect(dump.status).toBe(0);
            expect(dump.stdout).toContain('APT::FixtureParts "loaded"');
            expect(dump.stdout).toContain('APT::FixtureMain "loaded"');
            expect(dump.stdout).not.toContain('APT::UnexpectedMain');
            expect(dump.stdout).toContain('APT::Update::Error-Mode "any"');
            const actualPaths = runChild(aptGetConfig, ['shell', ...paths], { env: childEnv });
            expect(actualPaths.status).toBe(0);
            expect(actualPaths.stdout).toBe(baseline.stdout);
            const indices = runChild('apt-get', ['indextargets', '--no-release-info', '--format', '$(URI)'], {
              env: childEnv,
            });
            expect(indices.status).toBe(0);
            const uris = indices.stdout.trim().split('\n');
            expect(uris.length).toBeGreaterThan(0);
            expect(
              uris.every((uri) =>
                /^http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/dists\/noble(?:-(?:updates|backports|security))?\//.test(
                  uri,
                ),
              ),
            ).toBe(true);
            expect(indices.stdout).not.toContain('microsoft');
            observed = true;
            return 0;
          },
        }),
      ).toBe(0);
      expect(observed).toBe(true);
      expect(readdirSync(f.root).filter((x) => x.startsWith('fleet-ci-browser-'))).toEqual([]);
    },
  );
});
