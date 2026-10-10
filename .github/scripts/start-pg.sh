#!/usr/bin/env bash
# 起 CI 用的 postgres:16-alpine 容器：多个镜像源依次试，每源最多 3 次、退避 5/15/30 秒（#1664）。
# 用法：start-pg.sh <容器名> <日志文件>
# 容器的端口、环境变量由 PG_ENV（空格隔开的 KEY=VALUE 列表）给；日志文件只放拉镜像的报错和 docker run 输出。
set -euo pipefail

name=${1:?缺容器名}
log=${2:?缺日志文件}
: "${PG_ENV:?缺 PG_ENV（空格隔开的 KEY=VALUE）}"

sources=(
  public.ecr.aws/docker/library/postgres:16-alpine
  mirror.gcr.io/library/postgres:16-alpine
)
backoffs=(5 15 30)

env_args=()
for kv in $PG_ENV; do env_args+=(-e "$kv"); done

: > "$log"
declare -A last_err
chosen=""
for src in "${sources[@]}"; do
  for attempt in 1 2 3; do
    if err=$(docker pull "$src" 2>&1); then
      chosen=$src
      break 2
    fi
    last_err[$src]=$err
    echo "拉 $src 第 $attempt 次失败" >> "$log"
    if [ "$attempt" -lt 3 ]; then sleep "${backoffs[$((attempt - 1))]}"; fi
  done
done

if [ -z "$chosen" ]; then
  for src in "${sources[@]}"; do
    echo "== $src 最后一次报错：" >> "$log"
    echo "${last_err[$src]:-（无）}" >> "$log"
  done
  cat "$log" >&2
  exit 1
fi

echo "用镜像 $chosen" >> "$log"
docker run -d --name "$name" -p 5432:5432 "${env_args[@]}" "$chosen" >> "$log" 2>&1
