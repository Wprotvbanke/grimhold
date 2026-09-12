import {
  AOI_RADIUS,
  CHUNK_SIZE,
  ChunkedWorld,
  RACES,
  SKILLS,
  aabbOverlap,
  attributesFor,
  chunkKey,
  fullVitals,
  isInsideWorld,
  maxHealth,
  maxMana,
  maxStamina,
  mobsForChunk,
  playerAabb,
  step,
  NODES,
  findNode,
  type ResourceNode,
  WORLD_CHUNK_RADIUS,
  type Attributes,
  type CharacterClass,
  type EntitySnapshot,
  type MoveInput,
  type MoveState,
  type ProjectileSnapshot,
  type Race,
  type SelfState,
  type SkillId,
  type SkillProgress,
  type SpellId,
  type Equipment,
  type Grid,
  type Hotbar,
  type ItemId,
  type InventoryMessage,
  type RecipeId,
  carryCapacity,
  createBackpack,
  createBank,
  createHotbar,
  createMoveState,
  equipmentArmor,
  equipmentWeight,
  totalWeight,
  weaponDamageOf,
} from '@grimhold/shared';
import { speedMultiplier, type Combatant } from './combatant.js';
import { PositionHistory } from './history.js';
import { createMob, isCorpseVisible, type Mob } from './mob.js';
import { createNpc, npcIntent, type Npc } from './npc.js';
import type { Projectile } from './projectile.js';

/**
 * Состояние мира живёт в памяти — это источник истины во время игры.
 * База это слой долговечности: пакетный флаш раз в минуту плюс немедленная
 * запись критичных событий.
 */

/**
 * Идентификатор инстанса. Изоляция строится на нём, а не на отдельных мап-левелах:
 * геометрия интерьеров лежит в том же мировом пространстве со смещением, а игроки
 * из разных инстансов просто не попадают в снапшоты друг друга.
 */
export type InstanceId = string;

export const OVERWORLD: InstanceId = 'overworld';

/** Дальше этого мобы не думают: считать ИИ для пустых чанков незачем. */
const MOB_ACTIVE_RANGE = 90;

/**
 * Стол обмена. Один объект на двоих: обе стороны смотрят на одно и то же
 * состояние, иначе подтверждение ничего не значит.
 */
export interface Trade {
  a: Player;
  b: Player;
  offerA: { itemId: ItemId; count: number }[];
  offerB: { itemId: ItemId; count: number }[];
  lockA: boolean;
  lockB: boolean;
  /** Приглашённый согласился сесть за стол. До этого класть нечего. */
  accepted: boolean;
}

export interface Player {
  id: string;
  /** Идентификатор персонажа в базе — по нему идёт сохранение. */
  characterId: string;
  accountId: string;
  name: string;
  race: Race;
  characterClass: CharacterClass;
  playtimeSeconds: number;
  /** Момент, до которого время в игре уже зачтено. */
  lastAccountedAt: number;
  instanceId: InstanceId;
  state: MoveState;
  /** Ввод, накопленный с прошлого тика. Обрабатывается в порядке поступления. */
  pendingInputs: MoveInput[];
  /** Номер последнего обработанного ввода — клиент по нему делает реконсилиацию. */
  lastProcessedSeq: number;
  /**
   * Последнее присланное намерение движения.
   *
   * Нужно рывку: он разрешён только в сторону — вперёд, назад, вбок или
   * в прыжке. Берём самое свежее намерение, а не обработанное в тике:
   * команда действия приходит между тиками, и обработанное к тому моменту
   * отстаёт на целый шаг.
   */
  lastIntent: { forward: number; right: number; jump: boolean };
  /** Секунд до следующего удара по ресурсной ноде. */
  harvestCooldown: number;
  /**
   * Начатая работа, если игрок сейчас мастерит.
   *
   * Длительность лежит здесь же, а не берётся из рецепта на месте: полосу
   * на клиенте надо чем-то заполнять, и обе величины должны прийти вместе.
   */
  crafting: { recipeId: RecipeId; duration: number; remaining: number } | null;
  /**
   * Игрок попросил воскресить, но срок лежания ещё не вышел.
   *
   * Просьба не отбрасывается, а ждёт своего часа: раньше ранний клик пропадал
   * молча, клиент к тому времени уже убирал экран смерти, и игрок оставался
   * ходить мёртвым — его не видели, он не мог бить, здоровье оставалось нулём.
   */
  wantsRespawn: boolean;
  /** Помечается при любом изменении; персистентность использует это для батча. */
  dirty: boolean;

