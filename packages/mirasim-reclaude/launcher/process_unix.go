//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func protectProcess() error         { return nil }
func configureGuardian(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func configureTarget(c *exec.Cmd)   { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func gracefulTree(c *exec.Cmd) {
	if c.Process != nil {
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	}
}
func terminateTree(c *exec.Cmd) {
	if c.Process != nil {
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
}
func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}
