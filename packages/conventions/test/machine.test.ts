import { describe, expect, it } from 'vitest';
import {
  type MachineArgs,
  type MachineDeps,
  parseTokenInput,
  probeClaims,
  redact,
  runMachine,
} from '../src/machine.ts';

const TOKEN = 'tok_SECRET_0123456789abcdef';

interface Rig {
  deps: MachineDeps;
  out: string[];
  err: string[];
  sshCalls: { alias: string; cmd: string }[];
  installCalls: { args: string[]; env: Record<string, string> }[];
  getCalls: { url: string; headers: Record<string, string> }[];
}

function rig(o: {
  ssh?: { status: number; stdout: string; stderr?: string };
  install?: { status: number; stdout?: string; stderr?: string };
  get?: { status: number; body: string } | Error;
  stdin?: string;
}): Rig {
  const r: Rig = { out: [], err: [], sshCalls: [], installCalls: [], getCalls: [], deps: undefined as never };
  r.deps = {
    ssh: async (alias, cmd) => {
      r.sshCalls.push({ alias, cmd });
      const s = o.ssh ?? { status: 0, stdout: JSON.stringify({ env: 'founder-mac', token: TOKEN }) };
      return { status: s.status, stdout: s.stdout, stderr: s.stderr ?? '' };
    },
    install: async (args, env) => {
      r.installCalls.push({ args, env });
      const i = o.install ?? { status: 0, stdout: '成  试推：法国收下了\n' };
      return { status: i.status, stdout: i.stdout ?? '', stderr: i.stderr ?? '' };
    },
    get: async (url, headers) => {
      r.getCalls.push({ url, headers });
      const g = o.get ?? { status: 200, body: '{"claims":[]}' };
      if (g instanceof Error) throw g;
      return g;
    },
    readStdin: async () => o.stdin ?? '',
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
  };
  return r;
}

const joinSsh: MachineArgs = {
  cmd: 'join',
  id: 'founder-mac',
  name: '创始人的 Mac',
  url: 'https://fleet.example.com/',
  ssh: 'france',
  tokenStdin: false,
};

const everything = (r: Rig) =>
  JSON.stringify([r.out, r.err, r.sshCalls, r.installCalls.map((c) => c.args), r.getCalls.map((c) => c.url)]);

describe('machine join --ssh', () => {
  it('发钥匙、装、试读都成：退出 0，明文只在环境变量和请求头，不在任何输出与参数里', async () => {
    const r = rig({});
    expect(await runMachine(joinSsh, r.deps)).toBe(0);
    expect(r.sshCalls[0]?.alias).toBe('france');
    expect(r.sshCalls[0]?.cmd).toBe(
      "sudo -n bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api node-key new founder-mac --name '创始人的 Mac' --json",
    );
    expect(r.installCalls[0]?.env).toEqual({ FLEET_NODE_TOKEN: TOKEN });
    expect(r.installCalls[0]?.args).toEqual([
      'install',
      '--url',
      'https://fleet.example.com/',
      '--machine',
      '创始人的 Mac',
    ]);
    expect(r.getCalls[0]).toEqual({
      url: 'https://fleet.example.com/api/nodes/claims',
      headers: { 'X-Fleet-Node-Token': TOKEN },
    });
    expect(everything(r)).not.toContain(TOKEN);
    expect(r.out.join('\n')).toContain('装好了');
  });

  it('编号已存在：法国退出非 0，拒绝覆盖、不装、不读，原因里没有明文', async () => {
    const r = rig({ ssh: { status: 1, stdout: '', stderr: `node-key founder-mac 已存在 ${TOKEN}` } });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(r.installCalls).toHaveLength(0);
    expect(r.getCalls).toHaveLength(0);
    expect(r.err.join('\n')).toContain('已存在');
    expect(r.err.join('\n')).toContain('revoke');
  });

  it('试推失败：非零、写原因、不当成装好，明文被抹掉', async () => {
    const r = rig({ install: { status: 1, stdout: '没成  试推：没推成\n', stderr: `boom ${TOKEN}` } });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(r.getCalls).toHaveLength(0);
    expect(r.err.join('\n')).toContain('试推');
    expect(r.out.join('\n')).not.toContain('装好了');
    expect(everything(r)).not.toContain(TOKEN);
  });

  it.each([
    [{ status: 401, body: '{}' }, 'HTTP 401'],
    [{ status: 200, body: 'nope' }, '不是 JSON'],
    [{ status: 200, body: '{"x":1}' }, 'claims'],
  ])('试读租约失败 %#：非零并写原因', async (get, why) => {
    const r = rig({ get });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(r.err.join('\n')).toContain(why);
    expect(r.out.join('\n')).not.toContain('装好了');
    expect(everything(r)).not.toContain(TOKEN);
  });

  it('试读网络错误里带明文也被抹掉', async () => {
    const r = rig({ get: new Error(`connect failed for ${TOKEN}`) });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(everything(r)).not.toContain(TOKEN);
  });

  it('法国输出不是 JSON：不把原输出打出来', async () => {
    const r = rig({ ssh: { status: 0, stdout: `oops ${TOKEN}` } });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(r.installCalls).toHaveLength(0);
    expect(everything(r)).not.toContain(TOKEN);
  });

  it('法国回的环境编号对不上：拒绝', async () => {
    const r = rig({ ssh: { status: 0, stdout: JSON.stringify({ env: 'other', token: TOKEN }) } });
    expect(await runMachine(joinSsh, r.deps)).toBe(1);
    expect(r.installCalls).toHaveLength(0);
  });

  it('名字里的单引号在远程命令里被转义', async () => {
    const r = rig({});
    await runMachine({ ...joinSsh, name: "a'b" }, r.deps);
    expect(r.sshCalls[0]?.cmd).toContain(`--name 'a'\\''b'`);
  });
});

