//go:build !windows

package main

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Mirasim 正常回收空闲进程会发停止信号：优雅停掉执行体、退出 0、日志记 event=stopped，不记成会话失败。
func TestStopSignalStopsGracefullyAndExitsZero(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startApp(t, f, "XDG_CACHE_HOME="+cache)
	x := a.turn(t, "first")
	target := int(x["pid"].(float64))
	if err := a.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := waitEnded(t, a); err != nil {
		t.Fatalf("收到停止信号应退出 0：%v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for testProcessAlive(target) {
		if time.Now().After(deadline) {
			t.Fatal("停止后执行体还活着")
		}
		time.Sleep(20 * time.Millisecond)
	}
	log := launchLogOf(t, f, cache)
	if !strings.Contains(log, "event=stopped") || strings.Contains(log, "error=session_failed") {
		t.Fatalf("停止信号应记 event=stopped、不记失败：\n%s", log)
	}
}
