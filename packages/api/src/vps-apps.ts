// 法国 VPS 上的「上线项目」登记表（#1985）：每个应用 = 哪些 systemd 单元 + 哪些目录 + 哪些库。资源页一行一个，
// 采样器（host-resources.ts）按这里读各单元的 cgroup，各目录的磁盘由法国上 root 的单元（fleet-footprint）按这里的目录用 du 量、
// 后端读它写的文件（disk-footprint.ts）。
// 清单只在这一份；test/vps-apps.test.ts 核对：每个单元在 docs/ops.md 里对得上，deploy/france 下每个常驻 .service / .slice
// 要么登记在这里、要么在 NOT_APPS 里写明为什么不算，目录不许互相套（套了就算两遍）。
//
// 改这里之前必须知道：
// - cgroup 是相对 /sys/fs/cgroup 的路径。普通服务在 system.slice/<单元>；模板单元的实例在 system-<模板>.slice 下
//   （postgresql@16-main.service 在 system.slice/system-postgresql.slice/）；会话资源池在 fleet.slice/fleet-agents.slice。
// - 目录不用后端（fleet 用户，开着 ProtectSystem=strict、ProtectHome=yes）读得到：量它的是 root 的 oneshot 单元（deploy/france/
//   fleet-footprint.service，每 10 分钟，只留 CAP_DAC_READ_SEARCH，只把数字写进 /var/lib/fleet-footprint/sizes.json），所以会话用户 700 的
//   工作树、/home 下会话用户的家、别家应用 750 的目录都量得到（决定 0109，取代以前「不加 root 小工具」那条）。
// - 它量哪些目录由 deploy/france/footprint/dirs.json 定（france.sh 的自动档装到 root 拥有的位置，fleet 改不了，也就没法让 root 量任意路径）：
//   这里加、改、删目录或带 .timer 的应用，要同步改那份 json（test/disk-footprint.test.ts 核对一致，不一致就红）。
// - 带 .timer 的 oneshot 应用（跑完 cgroup 就没了，5 秒一采抓不到）：单元写 service 加 timer 两个，json 的 timers 列它的 service；
//   同一个 root 单元从 journal 里数 systemd 每回结束的「Consumed … CPU time、memory peak」，资源页写近 24 小时的账。
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
  /** systemd 定时任务（oneshot 跑完 cgroup 就没了）：5 秒一采基本是 0，资源页这一格改看「近 24 小时」的用量。 */
  scheduled?: true;
}

const service = (name: string): VpsUnit => ({ name, cgroup: `system.slice/${name}` });
const timer = service;

export const VPS_APPS: readonly VpsApp[] = [
  {
    id: 'cockpit',
    name: '驾驶舱',
    place: '/srv/fleet-dao-releases/current（后端代码）',
    units: [service('fleet-api.service'), service('fleet-footprint.service')],
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
    dirs: ['/opt/miraquota'],
    external: true,
  },
  {
    id: 'daihuo',
    name: 'daihuo',
    place: '/opt/daihuo（程序）、/var/lib/daihuo（数据），不归本仓管',
    units: [service('daihuo.service')],
    dirs: ['/opt/daihuo', '/var/lib/daihuo'],
    external: true,
  },
  {
    id: 'reclaude-refill',
    name: 'reclaude-refill',
    place:
      '/opt/reclaude-refill（程序）、/var/lib/reclaude-refill（数据），不归本仓管；systemd 定时任务，每分钟跑一次',
    units: [service('reclaude-refill-collector.service'), timer('reclaude-refill-collector.timer')],
    dirs: ['/opt/reclaude-refill', '/var/lib/reclaude-refill'],
    external: true,
    scheduled: true,
  },
  {
    id: 'mirasim-radar',
    name: 'mirasim-radar',
    place:
      '/opt/mirasim-radar（程序）、/var/lib/mirasim-radar（数据），不归本仓管；systemd 定时任务，每 5 分钟跑一次',
    units: [service('mirasim-radar-collector.service'), timer('mirasim-radar-collector.timer')],
    dirs: ['/opt/mirasim-radar', '/var/lib/mirasim-radar'],
    external: true,
    scheduled: true,
  },
];

/**
 * 机器上自带的定时器（不是上线项目）和为什么不算：采样器列 /etc/systemd/system/*.timer 兜底（#3457），
 * 不在 VPS_APPS 里、对应的 .service 也没登记、也不在这里的，出一行「没登记」。键是定时器名去掉 .timer。
 */
