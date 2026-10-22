//go:build !windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
)

func testProcessAlive(pid int) bool {
	if runtime.GOOS == "linux" {
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
			for i := len(b) - 1; i >= 0; i-- {
				if b[i] == ')' && i+2 < len(b) && b[i+2] == 'Z' {
					return false
				}
			}
		}
	}
	return syscall.Kill(pid, 0) == nil
}