  attributes: Attributes;
  maxima: { health: number; mana: number; stamina: number };
  combat: Combatant;
  skills: Record<SkillId, SkillProgress>;
  /** Секунд до возможности воскреснуть. */
  deadFor: number;
  /** Когда каждое заклинание снова готово, в секундах игрового времени. */
  spellCooldowns: Partial<Record<SpellId, number>>;
  /** Рюкзак: раскладку хранит и проверяет сервер, клиент только рисует. */
  inventory: Grid;
  /**
   * Городская казна — общая на аккаунт, а не на персонажа.
   *
   * Грузится один раз при входе в мир: строчка в базе, зато не нужен поход
   * в хранилище посреди тика. Пишется немедленно при каждой операции.
   */
  bank: Grid;
  /** Открыт ли сундук. Пока открыт, клиент получает содержимое казны. */
  bankOpen: boolean;
  /** Стол обмена, если игрок за ним сидит. Общий объект с собеседником. */
  trade: Trade | null;
  equipment: Equipment;
  knownRecipes: RecipeId[];
  hotbar: Hotbar;
  /** Текущий вес — считается при каждом изменении вещей, а не каждый тик. */
  carriedWeight: number;
  /** Куда смотрит по вертикали — нужно снарядам. */
  pitch: number;
  /**
   * Номер снапшота, который игрок видел в момент удара.
   * По нему сервер отматывает цели назад — см. history.ts.
   */
  pendingViewTick: number | null;
}

export class World {
  readonly players = new Map<string, Player>();
  /** Мирные жители по инстансам. */
  readonly npcs = new Map<InstanceId, Npc[]>();
  /** Мобы по инстансам. */
  readonly mobs = new Map<InstanceId, Mob[]>();
  readonly projectiles: Projectile[] = [];
  readonly history = new PositionHistory();

  tick = 0;
  /** Игровое время в секундах. */
  elapsed = 0;

  private readonly terrain = new Map<InstanceId, ChunkedWorld>();
  private nextId = 1;

  // ---------- игроки ----------

  spawnPlayer(character: {
    id: string;
    accountId: string;
    name: string;
    race: Race;
    characterClass: CharacterClass;
    x: number;
    y: number;
    z: number;
    yaw: number;
    instanceId: string;
    playtimeSeconds: number;
    inventory?: Grid;
    bank?: Grid;
    equipment?: Equipment;
    knownRecipes?: RecipeId[];
    hotbar?: Hotbar;
  }): Player {
    const profile = RACES[character.race];
    const attributes = attributesFor(character.race, character.characterClass);
    const body = { radius: profile.radius, height: profile.height };

    const state = createMoveState(
      { x: character.x, y: character.y, z: character.z },
      { body, speedScale: profile.speedScale },
    );
    state.yaw = character.yaw;

    const id = `p${this.nextId++}`;
    const maxima = {
      health: maxHealth(attributes),
      mana: maxMana(attributes),
      stamina: maxStamina(attributes),
    };

    const player: Player = {
      id,
      characterId: character.id,
      accountId: character.accountId,
      name: character.name,
      race: character.race,
      characterClass: character.characterClass,
      playtimeSeconds: character.playtimeSeconds,
      lastAccountedAt: Date.now(),
      instanceId: character.instanceId,
      state,
      pendingInputs: [],
      lastProcessedSeq: -1,
      lastIntent: { forward: 0, right: 0, jump: false },
      harvestCooldown: 0,
      crafting: null,
      wantsRespawn: false,
      dirty: true,
      attributes,
      maxima,
      skills: emptySkillBook(),
      deadFor: 0,
      spellCooldowns: {},
      inventory: character.inventory ?? createBackpack(),
      bank: character.bank ?? createBank(),
      bankOpen: false,
      trade: null,
      equipment: character.equipment ?? {},
      knownRecipes: character.knownRecipes ?? [],
      hotbar: character.hotbar ?? defaultHotbar(character.characterClass),
      carriedWeight: 0,
      pitch: 0,
      pendingViewTick: null,
      combat: {
        id,
        name: character.name,
        instanceId: character.instanceId,
        pos: { x: character.x, y: character.y, z: character.z },
        yaw: character.yaw,
        radius: profile.radius,
        height: profile.height,
        vitals: fullVitals(attributes),
        attributes,
        armor: 0,
        alive: true,
        action: null,
        blocking: false,
        invulnerable: 0,
        sinceStaminaUse: 99,
        wardArmor: 0,
        wardRemaining: 0,
        slowFactor: 1,
        slowRemaining: 0,
        lightRemaining: 0,
        dodgeCooldown: 0,
        swingCooldown: 0,
      },
    };

    // Броня и вес выводятся из надетого — пересчитываем сразу при входе.
    refreshLoadout(player);

    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.history.forget(id);
  }

