import {
  SPELLS,
  aabbOverlap,
  spellDamage,
  type Aabb,
  type Attributes,
  type CombatEvent,
  type SpellId,
  type Vec3,
} from '@grimhold/shared';
import { applyDamage, type Combatant } from './combatant.js';
import { markAggressor, mayAttack, punishKill } from './pvp.js';

/**
 * Снаряды заклинаний.
 *
 * Летят настоящим телом, а не мгновенным лучом: от «Уголька» можно отойти,
 * а «Разряд» с его долгим кастом и вовсе наказывает за неподвижность.
 * Мгновенное попадание обесценило бы весь экшен-бой.
 */

export interface Projectile {
  id: string;
  ownerId: string;
  ownerName: string;
  instanceId: string;
  spellId: SpellId;
  pos: Vec3;
  velocity: Vec3;
  /** Секунд до самоуничтожения. */
  lifetime: number;
  /** Уровень навыка стрелявшего на момент выстрела. */
  skillLevel: number;
  /**
   * Атрибуты заклинателя на момент выстрела. Снаряд летит сам по себе,
   * и к попаданию хозяин может быть уже мёртв — поэтому силу заклинания
   * фиксируем при вылете, а не ищем стрелявшего потом.
   */
  casterAttributes: Attributes;
}

const RADIUS = 0.25;

/**
 * Максимальный шаг снаряда за одну проверку.
 *
 * «Разряд» летит 42 м/с, то есть за тик 20 Гц проходит 2.1 метра — больше
 * ширины человека. Без дробления шага он пролетал бы сквозь цель и сквозь
 * тонкие стены. Поэтому движение режется на куски меньше радиуса тела.
 */
const MAX_SUBSTEP = 0.25;

export function createProjectile(
  id: string,
  owner: Combatant,
  spellId: SpellId,
  pitch: number,
  skillLevel: number,
): Projectile {
  const spell = SPELLS[spellId];
  const speed = spell.projectileSpeed ?? 20;

  // Направление взгляда: yaw даёт горизонталь, pitch — наклон.
  const cosPitch = Math.cos(pitch);
  const dir = {
    x: -Math.sin(owner.yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(owner.yaw) * cosPitch,
  };

  return {
    id,
    ownerId: owner.id,
    ownerName: owner.name,
    instanceId: owner.instanceId,
    spellId,
    // Вылетает от груди, а не от ног — иначе задевает собственные ступени.
    pos: {
      x: owner.pos.x + dir.x * 0.6,
      y: owner.pos.y + owner.height * 0.75,
      z: owner.pos.z + dir.z * 0.6,
    },
    velocity: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
    lifetime: spell.range / speed,
    skillLevel,
    casterAttributes: owner.attributes,
  };
}

export interface ProjectileHit {
  event: CombatEvent;
  victim: Combatant | null;
  killed: boolean;
}

/**
 * Двигает снаряд на шаг. Возвращает попадание, если оно случилось,
 * либо null. Снаряд считается израсходованным, если lifetime вышел
 * или вернулось попадание.
 */
export function stepProjectile(
  projectile: Projectile,
  dt: number,
  combatants: Combatant[],
  colliders: readonly Aabb[],
): ProjectileHit | null {
  projectile.lifetime -= dt;

  const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z);
  const distance = speed * dt;
  const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
  const stepDt = dt / steps;

  for (let i = 0; i < steps; i++) {
    projectile.pos.x += projectile.velocity.x * stepDt;
    projectile.pos.y += projectile.velocity.y * stepDt;
    projectile.pos.z += projectile.velocity.z * stepDt;

    const hit = checkImpact(projectile, combatants, colliders);
    if (hit) return hit;
  }

  return null;
}

/** Проверка одного положения снаряда: сначала мир, затем бойцы. */
function checkImpact(
  projectile: Projectile,
  combatants: Combatant[],
  colliders: readonly Aabb[],
): ProjectileHit | null {
  const body = bodyOf(projectile.pos);

  // Столкновение с миром: снаряд просто гаснет.
  for (const box of colliders) {
    if (aabbOverlap(body, box)) {
      return { event: impactEvent(projectile, 'miss', '', '', 0), victim: null, killed: false };
    }
  }

  for (const target of combatants) {
    if (target.id === projectile.ownerId) continue;
    if (!aabbOverlap(body, combatantBox(target))) continue;

    // Снаряд подчиняется тем же правилам, что и меч: иначе в городе нельзя
    // было бы ударить, но можно было бы сжечь.
    const owner = combatants.find((entry) => entry.id === projectile.ownerId);
    if (owner && !mayAttack(owner, target).ok) continue;
    if (!owner && (!target.alive || target.instanceId !== projectile.instanceId)) continue;

    if (owner) markAggressor(owner, target);

    const spell = SPELLS[projectile.spellId];
    const raw = spellDamage(projectile.casterAttributes, spell.power, projectile.skillLevel);
    const result = applyDamage(target, raw, { blockReduction: 0.4, staminaOnBlock: 10 });
    if (result.killed && owner) punishKill(owner, target);

    return {
      event: {
        t: 'combat',
        kind: result.dodged ? 'dodged' : result.blocked ? 'blocked' : 'hit',
        attackerId: projectile.ownerId,
        attackerName: projectile.ownerName,
        targetId: target.id,
        targetName: target.name,
        amount: result.applied,
        backstab: false,
        x: projectile.pos.x,
        y: projectile.pos.y,
        z: projectile.pos.z,
      },
      victim: target,
      killed: result.killed,
    };
  }

  return null;
}

function bodyOf(pos: Vec3): Aabb {
  return {
    minX: pos.x - RADIUS,
    minY: pos.y - RADIUS,
    minZ: pos.z - RADIUS,
    maxX: pos.x + RADIUS,
    maxY: pos.y + RADIUS,
    maxZ: pos.z + RADIUS,
  };
}

function combatantBox(target: Combatant): Aabb {
  return {
    minX: target.pos.x - target.radius,
    minY: target.pos.y,
    minZ: target.pos.z - target.radius,
    maxX: target.pos.x + target.radius,
    maxY: target.pos.y + target.height,
    maxZ: target.pos.z + target.radius,
  };
}

function impactEvent(
  projectile: Projectile,
  kind: CombatEvent['kind'],
  targetId: string,
  targetName: string,
  amount: number,
): CombatEvent {
  return {
    t: 'combat',
    kind,
    attackerId: projectile.ownerId,
    attackerName: projectile.ownerName,
    targetId,
    targetName,
    amount,
    backstab: false,
    x: projectile.pos.x,
    y: projectile.pos.y,
    z: projectile.pos.z,
  };
}
