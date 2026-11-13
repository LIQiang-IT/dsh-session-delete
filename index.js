/**
 * Permanently delete one Session and every artifact the Host keeps for it.
 *
 * The Host ships no Session delete API, so this plugin owns the whole
 * operation: stop the Session, drop it from the workspace registry (membership,
 * archive set, pin set), then remove the on-disk artifacts the Host created for
 * that Session — its durable log directory, its rewind snapshots and its
 * projection cache. Content-addressed attachments are shared between Sessions
 * and are deliberately left alone.
 */
import { statSync, watch } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-session-delete'
export const inject = ['webServer', 'tools']

export const VERSION = '1.2.0'
const ROUTE = '/session-delete'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_BODY_BYTES = 64 * 1024

class RequestError extends Error {
	constructor(message, status = 400) {
		super(message)
		this.status = status
	}
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error)
}

function assertSessionId(value) {
	if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
		throw new RequestError('sessionId must be a plain session identifier')
	}
	return value
}

async function exists(path) {
	try {
		await lstat(path)
		return true
	} catch {
		return false
	}
}

/** Total file count and byte size below one target, bounded by depth. */
async function measure(path) {
	let bytes = 0
	let files = 0
	const walk = async (current, depth) => {
		let info
		try {
			info = await lstat(current)
		} catch {
			return
		}
		if (!info.isDirectory()) {
			bytes += info.size
			files += 1
			return
		}
		if (depth > 6) return
		let entries = []
		try {
			entries = await readdir(current)
		} catch {
			return
		}
		for (const entry of entries) await walk(join(current, entry), depth + 1)
	}
	await walk(path, 0)
	return { bytes, files }
}

function homeFromLog(logPath) {
	return resolve(dirname(dirname(dirname(dirname(logPath)))))
}

/**
 * Resolve every Session-owned path, using the persistence backend's own
 * location as the authority and sweeping the two historical directory namings
 * (`<id>` and `session-<id>`) across every project directory it may appear in.
 */
async function collectTargets(ctx, sessionId) {
	const notes = []
	const persistence = ctx.get('sessionPersistence')
	let logPath
	if (persistence !== undefined) {
		try {
			const snapshot = await persistence.stat(sessionId)
			logPath = snapshot?.location?.path
		} catch (error) {
			notes.push(`session persistence lookup failed: ${errorMessage(error)}`)
		}
	}
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
		? resolve(process.env.DSH_HOME)
		: logPath !== undefined ? homeFromLog(logPath) : undefined
	if (home === undefined) throw new RequestError('cannot determine DSH_HOME', 500)

	const targets = []
	const seen = new Set()
	const add = async (path, kind) => {
		if (path === undefined) return
		const key = resolve(path).toLowerCase()
		if (seen.has(key)) return
		if (!(await exists(path))) return
		seen.add(key)
		targets.push({ path: resolve(path), kind })
	}

	if (logPath !== undefined) await add(dirname(logPath), 'session-log')

	const sessionsRoot = join(home, 'sessions')
	let projects = []
	try {
		projects = await readdir(sessionsRoot)
	} catch (error) {
		notes.push(`cannot list ${sessionsRoot}: ${errorMessage(error)}`)
	}
	for (const project of projects) {
		await add(join(sessionsRoot, project, sessionId), 'session-log')
		await add(join(sessionsRoot, project, `session-${sessionId}`), 'session-log')
	}

	for (const directory of [`session-${sessionId}`, sessionId]) {
		await add(join(home, 'rewind-snapshots', directory), 'rewind-snapshot')
	}

	const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
	for (const stem of [sessionId, `session-${sessionId}`]) {
		for (const suffix of ['.json', '.json.tmp', '.tmp']) {
			await add(join(cacheRoot, `${stem}${suffix}`), 'projection-cache')
		}
		await add(join(cacheRoot, stem), 'projection-cache')
	}

	return { home, logPath, targets, notes }
}

