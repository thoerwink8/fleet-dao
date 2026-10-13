// 法国 VPS 上的「上线项目」登记表（#1985）：每个应用 = 哪些 systemd 单元 + 哪些目录 + 哪些库。资源页一行一个，
// 采样器（host-resources.ts）按这里读各单元的 cgroup，磁盘遍历（disk-footprint.ts）按这里量各目录。
// 清单只在这一份；test/vps-apps.test.ts 核对：每个单元在 docs/ops.md 里对得上，deploy/france 下每个常驻 .service / .slice
// 要么登记在这里、要么在 NOT_APPS 里写明为什么不算，目录不许互相套（套了就算两遍）。
//
// 改这里之前必须知道：
// - cgroup 是相对 /sys/fs/cgroup 的路径。普通服务在 system.slice/<单元>；模板单元的实例在 system-<模板>.slice 下
//   （postgresql@16-main.service 在 system.slice/system-postgresql.slice/）；会话资源池在 fleet.slice/fleet-agents.slice。
// - 目录要后端（fleet 用户，fleet-api.service 开着 ProtectSystem=strict、ProtectHome=yes）读得到才量得出：
//   /home 下的后端看不见，照登记、照实报「没读到」；/var/lib/fleet-work 里每棵树归会话用户、700，报「不全：有 N 棵树没读到」。
//   不为了量全加 root 小工具（那要人以 root 重跑 france.sh，是人闸）。
// - databases: 'all' = pg_database 里所有非模板库都算在这个应用名下（数据库那一行）；Temporal 的数据在库里，不另算。
// - external：不归本仓管的别家常驻服务，照样占这台机器，排在最后。

export interface VpsUnit {
  /** systemd 单元名（和 docs/ops.md、deploy/france 下的文件名一致）。 */
  name: string;
  /** 相对 /sys/fs/cgroup 的 cgroup 目录。 */
  cgroup: string;
}

export interface VpsApp {
  id: string;
  name: string;
  /** 放在哪：主要路径，一句话。 */
  place: string;
  units: readonly VpsUnit[];
  /** 名下的目录（绝对路径）：资源页的磁盘按这些量。 */
  dirs: readonly string[];
  /** 名下的库：'all' 是所有非模板库。 */
  databases?: 'all';
  /** 名下没登记目录时，磁盘那一格写什么。 */
  diskNote?: string;
  /** 这一项没有进程（只占磁盘）时，CPU、内存那一格的补充。 */
  idleNote?: string;
  external?: true;
}

const service = (name: string): VpsUnit => ({ name, cgroup: `system.slice/${name}` });

export const VPS_APPS: readonly VpsApp[] = [
  {
    id: 'cockpit',
    name: '驾驶舱',
    place: '/srv/fleet-dao-releases/current（后端代码）',
    units: [service('fleet-api.service')],
    dirs: ['/var/lib/fleet-dao/release-request'],
    diskNote: '代码在发布版本目录里，算在「发布版本」；静态页在香港那台',
  },
  {
    id: 'engine',
    name: '引擎',
    place: '/var/lib/fleet-dao/engine',
    units: [service('fleet-engine.service')],
    dirs: ['/var/lib/fleet-dao/engine', '/var/lib/fleet-dao/github', '/var/log/fleet-dao'],
  },
  {
    id: 'temporal',
    name: 'Temporal',
    place: '/opt/fleet-dao/temporal（程序）',
    units: [service('fleet-temporal.service')],
    dirs: ['/opt/fleet-dao/temporal'],
    diskNote: '数据存在数据库里（temporal、temporal_visibility 两个库，算在「数据库」）',
  },
  {
    id: 'postgres',
    name: '数据库',
    place: '/var/lib/postgresql/16/main（PostgreSQL 16）',
    units: [
      {
        name: 'postgresql@16-main.service',
        cgroup: 'system.slice/system-postgresql.slice/postgresql@16-main.service',
      },
    ],
    dirs: [],
    databases: 'all',
  },
  {
    id: 'sessions',
    name: 'AI 会话',
    place: '/var/lib/fleet-work（工作树）',
    units: [{ name: 'fleet-agents.slice', cgroup: 'fleet.slice/fleet-agents.slice' }],
    dirs: ['/var/lib/fleet-work', '/var/lib/fleet-sessions', '/home/fleet-agent-carpool'],
  },
  {
    id: 'mirasim',
    name: '会话用户的 Mirasim',
    place: '/home/fleet-agent-carpool/.mirasim',
    units: [service('fleet-mirasim-session.service'), service('fleet-mirasim-liveness.service')],
    dirs: [],
    diskNote: '在会话用户家里，算在「AI 会话」',
  },
  {
    id: 'release',
    name: '自动发布',
    place: '/usr/local/lib/fleet-dao',
    units: [
      service('fleet-auto-release.service'),
      service('fleet-release-request.service'),
      service('fleet-cli-upgrade.service'),
    ],
    dirs: ['/usr/local/lib/fleet-dao', '/var/lib/fleet-dao/cli-upgrade'],
  },
  {
    id: 'releases',
    name: '发布版本',
    place: '/srv/fleet-dao-releases',
    units: [],
    dirs: ['/srv/fleet-dao-releases', '/srv/fleet-dao'],
    idleNote: '这一项没有进程，只占磁盘',
  },
  {
    id: 'self-proxy',
    name: 'self-proxy',
    place: '不归本仓管（README「两台机器」）',
    units: [service('self-proxy-direct.service'), service('self-proxy-exit.service')],
    dirs: [],
    diskNote: '不归本仓管，没登记目录',
    external: true,
  },
  {
    id: 'miraquota',
    name: 'MiraQuota 同步',
    place: '不归本仓管（等 miraquota-win#3 发版后停）',
    units: [service('miraquota-sync.service')],
    dirs: [],
    diskNote: '不归本仓管，没登记目录',
    external: true,
  },
];

/** deploy/france 下不算「上线项目」的常驻单元和为什么（.socket、.timer、.path 只是触发器，按后缀整类不算）。 */
export const NOT_APPS: Readonly<Record<string, string>> = {
  'fleet-firewall.service': '一次性载入 nft 表，不留进程、不占磁盘',
};
