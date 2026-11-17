/**
 * Permanently delete one Session and every artifact the Host keeps for it.
 *
 * The Host ships no Session delete API, so this plugin owns the whole
 * operation: stop the Session, drop it from the workspace registry (membership,
 * archive and pin slots), then remove the on-disk artifacts the Host created for
 * that Session — its durable log directory, its rewind snapshots and its
 * projection cache. Content-addressed attachments are shared between Sessions
 * and are deliberately left alone.
 *
 * The Host keeps an opened Session resident until the process restarts, so no
 * amount of disk cleanup removes it from `session.list`. The plugin therefore
 * records the deleted id in its own tombstone file; the client half reads that
 * file and keeps the row out of the browser catalog, which hides it in every
 * archive filter instead of turning it into a permanent "archived" row.
 */
import { statSync, watch } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-session-delete'
export const inject = ['webServer', 'tools']

export const VERSION = '1.3.0'
const ROUTE = '/session-delete'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_BODY_BYTES = 64 * 1024
/** Directory under DSH_HOME that holds this plugin's own bookkeeping. */
const STATE_DIR = 'dsh-session-delete'

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

/** Cache of the resolved DSH_HOME, filled by the first lookup. */
let knownHome

/**
 * Resolve DSH_HOME without a Session id: the environment variable when the Host
 * exports it, otherwise the directory layout of any stored Session log.
 */
async function resolveHome(ctx) {
	if (knownHome !== undefined) return knownHome
	const fromEnv = process.env.DSH_HOME
	if (fromEnv !== undefined && fromEnv !== '') return (knownHome = resolve(fromEnv))
	const persistence = ctx.get('sessionPersistence')
	if (persistence !== undefined && typeof persistence.list === 'function') {
		const listed = await persistence.list().catch(() => undefined)
		for (const entry of Array.isArray(listed) ? listed : []) {
			const path = entry?.location?.path
			if (typeof path === 'string' && path !== '') return (knownHome = homeFromLog(path))
		}
	}
	throw new RequestError('cannot determine DSH_HOME', 500)
}

/**
 * This plugin's tombstone file.
 *
 * It records Sessions this plugin deleted. The Host cannot evict a resident
 * Session from `session.list`, so the browser needs a durable answer to "which
 * rows did the user delete?" — the archive set cannot serve, because it doubles
 * as the "show archived" view and would turn a deleted Session into a grayed row.
 */
function tombstoneFile(home) {
	return join(home, STATE_DIR, 'tombstones.json')
}

/** Read the tombstone file; missing, unreadable or malformed state reads as empty. */
async function readTombstoneState(home) {
	let parsed
	try {
		parsed = JSON.parse(await readFile(tombstoneFile(home), 'utf8'))
	} catch {
		parsed = undefined
	}
	const entries = []
	for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) {
		const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : undefined
		if (sessionId === undefined || !SAFE_ID.test(sessionId)) continue
		entries.push({
			sessionId,
			deletedAt: typeof entry?.deletedAt === 'string' ? entry.deletedAt : null,
		})
	}
	return {
		version: 1,
		entries,
		legacyArchiveSwept: parsed?.legacyArchiveSwept === true,
	}
}

/** Replace the tombstone file atomically (write, then rename over). */
async function writeTombstoneState(home, state) {
	const file = tombstoneFile(home)
	await mkdir(dirname(file), { recursive: true })
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(temp, JSON.stringify(state, null, '\t') + '\n', 'utf8')
	await rename(temp, file)
}

/** Remember one deleted Session id, replacing any earlier record. */
async function recordTombstone(home, sessionId, notes) {
	try {
		const state = await readTombstoneState(home)
		state.entries = [
			...state.entries.filter(entry => entry.sessionId !== sessionId),
			{ sessionId, deletedAt: new Date().toISOString() },
		]
		await writeTombstoneState(home, state)
		return true
	} catch (error) {
		notes.push(`tombstone record failed: ${errorMessage(error)}`)
		return false
	}
}

/** Whether a Session still has a stored log, i.e. is not deleted. */
async function hasStoredLog(ctx, sessionId) {
	const persistence = ctx.get('sessionPersistence')
	if (persistence === undefined) return true
	try {
		return (await persistence.stat(sessionId)) !== undefined
	} catch {
		return true
	}
}

/**
 * Forget tombstones that outlived their purpose: once the Host restarts, a
 * deleted Session is neither resident nor stored, so the catalog no longer
 * carries it and the row cannot come back.
 */
async function pruneTombstones(ctx, home) {
	const state = await readTombstoneState(home)
	const kept = []
	for (const entry of state.entries) {
		if (ctx.get('sessions')?.get?.(entry.sessionId) !== undefined) {
			kept.push(entry)
			continue
		}
		if (await hasStoredLog(ctx, entry.sessionId)) kept.push(entry)
	}
	if (kept.length !== state.entries.length) {
		state.entries = kept
		await writeTombstoneState(home, state).catch(() => {})
	}
	return state
}

/**
 * One-time cleanup of 1.2.3's archive tombstones.
 *
 * 1.2.3 hid the row by archiving it, which made a deleted Session a permanent
 * grayed row under "show archived". A resident Session whose log is already
 * gone and which sits in the archive set has no other explanation, so it is
 * unarchived and recorded as a tombstone here instead. Runs once.
 */