/** Stop anything the Session is currently running, through the published seams. */
async function stopActivity(ctx, sessionId, notes) {
	const controller = ctx.get('sessionController')
	try {
		controller?.cancel?.({ sessionId })
	} catch (error) {
		notes.push(`cancel failed: ${errorMessage(error)}`)
	}
	try {
		await ctx.parallel('workspace/session-stop', { sessionId })
	} catch (error) {
		notes.push(`session stop failed: ${errorMessage(error)}`)
	}
	// Give the transport a beat to release its log handle before unlinking on Windows.
	await new Promise((done) => { setTimeout(done, 120) })
}

/** Drop every registry trace: workspace membership, archive membership, pin membership. */
async function forgetInRegistry(ctx, sessionId, notes) {
	const registry = ctx.get('workspaceRegistry')
	const report = { workspaces: [], detached: 0, unarchived: false, unpinned: false }
	if (registry === undefined) {
		notes.push('workspace registry unavailable; registry entries were not cleaned')
		return report
	}
	let entities = []
	try {
		entities = registry.list?.() ?? []
	} catch (error) {
		notes.push(`workspace listing failed: ${errorMessage(error)}`)
	}
	for (const entity of entities) {
		try {
			await entity?.detachSession?.(sessionId)
			report.detached += 1
			report.workspaces.push(entity?.id ?? entity?.path ?? 'workspace')
		} catch (error) {
			notes.push(`detach from workspace failed: ${errorMessage(error)}`)
		}
	}
	try {
		await registry.unarchiveSession?.(sessionId)
		report.unarchived = true
	} catch (error) {
		notes.push(`unarchive failed: ${errorMessage(error)}`)
	}
	try {
		await registry.unpinSession?.(sessionId)
		report.unpinned = true
	} catch (error) {
		notes.push(`unpin failed: ${errorMessage(error)}`)
	}
	return report
}

/**
 * Per-Session rows kept by the installed sidecar plugins. Both stores key their
 * rows by Session id (the Host prefixes them with `session-`), and neither one
 * prunes a Session that disappears, so a deletion that skipped them would leave
 * the transcript in the full-text index and the token usage in the ledger.
 */
const INDEX_STORES = [
	{ key: 'chat-index', path: ['bot', 'chat-index.sqlite'], tables: [['lines', 'session'], ['marks', 'session']] },
	{ key: 'usage', path: ['bot', 'usage.sqlite'], tables: [['calls', 'session'], ['marks', 'session'], ['owners', 'session'], ['kinds', 'session']] },
]

let sqliteModule

async function loadSqlite() {
	if (sqliteModule === undefined) {
		try {
			sqliteModule = await import('node:sqlite')
		} catch {
			sqliteModule = null
		}
	}
	return sqliteModule
}

function sessionKeys(sessionId) {
	return [sessionId, `session-${sessionId}`]
}

/**
 * Remove one Session's rows from the sidecar SQLite stores. The stores belong to
 * other plugins, so every statement is guarded: a locked or unreadable file is
 * reported in `notes` and never breaks the deletion itself.
 */
