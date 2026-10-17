/**
 * 真实串口传输（serialport 13 + @serialport/bindings-cpp，Windows 锁默认开启：
 * lock=true → 打开即物理独占，第二进程打开同一 COM 口失败）。
 * - open 失败/拔线 → SerialTransportError('open_failed' | 'disconnected') → 连接失败语义
 * - flush：OS 缓冲丢弃（port.flush）+ 内部行队列清空，防旧日志污染本轮证据
 * - readLine：按 \n 切行（行尾 \r 剔除），超时抛 'timeout'
 */
import { SerialPort } from 'serialport';
import type { SerialTransport } from '@forgedesk/contracts';
import { SerialTransportError } from '../errors';
import { LineQueue } from './line-queue';

export class SerialPortTransport implements SerialTransport {
  readonly kind = 'real' as const;

  private port: SerialPort | null = null;
  private readonly queue = new LineQueue();
  private partial = '';
  private disconnected = false;
  private closingByUs = false;

  async open(portPath: string, baudRate: number): Promise<void> {
    if (this.port) throw new SerialTransportError('open_failed', '传输已打开');
    this.disconnected = false;
    this.closingByUs = false;
    this.partial = '';
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false, lock: true });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      port.open((err) => {
        settled = true;
        if (err) {
          reject(new SerialTransportError('open_failed', `串口 ${portPath} 打开失败：${err.message}`, err));
        } else {
          resolve();
        }
      });
      port.once('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(new SerialTransportError('open_failed', `串口 ${portPath} 打开失败：${err.message}`, err));
        }
      });
    });
    this.port = port;
    port.on('data', (chunk: Buffer) => this.feed(chunk));
    port.on('error', (err: Error) => {
      // 打开后的错误（写失败等）：按断连处理，避免读线程悬挂
      this.disconnected = true;
      this.queue.failAll(new SerialTransportError('disconnected', `串口 ${portPath} 异常：${err.message}`, err));
    });
    port.on('close', () => {
      if (this.port === port && !this.closingByUs) {
        this.disconnected = true;
        this.queue.failAll(new SerialTransportError('disconnected', `串口 ${portPath} 已断开（拔线或被系统移除）`));
      }
    });
  }

  /** 喂入字节流 → 切行入队；行尾 \r 剔除，空行丢弃 */
  private feed(chunk: Buffer): void {
    this.partial += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, idx).replace(/\r$/, '');
      this.partial = this.partial.slice(idx + 1);
      if (line.length > 0) this.queue.push(line);
    }
  }

  async flush(): Promise<void> {
    const port = this.port;
    if (!port) throw new SerialTransportError('closed', '串口未打开');
    if (this.disconnected) throw new SerialTransportError('disconnected', '串口已断开');
    // OS 层：丢弃已收到未读/已写未发数据
    await new Promise<void>((resolve, reject) => {
      port.flush((err) => {
        if (err) reject(new SerialTransportError('disconnected', `串口 flush 失败：${err.message}`, err));
        else resolve();
      });
    });
    // 应用层：丢弃已切好的行与半行（旧日志，不能作为本轮证据）
    this.partial = '';
    this.queue.clear();
  }

  async writeLine(line: string): Promise<void> {
    const port = this.port;
    if (!port) throw new SerialTransportError('closed', '串口未打开');
    if (this.disconnected) throw new SerialTransportError('disconnected', '串口已断开，写入失败');
    await new Promise<void>((resolve, reject) => {
      port.write(`${line}\n`, 'utf8', (err) => {
        if (err) reject(new SerialTransportError('write_failed', `串口写入失败：${err.message}`, err));
        else resolve();
      });
    });
  }

  async readLine(timeoutMs: number): Promise<string> {
    if (!this.port) throw new SerialTransportError('closed', '串口未打开');
    if (this.disconnected) throw new SerialTransportError('disconnected', '串口已断开');
    return this.queue.waitForLine(timeoutMs);
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.closingByUs = true;
    this.port = null;
    try {
      await new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        port.close(() => resolve());
      });
    } finally {
      this.queue.failAll(new SerialTransportError('closed', '串口已关闭'));
    }
  }
}
