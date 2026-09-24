#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 发布（在法国以 root 跑）：把主线上的一个提交装成一版 → 跑数据库迁移 → 切过去、按本机配置起应用服务 → 把驾驶舱静态文件
# 经隧道发到香港 → 健康检查；不过就自动退回上一版并报错。幂等：同一个提交跑第二遍什么都不变。
#   bash deploy/release.sh [<提交号>]            发布这个提交（不给就发主线最新）；只认主线上的提交
#   bash deploy/release.sh --rollback            退回上一版（上一个在用过、没被判过不健康、目录还在的版本）
#   bash deploy/release.sh --check               只读：在用哪版、有哪几版、服务与健康检查，不改任何东西
#   bash deploy/release.sh <提交号> --unmerged   发还没合进主线的提交（只用来合并前在真机上验；历史里会标出来）
# 每一版在 /srv/fleet-dao-releases/<提交号>，current 指着在用的那版；留最近 5 版。目录、单元、本机配置、怎么看、
# 怎么退：docs/ops.md 第九节。退出码同装机脚本：0 全绿，1 有红（含「没过健康检查、已退回」），2 没红但有待配。
set -Eeuo pipefail
umask 022

DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"

REPO_URL=https://github.com/thoerwink8/fleet-dao.git
RELEASES=${FLEET_RELEASES_DIR:-/srv/fleet-dao-releases} # 只有 deploy/test/release-flow.test.sh 会改它
CACHE=$RELEASES/.repo.git   # 取代码用的裸仓（root 的）
# 每切一次、每判一次记一行：时间 提交号 事件 [unmerged]。事件：release、rollback、auto-rollback（切过去）、
# unhealthy（健康检查没过）、recovered（判过不健康的在用版本后来又过了）
HISTORY=$RELEASES/.history
KEEP=5                      # 留几版：在用的、上一版，再加最近用过的
APP_UNITS=(fleet-engine fleet-api)
RELEASE_ENV=/etc/fleet-dao/release.env
UPLOAD_KEY=/etc/fleet-dao/web-upload.key
HK_KNOWN_HOSTS=/etc/fleet-dao/hk-known-hosts
HK_TUNNEL=10.99.0.1            # 香港在隧道上的地址：静态文件经它传，发完也经它核对（不依赖公网解析）
COCKPIT=10.99.0.2:8787         # 驾驶舱接口（api.env 的 FLEET_COCKPIT_LISTEN）
AGENT_API=127.0.0.1:8788       # fleet 命令接口（api.env 的 FLEET_AGENT_LISTEN）
TASK_QUEUE=fleet               # 引擎工人取活的任务队列（engine.env 的 FLEET_TASK_QUEUE）
# 迁移连本机库：unix socket + peer 认证（同 api.env；postgres.js 不认连接串里的 ?host=，主机走 PGHOST）
DB_ENV=(DATABASE_URL=postgres:///fleet PGHOST=/var/run/postgresql PGUSER=fleet)
SETTLE_SECONDS=10     # 服务起来后再看这么久：这段时间里退出过、重启过，就是没起稳
ENGINE_POLL_WAIT=90   # 引擎工人起来后要先打包工作流，才去任务队列取活

FLEET_SERVICES=""
FLEET_DOMAIN=""
SHA=""
ON_MAIN=1
WEB_KIND=""

usage() {
  cat <<'EOF'
用法（法国，root）：
  bash deploy/release.sh [<提交号>]            发布（不给提交号就发主线最新）
  bash deploy/release.sh <提交号> --unmerged   发还没合进主线的提交（合并前在真机上验）
  bash deploy/release.sh --rollback            退回上一版
  bash deploy/release.sh --check               只读：看在用哪版、服务与健康
EOF
}

# ── 小零件 ──

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
has_service() { [[ " $FLEET_SERVICES " == *" $1 "* ]]; }
current_sha() {
  local s
  s=$(readlink -- "$RELEASES/current" 2>/dev/null) || return 0
  if is_sha "$s"; then printf '%s' "$s"; fi
}

# 上一版：历史里最近在用过、不是现在这版、最后一次事件不是「不健康」、目录还在的那一版
previous_sha() {
  local cur s
  cur=$(current_sha)
  if [[ ! -f "$HISTORY" ]]; then return 0; fi
  while read -r s; do
    if is_sha "$s" && [[ "$s" != "$cur" && -f "$RELEASES/$s/.fleet-release" ]]; then
      printf '%s' "$s"
      return 0
    fi
  done < <(awk '{ last[$2] = $3; if ($3 != "unhealthy") order[++n] = $2 }
    END { for (i = n; i >= 1; i--) if (last[order[i]] != "unhealthy" && !seen[order[i]]++) print order[i] }' "$HISTORY")
}

last_event() { # 提交号
  if [[ -f "$HISTORY" ]]; then awk -v s="$1" '$2 == s { e = $3 } END { printf "%s", e }' "$HISTORY"; fi
}

record() { # 提交号 事件
  local tag=""
  if [[ "$(marker_get "$1" on_main)" == 0 ]]; then tag=" unmerged"; fi
  printf '%s %s %s%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$tag" >>"$HISTORY"
}

marker_get() { # 提交号 键
  local line
  if [[ ! -f "$RELEASES/$1/.fleet-release" ]]; then return 0; fi
  while IFS= read -r line; do
    if [[ "$line" == "$2="* ]]; then printf '%s' "${line#*=}"; fi
  done <"$RELEASES/$1/.fleet-release"
}

# 以 fleet 身份、在给定目录里跑命令（环境清空，同 as_user）
as_fleet_in() { # 目录 命令…
  local dir=$1
  shift
  (cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet USER=fleet LOGNAME=fleet \
    PATH=/home/fleet/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@")
}

pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }
tcli() { env -i HOME=/root PATH=/usr/bin:/bin /usr/local/bin/fleet-temporal "$@"; }

# ── 前提 ──

preflight() {
  step "前提"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0" >&2
    exit 64
  fi
  if [[ ! -f /etc/fleet-dao/france.env || ! -f "$RELEASE_ENV" ]]; then
    red "没有 /etc/fleet-dao/france.env 或 $RELEASE_ENV：发布只在装过 deploy/france.sh 的法国机器上跑，先跑一遍它"
    return 1
  fi
  load_env "$RELEASE_ENV" FLEET_SERVICES FLEET_DOMAIN
  local s c
  for s in $FLEET_SERVICES; do
    if [[ " ${APP_UNITS[*]} " != *" $s "* ]]; then
      red "$RELEASE_ENV 的 FLEET_SERVICES 里有不认识的服务「$s」（认识的：${APP_UNITS[*]}）"
      return 1
    fi
  done
  if [[ ! "$FLEET_DOMAIN" =~ ^[a-z0-9.-]+$ ]]; then
    red "$RELEASE_ENV 的 FLEET_DOMAIN 应为驾驶舱的域名，现在是「$FLEET_DOMAIN」"
    return 1
  fi
  for c in git rsync curl flock runuser psql /usr/bin/node /usr/local/bin/fleet-temporal; do
    if ! command -v "$c" >/dev/null; then
      red "缺 $c：先跑一遍 deploy/france.sh"
      return 1
    fi
  done
  ok "本机启用的服务：${FLEET_SERVICES:-（无：只发代码、跑迁移、发静态页）}；域名 $FLEET_DOMAIN"
}

# 同一时间只许一个发布在跑
take_lock() {
  exec 9>>"$RELEASES/.lock"
  if ! flock -n 9; then
    red "另一个发布正在跑（$RELEASES/.lock）"
    return 1
  fi
}

# ── 取代码、构建 ──

fetch_code() { # 要发的提交（空 = 主线最新）
  local target=$1 out
  step "取代码"
  if [[ ! -d "$CACHE" ]]; then
    git init -q --bare "$CACHE"
    git -C "$CACHE" remote add origin "$REPO_URL"
    echo "  · 建了取代码用的裸仓 $CACHE"
  fi
  if ! out=$(timeout 300 git -C "$CACHE" fetch -q --prune origin '+refs/heads/main:refs/remotes/origin/main' 2>&1); then
    red "从 $REPO_URL 取主线失败：$(tail -2 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if [[ -z "$target" ]]; then
    SHA=$(git -C "$CACHE" rev-parse refs/remotes/origin/main)
  else
    if ! git -C "$CACHE" cat-file -e "$target^{commit}" 2>/dev/null; then
      if ((${#target} < 40)); then
        red "本地没有 $target，短提交号又没法向 GitHub 要：给完整的 40 位提交号"
        return 1
      fi
      if ! out=$(timeout 300 git -C "$CACHE" fetch -q origin "$target" 2>&1); then
        red "向 GitHub 要不到提交 $target：$(tail -2 <<<"$out" | tr '\n' ' ')"
        return 1
      fi
    fi
    if ! SHA=$(git -C "$CACHE" rev-parse -q --verify "$target^{commit}"); then
      red "认不出提交 $target"
      return 1
    fi
  fi
  if git -C "$CACHE" merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then
    ON_MAIN=1
    ok "提交 ${SHA:0:12}（在主线上）：$(git -C "$CACHE" log -1 --format=%s "$SHA")"
  elif ((UNMERGED)); then
    ON_MAIN=0
    echo "  ! 提交 ${SHA:0:12} 不在主线上（--unmerged：只用来合并前在真机上验）：$(git -C "$CACHE" log -1 --format=%s "$SHA")"
  else
    red "提交 ${SHA:0:12} 不在主线上：只发主线上的提交（合并前要在真机上验，加 --unmerged）"
    return 1
  fi
}

# 装成一版：fleet 在临时目录里装依赖、构建前端（第三方代码不以 root 跑）；构建完整个目录换成 root 的、fleet 只读，
# 再原子地挪到 <提交号>。root 要照着办事的东西（单元文件、完成标记）在换属主之后才由 root 从 git 里取、写，fleet 碰不到。
build_release() { # 提交号
  local sha=$1 dir=$RELEASES/$1 stage=$RELEASES/.build-$1 log u odd
  step "构建 ${sha:0:12}"
  if [[ -f "$dir/.fleet-release" ]]; then
    ok "已构建（$dir，$(marker_get "$sha" built) 建的）"
    return 0
  fi
  if [[ -e "$dir" || -L "$dir" ]]; then
    red "$dir 在但没有构建完成的标记——不是发布脚本放的？停下等人看"
    return 1
  fi
  rm -rf -- "$stage"
  install -d -o fleet -g fleet -m 750 "$stage"
  log=$stage/.fleet-build.log
  if ! git -C "$CACHE" archive --format=tar "$sha" | as_fleet_in "$stage" tar -x -f -; then
    red "把 ${sha:0:12} 的代码解到 $stage 失败"
    return 1
  fi
  echo "  装依赖（pnpm install --frozen-lockfile，日志 $dir/.fleet-build.log）"
  # copy：依赖整份拷进这一版，不和 fleet 的 pnpm 仓库共用文件（共用的话，换属主会连带改掉仓库里的文件）
  if ! as_fleet_in "$stage" pnpm install --frozen-lockfile --package-import-method=copy --reporter=append-only >>"$log" 2>&1; then
    red "pnpm install --frozen-lockfile 失败（没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
    return 1
  fi
  build_web "$stage" "$log"
  # 换属主：之后 fleet 只读。-h：符号链接只改它自己，不跟过去改别处
  chown -R -h root:root -- "$stage"
  chmod -R u+rwX,go+rX,go-w -- "$stage"
  # 静态文件要原样发到香港：不许有符号链接和特殊文件（rsync 不跟链接，也防借链接把本机文件带出去）
  odd=$(find "$stage/web" ! -type f ! -type d -print -quit)
  if [[ -n "$odd" ]]; then
    red "静态文件里有符号链接或特殊文件（${odd#"$stage"/}），不发"
    return 1
  fi
  printf '{"commit":"%s"}\n' "$sha" >"$stage/web/release.json"
  # 单元文件从 git 里取（不用构建目录里那份：构建时它归 fleet，root 要照着它起服务）
  rm -rf -- "$stage/.units"
  install -d -m 755 "$stage/.units"
  for u in "${APP_UNITS[@]}"; do
    if git -C "$CACHE" cat-file -e "$sha:deploy/france/$u.service" 2>/dev/null; then
      git -C "$CACHE" show "$sha:deploy/france/$u.service" >"$stage/.units/$u.service"
    fi
  done
  rm -f -- "$stage/.fleet-release"
  printf 'commit=%s\nbuilt=%s\non_main=%s\nweb=%s\n' "$sha" "$(date -u +%FT%TZ)" "$ON_MAIN" "$WEB_KIND" >"$stage/.fleet-release"
  mv -T -- "$stage" "$dir"
  changed "构建 ${sha:0:12}：依赖装好，静态文件是$WEB_KIND"
}

# 驾驶舱静态文件：有 packages/web 就构建它，没有就用占位页；健康页放在 /health/，版本标记 release.json 由 root 写
build_web() { # 临时目录 日志
  local stage=$1 log=$2
  if [[ -f "$stage/packages/web/package.json" ]] &&
    /usr/bin/node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts?.build ? 0 : 1)' \
      "$stage/packages/web/package.json"; then
    echo "  构建驾驶舱前端（packages/web）"
    if ! as_fleet_in "$stage" pnpm --filter ./packages/web run build >>"$log" 2>&1; then
      red "驾驶舱前端构建失败（没切版本）：$(tail -5 "$log" | tr '\n' ' ')"
      return 1
    fi
    if [[ ! -f "$stage/packages/web/dist/client/index.html" ]]; then
      red "驾驶舱前端构建完没有 packages/web/dist/client/index.html"
      return 1
    fi
    as_fleet_in "$stage" cp -R packages/web/dist/client web
    WEB_KIND="驾驶舱前端（packages/web）+ 健康页"
  else
    as_fleet_in "$stage" mkdir web
    as_fleet_in "$stage" cp deploy/hk/placeholder.html web/index.html
    WEB_KIND="占位页（这一版还没有驾驶舱前端）+ 健康页"
  fi
  if [[ -e "$stage/web/health" ]]; then
    red "驾驶舱前端自己带了 /health/，和健康页撞了"
    return 1
  fi
  as_fleet_in "$stage" cp -R deploy/web/health web/health
  if [[ ! -f "$stage/web/index.html" || ! -f "$stage/web/health/index.html" || ! -f "$stage/web/health/health.js" ]]; then
    red "静态文件不全：要有 index.html、health/index.html、health/health.js"
    return 1
  fi
}

# ── 迁移 ──

# 已跑过几个迁移。还没跑过（drizzle 的记账表还不在）是 0；读不到就失败，不当成 0
migrations_applied() {
  local exists
  exists=$(pg_admin -d fleet -c "select to_regclass('drizzle.__drizzle_migrations') is not null") || return 1
  if [[ "$exists" == f ]]; then
    echo 0
    return 0
  fi
  pg_admin -d fleet -c 'select count(*) from drizzle.__drizzle_migrations'
}

# 迁移在切版本之前跑、只进不退：新迁移要写成旧代码照样能跑（先加后删），退回上一版时不撤迁移
migrate() { # 提交号
  local dir=$RELEASES/$1 before after out
  step "数据库迁移"
  if [[ ! -f "$dir/packages/db/src/bin/migrate.ts" ]]; then
    ok "这一版没有数据库迁移"
    return 0
  fi
  if ! before=$(migrations_applied); then
    red "读不到库 fleet 里已跑过的迁移"
    return 1
  fi
  if ! out=$(cd -- "$dir" && runuser -u fleet -- env -i HOME=/home/fleet PATH=/usr/bin:/bin LANG=C.UTF-8 "${DB_ENV[@]}" \
    /usr/bin/node packages/db/src/bin/migrate.ts 2>&1); then
    red "迁移失败（没切版本，在用的那版不受影响）：$(tail -5 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if ! after=$(migrations_applied); then
    red "迁移跑完了，但读不到库 fleet 里已跑过的迁移"
    return 1
  fi
  if [[ "$before" == "$after" ]]; then
    ok "没有新迁移（库 fleet 已跑过 $after 个）"
  else
    changed "跑了新迁移：库 fleet 已跑过的从 $before 个到 $after 个"
  fi
}

# ── 切版本 ──

# 单元读的环境文件在它这次起来之后改过没有（改了 engine.env、api.env 要重启才生效）
env_changed_since_start() { # 单元
  local start f
  start=$(systemctl show -p ExecMainStartTimestamp --timestamp=unix --value "$1" 2>/dev/null) || start=""
  start=${start#@}
  if [[ ! "$start" =~ ^[0-9]+$ ]]; then return 1; fi
  while read -r f _; do
    if [[ -f "$f" ]] && (($(stat -c %Y -- "$f") > start)); then return 0; fi
  done < <(systemctl show -p EnvironmentFiles --value "$1" 2>/dev/null)
  return 1
}

# 切到这一版：current 指过去；本机启用的服务装上这一版的单元、起来（换了代码、单元或环境文件就重启）；
# 没启用的停掉撤掉；静态文件发到香港。哪一步不成就记红、返回 1，退不退由调用方定。
activate() { # 提交号 事件（release / rollback / auto-rollback）
  local sha=$1 how=$2 dir=$RELEASES/$1 u reload=0 code=0 restart unit_file
  local -A fresh=()
  if [[ "$(readlink -- "$RELEASES/current" 2>/dev/null)" != "$sha" ]]; then
    if ! ln -sfn -- "$sha" "$RELEASES/.current.new" || ! mv -Tf -- "$RELEASES/.current.new" "$RELEASES/current"; then
      red "把 current 切到 ${sha:0:12} 失败"
      return 1
    fi
    record "$sha" "$how"
    changed "current → ${sha:0:12}（$how）"
    code=1
  else
    ok "current 已是 ${sha:0:12}"
  fi
  for u in "${APP_UNITS[@]}"; do
    unit_file=/etc/systemd/system/$u.service
    if has_service "$u"; then
      if [[ ! -f "$dir/.units/$u.service" ]]; then
        red "这一版没有 deploy/france/$u.service，起不了 $u"
        return 1
      fi
      put_file "$unit_file" root:root 644 "$(<"$dir/.units/$u.service")"
      fresh[$u]=$WROTE
      if ((WROTE)); then reload=1; fi
    elif [[ -e "$unit_file" ]]; then
      if ! systemctl disable --now --quiet "$u.service"; then
        red "停不掉 $u（本机 release.env 没启用它）"
        return 1
      fi
      rm -f -- "$unit_file"
      reload=1
      changed "停用并撤掉 $u（本机 release.env 没启用它）"
    fi
  done
  if ((reload)) && ! systemctl daemon-reload; then
    red "systemctl daemon-reload 失败"
    return 1
  fi
  for u in $FLEET_SERVICES; do
    restart=0
    if ((code)) || [[ "${fresh[$u]:-0}" == 1 ]] || env_changed_since_start "$u.service"; then restart=1; fi
    if ! ensure_unit_running "$u.service" "$restart"; then return 1; fi
  done
  sync_web "$sha"
}

# 静态文件经隧道发到香港（那头 rrsync 把路径限死在 /srv/fleet-dao-web、只许写）。先落临时名、最后一起换上，
# 旧的最后删：换的那一下之前浏览器拿到的都是整套旧页面。属主是香港的 root
sync_web() { # 提交号
  local out
  if ! out=$(rsync -rpt -O --delete-after --delay-updates --itemize-changes \
    -e "$(web_upload_ssh "$UPLOAD_KEY" "$HK_KNOWN_HOSTS")" -- "$RELEASES/$1/web/" "root@$HK_TUNNEL:/" 2>&1); then
    red "把静态文件发到香港没成：$(tail -3 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if [[ -n "$out" ]]; then
    changed "香港的静态文件换成 ${1:0:12} 那版（$(wc -l <<<"$out") 处变化）"
  else
    ok "香港的静态文件已是 ${1:0:12} 那版"
  fi
}

# ── 健康检查 ──

# 健康报告（packages/api 的 health.ts）：{ ok, checks: { 名: { ok, code?, message? } } }。
# 认得出就逐项打印「名<TAB>ok|bad<TAB>原因」，认不出退出 1。故意不复用后端和健康页的解析代码：自己查自己查不出错
# shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
report_items() {
  printf '%s' "$1" | /usr/bin/node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let r;
      try { r = JSON.parse(s); } catch { process.exit(1); }
      const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
      if (!isObj(r) || typeof r.ok !== "boolean" || !isObj(r.checks)) process.exit(1);
      for (const [k, v] of Object.entries(r.checks)) {
        const good = isObj(v) && v.ok === true;
        const why = good ? "" : isObj(v) && typeof v.message === "string" && v.message ? v.message : "没给原因";
        console.log(`${k}\t${good ? "ok" : "bad"}\t${why.replace(/\s+/g, " ")}`);
      }
    });'
}

# 驾驶舱接口上的 /healthz：打印「状态码<TAB>正文」；连不上返回 1
api_healthz() {
  local out
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' "http://$COCKPIT/healthz" 2>&1) || return 1
  printf '%s\t%s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# 切之前后端的健康报告（后端没在跑就空）：切之后逐项对比，之前好的变坏了才算这一版的错
api_report_before() {
  local got
  if ! has_service fleet-api || [[ "$(systemctl is-active fleet-api.service 2>/dev/null)" != active ]]; then return 0; fi
  got=$(api_healthz) || return 0
  report_items "${got#*$'\t'}" 2>/dev/null || true
}

# 服务起来后再看一会儿：还在跑、主进程没换、没被重启过，才算起稳了
settle_services() {
  local u bad=0
  local -A pid=() restarts=()
  for u in $FLEET_SERVICES; do
    pid[$u]=$(unit_prop "$u.service" MainPID)
    restarts[$u]=$(unit_prop "$u.service" NRestarts)
  done
  sleep "$SETTLE_SECONDS"
  for u in $FLEET_SERVICES; do
    if [[ "$(systemctl is-active "$u.service" 2>/dev/null)" != active || "$(unit_prop "$u.service" MainPID)" != "${pid[$u]}" ||
      "$(unit_prop "$u.service" NRestarts)" != "${restarts[$u]}" ]]; then
      red "$u 起来后没稳住（${SETTLE_SECONDS} 秒里退出或重启过，累计重启 $(unit_prop "$u.service" NRestarts) 次）：journalctl -u $u -n 50"
      bad=1
    else
      ok "$u 起稳了（pid ${pid[$u]}，${SETTLE_SECONDS} 秒没退出）"
    fi
  done
  return "$bad"
}

check_api() { # 切之前的逐项结果
  local before=$1 got code body items k st why was bad=0
  if ! got=$(api_healthz); then
    red "fleet-api：驾驶舱接口 http://$COCKPIT/healthz 连不上"
    return 1
  fi
  code=${got%%$'\t'*}
  body=${got#*$'\t'}
  if [[ "$code" != 200 && "$code" != 503 ]] || ! items=$(report_items "$body"); then
    red "fleet-api：/healthz 回的不是健康报告（HTTP $code）"
    return 1
  fi
  ok "fleet-api：驾驶舱接口 $COCKPIT 在答健康报告（HTTP $code）"
  while IFS=$'\t' read -r k st why; do
    if [[ -z "$k" ]]; then continue; fi
    was=$(awk -F '\t' -v k="$k" '$1 == k { print $2 }' <<<"$before")
    if [[ "$st" == ok ]]; then
      ok "后端报 $k 好"
    elif [[ "$was" == ok ]]; then
      red "fleet-api：$k 切之前是好的，换了这一版不好了：$why"
      bad=1
    else
      pending "后端报 $k 不好：$why（切之前就不好或第一次起，不算这一版的错，不退回）"
    fi
  done <<<"$items"
  if ! timeout 5 bash -c "exec 3<>/dev/tcp/${AGENT_API%:*}/${AGENT_API#*:}" 2>/dev/null; then
    red "fleet-api：fleet 命令接口 $AGENT_API 连不上"
    bad=1
  else
    ok "fleet-api：fleet 命令接口 $AGENT_API 在听"
  fi
  return "$bad"
}

# 引擎工人：任务队列上有它（身份是「进程号@主机名」）在取工作流任务和活动任务
check_engine() {
  local pid json i
  pid=$(unit_prop fleet-engine.service MainPID)
  for ((i = 0; i < ENGINE_POLL_WAIT; i += 3)); do
    json=$(tcli task-queue describe --task-queue "$TASK_QUEUE" -o json 2>/dev/null) || json=""
    if printf '%s' "$json" | /usr/bin/node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let r; try { r = JSON.parse(s); } catch { process.exit(1); }
        const mine = (r.pollers || []).filter((p) => typeof p.identity === "string" && p.identity.startsWith(process.argv[1]));
        const types = new Set(mine.map((p) => p.taskQueueType));
        process.exit(types.has("workflow") && types.has("activity") ? 0 : 1);
      });' "$pid@"; then
      ok "fleet-engine：引擎工人（pid $pid）在任务队列 $TASK_QUEUE 上取工作流任务和活动任务"
      return 0
    fi
    sleep 3
  done
  red "fleet-engine：引擎工人（pid $pid）${ENGINE_POLL_WAIT} 秒还没到任务队列 $TASK_QUEUE 取活：journalctl -u fleet-engine -n 50"
  return 1
}

# 香港在发的是不是这一版：经隧道连香港的 nginx（证书照常按域名校验），读 release.json 与健康页
check_web() { # 提交号
  local body commit code
  if ! body=$(curl -sS --max-time 10 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/release.json" 2>&1); then
    red "从香港取不到 https://$FLEET_DOMAIN/release.json：$(tail -1 <<<"$body")"
    return 1
  fi
  commit=$(json_field "$body" commit)
  if [[ "$commit" != "$1" ]]; then
    red "香港在发的是「${commit:0:12}」，不是 ${1:0:12}"
    return 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/health/") || code=000
  if [[ "$code" != 200 ]]; then
    red "健康页 https://$FLEET_DOMAIN/health/ 返回「$code」"
    return 1
  fi
  ok "香港在发 ${1:0:12} 这版：首页与健康页 https://$FLEET_DOMAIN/health/ 都在"
}

json_field() { # JSON 键
  printf '%s' "$1" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const v = JSON.parse(s)[process.argv[1]]; if (typeof v === "string") process.stdout.write(v); } catch {}
    });' "$2"
}

# 健康页读的 /healthz 经香港转不转得到法国：不归发布管（香港的站点配置、隧道），不计入健康检查，只报出来
check_chain() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$FLEET_DOMAIN:443:$HK_TUNNEL" "https://$FLEET_DOMAIN/healthz") || code=000
  case $code in
  200) ok "健康页那条路通：香港 → 隧道 → 法国后端的 /healthz 回 200（全好）" ;;
  503) ok "健康页那条路通：香港 → 隧道 → 法国后端的 /healthz 回 503（有项不好，健康页会照实报红）" ;;
  502 | 504)
    if has_service fleet-api; then
      pending "香港转 /healthz 到法国后端没通（HTTP $code）：本机后端在跑，看香港 nginx 与隧道"
    else
      pending "健康页现在三项全红（香港转 /healthz 回 $code）：本机没启用 fleet-api（$RELEASE_ENV 的 FLEET_SERVICES）"
    fi
    ;;
  404) pending "香港还没转 /healthz（HTTP 404）：香港 git pull 后重跑 deploy/hk.sh" ;;
  *) pending "经香港取 /healthz 没取成（HTTP $code）" ;;
  esac
}