export const SYSTEM_TIMERS: Readonly<Record<string, string>> = {
  'apt-daily': '定期刷新 apt 软件包索引，Ubuntu 自带',
  'apt-daily-upgrade': '定期装安全更新，Ubuntu 自带',
  'dpkg-db-backup': '每天备份 dpkg 数据库，Ubuntu 自带',
  e2scrub_all: '定期检查 ext4 文件系统，Ubuntu 自带',
  'fwupd-refresh': '定期刷新固件更新清单，Ubuntu 自带',
  fstrim: '每周对 SSD 做 trim，Ubuntu 自带',
  logrotate: '每天轮转日志，Ubuntu 自带',
  'man-db': '每天更新 man 手册索引，Ubuntu 自带',
  'motd-news': '登录欢迎语的新闻，Ubuntu 自带',
  'sysstat-collect': 'sysstat 的系统指标采集，系统自带',
  'sysstat-summary': 'sysstat 的每日汇总，系统自带',
  'systemd-tmpfiles-clean': '清理临时文件，systemd 自带',
  'update-notifier-download': '下载更新提示，Ubuntu 自带',
  'update-notifier-motd': '更新提示写进登录欢迎语，Ubuntu 自带',
};

/** 这个定时器要不要出「没登记」行：登记过的（定时器本身或同名 .service）、系统自带的不出。 */
export function isUnregisteredTimer(timer: string, apps: readonly VpsApp[]): boolean {
  const base = timer.replace(/\.timer$/, '');
  const registered = new Set(apps.flatMap((a) => a.units.map((u) => u.name)));
  if (registered.has(timer) || registered.has(`${base}.service`)) return false;
  return !Object.hasOwn(SYSTEM_TIMERS, base) && !isSystemService(`${base}.service`);
}

/**
 * 机器上自带的系统服务（不是上线项目）和为什么不算：采样器扫 system.slice 时，不在 VPS_APPS 里、也不在这里的
 * 在跑服务，会在资源页单独出一行「没登记」（#3457）。键是单元名去掉 .service；模板实例按模板名匹配（getty@ 管 getty@tty1）。
 */
export const SYSTEM_SERVICES: Readonly<Record<string, string>> = {
  cron: '系统定时任务守护进程，Ubuntu 自带',
  dbus: '系统消息总线，Ubuntu 自带',
  fail2ban: 'ssh 防爆破，装机时装的系统服务，不是上线项目',
  fwupd: '固件更新守护进程，Ubuntu 自带',
  'getty@': '本地控制台登录（getty@tty1），系统自带',
  ModemManager: '调制解调器管理，Ubuntu 自带',
  multipathd: '多路径存储守护进程，Ubuntu 自带',
  polkit: '权限策略服务，Ubuntu 自带',
  rsyslog: '系统日志，Ubuntu 自带',
  'serial-getty@': '串口控制台登录（serial-getty@ttyS0，云主机的控制台口），系统自带',
  ssh: '远程登录 sshd，Ubuntu 自带',
  'systemd-journald': 'systemd 日志服务，系统自带',
  'systemd-logind': 'systemd 登录管理，系统自带',
  'systemd-networkd': 'systemd 网络配置，系统自带',
  'systemd-resolved': 'systemd 域名解析，系统自带',
  'systemd-timesyncd': 'systemd 对时，系统自带',
  'systemd-udevd': 'systemd 设备管理，系统自带',
  udisks2: '磁盘管理守护进程，Ubuntu 自带',
  'unattended-upgrades': '自动安全更新，Ubuntu 自带',
};

/** 这个单元是不是系统自带的（在 SYSTEM_SERVICES 里；模板实例按模板名）。 */
export function isSystemService(unit: string): boolean {
  const base = unit.replace(/\.service$/, '');
  const at = base.indexOf('@');
  return Object.hasOwn(SYSTEM_SERVICES, at < 0 ? base : base.slice(0, at + 1));
}

/** deploy/france 下不算「上线项目」的常驻单元和为什么（.socket、.timer、.path 只是触发器，按后缀整类不算）。 */
export const NOT_APPS: Readonly<Record<string, string>> = {
  'fleet-firewall.service': '一次性载入 nft 表，不留进程、不占磁盘',
  'fleet2-shadow-firewall.service':
    '一次性载入新内核影子工人的 nft 表 inet fleet2_shadow，不留进程、不占磁盘',
  'fleet2-shadow.slice': '新内核影子工人的 cgroup，只给 nft 认连接用，自己不跑东西',
};
