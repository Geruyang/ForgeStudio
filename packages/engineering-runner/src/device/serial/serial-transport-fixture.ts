/**
 * 内存环回 fixture 串口传输（kind:'fixture'，模拟设备，不算实机验收）。
 * - 可编程响应脚本：收到一行 → 按脚本回行（支持多行/任意顺序/延迟/无响应/模拟拔线）
 * - preloadedLines：open 后即可读的"旧缓冲"（flush 会清掉——旧日志不作本轮证据）
 * - 端口占用注册表：同进程内模拟 Windows 串口物理独占（第二道锁语义）
 */
import type { SerialTransport } from '@forgedesk/contracts';
import { SerialTransportError } from '../errors';
import { LineQueue } from './line-queue';

export type FixtureReply =
  | { kind: 'reply'; lines: string[]; delayMs?: number }
  | { kind: 'silent' }
  | { kind: 'disconnect' };

export type FixtureLineHandler = (line: string) => FixtureReply;

export interface FixtureSerialTransportOptions {
  portPath: string;
  /** false → open 报 open_failed（模拟未插/已拔出的端口） */
  portExists?: boolean;
  handler?: FixtureLineHandler;
  /** open 后立即可读的预置行（模拟旧缓冲/开机横幅） */
  preloadedLines?: string[];
}

/** 模拟 OS 串口占用表：portPath(大写) → 已被某传输打开 */
const openFixturePorts = new Set<string>();

export class FixtureSerialTransport implements SerialTransport {
  readonly kind = 'fixture' as const;

  private opened = false;
  private unplugged = false;
  private readonly queue = new LineQueue();

  constructor(private readonly options: FixtureSerialTransportOptions) {}

  async open(portPath: string, _baudRate: number): Promise<void> {
    if (this.opened) throw new SerialTransportError('open_failed', '传输已打开（fixture）');
    if (this.unplugged || this.options.portExists === false) {
      throw new SerialTransportError('open_failed', `串口 ${portPath} 不存在或已拔出（fixture 模拟）`);
    }
    const key = portPath.toUpperCase();
    if (openFixturePorts.has(key)) {
      throw new SerialTransportError('open_failed', `串口 ${portPath} 已被占用（fixture 模拟物理独占）`);
    }
    openFixturePorts.add(key);
    this.opened = true;
    // 预置"旧缓冲"：open 即可读，flush 丢弃
    for (const line of this.options.preloadedLines ?? []) {
      this.queue.push(line);
    }
  }

  async flush(): Promise<void> {
    this.assertUsable();
    this.queue.clear();
  }

  async writeLine(line: string): Promise<void> {
    this.assertUsable();
    const handler = this.options.handler;
    if (!handler) return;
    const reply = handler(line.replace(/\r$/, ''));
    if (!reply || reply.kind === 'silent') return;
    if (reply.kind === 'disconnect') {
      this.simulateUnplug();
      return;
    }
    const lines = reply.lines ?? [];
    const delayMs = reply.delayMs ?? 0;
    if (delayMs <= 0) {
      for (const out of lines) this.queue.push(out);
      return;
    }
    // 延迟响应（模拟慢速固件；unref 避免悬挂进程）
    const timer = setTimeout(() => {
      if (this.opened && !this.unplugged) {
        for (const out of lines) this.queue.push(out);
      }
    }, delayMs);
    timer.unref?.();
  }

  async readLine(timeoutMs: number): Promise<string> {
    if (!this.opened) throw new SerialTransportError('closed', '串口未打开（fixture）');
    if (this.unplugged) throw new SerialTransportError('disconnected', '串口已拔出（fixture 模拟）');
    return this.queue.waitForLine(timeoutMs);
  }

  async close(): Promise<void> {
    if (this.opened && !this.unplugged) {
      openFixturePorts.delete(this.options.portPath.toUpperCase());
    }
    this.opened = false;
    this.queue.failAll(new SerialTransportError('closed', '串口已关闭（fixture）'));
  }

  /** 模拟拔线：占用释放 + 拒绝等待者 */
  private simulateUnplug(): void {
    this.unplugged = true;
    openFixturePorts.delete(this.options.portPath.toUpperCase());
    this.queue.failAll(new SerialTransportError('disconnected', '串口已拔出（fixture 模拟）'));
  }

  private assertUsable(): void {
    if (!this.opened) throw new SerialTransportError('closed', '串口未打开（fixture）');
    if (this.unplugged) throw new SerialTransportError('disconnected', '串口已拔出（fixture 模拟）');
  }
}