# 这一版健不健康：起了的服务起稳了、各自该通的通了、香港在发这一版。不过返回 1（原因已记成红）
health_gate() { # 提交号 切之前后端的逐项结果
  local sha=$1 before=${2:-} bad=0
  step "健康检查（${sha:0:12}）"
  if [[ -n "$FLEET_SERVICES" ]]; then
    settle_services || bad=1
  fi
  if has_service fleet-api; then check_api "$before" || bad=1; fi
  if has_service fleet-engine; then check_engine || bad=1; fi
  check_web "$sha" || bad=1
  check_chain
  return "$bad"
}

mark_unhealthy() { # 提交号
  record "$1" unhealthy
  echo "  · 历史里把 ${1:0:12} 记成不健康：以后 --rollback 不会退到它"
}

# ── 清旧版 ──

# 留 KEEP 版：在用的、上一版，再按最近用过的顺序补满；没用过的（构建了没切过去）按构建时间排在后面
prune() {
  local cur prev s d kept=() order=()
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -f "$HISTORY" ]]; then mapfile -t order < <(tac -- "$HISTORY" | awk '!seen[$2]++ { print $2 }'); fi
  while read -r _ d; do order+=("$d"); done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn)
  for s in "$cur" "$prev" "${order[@]}"; do
    if ! is_sha "$s" || [[ ! -d "$RELEASES/$s" ]] || [[ " ${kept[*]} " == *" $s "* ]]; then continue; fi
    if ((${#kept[@]} < KEEP)) || [[ "$s" == "$cur" || "$s" == "$prev" ]]; then kept+=("$s"); fi
  done
  for d in "$RELEASES"/*; do
    s=${d##*/}
    if ! is_sha "$s" || [[ -L "$d" || ! -d "$d" ]]; then continue; fi
    if [[ " ${kept[*]} " != *" $s "* ]]; then
      rm -rf -- "$d"
      changed "清掉旧版 ${s:0:12}（只留最近 $KEEP 版）"
    fi
  done
  # 上次没构建完留下的临时目录（发布有锁，这时不会有别的发布在用它们）
  for d in "$RELEASES"/.build-*; do
    if [[ -d "$d" ]]; then
      rm -rf -- "$d"
      changed "清掉没构建完的临时目录 ${d##*/}"
    fi
  done
}

# ── 三种用法 ──

do_release() { # 要发的提交（空 = 主线最新）
  local cur before=""
  fetch_code "$1"
  build_release "$SHA"
  cur=$(current_sha)
  migrate "$SHA"
  before=$(api_report_before)
  step "切到 ${SHA:0:12}（在用：${cur:+${cur:0:12}}${cur:-还没有}）"
  if activate "$SHA" release && health_gate "$SHA" "$before"; then
    # 之前判过不健康（比如那时本机配置没备齐）、这次过了：记回健康，它又能当退回的目标
    if [[ "$(last_event "$SHA")" == unhealthy ]]; then
      record "$SHA" recovered
      changed "历史里把 ${SHA:0:12} 记回健康（之前判过不健康，这次健康检查过了）"
    fi
    ok "发布完成：在用 ${SHA:0:12}"
  elif [[ -z "$cur" ]]; then
    mark_unhealthy "$SHA"
    red "${SHA:0:12} 没过健康检查；这是头一版，没有上一版可退"
  elif [[ "$cur" == "$SHA" ]]; then
    red "在用的就是 ${SHA:0:12}，它的健康检查没过（没换版本，不退）"
  else
    mark_unhealthy "$SHA"
    step "自动退回上一版 ${cur:0:12}"
    if activate "$cur" auto-rollback && health_gate "$cur" ""; then
      ok "已退回 ${cur:0:12}，健康检查过了"
    else
      mark_unhealthy "$cur"
      red "退回 ${cur:0:12} 之后健康检查也没过：要人来看"
    fi
    red "${SHA:0:12} 没过健康检查，已自动退回 ${cur:0:12}（原因见上面的红）"
  fi
  prune
}

do_rollback() {
  local cur prev
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -z "$prev" ]]; then
    red "没有可退的上一版（历史里没有别的在用过、没被判过不健康、目录还在的版本）"
    return 1
  fi
  step "退回 ${prev:0:12}（在用：${cur:+${cur:0:12}}${cur:-没有}）"
  if activate "$prev" rollback && health_gate "$prev" ""; then
    ok "已退回 ${prev:0:12}"
  else
    mark_unhealthy "$prev"
    red "退回 ${prev:0:12} 之后健康检查没过：要人来看"
  fi
}

