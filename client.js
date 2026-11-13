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
				'dialog.description': '将永久删除“{title}”的一切相关数据：会话日志、回退快照、投影缓存，以及它在工作区、归档和置顶中的记录。共享附件不受影响。此操作不可撤销。',
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
				'dialog.close': '关闭',
			},
			en: {
				'menu.deleteSession': 'Delete session',
				'dialog.title': 'Delete session',
				'dialog.description': 'This permanently deletes “{title}” and everything stored for it: the session log, rewind snapshots, the projection cache, and its workspace, archive and pin records. Shared attachments are unaffected. This cannot be undone.',
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
				'dialog.close': 'Close',
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
		 * Drop the deleted Session from the live catalog and re-pull the Host
		 * baseline, so the sidebar row disappears without a page reload.
		 */
		function reconcileCatalog(ctx, sessionId) {
			const sessions = ctx.get('sessions')
			if (!sessions || typeof sessions !== 'object') return
			try {
				if (typeof sessions.handleSessionRemoved === 'function') sessions.handleSessionRemoved(sessionId)
			} catch (error) {
				console.error('dsh-session-delete: handleSessionRemoved failed', error)
			}
			try {
				const pending = typeof sessions.refresh === 'function' ? sessions.refresh() : undefined
				if (pending && typeof pending.catch === 'function') pending.catch(() => {})
			} catch (error) {
				console.error('dsh-session-delete: list refresh failed', error)
			}
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
							reconcileCatalog(ctx, request.sessionId)
							setReport(result)
							setPhase('done')
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

				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'dsh-session-delete.dialog',
				}, DeleteSessionDialog))

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
			},
		}
	},
})
