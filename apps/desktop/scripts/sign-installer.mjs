/**
 * 独立签名工具（Z4-B2）：对既有产物签名或验证签名链路（不重新打包）。
 * 用法：node scripts/sign-installer.mjs <file...>
 * 凭据环境变量与 sign-hook.cjs 一致（FD_SIGN_PFX/FD_SIGN_PFX_PASSWORD 或
 * FD_SIGN_CERT_THUMBPRINT；FD_SIGN_TIMESTAMP_URL 可选）。
 */
import { sign } from '@electron/windows-sign';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：node scripts/sign-installer.mjs <file...>');
  process.exit(2);
}
const opts = {
  files,
  hashes: ['sha256'],
  timestampServer: process.env.FD_SIGN_TIMESTAMP_URL ?? 'http://timestamp.digicert.com',
};
if (process.env.FD_SIGN_PFX) {
  if (!process.env.FD_SIGN_PFX_PASSWORD) {
    console.error('[sign] 配置了 FD_SIGN_PFX 但缺少 FD_SIGN_PFX_PASSWORD');
    process.exit(2);
  }
  opts.certificateFile = process.env.FD_SIGN_PFX;
  opts.certificatePassword = process.env.FD_SIGN_PFX_PASSWORD;
} else if (process.env.FD_SIGN_CERT_THUMBPRINT) {
  opts.signWithParams = ['/sha1', process.env.FD_SIGN_CERT_THUMBPRINT];
  opts.automaticallySelectCertificate = false;
} else {
  console.error('[sign] 未配置凭据：需 FD_SIGN_PFX(+密码) 或 FD_SIGN_CERT_THUMBPRINT');
  process.exit(2);
}

console.log(`[sign] 签名 ${files.length} 个文件（sha256 + 时间戳 ${opts.timestampServer}）`);
await sign(opts);
console.log('[sign] 完成');
