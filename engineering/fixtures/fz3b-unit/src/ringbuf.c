/* 定容环形缓冲实现 */
#include "ringbuf.h"

void fz_rb_init(fz_ringbuf *rb, uint8_t *storage, size_t capacity) {
    rb->data = storage;
    rb->capacity = capacity;
    rb->head = 0;
    rb->tail = 0;
    rb->count = 0;
}

int fz_rb_push(fz_ringbuf *rb, uint8_t value) {
    if (rb->count == rb->capacity) return 0;
    rb->data[rb->head] = value;
    rb->head = (rb->head + 1) % rb->capacity;
    rb->count++;
    return 1;
}

uint8_t fz_rb_pop(fz_ringbuf *rb, int *ok) {
    if (rb->count == 0) {
        if (ok) *ok = 0;
        return 0;
    }
    uint8_t v = rb->data[rb->tail];
    rb->tail = (rb->tail + 1) % rb->capacity;
    rb->count--;
    if (ok) *ok = 1;
    return v;
}

uint8_t fz_rb_peek(const fz_ringbuf *rb, int *ok) {
    if (rb->count == 0) {
        if (ok) *ok = 0;
        return 0;
    }
    if (ok) *ok = 1;
    return rb->data[rb->tail];
}

int fz_rb_empty(const fz_ringbuf *rb) { return rb->count == 0; }

int fz_rb_full(const fz_ringbuf *rb) { return rb->count == rb->capacity; }