  findByCharacterId(characterId: string): Player | null {
    for (const player of this.players.values()) {
      if (player.characterId === characterId) return player;
    }
    return null;
  }

  playersNear(origin: { x: number; z: number }, instanceId: InstanceId): Player[] {
    const result: Player[] = [];
    for (const player of this.players.values()) {
      if (player.instanceId !== instanceId) continue;
      if (!withinAoi(origin, player.state.pos)) continue;
      result.push(player);
    }
    return result;
  }

  /** Все бойцы инстанса: игроки и мобы вместе — удар обрабатывается одинаково. */
  combatantsIn(instanceId: InstanceId): Combatant[] {
    const result: Combatant[] = [];
    for (const player of this.players.values()) {
      if (player.instanceId === instanceId) result.push(player.combat);
    }
    for (const mob of this.mobs.get(instanceId) ?? []) {
      if (mob.instanceId === instanceId) result.push(mob);
    }
    return result;
  }

  playerByCombatantId(id: string): Player | null {
    return this.players.get(id) ?? null;
  }

  mobByCombatantId(instanceId: InstanceId, id: string): Mob | null {
    return (this.mobs.get(instanceId) ?? []).find((mob) => mob.id === id) ?? null;
  }

  // ---------- геометрия ----------

  /**
   * Коллизии вокруг точки. Берутся из чанка под ней и восьми соседних —
   * держать в памяти весь мир не нужно, а шаг симуляции дальше и не уходит.
   */
  collidersAt(instanceId: InstanceId, x: number, z: number) {
    return this.terrainOf(instanceId).collidersAt(x, z);
  }

  private terrainOf(instanceId: InstanceId): ChunkedWorld {
    let terrain = this.terrain.get(instanceId);
    if (!terrain) {
      terrain = new ChunkedWorld();
      this.terrain.set(instanceId, terrain);
    }
    return terrain;
  }

  // ---------- население ----------

  addNpc(npc: Npc, instanceId: InstanceId = OVERWORLD): Npc {
    const list = this.npcs.get(instanceId) ?? [];
    list.push(npc);
    this.npcs.set(instanceId, list);
    return npc;
  }

  spawnNpc(
    name: string,
    race: Race,
    waypoints: { x: number; y: number; z: number }[],
    instanceId: InstanceId = OVERWORLD,
  ): Npc {
    return this.addNpc(createNpc(`n${this.nextId++}`, name, race, waypoints), instanceId);
  }

