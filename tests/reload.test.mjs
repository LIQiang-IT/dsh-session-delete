/**
 * End-to-end check of the dev-reload path: mount the plugin against a mock Host,
 * edit a copy of index.js on disk, and confirm the live module swaps itself and
 * reports the new version through GET /session-delete/api/health.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = new URL('../index.js', import.meta.url)
const scratch = await mkdtemp(join(tmpdir(), 'dsd-reload-'))
await mkdir(join(scratch, 'plug'), { recursive: true })
const target = join(scratch, 'plug', 'index.js')
await copyFile(source, target)

const failures = []
function report(ok, label, detail) {
	if (ok) {
		console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
		return
	}
	failures.push(label)
	console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const serviceTable = {}
const disposers = []
let route = null
const disposals = []
const context = {
	get: (key) => serviceTable[key],
	effect: (factory, _label) => {
		const dispose = factory()
		disposals.push(dispose)
		disposers.push(dispose)
		return () => {
			if (typeof dispose === 'function') dispose()
		}
	},
	tools: {
		register: () => {
			let disposed = false
			return () => {
				disposed = true
				return disposed
			}
		},
	},
	webServer: {
		register: (definition) => {
			route = definition
			return () => {
				route = null
			}
		},
	},
}

const module = await import(new URL(`file://${target.replace(/\\/g, '/')}`).href.replace('file:///', 'file:///'))
module.apply(context)

report(route !== null && route.path === '/session-delete', 'mounts the HTTP route')

async function health() {
	let body = ''
	const response = {
		headers: {},
		statusCode: 0,
		writeHead(status, headers) {
			this.statusCode = status
			Object.assign(this.headers, headers ?? {})
			return this
		},
		setHeader(name, value) {
			this.headers[name] = value
		},
		end(chunk) {
			body = chunk ?? ''
		},
	}
	const seen = JSON.parse(await (async () => {
		await route.handler({ url: '/session-delete/api/health', method: 'GET' }, response)
		return body
	})())
	return seen
}

const before = await health()
report(before.ok === true && before.generation === 0, 'reports a healthy, first-generation mount', before)
report(before.stale === false, 'a freshly loaded module is not stale')

// Simulate an edit: bump the version constant the way a real change would.
const original = await readFile(target, 'utf8')
await writeFile(target, original.replace(/const VERSION = '[^']*'/, "const VERSION = '9.9.9-reloaded'"), 'utf8')

const deadline = Date.now() + 8000
let after = null
while (Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 250))
	after = await health()
	if (after.generation > 0) break
}

report(after !== null && after.generation === 1, 'swaps the module after the file changes', after)
report(after !== null && after.version === '9.9.9-reloaded', 'serves the edited version without a restart', after?.version)
report(after !== null && after.lastReloadError === null, 'records no reload error', after?.lastReloadError)

for (const dispose of disposals) {
	try {
		dispose?.()
	} catch (error) {
		failures.push(`dispose threw: ${error instanceof Error ? error.message : String(error)}`)
	}
}
report(route === null, 'disposing the mount releases the route')

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`)
if (failures.length > 0) process.exitCode = 1