async function purgeIndexes(home, sessionId, dryRun, notes) {
	const sqlite = await loadSqlite()
	if (sqlite === null) {
		notes.push('index stores were left untouched: this Host has no node:sqlite module')
		return {}
	}
	const { DatabaseSync } = sqlite
	const keys = sessionKeys(sessionId)
	const report = {}
	for (const store of INDEX_STORES) {
		const file = join(home, ...store.path)
		if (!(await exists(file))) continue
		const entry = { present: true, dryRun, deleted: 0, tables: [] }
		let db
		try {
			db = dryRun ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file)
			if (!dryRun) db.exec('PRAGMA busy_timeout = 4000')
			for (const [table, column] of store.tables) {
				try {
					if (dryRun) {
						let count = 0
						for (const key of keys) {
							count += Number(db.prepare(`select count(*) as n from ${table} where ${column} = ?`).get(key)?.n ?? 0)
						}
						if (count > 0) entry.tables.push(`${table}:${count}`)
						entry.deleted += count
						continue
					}
					let changes = 0
					for (const key of keys) {
						changes += Number(db.prepare(`delete from ${table} where ${column} = ?`).run(key).changes ?? 0)
					}
					if (changes > 0) entry.tables.push(`${table}:${changes}`)
					entry.deleted += changes
				} catch (error) {
					entry.tables.push(`${table}: ${errorMessage(error)}`)
					notes.push(`${store.key}.${table} cleanup failed: ${errorMessage(error)}`)
				}
			}
			if (!dryRun && store.key === 'chat-index' && entry.deleted > 0) {
				try {
					db.prepare("insert into lines(lines) values('optimize')").run()
				} catch (error) {
					notes.push(`chat-index compaction failed: ${errorMessage(error)}`)
				}
			}
		} catch (error) {
			entry.error = errorMessage(error)
			notes.push(`${store.key} index cleanup failed: ${errorMessage(error)}`)
		} finally {
			try {
				db?.close()
			} catch {}
		}
		report[store.key] = entry
	}
	return report
}

/**
 * Delete the scheduled tasks aimed at the Session. The schedule service owns the
 * durable table, so tasks go through `edit({ action: 'delete' })` instead of a
 * file rewrite that would desync the scheduler's in-memory state.
 */
async function purgeSchedules(ctx, sessionId, notes, dryRun = false) {
	const schedule = ctx.get('schedule')
	if (schedule === undefined) {
		notes.push('schedule service unavailable; scheduled tasks pointing at this Session were not checked')
		return { deleted: [], skipped: [], matched: [] }
	}
	const wanted = new Set(sessionKeys(sessionId))
	const deleted = []
	const skipped = []
	const matched = []
	let entries
	try {
		entries = await schedule.catalog()
	} catch (error) {
		notes.push(`schedule catalog failed: ${errorMessage(error)}`)
		return { deleted, skipped, matched }
	}
	for (const entry of entries ?? []) {
		const target = entry?.target
		// `session` delivers into the Session; `new_once` reserved its identity and can never deliver once it is gone.
		const aimedAtSession =
			(target?.kind === 'session' || target?.kind === 'new_once') && wanted.has(target.sessionId)
		const involved = Array.isArray(entry?.involvedSessionIds) && entry.involvedSessionIds.some((id) => wanted.has(id))
		if (!aimedAtSession && !involved) continue
		if (dryRun) {
			matched.push({ id: entry.id, title: entry.title })
			continue
		}
		try {
			const result = await schedule.edit({ id: entry.id, action: 'delete' })
			if (result?.deleted === true) deleted.push({ id: entry.id, title: entry.title })
			else skipped.push({ id: entry.id, title: entry.title, reason: result?.code ?? 'not deleted' })
		} catch (error) {
			skipped.push({ id: entry.id, title: entry.title, reason: errorMessage(error) })
		}
	}
	return { deleted, skipped, matched }
}

/**
 * The one deletion routine shared by the HTTP route, the agent tool and the
 * context-menu action.
 */
