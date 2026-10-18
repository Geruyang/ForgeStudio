/*
 * minunit 风格极简单元测试框架（板上运行，无外部依赖）：
 * - MU_TEST 定义用例；mu_assert 失败即返回用例名（该用例计失败）；
 * - mu_run_test 执行并计数（RUN/FAILED）；打印逐用例 PASS/FAIL 与总结行；
 * - 总结行格式供验收 stdoutMustContain 判定：RUN=<n> FAILED=<m> + UNIT_TESTS_PASSED。
 */
#ifndef FZ_MINUNIT_H
#define FZ_MINUNIT_H

#include <stdio.h>

static int fz_mu_run = 0;
static int fz_mu_failed = 0;

#define MU_TEST(name) static const char *name(void)

#define mu_assert(message, test) \
    do { \
        if (!(test)) return (message); \
    } while (0)

#define mu_run_test(test) \
    do { \
        const char *msg = (test)(); \
        fz_mu_run++; \
        if (msg) { \
            fz_mu_failed++; \
            printf("[CASE] %s ... FAIL: %s\n", #test, msg); \
        } else { \
            printf("[CASE] %s ... PASS\n", #test); \
        } \
    } while (0)

/* 主入口：打印板卡身份头 → 运行套件 → 总结；全过返回 0 */
#define MU_MAIN_HEADER() \
    do { \
        char host[64] = "?", release[96] = "?"; \
        FILE *hf = fopen("/proc/sys/kernel/hostname", "r"); \
        if (hf) { if (fgets(host, sizeof host, hf)) host[strcspn(host, "\r\n")] = '\0'; fclose(hf); } \
        FILE *rf = fopen("/proc/sys/kernel/osrelease", "r"); \
        if (rf) { if (fgets(release, sizeof release, rf)) release[strcspn(release, "\r\n")] = '\0'; fclose(rf); } \
        printf("BOARD_HOST=%s\nKERNEL=%s\nARCH=%s\n", host, release, sizeof(void *) == 8 ? "aarch64" : "unknown"); \
    } while (0)

#define MU_MAIN_SUMMARY() \
    do { \
        printf("RUN=%d FAILED=%d\n", fz_mu_run, fz_mu_failed); \
        if (fz_mu_failed == 0) printf("UNIT_TESTS_PASSED\n"); \
        return fz_mu_failed == 0 ? 0 : 1; \
    } while (0)

#endif
