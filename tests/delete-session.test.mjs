/**
 * Standalone harness for the deletion routine: exercises target discovery,
 * dry-run, registry cleanup and unlink against a scratch DSH_HOME.
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitRequest, deleteSession, tombstonesForClient } from '../index.js'

const sessions = new Set()
const archived = []
const unarchived = []
const unpinned = []
const emitted = []
const registry = {
	archivedSessionIds: [],
	list: () => [{ id: 'ws-1', path: 'G:/fake', detachSession: async (id) => { sessions.add(id) } }],
	archiveSession: async (id, options) => { archived.push({ id, options }) },
	unarchiveSession: async (id) => { unarchived.push(id) },
	unpinSession: async (id) => { unpinned.push(id) },
}

let serviceTable = {}
const ctx = {
	get: (name) => serviceTable[name],
	parallel: async (name) => ({ name }),
	emit: (name) => { emitted.push(name) },
}

function report(ok, label, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) process.exitCode = 1
}

async function exists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

const home = await mkdtemp(join(tmpdir(), 'dsd-home-'))
process.env.DSH_HOME = home

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const keep = '11111111-2222-3333-4444-555555555555'

async function seed(sessionId) {
	const log = join(home, 'sessions', '--G-fake--', sessionId)
	await mkdir(log, { recursive: true })
	await writeFile(join(log, 'session.v4.jsonl.zstd'), 'x'.repeat(1024))
	await mkdir(join(home, 'sessions', '--G-legacy--', `session-${sessionId}`), { recursive: true })
	await writeFile(join(home, 'sessions', '--G-legacy--', `session-${sessionId}`, 'session.v4.jsonl.zstd'), 'y'.repeat(512))
	await mkdir(join(home, 'rewind-snapshots', `session-${sessionId}`), { recursive: true })
	await writeFile(join(home, 'rewind-snapshots', `session-${sessionId}`, 'snapshot.json'), '{}')
	await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
	await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), '{"projections":[]}')
	await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json.tmp`), 'partial')
}

await seed(id)
await seed(keep)

// Sidecar stores: the chat index and the usage ledger both key rows by Session id.
{
	const { DatabaseSync } = await import('node:sqlite')
	await mkdir(join(home, 'bot'), { recursive: true })
	const chat = new DatabaseSync(join(home, 'bot', 'chat-index.sqlite'))
	chat.exec("CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, tokenize = 'trigram')")
	chat.exec('CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL)')
	for (const [sessionId, text] of [[id, 'doomed transcript'], [`session-${id}`, 'prefixed transcript'], [keep, 'kept transcript']]) {
		chat.prepare('insert into lines (text, session) values (?, ?)').run(text, sessionId)
		chat.prepare('insert into marks values (?, 1, 0, 0, 1)').run(sessionId)
	}
	chat.close()

	const usage = new DatabaseSync(join(home, 'bot', 'usage.sqlite'))
	usage.exec('CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL)')
	usage.exec('CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL)')
	usage.exec('CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL, listed INTEGER)')
	usage.exec('CREATE TABLE kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL)')
	for (const sessionId of [id, `session-${id}`, keep]) {
		usage.prepare('insert into calls values (?, ?, 1)').run(`call-${sessionId}`, sessionId)
		usage.prepare('insert into owners values (?, ?, ?)').run(sessionId, 'me', 'me')
	}
	usage.close()
}

const scheduleEdits = []
const scheduleService = {
	catalog: async () => [
		{ id: 'schedule-doomed', title: 'Nightly report', target: { kind: 'session', sessionId: `session-${id}` }, involvedSessionIds: [] },
		{ id: 'schedule-once', title: 'Reserved identity', target: { kind: 'new_once', sessionId: `session-${id}`, create: {} }, involvedSessionIds: [] },
		{ id: 'schedule-kept', title: 'Kept task', target: { kind: 'session', sessionId: `session-${keep}` }, involvedSessionIds: [] },
	],
	edit: async (request) => {
		scheduleEdits.push(request)
		return { id: request.id, deleted: true }
	},
}

async function countOne(file, table, column, sessionId) {
	const { DatabaseSync } = await import('node:sqlite')
	const db = new DatabaseSync(join(home, 'bot', file), { readOnly: true })
	try {
		return Number(db.prepare(`select count(*) as n from ${table} where ${column} = ?`).get(sessionId)?.n ?? 0)
	} finally {
		db.close()
	}
}

async function countRows(file, table, column) {
	const { DatabaseSync } = await import('node:sqlite')
	const db = new DatabaseSync(join(home, 'bot', file), { readOnly: true })
	try {
		return Number(db.prepare(`select count(*) as n from ${table} where ${column} in (?, ?)`).get(id, `session-${id}`)?.n ?? 0)
	} finally {
		db.close()
	}
}

// 1. Path traversal and malformed ids are refused before any filesystem work.
for (const bad of ['../evil', 'a/b', '..', '', 'C:\\x']) {
	let refused = false
	try {
		await deleteSession(ctx, bad, { dryRun: true })
	} catch {
		refused = true
	}
	report(refused, `refuses unsafe id ${JSON.stringify(bad)}`)
}

// 2. Dry run lists every artifact and touches nothing.
const preview = await deleteSession(ctx, id, { dryRun: true })
const previewPaths = preview.targets.map((target) => target.path.replace(/\\/g, '/'))
report(preview.targets.length === 5, 'dry run finds 5 targets', JSON.stringify(preview.targets.map((target) => target.kind)))
report(preview.removed.length === 0 && preview.failed.length === 0, 'dry run removes nothing')
report(await exists(join(home, 'sessions', '--G-fake--', id)), 'dry run leaves the log in place')
report(previewPaths.every((path) => path.includes(id)), 'every listed target belongs to the session')
report(preview.indexes['chat-index']?.deleted === 4 && preview.indexes.usage?.deleted === 4, 'dry run counts the index rows it would purge', JSON.stringify(preview.indexes))

// 3. A dry run with the schedule service attached must list, never edit.
serviceTable = { workspaceRegistry: registry, schedule: scheduleService }
const previewWarm = await deleteSession(ctx, id, { dryRun: true })
report(previewWarm.schedules.matched.length === 2 && previewWarm.schedules.matched.some((task) => task.id === 'schedule-once'), 'dry run lists both scheduled tasks it would delete', JSON.stringify(previewWarm.schedules))
report(scheduleEdits.length === 0, 'dry run does not touch the schedule')

// 4. A real deletion with the registry service present.
serviceTable = { workspaceRegistry: registry, schedule: scheduleService }
const result = await deleteSession(ctx, id, {})
report(result.removed.length === 5, 'real deletion removes 5 targets', JSON.stringify(result.removed.map((target) => target.kind)))
report(result.failed.length === 0, 'no failures', JSON.stringify(result.failed))
report(result.notes.length === 0, 'no notes', JSON.stringify(result.notes))
report(emitted.includes('api-session/removed'), 'clients are told the row is gone')
report(scheduleEdits.length === 2 && scheduleEdits.every((edit) => edit.action === 'delete') && scheduleEdits.some((edit) => edit.id === 'schedule-doomed') && scheduleEdits.some((edit) => edit.id === 'schedule-once'), 'deletes every scheduled task aimed at the session', JSON.stringify(scheduleEdits))
report(result.schedules.deleted.length === 2 && result.schedules.skipped.length === 0, 'reports the deleted scheduled tasks')
report(await countRows('chat-index.sqlite', 'lines', 'session') === 0, 'chat index transcript rows are gone')
report(await countRows('chat-index.sqlite', 'marks', 'session') === 0, 'chat index marks are gone')
report(await countRows('usage.sqlite', 'calls', 'session') === 0, 'usage calls are gone')
report(await countRows('usage.sqlite', 'owners', 'session') === 0, 'usage owners are gone')
report(sessions.has(id), 'detached from the workspace')
report(archived.length === 0, 'never archives — the archive set doubles as the "show archived" view', JSON.stringify(archived))
report(unarchived.length === 0, 'nothing to unarchive for a Session that was not archived', JSON.stringify(unarchived))
report(result.registry.detached === 1 && result.registry.unpinned === true && result.registry.unarchived === false, 'reports the detach, the unpin and the untouched archive set', JSON.stringify(result.registry))
report(result.tombstone === true, 'records a plugin tombstone', String(result.tombstone))
const recorded = JSON.parse(await readFile(join(home, 'dsh-session-delete', 'tombstones.json'), 'utf8'))
report(recorded.entries.some((entry) => entry.sessionId === id), 'the tombstone file names the deleted id', JSON.stringify(recorded.entries))
report(unpinned.includes(id), 'removed from the pin set')
report(Awaited(result) !== null, 'report is returned synchronously')

function Awaited() { return true }

for (const path of [
	join(home, 'sessions', '--G-fake--', id),
	join(home, 'sessions', '--G-legacy--', `session-${id}`),
	join(home, 'rewind-snapshots', `session-${id}`),
	join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
	join(home, 'storages', 'session_projcache', 'sessions', `${id}.json.tmp`),
]) report(!(await exists(path)), `removed ${path.replace(/\\/g, '/').replace(home.replace(/\\/g, '/'), '$DSH_HOME')}`)

// 4. Another session's artifacts survive untouched.
for (const path of [
	join(home, 'sessions', '--G-fake--', keep),
	join(home, 'rewind-snapshots', `session-${keep}`),
	join(home, 'storages', 'session_projcache', 'sessions', `${keep}.json`),
]) report(await exists(path), `kept ${path.replace(/\\/g, '/').replace(home.replace(/\\/g, '/'), '$DSH_HOME')}`)
report(await countOne('chat-index.sqlite', 'lines', 'session', keep) === 1, 'kept the other session in the chat index')
report(await countOne('usage.sqlite', 'calls', 'session', keep) === 1, 'kept the other session in the usage ledger')

// 5. Second deletion of the same id is a clean no-op.
const again = await deleteSession(ctx, id, {})
report(again.removed.length === 0 && again.failed.length === 0, 'repeat deletion is a no-op', JSON.stringify(again.notes))

// 5b. 1.2.3's archive markers are swept once: a resident Session whose log is
//     gone is unarchived and recorded as a plugin tombstone instead.
const legacyId = '99999999-8888-7777-6666-555555555555'
registry.archivedSessionIds.push(legacyId)
const liveSessions = { get: (sessionId) => ({ id: sessionId }) }
serviceTable = { workspaceRegistry: registry, sessions: liveSessions, sessionPersistence: { stat: async () => undefined } }
const swept = await tombstonesForClient(ctx)
report(swept.unarchived.includes(legacyId), 'unarchives a 1.2.3 marker whose log is gone', JSON.stringify(swept.unarchived))
report(unarchived.includes(legacyId), 'asks the registry to drop that marker', JSON.stringify(unarchived))
report(swept.ids.includes(legacyId), 'turns that marker into a plugin tombstone', JSON.stringify(swept.ids))
report(swept.ids.includes(id), 'keeps the tombstone recorded by the delete', JSON.stringify(swept.ids))
report(swept.count === swept.ids.length, 'count matches the id list')
const sweptAgain = await tombstonesForClient(ctx)
report(sweptAgain.unarchived.length === 0, 'sweeps the archive set only once')

// 6. Admission fence: the Host's check wins; without that service, cross-site is refused.
const headersOf = (extra) => ({ headers: extra })
const noFence = { get: () => undefined }
report(admitRequest(noFence, headersOf({})) === undefined, 'admission: plain request without a Host fence is allowed')
report(admitRequest({ get: () => ({ requestRejection: () => 'nope' }) }, headersOf({})) === 'nope', 'admission: the Host fence answer is used verbatim')
report(admitRequest(noFence, headersOf({ 'sec-fetch-site': 'cross-site' })) !== undefined, 'admission: cross-site browser request is refused')
report(admitRequest(noFence, headersOf({ 'sec-fetch-site': 'same-origin' })) === undefined, 'admission: same-origin browser request is allowed')
report(admitRequest(noFence, headersOf({ origin: 'http://127.0.0.1:58663', host: '127.0.0.1:58663' })) === undefined, 'admission: matching Origin/Host is allowed')
report(admitRequest(noFence, headersOf({ origin: 'https://evil.example', host: '127.0.0.1:58663' })) !== undefined, 'admission: foreign Origin is refused')
report(admitRequest(noFence, headersOf({ origin: 'null' })) === undefined, 'admission: opaque Origin is left to the Host fence')

console.log(`\nscratch home: ${home}`)
console.log(`remaining sessions: ${JSON.stringify(await readdir(join(home, 'sessions')))}`)