  /**
   * Заселяет дикие земли. Позиции подбираются детерминированно и проверяются
   * на пересечение с камнями — иначе моб появится внутри валуна и застрянет.
   */
  populateMobs(instanceId: InstanceId = OVERWORLD): number {
    const list = this.mobs.get(instanceId) ?? [];
    const terrain = this.terrainOf(instanceId);

    for (let cx = -WORLD_CHUNK_RADIUS; cx <= WORLD_CHUNK_RADIUS; cx++) {
      for (let cz = -WORLD_CHUNK_RADIUS; cz <= WORLD_CHUNK_RADIUS; cz++) {
        if (!isInsideWorld(cx, cz)) continue;

        const roster = mobsForChunk(cx, cz);
        if (roster.length === 0) continue;

        const random = seededRandom(chunkKey(cx, cz));
        const originX = cx * CHUNK_SIZE;
        const originZ = cz * CHUNK_SIZE;

        for (const mobId of roster) {
          const home = findFreeSpot(terrain, originX, originZ, random);
          if (!home) continue;
          list.push(createMob(`m${this.nextId++}`, mobId, home, instanceId));
        }
      }
    }

    this.mobs.set(instanceId, list);
    return list.length;
  }

  /**
   * Стоит ли считать ИИ этого моба. Мобов в мире под две сотни, и гонять
   * автомат для тех, рядом с кем никого нет, — пустая работа каждый тик.
   */
  isMobActive(mob: Mob, players: Player[]): boolean {
    for (const player of players) {
      const dx = player.state.pos.x - mob.pos.x;
      const dz = player.state.pos.z - mob.pos.z;
      if (dx * dx + dz * dz < MOB_ACTIVE_RANGE * MOB_ACTIVE_RANGE) return true;
    }
    return false;
  }

  /** Прогоняет мирных жителей через ту же симуляцию, что и игроков. */
  stepNpcs(dt: number): void {
    this.elapsed += dt;
    for (const [instanceId, list] of this.npcs) {
      for (const npc of list) {
        const colliders = this.collidersAt(instanceId, npc.state.pos.x, npc.state.pos.z);
        npc.state = step(npc.state, npcIntent(npc, this.elapsed, dt), colliders);
      }
    }
  }

  /** Двигает моба тем же шагом симуляции, что и игроков. */
  stepMob(mob: Mob, input: MoveInput, dt: number): void {
    void dt;
    const colliders = this.collidersAt(mob.instanceId, mob.state.pos.x, mob.state.pos.z);
    const slowed = speedMultiplier(mob);
    const base = mob.profile.speedScale;

    mob.state = step({ ...mob.state, speedScale: base * slowed }, input, colliders);
    mob.pos = mob.state.pos;
    mob.yaw = mob.state.yaw;
  }

  nextEntityId(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }

  // ---------- снапшоты ----------

  selfStateOf(player: Player): SelfState {
    const { pos, vel, onGround } = player.state;
    const combat = player.combat;
    return {
      x: round(pos.x),
      y: round(pos.y),
      z: round(pos.z),
      vx: round(vel.x),
      vy: round(vel.y),
      vz: round(vel.z),
      onGround,
      health: Math.round(combat.vitals.health),
      maxHealth: player.maxima.health,
      mana: Math.round(combat.vitals.mana),
      maxMana: player.maxima.mana,
      stamina: Math.round(combat.vitals.stamina),
      maxStamina: player.maxima.stamina,
      alive: combat.alive,
      blocking: combat.blocking,
      action: combat.action?.kind,
      phase: combat.action?.phase,
      invulnerable: round(combat.invulnerable),
      light: round(combat.lightRemaining),
    };
  }