export async function deleteSession(ctx, rawSessionId, options = {}) {
	const sessionId = assertSessionId(rawSessionId)
	const dryRun = options.dryRun === true
	const notes = []
	const plan = await collectTargets(ctx, sessionId)

	const targets = []
	for (const target of plan.targets) targets.push({ ...target, ...(await measure(target.path)) })

	const report = {
		sessionId,
		dryRun,
		home: plan.home,
		targets,
		removed: [],
		failed: [],
		registry: { workspaces: [], detached: 0, unarchived: false, unpinned: false },
		indexes: await purgeIndexes(plan.home, sessionId, true, notes),
		schedules: { deleted: [], skipped: [], matched: [] },
		notes,
	}
	if (dryRun) {
		report.schedules = await purgeSchedules(ctx, sessionId, notes, true)
		return report
	}

	await stopActivity(ctx, sessionId, notes)
	report.registry = await forgetInRegistry(ctx, sessionId, notes)

	for (const target of targets) {
		try {
			await rm(target.path, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 })
			if (await exists(target.path)) {
				report.failed.push({ ...target, error: 'still present after removal' })
			} else {
				report.removed.push(target)
			}
		} catch (error) {
			report.failed.push({ ...target, error: errorMessage(error) })
		}
	}

	if (report.failed.length === 0 && report.removed.length === 0) {
		notes.push('no Session artifacts were found on disk')
	}
	report.schedules = await purgeSchedules(ctx, sessionId, notes)
	report.indexes = await purgeIndexes(plan.home, sessionId, false, notes)
	await announceRemoval(ctx, sessionId, notes)
	return report
}

/**
 * Tell every attached client to drop the catalog row. The Session Controller
 * forwards `api-session/removed` to browsers, where the sidebar removes the row
 * without a page reload.
 */
async function announceRemoval(ctx, sessionId, notes) {
	try {
		ctx.emit('api-session/removed', sessionId)
	} catch (error) {
		notes.push(`list broadcast failed: ${errorMessage(error)}`)
	}
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	})
	response.end(body)
}

async function readJson(request) {
	const chunks = []
	let size = 0
	for await (const chunk of request) {
		size += chunk.length
		if (size > MAX_BODY_BYTES) throw new RequestError('request body too large', 413)
		chunks.push(chunk)
	}
	if (chunks.length === 0) throw new RequestError('request body required')
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new RequestError('request body must be JSON')
	}
}

function createHandler(ctx, status) {
	return async (request, response) => {
		try {
			// Admit only requests the Harness itself would serve to its own page.
			const rejection = ctx.get('connection')?.requestRejection?.(request)
			if (rejection !== undefined) {
				sendJson(response, 403, { error: 'forbidden' })
				return
			}
			const url = new URL(request.url ?? ROUTE, 'http://127.0.0.1')
			if (url.pathname === `${ROUTE}/api/health` && request.method === 'GET') {
				sendJson(response, 200, healthPayload(status))
				return
			}
			if (url.pathname === `${ROUTE}/api/preview` && request.method === 'GET') {
				const sessionId = assertSessionId(url.searchParams.get('sessionId') ?? '')
				sendJson(response, 200, await status.impl(ctx, sessionId, { dryRun: true }))
				return
			}
			if (url.pathname === `${ROUTE}/api/delete` && request.method === 'POST') {
				const body = await readJson(request)
				sendJson(response, 200, await status.impl(ctx, body.sessionId, { dryRun: body.dryRun === true }))
				return
			}
			sendJson(response, 404, { error: 'not found' })
		} catch (error) {
			const statusCode = error instanceof RequestError ? error.status : 500
			sendJson(response, statusCode, { error: errorMessage(error) })
		}
	}
}

