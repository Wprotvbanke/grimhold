export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Axis-aligned bounding box in world space. */
export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function boxFromCenter(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Aabb {
  return {
    minX: cx - sx / 2,
    minY: cy - sy / 2,
    minZ: cz - sz / 2,
    maxX: cx + sx / 2,
    maxY: cy + sy / 2,
    maxZ: cz + sz / 2,
  };
}

export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}
