# dsh-session-delete

[DeepSeek Harness](https://github.com/deepseek-ai) 插件：在会话右键菜单的 **归档会话** 之后追加 **删除会话**，永久删除该会话的日志、回退快照、投影缓存、工作区登记、定时任务与索引行。

> Adds a permanent **Delete session** action right after **Archive session** in the session context menu, and removes every artifact the Host keeps for that Session. MIT licensed.

- 版本：1.2.3
- 分发：GitHub 仓库 + Release 里的 zip/tgz（未发布到 npm：npm 上 `dsh-session-delete` 已被他人占用，且发布需要账号 2FA）
- 宿主侧提供同名 Agent 工具 `session_delete({ sessionId, dryRun })` 与 HTTP 接口，浏览器里点右键菜单和 Agent 调用走同一套删除实现。
- 删除后宿主广播 `api-session/removed`，侧栏那一行立即消失，无需刷新；同时把该 id 写进归档集合当墓碑，防止宿主内存里仍存活的会话行在下次列表时以“未分组”身份复活（见下）。
- 共享附件（`attachments/v1/objects/<sha>`）按内容寻址、多会话共用，**刻意不删**。

## 删除范围

| 类别 | 位置 |
| --- | --- |
| 会话日志 | `$DSH_HOME/sessions/<projectKey>/<id>` 与历史命名 `session-<id>`（两种命名都会扫） |
| 回退快照 | `$DSH_HOME/rewind-snapshots/{<id>,session-<id>}` |
| 投影缓存 | `$DSH_HOME/storages/session_projcache/sessions/{<id>,session-<id>}.json`（含 `.json.tmp`、`.tmp` 残留） |
| 注册表 | `storages/workspace.json` 中的 sessionIds（工作区成员）、pinnedSessionIds（置顶）；archivedSessionIds 不清理，反而写入该 id 作**墓碑**（见下节） |
| 定时任务 | `target.kind` 为 `session`（投递进该会话）或 `new_once`（预留了该会话身份、会话没了就永远无法投递）的任务，经 `schedule.edit({ id, action: 'delete' })` 正式删除（不改文件） |
| 聊天索引 | `$DSH_HOME/bot/chat-index.sqlite` 的 `lines`(FTS5) 与 `marks` 表，`session = <id>` 与 `session = session-<id>` 两种键 |
| 用量账本 | `$DSH_HOME/bot/usage.sqlite` 的 `calls` / `marks` / `owners` / `kinds` 表，同样两种键 |
| 运行状态 | 先 `sessionController.cancel` + `workspace/session-stop` 停掉正在跑的回合，等 120 ms 释放句柄再删文件 |

刻意**不动**的东西：

- `attachments/v1/objects/<sha>` —— 内容寻址、多会话共享，按会话删会误伤别的会话。
- `storages/workspace.json` 里其它会话、`schedule.json` 里其它任务、两个 sqlite 里其它会话的行 —— 测试里有对照组断言。
- `integrations/dsh-im/group-history.sqlite` —— IM 群历史，与会话无关。

## 使用

- 侧栏会话行右键 → **删除会话**（危险色，位于“归档会话”之后）→ 确认弹窗显示会话标题，执行后列出删除的路径与字节数、被删的定时任务、被清理的索引行数、失败项、备注。
- 删除成功后宿主广播 `api-session/removed`，侧栏那一行**立即消失**，不需要刷新页面（客户端先 `sessions.handleSessionRemoved()` 移除，再 `sessions.refresh()` 重拉基线，**最后再移除一次**兜底）。
- Agent 工具 `session_delete({ sessionId, dryRun })`：同一套逻辑，`dryRun=true` 只列出将被删除的路径、任务与索引行数。
- HTTP（客户端走这条通道，带 `connection.requestRejection` 请求栅栏；Host 没有该服务时退化为 `Sec-Fetch-Site` + `Origin`/`Host` 同源校验）：
  - `GET /session-delete/api/health` —— 宿主半的加载状态（见下）
  - `GET /session-delete/api/preview?sessionId=...`
  - `POST /session-delete/api/delete` `{ "sessionId": "...", "dryRun": false }`

会话 ID 只接受 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，`../`、绝对路径、空串一律拒绝。

## 为什么留一个归档墓碑（1.2.3）

DSH 没有“销毁会话”的公开 API：`ctx.sessions` 只提供 create/prepare/enter/announce/get/list/fork，唯一能把会话从内存里移除的路径是 `enter()` 返回的 detach 闭包（由 agent-loop 的 teardown 持有，而 API 会话控制器 `resumeObserved` 拿到的 `AgentHandle.dispose` 被丢掉了）。因此**任何在 GUI 里打开过、提问过的会话都会常驻宿主进程直到进程退出**，`session.list` 每次都把它报回来。

只要它在列表里、又不属于任何工作区，侧栏就会按“未分组”渲染（`dsh-client-ui-workspace` 的 `owningGroupKey()` 找不到工作区就回落到 `UNGROUPED_KEY`）。这正是 1.2.2 的 BUG：

1. `forgetInRegistry` 先把会话从工作区 detach 掉，再删磁盘；
2. 客户端 `handleSessionRemoved()` 之后紧接着 `refresh()`，而 `ClientSessions.refreshList()` 开头就把 mutation 日志重置，刚记下的 remove 被丢掉，基线又把它加回来；
3. 于是一行没有工作区归属的幽灵出现在“未分组”，再删一次只剩“未找到磁盘数据，只清理了工作区记录”。

1.2.3 的处理：

- 注册表清理顺序改为 **unpin → archive（墓碑）→ detach**，归档先落盘，所以中间任何一次快照都不会把它渲染成“未分组”；
- 客户端顺序改为 **restore 立即移除 → refresh 重拉基线 → 再移除一次**；
- 墓碑利用的是侧栏的既有语义：`ArchivedFilter = 'hide'` 是默认值，归档行默认不显示、也不可打开。宿主重启后该 id 既不在磁盘、也不在内存里，列表里根本没有它的 summary，墓碑变成惰性条目（不会显示）。
- 代价：在这一个宿主进程的生命周期内，如果把侧栏切到“显示已归档”，会看到一条不可打开的灰行；磁盘上 `workspace.json` 的 `archivedSessionIds` 会保留这个 id。


## 安装

需要 DeepSeek Harness，Node.js ≥ 22.5（用到 `node:sqlite`；DSH 自带 Node 24）。

```bash
git clone https://github.com/LIQiang-IT/dsh-session-delete.git
```

然后在 DSH 里用 **插件管理 / plugin_manager 的 `install_bundle`** 指向克隆下来的目录安装（不要手改 profile 的 `package.json`）。首次安装后需要重启一次 DSH 进程（`restartReason: package-moved`），再刷新一次 Web UI 让 `client.js` 生效。

手动兜底（仅在插件管理不可用时）：在 profile 的 `package.json` 里加依赖 `"dsh-session-delete": "file:<克隆目录的绝对路径>"`，并把 `"dsh-session-delete"` 加进 `dsh.profile.bundles`，重新安装依赖后重启 DSH。

卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 移除该条目，重装依赖并重启；插件不在磁盘上留私货。

## 宿主侧改动即时生效（dev loop）

宿主进程只在启动时 import 一次插件模块，而 DSH 的 HMR 监视器忽略 `node_modules`，所以正常改完 `index.js` 必须重启。本插件自己解决这个问题：

- `apply()` 里启动了源文件监视器（`node:fs` 的 `watch`，只看同目录的 `index.js`，300 ms 防抖）。
- 文件变化后以 `import(路径 + '?v=<时间戳>')` 重新导入自己，把新的 `deleteSession()` 换进 `status.impl`，HTTP 路由与 `session_delete` 工具都通过 `status.impl` 间接调用，因此**行为立即跟着源码走**。
- 重新导入失败（语法错误等）时不替换旧实现，把错误记在 `status.lastReloadError`，仍用旧代码继续服务。
- `GET /session-delete/api/health` 返回：`version`、`generation`（重载次数）、`loadedAt`/`reloadedAt`、`loadedModuleMtimeMs`/`diskModuleMtimeMs`、`stale`、`lastReloadError`。
- 客户端在确认弹窗打开时读一次 health；若 `stale === true` 或有 `lastReloadError`，弹窗顶部用危险色提示“宿主插件仍在跑旧代码”，避免在不知情的情况下以为改的东西已经生效。
- 只有**首次安装**（bundle 尚未进入进程）需要重启一次；此后改 `index.js` 不用重启。

客户端 `client.js` 属于浏览器侧模块：宿主会 stat 轮询客户端包入口文件并通过 `/plugins/events` 推送 rebuilt 帧，正常情况下开着的页面会自动热替换；若没换过来，刷新一次 Web UI（Ctrl+R）即可。

## 测试

```bash
node tests/delete-session.test.mjs   # 46 项断言（scratch DSH_HOME，不碰真实数据）
node tests/reload.test.mjs          # 7 项断言
npm test
```

- `tests/delete-session.test.mjs`：非法 id 拒绝、`dryRun` 不落盘且只列出待删任务、5 类磁盘目标删除、注册表清理（unpin → archive 墓碑 → detach，且断言**从不** unarchive）、定时任务真删、两个 sqlite 的按 id 清理、对照组（keep 会话）全部保留、重复删除幂等。
- `tests/reload.test.mjs`：挂载路由、health 初始状态、改文件后自动换模块（`generation` 变 1、`version` 变新值）、无重载错误、卸载释放路由。

测试全部在 `mkdtemp` 出来的临时 `DSH_HOME` 里跑，不读写真机数据。

## 结构

- `index.js` — 宿主：HTTP 路由（`/health`、`/preview`、`/delete`）、`session_delete` 工具、删除编排（`deleteSession()` 是唯一实现）、自热重载与健康检查。
- `client.js` — 客户端：会话右键菜单项 + 确认弹窗（`shell.overlay`，零 Harness 依赖，只用 `react`）。
- `locale/{zh,en}.json` — 插件显示元数据；界面文案在 `client.js` 内注册到 locale 服务（`ctx.locale.register`）。

## 安全

- 会话 ID 先过 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，显式拒绝 `.` 与 `..`，用户输入不参与路径拼接。
- 所有目标路径都由 `join(DSH_HOME, …)` 构造，只落在这五类位置；存在性检查用 `lstat`（不跟随符号链接）。
- 不删除 `attachments`（内容寻址共享），不猜测未知目录。
- `dryRun` 完全只读：只列出目标，不写磁盘、不发事件。

## License

[MIT](./LICENSE) © 2026 LIQiang-IT
