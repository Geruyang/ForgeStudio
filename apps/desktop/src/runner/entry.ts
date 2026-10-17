/**
 * Runner 服务入口（utilityProcess 加载）：
 * --fd-runner-data-dir <dir> 启动唯一权威执行器实例，注入设备适配器。
 */
import path from 'node:path';
import { createRunnerService } from '@forgedesk/engineering-runner';
import { createDeviceAdapter } from '@forgedesk/engineering-runner/device';

function argValue(name: string): string | undefined {
  const argv = process.argv;
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = argValue('--fd-runner-data-dir');
  if (!dataDir) {
    process.stderr.write('[fd-runner] 缺少 --fd-runner-data-dir 参数\n');
    process.exit(1);
  }

  // profile 目录：用户数据目录优先，随包模板只读次之
  const bundledDir = argValue('--fd-bundled-profiles');
  const profileDirs = [path.join(dataDir, 'profiles')];
  if (bundledDir) profileDirs.push(bundledDir);

  // 设备适配器：纯设备操作；状态/授权/Evidence 由 ops 层管理
  const deviceAdapter = createDeviceAdapter({
    dataDir,
    lockDir: path.join(dataDir, 'device-locks'),
  });

  await createRunnerService({ dataDir, profileDirs, deviceAdapter });
  process.stdout.write(`[fd-runner] 就绪 dataDir=${dataDir}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`[fd-runner] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
