/* 定容环形缓冲（uint8_t）：嵌入式常见模块——多文件工程样例的被测对象 */
#ifndef FZ_RINGBUF_H
#define FZ_RINGBUF_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *data;      /* 外部提供的存储 */
    size_t capacity;    /* 容量（元素数） */
    size_t head;        /* 写位置 */
    size_t tail;        /* 读位置 */
    size_t count;       /* 当前元素数 */
} fz_ringbuf;

void fz_rb_init(fz_ringbuf *rb, uint8_t *storage, size_t capacity);
/* 推入：满则拒绝并返回 0 */
int fz_rb_push(fz_ringbuf *rb, uint8_t value);
/* 弹出：空则返回 0 并置 *ok=0 */
uint8_t fz_rb_pop(fz_ringbuf *rb, int *ok);
/* 查看（不移除）：空则返回 0 并置 *ok=0 */
uint8_t fz_rb_peek(const fz_ringbuf *rb, int *ok);
int fz_rb_empty(const fz_ringbuf *rb);
int fz_rb_full(const fz_ringbuf *rb);

#endif
