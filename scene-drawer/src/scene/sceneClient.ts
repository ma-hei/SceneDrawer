// Polls the object server and keeps fetched objects in a cache.
//
// Every POLL_MS the cheap list (id + version of every object) is fetched. Only objects that
// aren't in the cache in that version are fetched in full; objects no longer listed leave the
// scene. The cache lives in this module, so it survives the component unmounting and mounting
// again (e.g. navigating away and back); it's gone when the page reloads.

import type { ObjectSummary, SceneObject } from './sceneTypes.ts'

const POLL_MS = 2000

// The object server's address. Empty: the page's own address (in development, Vite forwards /api/scene).
const BASE = import.meta.env.VITE_OBJECT_SERVER_URL ?? ''

const cache = new Map<string, SceneObject>()

export interface SceneStatus {
	online: boolean
	objects: number
}

export interface PollHandlers {
	/** The objects to draw, after every change (and once at the start, from the cache). */
	onObjects(objects: SceneObject[]): void
	/** Called when online/offline or the object count changes. */
	onStatus(status: SceneStatus): void
}

/** Start polling; returns a function that stops it. */
export function pollScene({ onObjects, onStatus }: PollHandlers): () => void {
	const abort = new AbortController()
	let timer = 0
	let status: SceneStatus = { online: false, objects: cache.size }
	onObjects([...cache.values()])
	onStatus(status)

	function report(next: SceneStatus) {
		if (next.online !== status.online || next.objects !== status.objects) {
			status = next
			onStatus(status)
		}
	}

	async function poll() {
		try {
			const { objects: listed } = await getJson<{ objects: ObjectSummary[] }>('/api/scene/objects', abort.signal)
			const missing = listed.filter(({ id, version }) => cache.get(id)?.version !== version)
			// Fetch new and changed objects in parallel; one failing doesn't stop the others.
			const fetched = await Promise.allSettled(
				missing.map(({ id }) => getJson<SceneObject>(`/api/scene/objects/${encodeURIComponent(id)}`, abort.signal)),
			)
			let changed = false
			for (const result of fetched) {
				if (result.status === 'fulfilled') {
					cache.set(result.value.id, result.value)
					changed = true
				} else if (!abort.signal.aborted) {
					console.warn('scene: could not fetch an object', result.reason)
				}
			}
			const listedIds = new Set(listed.map((o) => o.id))
			for (const id of cache.keys()) {
				if (!listedIds.has(id)) {
					cache.delete(id)
					changed = true
				}
			}
			if (changed) onObjects([...cache.values()])
			report({ online: true, objects: cache.size })
		} catch (error) {
			if (abort.signal.aborted) return
			report({ online: false, objects: cache.size })  // keep drawing what's cached; try again
			console.debug('scene: server unreachable', error)
		}
		if (!abort.signal.aborted) timer = window.setTimeout(poll, POLL_MS)  // next poll after this one finished
	}

	void poll()
	return () => {
		abort.abort()
		clearTimeout(timer)
	}
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(BASE + path, { signal, cache: 'no-store' })
	if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
	return (await response.json()) as T
}
