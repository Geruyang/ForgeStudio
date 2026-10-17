/**
 * 交付包导出（engineering.export）：目录交付（不压缩）。
 * <dataDir>/exports/task-<id>-<ts>/
 *   manifest.json —— schemaVersion=1，任务/验收/快照/操作/证据/产物清单+哈希
 *   artifacts/    —— 产物副本（优先归档副本，防产物被清理后证据失联）
 *   evidence/     —— 证据日志副本（保留 evidence/<taskId>/<opId>/ 相对结构）
 * 不含任何凭证内容：清单只含结构化实体数据（命令、路径、哈希、状态）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { EngineeringTask, AcceptanceItem, Operation, Evidence, Artifact, SourceSnapshot } from '@forgedesk/contracts/engineering';
import { sha256File, toPosix } from '../snapshot/digests.ts';
import type { Storage } from '../storage/database.ts';

export interface ExportBundleFile {
  /** 相对 bundle 根的 posix 路径 */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ExportManifest {
  schemaVersion: 1;
  generatedAt: string;
  task: EngineeringTask;
  acceptance: AcceptanceItem[];
  snapshot?: SourceSnapshot;
  operations: Operation[];
  evidence: Evidence[];
  artifacts: Array<Omit<Artifact, 'schemaVersion'> & { schemaVersion: number; bundleFile?: string }>;
  files: ExportBundleFile[];
  note: string;
}

export interface ExportBundleResult {
  bundlePath: string;
  manifest: ExportManifest;
}

export async function buildExportBundle(args: {
  dataDir: string;
  storage: Storage;
  task: EngineeringTask;
  now?: Date;
}): Promise<ExportBundleResult> {
  const { dataDir, storage, task } = args;
  const now = args.now ?? new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(dataDir, 'exports', `${task.id}-${ts}`);
  await fsp.mkdir(path.join(bundlePath, 'artifacts'), { recursive: true });

  const acceptance = storage.listAcceptanceItems(task.id);
  const snapshot = storage.latestSnapshot(task.id) ?? undefined;
  const operations = storage.listOperations(task.id);
  const evidence = storage.listEvidence(task.id);
  const artifacts = storage.listArtifacts(task.id);
  const files: ExportBundleFile[] = [];

  // 产物副本（优先归档副本）
  const artifactEntries: ExportManifest['artifacts'] = [];
  for (const art of artifacts) {
    const entry: ExportManifest['artifacts'][number] = { ...art };
    const src = art.archivedPath ? path.join(dataDir, art.archivedPath) : art.path;
    const exists = await fsp
      .stat(src)
      .then((s) => s.isFile())
      .catch(() => false);
    if (exists) {
      const destName = `${art.id}__${path.basename(src)}`;
      const dest = path.join(bundlePath, 'artifacts', destName);
      await fsp.copyFile(src, dest);
      const digest = await sha256File(dest);
      files.push({ path: toPosix(path.join('artifacts', destName)), sha256: digest.sha256, sizeBytes: digest.sizeBytes });
      entry.bundleFile = toPosix(path.join('artifacts', destName));
    }
    artifactEntries.push(entry);
  }

  // 证据日志副本（保留相对结构 evidence/<taskId>/<opId>/…）
  for (const ev of evidence) {
    if (!ev.logRef) continue;
    const src = path.join(dataDir, ev.logRef);
    const exists = await fsp
      .stat(src)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) continue;
    const rel = toPosix(ev.logRef);
    const dest = path.join(bundlePath, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    const digest = await sha256File(dest);
    files.push({ path: rel, sha256: digest.sha256, sizeBytes: digest.sizeBytes });
  }

  const manifest: ExportManifest = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    task,
    acceptance,
    snapshot,
    operations,
    evidence,
    artifacts: artifactEntries,
    files,
    note: 'ForgeDesk 交付包：软件与实机统一交付；证据只由工程执行器写入；不含任何凭证内容。',
  };

  const manifestPath = path.join(bundlePath, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { bundlePath, manifest };
}
