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

/**
 * Пересекает ли отрезок коробку.
 *
 * Плитный тест (slab): по каждой оси считаем, на каком участке пути отрезок
 * находится внутри полосы коробки, и смотрим, есть ли у трёх участков общая
 * часть. Нужен, чтобы понять, **видно ли одно из другого** — стоит ли между
 * ними стена.
 */
export function segmentHitsAabb(
  from: Vec3,
  to: Vec3,
  box: Aabb,
): boolean {
  const axes: [number, number, number, number, number, number][] = [
    [from.x, to.x, box.minX, box.maxX, 0, 0],
    [from.y, to.y, box.minY, box.maxY, 0, 0],
    [from.z, to.z, box.minZ, box.maxZ, 0, 0],
  ];

  let enter = 0;
  let exit = 1;
  for (const [start, end, low, high] of axes) {
    const delta = end - start;
    // Отрезок идёт поперёк этой оси: либо он весь внутри полосы, либо мимо.
    if (Math.abs(delta) < 1e-9) {
      if (start < low || start > high) return false;
      continue;
    }
    const first = (low - start) / delta;
    const second = (high - start) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return true;
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
