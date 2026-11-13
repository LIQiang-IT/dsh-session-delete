维护性更新，功能与 v1.2.0 相同。

**修复**
- `tests/reload.test.mjs` 改为正则匹配版本号，不再把 `const VERSION = '1.2.0'` 写死；以后升版本不会出现假失败。

**其它**
- `index.js` 的 `VERSION` 常量与 `package.json` 同步为 1.2.1。
- README 增加分发说明：本插件通过 GitHub 仓库与 Release 的 zip/tgz 分发，**未发布到 npm**（npm 上 `dsh-session-delete` 已被他人占用，且 npm 发版要求账号启用 2FA）。

## 安装
1. 下载 `dsh-session-delete-1.2.1.zip` 解压，或 `git clone https://github.com/LIQiang-IT/dsh-session-delete.git`
2. 在 DSH 的插件管理里用 `install_bundle` 指向该目录，重启 DSH 一次，刷新 Web UI

卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 移除条目，重装依赖并重启。