/**
 * 行队列 + 超时等待：真实串口传输与 fixture 环回传输共用。
 */
import { SerialTransportError } from '../errors';

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (err: SerialTransportError) => void;
  timer: NodeJS.Timeout;
}

export class LineQueue {
  private lines: string[] = [];
  private waiters: LineWaiter[] = [];

  push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    } else {
      this.lines.push(line);
    }
  }

  poll(): string | undefined {
    return this.lines.shift();
  }

  get size(): number {
    return this.lines.length + this.waiters.length;
  }

  /** 清空已缓冲行（flush 旧缓冲用），等待中的读取不受影响 */
  clear(): void {
    this.lines = [];
  }

  waitForLine(timeoutMs: number): Promise<string> {
    const buffered = this.poll();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<string>((resolve, reject) => {
      const waiter: LineWaiter = {
        resolve,
        reject,
        // 占位，下面立即赋值
        timer: null as unknown as NodeJS.Timeout,
      };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new SerialTransportError('timeout', `等待串口行超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** 传输关闭/拔线：拒绝全部等待者 */
  failAll(err: SerialTransportError): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}
