// Shared CI cluster: use the runner's PG16, never a network image or host service (#3649).
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type CommandResult = { status: number; stdout: string; stderr: string };
export interface PostgresOptions {
  tempRoot: string;
  mode: 'test' | 'e2e';
  bin?: string;
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult;
  log?: (message: string) => void;
}

/** Leaves data/logs under RUNNER_TEMP; only this fresh cluster can satisfy readiness. */
export function startCiPostgres(options: PostgresOptions): string {
  const bin = options.bin ?? '/usr/lib/postgresql/16/bin';
  const cluster = mkdtempSync(join(realpathSync(options.tempRoot), 'fleet-ci-pg-'));
  const data = join(cluster, 'data');
  const socket = join(cluster, 'socket');
  const serverLog = join(cluster, 'server.log');
  const commandLog = join(cluster, 'commands.log');
  const log = options.log ?? console.log;
  log(`CI PostgreSQL cluster: ${cluster}`);
  mkdirSync(socket);
  const env = {
    ...process.env,
    PGCONNECT_TIMEOUT: '10',
    PGPASSWORD: options.mode === 'test' ? 'fleet_test' : '',
    PGSERVICE: '',
    PGSERVICEFILE: '',
  };
  const run =
    options.run ??
    ((command, args, childEnv) => {
      const result = spawnSync(command, args, { env: childEnv, encoding: 'utf8', timeout: 90_000 });
      if (result.error) throw result.error;
      if (result.status === null) throw new Error(`${command} did not exit normally: ${result.signal}`);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
  function exec(tool: string, args: string[]): string {
    let result: CommandResult;
    try {
      result = run(join(bin, tool), args, env);
    } catch (error) {
      appendFileSync(commandLog, `${tool}: ${String(error)}\n`);
      throw error;
    }
    appendFileSync(commandLog, `${tool} ${args.join(' ')}\n${result.stdout}${result.stderr}\n`);
    if (result.status !== 0) throw new Error(`${tool} failed (exit ${result.status})`);
    return result.stdout.trim();
  }
  try {
    for (const tool of ['initdb', 'pg_ctl', 'postgres', 'psql']) {
      const version = exec(tool, ['--version']);
      if (!/\(PostgreSQL\) 16(?:\.|\s|$)/.test(version))
        throw new Error(`${tool}: expected PostgreSQL 16, got ${version}`);
    }
    const user = options.mode === 'test' ? 'fleet_test' : 'postgres';
    const auth = ['--auth=trust'];
    if (options.mode === 'test') {
      const passwordFile = join(cluster, 'password');
      writeFileSync(passwordFile, 'fleet_test\n', { mode: 0o600 });
      auth.splice(0, 1, '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`);
    }
    exec('initdb', ['-D', data, '-U', user, ...auth, '--encoding=UTF8', '--locale=C']);
    // Configuration is in this new data directory, not a global cluster configuration.
    appendFileSync(
      join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1,::1'\nport = 5432\nunix_socket_directories = '${socket.replaceAll("'", "''")}'\n`,
    );
    exec('pg_ctl', ['start', '-D', data, '-l', serverLog, '-w', '-t', '60']);
    const connection = [
      '-X',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      user,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ];
    const identity = exec('psql', [
      ...connection,
      '-At',
      '-F',
      '\t',
      '-c',
      "SELECT current_setting('server_version_num'), current_setting('data_directory')",
    ]);
    const [version, actualData] = identity.split('\t');
    if (!version || !/^16\d{4}$/.test(version) || actualData !== data)
      throw new Error(`Connected to an unexpected PostgreSQL cluster: ${identity}`);
    if (options.mode === 'test') {
      exec('psql', [...connection, '-c', 'CREATE DATABASE fleet_test_admin OWNER fleet_test']);
    }
    log(`CI PostgreSQL verified: server_version_num=${version} data_directory=${actualData} user=${user}`);
    return cluster;
  } catch (error) {
    for (const path of [commandLog, serverLog]) {
      try {
        log(`${path}\n${readFileSync(path, 'utf8')}`);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      }
    }
    throw error;
  }
}
