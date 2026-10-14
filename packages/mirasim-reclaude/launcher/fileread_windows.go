//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// Go 的 os.Open 在 Windows 上不带 FILE_SHARE_DELETE：启动器读着索引时，Mirasim 用 rename 原子替换它会失败。
// 放开删除共享只是必要条件：旧 rename 语义下目标有句柄开着仍拒绝覆盖，所以读完立刻关句柄，把窗口压到最短。
// 读 Mirasim 的文件一律用三种共享都放开的句柄。
func openShared(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

func readFileShared(path string) ([]byte, error) {
	f, err := openShared(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

const (
	errorSharingViolation syscall.Errno = 32
	errorLockViolation    syscall.Errno = 33
)

func isSharingViolation(err error) bool {
	return errors.Is(err, errorSharingViolation) || errors.Is(err, errorLockViolation)
}
