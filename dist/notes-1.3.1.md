## dsh-session-delete 1.3.1 — 删除的会话不再死灰复活

1.3.0 把「藏起来」交给了浏览器：宿主记墓碑，浏览器读墓碑、订阅会话目录、每次变化后再剔一次。删除当下确实生效，但**下一次完整拉取**（刷新页面、重连、宿主在另一条连接上重算目录）会从 `session.list` 重建基线 —— 浏览器只看得见自己观察到的变化，拦不住一次从没见过的 pull，行就又回来了。

1.3.1 把遮挡点前移到宿主，也就是列表的源头：

- **宿主过滤自己的会话列表**：`installCatalogFilter()` 在 `sessionQuery.listSessions` 上包一层（`ApiSessionList.list()` 正是从它取记录），墓碑 id 直接从返回结果里滤掉 —— 任何浏览器、刷新多少次、有没有订阅到帧，都不会再列出被删的会话，也不会再出现「未分组」幽灵行。
- **浏览器半双保险**：保留 `handleSessionRemoved` 的即时剔除，另加 1.5s 轮询兜底（只在墓碑集非空时工作），即使订阅缺失或某帧丢了也不会静默失效。
- **可观测**：`GET /session-delete/api/tombstones` 新增 `filter: { installed, wrapped, note }`；右键「诊断会话目录」会打印宿主的过滤状态与浏览器兜底的计数（installed / subscribed / polls / drops）。
- 删除流程、墓碑文件、1.2.3 遗留回收与 1.3.0 相同：unpin → 必要时 unarchive → 逐工作区 detach → 删日志 / 回退快照 / 投影缓存 → 写墓碑 → 广播 `api-session/removed`。

### 测试

```
node tests/delete-session.test.mjs   # 60 项断言
node tests/reload.test.mjs           # 7 项断言
```

新增断言：过滤器装入、结果里滤掉墓碑 id、重复装入不重复包裹、卸载后还原、`sessionQuery` 缺失时降级上报。

### 安装

```
dsh plugin add dsh-session-delete-1.3.1.tgz   # 或解压 zip 后 link
```

**升级后需要重启 DSH**：宿主过滤器在插件 `apply()` 时安装，进程内热重载只替换删除实现、不会重跑 `apply()`。
