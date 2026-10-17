/**
 * @forgedesk/engineering-runner —— 工程执行器入口。
 * 状态/存储/快照/HTTP 属引擎 Agent（B）；src/device 属设备 Agent（C），经
 * src/internal/device-port.ts 注入点接入。
 */
export { createRunnerService, type RunnerService, type RunnerServiceOptions } from './index-service.ts';
export { Storage, type AuthorizationRecord } from './storage/database.ts';
export { RUNNER_SCHEMA_VERSION, MIGRATIONS, applyMigrations, appliedSchemaVersion } from './storage/migrations.ts';
export { OpsEngine, OperationCancelledError, ToolExecError, NotFoundError, BadRequestError, type OperationCallResult, type ToolOutput } from './ops/engine.ts';
export { ProfileLoader, type ProfileLoadDiagnostics } from './profiles/loader.ts';
export { createRunnerHttp, type RunnerHttpOptions, type RunnerHttpServer } from './http/server.ts';
export {
  captureSourceSnapshot,
  probeGit,
  digestManifest,
  SnapshotLimitError,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_MANIFEST_FILES,
  DEFAULT_INPUT_EXCLUDES,
} from './snapshot/source-snapshot.ts';
export { probeToolVersions, isGitAvailable, type ToolVersionProbe } from './snapshot/tool-versions.ts';
export { runCommand, buildCommandEnv, COMMAND_ENV_WHITELIST, type RunCommandArgs, type CommandResult } from './ops/command.ts';
export {
  OPERATION_TRANSITIONS,
  TASK_TRANSITIONS,
  assertOperationTransition,
  canTransitionOperation,
  canTransitionTask,
  isTerminalOperationStatus,
} from './ops/state-machine.ts';
export { buildArgsDigest } from './ops/keys.ts';
export { buildExportBundle, type ExportManifest, type ExportBundleResult } from './ops/exporter.ts';
export { canonicalJson, sha256Of, sha256File, matchPath, matchAny, walkFiles, toPosix } from './snapshot/digests.ts';
export type { DeviceAdapter, DeviceAdapterInjection } from './internal/device-port.ts';
