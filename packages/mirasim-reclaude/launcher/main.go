// stdout 归 Mirasim 的 stream-json 协议；诊断只写 stderr 和不含凭据的日志。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var version = "2.0.0"
var sourceCommit = "development"
var sourceHash = "development"

func main() { os.Exit(run()) }

func run() int {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--fleet-mirasim-child" {
		return guardian()
	}
	if len(args) == 1 && args[0] == "--fleet-version" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"name": "fleet-mirasim-reclaude", "schema": 1, "version": version, "sourceCommit": sourceCommit, "sourceHash": sourceHash, "platform": runtime.GOOS, "arch": runtime.GOARCH})
		return 0
	}
	if len(args) == 1 && args[0] == "--fleet-doctor" {
		target, err := findReclaude()
		if err != nil {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "failed", "reason": "reclaude_target_missing"})
			return 1
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "ready", "target": target, "checks": "executable-present"})
		return 0
	}
	if err := protectProcess(); err != nil {
		return fail("process_protection", err)
	}
	target, err := findReclaude()
	if err != nil {
		return fail("target_missing", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail("home_unreadable", err)
	}
	ms := filepath.Join(home, ".mirasim")
	if h := os.Getenv("MIRASIM_HOME"); h != "" {
		ms = h
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail("workdir_unreadable", err)
	}
	cfg := configuration{target: target, args: args, env: os.Environ(), mirasimHome: ms, cwd: cwd}
	// Mirasim 把启动命令当 claude 本体：「--version」探版本、「update」升级都原样交给 reclaude，不在这里截。
	if flagValue(args, "--input-format") != "stream-json" {
		return runOnce(cfg)
	}
	if err := supervise(cfg); err != nil {
		return fail("session_failed", err)
	}
	return 0
}

func fail(code string, err error) int {
	logLine("error=" + code + " " + err.Error())
	fmt.Fprintln(os.Stderr, "mirasim-reclaude:", code, err)
	return 1
}

func findReclaude() (string, error) {
	if p := strings.TrimSpace(os.Getenv("RECLAUDE_MIRASIM_TARGET")); p != "" {
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			return "", fmt.Errorf("指定的 reclaude 不可执行")
		}
		self, _ := os.Executable()
		if sameFile(p, self) {
			return "", fmt.Errorf("reclaude 目标指向启动器自身")
		}
		return p, nil
	}
	self, _ := os.Executable()
	home, _ := os.UserHomeDir()
	for _, dir := range []string{filepath.Dir(self), filepath.Join(home, ".local", "bin"), filepath.Join(home, "AppData", "Local", "Programs", "reclaude", "bin")} {
		for _, name := range []string{"reclaude.exe", "reclaude"} {
			p := filepath.Join(dir, name)
			if st, err := os.Stat(p); err == nil && !st.IsDir() && !sameFile(p, self) {
				return p, nil
			}
		}
	}
	p, err := exec.LookPath("reclaude")
	if err != nil || sameFile(p, self) {
		return "", fmt.Errorf("找不到 reclaude，请先安装或指定 RECLAUDE_MIRASIM_TARGET")
	}
	return p, nil
}

func sameFile(a, b string) bool {
	x, e1 := os.Stat(a)
	y, e2 := os.Stat(b)
	return e1 == nil && e2 == nil && os.SameFile(x, y)
}

func logLine(message string) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return
	}
	dir = filepath.Join(dir, "reclaude-mirasim")
	if os.MkdirAll(dir, 0700) != nil {
		return
	}
	p := filepath.Join(dir, "launch.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(p, flags, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s pid=%d version=%s %s\n", time.Now().Format(time.RFC3339), os.Getpid(), version, message)
}
