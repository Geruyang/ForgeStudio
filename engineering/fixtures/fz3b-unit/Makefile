# FZ3B 板上多文件 C 工程（aarch64 原生构建 + 板上单元测试，Z4 实机样例）
CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -Isrc

.PHONY: all clean
all: fzunit

fzunit: test/test_ringbuf.c src/ringbuf.c src/ringbuf.h src/minunit.h
	$(CC) $(CFLAGS) -o $@ test/test_ringbuf.c src/ringbuf.c

clean:
	rm -f fzunit
