//go:build windows

package main

import "syscall"

func testProcessAlive(pid int) bool {
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	status, err := syscall.WaitForSingleObject(h, 0)
	return err == nil && status == syscall.WAIT_TIMEOUT
}
