//go:build !windows

package main

import "os"

// Unix 上打开着的文件不挡 rename，照旧读。
func readFileShared(path string) ([]byte, error) { return os.ReadFile(path) }

func isSharingViolation(error) bool { return false }
