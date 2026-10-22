import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCiPostgres } from '../src/ci-postgres.ts';
import { runChild } from './child.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Real subprocess protocol fixture: models tools/server identity, not a real PG server.
function fixture(settings: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-pg-test-'));
  roots.push(root);
  const cli = join(root, 'pg.cjs');
  const transcript = join(root, 'calls.jsonl');
  const state = join(root, 'state.json');
  writeFileSync(
    cli,
    `
const fs=require('node:fs');
const [tool,...args]=process.argv.slice(2);
const env=process.env;
fs.appendFileSync(env.CALLS,JSON.stringify({tool,args})+'\\n');
const arg=k=>args[args.indexOf(k)+1];
if(env.FAIL===tool && (args[0]!=='--version'||env.FAIL_VERSION==='yes')) {
 console.error('fixture failure '+tool);process.exit(23);
}
if(args[0]==='--version') { console.log(tool+' (PostgreSQL) '+(env.TOOL_VERSION||'16.15'));process.exit(0); }
if(tool==='initdb') {
 if(arg('-U')==='fleet_test') {
  const pw=args.find(a=>a.startsWith('--pwfile='));
  if(!args.includes('--auth-host=scram-sha-256')||!pw||fs.readFileSync(pw.slice(9),'utf8')!=='fleet_test\\n')process.exit(90);
 } else if(!args.includes('--auth=trust'))process.exit(89);
 const data=arg('-D');fs.mkdirSync(data);fs.writeFileSync(data+'/postgresql.conf','');
 fs.writeFileSync(env.STATE,JSON.stringify({data,user:arg('-U')}));
} else {
 const s=JSON.parse(fs.readFileSync(env.STATE,'utf8'));
 if(tool==='pg_ctl') {
  const conf=fs.readFileSync(s.data+'/postgresql.conf','utf8');
  if(arg('-D')!==s.data||!args.includes('-w')||!conf.includes("listen_addresses = '127.0.0.1,::1'")||!conf.includes('socket')) process.exit(91);
  fs.writeFileSync(arg('-l'),'fixture server log retained');
 } else if(tool==='psql') {
  if(s.user==='fleet_test'&&env.PGPASSWORD!=='fleet_test')process.exit(88);
  if(!args.includes('-X')||arg('-h')!=='127.0.0.1'||arg('-p')!=='5432'||arg('-U')!==s.user||!args.includes('ON_ERROR_STOP=1'))process.exit(92);
  if(args.some(a=>a.startsWith('SELECT '))) console.log((env.SERVER_VERSION||'160015')+'\\t'+(env.WRONG_DATA||s.data));
  else if(!args.includes('CREATE DATABASE fleet_test_admin OWNER fleet_test'))process.exit(93);
 } else process.exit(94);
}
`,
  );
  const output: string[] = [];
  const start = (mode: 'test' | 'e2e' = 'e2e') =>
    startCiPostgres({
      tempRoot: root,
      mode,
      log: (line) => output.push(line),
      run(command, args, env) {
        return runChild(process.execPath, [cli, basename(command), ...args], {
          env: { ...env, ...settings, CALLS: transcript, STATE: state },
        });
      },
    });
  const calls = () =>
    readFileSync(transcript, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
  return { root, output, start, calls };
}

describe('CI PostgreSQL cluster bootstrap', () => {
  it.each(['test', 'e2e'] as const)('starts and SQL-verifies its own PG16 cluster for %s', (mode) => {
    const f = fixture();
    const cluster = f.start(mode);
    expect(cluster.startsWith(f.root)).toBe(true);
    const sql = f.calls().filter((c) => c.tool === 'psql' && !c.args.includes('--version'));
    expect(sql).toHaveLength(mode === 'test' ? 2 : 1);
    expect(f.output.join('\n')).toContain(`data_directory=${join(cluster, 'data')}`);
    expect(f.output.join('\n')).toContain('server_version_num=160015');
    if (mode === 'test') expect(sql[1]?.args).toContain('CREATE DATABASE fleet_test_admin OWNER fleet_test');
  });
  it('reports a missing executable instead of accepting a host server', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-pg-missing-'));
    roots.push(root);
    expect(() =>
      startCiPostgres({ tempRoot: root, mode: 'e2e', bin: join(root, 'absent'), log: () => {} }),
    ).toThrow(/ENOENT/);
  });
  it('rejects the wrong installed tool version before initialization', () => {
    const f = fixture({ TOOL_VERSION: '17.1' });
    expect(() => f.start()).toThrow(/expected PostgreSQL 16/);
    expect(f.calls()).toHaveLength(1);
  });
  it.each(['initdb', 'pg_ctl', 'psql'])('propagates %s failure and retains diagnostic logs', (tool) => {
    const f = fixture({ FAIL: tool });
    expect(() => f.start()).toThrow(`${tool} failed (exit 23)`);
    expect(f.output.join('\n')).toContain(`fixture failure ${tool}`);
    if (tool === 'pg_ctl')
      expect(f.calls().some((c) => c.tool === 'psql' && !c.args.includes('--version'))).toBe(false);
  });
  it.each([{ SERVER_VERSION: '170001' }, { WRONG_DATA: '/another/server/data' }])(
    'rejects a live server with the wrong identity %j',
    (settings) => {
      const f = fixture(settings);
      expect(() => f.start('test')).toThrow(/unexpected PostgreSQL cluster/);
      expect(
        f.calls().some((c) => c.args.includes('CREATE DATABASE fleet_test_admin OWNER fleet_test')),
      ).toBe(false);
    },
  );
  it('uses a new directory for every invocation, without stopping or overwriting another cluster', () => {
    const f = fixture();
    const first = f.start();
    const second = f.start();
    expect(first).not.toBe(second);
    expect(readFileSync(join(first, 'server.log'), 'utf8')).toContain('retained');
    expect(
      f
        .calls()
        .filter((c) => c.tool === 'pg_ctl')
        .every((c) => !c.args.includes('stop')),
    ).toBe(true);
  });
});
