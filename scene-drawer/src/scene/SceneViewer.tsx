import { useEffect, useRef, useState } from 'react'
import { pollScene } from './sceneClient.ts'
import type { SceneStatus } from './sceneClient.ts'
import { createSceneRenderer } from './sceneRenderer.ts'
import type { PerspectiveMode, SceneRenderer } from './sceneRenderer.ts'

const PERSPECTIVE_LABELS: Record<PerspectiveMode, string> = {
	shared: 'one camera for all objects',
	perObject: 'own perspective per object',
}

// A full-screen WebGL canvas showing the objects from the object server (../object-server).
// React renders the canvas once; drawing (every frame) and polling run outside React. Only the
// status line and the perspective switch are React state; they change only when clicked or
// when the server's status changes.
export default function SceneViewer() {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const rendererRef = useRef<SceneRenderer | null>(null)
	const [status, setStatus] = useState<SceneStatus>({ online: false, objects: 0 })
	const [perspective, setPerspective] = useState<PerspectiveMode>('shared')

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const renderer = createSceneRenderer(canvas)
		rendererRef.current = renderer
		const stopPolling = pollScene({ onObjects: renderer.setObjects, onStatus: setStatus })

		// Redrawn every frame although nothing moves yet: animated objects will need it.
		let frame = 0
		const loop = (ms: number) => {
			frame = requestAnimationFrame(loop)
			renderer.draw(ms / 1000)
		}
		frame = requestAnimationFrame(loop)

		return () => {
			cancelAnimationFrame(frame)
			stopPolling()
			renderer.dispose()
			rendererRef.current = null
		}
	}, [])

	// Hand the switch's position to the renderer (declared after the effect above,
	// so on mount it runs once the renderer exists).
	useEffect(() => {
		rendererRef.current?.setPerspective(perspective)
	}, [perspective])

	return (
		<>
			<canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block' }} />
			<div style={{ position: 'fixed', left: 12, bottom: 10, font: '13px system-ui, sans-serif', color: '#9a9aa5', display: 'flex', gap: 12, alignItems: 'center' }}>
				<span>
					{status.online ? 'online' : 'server unreachable'} · {status.objects} {status.objects === 1 ? 'object' : 'objects'}
				</span>
				<button
					type="button"
					onClick={() => setPerspective((mode) => (mode === 'shared' ? 'perObject' : 'shared'))}
					style={{ font: 'inherit', color: '#d0d0d8', background: '#24242c', border: '1px solid #3a3a46', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
				>
					Perspective: {PERSPECTIVE_LABELS[perspective]}
				</button>
			</div>
		</>
	)
}