  /**
   * Что видит игрок: свой инстанс и радиус интереса.
   * Фильтр по радиусу — не только экономия трафика: клиент физически
   * не получает данных о тех, кого не должен видеть.
   */
  snapshotFor(viewer: Player): EntitySnapshot[] {
    const entities: EntitySnapshot[] = [];
    const origin = viewer.state.pos;

    for (const player of this.players.values()) {
      if (player.instanceId !== viewer.instanceId) continue;
      if (player.id !== viewer.id && !withinAoi(origin, player.state.pos)) continue;
      entities.push({
        id: player.id,
        name: player.name,
        kind: 'player',
        race: player.race,
        x: round(player.state.pos.x),
        y: round(player.state.pos.y),
        z: round(player.state.pos.z),
        yaw: round(player.state.yaw),
        hp: fraction(player.combat.vitals.health, player.maxima.health),
        alive: player.combat.alive,
        action: player.combat.action?.kind,
        phase: player.combat.action?.phase,
      });
    }

    for (const npc of this.npcs.get(viewer.instanceId) ?? []) {
      if (!withinAoi(origin, npc.state.pos)) continue;
      entities.push({
        id: npc.id,
        name: npc.name,
        kind: 'npc',
        race: npc.race,
        x: round(npc.state.pos.x),
        y: round(npc.state.pos.y),
        z: round(npc.state.pos.z),
        yaw: round(npc.state.yaw),
        hp: 1,
        alive: true,
      });
    }

    for (const mob of this.mobs.get(viewer.instanceId) ?? []) {
      // Мёртвые едут в снапшоте ещё несколько секунд: клиент роняет тело.
      if (!mob.alive && !isCorpseVisible(mob)) continue;
      if (!withinAoi(origin, mob.pos)) continue;
      entities.push({
        id: mob.id,
        name: mob.name,
        kind: 'mob',
        race: 'human',
        mobId: mob.mobId,
        x: round(mob.pos.x),
        y: round(mob.pos.y),
        z: round(mob.pos.z),
        yaw: round(mob.yaw),
        hp: fraction(mob.vitals.health, mob.profile.health),
        alive: mob.alive,
        // Замах моба видно — по нему игрок решает, отходить или блокировать.
        action: mob.windupRemaining > 0 ? 'heavy' : undefined,
        phase: mob.windupRemaining > 0 ? 'windup' : undefined,
      });
    }

    return entities;
  }

  /** Состояние вещей игрока — уходит ему при каждом изменении. */
  inventoryMessage(player: Player): InventoryMessage {
    return {
      t: 'inventory',
      backpack: player.inventory,
      equipment: player.equipment,
      knownRecipes: player.knownRecipes,
      hotbar: player.hotbar,
      weight: Math.round(player.carriedWeight * 10) / 10,
      capacity: Math.round(carryCapacity(player.attributes)),
      armor: player.combat.armor,
      weaponDamage: weaponDamageOf(player.equipment),
    };
  }

  projectilesFor(viewer: Player): ProjectileSnapshot[] {
    const origin = viewer.state.pos;
    const result: ProjectileSnapshot[] = [];
    for (const projectile of this.projectiles) {
      if (projectile.instanceId !== viewer.instanceId) continue;
      if (!withinAoi(origin, projectile.pos)) continue;
      result.push({
        id: projectile.id,
        spellId: projectile.spellId,
        x: round(projectile.pos.x),
        y: round(projectile.pos.y),
        z: round(projectile.pos.z),
      });
    }
    return result;
  }

  // ---------- ресурсные ноды ----------

  /**
   * Состояние тронутых нод: сколько зарядов осталось и сколько ждать
   * восстановления. Нетронутых тут нет — их тысячи, и они выводятся
   * генератором, а хранить стоит только исключения.
   */
  private readonly nodeStates = new Map<string, { charges: number; respawnIn: number }>();

  private nodeKey(instanceId: InstanceId, nodeId: string): string {
    return `${instanceId}|${nodeId}`;
  }

  /** Сколько ударов нода ещё держит. Нетронутая отвечает своим запасом. */
  nodeCharges(instanceId: InstanceId, node: ResourceNode): number {
    return this.nodeStates.get(this.nodeKey(instanceId, node.id))?.charges ?? NODES[node.nodeId].charges;
  }

  /** Снимает один заряд. Возвращает true, если нода после этого истощилась. */
  spendNode(instanceId: InstanceId, node: ResourceNode): boolean {
    const profile = NODES[node.nodeId];
    const key = this.nodeKey(instanceId, node.id);
    const left = (this.nodeStates.get(key)?.charges ?? profile.charges) - 1;

    this.nodeStates.set(key, {
      charges: Math.max(0, left),
      respawnIn: left <= 0 ? profile.respawn : 0,
    });
    return left <= 0;
  }

