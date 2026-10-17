/**
 * 设备独占锁（应用级，M8 语义基础，任务书 §10.3）：
 * `<dataDir>/device-locks/<bindingId>.lock`（JSON：holder、pid、acquiredAt、token）。
 * - 获取：独占创建（'wx' 原子失败）；已存在时读取并检测持有者 pid 存活
 *   - pid 不存活（陈旧锁）→ 可夺取覆盖，写后回读 token 校验降低并发回收竞态
 *   - pid 存活 → { acquired:false, heldBy }（同 binding 二次获取同样失败）
 * - 释放：删锁文件；串口物理持有（第二道锁）由 adapter 负责，本类只管文件锁
 * - 超时/租约到期不能直接让第二任务烧录：必须旧进程退出确认（锁文件 pid 检查）——
 *   本类不做租约自动过期，永远以 pid 存活判定
 * 已知限制：两进程同时回收同一"死锁"存在极小竞态窗口（Windows 无跨进程原子创建语义）；
 * 产品为单一权威执行器实例，实际风险可忽略。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface LockFileContent {
  schemaVersion: 1;
  holder: string;
  pid: number;
  acquiredAt: string;
  token: string;
}

export interface AcquireResult {
  acquired: boolean;
  /** 已被占用时的持有者描述 */
  heldBy?: string;
  acquiredAt?: string;
  /** 本次是否回收了陈旧锁（持有者进程已死） */
  reclaimedStale?: boolean;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 进程存活探测：信号 0 探测；EPERM 视为存活（存在但无权限） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DeviceExclusiveFileLock {
  /** 本进程内已持有的 key（同进程同 binding 二次获取直接失败） */
  private readonly held = new Map<string, LockFileContent>();

  constructor(private readonly lockDir: string) {}

  lockPath(key: string): string {
    return path.join(this.lockDir, `${sanitizeKey(key)}.lock`);
  }

  async acquire(key: string, holder: string): Promise<AcquireResult> {
    await mkdir(this.lockDir, { recursive: true });
    const inProcess = this.held.get(key);
    if (inProcess) {
      return { acquired: false, heldBy: inProcess.holder, acquiredAt: inProcess.acquiredAt };
    }
    const content: LockFileContent = {
      schemaVersion: 1,
      holder,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
    };
    const lockPath = this.lockPath(key);

    // 第一道：独占创建（'wx' 原子失败）
    try {
      const fd = await open(lockPath, 'wx');
      await fd.writeFile(JSON.stringify(content, null, 2) + '\n', 'utf8');
      await fd.close();
      this.held.set(key, content);
      return { acquired: true, acquiredAt: content.acquiredAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // 已存在：读取并判定持有者进程是否存活（旧进程退出确认）
    let previous: LockFileContent | null = null;
    try {
      previous = JSON.parse(await readFile(lockPath, 'utf8')) as LockFileContent;
    } catch {
      previous = null; // 损坏/半写文件按陈旧处理
    }
    if (previous && typeof previous.holder === 'string' && isPidAlive(previous.pid)) {
      return { acquired: false, heldBy: previous.holder, acquiredAt: previous.acquiredAt };
    }

    // 持有者进程已死或文件损坏 → 覆盖回收；写后回读 token 确认我们赢下竞态
    await writeFile(lockPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    let verified: LockFileContent | null = null;
    try {
      verified = JSON.parse(await readFile(lockPath, 'utf8')) as LockFileContent;
    } catch {
      verified = null;
    }
    if (!verified || verified.token !== content.token) {
      // 另一个回收者竞态抢先：本方放弃
      return { acquired: false, heldBy: '另一执行器实例并发回收了同一陈旧锁' };
    }
    this.held.set(key, content);
    return { acquired: true, acquiredAt: content.acquiredAt, reclaimedStale: true };
  }

  async release(key: string): Promise<void> {
    this.held.delete(key);
    try {
      await unlink(this.lockPath(key));
    } catch {
      // 文件不存在/清理失败不阻断释放流程
    }
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}
