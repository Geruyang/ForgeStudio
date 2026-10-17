/**
 * 测试夹具：临时工程与 profile 生成（全部位于 os.tmpdir()，测试后清理）。
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FixtureProject {
  root: string;
  profileDir: string;
  profileId: string;
  profileFile: string;
}

export type FixtureVariant = 'ok' | 'build-fail' | 'mutate' | 'keywords';

const BUILD_OK = `import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(root, 'build-report.json'), JSON.stringify({ ok: true, builtAt: Date.now() }, null, 2) + '\\n');
console.log('BUILD_OK');
`;

const BUILD_FAIL = `console.error('boom: 故意失败');
process.exit(1);
`;

/** 构建期间修改源码（模拟外部编辑/构建脚本写源文件 → 前后指纹不一致） */
const BUILD_MUTATE = `import { writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(root, 'src', 'main.js'), '// mutated by build\\n');
writeFileSync(join(root, 'build-report.json'), JSON.stringify({ ok: true }, null, 2) + '\\n');
console.log('BUILD_OK');
`;

/** 副作用计数构建：每次执行向 side-effect.txt 追加一行（幂等性测试用，inputExcludes 排除） */
const BUILD_SIDE_EFFECT = `import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(root, 'side-effect.txt'), 'run\\n');
writeFileSync(join(root, 'build-report.json'), JSON.stringify({ ok: true }, null, 2) + '\\n');
console.log('BUILD_OK');
`;

const VERIFY_PASS = `console.log('PASS 用例1');
console.log('TESTS_PASSED');
`;

const VERIFY_FAIL = `console.log('FAIL 用例1');
console.log('TEST_FAILED');
process.exit(1);
`;

/** 输出含关键字但退出码非 0（判定规则组合用） */
const VERIFY_KEYWORDS = `console.log('HAS_MARKER');
console.log('no forbidden');
process.exit(2);
`;

export async function makeTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(tmpdir(), `forgedesk-${prefix}-`));
}

export async function writeFixtureProject(
  variant: FixtureVariant,
  opts?: { sideEffectBuild?: boolean; rootName?: string },
): Promise<FixtureProject> {
  const base = await makeTmpDir('proj');
  // should 场景（任务书 §15.2 路径组合）：rootName 指定时在其下再建自定义命名子目录
  const root = opts?.rootName ? path.join(base, opts.rootName) : base;
  if (opts?.rootName) await fsp.mkdir(root, { recursive: true });
  const profileDir = await makeTmpDir('profiles');
  const profileId = `fixture-${variant}${opts?.sideEffectBuild ? '-se' : ''}`;
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'main.js'), 'console.log("v1");\n', 'utf8');
  await fsp.writeFile(path.join(root, 'src', 'util.js'), 'export const u = 1;\n', 'utf8');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: profileId, private: true }, null, 2), 'utf8');

  const buildScript =
    opts?.sideEffectBuild ? BUILD_SIDE_EFFECT : variant === 'build-fail' ? BUILD_FAIL : variant === 'mutate' ? BUILD_MUTATE : BUILD_OK;
  await fsp.writeFile(path.join(root, 'build.mjs'), buildScript, 'utf8');

  const verifierScript =
    variant === 'keywords' ? VERIFY_KEYWORDS : variant === 'ok' ? VERIFY_PASS : VERIFY_FAIL;
  await fsp.writeFile(path.join(root, 'run-tests.mjs'), verifierScript, 'utf8');

  const verifiers =
    variant === 'keywords'
      ? [
          {
            verifierId: 'kw-verifier',
            title: '关键字判定',
            command: { exe: 'node', args: ['run-tests.mjs'], timeoutMs: 30_000 },
            passExitCode: 2,
            stdoutMustContain: ['HAS_MARKER'],
            stdoutMustNotContain: ['FORBIDDEN'],
            outputLimitBytes: 1_048_576,
          },
        ]
      : [
          {
            verifierId: `${profileId}-smoke`,
            title: '冒烟验收',
            command: { exe: 'node', args: ['run-tests.mjs'], timeoutMs: 30_000 },
            passExitCode: 0,
            stdoutMustContain: ['TESTS_PASSED'],
            stdoutMustNotContain: ['TEST_FAILED'],
            outputLimitBytes: 1_048_576,
          },
        ];

  const profile = {
    schemaVersion: 1,
    id: profileId,
    revision: 1,
    title: `fixture ${variant}`,
    kind: 'software',
    build: { exe: 'node', args: ['build.mjs'], timeoutMs: 60_000 },
    artifactsGlob: ['build-report.json'],
    verifiers,
    inputIncludes: ['package.json', 'build.mjs', 'run-tests.mjs'],
    inputExcludes: ['build-report.json', 'side-effect.txt'],
  };
  const profileFile = path.join(profileDir, `${profileId}.profile.json`);
  await fsp.writeFile(profileFile, JSON.stringify(profile, null, 2), 'utf8');
  return { root, profileDir, profileId, profileFile };
}

/** 嵌入式 profile（设备授权框架测试用：匹配 StubAdapter 的虚拟探针） */
export async function writeEmbeddedProfile(profileDir: string, id = 'fixture-embedded'): Promise<string> {
  const profile = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: '嵌入式 fixture（虚拟探针，标注模拟）',
    kind: 'embedded',
    build: { exe: 'node', args: ['build.mjs'], timeoutMs: 60_000 },
    artifactsGlob: ['build-report.json'],
    verifiers: [],
    device: {
      chipTarget: 'stm32f103cb-fixture',
      identity: { usbVid: 0x1234, usbPid: 0x5678, expectProbeSerial: false },
      serial: {
        baudRate: 115200,
        verifyProtocol: { requestLine: 'IDENT?', buildIdEchoPrefix: 'BUILD:' },
        responseTimeoutMs: 2_000,
      },
      flashCommand: { exe: 'node', args: ['-e', 'console.log("stub")'], timeoutMs: 60_000 },
      flashBudgetMs: 30_000,
      verifyBudgetMs: 10_000,
    },
    inputIncludes: ['package.json'],
    inputExcludes: ['build-report.json'],
  };
  const file = path.join(profileDir, `${id}.profile.json`);
  await fsp.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
  return file;
}

export async function rmForce(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

/** 复制目录（fixture 工程复制到临时目录，避免污染仓库） */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fsp.copyFile(from, to);
  }
}
