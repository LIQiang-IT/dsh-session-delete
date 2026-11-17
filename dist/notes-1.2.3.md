修掉「删除会话后在侧栏跳到未分组、再删一次提示未找到磁盘数据」的 BUG。

**根因（两个缺陷叠加）**
1. 客户端 `reconcileCatalog()` 先 `sessions.handleSessionRemoved()` 再 `sessions.refresh()`；而 `ClientSessions.refreshList()` 一进来就把 mutation 日志重置（`this.listMutations = mutations`），刚记下的 remove 被丢掉，宿主基线又把这行加回来。
2. DSH 没有公开的“销毁会话”API：只要在 GUI 里打开过，会话就常驻 `ctx.sessions`（`enter()` 的 detach 闭包只交给 agent-loop，`AgentHandle.dispose` 在 API 会话控制器里被丢弃），`session.list` 永远报它。于是“已从工作区 detach + 磁盘已删”的行以“无工作区归属”身份出现在未分组。

**修复**
- 客户端顺序改为：立即 remove → refresh 重拉基线 → 再 remove 一次（保证 remove 落在新 mutation 数组之上）。
- 宿主 `forgetInRegistry()` 顺序改为 unpin → `registry.archiveSession(id, { stopActivity: true })` → detach 工作区；**不再** `unarchiveSession`。归档是侧栏默认隐藏的持久标记（`ArchivedFilter = 'hide'`），宿主重启前不会再出现未分组幽灵行。
- 确认弹窗在留下墓碑时显示一行说明；README 增加“为什么留一个归档墓碑”一节。

**代价**：本宿主进程生命周期内，切到“显示已归档”会看到一条不可打开的灰行；`workspace.json` 的 `archivedSessionIds` 会保留该 id（重启后为惰性条目）。

**测试**
- `node tests/delete-session.test.mjs` 46 项、`node tests/reload.test.mjs` 7 项全 PASS。
- 新增断言：写墓碑（带 `stopActivity: true`）、**从不** unarchive、报告 `registry.archived/detached`。

## 安装
1. 下载 `dsh-session-delete-1.2.3.zip` 解压，或 `git clone https://github.com/LIQiang-IT/dsh-session-delete.git`
2. 在 DSH 的插件管理里用 `install_bundle` 指向该目录，重启 DSH 一次，刷新 Web UI

卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 移除条目，重装依赖并重启。
