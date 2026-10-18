/**
 * electron-builder 自定义签名钩子（Z4-B2）。
 * 挂接方式：package.mjs 在检测到 FD_SIGN_* 配置时追加
 *   --config.win.signtoolOptions.sign=./scripts/sign-hook.cjs
 * （electron-builder 26 的 resolveFunction 对字符串模块路径做动态导入，default 导出即钩子函数；
 *   签名发生在 electron-builder 计算 blockmap/latest.yml 之前——产物哈希与差分更新不受影响。）
 *
 * 凭据经环境变量注入（不落盘、不入 git）：
 *   FD_SIGN_PFX + FD_SIGN_PFX_PASSWORD   —— PFX 文件路径 + 密码
 *   FD_SIGN_CERT_THUMBPRINT              —— 证书存储（CurrentUser\My）内按 SHA-1 指纹选取
 *   FD_SIGN_TIMESTAMP_URL                —— RFC3161 时间戳服务器，默认 DigiCert
 *
 * 签名实现：@electron/windows-sign（随 electron-builder 依赖分发，内置 vendor/signtool.exe，
 * 无需安装 Windows SDK）。SHA-1 已弃用：钩子内跳过 sha1 轮次，只做 sha256。
 */
const { sign } = require('@electron/windows-sign');

module.exports = async function forgeStudioSign(configuration) {
  if (configuration.hash === 'sha1') return; // SHA-1 自 2016 起 Windows 弃用，只签 sha256
  const file = configuration.path;
  const opts = {
    files: [file],
    hashes: ['sha256'],
    timestampServer: process.env.FD_SIGN_TIMESTAMP_URL ?? 'http://timestamp.digicert.com',
  };
  if (process.env.FD_SIGN_PFX) {
    opts.certificateFile = process.env.FD_SIGN_PFX;
    opts.certificatePassword = process.env.FD_SIGN_PFX_PASSWORD;
  } else if (process.env.FD_SIGN_CERT_THUMBPRINT) {
    opts.signWithParams = ['/sha1', process.env.FD_SIGN_CERT_THUMBPRINT];
    opts.automaticallySelectCertificate = false;
  } else {
    throw new Error('[sign-hook] FD_SIGN_PFX / FD_SIGN_CERT_THUMBPRINT 均未配置：钩子不应被调用');
  }
  console.log(`[sign-hook] Authenticode 签名（sha256）→ ${file}`);
  await sign(opts);
};
