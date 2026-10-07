#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 法国机器装机（以 root 跑；幂等：跑第二遍什么都不变）。装的是：引擎用户 fleet、会话专用用户（一个）、创始人的登录用户 pilot、目录、
# PostgreSQL 16（Ubuntu 自带的源，吃得到自动安全更新）、Temporal 服务端 1.32.0（Postgres 持久化，端口和旧系统错开）、
# 本机上只许 root 和 fleet 连 Temporal 与库、会话用户在本机开的口只许它自己连的 nft 表、AI 会话资源池 fleet-agents.slice 与起会话的脚本、
# fleet 用户的 pnpm（corepack）、AI 会话用的 pnpm（归 root，钉版本、核 sha512）、WireGuard 客户端（主动连香港，法国不开任何入站端口）、
# 应用的本机配置与随机密钥、往香港传驾驶舱静态文件的钥匙、清掉老机器上已删的演示版单元（#1223）、
# 会话用户和 pilot 家里各家 AI 的全局说明与方法类 skill、他们各自的 ddgs（用钉住版本的 uv 装）、
# 会话用户的 cursor-agent（官方安装脚本，以会话用户自己的身份装在他家里，只在没有时装；它的 API 密钥由创始人放，这里只读回
# 在不在、属主、权限，不读值，见 lib/cursor-key.sh）、
# 会话用户的 grok 命令行（官方安装脚本，以会话用户自己的身份装在他家里，只在没有时装；登录由创始人以他的身份做一次，这里只读回
# 登录态文件在不在、属主、权限，不读内容，见 lib/grok.sh）、
# node 默认的编译缓存目录（先由 root 建好，别的用户替 fleet、pilot、root 放不进编译缓存）。
# 应用本身（引擎、后端、前端）由 deploy/release.sh 发布。
# 旧系统的服务、端口、文件一概不动。端口表、怎么跑、怎么看健康、怎么回滚：docs/ops.md。
#   bash deploy/france.sh           装：缺的补上，已有的不动（整套，含人工档）
#   bash deploy/france.sh --check   只读回和自检，不改任何东西
#   bash deploy/france.sh --auto-tier  只装「自动档」：自动发布脚本副本和单元、fleet-agents.slice、清掉老机器上已删的演示版单元和脚本（#1223）、
#                                   Mirasim 常驻单元（#1274；服务端本体不在记待配，单元文件内容变了才重启）
#                                   （不碰防火墙、sudoers、用户、/etc/fleet-dao 里的钥匙和环境文件；幂等）。自动发布每发完一版以 root
#                                   顺带跑它（docs/ops.md 第九节「装机层」）；规矩同步不在这里，由自动发布的规矩那一步做（同一条 agents-sync）。
#                                   人工档（lib/human-tier.sh：建用户、防火墙、sudoers）只在整套跑时做。
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/snapshot.sh
source "$DEPLOY_DIR/lib/snapshot.sh"
# shellcheck source=lib/root-exec-check.sh
source "$DEPLOY_DIR/lib/root-exec-check.sh"
# shellcheck source=lib/session-proxy.sh
source "$DEPLOY_DIR/lib/session-proxy.sh"
# shellcheck source=lib/listen.sh
source "$DEPLOY_DIR/lib/listen.sh"
# shellcheck source=lib/login-user.sh
source "$DEPLOY_DIR/lib/login-user.sh"
# shellcheck source=lib/session-user.sh
source "$DEPLOY_DIR/lib/session-user.sh"
# shellcheck source=lib/session-ports.sh
source "$DEPLOY_DIR/lib/session-ports.sh"
# shellcheck source=lib/cli-tools.sh
source "$DEPLOY_DIR/lib/cli-tools.sh"
# shellcheck source=lib/cursor-agent.sh
source "$DEPLOY_DIR/lib/cursor-agent.sh"
# shellcheck source=lib/cursor-key.sh
source "$DEPLOY_DIR/lib/cursor-key.sh"
# shellcheck source=lib/grok.sh
source "$DEPLOY_DIR/lib/grok.sh"
# shellcheck source=lib/mirasim.sh
source "$DEPLOY_DIR/lib/mirasim.sh"
# shellcheck source=lib/agents-sync.sh
source "$DEPLOY_DIR/lib/agents-sync.sh"
# shellcheck source=lib/app-config.sh
source "$DEPLOY_DIR/lib/app-config.sh"
# shellcheck source=lib/session-pnpm.sh
source "$DEPLOY_DIR/lib/session-pnpm.sh"
# shellcheck source=lib/node-cache.sh
source "$DEPLOY_DIR/lib/node-cache.sh"
# shellcheck source=lib/auto-release-state.sh
source "$DEPLOY_DIR/lib/auto-release-state.sh"
# shellcheck source=lib/node-report-gate.sh
source "$DEPLOY_DIR/lib/node-report-gate.sh"
# shellcheck source=lib/human-tier.sh
source "$DEPLOY_DIR/lib/human-tier.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# ── 钉死的版本与校验和：外部二进制装上机器就进了信任面，不用 latest ──
TEMPORAL_SERVER_VERSION=1.32.0
TEMPORAL_SERVER_SHA256=ca1ccbb1d1545b68eb4523de463c51ffcd80f7e0bccd14a9b2c56fc7e389e792
TEMPORAL_CLI_VERSION=1.9.1
TEMPORAL_CLI_SHA256=09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5
PG_MAJOR=16 # Temporal 官方测过的最高大版本（13.18/14.15/15.10/16.6）；Ubuntu 24.04 自带的源里就是 16
# 会话用户和 pilot 的 reclaude（dl.reclaude.ai/stable.json 列的 linux-amd64）。只在没有时装，
# 之后由各用户自己 reclaude update，脚本不盖
RECLAUDE_VERSION=v1.4.0
RECLAUDE_SHA256=4f5d683b695ea392f53d4e8f2a916f092794f8d4196d5b7356afb0c9a9392f0a
# uv：只用来给会话用户和 pilot 各装一份 ddgs（lib/cli-tools.sh）。装在 /opt/fleet-dao/uv/<版本>，归 root，不进谁的 PATH
UV_VERSION=0.12.17
UV_SHA256=fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63
# ddgs：skill docs-lookup 首选的搜索命令行。它自己和它的依赖都钉死版本（依赖里 primp、lxml 带编译好的二进制）；
# 这些是 PyPI 上的包，只钉版本、不核校验和（核 sha256 的只有上面的 uv）。升 ddgs 时依赖跟着对一遍
DDGS_VERSION=9.16.0
DDGS_DEPS=(click==8.5.0 lxml==6.1.3 primp==2.0.1)
# AI 会话用的 pnpm（lib/session-pnpm.sh）：版本必须和仓根 package.json 的 packageManager 一样（deploy/test/session-pnpm.test.sh
# 核对，漏改一处 CI 就红）；校验和是 npm 的 dist.integrity，升版本时照 `npm view pnpm@<版本> dist.integrity` 一起改
PNPM_VERSION=11.1.2
PNPM_INTEGRITY=sha512-QVocwll0cx51RVwUaDcb50xapft2IbUNQFbSIkUWCfEUEvI/1gLmFp8eBgRmZB95hZfhvpYaEGiINqZ7FlaUmQ==
# 会话用户的 cursor-agent（lib/cursor-agent.sh）：官方安装脚本，以会话用户自己的身份跑，只在没有时装，之后它自己升级；
# 不钉版本、不核校验和（升级会删旧版本目录；为什么可以不核见 lib/cursor-agent.sh 开头）
CURSOR_INSTALL_URL=https://cursor.com/install
# 官方安装脚本固定装在这（{user} 换成会话用户），装和读回都照引擎的找法在这里找：和 packages/engine/src/real/hosts.ts 的
# DEFAULT_CURSOR_VERSIONS_DIR 一样（engine 的 hosts.test.ts 核对）。engine.env 别改 FLEET_CURSOR_VERSIONS_DIR：改了引擎就找不到这里装的
CURSOR_VERSIONS_DIR='/home/{user}/.local/share/cursor-agent/versions'
# 会话用户的 grok 命令行（lib/grok.sh）：官方安装脚本，以会话用户自己的身份跑，只在没有时装；不钉版本、不核校验和（为什么见
# lib/grok.sh 开头）。装在哪、登录态在哪是 lib/grok.sh 的 GROK_BIN、GROK_AUTH_FILE
GROK_INSTALL_URL=https://x.ai/cli/install.sh
# node 默认的编译缓存目录和开机时建它的配置（lib/node-cache.sh：为什么要归 root）
NODE_CACHE_DIR=/tmp/node-compile-cache
NODE_CACHE_CONF=/etc/tmpfiles.d/fleet-dao-node-compile-cache.conf

# ── 端口：全部只绑本机，和旧系统的开发版 Temporal（7233/8233 与一批临时端口）错开。改了同步 docs/ops.md ──
PG_PORT=5432
TEMPORAL_FRONTEND_PORT=7243
TEMPORAL_FRONTEND_MEMBERSHIP_PORT=6943
TEMPORAL_HISTORY_PORT=7244
TEMPORAL_HISTORY_MEMBERSHIP_PORT=6944
TEMPORAL_MATCHING_PORT=7245
TEMPORAL_MATCHING_MEMBERSHIP_PORT=6945
TEMPORAL_WORKER_PORT=7249
TEMPORAL_WORKER_MEMBERSHIP_PORT=6949
TEMPORAL_PORTS=("$TEMPORAL_FRONTEND_PORT" "$TEMPORAL_FRONTEND_MEMBERSHIP_PORT" "$TEMPORAL_HISTORY_PORT"
  "$TEMPORAL_HISTORY_MEMBERSHIP_PORT" "$TEMPORAL_MATCHING_PORT" "$TEMPORAL_MATCHING_MEMBERSHIP_PORT"
  "$TEMPORAL_WORKER_PORT" "$TEMPORAL_WORKER_MEMBERSHIP_PORT")

NAMESPACE=fleet
RETENTION_HOURS=720 # 30 天；Temporal 默认只留 24 小时，过后网页上查不到时间线

