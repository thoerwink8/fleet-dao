//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW     = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObj = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob   = kernel32.NewProc("AssignProcessToJobObject")
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x2000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
)

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type jobBasicLimit struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobExtendedLimit struct {
	BasicLimitInformation jobBasicLimit
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// jobHandle 故意不关：本进程退出时句柄随之关闭，KILL_ON_JOB_CLOSE 就把整棵子树带走。
var jobHandle uintptr

func bindToJob(pid int) error {
	h, _, err := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return fmt.Errorf("CreateJobObject: %v", err)
	}
	info := jobExtendedLimit{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	r, _, err := procSetInformationJobObj.Call(h, jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		return fmt.Errorf("SetInformationJobObject: %v", err)
	}
	ph, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess: %v", err)
	}
	defer syscall.CloseHandle(ph)
	r, _, err = procAssignProcessToJob.Call(h, uintptr(ph))
	if r == 0 {
		return fmt.Errorf("AssignProcessToJobObject: %v", err)
	}
	jobHandle = h
	return nil
}
