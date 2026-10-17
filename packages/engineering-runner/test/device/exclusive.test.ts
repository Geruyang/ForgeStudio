// fixture 模拟测试——非实机验收。
// 独占（M8 语义）：双任务争用 → 第二失败；释放后可获取；陈旧锁（伪造死 pid）可夺取；
// 超时/租约到期不得直接让第二任务烧录——必须旧进程退出确认（pid 检查）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DeviceExclusiveFileLock, isPidAlive } from '../../src/device/exclusive.ts';
import { createDeviceAdapter } from '../../src/device/index.ts';

let lockDir: string;

beforeEach(async () => {
  lockDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-device-lock-'));
});

afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

describe('文件锁：获取/争用/释放/陈旧回收', () => {
  it('首次获取成功，同实例二次获取失败（heldBy 指明持有者）', async () => {
    const lock = new DeviceExclusiveFileLock(lockDir);
    const first = await lock.acquire('dev-abc', '任务A device_flash');
    expect(first.acquired).toBe(true);
    expect(first.acquiredAt).toBeTruthy();

    const second = await lock.acquire('dev-abc', '任务B device_flash');
    expect(second.acquired).toBe(false);
    expect(second.heldBy).toContain('任务A');
  });

  it('不同 bindingId 互不阻塞', async () => {
    const lock = new DeviceExclusiveFileLock(lockDir);
    await lock.acquire('dev-abc', '任务A');
    const other = await lock.acquire('dev-xyz', '任务B');
    expect(other.acquired).toBe(true);
  });

  it('释放后可再次获取，锁文件删除', async () => {
    const lock = new DeviceExclusiveFileLock(lockDir);
    await lock.acquire('dev-abc', '任务A');
    await lock.release('dev-abc');
    const again = await lock.acquire('dev-abc', '任务B');
    expect(again.acquired).toBe(true);
    expect(again.reclaimedStale).toBeUndefined(); // 正常获取（非回收）
    await lock.release('dev-abc');
  });

  it('跨实例争用（模拟第二任务/第二执行器）：持有者进程存活 → 不可夺取', async () => {
    const lockA = new DeviceExclusiveFileLock(lockDir);
    const lockB = new DeviceExclusiveFileLock(lockDir); // 同目录不同实例
    const a = await lockA.acquire('dev-abc', '任务A device_flash');
    expect(a.acquired).toBe(true);
    const b = await lockB.acquire('dev-abc', '任务B device_flash');
    expect(b.acquired).toBe(false);
    expect(b.heldBy).toContain('任务A');
    await lockA.release('dev-abc');
    const b2 = await lockB.acquire('dev-abc', '任务B device_flash');
    expect(b2.acquired).toBe(true);
  });

  it('陈旧锁（持有者 pid 已死）可夺取并记录（M8：旧进程退出确认）', async () => {
    const stalePid = 99999999; // 不可能存活的 pid
    const lockPath = path.join(lockDir, 'dev-abc.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        holder: '崩溃前的任务Z device_flash',
        pid: stalePid,
        acquiredAt: new Date().toISOString(),
        token: 'stale-token',
      }),
      'utf8',
    );
    const lock = new DeviceExclusiveFileLock(lockDir);
    const res = await lock.acquire('dev-abc', '新任务 device_flash');
    expect(res.acquired).toBe(true);
    expect(res.reclaimedStale).toBe(true);
    const content = JSON.parse(await readFile(lockPath, 'utf8')) as { holder: string };
    expect(content.holder).toBe('新任务 device_flash');
  });

  it('存活 pid 持有的锁不可夺取（租约到期也不行——pid 检查优先）', async () => {
    const lockPath = path.join(lockDir, 'dev-abc.lock');
    // 伪造"另一个存活进程"持有：pid 用当前进程（必定存活）
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        holder: '另一执行器实例（模拟外部进程）',
        pid: process.pid,
        acquiredAt: new Date(2020, 1, 1).toISOString(), // 早已"过期"的租约
        token: 'external-token',
      }),
      'utf8',
    );
    const lock = new DeviceExclusiveFileLock(lockDir);
    const res = await lock.acquire('dev-abc', '新任务');
    expect(res.acquired).toBe(false);
    expect(res.heldBy).toContain('另一执行器实例');
  });

  it('isPidAlive：死 pid false / 当前进程 true', () => {
    expect(isPidAlive(99999999)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('adapter.acquireExclusive：M8 双任务争用（应用级锁）', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-adapter-lock-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('任务A 持有 → 任务B 失败；A 释放后 B 可获取', async () => {
    const adapterA = createDeviceAdapter({ dataDir });
    const adapterB = createDeviceAdapter({ dataDir });
    const bindingId = 'dev-contended';

    const a = await adapterA.acquireExclusive(bindingId, '任务A device_flash');
    expect(a.acquired).toBe(true);

    const b = await adapterB.acquireExclusive(bindingId, '任务B device_flash');
    expect(b.acquired).toBe(false);
    expect(b.heldBy).toContain('任务A');

    await adapterA.releaseExclusive(bindingId);
    const b2 = await adapterB.acquireExclusive(bindingId, '任务B device_flash');
    expect(b2.acquired).toBe(true);
    await adapterB.releaseExclusive(bindingId);
  });
});
