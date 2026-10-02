//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// 先把监管进程本身放进 Job 再启动目标，避免漏掉绑定前派生的子孙。
func protectProcess() error         { return bindToJob(os.Getpid()) }
func configureGuardian(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func configureTarget(c *exec.Cmd)   { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func gracefulTree(*exec.Cmd)        {}
func terminateTree(c *exec.Cmd) {
	if c.Process != nil {
		_ = c.Process.Kill()
	}
}
func terminationSignals() []os.Signal { return []os.Signal{os.Interrupt} }
