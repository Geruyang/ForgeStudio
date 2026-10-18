# FZ3B 板上原生构建（aarch64 gcc，Z3 实机工程样例）
CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra

.PHONY: all clean
all: fzprobe

fzprobe: src/main.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f fzprobe