WG_IF=wg-fleet
WG_ADDR=10.99.0.2/24
WG_HK_ADDR=10.99.0.1
# 驾驶舱后端在隧道地址上的端口（packages/api 的 FLEET_COCKPIT_LISTEN）：只对香港开，只在隧道网卡上开
API_PORT=8787
# 本机上只许 root 和 fleet 连的端口：Temporal 没开认证，库和驾驶舱后端也不该让会话直接碰（nft 表 inet fleet_dao）
PROTECTED_PORTS=("$PG_PORT" "${TEMPORAL_PORTS[@]}" "$API_PORT")
NFT_FILE=/etc/fleet-dao/nftables.nft
# 会话用户自己的 Mirasim 服务，本地模式常驻用的固定端口（deploy/france/fleet-mirasim-session.service，#424）：
# 避开旧系统仍留着共用的 4316（wire.ts 的 assertNotRealMirasimInTests 连测试里都拒它）和同机可能还没清干净的
# 4315、4317（docs/reference/deploy.md §1.2）。引擎自己认端口靠现读 local-<端口>.token 的文件名，不认这个常量。
MIRASIM_SESSION_PORT=4318
MIRASIM_SESSION_UNIT_FILE=/etc/systemd/system/fleet-mirasim-session.service
# AI 会话跑在一个专用用户下（lib/session-user.sh：reclaude 设备上限，法国只占 1 台）；引擎（fleet）经 sudo 只能调
# fleet-agent-scope 起会话。会话用户：没有 sudo、不能提权、家目录干净、没有 GitHub 凭据、读不到 /etc/fleet-dao。
# 旧系统的会话用户不用、不碰；停用的 fleet-agent-dedicated 不建、不查（已删）。
SESSION_USERS=("$SESSION_USER")
# 创始人的登录用户：经 Mirasim 的 ssh 远程模式登进来干活。没有 sudo、只在自己的组和 systemd-journal 里，
# 家里只放 reclaude 二进制、不放任何凭据（lib/login-user.sh）。它改得了的 root 执行文件一样要清零，所以也算写入身份
PILOT_USER=pilot
PILOT_HOME=/home/pilot
WRITER_IDENTITIES=(fleet "${SESSION_USERS[@]}" "$PILOT_USER")
# 各家 AI 的全局说明（agents/shared-rules.md 的通用段）和方法类 skill（agents/skills/）写进这几个用户家里：
# 同步脚本以各用户自己的身份写（文件归他们），只动标记圈起来的那一块和它清单里记着的 skill（docs/ops.md 第五节）
AGENT_RULES_USERS=("${SESSION_USERS[@]}" "$PILOT_USER")
AGENTS_SYNC=$DEPLOY_DIR/../packages/agents-sync/bin/agents-sync
AGENTS_SYNC_CMD=(/usr/bin/node "$AGENTS_SYNC")
AGENT_SCOPE_BIN=/usr/local/sbin/fleet-agent-scope
SUDOERS_FILE=/etc/sudoers.d/fleet-dao
ENV_FILE=/etc/fleet-dao/france.env
ENV_KEYS=(FLEET_WG_HK_ENDPOINT FLEET_WG_HK_PUBLIC_KEY)
TEMPORAL_HOME=/opt/fleet-dao/temporal
UV_HOME=/opt/fleet-dao/uv
# AI 会话用的 pnpm：包解在 <这里>/<版本>，入口放在引擎给会话的 PATH 上（systemd 给服务的默认 PATH 里有 /usr/local/bin）
PNPM_ROOT=/opt/fleet-dao/pnpm
PNPM_BIN=/usr/local/bin/pnpm
TEMPORAL_ENV=/etc/fleet-dao/temporal.env
TEMPORAL_CONFIG=/etc/fleet-dao/temporal.yaml
PG_UNIT=postgresql@$PG_MAJOR-main.service
# 应用：每一版装在 /srv/fleet-dao-releases/<提交号>（deploy/release.sh）。本机配置新机器上照仓里的期望建一次（#323），之后由
# 发布时照期望写（只写期望变了的键，人手改的不改回），本脚本只管属主权限
RELEASES_DIR=/srv/fleet-dao-releases
APP_ENV_FILES=(engine api release) # /etc/fleet-dao/<名>.env ← 期望（deploy/france/desired-config.json）
# 随机密钥（文件:键:用途），首次生成后不再动。gateway-token.env 香港也要放同一份（docs/ops.md 第九节）
APP_SECRETS=("agent-token:FLEET_AGENT_TOKEN_SECRET:签 fleet 通行证（引擎签、后端验）"
  "session-secret:FLEET_SESSION_SECRET:驾驶舱登录的 Cookie"
  "gateway-token:FLEET_FEISHU_GATEWAY_TOKEN:飞书网关的通行证（香港放同一份）")
# 「引擎」GitHub App 的凭据（手放）：api.env 的 FLEET_GITHUB_WEBHOOK_SECRET 照它的 webhook_secret 填（lib/app-config.sh）
ENGINE_APP_JSON=/etc/fleet-dao/github/gh-app-fleet-dao-engine.json
# 卫生检查已知敏感值名单机制整个删掉了（创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）：早先版本放过的
# 这份名单文件、engine.env 里指它的键，装机脚本这次清掉，别留着骗后面 desired-config.json 的对账
STALE_SENSITIVE_VALUES=/etc/fleet-dao/sensitive-values.txt
# 拼车用户家里的派活垫片：引擎接真活以后退役（#28 登记），读回在它还在时记待配。装机脚本不碰它
CARPOOL_SHIM=/home/fleet-agent-carpool/bin/carpool-run.sh
# AI 会话的工作树的根（引擎真端口的 FLEET_WORK_DIR，fleet-agent-scope 的 WORK_BASE）、引擎自己的状态目录（FLEET_ENGINE_STATE_DIR）
WORK_DIR=/var/lib/fleet-work
ENGINE_STATE_DIR=/var/lib/fleet-dao/engine
# 会话脱开引擎跑的收发目录的根（引擎的 FLEET_SESSION_IO_DIR 默认就是它，packages/engine/src/real/session-io.ts）：归 fleet、711——
# 会话用户按路径进得去自己那一格（写输出、读提示词），列不出别的会话；不在或权限不对，引擎照旧接管道、发布还会停会话（推提醒）
SESSION_IO_DIR=/var/lib/fleet-sessions
# 发布脚本往香港传驾驶舱静态文件用的钥匙（只有 root 读得到），和钉住的香港 sshd 主机钥匙
WEB_UPLOAD_KEY=/etc/fleet-dao/web-upload.key
HK_KNOWN_HOSTS=/etc/fleet-dao/hk-known-hosts
# 发布脚本发飞书网关用的钥匙（另一把）：香港把它限死成只能跑 fleet-gateway-deploy
GATEWAY_DEPLOY_KEY=/etc/fleet-dao/gateway-deploy.key
# 已删的演示版（#1223，创始人 2026-10-07）：以前装过的推可见范围的脚本和单元，装机时停掉、删掉（retire_old_units），读回核对它们不在。
# 它们的数据目录（/var/lib/fleet-dao/demo，#1223）不动：里面是旧的可见范围文件，要不要清由人定
RETIRED_UNITS=(fleet-demo-scopes.path fleet-demo-scopes.timer fleet-demo-scopes.service) # #1223：先停触发的两个，再停服务本身
DEMO_DIR=/var/lib/fleet-dao/demo # #1223：人工档（lib/human-tier.sh）还在建这个老目录；改人工档的文件会让 deploy_lag 要人重跑整套，所以这一行留着，另开单再删
RETIRED_BIN=/usr/local/sbin/fleet-demo-scopes # #1223
RETIRED_UNIT_DIR=/etc/systemd/system # 只有测试会改（#1223）
# 驾驶舱「发布到法国」按钮的接活（人工档，lib/human-tier.sh 的 setup_release_request）：后端（fleet）写请求到 RELEASE_REQUEST_DIR，
# root 的 path 单元接活、走一趟发版，进度写在 TRAIN_DIR（root 的，fleet 写不进）。脚本是 deploy/france/release-request 的副本
RELEASE_REQUEST_DIR=/var/lib/fleet-dao/release-request
TRAIN_DIR=$RELEASES_DIR/.train
RELEASE_REQUEST_LIB=/usr/local/lib/fleet-dao/release-request
RELEASE_REQUEST_FILES=(lib.mjs fleet-release-request.mjs)
RELEASE_REQUEST_UNITS=(fleet-release-request.service fleet-release-request.path)
# 自动发布单元（docs/ops.md 第九节「自动发布」）：只读不发（0032）——读主线头、它的 CI、在用版本、落后几个；发完版（驾驶舱按钮）后顺带装自动档、同步规矩。装的是副本：
# 主线上改了它，下一轮发完版自动换（--auto-tier）。它每一轮的读数、本脚本装到哪个提交（下面 APPLIED_FILE）都放在 AUTO_DIR，后端的 /healthz 读
AUTO_RELEASE_LIB=/usr/local/lib/fleet-dao/auto-release
AUTO_RELEASE_FILES=(lib.mjs fleet-auto-release.mjs config.mjs)
# 配置对账（#323，docs/ops.md 第九节「配置进仓对账」）：私有值只把 HMAC 指纹写进仓里的期望，钥匙只在本机（root 600）。
# 本脚本第一次跑时生成，之后不动；自动发布每一轮、本脚本的读回都拿它算线上私有值的指纹
CONFIG_KEY=/etc/fleet-dao/config-fingerprint.key
CONFIG_CLI=$DEPLOY_DIR/france/auto-release/config.mjs
AUTO_RELEASE_UNITS=(fleet-auto-release.service fleet-auto-release.timer)
AUTO_DIR=$RELEASES_DIR/.auto
APPLIED_FILE=$AUTO_DIR/france-applied

FLEET_WG_HK_ENDPOINT=""
FLEET_WG_HK_PUBLIC_KEY=""
FLEET_TEMPORAL_DB_PASSWORD=""

CHECK_ONLY=0
AUTO_TIER=0
case "${1:-}" in
--check) CHECK_ONLY=1 ;;
--auto-tier) AUTO_TIER=1 ;;
"") ;;
*)
  echo "用法：bash $0 [--check | --auto-tier]" >&2
  exit 64
  ;;
esac