describe('machine join --token-stdin', () => {
  const base: MachineArgs = {
    cmd: 'join',
    id: 'second-pc',
    url: 'https://fleet.example.com',
    tokenStdin: true,
  };

  it('从标准输入读明文：不 ssh，安装用环境变量，成功退出 0', async () => {
    const r = rig({ stdin: `${TOKEN}\n` });
    expect(await runMachine(base, r.deps)).toBe(0);
    expect(r.sshCalls).toHaveLength(0);
    expect(r.installCalls[0]?.env).toEqual({ FLEET_NODE_TOKEN: TOKEN });
    expect(r.installCalls[0]?.args).toContain('second-pc');
    expect(everything(r)).not.toContain(TOKEN);
  });

  it('也认 issue --json 那种一行 JSON，环境编号对不上就拒绝', async () => {
    const ok = rig({ stdin: JSON.stringify({ env: 'second-pc', token: TOKEN }) });
    expect(await runMachine(base, ok.deps)).toBe(0);
    const bad = rig({ stdin: JSON.stringify({ env: 'founder-pc', token: TOKEN }) });
    expect(await runMachine(base, bad.deps)).toBe(1);
    expect(bad.installCalls).toHaveLength(0);
    expect(everything(bad)).not.toContain(TOKEN);
  });

  it('标准输入为空：非零', async () => {
    const r = rig({ stdin: '  \n' });
    expect(await runMachine(base, r.deps)).toBe(1);
    expect(r.installCalls).toHaveLength(0);
  });

  it('--ssh 和 --token-stdin 必须二选一', async () => {
    const both = rig({});
    expect(await runMachine({ ...base, ssh: 'france' }, both.deps)).toBe(1);
    const none = rig({});
    expect(await runMachine({ ...base, tokenStdin: false }, none.deps)).toBe(1);
  });
});

describe('参数校验', () => {
  it('编号不合规、缺 --url 都拒绝，且不碰 ssh', async () => {
    const a = rig({});
    expect(await runMachine({ ...joinSsh, id: 'Bad_ID' }, a.deps)).toBe(1);
    const b = rig({});
    const { url: _u, ...noUrl } = joinSsh;
    expect(await runMachine(noUrl, b.deps)).toBe(1);
    expect(a.sshCalls.length + b.sshCalls.length).toBe(0);
  });
});

describe('issue / list / revoke', () => {
  it('issue 只在标准输出打印一次明文，提示走标准错误且不含明文', async () => {
    const r = rig({});
    expect(
      await runMachine({ cmd: 'issue', id: 'founder-mac', ssh: 'france', tokenStdin: false }, r.deps),
    ).toBe(0);
    expect(r.out).toEqual([TOKEN]);
    expect(r.err.join('\n')).toContain('只显示这一次');
    expect(r.err.join('\n')).not.toContain(TOKEN);
  });

  it('issue 编号已存在：非零，不打印明文', async () => {
    const r = rig({ ssh: { status: 1, stdout: '', stderr: '已存在' } });
    expect(
      await runMachine({ cmd: 'issue', id: 'founder-mac', ssh: 'france', tokenStdin: false }, r.deps),
    ).toBe(1);
    expect(r.out).toHaveLength(0);
  });

  it('list / revoke 原样转发法国输出', async () => {
    const l = rig({ ssh: { status: 0, stdout: 'founder-pc\nfounder-mac\n' } });
    expect(await runMachine({ cmd: 'list', ssh: 'france', tokenStdin: false }, l.deps)).toBe(0);
    expect(l.out).toEqual(['founder-pc\nfounder-mac']);
    expect(l.sshCalls[0]?.cmd).toMatch(/node-key list$/);
    const v = rig({ ssh: { status: 0, stdout: 'revoked\n' } });
    expect(
      await runMachine({ cmd: 'revoke', id: 'founder-mac', ssh: 'france', tokenStdin: false }, v.deps),
    ).toBe(0);
    expect(v.sshCalls[0]?.cmd).toMatch(/node-key revoke founder-mac$/);
    const f = rig({ ssh: { status: 3, stdout: '', stderr: '没有这个编号' } });
    expect(await runMachine({ cmd: 'revoke', id: 'nope', ssh: 'france', tokenStdin: false }, f.deps)).toBe(1);
    expect(f.err.join('\n')).toContain('没有这个编号');
  });

  it('缺 --ssh 非零', async () => {
    const r = rig({});
    expect(await runMachine({ cmd: 'list', tokenStdin: false }, r.deps)).toBe(1);
  });
});

describe('小工具', () => {
  it('redact 抹掉明文和 URL 编码形态', () => {
    expect(redact(`a ${TOKEN} b ${encodeURIComponent('x y')}`, TOKEN)).toBe(`a [已隐去] b x%20y`);
    expect(redact('a+b', 'a+b')).toBe('[已隐去]');
    expect(redact('x', undefined)).toBe('x');
  });
  it('parseTokenInput 拒绝带空白的明文', () => {
    expect(parseTokenInput('a b', 'x')).toHaveProperty('error');
  });
  it('probeClaims 200 带 claims 才成', async () => {
    const r = rig({ get: { status: 200, body: '{"claims":[1,2]}' } });
    expect(await probeClaims(r.deps, 'https://h', TOKEN)).toEqual({ ok: true, count: 2 });
  });
});