async function sweepLegacyArchive(ctx, home, state, notes) {
	const registry = ctx.get('workspaceRegistry')
	if (registry === undefined || typeof registry.unarchiveSession !== 'function') return []
	if (state.legacyArchiveSwept === true) return []
	const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
	const cleared = []
	for (const sessionId of archived) {
		if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) continue
		if (state.entries.some(entry => entry.sessionId === sessionId)) continue
		if (ctx.get('sessions')?.get?.(sessionId) === undefined) continue
		if (await hasStoredLog(ctx, sessionId)) continue
		try {
			await registry.unarchiveSession(sessionId)
			state.entries.push({ sessionId, deletedAt: new Date().toISOString() })
			cleared.push(sessionId)
		} catch (error) {
			notes.push(`legacy tombstone cleanup failed for ${sessionId}: ${errorMessage(error)}`)
		}
	}
	state.legacyArchiveSwept = true
	await writeTombstoneState(home, state).catch((error) => {
		notes.push(`tombstone state was not saved: ${errorMessage(error)}`)
	})
	return cleared
}

/** Tombstone payload the browser half polls to keep deleted rows out of the catalog. */
export async function tombstonesForClient(ctx) {
	const notes = []
	const home = await resolveHome(ctx)
	const state = await readTombstoneState(home)
	const unarchived = await sweepLegacyArchive(ctx, home, state, notes)
	const pruned = await pruneTombstones(ctx, home)
	return {
		plugin: name,
		version: VERSION,
		count: pruned.entries.length,
		ids: pruned.entries.map(entry => entry.sessionId),
		unarchived,
		notes,
	}
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
	knownHome = home

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

/**
 * Drop every registry trace and leave a durable tombstone.
 *
 * A Session that has ever been opened is resident in the Host's in-memory store
 * (`ctx.sessions`), and only the agent-loop teardown — a capability the API
 * drops when it resumes an Agent — can evict it. Until the Host restarts, every
 * `session.list` therefore keeps reporting the id. Detaching the workspace
 * membership alone would turn that leftover row into an orphan the sidebar
 * renders under "未分组" (Ungrouped), which is the bug this ordering avoids.
 *
 * So: unpin (pin and archive are mutually exclusive), archive the id, then drop
 * the workspace membership. Archiving first means the leftover row is already
 * flagged as hidden while it still has a home, so no intermediate registry
 * snapshot can render it under "未分组". The archive is the one durable flag
 * the sidebar hides by default (`ArchivedFilter = 'hide'`), which keeps the
 * resident phantom invisible across replays, reconnects and page reloads. The
 * id is deliberately left archived — unarchiving it here would resurrect the
 * row.
 */
/**
 * Drop the Session from the workspace registry: its pin slot, any archive slot
 * and every workspace's member account. Nothing is archived on the way out.
 *
 * Archiving looks like a cheap way to hide the row (the sidebar hides archived
 * rows by default), but the archive set is also the source of the "show
 * archived" view, so a tombstone there turns a deleted Session into a permanent
 * grayed row. The plugin hides the row from the browser catalog instead; see
 * `recordTombstone` and the client half.
 */
async function forgetInRegistry(ctx, sessionId, notes) {
	const registry = ctx.get('workspaceRegistry')
	const report = { workspaces: [], detached: 0, unpinned: false, unarchived: false }
	if (registry === undefined) {
		notes.push('workspace registry unavailable; registry entries were not cleaned')
		return report
	}
	try {
		await registry.unpinSession?.(sessionId)
		report.unpinned = true
	} catch (error) {
		notes.push(`unpin failed: ${errorMessage(error)}`)
	}
	try {
		const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []
		if (archived.includes(sessionId) && typeof registry.unarchiveSession === 'function') {
			await registry.unarchiveSession(sessionId)
			report.unarchived = true
		}
	} catch (error) {
		notes.push(`unarchive failed: ${errorMessage(error)}`)
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
		registry: { workspaces: [], detached: 0, unpinned: false, unarchived: false },
		tombstone: false,
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
	// The tombstone must exist before the broadcast: a browser that reloads
	// right after the delete asks for it and keeps the row out of the catalog.
	report.tombstone = await recordTombstone(plan.home, sessionId, notes)
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

/**
 * Admission fence for the HTTP route.
 *
 * The Host's own connection service answers this for its built-in API: it rejects
 * requests a browser page on another site could have forged. When a Host is
 * composed without that service, fall back to a strict same-origin check so the
 * delete route never becomes a cross-site target by default.
 */
export function admitRequest(ctx, request) {
	const connection = ctx?.get?.('connection')
	if (typeof connection?.requestRejection === 'function') return connection.requestRejection(request)
	const headers = request?.headers ?? {}
	const site = headers['sec-fetch-site']
	if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'cross-site request'
	const origin = headers.origin
	if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
		let originHost = null
		try {
			originHost = new URL(origin).host
		} catch {
			return 'malformed Origin'
		}
		const host = headers.host
		if (typeof host === 'string' && host !== '' && originHost !== host) return 'cross-origin request'
	}
	return undefined
}

function createHandler(ctx, status) {
	return async (request, response) => {
		try {
			// Admit only requests the Harness itself would serve to its own page.
			const rejection = admitRequest(ctx, request)
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
			// The browser half keeps deleted rows out of its catalog from this list.
			// It also drives the one-time cleanup of 1.2.3's archive tombstones.
			if (url.pathname === `${ROUTE}/api/tombstones` && request.method === 'GET') {
				const tombstones = typeof status.tombstones === 'function' ? status.tombstones : tombstonesForClient
				sendJson(response, 200, await tombstones(ctx))
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
		description: 'Permanently delete one DSH Session and every artifact the Host stores for it: its durable session log directory, its rewind snapshots, its projection cache, and its workspace membership/archive/pin registry slots. The plugin also records a tombstone so browsers keep the row out of the catalog until the Host restarts (the Host itself cannot evict a resident Session). Shared content-addressed attachments are never touched. Irreversible; use dryRun to list the targets first.',
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
		tombstones: tombstonesForClient,
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
		if (typeof module.tombstonesForClient === 'function') status.tombstones = module.tombstonesForClient
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