# shellcheck disable=SC1091 # /etc/os-release 是目标机器上的文件
preflight() {
  step "前提"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi
  local id ver node_major
  id=$(. /etc/os-release && echo "$ID")
  ver=$(. /etc/os-release && echo "$VERSION_ID")
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  if [[ "$id" != ubuntu ]]; then
    red "只在 Ubuntu 上验过，这台是 $id $ver"
    return 1
  fi
  if [[ "$(uname -m)" != x86_64 ]]; then
    red "Temporal 装的是 linux_amd64 包，这台是 $(uname -m)"
    return 1
  fi
  if [[ "$(stat -fc %T /sys/fs/cgroup)" != cgroup2fs ]]; then
    red "资源池要 cgroup v2，这台不是"
    return 1
  fi
  node_major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || node_major=0
  if ((node_major < 22)); then
    red "要 /usr/bin/node 22 或更高（pnpm 靠它自带的 corepack），这台是「$node_major」"
    return 1
  fi
  # 早年用 systemd-run 起的同名临时单元会遮住文件单元，daemon-reload 也换不掉（审计 P10）
  if [[ "$(unit_prop fleet-temporal.service FragmentPath)" == /run/systemd/transient/* ]]; then
    red "fleet-temporal.service 是个临时单元（systemd-run 起的），先 systemctl stop 它再装"
    return 1
  fi
  ok "Ubuntu $ver（$CODENAME），x86_64，cgroup v2，node $(/usr/bin/node --version)"
}

# node 默认的编译缓存目录先由 root 建好（lib/node-cache.sh）：排在第一次以 fleet 跑 node（下面装 pnpm 就会）之前。
# 没弄成照装机的规矩停下：这一步不对，会话就能替 fleet、pilot、root 放编译缓存、以他们的身份跑代码
setup_node_cache() {
  step "node 的编译缓存目录（$NODE_CACHE_DIR 归 root、755；开机时由 $NODE_CACHE_CONF 先建好）"
  ensure_node_cache "$NODE_CACHE_DIR" "$NODE_CACHE_CONF"
}

readback_node_cache() { check_node_cache "$NODE_CACHE_DIR" "$NODE_CACHE_CONF"; }

load_config() {
  load_env "$ENV_FILE" "${ENV_KEYS[@]}"
  if [[ -f "$TEMPORAL_ENV" ]]; then load_env "$TEMPORAL_ENV" FLEET_TEMPORAL_DB_PASSWORD; fi
  ok "本机配置 $ENV_FILE：香港地址$(filled "$FLEET_WG_HK_ENDPOINT")，香港公钥$(filled "$FLEET_WG_HK_PUBLIC_KEY")"
}

setup_packages() {
  step "装包（PostgreSQL 用 Ubuntu 自带的源，吃得到自动安全更新）"
  # 早先的版本加过 PostgreSQL 的 PGDG 源：撤掉。已经从 PGDG 装上的包不会因此变，读回会查出来
  local removed=0
  remove_legacy /etc/apt/sources.list.d/pgdg.sources "早先加的 PGDG 源"
  removed=$((removed || WROTE))
  remove_legacy /etc/apt/keyrings/pgdg.asc "早先加的 PGDG 签名公钥"
  removed=$((removed || WROTE))
  if ((removed)); then APT_UPDATED=0; fi
  # rsync、openssh-client：发布脚本经隧道往香港传驾驶舱静态文件
  ensure_pkgs "postgresql-$PG_MAJOR" wireguard-tools nftables rsync openssh-client
}

setup_wireguard() {
  step "WireGuard 客户端（法国主动连香港，不开入站端口）"
  local key_changed conf
  ensure_dir /etc/wireguard root:root 700
  ensure_wg_key "$WG_IF"
  key_changed=$WROTE
  echo "  法国公钥：$WG_PUBLIC_KEY（填进香港 /etc/fleet-dao/hk.env 的 FLEET_WG_FRANCE_PUBLIC_KEY）"
  if [[ -z "$FLEET_WG_HK_PUBLIC_KEY" || -z "$FLEET_WG_HK_ENDPOINT" ]]; then
    # 读回那一步会记「待配」
    echo "  缺香港的公钥或地址（$ENV_FILE），隧道先不起"
    return 0
  fi
  if ! valid_wg_key "$FLEET_WG_HK_PUBLIC_KEY"; then
    red "$ENV_FILE 的 FLEET_WG_HK_PUBLIC_KEY 不像 WireGuard 公钥（应为 44 个字符、以 = 结尾）"
    return 1
  fi
  if [[ ! "$FLEET_WG_HK_ENDPOINT" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]]; then
    red "$ENV_FILE 的 FLEET_WG_HK_ENDPOINT 应为 <地址>:<端口>"
    return 1
  fi
  conf="# fleet-dao 两机隧道，法国这头（客户端）。deploy/france.sh 生成，别手改；私钥在 /etc/wireguard/$WG_IF.key。
# 只有出站：法国主动连香港，每 25 秒发一次保活，香港回来的包走的是这条连接，法国不用开任何入站端口。
[Interface]
Address = $WG_ADDR
PostUp = wg set %i private-key /etc/wireguard/%i.key

[Peer]
# 香港
PublicKey = $FLEET_WG_HK_PUBLIC_KEY
Endpoint = $FLEET_WG_HK_ENDPOINT
AllowedIPs = $WG_HK_ADDR/32
PersistentKeepalive = 25"
  put_file "/etc/wireguard/$WG_IF.conf" root:root 600 "$conf"
  ensure_unit_running "wg-quick@$WG_IF.service" $((key_changed || WROTE))
}

# 以 postgres 超级用户跑 psql。先 cd /：postgres 进不了 root 的家目录，会多打一行警告
pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }

temporal_login_ok() {
  env -i PATH=/usr/bin:/bin PGPASSWORD="$FLEET_TEMPORAL_DB_PASSWORD" PGCONNECT_TIMEOUT=5 \
    psql -X -q -h 127.0.0.1 -p "$PG_PORT" -U temporal -d temporal -tAc 'select 1' >/dev/null 2>&1
}

setup_postgres() {
  step "PostgreSQL $PG_MAJOR"
  local conf_dir=/etc/postgresql/$PG_MAJOR/main port restart unit_changed=0 i role db owner
  # 集群平时由装包顺手建好；包是后换的（比如从别的源换回来）时可能没有，补上
  if [[ -z "$(pg_lsclusters -h | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main"')" ]]; then
    pg_createcluster "$PG_MAJOR" main >/dev/null
    changed "建集群 $PG_MAJOR/main"
  fi
  port=$(pg_lsclusters -h | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { print $3 }')
  if [[ "$port" != "$PG_PORT" ]]; then
    red "集群 $PG_MAJOR/main 的端口是「$port」，不是 $PG_PORT"
    return 1
  fi
  put_file "$conf_dir/conf.d/fleet.conf" root:root 644 "# deploy/france.sh 写的：只听本机（法国不对外开端口，隧道那头也没人要直连库）。改了要重启库。
listen_addresses = 'localhost'"
  restart=$WROTE
  ensure_dir "/etc/systemd/system/$PG_UNIT.d" root:root 755
  # 装包自带的集群单元是 Restart=no：进程没了就一直躺着。always 连干净退出也拉起来（审计 P06）
  put_file "/etc/systemd/system/$PG_UNIT.d/fleet.conf" root:root 644 "# deploy/france.sh 写的：库的进程没了（崩了、被杀了、干净退出了）都拉起来。
[Service]
Restart=always
RestartSec=5"
  unit_changed=$WROTE
  # 早先的版本让库排在隧道之后起：wg-quick 起动没有超时，会把库一起拖住，而隧道上也没人连库
  remove_legacy "/etc/systemd/system/$PG_UNIT.d/fleet-wireguard.conf" "早先让库等隧道的 drop-in"
  unit_changed=$((unit_changed || WROTE))
  if ((unit_changed)); then systemctl daemon-reload; fi
  # 集群单元由 postgresql.service 按 Debian 的方式拉起（装包时已启用），这里只管它在跑
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    systemctl start "$PG_UNIT"
    changed "启动 $PG_UNIT"
  elif ((restart)); then
    systemctl restart "$PG_UNIT"
    changed "重启 $PG_UNIT（监听地址变了）"
  fi
  for ((i = 0; i < 30; i++)); do
    if pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then break; fi
    sleep 1
  done
  if ! pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then
    red "库 30 秒还没就绪：journalctl -u $PG_UNIT -n 50"
    return 1
  fi

  # 口令只在 root 和 fleet 读得到的文件里；首次生成，之后不再动
  if [[ ! -s "$TEMPORAL_ENV" ]]; then
    put_file "$TEMPORAL_ENV" root:fleet 640 "# Temporal 连库的口令：deploy/france.sh 首次生成，之后不再动。
FLEET_TEMPORAL_DB_PASSWORD=$(openssl rand -hex 24)"
  else
    fix_meta "$TEMPORAL_ENV" root:fleet 640
  fi
  load_env "$TEMPORAL_ENV" FLEET_TEMPORAL_DB_PASSWORD
  if [[ ! "$FLEET_TEMPORAL_DB_PASSWORD" =~ ^[0-9a-f]{48}$ ]]; then
    red "$TEMPORAL_ENV 里的 FLEET_TEMPORAL_DB_PASSWORD 不是装机脚本生成的样子"
    return 1
  fi

  # 角色：fleet 走本机 socket 的 peer 认证（操作系统用户 fleet = 库角色 fleet），不设口令；temporal 走 127.0.0.1 + 口令
  for role in fleet temporal; do
    if [[ "$(pg_admin -c "select 1 from pg_roles where rolname = '$role'")" != 1 ]]; then
      pg_admin -c "create role $role login"
      changed "建库角色 $role"
    fi
  done
  for db in fleet:fleet temporal:temporal temporal_visibility:temporal; do
    owner=${db#*:}
    db=${db%%:*}
    if [[ "$(pg_admin -c "select 1 from pg_database where datname = '$db'")" != 1 ]]; then
      pg_admin -c "create database $db owner $owner"
      changed "建库 $db（属主 $owner）"
    fi
    if [[ "$(pg_admin -c "select pg_get_userbyid(datdba) from pg_database where datname = '$db'")" != "$owner" ]]; then
      red "库 $db 的属主不是 $owner——不是装机脚本建的？停下等人看"
      return 1
    fi
  done
  if ! temporal_login_ok; then
    # 口令走标准输入，不进任何进程的命令行
    printf "alter role temporal with login password '%s';\n" "$FLEET_TEMPORAL_DB_PASSWORD" | pg_admin -f -
    changed "设置库角色 temporal 的口令（来自 $TEMPORAL_ENV）"
    if ! temporal_login_ok; then
      red "temporal 用口令从 127.0.0.1 还是登不上：看 $conf_dir/pg_hba.conf"
      return 1
    fi
  fi
  ok "库 fleet / temporal / temporal_visibility 与角色 fleet / temporal 就位"
}

# 下载发布包、核对 sha256、只解出要的几个文件；标记文件（.sha256）最后才写，半截安装下次会重来。
# 要的文件写它在包里的路径（可以带一层目录，比如 uv 的包），装进目录时只留文件名
fetch_release() { # 目录 下载地址 sha256 要的文件…
  local dir=$1 url=$2 sum=$3 tmp m
  shift 3
  WROTE=0
  if [[ -f "$dir/.sha256" ]] && (cd "$dir" && sha256sum --quiet --status -c .sha256); then
    ok "已装 $dir"
    return 0
  fi
  tmp=$(mktemp -d /var/tmp/fleet-dao-download.XXXXXX)
  if ! curl -fsSL --retry 3 --max-time 900 -o "$tmp/pkg.tgz" "$url"; then
    rm -rf -- "$tmp"
    red "下载失败：$url"
    return 1
  fi
  if ! printf '%s  %s\n' "$sum" "$tmp/pkg.tgz" | sha256sum --quiet --status -c -; then
    rm -rf -- "$tmp"
    red "sha256 对不上，不装：$url"
    return 1
  fi
  tar -xzf "$tmp/pkg.tgz" -C "$tmp" "$@"
  install -d -o root -g root -m 755 "$dir"
  for m in "$@"; do install -o root -g root -m 755 "$tmp/$m" "$dir/${m##*/}"; done
  (cd "$dir" && sha256sum "${@##*/}" >.sha256)
  rm -rf -- "$tmp"
  changed "装 ${url##*/}（sha256 已核对）到 $dir"
}

sql_tool() {
  env -i PATH=/usr/bin:/bin SQL_PASSWORD="$FLEET_TEMPORAL_DB_PASSWORD" "$TEMPORAL_HOME/bin/temporal-sql-tool" \
    --plugin postgres12 --ep 127.0.0.1 -p "$PG_PORT" -u temporal "$@"
}

# 库里 Temporal 表结构的版本号：打印版本号；还没有版本表打印空、返回 0；连不上库、查询报错、回的认不出返回 1（原因在 stderr）。
# 先问表在不在（to_regclass），在了再读：不靠「查询报错」认「没有版本表」——连不上库也是报错，当成没有版本表就会对已有的库
# 跑 setup-schema（审查 S5）。
schema_version() { # 库
  local has
  has=$(pg_admin -d "$1" -c "select to_regclass('schema_version') is not null") || return 1
  case $has in
  f) return 0 ;;
  t) pg_admin -d "$1" -c 'select curr_version from schema_version' ;;
  *)
    echo "问版本表在不在，psql 回的认不出：「${has:0:80}」" >&2
    return 1
    ;;
  esac
}

# 一个库的表结构：没有版本表就先建，再升到这个版本自带的最新；前后版本号一样就是没动。读不到版本号（连不上库）判红、不建不升
temporal_schema() { # 库 表结构名
  local db=$1 name=$2 before after log
  log=$(mktemp)
  if ! before=$(schema_version "$db" 2>"$log"); then
    red "读库 $db 的表结构版本没成（连不上库或查询报错，不当成「还没有版本表」）：$(tail -3 "$log" | tr '\n' ' ')"
    rm -f -- "$log"
    return 1
  fi
  if [[ -z "$before" ]] && ! sql_tool --db "$db" setup-schema -v 0.0 >"$log" 2>&1; then
    red "给库 $db 建版本表失败：$(tail -3 "$log" | tr '\n' ' ')"
    rm -f -- "$log"
    return 1
  fi
  if ! sql_tool --db "$db" update-schema --schema-name "$name" >"$log" 2>&1; then
    red "升级库 $db 的表结构失败：$(tail -3 "$log" | tr '\n' ' ')"
    rm -f -- "$log"
    return 1
  fi
  if ! after=$(schema_version "$db" 2>"$log"); then
    red "升级完读库 $db 的表结构版本没成：$(tail -3 "$log" | tr '\n' ' ')"
    rm -f -- "$log"
    return 1
  fi
  rm -f -- "$log"
  if [[ "$before" == "$after" ]]; then
    ok "库 $db 表结构版本 $after"
  else
    changed "库 $db 表结构 ${before:-（空）} → $after"
  fi
}

# 运维命令行（只连 fleet-dao 这套）。不带调用者的环境，免得 HOME 里的配置或残留的 TEMPORAL_* 变量掺进来
tcli() { env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal "$@"; }

json_get() { # JSON 点分路径
  printf '%s' "$1" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v; try { v = JSON.parse(s); } catch { return; }
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined) process.stdout.write(String(v));
    });' "$2"
}

