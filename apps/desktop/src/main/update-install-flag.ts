/**
 * 更新安装退出标记（共享状态模块）：
 * quitAndInstall 需要自然完成 quit 以启动安装器；will-quit 的优雅收尾拦截
 * （preventDefault + 异步 dispose + app.exit）会抢先终止进程导致安装器不启动。
 * 独立模块避免 auto-updater ↔ index 循环依赖（打包后 require 源路径不可用）。
 */
let installing = false;

export function markInstallingUpdate(): void {
  installing = true;
}

export function isInstallingUpdate(): boolean {
  return installing;
}
