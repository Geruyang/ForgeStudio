/* 环形缓冲单元测试：8 个用例覆盖初始化/基本序/环绕/边界拒绝/窥视 */
#include <stdio.h>
#include <string.h>
#include "../src/ringbuf.h"
#include "../src/minunit.h"

static uint8_t storage[4];
static fz_ringbuf rb;

MU_TEST(test_init_state) {
    fz_rb_init(&rb, storage, 4);
    mu_assert("初始应为空", fz_rb_empty(&rb));
    mu_assert("初始不应为满", !fz_rb_full(&rb));
    mu_assert("初始计数应为 0", rb.count == 0);
    return 0;
}

MU_TEST(test_fifo_order) {
    fz_rb_init(&rb, storage, 4);
    mu_assert("推入 10 失败", fz_rb_push(&rb, 10) == 1);
    mu_assert("推入 20 失败", fz_rb_push(&rb, 20) == 1);
    mu_assert("推入 30 失败", fz_rb_push(&rb, 30) == 1);
    int ok = 0;
    mu_assert("弹出值应为 10", fz_rb_pop(&rb, &ok) == 10 && ok);
    mu_assert("弹出值应为 20", fz_rb_pop(&rb, &ok) == 20 && ok);
    mu_assert("弹出值应为 30", fz_rb_pop(&rb, &ok) == 30 && ok);
    mu_assert("弹空后应为空", fz_rb_empty(&rb));
    return 0;
}

MU_TEST(test_wraparound_preserves_order) {
    fz_rb_init(&rb, storage, 4);
    /* 填满 4 再弹 2，写读位置错开后继续推弹——检验环绕正确性 */
    for (int v = 1; v <= 4; v++) mu_assert("填满阶段推入失败", fz_rb_push(&rb, (uint8_t)v) == 1);
    int ok = 0;
    mu_assert("环绕前弹出应为 1", fz_rb_pop(&rb, &ok) == 1 && ok);
    mu_assert("环绕前弹出应为 2", fz_rb_pop(&rb, &ok) == 2 && ok);
    mu_assert("错位后推入 5 失败", fz_rb_push(&rb, 5) == 1);
    mu_assert("错位后推入 6 失败", fz_rb_push(&rb, 6) == 1);
    /* 期望顺序 3,4,5,6 */
    uint8_t expect[4] = {3, 4, 5, 6};
    for (int i = 0; i < 4; i++)
        mu_assert("环绕后顺序错误", fz_rb_pop(&rb, &ok) == expect[i] && ok);
    mu_assert("全部弹出后应为空", fz_rb_empty(&rb));
    return 0;
}

MU_TEST(test_pop_empty_rejected) {
    fz_rb_init(&rb, storage, 4);
    int ok = 1;
    (void)fz_rb_pop(&rb, &ok);
    mu_assert("空弹出应置 ok=0", ok == 0);
    return 0;
}

MU_TEST(test_push_full_rejected) {
    fz_rb_init(&rb, storage, 4);
    for (int v = 0; v < 4; v++) mu_assert("填满推入失败", fz_rb_push(&rb, (uint8_t)v) == 1);
    mu_assert("满时应为满", fz_rb_full(&rb));
    mu_assert("满后推入应被拒绝", fz_rb_push(&rb, 99) == 0);
    mu_assert("拒绝推入后计数仍为 4", rb.count == 4);
    return 0;
}

MU_TEST(test_peek_does_not_consume) {
    fz_rb_init(&rb, storage, 4);
    (void)fz_rb_push(&rb, 7);
    int ok = 0;
    mu_assert("窥视值应为 7", fz_rb_peek(&rb, &ok) == 7 && ok);
    mu_assert("窥视不应消费元素", rb.count == 1);
    mu_assert("窥视后弹出仍为 7", fz_rb_pop(&rb, &ok) == 7 && ok);
    return 0;
}

MU_TEST(test_peek_empty_rejected) {
    fz_rb_init(&rb, storage, 4);
    int ok = 1;
    (void)fz_rb_peek(&rb, &ok);
    mu_assert("空窥视应置 ok=0", ok == 0);
    return 0;
}

MU_TEST(test_reinit_clears_state) {
    fz_rb_init(&rb, storage, 4);
    for (int v = 0; v < 3; v++) (void)fz_rb_push(&rb, (uint8_t)v);
    fz_rb_init(&rb, storage, 4); /* 重新初始化 */
    mu_assert("重初始化后应为空", fz_rb_empty(&rb));
    int ok = 0;
    (void)fz_rb_pop(&rb, &ok);
    mu_assert("重初始化后弹出应被拒", ok == 0);
    mu_assert("重初始化后可正常推入", fz_rb_push(&rb, 42) == 1);
    mu_assert("重初始化后弹出为 42", fz_rb_pop(&rb, &ok) == 42 && ok);
    return 0;
}

int main(void) {
    MU_MAIN_HEADER();
    mu_run_test(test_init_state);
    mu_run_test(test_fifo_order);
    mu_run_test(test_wraparound_preserves_order);
    mu_run_test(test_pop_empty_rejected);
    mu_run_test(test_push_full_rejected);
    mu_run_test(test_peek_does_not_consume);
    mu_run_test(test_peek_empty_rejected);
    mu_run_test(test_reinit_clears_state);
    MU_MAIN_SUMMARY();
}