setup_temporal() {
  step "Temporal 服务端 $TEMPORAL_SERVER_VERSION（前端 127.0.0.1:$TEMPORAL_FRONTEND_PORT）"
  local restart=0 db name pids main port i desc ttl want
  ensure_dir "$TEMPORAL_HOME" root:root 755
  ensure_dir "$TEMPORAL_HOME/bin" root:root 755
  fetch_release "$TEMPORAL_HOME/server-$TEMPORAL_SERVER_VERSION" \
    "https://github.com/temporalio/temporal/releases/download/v$TEMPORAL_SERVER_VERSION/temporal_${TEMPORAL_SERVER_VERSION}_linux_amd64.tar.gz" \
    "$TEMPORAL_SERVER_SHA256" temporal-server temporal-sql-tool
  fetch_release "$TEMPORAL_HOME/cli-$TEMPORAL_CLI_VERSION" \
    "https://github.com/temporalio/cli/releases/download/v$TEMPORAL_CLI_VERSION/temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz" \
    "$TEMPORAL_CLI_SHA256" temporal
  ensure_symlink "$TEMPORAL_HOME/bin/temporal-server" "../server-$TEMPORAL_SERVER_VERSION/temporal-server"
  restart=$((restart || WROTE))
  ensure_symlink "$TEMPORAL_HOME/bin/temporal-sql-tool" "../server-$TEMPORAL_SERVER_VERSION/temporal-sql-tool"
  ensure_symlink "$TEMPORAL_HOME/bin/temporal" "../cli-$TEMPORAL_CLI_VERSION/temporal"
  render "$DEPLOY_DIR/france/fleet-temporal-cli.sh" FRONTEND_PORT="$TEMPORAL_FRONTEND_PORT"
  put_file /usr/local/bin/fleet-temporal root:root 755 "$RENDERED"

  # 表结构：没有版本表就先建，再升到这个版本自带的最新；前后版本号一样就是没动
  for db in temporal temporal_visibility; do
    name=postgresql/v12/temporal
    if [[ "$db" == temporal_visibility ]]; then name=postgresql/v12/visibility; fi
    temporal_schema "$db" "$name" || return 1
  done

  render "$DEPLOY_DIR/france/temporal.yaml" PG_PORT="$PG_PORT" \
    FRONTEND_PORT="$TEMPORAL_FRONTEND_PORT" FRONTEND_MEMBERSHIP_PORT="$TEMPORAL_FRONTEND_MEMBERSHIP_PORT" \
    HISTORY_PORT="$TEMPORAL_HISTORY_PORT" HISTORY_MEMBERSHIP_PORT="$TEMPORAL_HISTORY_MEMBERSHIP_PORT" \
    MATCHING_PORT="$TEMPORAL_MATCHING_PORT" MATCHING_MEMBERSHIP_PORT="$TEMPORAL_MATCHING_MEMBERSHIP_PORT" \
    WORKER_PORT="$TEMPORAL_WORKER_PORT" WORKER_MEMBERSHIP_PORT="$TEMPORAL_WORKER_MEMBERSHIP_PORT"
  put_file "$TEMPORAL_CONFIG" root:fleet 640 "$RENDERED"
  restart=$((restart || WROTE))
  put_file /etc/systemd/system/fleet-temporal.service root:root 644 "$(<"$DEPLOY_DIR/france/fleet-temporal.service")"
  if ((WROTE)); then
    systemctl daemon-reload
    restart=1
  fi

  # 端口先查清：没人占，或者占着的正是我们自己的服务端（审计 P10：被占了要说出是谁）
  main=$(unit_prop fleet-temporal.service MainPID)
  for port in "${TEMPORAL_PORTS[@]}"; do
    pids=$(port_pids tcp "$port")
    if [[ -n "$pids" && " $pids" != *" $main "* ]]; then
      red "端口 $port 被别的进程占着：$(ps -o pid=,user=,comm= -p "${pids// /,}" 2>/dev/null | tr -s ' ' | tr '\n' ';')"
      return 1
    fi
  done
  ensure_unit_running fleet-temporal.service "$restart"

  # 服务端刚起来时前端要一会儿才就绪：有界地等，等不到不当成功（审计 P09）
  for ((i = 0; i < 60; i++)); do
    if [[ "$(tcli operator cluster health 2>/dev/null)" == *SERVING* ]]; then break; fi
    sleep 1
  done
  if [[ "$(tcli operator cluster health 2>/dev/null)" != *SERVING* ]]; then
    red "Temporal 前端 60 秒还没就绪：journalctl -u fleet-temporal -n 80"
    return 1
  fi

  # 命名空间 fleet，已结束的工作流保留 30 天（默认只有 24 小时）
  want="$((RETENTION_HOURS * 3600))s"
  desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
  if [[ -z "$desc" ]]; then
    tcli operator namespace create --namespace "$NAMESPACE" --retention "${RETENTION_HOURS}h" >/dev/null
    changed "建命名空间 $NAMESPACE（已结束的工作流保留 ${RETENTION_HOURS} 小时）"
    # 新命名空间要等服务端的缓存刷新才查得到
    for ((i = 0; i < 30; i++)); do
      desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
      if [[ -n "$desc" ]]; then break; fi
      sleep 1
    done
  fi
  ttl=$(json_get "$desc" config.workflowExecutionRetentionTtl)
  if [[ "$ttl" != "$want" ]]; then
    tcli operator namespace update --namespace "$NAMESPACE" --retention "${RETENTION_HOURS}h" >/dev/null
    changed "命名空间 $NAMESPACE 的保留期「${ttl:-读不到}」→ $want"
  fi
}

setup_slice() {
  step "AI 会话资源池 fleet-agents.slice（池子设总量上限；每个会话各自的上限由引擎起会话时给）"
  put_file /etc/systemd/system/fleet-agents.slice root:root 644 "$(<"$DEPLOY_DIR/france/fleet-agents.slice")"
  if ((WROTE)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-agents.slice 0
}

pnpm_want() { /usr/bin/node -p 'require(process.argv[1]).packageManager' "$DEPLOY_DIR/../package.json"; }
pnpm_have() { as_user fleet env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version 2>/dev/null || true; }

setup_pnpm() {
  local want ver
  want=$(pnpm_want)
  ver=${want#pnpm@}
  step "pnpm $ver（fleet 用户，corepack）"
  if [[ ! "$want" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    red "仓根 package.json 的 packageManager 是「$want」，认不出 pnpm 版本"
    return 1
  fi
  if [[ "$(pnpm_have)" == "$ver" ]]; then
    ok "fleet 用户的 pnpm 是 $ver"
    return 0
  fi
  # 发布（release.sh 以 fleet 装依赖、打包）用的这一份：垫片装在 fleet 自己的 ~/.local/bin，它的 PATH 里排在 /usr/local/bin
  # 前面。AI 会话读不到 fleet 的家，用的是 setup_session_pnpm 装的那一份。写家目录的事都以 fleet 身份做（审计 P01）
  as_user fleet mkdir -p /home/fleet/.local/bin
  as_user fleet corepack enable --install-directory /home/fleet/.local/bin pnpm
  as_user fleet env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "$want" >/dev/null
  if [[ "$(pnpm_have)" != "$ver" ]]; then
    red "装完 fleet 用户的 pnpm 还不是 $ver（读到「$(pnpm_have)」）"
    return 1
  fi
  changed "fleet 用户装 pnpm $ver（corepack，垫片在 /home/fleet/.local/bin）"
}

# AI 会话用的 pnpm（lib/session-pnpm.sh）：会话交活要原样跑 `pnpm test:changed`，引擎给会话的 PATH 上得找得到它。
# 装完以会话用户、按 fleet-agent-scope 的默认 PATH 跑一次入口核版本；引擎给会话的那条 PATH 上找不找得到，在读回里查
setup_session_pnpm() {
  local want
  want=$(pnpm_want)
  step "AI 会话用的 pnpm $PNPM_VERSION（归 root：$PNPM_ROOT/<版本>，入口 $PNPM_BIN；钉版本、核 sha512）"
  if [[ "${want#pnpm@}" != "$PNPM_VERSION" ]]; then
    red "仓根 package.json 钉的是 $want，france.sh 顶部钉的是 pnpm@$PNPM_VERSION 的校验和：升 pnpm 时两处一起改（校验和照 npm view pnpm@<版本> dist.integrity）"
    return 1
  fi
  ensure_session_pnpm "$PNPM_VERSION" "$PNPM_INTEGRITY" "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" \
    "$PNPM_ROOT" "$PNPM_BIN" as_tool_user "${SESSION_USERS[0]}"
}

cursor_versions_dir() { printf '%s' "${CURSOR_VERSIONS_DIR//\{user\}/$1}"; } # 会话用户

# 会话用户的 cursor-agent（lib/cursor-agent.sh）：引擎起 Cursor 会话用的就是他家里这份。照引擎的找法一个能跑的都没有时，
# 以他自己的身份跑官方安装脚本；有了不动。装不上只记红、不中断（读回还会再判一次）。认证用的 API 密钥由创始人放
# （deploy/cursor-key.sh put，docs/ops.md 第五节）
setup_cursor_agent() {
  step "会话用户的 cursor-agent（${SESSION_USERS[*]}；官方安装脚本，以会话用户自己的身份装，只在没有时装）"
  local u
  for u in "${SESSION_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，cursor-agent 没装（建了再跑一遍）"
      continue
    fi
    ensure_cursor_agent "$u" "$(cursor_versions_dir "$u")" "$CURSOR_INSTALL_URL"
  done
}

# 会话用户的 grok 命令行（lib/grok.sh）：引擎起 Grok 会话用的就是他家里这份。不在、不能跑时以他自己的身份跑官方安装脚本；
# 有了不动。装不上只记红、不中断（读回还会再判一次）。登录由创始人以他的身份做一次（docs/ops.md 第五节「会话用户的 grok」）
setup_grok() {
  step "会话用户的 grok 命令行（${SESSION_USERS[*]}；官方安装脚本，以会话用户自己的身份装，只在没有时装）"
  local u
  for u in "${SESSION_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，grok 没装（建了再跑一遍）"
      continue
    fi
    ensure_grok "$u" "$(grok_bin "$u")" "$GROK_INSTALL_URL"
  done
}

# 会话用户自己的 Mirasim 服务，本地模式常驻（lib/mirasim.sh，#345 接上引擎、单元本身 #424）：服务端本体（node、
# server.cjs）不是这一步装的，创始人或帅位先用 mirasim ssh connect（或桌面端 SSH 远程模式）连一次装好
# （docs/ops.md 第五节「会话用户的 Mirasim」）——这一步只把它做成常驻：本体还没到位就不装单元、记待配（不许把
# 整个装机停下：这里改成一个 if 判断，不走「赋值 || rc=$?」那条容易踩坑的路，见 lib/mirasim.sh 顶上的注释）。
setup_mirasim_session() {
  step "会话用户 ${SESSION_USERS[0]} 的 Mirasim 服务（本地模式常驻，端口 $MIRASIM_SESSION_PORT；deploy/france/fleet-mirasim-session.service）"
  local u=${SESSION_USERS[0]} unit_changed
  if ! id "$u" >/dev/null 2>&1; then
    pending "$u 这个用户还没有，Mirasim 常驻单元没装（建了再跑一遍）"
    return 0
  fi
  if ! mirasim_server_installed "$u"; then
    pending "$u 还没有 Mirasim 服务端本体（没有 $(mirasim_server_bin "$u")），这轮不装常驻单元（docs/ops.md 第五节「会话用户的 Mirasim」）"
    return 0
  fi
  render "$DEPLOY_DIR/france/fleet-mirasim-session.service" \
    SESSION_USER="$u" MIRASIM_SESSION_PORT="$MIRASIM_SESSION_PORT"
  put_file "$MIRASIM_SESSION_UNIT_FILE" root:root 644 "$RENDERED"
  unit_changed=$WROTE
  if ((unit_changed)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-mirasim-session.service "$unit_changed"
}

setup_app_config() {
  step "应用的本机配置（/etc/fleet-dao 下的环境文件；应用本身由 deploy/release.sh 发布）"
  local name spec file key what desired api_ok=1
  # 新机器上照仓里的期望建（#323）：公开的照期望写，私有的空着等人放。
  # 已经在的不建、不补：之后每一项由发布时照期望写（只写期望变了的键，人手改的不改回），对账报偏离。这里只管属主和权限、
  # 删掉功能删了还留着的键、按「引擎」App 填空着的 webhook 密钥（lib/app-config.sh）
  desired=$DEPLOY_DIR/france/desired-config.json
  for name in "${APP_ENV_FILES[@]}"; do
    file=/etc/fleet-dao/$name.env
    # 目录、符号链接（含断链）判红、跳过：fix_meta 会跟着链接改属主，put_file 会把链接换掉
    if ! app_config_path_ok "$file"; then
      if [[ "$name" == api ]]; then api_ok=0; fi
      continue
    fi
    if [[ -e "$file" ]]; then
      fix_meta "$file" root:fleet 640
      # 功能删掉了、机器上还留着的键：这里清掉（remove_stale_key 只删这一个键那一行，不碰旁的）
      if [[ "$name" == engine ]]; then
        remove_stale_key "$file" FLEET_SENSITIVE_VALUES_FILE "卫生检查已知敏感值名单机制删掉了"
      fi
    elif ! env_from_desired "$file" "$name.env" "$desired" "$CONFIG_CLI"; then
      if [[ "$name" == api ]]; then api_ok=0; fi
    fi
  done
  if ((api_ok)); then fill_webhook_secret /etc/fleet-dao/api.env "$ENGINE_APP_JSON"; fi
  # 早先版本手放的已知敏感值名单文件：机制删掉了，没人读了，删掉（只删装机脚本认识的这一个路径）
  remove_legacy "$STALE_SENSITIVE_VALUES" "卫生检查早先的已知敏感值名单"
  # 随机密钥：首次生成，之后不再动（换了会让已发出的登录、通行证全部作废；真要换就删掉文件再跑）。值不进日志
  for spec in "${APP_SECRETS[@]}"; do
    IFS=: read -r name key what <<<"$spec"
    file=/etc/fleet-dao/$name.env
    if ! app_config_path_ok "$file"; then continue; fi
    if [[ -s "$file" ]]; then
      fix_meta "$file" root:fleet 640
    else
      put_file "$file" root:fleet 640 "# $what。deploy/france.sh 首次生成的随机值，之后不再动；不进 git，别打印。
$key=$(openssl rand -hex 32)"
    fi
  done
  # 配置对账的指纹钥匙：首次生成，之后不动（换了钥匙，仓里期望文件记的私有值指纹要全部重算）。只有 root 读，值不进日志
  if app_config_path_ok "$CONFIG_KEY"; then
    if [[ -s "$CONFIG_KEY" ]]; then
      fix_meta "$CONFIG_KEY" root:root 600
    else
      put_file "$CONFIG_KEY" root:root 600 "$(openssl rand -hex 32)"
    fi
  fi
}

# 发布脚本登香港用的钥匙：没有就生成（只有 root 读得到），打印公钥给香港登记。公钥随时能从私钥导出，不另存一份
ensure_deploy_key() { # 私钥文件 注释 香港 hk.env 里的键 用途
  if [[ ! -s "$1" ]]; then
    rm -f -- "$1" "$1.pub"
    ssh-keygen -q -t ed25519 -N '' -C "$2" -f "$1" >/dev/null
    rm -f -- "$1.pub"
    changed "生成$4的钥匙 $1"
  fi
  fix_meta "$1" root:root 600
  echo "  $4的公钥：$(ssh-keygen -y -f "$1")（整行填进香港 /etc/fleet-dao/hk.env 的 $3）"
}

setup_web_upload() {
  step "发布脚本登香港用的钥匙（香港只许它们经隧道来：一把只能往 /srv/fleet-dao-web 写，一把只能发飞书网关）"
  local line re
  ensure_deploy_key "$WEB_UPLOAD_KEY" fleet-dao-web-upload FLEET_WEB_UPLOAD_PUBLIC_KEY 传静态文件
  ensure_deploy_key "$GATEWAY_DEPLOY_KEY" fleet-dao-gateway-deploy FLEET_GATEWAY_DEPLOY_PUBLIC_KEY 发飞书网关
  # 香港 sshd 的主机钥匙：经隧道取（隧道两头靠 WireGuard 钥匙互认，那头只可能是香港），钉住之后只认这一把
  if [[ -s "$HK_KNOWN_HOSTS" ]]; then
    fix_meta "$HK_KNOWN_HOSTS" root:root 600
    return 0
  fi
  if ! ping -c 1 -W 2 -q "$WG_HK_ADDR" >/dev/null 2>&1; then
    # 读回那一步会记「待配」
    echo "  隧道还没通，香港 sshd 的主机钥匙等隧道通了再取"
    return 0
  fi
  line=$(ssh-keyscan -T 5 -t ed25519 "$WG_HK_ADDR" 2>/dev/null) || line=""
  re="^${WG_HK_ADDR//./\\.} ssh-ed25519 [A-Za-z0-9+/]+=*$"
  if [[ ! "$line" =~ $re ]]; then
    red "经隧道取不到香港 sshd 的主机钥匙（读到「${line:0:80}」）"
    return 1
  fi
  put_file "$HK_KNOWN_HOSTS" root:root 600 "# 香港 sshd 的主机钥匙：deploy/france.sh 经隧道取的。发布脚本往香港传静态文件时只认这一把；香港真换了主机钥匙就删掉本文件重跑。
$line"
}

# 已删的演示版（#1223）：以前装过的单元停掉、禁用、删掉，脚本删掉。已经没有就什么都不动（幂等）。
# 停不掉、删不掉判红（读回 readback_retired_units 还会再核对一遍），不当成没事
retire_old_units() {
  step "清掉已删的演示版留下的单元和脚本（#1223）"
  local u f touched=0
  for u in "${RETIRED_UNITS[@]}"; do
    f=$RETIRED_UNIT_DIR/$u
    if [[ ! -e "$f" && ! -L "$f" && "$(systemctl is-active "$u" 2>/dev/null)" != active ]]; then continue; fi
    if ! systemctl disable --now "$u" >/dev/null 2>&1 && [[ "$(systemctl is-active "$u" 2>/dev/null)" == active ]]; then
      red "$u 停不掉（#1223）：systemctl status $u 看现场"
      continue
    fi
    if ! rm -f -- "$f"; then
      red "$f 删不掉（#1223）"
      continue
    fi
    touched=1
    changed "停掉并删掉 $u（#1223）"
  done
  if ((touched)) && ! systemctl daemon-reload; then red "systemctl daemon-reload 失败（#1223）"; fi
  if [[ -e "$RETIRED_BIN" || -L "$RETIRED_BIN" ]]; then
    if rm -f -- "$RETIRED_BIN"; then changed "删掉 $RETIRED_BIN（#1223）"; else red "$RETIRED_BIN 删不掉（#1223）"; fi
  fi
}

# 读回：已删的单元和脚本真不在了（文件没有、也没在跑）
readback_retired_units() {
  local u bad=0
  for u in "${RETIRED_UNITS[@]}"; do
    if [[ -e "$RETIRED_UNIT_DIR/$u" || -L "$RETIRED_UNIT_DIR/$u" ]] || [[ "$(systemctl is-active "$u" 2>/dev/null)" == active ]]; then
      red "已删的 $u 还在（#1223）：停掉、删掉 $RETIRED_UNIT_DIR/$u 后 systemctl daemon-reload"
      bad=1
    fi
  done
  if [[ -e "$RETIRED_BIN" || -L "$RETIRED_BIN" ]]; then
    red "已删的 $RETIRED_BIN 还在（#1223）"
    bad=1
  fi
  if ((bad == 0)); then ok "已删的演示版单元和脚本都不在了（#1223）"; fi
}

# 自动发布单元：定时器每 5 分钟拉起一轮（deploy/france/auto-release），只读不发；发完版后以 root 跑 france.sh --auto-tier、替会话用户同步规矩。
# 脚本放 /usr/local/lib 下的副本（全链归 root），不从检出直接跑：检出它自己会快进，主线上一个坏提交不该把自动发布本身弄坏
setup_auto_release() {
  step "自动发布单元（只读：主线头、CI、在用版本、落后几个；发完版后装自动档、同步规矩；读数在 $AUTO_DIR；发布走驾驶舱按钮）"
  local f u unit_changed=0
  ensure_dir "$AUTO_DIR" root:root 755
  ensure_dir /usr/local/lib/fleet-dao root:root 755
  ensure_dir "$AUTO_RELEASE_LIB" root:root 755
  for f in "${AUTO_RELEASE_FILES[@]}"; do
    put_file "$AUTO_RELEASE_LIB/$f" root:root 644 "$(<"$DEPLOY_DIR/france/auto-release/$f")"
  done
  for u in "${AUTO_RELEASE_UNITS[@]}"; do
    put_file "/etc/systemd/system/$u" root:root 644 "$(<"$DEPLOY_DIR/france/$u")"
    if ((WROTE)); then unit_changed=1; fi
  done
  if ((unit_changed)); then systemctl daemon-reload; fi
  ensure_unit_running fleet-auto-release.timer "$unit_changed"
}

# 本脚本整套跑完没红：记下装到了哪个提交（检出的 HEAD）。自动发布拿它和主线比，数人工档那几个文件（HUMAN_TIER_PATHS：
# 防火墙、sudoers、建用户）后来改过几次，后端的 /healthz 据此标「装机脚本落后」。只记整套跑（自动档 --auto-tier 不记）。同一个提交再跑不改
record_applied() {
  local head
  if ! head=$(git -C "$DEPLOY_DIR/.." rev-parse HEAD 2>/dev/null) || [[ ! "$head" =~ ^[0-9a-f]{40}$ ]]; then
    pending "读不到检出在哪个提交，没记装到哪了（$APPLIED_FILE）：后端会报装机层没查成"
    return 0
  fi
  if [[ ! -d "$AUTO_DIR" ]]; then return 0; fi
  put_file "$APPLIED_FILE" root:root 644 "commit=$head"
}

# agents_sync（跑同步脚本、把逐行结论记进账）在 lib/agents-sync.sh
setup_agent_rules() {
  step "各家 AI 的全局说明与方法类 skill（${AGENT_RULES_USERS[*]}；agents/shared-rules.md 的通用段、agents/skills/）"
  local u
  for u in "${AGENT_RULES_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，全局说明没写（建了再跑一遍）"
      continue
    fi
    agents_sync --apply "$u"
  done
}

# skill docs-lookup 首选的搜索命令行，分发过去就得能用。排在装机最后：下载 uv 失败按装机的规矩判红停下时，
# 上一步的规矩已经写完；uv tool install 失败只记红、接着装下一个用户（lib/cli-tools.sh）
setup_cli_tools() {
  step "各用户的 ddgs（${AGENT_RULES_USERS[*]}；uv $UV_VERSION 钉版本、核 sha256，ddgs 和依赖钉版本）"
  local u
  fetch_release "$UV_HOME/$UV_VERSION" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" \
    "$UV_SHA256" uv-x86_64-unknown-linux-gnu/uv
  for u in "${AGENT_RULES_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，ddgs 没装（建了再跑一遍）"
      continue
    fi
    ensure_ddgs "$u" "$UV_HOME/$UV_VERSION/uv" "$DDGS_VERSION" "${DDGS_DEPS[@]}"
  done
}

readback_agent_rules() {
  local u
  for u in "${AGENT_RULES_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，全局说明没查"
      continue
    fi
    agents_sync --check "$u"
    check_ddgs "$u" "$DDGS_VERSION" "${DDGS_DEPS[@]}"
  done
}

readback() {
  step "读回"
  readback_secrets_dir
  readback_dirs
  readback_postgres
  readback_temporal
  readback_slice
  readback_session_users
  readback_pilot
  readback_agent_rules
  readback_sessions
  readback_node_cache
  readback_pnpm
  readback_cursor_agent
  readback_grok
  readback_mirasim
  readback_wireguard
  readback_firewall
  readback_session_ports
  readback_app_config
  readback_web_upload
  readback_retired_units
  readback_auto_release
  readback_release_request
  readback_proxy_headers
  readback_node_report_gate
  readback_service_home
}

# 自动发布：定时器在等、装上去的副本和仓里一样、上一轮什么时候跑的、干了什么、最近一轮崩没崩（lib/auto-release-state.sh：
# 读它每一轮写的状态文件，不看服务正在跑时是空的 ExecMainExitTimestamp）。跟不跟得上主线由后端 /healthz 的 deploy_lag 判
readback_auto_release() {
  local f
  if [[ "$(systemctl is-active fleet-auto-release.timer 2>/dev/null)" != active ]]; then
    red "fleet-auto-release.timer 没在跑：落后几个的读数不会更新，发完版也不会装自动档、同步规矩"
  fi
  for f in "${AUTO_RELEASE_FILES[@]}"; do
    if ! cmp -s -- "$AUTO_RELEASE_LIB/$f" "$DEPLOY_DIR/france/auto-release/$f"; then
      red "$AUTO_RELEASE_LIB/$f 和仓里的不一样（或没装）：重跑本脚本"
    fi
  done
  # 判红时两个都已经记进 REDS，这里照样往下查
  check_auto_release_state "$AUTO_DIR/state.json" "$DEPLOY_DIR/france/auto-release/lib.mjs" || true
  check_auto_release_unit "$(unit_prop fleet-auto-release.service ActiveState)" \
    "$(unit_prop fleet-auto-release.service ExecMainStatus)" || true
}

# 香港往法国转发时要清掉 Authorization 与 X-Fleet-Acting-Feishu（飞书网关的通行证和代表谁）：从公网带着这两个头
# 请求 /api，看法国收到的请求里有没有。驾驶舱后端没在跑：在隧道地址上临时起一个回显，直接看收到了哪些头，另带一个
# 探针头证明请求确实到了这里；后端在跑：看它怎么答——收到 Authorization 答 bearer_not_allowed，没收到答
# unauthenticated（packages/api 的 session.ts）
readback_proxy_headers() {
  local domain url nonce tmp pid i out code body verdict rc=0
  env_get /etc/fleet-dao/release.env FLEET_DOMAIN || rc=$?
  domain=$APP_ENV_VALUE
  if ((rc == 2)); then
    pending "没读到驾驶舱域名（$APP_CONFIG_WHY），香港清不清请求头这项没查"
    return 0
  fi
  if [[ ! "$domain" =~ ^[a-z0-9.-]+$ ]]; then
    pending "/etc/fleet-dao/release.env 的 FLEET_DOMAIN 没写或认不出，香港清不清请求头这项没查"
    return 0
  fi
  url=https://$domain/api/fleet-dao-probe
  local probe=(-H 'Authorization: Bearer fleet-dao-probe' -H 'X-Fleet-Acting-Feishu: fleet-dao-probe')
  if [[ -n "$(ss -Hltn "src ${WG_ADDR%/*} and sport = :$API_PORT" 2>/dev/null)" ]]; then
    if [[ "$(systemctl is-active fleet-api.service 2>/dev/null)" != active ]]; then
      pending "${WG_ADDR%/*}:$API_PORT 被别的程序占着（不是 fleet-api），香港清不清请求头这项没查"
      return 0
    fi
    out=$(curl -sS --max-time 15 "${probe[@]}" -w '\n%{http_code}' "https://$domain/api/me" 2>&1) || out=$'\n000'
    code=${out##*$'\n'}
    body=${out%$'\n'*}
    if [[ "$code" == 401 && "$body" == *'"unauthenticated"'* ]]; then
      ok "从公网带着 Authorization、X-Fleet-Acting-Feishu 请求 /api：后端答「没登录」，没收到这两个头"
    elif [[ "$body" == *bearer_not_allowed* || "$body" == *acting_missing* ]]; then
      red "香港把 Authorization 转给了后端（后端答的是网关通行证不对）：香港 nginx 没清这个头"
    else
      pending "从公网带头请求 /api，后端的回答认不出（HTTP $code），香港清不清请求头这项没查成"
    fi
    return 0
  fi
  nonce=$(openssl rand -hex 8)
  tmp=$(mktemp)
  # setpriv 直接换身份再 exec，记下的进程号就是回显本身（runuser 会多隔一层，杀它不一定连带杀掉回显、端口会被占着）
  (cd / && exec setpriv --reuid=fleet --regid=fleet --init-groups /usr/bin/node -e '
    const [host, port] = process.argv.slice(1);
    const srv = require("node:http").createServer((req, res) => {
      const body = JSON.stringify({ headers: Object.keys(req.headers), probe: req.headers["x-fleet-probe"] ?? null });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(body, () => process.exit(0));
    });
    srv.listen(Number(port), host);
    setTimeout(() => process.exit(3), 30000);' "${WG_ADDR%/*}" "$API_PORT") >"$tmp" 2>&1 &
  pid=$!
  for ((i = 0; i < 50; i++)); do
    if [[ -n "$(ss -Hltn "src ${WG_ADDR%/*} and sport = :$API_PORT" 2>/dev/null)" ]]; then break; fi
    sleep 0.1
  done
  out=$(curl -sS --max-time 15 "${probe[@]}" -H "X-Fleet-Probe: $nonce" "$url" 2>&1) || out=""
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f -- "$tmp"
  # shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
  verdict=$(printf '%s' "$out" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r; try { r = JSON.parse(s); } catch { return console.log("unreadable"); }
      if (r.probe !== process.argv[1]) return console.log("no-probe");
      const leaked = (r.headers || []).filter((h) => h === "authorization" || h === "x-fleet-acting-feishu");
      console.log(leaked.length ? `leaked ${leaked.join(",")}` : "clean");
    });' "$nonce")
  case $verdict in
  clean) ok "从公网带着 Authorization、X-Fleet-Acting-Feishu 请求 /api：法国收到的请求里没有这两个头（探针头到了，临时回显已收）" ;;
  leaked*) red "香港把 ${verdict#leaked } 转到了法国：香港 nginx 没清这个头" ;;
  *) pending "从公网请求 $url 没走到法国的临时回显（读到「${out:0:120}」），香港清不清请求头这项没查成" ;;
  esac
}

# 看板多机的收件口挡不挡得住假通行证（lib/node-report-gate.sh 判回答）：从公网（经香港）带一把假的 X-Fleet-Node-Token
# POST /api/nodes/report，要回 401。法国还没配 FLEET_NODE_KEYS 时后端回 503：记待配、提示去配，不当成通过。
readback_node_report_gate() {
  local domain out code body rc=0
  env_get /etc/fleet-dao/release.env FLEET_DOMAIN || rc=$?
  domain=$APP_ENV_VALUE
  if ((rc == 2)); then
    pending "没读到驾驶舱域名（$APP_CONFIG_WHY），收件口挡没挡住假通行证这项没查"
    return 0
  fi
  if [[ ! "$domain" =~ ^[a-z0-9.-]+$ ]]; then
    pending "/etc/fleet-dao/release.env 的 FLEET_DOMAIN 没写或认不出，收件口挡没挡住假通行证这项没查"
    return 0
  fi
  out=$(curl -sS --max-time 15 -X POST -H 'Content-Type: application/json' \
    -H "X-Fleet-Node-Token: $NODE_REPORT_FAKE_TOKEN" --data '{}' \
    -w '\n%{http_code}' "https://$domain/api/nodes/report" 2>&1) || out=$'\n000'
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  judge_node_report_gate "$code" "$body"
}

# 应用的环境文件都在、属主权限对；随机密钥是生成的样子、互不相同（后端要求）。按 systemd 的读法读（lib/app-config.sh
# 的 env_get），只比对，不打印值。lib/app-config.sh 的 check_* 判红返回 1：红已经记账，这里照样往下查，不让读回停在半路
readback_app_config() {
  local name spec file key what bad=0 values=() rc
  for name in "${APP_ENV_FILES[@]}"; do
    if [[ ! -f "/etc/fleet-dao/$name.env" ]]; then
      red "没有 /etc/fleet-dao/$name.env"
      bad=1
    fi
  done
  for spec in "${APP_SECRETS[@]}"; do
    IFS=: read -r name key what <<<"$spec"
    file=/etc/fleet-dao/$name.env
    rc=0
    env_get "$file" "$key" || rc=$?
    if ((rc == 2)); then
      red "$key 核对不了：$APP_CONFIG_WHY"
      bad=1
    elif ((APP_ENV_COUNT > 1)); then
      red "$file 里 $key 写了 $APP_ENV_COUNT 行（服务里生效的是最后一行）：删成一行"
      bad=1
    elif [[ ! "$APP_ENV_VALUE" =~ ^[0-9a-f]{64}$ ]]; then
      red "$file 里的 $key 不是装机脚本生成的样子（64 位十六进制）"
      bad=1
    fi
    values+=("$APP_ENV_VALUE")
  done
  if ((bad == 0)) && [[ "${values[0]}" == "${values[1]}" || "${values[0]}" == "${values[2]}" || "${values[1]}" == "${values[2]}" ]]; then
    red "三个随机密钥有两个一样：后端会拒绝启动"
    bad=1
  fi
  if ((bad == 0)); then ok "应用的环境文件都在（${APP_ENV_FILES[*]}），三个随机密钥已生成、互不相同（值不打印）"; fi
  local metas=()
  for name in "${APP_ENV_FILES[@]}"; do metas+=("/etc/fleet-dao/$name.env"); done
  for spec in "${APP_SECRETS[@]}"; do metas+=("/etc/fleet-dao/${spec%%:*}.env"); done
  check_app_file_meta "${metas[@]}" || :
  check_env_duplicates /etc/fleet-dao/engine.env /etc/fleet-dao/api.env /etc/fleet-dao/release.env || :
  # api.env 不在的话上面已经判红
  if [[ -f /etc/fleet-dao/api.env ]]; then check_webhook_secret /etc/fleet-dao/api.env "$ENGINE_APP_JSON" || :; fi
  check_engine_env /etc/fleet-dao/engine.env "$WORK_DIR" "$ENGINE_STATE_DIR" || :
  check_retired "$CARPOOL_SHIM" 拼车用户家里的派活垫片
  readback_config
}

# 配置和仓里的期望对账（#323）：和自动发布每一轮同一份判法（deploy/france/auto-release/config.mjs），拿在用那一版里的期望比；
# 法国的判法（拿在用那一版里的 deploy/france/desired-config.json 比）一个字节都不变。
readback_config() {
  local out line rc=0 meta
  if [[ -L "$CONFIG_KEY" ]]; then
    red "$CONFIG_KEY 是符号链接：要 root:root 600 的普通文件（配置对账的指纹钥匙）"
  elif [[ -e "$CONFIG_KEY" ]]; then
    meta=$(stat -c '%U:%G %a' -- "$CONFIG_KEY" 2>/dev/null) || meta="读不了"
    if [[ ! -f "$CONFIG_KEY" || "$meta" != "root:root 600" ]]; then
      red "$CONFIG_KEY 是「$meta」，要 root:root 600 的普通文件（配置对账的指纹钥匙，别人读到就能拿指纹猜私有值）"
    fi
  fi
  out=$(/usr/bin/node "$CONFIG_CLI" check 2>&1) || rc=$?
  while IFS= read -r line; do
    case $line in
    "ok "*) ok "${line#ok }" ;;
    "red "*) red "${line#red }" ;;
    "pending "*) pending "${line#pending }" ;;
    "") ;;
    *) pending "配置对账说了认不出的一行：${line:0:200}" ;;
    esac
  done <<<"$out"
  # 0 一致、1 有不一致、2 没查成：各行已经记了账；别的退出码是命令行自己没跑成
  case $rc in
  0 | 1 | 2) ;;
  *) red "配置对账没跑成（$CONFIG_CLI 退出码 $rc）" ;;
  esac
}

# 往香港传静态文件的通路：用发布脚本同一套参数试跑一次 rsync（-n，什么都不传）
readback_web_upload() {
  local empty rc=0 out
  if [[ ! -s "$WEB_UPLOAD_KEY" ]]; then
    red "没有上传钥匙 $WEB_UPLOAD_KEY"
    return 0
  fi
  if [[ ! -s "$HK_KNOWN_HOSTS" ]]; then
    pending "还没钉住香港 sshd 的主机钥匙（隧道通了再跑一遍 france.sh）"
    return 0
  fi
  empty=$(mktemp -d)
  out=$(hk_rsync -n -r -e "$(web_upload_ssh "$WEB_UPLOAD_KEY" "$HK_KNOWN_HOSTS")" "$empty/" "root@$WG_HK_ADDR:/" 2>&1) || rc=$?
  rmdir -- "$empty"
  if ((rc == 0)); then
    ok "法国经隧道往香港 /srv/fleet-dao-web 传文件的通路是通的（试跑，没传东西）"
  elif [[ "$out" == *"Permission denied"* ]]; then
    pending "香港还没认这把上传钥匙：把上面打印的公钥填进香港 hk.env 的 FLEET_WEB_UPLOAD_PUBLIC_KEY，重跑 hk.sh"
  else
    red "试着往香港传文件没成（rsync 退出码 $rc）：$(tail -3 <<<"$out" | tr '\n' ' ')"
  fi
  # 发网关的那把：问一次香港网关的状态（只读）
  if [[ ! -s "$GATEWAY_DEPLOY_KEY" ]]; then
    red "没有发网关用的钥匙 $GATEWAY_DEPLOY_KEY"
    return 0
  fi
  rc=0
  out=$(gateway_ssh "$GATEWAY_DEPLOY_KEY" "$HK_KNOWN_HOSTS" "root@$WG_HK_ADDR" status 2>&1) || rc=$?
  if ((rc == 0)) && [[ "$out" == *$'\n'config=* || "$out" == config=* ]]; then
    ok "法国经隧道问得到香港飞书网关的状态（fleet-gateway-deploy status）"
  elif [[ "$out" == *"Permission denied"* ]]; then
    pending "香港还没认发网关的钥匙：把上面打印的公钥填进香港 hk.env 的 FLEET_GATEWAY_DEPLOY_PUBLIC_KEY，重跑 hk.sh"
  else
    red "问香港飞书网关的状态没成（退出码 $rc）：$(tail -2 <<<"$out" | tr '\n' ' ')"
  fi
}

# 会话用户：判据在 lib/session-user.sh（没有 sudo、只在自己的组里、家里没有 GitHub 凭据；reclaude 没登录记「待配」）
readback_session_users() {
  local u
  for u in "${SESSION_USERS[@]}"; do readback_session_user "$u"; done
}

# 创始人的登录用户：判据在 lib/login-user.sh。reclaude 登没登录、家里放了什么钥匙是创始人自己的事，不查
readback_pilot() {
  local line
  if check_login_user "$PILOT_USER"; then
    ok "$PILOT_USER：在，家目录 750，只在自己的组和 $LOGIN_USER_LOG_GROUP 里，没有 sudo，reclaude 执行得了、登录 shell 里找得到"
    return 0
  fi
  for line in "${LOGIN_USER_BAD[@]}"; do red "$PILOT_USER：${line#*$'\t'}"; done
}

# 真起一个会话走一遍：fleet 经 sudo 调脚本 → 落进 fleet-agents.slice 下自己的 scope → 身份是会话用户、不带 root 组、
# 提不了权（NoNewPrivs=1）、上限写进了 cgroup
readback_sessions() {
  local id out want_cg user=${SESSION_USERS[0]} lines=()
  if [[ "$(sudo -l -U fleet 2>/dev/null)" == *"NOPASSWD: $AGENT_SCOPE_BIN"* ]]; then
    ok "sudoers：fleet 只能以 root 跑 $AGENT_SCOPE_BIN"
  else
    red "sudo -l -U fleet 里没有 $AGENT_SCOPE_BIN"
  fi
  REC_VIOLATIONS=()
  rec_check_path "sudo:fleet" "$AGENT_SCOPE_BIN" 程序
  if ((${#REC_VIOLATIONS[@]})); then red "${REC_VIOLATIONS[0]//$'\t'/ | }"; fi
  id=readback-$$
  want_cg="0::/fleet.slice/fleet-agents.slice/fleet-agent-$id.scope"
  # shellcheck disable=SC2016 # 单引号里的东西要在会话里展开，不是在这里
  out=$(as_user fleet /usr/bin/sudo -n "$AGENT_SCOPE_BIN" run "$id" --user "$user" --memory-max 64M --tasks-max 16 -- \
    /bin/sh -c 'id -un; id -G; cat /proc/self/cgroup; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.max"; awk "/^NoNewPrivs/ { print \$2 }" /proc/self/status' 2>&1) || true
  mapfile -t lines <<<"$out"
  if [[ "${lines[0]:-}" == "$user" && " ${lines[1]:-0} " != *" 0 "* && "${lines[2]:-}" == "$want_cg" && "${lines[3]:-}" == 67108864 && "${lines[4]:-}" == 1 ]]; then
    ok "起会话走得通：fleet → sudo → $user（不带 root 组、提不了权），落在 ${want_cg#0::}，上限写进了 cgroup"
  else
    red "起会话没走通，读到：$(tr '\n' '|' <<<"$out")"
  fi
}

# 以某个用户去连本机某个端口：连上返回 0；被拒、超时都返回非 0
connect_as() { # 用户 端口
  (cd / && runuser -u "$1" -- timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$2") >/dev/null 2>&1
}

readback_firewall() {
  local rule="allow in on $WG_IF from $WG_HK_ADDR to ${WG_ADDR%/*} port $API_PORT proto tcp" u port bad=0
  if command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null | head -1)" == "Status: active" ]]; then
    if [[ "$(ufw show added 2>/dev/null)" == *"ufw $rule"* ]]; then
      ok "ufw 只在隧道网卡上给香港开了 $API_PORT"
    else
      red "ufw 里没有「$rule」：香港转过来的驾驶舱请求会被挡"
    fi
  fi
  if [[ "$(systemctl is-active fleet-firewall.service 2>/dev/null)" != active ]] || ! nft list table inet fleet_dao >/dev/null 2>&1; then
    red "nft 表 inet fleet_dao 不在：会话能直接连 Temporal 给工作流发信号，别的用户能借会话用户的 reclaude"
    return 0
  fi
  # 装上去的就是仓里这份：文件和模板渲染出来的一样，内核里的表和文件一样（手改过、换了文件没重载，都在这里现形）。
  # 真连一遍在下面和 readback_session_ports 里
  local same=0
  if render_firewall; then
    if ! cmp -s -- "$NFT_FILE" <(printf '%s\n' "$RENDERED"); then
      red "$NFT_FILE 和仓里 deploy/france/fleet-dao.nft 渲染出来的不一样：重跑 france.sh"
    fi
  fi
  nft_table_same_as_file inet fleet_dao "$NFT_FILE" || same=$?
  case $same in
  0) ok "内核里的 nft 表 inet fleet_dao 就是 $NFT_FILE 那一份" ;;
  1) red "内核里的 nft 表 inet fleet_dao 和 $NFT_FILE 不一样（手改过，或者换了文件没重载）：systemctl reload fleet-firewall" ;;
  *) pending "内核里的 nft 表和 $NFT_FILE 一不一样没查成：$NFT_SAME_WHY" ;;
  esac
  # 真连一次：会话用户和登录用户 pilot 都连不上 Temporal 前端和库，fleet 连得上
  for u in "${SESSION_USERS[@]}" "$PILOT_USER"; do
    id "$u" >/dev/null 2>&1 || continue
    for port in "$TEMPORAL_FRONTEND_PORT" "$PG_PORT"; do
      if connect_as "$u" "$port"; then
        red "$u 连得上 127.0.0.1:$port"
        bad=1
      fi
    done
  done
  if ((bad == 0)); then ok "会话用户和 $PILOT_USER 都连不上 Temporal（$TEMPORAL_FRONTEND_PORT）和库（$PG_PORT）"; fi
  if connect_as fleet "$TEMPORAL_FRONTEND_PORT" && connect_as fleet "$PG_PORT"; then
    ok "fleet 连得上 Temporal 和库"
  else
    red "fleet 连不上 Temporal 或库：nft 表拦错了人"
  fi
  if [[ "$(systemctl is-enabled nftables.service 2>/dev/null)" == enabled ]]; then
    red "nftables.service 被启用了：它开机会 flush ruleset，把 ufw 的规则和这张表一起冲掉"
  fi
}

# 会话用户在本机开的口只许它自己和 root 连（#35）：fleet、pilot 真连一遍它此刻在听的口（reclaude 的代理口）和现起的探针，
# 判据在 lib/session-ports.sh
readback_session_ports() {
  check_session_ports "${SESSION_USERS[0]}" fleet "$PILOT_USER"
}

readback_dirs() {
  local spec path want have bad=0
  for spec in "/srv/fleet-dao root:root 755" "$RELEASES_DIR root:root 755" "/var/lib/fleet-dao fleet:fleet 750" "/var/log/fleet-dao fleet:fleet 750" \
    "$ENGINE_STATE_DIR fleet:fleet 750" "$SESSION_IO_DIR fleet:fleet 711" "$WORK_DIR root:root 755" \
    "/opt/fleet-dao root:root 755" "/home/fleet fleet:fleet 750" "$TEMPORAL_ENV root:fleet 640" "$TEMPORAL_CONFIG root:fleet 640"; do
    path=${spec%% *}
    want=${spec#* }
    have=$(stat -c '%U:%G %a' -- "$path" 2>/dev/null) || have="不存在"
    if [[ "$have" != "$want" ]]; then
      red "$path 是「$have」，应为 $want"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "目录与配置文件的属主、权限都对"; fi
}

readback_postgres() {
  local listen version restart
  if [[ "$(systemctl is-active "$PG_UNIT" 2>/dev/null)" != active ]]; then
    red "$PG_UNIT 没在跑"
    return 0
  fi
  if pg_isready -q -h 127.0.0.1 -p "$PG_PORT"; then ok "库在 127.0.0.1:$PG_PORT 就绪"; else red "库在 127.0.0.1:$PG_PORT 没就绪"; fi
  # 只听回环的判法在 lib/listen.sh（deploy/test/listen.test.sh 钉住）：机器没开 IPv6 的，只听 127.0.0.1 一个也是只听本机
  listen=$(ss -Hltn "sport = :$PG_PORT" 2>/dev/null | awk '{ print $4 }' | sort | tr '\n' ' ')
  if listens_loopback_only_on "$PG_PORT" "$listen"; then
    ok "库只听本机：$listen"
  else
    red "库在听「$listen」，应只听 127.0.0.1 和 ::1（回环以外的地址、或一个都没听，都不对）"
  fi
  restart=$(unit_prop "$PG_UNIT" Restart)
  if [[ "$restart" == always ]]; then ok "库的进程没了会被拉起（Restart=always）"; else red "$PG_UNIT 是 Restart=$restart，进程没了就一直躺着"; fi
  version=$(dpkg-query -W -f '${Version}' "postgresql-$PG_MAJOR" 2>/dev/null) || version=""
  if [[ "$version" == *pgdg* || -e /etc/apt/sources.list.d/pgdg.sources ]]; then
    red "postgresql-$PG_MAJOR $version 是从 PGDG 源装的：吃不到 Ubuntu 的自动安全更新"
  else
    ok "postgresql-$PG_MAJOR $version（Ubuntu 自带的源）"
  fi
  if temporal_login_ok; then ok "temporal 角色用口令登得上"; else red "temporal 角色用 $TEMPORAL_ENV 里的口令登不上"; fi
}

readback_temporal() {
  local main port pids bad=0 health desc ttl state
  if [[ "$(systemctl is-active fleet-temporal.service 2>/dev/null)" != active ]]; then
    red "fleet-temporal 没在跑"
    return 0
  fi
  main=$(unit_prop fleet-temporal.service MainPID)
  ok "fleet-temporal 在跑（pid $main，累计自动重启 $(unit_prop fleet-temporal.service NRestarts) 次）"
  for port in "${TEMPORAL_PORTS[@]}"; do
    pids=$(port_pids tcp "$port")
    if [[ " $pids" != *" $main "* ]]; then
      red "端口 $port 不是 fleet-temporal 在听（在听的：${pids:-没人}）"
      bad=1
    elif [[ "$(ss -Hltn "sport = :$port" | awk '{ print $4 }' | sort -u | tr '\n' ' ')" != "127.0.0.1:$port " ]]; then
      red "端口 $port 没有只绑 127.0.0.1"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "端口 ${TEMPORAL_PORTS[*]} 都由它在 127.0.0.1 上听"; fi
  health=$(tcli operator cluster health 2>/dev/null) || health=""
  if [[ "$health" == *SERVING* ]]; then ok "fleet-temporal operator cluster health：SERVING"; else red "集群健康检查没过：「$health」"; fi
  desc=$(tcli operator namespace describe --namespace "$NAMESPACE" -o json 2>/dev/null) || desc=""
  ttl=$(json_get "$desc" config.workflowExecutionRetentionTtl)
  state=$(json_get "$desc" namespaceInfo.state)
  if [[ "$ttl" == "$((RETENTION_HOURS * 3600))s" ]]; then
    ok "命名空间 $NAMESPACE：$state，保留 $ttl"
  else
    red "命名空间 $NAMESPACE 读回「${state:-读不到}」，保留期「${ttl:-读不到}」，应为 $((RETENTION_HOURS * 3600))s"
  fi
}

readback_slice() {
  local props
  if [[ "$(systemctl is-active fleet-agents.slice 2>/dev/null)" != active ]]; then
    red "fleet-agents.slice 没在"
    return 0
  fi
  props=$(systemctl show fleet-agents.slice -p CPUAccounting,MemoryAccounting,TasksAccounting,IOAccounting,MemoryHigh,MemoryMax,TasksMax,CPUQuotaPerSecUSec |
    sort | tr '\n' ' ')
  # MemoryHigh=10645143552（10152M）、MemoryMax=11182014464（10664M）：deploy/france/fleet-agents.slice 里写的数值，
  # 和 packages/engine/src/limits.ts 的 SLICE_MEMORY_HIGH_MB / SLICE_MEMORY_MAX_MB 是同一份推导（改一处两处都要改）。
  if [[ "$props" == "CPUAccounting=yes CPUQuotaPerSecUSec=infinity IOAccounting=yes MemoryAccounting=yes MemoryHigh=10645143552 MemoryMax=11182014464 TasksAccounting=yes TasksMax=infinity " ]]; then
    ok "fleet-agents.slice：记账全开，总量上限 MemoryHigh=10152M MemoryMax=10664M"
  else
    red "fleet-agents.slice 的设置不对：$props"
  fi
}

readback_pnpm() {
  local want have
  want=$(pnpm_want)
  have=$(pnpm_have)
  if [[ "$have" == "${want#pnpm@}" ]]; then ok "fleet 用户的 pnpm 是 $have"; else red "fleet 用户的 pnpm 是「$have」，应为 ${want#pnpm@}"; fi
  readback_session_pnpm "${want#pnpm@}"
}

# 照引擎起会话的路子起一条命令：fleet 经 sudo 调 fleet-agent-scope，引擎给的 PATH 改名 FLEET_SESSION_PATH 交过去
# （packages/adapters 的 scopeLaunch），帮手脚本在它最后接上会话用户的 ~/.local/bin，再降成会话用户跑
# shellcheck disable=SC2317,SC2329 # 当跑法交给 check_session_pnpm，由它间接调（CI 上的旧版 shellcheck 报的是 2317）
session_scope_run() { # 会话 PATH 命令…
  local path=$1
  shift
  as_user fleet env FLEET_SESSION_PATH="$path" /usr/bin/sudo -n "$AGENT_SCOPE_BIN" run "readback-pnpm-$$" \
    --user "${SESSION_USERS[0]}" --memory-max 1G --tasks-max 64 -- "$@"
}

# AI 会话用的 pnpm：装着的和装的时候一样（归 root），引擎给会话的那条 PATH 上先找到的就是它、版本是钉的那一版。
# 那条 PATH 从在跑的引擎进程里读（lib/session-pnpm.sh 的 engine_session_path）；引擎没在跑读不到，记待配
readback_session_pnpm() { # 仓根 package.json 钉的版本
  local want=$1
  if [[ "$want" != "$PNPM_VERSION" ]]; then
    red "仓根 package.json 钉的 pnpm 是 $want，france.sh 顶部钉的是 $PNPM_VERSION：两处一起改，再跑一遍 france.sh"
    return 0
  fi
  if session_pnpm_intact "$PNPM_ROOT/$PNPM_VERSION" "$PNPM_INTEGRITY"; then
    ok "会话用的 pnpm $PNPM_VERSION 装在 $PNPM_ROOT/$PNPM_VERSION，文件和装的时候一样"
  else
    red "$PNPM_ROOT/$PNPM_VERSION 没装、没装全，或文件和装的时候对不上：跑一遍 france.sh 重装"
  fi
  if ! engine_session_path "$(unit_prop fleet-engine.service MainPID)"; then
    pending "引擎给会话的 PATH 上找不找得到 pnpm 没查：$SESSION_PATH_WHY"
    return 0
  fi
  check_session_pnpm "$PNPM_VERSION" "$PNPM_BIN" "引擎给会话的 PATH（$SESSION_PATH，最后再接会话用户的 ~/.local/bin）" \
    session_scope_run "$SESSION_PATH"
}

# 会话用户的 cursor-agent：以他的身份照引擎的找法跑 --version，没装、跑不成都判红（lib/cursor-agent.sh）；
# 他家里的 Cursor API 密钥只看在不在、属主、权限 600、非空，不读值：还没放记待配，放了不对判红（lib/cursor-key.sh）。
# 密钥 Cursor 认不认不在这里查：路由探针真起一次会话判（docs/ops.md 第五节）
readback_cursor_agent() {
  local u
  for u in "${SESSION_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，cursor-agent 和它的密钥没查"
      continue
    fi
    check_cursor_agent "$u" "$(cursor_versions_dir "$u")"
    check_cursor_key "$u" "$(cursor_key_file "$u")"
  done
}

# 会话用户的 grok：以他的身份照引擎的判法跑 --version，没装、跑不成都判红（lib/grok.sh）；他家里的登录态只看在不在、属主、
# 权限 600、非空，不读内容：还没登录记待配，在却不对判红。grok 认不认不在这里查：路由探针真起一次会话判（docs/ops.md 第五节）
readback_grok() {
  local u
  for u in "${SESSION_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，grok 和它的登录态没查"
      continue
    fi
    check_grok "$u" "$(grok_bin "$u")"
    check_grok_login "$u" "$(grok_auth_file "$u")" "$(grok_bin "$u")"
  done
}

# 会话用户自己的 Mirasim：服务端本体（装、登录要创始人或帅位在自己电脑上做，docs/ops.md 第五节「会话用户的
# Mirasim」）这一步不装，只看有没有；常驻单元（fleet-mirasim-session.service）是 setup_mirasim_session 装的，
# 这里核对它活没活、/api/health 通不通（lib/mirasim.sh 的 check_mirasim_session_unit）；令牌恰好一份仍由
# check_mirasim 认（引擎连哪个端口看的是这份令牌，不是这个单元）。
readback_mirasim() {
  local u
  for u in "${SESSION_USERS[@]}"; do
    if ! id "$u" >/dev/null 2>&1; then
      pending "$u 这个用户还没有，Mirasim 服务没查"
      continue
    fi
    check_mirasim_session_unit "$u" fleet-mirasim-session.service "$MIRASIM_SESSION_PORT"
    check_mirasim_session_unit_file "$u" "$MIRASIM_SESSION_UNIT_FILE" "$DEPLOY_DIR/france/fleet-mirasim-session.service" "$MIRASIM_SESSION_PORT"
    check_mirasim "$u"
  done
}

# 自动档只读回常驻单元这一层（活没活、health、单元文件内容对不对）；令牌 check_mirasim 是创始人手装服务端的事，不归自动档
readback_mirasim_session_unit() {
  local u=${SESSION_USERS[0]}
  if ! id "$u" >/dev/null 2>&1; then
    pending "$u 这个用户还没有，Mirasim 常驻单元没查"
    return 0
  fi
  check_mirasim_session_unit "$u" fleet-mirasim-session.service "$MIRASIM_SESSION_PORT"
  check_mirasim_session_unit_file "$u" "$MIRASIM_SESSION_UNIT_FILE" "$DEPLOY_DIR/france/fleet-mirasim-session.service" "$MIRASIM_SESSION_PORT"
}

readback_wireguard() {
  local latest
  if [[ -z "$FLEET_WG_HK_PUBLIC_KEY" || -z "$FLEET_WG_HK_ENDPOINT" ]]; then
    pending "WireGuard 待配：照香港 hk.sh 打印的提示，把香港公钥和 <香港公网IP>:<端口> 填进 $ENV_FILE，再跑一遍（法国公钥：$(wg pubkey <"/etc/wireguard/$WG_IF.key" 2>/dev/null || echo 读不到)）"
    return 0
  fi
  if [[ "$(systemctl is-active "wg-quick@$WG_IF.service" 2>/dev/null)" != active ]]; then
    red "wg-quick@$WG_IF 没在跑"
    return 0
  fi
  if ping -c 3 -W 2 -q "$WG_HK_ADDR" >/dev/null 2>&1; then
    ok "ping $WG_HK_ADDR（香港）通"
    return 0
  fi
  latest=$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{ print $2 }') || latest=""
  if [[ -z "$latest" || "$latest" == 0 ]]; then
    pending "隧道还没握上手：香港 hk.env 填了法国公钥、重跑过 hk.sh 了吗？$ENV_FILE 里的端口是 hk.sh 打印的那个吗（香港上游只放行少数 UDP 端口，见 docs/ops.md）？"
  else
    red "隧道握过手（$(($(date +%s) - latest)) 秒前），但 ping $WG_HK_ADDR 不通"
  fi
}

# 审计 P01：root 在服务用户的目录里留下的文件，之后会以各种不像权限问题的样子出错
readback_service_home() {
  local found
  # 不接 head：find 被管道截断会让整条命令算失败，结果就被当成「没找到」
  local homes=(/home/fleet /var/lib/fleet-dao /var/log/fleet-dao "$PILOT_HOME") u
  for u in "${SESSION_USERS[@]}"; do homes+=("/home/$u"); done
  found=$(find "${homes[@]}" -user root 2>/dev/null || true)
  if [[ -n "$found" ]]; then
    red "fleet、会话用户或 $PILOT_USER 的目录里有 $(wc -l <<<"$found") 个 root 属主的文件，比如：$(head -3 <<<"$found" | tr '\n' ' ')"
  else
    ok "fleet、会话用户和 $PILOT_USER 的目录里没有 root 属主的文件"
  fi
}

# 自动档（--auto-tier）：自动发布每发完一版以 root 顺带跑。只放不碰防火墙、sudoers、用户、机器上钥匙和环境文件的步骤，
# 每一步都幂等（内容一样就什么都不动）。前提是整套装过一遍了（会话用户、/srv 下的目录都在）；没装过的机器这里判红。
setup_auto_tier() {
  setup_slice
  retire_old_units
  setup_auto_release
  # Mirasim 常驻单元（#1274：只在整套装机时装，后来改的单元文件一直落不到法国）：它只是个 systemd 单元，
  # 不碰权限和钥匙；服务端本体不在就记待配、不装（待配不算红）；单元文件内容真变了才重启，会话断开只此一次。
  # 放最后，它出问题不挡前面自动发布单元的装。
  setup_mirasim_session
}

# 自动档只读回它装的那几样（整套的读回里别的项、状态文件上一轮的结果不归这里管，免得别的毛病让这一档每个提交都判红）
readback_auto_tier() {
  step "读回（自动档）"
  readback_slice
  readback_retired_units
  local u f
  if [[ "$(systemctl is-active fleet-auto-release.timer 2>/dev/null)" != active ]]; then red "fleet-auto-release.timer 没在跑"; fi
  for f in "${AUTO_RELEASE_FILES[@]}"; do
    if ! cmp -s -- "$AUTO_RELEASE_LIB/$f" "$DEPLOY_DIR/france/auto-release/$f"; then
      red "$AUTO_RELEASE_LIB/$f 和仓里的不一样（或没装）"
    fi
  done
  for u in "${AUTO_RELEASE_UNITS[@]}"; do
    if ! cmp -s -- "/etc/systemd/system/$u" "$DEPLOY_DIR/france/$u"; then red "/etc/systemd/system/$u 和仓里的不一样（或没装）"; fi
  done
  readback_mirasim_session_unit
}

auto_tier_main() {
  step "自动档（不碰防火墙、sudoers、用户、钥匙；整套装机见不带参数的 france.sh）"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0 --auto-tier" >&2
    exit 64
  fi
  if [[ ! -d "$RELEASES_DIR" ]] || ! id fleet >/dev/null 2>&1; then
    red "这台机器还没整套装过（没有 $RELEASES_DIR 或用户 fleet）：先由人以 root 跑一遍不带参数的 bash $0"
    finish
  fi
  setup_auto_tier
  readback_auto_tier
  finish
}

main() {
  local before=""
  if ((AUTO_TIER)); then auto_tier_main; fi
  preflight
  if ((CHECK_ONLY == 0)); then
    before=$(snapshot_others)
    setup_identity
    setup_pilot
    setup_node_cache
    load_config
    setup_packages
    setup_wireguard
    setup_postgres
    setup_temporal
    setup_slice
    setup_sudoers
    setup_firewall
    setup_pnpm
    setup_session_pnpm
    setup_cursor_agent
    setup_grok
    setup_mirasim_session
    setup_app_config
    setup_web_upload
    retire_old_units
    setup_auto_release
    setup_release_request
    setup_agent_rules
    setup_cli_tools
  else
    load_config
  fi
  readback
  self_check_root_exec
  if ((CHECK_ONLY == 0)); then compare_others "$before"; fi
  if ((CHECK_ONLY == 0 && ${#REDS[@]} == 0)); then record_applied; fi
  finish
}

main "$@"
