/**
 * Web client half: a "Delete session" row right after the built-in "Archive
 * session" row (same footer group, higher order), plus its confirmation dialog.
 *
 * The row only collects a request; the destructive work runs in the Host over
 * the `/session-delete/api/delete` route so the same routine also backs the
 * `session_delete` agent tool. Controls are hand-built from theme tokens: a
 * plain-JS plugin must not import Harness Client packages.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		const NS = 'dsh-session-delete'
		const DELETE_ENDPOINT = 'session-delete/api/delete'
		const HEALTH_ENDPOINT = 'session-delete/api/health'

		const dictionaries = {
			zh: {
				'menu.deleteSession': '删除会话',
				'dialog.title': '删除会话',
				'dialog.description': '将永久删除“{title}”的一切相关数据：会话日志、回退快照、投影缓存，以及它在工作区与置顶中的记录。共享附件不受影响。此操作不可撤销。',
				'dialog.descriptionDone': '“{title}”已删除。',
				'dialog.target': '会话 ID：{id}',
				'dialog.cancel': '取消',
				'dialog.confirm': '永久删除',
				'dialog.working': '正在删除…',
				'dialog.done': '已删除 {count} 项，共 {size}。',
				'dialog.none': '未找到该会话的磁盘数据，只清理了工作区记录。',
				'dialog.failed': '删除未完全成功：{message}',
				'dialog.scheduleDeleted': '已删除指向它的定时任务：{title}',
				'dialog.indexPurged': '已从 {store} 索引清理 {count} 行',
				'dialog.hostStale': '宿主插件仍在跑旧代码（{reason}）。重启 DSH 前，这里的删除行为可能与源码不一致。',
				'dialog.hidden': '已把它挡在侧栏目录之外：宿主重启前该会话仍驻留内存，插件会持续把它从列表里剔除。',
				'dialog.unarchived': '顺带清理了 1.2.3 留下的归档标记：{ids}',
				'dialog.close': '关闭',
				'menu.diagnose': '诊断会话目录',
				'diag.title': '会话目录诊断',
				'diag.intro': '下面是客户端此刻持有的会话目录与工作区快照，用来定位“未分组”里多出来的行。只读，不会改动任何数据。',
				'diag.refresh': '重新读取',
				'diag.close': '关闭',
			},
			en: {
				'menu.deleteSession': 'Delete session',
				'dialog.title': 'Delete session',
				'dialog.description': 'This permanently deletes “{title}” and everything stored for it: the session log, rewind snapshots, the projection cache, and its workspace and pin records. Shared attachments are unaffected. This cannot be undone.',
				'dialog.descriptionDone': '“{title}” was deleted.',
				'dialog.target': 'Session ID: {id}',
				'dialog.cancel': 'Cancel',
				'dialog.confirm': 'Delete permanently',
				'dialog.working': 'Deleting…',
				'dialog.done': 'Removed {count} item(s), {size} in total.',
				'dialog.none': 'No files were found on disk; only the workspace records were cleaned.',
				'dialog.failed': 'Deletion did not fully succeed: {message}',
				'dialog.scheduleDeleted': 'Deleted the scheduled task aimed at it: {title}',
				'dialog.indexPurged': 'Removed {count} row(s) from the {store} index',
				'dialog.hostStale': 'The Host plugin is still running older code ({reason}). Until DSH restarts, this delete may not match the sources on disk.',
				'dialog.hidden': 'Kept out of the sidebar catalog: until the Host restarts it still holds this Session in memory, and the plugin keeps dropping the row from the list.',
				'dialog.unarchived': 'Also cleared the archive marker that 1.2.3 left behind: {ids}',
				'dialog.close': 'Close',
				'menu.diagnose': 'Diagnose session catalog',
				'diag.title': 'Session catalog diagnosis',
				'diag.intro': 'The Session catalog and Workspace snapshot this browser holds right now, for tracking down extra "Ungrouped" rows. Read-only; nothing changes.',
				'diag.refresh': 'Read again',
				'diag.close': 'Close',
			},
		}

		const cardStyle = {
			width: 'min(460px, calc(100vw - 32px))',
			maxHeight: 'calc(100vh - 64px)',
			overflow: 'auto',
			boxSizing: 'border-box',
			padding: '18px 20px 14px',
			borderRadius: '12px',
			border: '0.5px solid var(--dsw-alias-border-l1)',
			background: 'var(--dsw-alias-bg-overlay)',
			color: 'var(--dsw-alias-label-primary)',
			boxShadow: '0 16px 40px rgba(0, 0, 0, 0.28)',
			fontSize: '13px',
			lineHeight: '1.55',
		}

		const scrimStyle = {
			position: 'fixed',
			inset: 0,
			zIndex: 1000,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			background: 'rgba(0, 0, 0, 0.32)',
		}

		function buttonStyle(danger, disabled) {
			return {
				height: '32px',
				padding: '0 14px',
				borderRadius: '8px',
				border: '0.5px solid ' + (danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'),
				background: 'transparent',
				color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
				fontFamily: 'inherit',
				cursor: disabled ? 'not-allowed' : 'pointer',
				opacity: disabled ? 0.5 : 1,
			}
		}

		function Button({ children, onClick, danger = false, disabled = false, autoFocus = false }) {
			return h('button', {
				type: 'button',
				onClick,
				disabled,
				autoFocus,
				style: buttonStyle(danger, disabled),
			}, children)
		}

		function Dialog({ title, description, footer, onClose, closeLabel, children }) {
			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key === 'Escape') {
						event.stopPropagation()
						onClose()
					}
				}
				document.addEventListener('keydown', onKeyDown, true)
				return () => { document.removeEventListener('keydown', onKeyDown, true) }
			}, [onClose])
			return h('div', {
				style: scrimStyle,
				onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
			}, h('div', {
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': title,
				style: cardStyle,
			}, [
				h('div', {
					key: 'title',
					style: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' },
				}, title),
				description === undefined ? null : h('p', {
					key: 'description',
					style: { margin: '0 0 10px', color: 'var(--dsw-alias-label-secondary)' },
				}, description),
				h('div', { key: 'body' }, children),
				h('div', {
					key: 'footer',
					style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' },
				}, footer),
				h('span', { key: 'close', hidden: true }, closeLabel),
			]))
		}

		let pendingRequest = null
		const listeners = new Set()

		function publish(next) {
			pendingRequest = next
			for (const listener of listeners) listener()
		}

		function useDeleteRequest() {
			const [request, setRequest] = React.useState(pendingRequest)
			React.useEffect(() => {
				const listener = () => setRequest(pendingRequest)
				listeners.add(listener)
				return () => { listeners.delete(listener) }
			}, [])
			return request
		}

		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
			const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
			let value = bytes
			let unit = 0
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024
				unit += 1
			}
			return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
		}

		/**
		 * Ask the Host half whether it is running the code currently on disk.
		 * The Host reloads itself on edit, so this only reports a real failure.
		 */
		async function requestHealth() {
			try {
				const response = await fetch(new URL(HEALTH_ENDPOINT, document.baseURI).href, { cache: 'no-store' })
				if (!response.ok) return null
				return await response.json()
			} catch {
				return null
			}
		}

		async function requestDelete(sessionId) {
			const response = await fetch(new URL(DELETE_ENDPOINT, document.baseURI).href, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId }),
			})
			const payload = await response.json().catch(() => undefined)
			if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
			return payload
		}

		/**
		 * The Host cannot evict a Session that is still resident in memory, so a
		 * deleted Session keeps showing up in `session.list` until DSH restarts.
		 * The Host therefore records every delete in a tombstone file, and this
		 * browser half keeps those rows out of the catalog.
		 *
		 * One removal is not enough: `ClientSessions.refresh()` resets its
		 * mutation log (`this.listMutations = mutations`) before it re-baselines
		 * from `session.list`, so the row returns after a page reload, a
		 * reconnect, or any Host push. Re-dropping on every catalog update is
		 * what makes the row stay gone.
		 */
		const TOMBSTONE_ENDPOINT = 'session-delete/api/tombstones'
		let tombstoned = new Set()
		let tombstoneGuard = null
		let hostFilter = null

		async function requestTombstones() {
			const response = await fetch(new URL(TOMBSTONE_ENDPOINT, document.baseURI).href, { cache: 'no-store' })
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const payload = await response.json()
			const ids = Array.isArray(payload && payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
			const unarchived = Array.isArray(payload && payload.unarchived) ? payload.unarchived.filter((id) => typeof id === 'string') : []
			const filter = payload && payload.filter && typeof payload.filter === 'object' ? payload.filter : null
			return { ids, unarchived, filter }
		}

		/** Remove one row from the live catalog, if the row is still there. */
		function dropCatalogRow(ctx, sessionId) {
			const sessions = ctx.get('sessions')
			if (!sessions || typeof sessions.handleSessionRemoved !== 'function') return false
			const snapshot = snapshotOf(sessions.list)
			if (snapshot !== undefined && snapshot.byId !== undefined && snapshot.byId[sessionId] === undefined) return false
			try {
				sessions.handleSessionRemoved(sessionId)
				return true
			} catch (error) {
				console.error('dsh-session-delete: handleSessionRemoved failed', error)
				return false
			}
		}

		/** Re-drop tombstoned rows whenever the catalog changes, and on a slow poll. */
		function installCatalogGuard(ctx) {
			if (tombstoneGuard !== null) return tombstoneGuard
			const guard = { installed: false, subscribed: false, polling: false, polls: 0, drops: 0, timer: null, interval: null }
			tombstoneGuard = guard
			const sweep = () => {
				guard.polls += 1
				for (const id of tombstoned) {
					if (dropCatalogRow(ctx, id)) guard.drops += 1
				}
			}
			const sessions = ctx.get('sessions')
			const store = sessions === undefined ? undefined : sessions.list
			if (store !== undefined && typeof store.subscribe === 'function') {
				guard.subscribed = true
				store.subscribe(() => {
					if (guard.timer !== null) return
					// Sweep after the store settles: handleSessionRemoved writes it too.
					guard.timer = setTimeout(() => {
						guard.timer = null
						sweep()
					}, 0)
				})
			}
			// A subscription is not enough on its own: the catalog can be rebuilt
			// from a fresh Host pull that this browser half never observes, and the
			// store's own subscribe may be missing. Re-dropping on a slow poll while
			// any tombstone exists keeps the row gone in every case.
			guard.interval = setInterval(sweep, 1500)
			ctx.effect(() => () => {
				if (guard.interval !== null) clearInterval(guard.interval)
				guard.interval = null
			}, 'dsh-session-delete: tombstone poll')
			guard.polling = true
			guard.installed = true
			return guard
		}

		/** Read the Host tombstone list, then drop every row it names. */
		async function refreshTombstones(ctx) {
			try {
				const { ids, unarchived, filter } = await requestTombstones()
				tombstoned = new Set(ids)
				hostFilter = filter
				installCatalogGuard(ctx)
				for (const id of ids) dropCatalogRow(ctx, id)
				return { ids, unarchived }
			} catch (error) {
				console.error('dsh-session-delete: tombstone fetch failed', error)
				return { ids: [], unarchived: [] }
			}
		}

		/** Right after a delete: forget the row locally and sync with the Host list. */
		function rememberDeleted(ctx, sessionId) {
			tombstoned.add(sessionId)
			installCatalogGuard(ctx)
			dropCatalogRow(ctx, sessionId)
			return refreshTombstones(ctx)
		}

		let pendingDiagnosis = null
		const diagnosisListeners = new Set()

		function publishDiagnosis(next) {
			pendingDiagnosis = next
			for (const listener of diagnosisListeners) listener()
		}

		function useDiagnosis() {
			const [request, setRequest] = React.useState(pendingDiagnosis)
			React.useEffect(() => {
				const listener = () => setRequest(pendingDiagnosis)
				diagnosisListeners.add(listener)
				return () => { diagnosisListeners.delete(listener) }
			}, [])
			return request
		}

		function snapshotOf(source) {
			try {
				if (source === undefined || source === null || typeof source.getSnapshot !== 'function') return undefined
				return source.getSnapshot()
			} catch (error) {
				console.error('dsh-session-delete: snapshot read failed', error)
				return undefined
			}
		}

		function summaryLine(summary) {
			if (summary === undefined || summary === null) return 'summary=missing'
			return 'title=' + String(summary.displayTitle ?? summary.title ?? '?')
				+ ' blank=' + String(summary.blank === true)
				+ ' origin=' + String(summary.origin ?? 'user')
				+ ' cwd=' + String(summary.cwd ?? '-')
		}

		/**
		 * Read-only dump of the two client snapshots the sidebar composes from.
		 *
		 * The sidebar derives a row's group by "is any Workspace accounting for
		 * this id", and hides rows whose id is in the registry archive set. A row
		 * that shows under "未分组" therefore has an id absent from
		 * `workspaces.list.archivedSessionIds` — this dump makes that visible.
		 */
		function buildDiagnostics(ctx, sessionId) {
			const lines = []
			const sessions = ctx.get('sessions')
			const workspaces = ctx.get('workspaces')
			const list = sessions === undefined ? undefined : snapshotOf(sessions.list)
			const views = workspaces === undefined ? undefined : snapshotOf(workspaces.list)
			const ids = list !== undefined && Array.isArray(list.ids) ? list.ids : []
			const byId = list !== undefined && list.byId !== null && typeof list.byId === 'object' ? list.byId : {}
			const items = views !== undefined && Array.isArray(views.items) ? views.items : []
			const archived = views !== undefined && Array.isArray(views.archivedSessionIds) ? views.archivedSessionIds : []
			const pinned = views !== undefined && Array.isArray(views.pinnedSessionIds) ? views.pinnedSessionIds : []
			lines.push('session: ' + sessionId)
			lines.push('services: sessions=' + String(sessions !== undefined) + ' workspaces=' + String(workspaces !== undefined))
			lines.push('list.phase: ' + (list === undefined ? 'missing' : String(list.phase)))
			lines.push('list.ids: ' + String(ids.length) + ' contains=' + String(ids.includes(sessionId)))
			lines.push('target ' + summaryLine(byId[sessionId]))
			lines.push('workspace.phase: ' + (views === undefined ? 'missing' : String(views.phase) + ' state=' + String(views.state)))
			lines.push('archived: ' + String(archived.length) + ' contains=' + String(archived.includes(sessionId)))
			lines.push('pinned: ' + String(pinned.length) + ' contains=' + String(pinned.includes(sessionId)))
			const tombstoneIds = [...tombstoned]
			lines.push('tombstones: ' + String(tombstoneIds.length) + ' contains=' + String(tombstoned.has(sessionId)))
			for (const id of tombstoneIds.slice(0, 20)) lines.push('  - ' + id)
			const guard = tombstoneGuard
			lines.push('guard: installed=' + String(guard !== null && guard.installed === true)
				+ ' subscribed=' + String(guard !== null && guard.subscribed === true)
				+ ' polls=' + String(guard === null ? 0 : guard.polls)
				+ ' drops=' + String(guard === null ? 0 : guard.drops))
			lines.push('host filter: ' + (hostFilter === null
				? 'unknown'
				: 'installed=' + String(hostFilter.installed === true)
					+ ' wrapped=' + String(hostFilter.wrapped ?? 0)
					+ ' note=' + String(hostFilter.note || '-').slice(0, 160)))
			let viewStore = null
			try {
				viewStore = window.localStorage.getItem('dsh.workspace.view.v5')
			} catch (error) {
				viewStore = null
			}
			lines.push('view store: ' + (viewStore === null ? 'missing' : viewStore.slice(0, 400)))
			lines.push('workspaces: ' + String(items.length))
			const accounted = new Set()
			for (const item of items) {
				const members = Array.isArray(item.sessionIds) ? item.sessionIds : []
				for (const member of members) accounted.add(member)
				lines.push('  - ' + String(item.title) + ' [' + String(item.path) + '] members=' + String(members.length) + ' has=' + String(members.includes(sessionId)))
			}
			const archivedSet = new Set(archived)
			const strays = ids.filter((id) => !accounted.has(id))
			lines.push('ungrouped candidates: ' + String(strays.length))
			for (const id of strays.slice(0, 40)) {
				lines.push('  * ' + id + ' archived=' + String(archivedSet.has(id)) + ' ' + summaryLine(byId[id]))
			}
			if (strays.length > 40) lines.push('  … ' + String(strays.length - 40) + ' more')
			return lines.join('\n')
		}

		return {
			inject: ['slots', 'contextMenus', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-session-delete: dictionaries')
				const t = ctx.locale.bind(NS)

				function DeleteSessionForm({ request }) {
					const [phase, setPhase] = React.useState('idle')
					const [report, setReport] = React.useState(null)
					const [error, setError] = React.useState(null)
					const busy = phase === 'working'
					const settle = () => { if (!busy) publish(null) }
					const [hostNote, setHostNote] = React.useState(null)
					const [cleared, setCleared] = React.useState(null)
					React.useEffect(() => {
						let cancelled = false
						requestHealth().then((payload) => {
							if (cancelled || payload === null || typeof payload !== 'object') return
							const failure = typeof payload.lastReloadError === 'string' ? payload.lastReloadError : null
							if (payload.stale !== true && failure === null) return
							setHostNote(t('dialog.hostStale', { reason: failure === null ? 'source changed after load' : failure }))
						})
						return () => { cancelled = true }
					}, [])
					const confirm = () => {
						setPhase('working')
						setError(null)
						requestDelete(request.sessionId).then((result) => {
							setReport(result)
							setPhase('done')
							rememberDeleted(ctx, request.sessionId).then((swept) => {
								if (swept.unarchived.length > 0) setCleared(swept.unarchived)
							})
						}).catch((reason) => {
							setError(reason instanceof Error ? reason.message : String(reason))
							setPhase('error')
						})
					}

					const removed = report && Array.isArray(report.removed) ? report.removed : []
					const failed = report && Array.isArray(report.failed) ? report.failed : []
					const bytes = removed.reduce((total, entry) => total + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)

					const body = [h('div', {
						key: 'target',
						style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', wordBreak: 'break-all' },
					}, t('dialog.target', { id: request.sessionId }))]
					if (hostNote !== null) {
						body.push(h('div', {
							key: 'host',
							role: 'note',
							style: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
						}, hostNote))
					}
					if (busy) {
						body.push(h('div', {
							key: 'busy',
							role: 'status',
							style: { marginTop: '8px', color: 'var(--dsw-alias-label-secondary)' },
						}, t('dialog.working')))
					}
					if (phase === 'done') {
						body.push(h('div', {
							key: 'done',
							role: 'status',
							style: { marginTop: '8px', color: 'var(--dsw-alias-state-success-primary)' },
						}, removed.length > 0 ? t('dialog.done', { count: String(removed.length), size: formatBytes(bytes) }) : t('dialog.none')))
					}
					if (error !== null) {
						body.push(h('div', {
							key: 'error',
							role: 'alert',
							style: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary)' },
						}, t('dialog.failed', { message: error })))
					}
					if (failed.length > 0) {
						body.push(h('ul', {
							key: 'failed',
							style: { margin: '6px 0 0', paddingLeft: '18px', color: 'var(--dsw-alias-state-error-primary)' },
						}, failed.map((entry, index) => h('li', { key: `${entry.path}-${String(index)}` }, `${entry.path}: ${entry.error}`))))
					}

					const schedules = report && report.schedules && Array.isArray(report.schedules.deleted) ? report.schedules.deleted : []
					const indexStores = report && report.indexes && typeof report.indexes === 'object' ? report.indexes : {}
					const notes = report && Array.isArray(report.notes) ? report.notes : []
					const remarks = notes.slice()
					if (report && report.tombstone === true) remarks.push(t('dialog.hidden'))
					if (Array.isArray(cleared) && cleared.length > 0) remarks.push(t('dialog.unarchived', { ids: cleared.join(', ') }))
					for (const task of schedules) remarks.push(t('dialog.scheduleDeleted', { title: task.title }))
					for (const store of Object.keys(indexStores)) {
						const entry = indexStores[store]
						if (entry && typeof entry.deleted === 'number' && entry.deleted > 0) {
							remarks.push(t('dialog.indexPurged', { count: String(entry.deleted), store }))
						}
					}

					if (phase === 'done' && remarks.length > 0) {
						body.push(h('ul', {
							key: 'notes',
							style: { margin: '6px 0 0', paddingLeft: '18px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
						}, remarks.map((entry, index) => h('li', { key: `note-${String(index)}` }, entry))))
					}

					const footer = phase === 'done'
						? [h(Button, { key: 'close', onClick: settle, autoFocus: true }, t('dialog.close'))]
						: [
							h(Button, { key: 'cancel', onClick: settle, disabled: busy }, t('dialog.cancel')),
							h(Button, { key: 'confirm', onClick: confirm, disabled: busy, danger: true, autoFocus: true }, t('dialog.confirm')),
						]

					return h(Dialog, {
						title: t('dialog.title'),
						description: phase === 'done'
							? t('dialog.descriptionDone', { title: request.displayTitle })
							: t('dialog.description', { title: request.displayTitle }),
						footer,
						onClose: settle,
						closeLabel: t('dialog.close'),
					}, body)
				}

				function DeleteSessionDialog() {
					const request = useDeleteRequest()
					if (request === null) return null
					return h(DeleteSessionForm, { key: request.sessionId, request })
				}

				function DiagnoseSessionForm({ request }) {
					const [tick, setTick] = React.useState(0)
					const settle = () => { publishDiagnosis(null) }
					const text = React.useMemo(
						() => buildDiagnostics(ctx, request.sessionId),
						[request.sessionId, tick],
					)
					const body = [
						h('p', {
							key: 'intro',
							style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
						}, t('diag.intro')),
						h('pre', {
							key: 'text',
							style: {
								margin: 0,
								padding: '10px 12px',
								borderRadius: '8px',
								border: '0.5px solid var(--dsw-alias-border-l1)',
								background: 'var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08))',
								fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
								fontSize: '11px',
								lineHeight: '1.5',
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-all',
								maxHeight: '46vh',
								overflow: 'auto',
							},
						}, text),
					]
					const footer = [
						h(Button, { key: 'again', onClick: () => { setTick(tick + 1) } }, t('diag.refresh')),
						h(Button, { key: 'close', onClick: settle, autoFocus: true }, t('diag.close')),
					]
					return h(Dialog, {
						title: t('diag.title'),
						footer,
						onClose: settle,
						closeLabel: t('diag.close'),
					}, body)
				}

				function DiagnoseSessionDialog() {
					const request = useDiagnosis()
					if (request === null) return null
					return h(DiagnoseSessionForm, { key: request.sessionId, request })
				}

				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'dsh-session-delete.dialog',
				}, DeleteSessionDialog))

				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'dsh-session-delete.diagnosis',
				}, DiagnoseSessionDialog))

				ctx.effect(() => ctx.contextMenus.register({
					id: 'session.delete',
					target: 'session',
					order: 700,
					observe: () => [ctx.locale],
					resolve: (target) => {
						if (!target || typeof target.sessionId !== 'string') return []
						return [{
							id: 'deleteSession',
							label: t('menu.deleteSession'),
							icon: { key: 'workspace.delete' },
							separatorBefore: true,
							afterContent: true,
							danger: true,
							run: () => {
								publish({
									sessionId: target.sessionId,
									displayTitle: typeof target.displayTitle === 'string' ? target.displayTitle : target.sessionId,
								})
							},
						}]
					},
				}), 'dsh-session-delete: session menu')

				ctx.effect(() => ctx.contextMenus.register({
					id: 'session.diagnose',
					target: 'session',
					order: 701,
					observe: () => [ctx.locale],
					resolve: (target) => {
						if (!target || typeof target.sessionId !== 'string') return []
						return [{
							id: 'diagnoseSession',
							label: t('menu.diagnose'),
							afterContent: true,
							run: () => {
								publishDiagnosis({ sessionId: target.sessionId })
							},
						}]
					},
				}), 'dsh-session-delete: diagnose menu')

				// A browser that is already open (or just reloaded) has to learn the
				// tombstone list too, not only the browser that ran the delete.
				ctx.effect(() => {
					let timer = null
					let attempts = 0
					const tick = () => {
						timer = null
						if (tombstoneGuard !== null && tombstoneGuard.installed) return
						attempts += 1
						if (attempts > 20) return
						void refreshTombstones(ctx)
						timer = setTimeout(tick, Math.min(1000 * attempts, 5000))
					}
					void refreshTombstones(ctx)
					timer = setTimeout(tick, 1000)
					return () => { if (timer !== null) clearTimeout(timer) }
				}, 'dsh-session-delete: catalog guard')
			},
		}
	},
})
