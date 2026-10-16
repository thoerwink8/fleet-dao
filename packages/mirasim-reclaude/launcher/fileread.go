package main

import (
	"encoding/json"
	"errors"
	"os"
	"time"
)

// Mirasim 用「写临时文件再 rename」原子替换索引和会话记录。读的一瞬间可能撞上替换：
// Windows 上是共享冲突，各平台都可能读到别的进程刚写一半的内容。隔 50ms 重读，最多 3 次，仍不行才明确失败。
var transientRetryDelay = 50 * time.Millisecond

const transientRetries = 3

// beforeJSONRetry 在解析失败、还要重读之前调用。生产环境保持 nil。
// 测试在这里把半截文件换成完整的：不另起 goroutine 睡几十毫秒再替换，忙的时候那一下排不上，
// 150ms 的重试窗口已经耗尽，读到的仍是半截（CI 上 TestReadJSONFileRetriesHalfWrittenFile 因此红过）。
var beforeJSONRetry func()

type readFailure struct {
	notExist bool
	parse    bool
}

func (e *readFailure) Error() string {
	switch {
	case e.notExist:
		return "文件不存在"
	case e.parse:
		return "JSON 格式错误"
	}
	return "文件读失败"
}

// readJSONFile 读 Mirasim 的 JSON 文件到 v。文件不存在不重试，直接返回 notExist。
func readJSONFile(path string, v any) error {
	var last *readFailure
	for attempt := 0; attempt <= transientRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(transientRetryDelay)
		}
		b, err := readFileShared(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return &readFailure{notExist: true}
			}
			last = &readFailure{}
			if isSharingViolation(err) {
				continue
			}
			return last
		}
		if json.Unmarshal(b, v) != nil {
			last = &readFailure{parse: true}
			if attempt < transientRetries && beforeJSONRetry != nil {
				beforeJSONRetry()
			}
			continue
		}
		return nil
	}
	return last
}

func isNotExist(err error) bool {
	var f *readFailure
	return errors.As(err, &f) && f.notExist
}

func isParseFailure(err error) bool {
	var f *readFailure
	return errors.As(err, &f) && f.parse
}