do_check() {
  local cur prev d s
  step "版本"
  cur=$(current_sha)
  prev=$(previous_sha)
  if [[ -z "$cur" ]]; then
    pending "还没发布过（$RELEASES/current 不在）"
    return 0
  fi
  ok "在用 ${cur:0:12}（$(marker_get "$cur" built) 建的，静态文件：$(marker_get "$cur" web)）；上一版 ${prev:+${prev:0:12}}${prev:-没有}"
  for d in "$RELEASES"/*; do
    s=${d##*/}
    if is_sha "$s" && [[ -d "$d" && ! -L "$d" ]]; then echo "  · 留着的版本 ${s:0:12}（$(marker_get "$s" built) 建的）"; fi
  done
  if [[ -f "$HISTORY" ]]; then
    echo "  最近的切换："
    tail -5 -- "$HISTORY" | sed 's/^/    /'
  fi
  step "服务"
  for s in "${APP_UNITS[@]}"; do
    if has_service "$s"; then
      if [[ "$(systemctl is-active "$s.service" 2>/dev/null)" == active ]]; then
        ok "$s 在跑（pid $(unit_prop "$s.service" MainPID)，累计重启 $(unit_prop "$s.service" NRestarts) 次）"
      else
        red "$s 启用了但没在跑：journalctl -u $s -n 50"
      fi
    else
      echo "  · $s 本机没启用（$RELEASE_ENV 的 FLEET_SERVICES）"
    fi
  done
  health_gate "$cur" "" || true
}

main() {
  local mode=release target="" arg
  UNMERGED=0
  for arg in "$@"; do
    case $arg in
    --rollback) mode=rollback ;;
    --check) mode=check ;;
    --unmerged) UNMERGED=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 64
      ;;
    *)
      if [[ -n "$target" || ! "$arg" =~ ^[0-9a-f]{7,40}$ ]]; then
        usage >&2
        exit 64
      fi
      target=$arg
      ;;
    esac
  done
  if [[ "$mode" != release && (-n "$target" || "$UNMERGED" == 1) ]]; then
    usage >&2
    exit 64
  fi
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  preflight
  if [[ "$mode" == check ]]; then
    do_check
    finish
  fi
  ensure_dir "$RELEASES" root:root 755
  take_lock
  if [[ "$mode" == rollback ]]; then do_rollback; else do_release "$target"; fi
  finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
