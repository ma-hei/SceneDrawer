// What the object server (object-server/server.py) sends. The server validates every object, so
// lengths and indices can be trusted here.

import { mat4, quat } from 'gl-matrix'

export type Vec3 = [x: number, y: number, z: number]

/** What the indices connect: triangles (surfaces, lit) or lines (no surface, unlit). */
export type Primitive = 'triangles' | 'lines'

export interface Mesh {
	primitive: Primitive
	positions: number[]  // x, y, z per vertex
	colors: number[]     // r, g, b (0..1) per vertex
	indices: number[]    // three vertex numbers per triangle, or two per line
}

export interface Transform {
	translation: Vec3
	rotation: Vec3  // degrees around x, y, z
	scale: Vec3
}

/** How an object moves. Only "static" exists so far; new kinds become further members of this
 *  union (e.g. { type: 'spin', axis: Vec3, degreesPerSecond: number }) and a case in poseAt. */
export type Motion = { type: 'static' }

export interface SceneObject {
	id: string
	version: string  // changes whenever the object changes on the server
	description: string
	mesh: Mesh
	transform: Transform
	motion: Motion
}

export interface ObjectSummary {
	id: string
	version: string
}

const rotation = quat.create()

/** The object's model matrix (mesh coordinates -> world) at a moment in time. Static objects
 *  ignore the time; animated ones will compute their pose from it here. */
export function poseAt(out: mat4, object: SceneObject, _timeSeconds: number): mat4 {
	const { translation, rotation: [rx, ry, rz], scale } = object.transform
	switch (object.motion.type) {
		case 'static':
		default:  // a motion type this page doesn't know yet (newer server): stand still
			quat.fromEuler(rotation, rx, ry, rz)
			return mat4.fromRotationTranslationScale(out, rotation, translation, scale)
	}
}
