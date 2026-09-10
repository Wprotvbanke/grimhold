/** Сводка по населению мира: сколько кого расселяется по чанкам. */
import { MOBS, WORLD_CHUNK_RADIUS, isInsideWorld, mobsForChunk, type MobId } from '@grimhold/shared';

const counts = new Map<MobId, number>();
for (let cx = -WORLD_CHUNK_RADIUS; cx <= WORLD_CHUNK_RADIUS; cx++) {
  for (let cz = -WORLD_CHUNK_RADIUS; cz <= WORLD_CHUNK_RADIUS; cz++) {
    if (!isInsideWorld(cx, cz)) continue;
    for (const id of mobsForChunk(cx, cz)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
}

let total = 0;
for (const [id, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  const p = MOBS[id];
  console.log(
    `${p.name.padEnd(12)} ×${String(count).padStart(3)}  ` +
    `${p.health} hp · ${p.damage} урона · замах ${p.windup} с · обзор ${p.aggroRange} м`,
  );
  total += count;
}
console.log(`\nвсего мобов в мире: ${total}`);
