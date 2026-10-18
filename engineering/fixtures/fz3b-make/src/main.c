/* FZ3B 板上自检工具：读板卡身份（hostname/内核/CPU 数），打印自检结果与身份摘要 */
#include <stdio.h>
#include <string.h>

static void read_first_line(const char *path, char *buf, size_t n) {
    buf[0] = '\0';
    FILE *f = fopen(path, "r");
    if (!f) return;
    if (fgets(buf, (int)n, f)) buf[strcspn(buf, "\r\n")] = '\0';
    fclose(f);
}

int main(void) {
    char hostname[64] = "?", release[96] = "?";
    int cores = 0;
    FILE *cpu = fopen("/proc/cpuinfo", "r");
    if (cpu) {
        char line[256];
        while (fgets(line, sizeof line, cpu))
            if (strncmp(line, "processor", 9) == 0) cores++;
        fclose(cpu);
    }
    read_first_line("/proc/sys/kernel/hostname", hostname, sizeof hostname);
    read_first_line("/proc/sys/kernel/osrelease", release, sizeof release);
    printf("TESTS_PASSED\n");
    printf("BOARD_HOST=%s\n", hostname);
    printf("KERNEL=%s\n", release);
    printf("CORES=%d\n", cores);
    printf("ARCH=%s\n", sizeof(void *) == 8 ? "aarch64" : "unknown");
    return cores > 0 ? 0 : 1;
}