  /** Отсчёт восстановления. Восстановившаяся нода просто забывается. */
  tickNodes(dt: number): void {
    for (const [key, state] of this.nodeStates) {
      if (state.respawnIn <= 0) continue;
      state.respawnIn -= dt;
      if (state.respawnIn <= 0) this.nodeStates.delete(key);
    }
  }

  /**
   * Истощённые ноды рядом с игроком.
   *
   * Радиус шире боевого: ноды стоят на месте, и клиент рисует их на всю
   * глубину загруженных чанков. Перебираем только тронутые — их единицы.
   */
  depletedNodesFor(viewer: Player): string[] {
    const prefix = `${viewer.instanceId}|`;
    const origin = viewer.state.pos;
    const result: string[] = [];

    for (const [key, state] of this.nodeStates) {
      if (state.charges > 0 || !key.startsWith(prefix)) continue;

      const id = key.slice(prefix.length);
      const node = findNode(id);
      if (!node) continue;
      if (Math.hypot(node.x - origin.x, node.z - origin.z) > NODE_VIEW_RANGE) continue;
      result.push(id);
    }

    return result;
  }
}

/** Насколько далеко игроку сообщают про истощённые ноды. */
const NODE_VIEW_RANGE = CHUNK_SIZE * 1.5;

/**
 * Что лежит в панели у новичка. Панель — про быстрый доступ, поэтому туда
 * сразу попадает то, чем он реально будет пользоваться с первой минуты.
 */
function defaultHotbar(characterClass: CharacterClass): Hotbar {
  const hotbar = createHotbar();
  hotbar[0] = 'crude_axe';
  hotbar[1] = 'bandage';
  hotbar[2] = 'torch';

  if (characterClass === 'mage') {
    hotbar[3] = 'spell_ember';
    hotbar[4] = 'spell_mend';
  }
  return hotbar;
}

/**
 * Пересчитывает всё, что выводится из вещей: броню и переносимый вес.
 *
 * Вызывается при любом изменении рюкзака или экипировки — иначе игрок мог бы
 * снять доспех и остаться с его бронёй. Единственное место такого вывода,
 * чтобы ни один путь изменения вещей не мог его обойти.
 */
export function refreshLoadout(player: Player): void {
  player.combat.armor = equipmentArmor(player.equipment);
  player.carriedWeight = totalWeight(player.inventory) + equipmentWeight(player.equipment);
  player.dirty = true;
}

// ---------- вспомогательное ----------

function emptySkillBook(): Record<SkillId, SkillProgress> {
  const book = {} as Record<SkillId, SkillProgress>;
  for (const id of Object.keys(SKILLS) as SkillId[]) {
    book[id] = { level: 0, experience: 0 };
  }
  return book;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fraction(current: number, max: number): number {
  return Math.max(0, Math.min(1, Math.round((current / max) * 100) / 100));
}

function withinAoi(origin: { x: number; z: number }, target: { x: number; z: number }): boolean {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  return dx * dx + dz * dz <= AOI_RADIUS * AOI_RADIUS;
}

/** Детерминированный генератор от строкового ключа. */
function seededRandom(key: string): () => number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let a = hash >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ищет свободное место под спавн: моб внутри валуна застрянет навсегда. */
function findFreeSpot(
  terrain: ChunkedWorld,
  originX: number,
  originZ: number,
  random: () => number,
): { x: number; y: number; z: number } | null {
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = originX + (random() - 0.5) * (CHUNK_SIZE - 12);
    const z = originZ + (random() - 0.5) * (CHUNK_SIZE - 12);
    const candidate = { x, y: 0.1, z };
    const body = playerAabb(candidate, { radius: 0.9, height: 2.9 });

    const blocked = terrain
      .collidersAt(x, z)
      .some((box) => box.maxY > 0.05 && aabbOverlap(body, box));

    if (!blocked) return candidate;
  }
  return null;
}