function createToolDefinition(ctx, status) {
	return {
		name: 'session_delete',
		description: 'Permanently delete one DSH Session and every artifact the Host stores for it: its durable session log directory, its rewind snapshots, its projection cache, and its workspace/archive/pin registry entries. Shared content-addressed attachments are never touched. Irreversible; use dryRun to list the targets first.',
		parameters: {
			type: 'object',
			properties: {
				sessionId: { type: 'string', description: 'Exact Session id to delete.' },
				dryRun: { type: 'boolean', description: 'Report the artifacts and registry state that would be removed without changing anything.' },
			},
			required: ['sessionId'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					sessionId: { type: 'string' },
					dryRun: { type: 'boolean' },
					home: { type: 'string' },
					targets: { type: 'array' },
					removed: { type: 'array' },
					failed: { type: 'array' },
					registry: { type: 'object' },
					schedules: { type: 'object' },
					indexes: { type: 'object' },
					notes: { type: 'array' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		},
		timeoutMs: 120_000,
		execute: async (args) => status.impl(ctx, args?.sessionId, { dryRun: args?.dryRun === true }),
	}
}

function modulePath() {
	return fileURLToPath(import.meta.url)
}

function moduleMtime() {
	try {
		return statSync(modulePath()).mtimeMs
	} catch {
		return null
	}
}

function createStatus() {
	return {
		impl: deleteSession,
		version: VERSION,
		generation: 0,
		loadedAt: Date.now(),
		moduleMtimeMs: moduleMtime(),
		reloadedAt: null,
		lastReloadError: null,
		toolDispose: null,
	}
}

function healthPayload(status) {
	const diskMtimeMs = moduleMtime()
	return {
		ok: true,
		plugin: name,
		version: status.version,
		generation: status.generation,
		loadedAt: new Date(status.loadedAt).toISOString(),
		reloadedAt: status.reloadedAt === null ? null : new Date(status.reloadedAt).toISOString(),
		loadedModuleMtimeMs: status.moduleMtimeMs,
		diskModuleMtimeMs: diskMtimeMs,
		stale: diskMtimeMs !== null && diskMtimeMs !== status.moduleMtimeMs,
		lastReloadError: status.lastReloadError,
	}
}

/**
 * Re-import this module with a cache-busting query and adopt its deleteSession().
 *
 * The Host loads plugin modules once, and the HMR watcher skips node_modules
 * entirely, so an edited plugin would otherwise keep running its old code
 * until DSH restarts. Swapping the implementation in place keeps the HTTP
 * route and the agent tool bound to the newest logic.
 */
async function reloadHostModule(ctx, status) {
	const file = modulePath()
	try {
		const stamp = Date.now()
		const target = pathToFileURL(file).href + '?v=' + stamp
		const module = await import(target)
		if (typeof module.deleteSession !== 'function') {
			throw new Error('the edited module no longer exports deleteSession()')
		}
		status.impl = module.deleteSession
		if (typeof module.VERSION === 'string') status.version = module.VERSION
		status.generation += 1
		status.reloadedAt = stamp
		status.moduleMtimeMs = moduleMtime()
		if (ctx.tools !== undefined) {
			const definition = typeof module.createToolDefinition === 'function' ? module.createToolDefinition(ctx, status) : null
			if (definition !== null) {
				const previous = status.toolDispose
				status.toolDispose = null
				try {
					previous?.()
				} catch {}
				try {
					status.toolDispose = ctx.tools.register(definition)
				} catch {
					status.toolDispose = ctx.tools.register(createToolDefinition(ctx, status))
				}
			}
		}
		status.lastReloadError = null
		return true
	} catch (error) {
		status.lastReloadError = errorMessage(error)
		return false
	}
}

function watchHostModule(ctx, status) {
	let timer = null
	let watcher = null
	try {
		watcher = watch(dirname(modulePath()), { persistent: false }, (_event, filename) => {
			if (filename !== null && String(filename) !== 'index.js') return
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = null
				void reloadHostModule(ctx, status)
			}, 300)
			timer.unref?.()
		})
		watcher.on('error', () => {})
	} catch {
		watcher = null
	}
	ctx.effect(
		() => () => {
			if (timer !== null) clearTimeout(timer)
			timer = null
			try {
				watcher?.close()
			} catch {}
			watcher = null
		},
		'dsh-session-delete: source watcher',
	)
}

export function apply(ctx) {
	const status = createStatus()
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx, status) }),
		'dsh-session-delete: http route',
	)

	if (ctx.tools !== undefined) {
		ctx.effect(() => {
			status.toolDispose = ctx.tools.register(createToolDefinition(ctx, status))
			return () => {
				try {
					status.toolDispose?.()
				} catch {}
				status.toolDispose = null
			}
		}, 'dsh-session-delete: tool')
	}

	watchHostModule(ctx, status)
}
