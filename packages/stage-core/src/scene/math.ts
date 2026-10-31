/**
 * Transform maths. Convention (documented in the README): metres, Y up, right-handed. The character stands at the
 * origin facing +Z. A camera looks down its own -Z axis (three.js convention). Quaternions are [x, y, z, w].
 */
import type { Transform } from '@ai-assistant/shared'
import type { Result } from '../util/result'
import { fail, ok } from '../util/result'
import { round } from '../util/math'

export type V3 = [number, number, number]
export type Q4 = [number, number, number, number]

export const IDENTITY_Q: Q4 = [0, 0, 0, 1]
export const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }

export const MAX_COORD = 1000
export const MIN_SCALE = 0.01
export const MAX_SCALE = 100

const finite3 = (v: readonly number[]): boolean => v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

export function quatLength(q: readonly number[]): number {
  return Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)
}

export function quatNormalize(q: Q4): Q4 {
  const l = quatLength(q)
  return l === 0 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function quatMul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

export function rotateVec(q: Q4, v: V3): V3 {
  // v' = q * (v, 0) * q^-1, expanded
  const [qx, qy, qz, qw] = q
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)]
}

/** Rotation about the Y axis by `rad` (positive = counter-clockwise seen from above). */
export function quatFromYaw(rad: number): Q4 {
  return [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)]
}

/** Orientation for an object at `eye` that looks (down its -Z) at `target`, with `up`. Same as three.js Matrix4.lookAt. */
export function lookAtQuat(eye: V3, target: V3, up: V3 = [0, 1, 0]): Q4 {
  let zx = eye[0] - target[0]
  let zy = eye[1] - target[1]
  let zz = eye[2] - target[2]
  let zl = Math.hypot(zx, zy, zz)
  if (zl === 0) {
    zz = 1
    zl = 1
  }
  zx /= zl
  zy /= zl
  zz /= zl
  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  let xl = Math.hypot(xx, xy, xz)
  if (xl === 0) {
    // up parallel to the view direction: nudge
    xx = 1
    xy = 0
    xz = 0
    xl = 1
  }
  xx /= xl
  xy /= xl
  xz /= xl
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  // rotation matrix columns are x, y, z
  const m11 = xx, m12 = yx, m13 = zx
  const m21 = xy, m22 = yy, m23 = zy
  const m31 = xz, m32 = yz, m33 = zz
  const trace = m11 + m22 + m33
  let q: Q4
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]
  }
  return quatNormalize(q)
}

export const roundVec = (v: readonly number[], d = 4): V3 => [round(v[0]!, d), round(v[1]!, d), round(v[2]!, d)]
export const roundQuat = (q: readonly number[], d = 5): Q4 => [round(q[0]!, d), round(q[1]!, d), round(q[2]!, d), round(q[3]!, d)]

/** parent ∘ child. Scale is composed component-wise (exact for uniform scale, the common case). */
export function composeTransforms(parent: Transform, child: Transform): Transform {
  const ps = parent.scale
  const scaled: V3 = [child.position[0] * ps[0], child.position[1] * ps[1], child.position[2] * ps[2]]
  const rotated = rotateVec(parent.rotation as Q4, scaled)
  return {
    position: [parent.position[0] + rotated[0], parent.position[1] + rotated[1], parent.position[2] + rotated[2]],
    rotation: quatNormalize(quatMul(parent.rotation as Q4, child.rotation as Q4)),
    scale: [ps[0] * child.scale[0], ps[1] * child.scale[1], ps[2] * child.scale[2]],
  }
}

/** Validate and normalise a transform: finite, bounded, a unit quaternion, strictly positive bounded scale. */
export function validateTransform(t: unknown, what = 'transform'): Result<Transform> {
  if (t === null || typeof t !== 'object') return fail('invalid_transform', `${what} must be an object`)
  const { position, rotation, scale } = t as Record<string, unknown>
  if (!Array.isArray(position) || !finite3(position)) return fail('invalid_transform', `${what}.position must be three finite numbers`)
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every((n) => typeof n === 'number' && Number.isFinite(n))) return fail('invalid_transform', `${what}.rotation must be four finite numbers`)
  if (!Array.isArray(scale) || !finite3(scale)) return fail('invalid_transform', `${what}.scale must be three finite numbers`)
  if ((position as number[]).some((n) => Math.abs(n) > MAX_COORD)) return fail('invalid_transform', `${what}.position is out of range (+-${MAX_COORD} m)`)
  if ((scale as number[]).some((n) => n < MIN_SCALE || n > MAX_SCALE)) return fail('invalid_transform', `${what}.scale must be within ${MIN_SCALE}..${MAX_SCALE}`)
  const len = quatLength(rotation as number[])
  if (len < 1e-6 || len > 1e6) return fail('invalid_transform', `${what}.rotation must be a non-zero quaternion`)
  const q = quatNormalize(rotation as Q4)
  return ok({ position: [...(position as V3)] as V3, rotation: q, scale: [...(scale as V3)] as V3 })
}

export const identityTransform = (): Transform => structuredClone(IDENTITY)
