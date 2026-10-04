// Draws the scene: every object with the same shader program.
//
// Each object's mesh is uploaded to the GPU once (one VAO per object and version); every frame
// only its model matrix changes. The shaders:
//   vertex    mesh coordinates -> world (u_model, the object's pose) -> screen (u_viewProjection)
//   fragment  the vertex colour, lit by one light from above. The surface direction (normal) is
//             worked out per pixel from how the world position changes across the screen, so
//             meshes don't need to send normals. Lines have no surface: they're drawn unlit,
//             in their exact colour (u_lit = 0).

import { mat4, vec4 } from 'gl-matrix'
import { poseAt } from './sceneTypes.ts'
import type { Primitive, SceneObject } from './sceneTypes.ts'

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_model;           // the object's pose: mesh coordinates -> world
uniform mat4 u_viewProjection;  // the camera: world -> screen
out vec3 v_color;
out vec3 v_world;
void main() {
	vec4 world = u_model * vec4(a_position, 1.0);
	v_world = world.xyz;
	v_color = a_color;
	gl_Position = u_viewProjection * world;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
in vec3 v_world;
uniform vec3 u_toLight;  // direction towards the light (normalised)
uniform bool u_lit;      // false for lines: they have no surface to light
out vec4 outColor;
void main() {
	if (!u_lit) {
		outColor = vec4(v_color, 1.0);
		return;
	}
	// The face's normal, from the triangle's slope on screen (always facing the camera).
	vec3 normal = normalize(cross(dFdx(v_world), dFdy(v_world)));
	float light = 0.35 + 0.65 * max(dot(normal, u_toLight), 0.0);  // ambient + direct
	outColor = vec4(v_color * light, 1.0);
}`

const CAMERA_POSITION = [0, 0, 8] as const
const CAMERA_TARGET = [0, 0, 0] as const
const TO_LIGHT = normalize([0.4, 1, 0.6])
const BACKGROUND = [0.06, 0.06, 0.08] as const

// How each primitive is drawn. (WebGL draws lines 1 pixel wide; browsers ignore gl.lineWidth.)
const MODES: Record<Primitive, GLenum> = {
	triangles: WebGL2RenderingContext.TRIANGLES,
	lines: WebGL2RenderingContext.LINES,
}

/**
 * How the camera sees the objects.
 *   shared     one camera for the whole scene (a normal 3D view): objects away from the middle
 *              are seen at an angle, and lines into the depth converge toward the screen's middle
 *   perObject  every object as if the camera stood straight in front of it: the camera slides
 *              (without turning) until the object's centre is in front of it, and the picture is
 *              then moved to where the object's centre is with the shared camera. Every object
 *              looks the same wherever it is, with lines converging toward its own centre.
 *              The depth (distance along the view) doesn't change, so hiding still works.
 */
export type PerspectiveMode = 'shared' | 'perObject'

export interface SceneRenderer {
	/** The objects to draw from now on; uploads new and changed meshes, frees removed ones. */
	setObjects(objects: readonly SceneObject[]): void
	setPerspective(mode: PerspectiveMode): void
	/** Draw one frame. The time is passed to each object's motion (for animations). */
	draw(timeSeconds: number): void
	dispose(): void
}

interface GpuMesh {
	version: string
	mode: GLenum   // gl.TRIANGLES or gl.LINES
	lit: boolean
	vao: WebGLVertexArrayObject
	buffers: WebGLBuffer[]
	indexCount: number
	indexType: GLenum
}

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
	const context = canvas.getContext('webgl2', { antialias: true })
	if (!context) throw new Error('WebGL2 is not available in this browser')
	const gl: WebGL2RenderingContext = context

	const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
	const uModel = gl.getUniformLocation(program, 'u_model')
	const uViewProjection = gl.getUniformLocation(program, 'u_viewProjection')
	const uToLight = gl.getUniformLocation(program, 'u_toLight')
	const uLit = gl.getUniformLocation(program, 'u_lit')

	gl.enable(gl.DEPTH_TEST)  // nearer surfaces hide farther ones
	gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1)

	let objects: readonly SceneObject[] = []
	const meshes = new Map<string, GpuMesh>()  // object id -> its mesh on the GPU
	const view = mat4.lookAt(mat4.create(), CAMERA_POSITION, CAMERA_TARGET, [0, 1, 0])
	const projection = mat4.create()
	const viewProjection = mat4.create()
	const model = mat4.create()
	let perspective: PerspectiveMode = 'shared'
	// scratch values for the per-object camera, reused every frame
	const objectViewProjection = mat4.create()
	const slide = mat4.create()
	const shift = mat4.create()
	const centre = vec4.create()

	function setObjects(next: readonly SceneObject[]): void {
		objects = next
		const ids = new Set(next.map((o) => o.id))
		for (const [id, mesh] of meshes) {
			if (!ids.has(id)) {
				freeMesh(gl, mesh)
				meshes.delete(id)
			}
		}
		for (const object of next) {
			const current = meshes.get(object.id)
			if (current?.version === object.version) continue
			if (current) freeMesh(gl, current)
			meshes.delete(object.id)
			if (!(object.mesh.primitive in MODES)) {
				// a primitive this page doesn't know yet (newer server): leave the object out
				console.warn(`scene: ${object.id}: unknown primitive "${object.mesh.primitive}"`)
				continue
			}
			meshes.set(object.id, uploadMesh(gl, object))
		}
	}

	/**
	 * The camera matrix for one object in "perObject" mode:
	 *   shift(centre on screen) × projection × slide(centre to the view axis) × view
	 * Returns the shared matrix if the object's centre is behind the camera.
	 */
	function viewProjectionFor(modelMatrix: mat4): mat4 {
		// The object's centre (the model matrix's translation), in camera coordinates.
		vec4.set(centre, modelMatrix[12], modelMatrix[13], modelMatrix[14], 1)
		vec4.transformMat4(centre, centre, view)
		const [x, y] = centre
		// Where the shared camera puts the centre on screen (-1..1).
		vec4.transformMat4(centre, centre, projection)
		const w = centre[3]
		if (w <= 0) return viewProjection
		// Slide the camera sideways (in its own x and y) until the centre is straight ahead...
		mat4.fromTranslation(slide, [-x, -y, 0])
		// ...then move the picture back to the centre's place on screen. In clip space, adding
		// "translation × w" moves things by exactly that much after the GPU divides by w.
		mat4.fromTranslation(shift, [centre[0] / w, centre[1] / w, 0])
		mat4.multiply(objectViewProjection, shift, projection)
		mat4.multiply(objectViewProjection, objectViewProjection, slide)
		return mat4.multiply(objectViewProjection, objectViewProjection, view)
	}

	function resize(): void {
		const dpr = window.devicePixelRatio || 1
		const w = Math.round(canvas.clientWidth * dpr)
		const h = Math.round(canvas.clientHeight * dpr)
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w
			canvas.height = h
		}
		gl.viewport(0, 0, w, h)
	}

	function draw(timeSeconds: number): void {
		resize()
		mat4.perspective(projection, Math.PI / 4, canvas.width / Math.max(canvas.height, 1), 0.1, 100)
		mat4.multiply(viewProjection, projection, view)

		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
		gl.useProgram(program)  // one program for every object
		gl.uniformMatrix4fv(uViewProjection, false, viewProjection)
		gl.uniform3fv(uToLight, TO_LIGHT)
		for (const object of objects) {
			const mesh = meshes.get(object.id)
			if (!mesh) continue
			gl.uniformMatrix4fv(uModel, false, poseAt(model, object, timeSeconds))
			if (perspective === 'perObject') gl.uniformMatrix4fv(uViewProjection, false, viewProjectionFor(model))
			gl.uniform1i(uLit, mesh.lit ? 1 : 0)
			gl.bindVertexArray(mesh.vao)
			gl.drawElements(mesh.mode, mesh.indexCount, mesh.indexType, 0)
		}
		gl.bindVertexArray(null)
	}

	function dispose(): void {
		for (const mesh of meshes.values()) freeMesh(gl, mesh)
		meshes.clear()
		gl.deleteProgram(program)
	}

	return {
		setObjects,
		setPerspective: (mode) => {
			perspective = mode
		},
		draw,
		dispose,
	}
}

function uploadMesh(gl: WebGL2RenderingContext, { version, mesh }: SceneObject): GpuMesh {
	const vao = gl.createVertexArray()
	gl.bindVertexArray(vao)
	const positions = arrayBuffer(gl, new Float32Array(mesh.positions), 0)
	const colors = arrayBuffer(gl, new Float32Array(mesh.colors), 1)
	// Small meshes use 16-bit indices; more than 65 536 vertices need 32-bit ones.
	const big = mesh.positions.length / 3 > 0xffff
	const indices = gl.createBuffer()
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices)  // remembered by the VAO
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices), gl.STATIC_DRAW)
	gl.bindVertexArray(null)
	return {
		version,
		mode: MODES[mesh.primitive],
		lit: mesh.primitive === 'triangles',
		vao,
		buffers: [positions, colors, indices],
		indexCount: mesh.indices.length,
		indexType: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
	}
}

/** A buffer of 3 floats per vertex, fed to the shader input at `location`. */
function arrayBuffer(gl: WebGL2RenderingContext, data: Float32Array, location: number): WebGLBuffer {
	const buffer = gl.createBuffer()
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
	gl.enableVertexAttribArray(location)
	gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0)
	return buffer
}

function freeMesh(gl: WebGL2RenderingContext, mesh: GpuMesh): void {
	gl.deleteVertexArray(mesh.vao)
	for (const buffer of mesh.buffers) gl.deleteBuffer(buffer)
}

function normalize([x, y, z]: [number, number, number]): Float32Array {
	const length = Math.hypot(x, y, z)
	return new Float32Array([x / length, y / length, z / length])
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
	const program = gl.createProgram()
	for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
		const shader = gl.createShader(type)
		if (!shader) throw new Error('could not create a shader')
		gl.shaderSource(shader, source)
		gl.compileShader(shader)
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'compile failed')
		gl.attachShader(program, shader)
		gl.deleteShader(shader)  // freed together with the program
	}
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
	return program
}
