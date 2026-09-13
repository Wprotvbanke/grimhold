import {
  MAX_INPUTS_PER_TICK,
  BLOCK_DRAIN,
  EXPERIENCE_PER_KILL,
  MOBS,
  SPAWN_POINT,
  SPELLS,
  SPRINT_DRAIN,
  addItem,
  itemDef,
  gainExperience,
  movementSpeedFactor,
  isItemId,
  KARMA_DECAY_PER_SECOND,
  RED_DROP_CHANCE,
  RED_SKILL_PENALTY,
  step,
  weaponDamageOf,
  weightSpeedFactor,
  type CombatEvent,
  type CraftingMessage,
  type EquipSlot,
  type GatheringMessage,
  type LifeMessage,
  type LootMessage,
  type ItemId,
  type SkillId,
  type SkillUpMessage,
  type SpellId,
} from '@grimhold/shared';
import { craftingMessage, finishCraft } from './commands/craft.js';
import { flagFor, forgiveForMob } from './pvp.js';
import { OVERWORLD } from './world.js';
import { finishHarvest, workMessage, outOfReach } from './commands/harvest.js';
import { finishChest } from './commands/chest.js';
import {
  applyDodgeImpulse,
  resolveCone,
  resolveMelee,
  resolveSelfSpell,
  FIST_DAMAGE,
  type CombatOutcome,
} from './combat.js';
import { speedMultiplier, tickCombatant, type Combatant } from './combatant.js';
import { decideMob, killMob, tickRespawn, type Mob, type MobTarget } from './mob.js';
import { applyDamage } from './combatant.js';
import { createProjectile, stepProjectile } from './projectile.js';
import { refreshLoadout, type Player, type World } from './world.js';

/**
 * Один тик мира: движение, бой, ИИ, снаряды, смерть.
 *
 * Все исходящие сообщения собираются в Outbox и рассылаются вызывающим кодом —
 * так игровая логика ничего не знает о сокетах и её можно гонять в тестах.
 */

export interface Outbox {
  /**
   * Событие боя и место, рядом с которым его слышно.
   * Инстанс обязателен: без него события подземелья ушли бы в открытый мир.
   */
  combat: { event: CombatEvent; near: { x: number; z: number }; instanceId: string }[];
  skillUps: { playerId: string; message: SkillUpMessage }[];
  life: { playerId: string; message: LifeMessage }[];
  loot: { playerId: string; message: LootMessage }[];
  /**
   * Игроки, которым надо переслать состояние вещей.
   *
   * Рюкзак меняется не только по команде игрока: лут падает в него сам, по ходу
   * тика. Раньше клиенту об этом не сообщали, и добыча оставалась невидимой,
   * пока игрок не трогал что-нибудь руками — а значит, он перетаскивал вещи
   * по устаревшей картинке и получал отказы на клетках, выглядящих пустыми.
   */
  inventory: Player[];
  /** Ход изготовления: начало и конец работы. */
  crafting: { playerId: string; message: CraftingMessage }[];
  /** Ход добычи: начало и конец работы у ноды. */
  gathering: { playerId: string; message: GatheringMessage }[];
  /** Короткие объяснения игроку: почему не вышло. */
  itemErrors: { playerId: string; message: string }[];
  /** Игроки, которых надо немедленно записать в базу (смерть — критичное событие). */
  criticalSaves: Player[];
}

export function emptyOutbox(): Outbox {
  return {
    combat: [],
    skillUps: [],
    life: [],
    loot: [],
    inventory: [],
    crafting: [],
    gathering: [],
    itemErrors: [],
    criticalSaves: [],
  };
}

/** Сколько секунд лежать до возможности воскреснуть. */
const DEATH_DELAY = 3;

export function tickWorld(world: World, dt: number, outbox: Outbox): void {
  world.tick++;
  world.stepNpcs(dt);
  world.tickNodes(dt);

  tickPlayers(world, dt, outbox);
  tickMobs(world, dt, outbox);
  tickProjectiles(world, dt, outbox);
  recordHistory(world);
}

// ---------- игроки ----------

function tickPlayers(world: World, dt: number, outbox: Outbox): void {
  for (const player of world.players.values()) {
    const combat = player.combat;

    // Карма сходит сама, фиолетовый гаснет по таймеру. И то и другое идёт
    // и у мёртвого: отлежаться от флага нельзя, но и висеть он вечно не должен.
    combat.karma = Math.max(0, combat.karma - KARMA_DECAY_PER_SECOND * dt);
    combat.purpleFor = Math.max(0, combat.purpleFor - dt);

    // Работа идёт, пока игрок стоит у цели: отошёл — брошена. Это и есть
    // способ передумать, отдельной кнопки отмены не нужно. Одинаково для
    // дерева и для сундука: механика одна.
    if (player.work) {
      if (outOfReach(player, player.work)) {
        player.work = null;
        outbox.gathering.push({
          playerId: player.id,
          message: workMessage(player, 'Ты отошёл'),
        });
      } else {
        player.work.remaining -= dt;
        if (player.work.remaining <= 0) {
          const done =
            player.work.kind === 'chest' ? finishChest(player, world) : finishHarvest(player, world);

          for (const event of done) {
            if (event.type === 'gathering') {
              outbox.gathering.push({
                playerId: player.id,
                message: workMessage(player, event.note as string | undefined),
              });
            }
            if (event.type === 'inventory') outbox.inventory.push(player);
            if (event.type === 'criticalSave') outbox.criticalSaves.push(player);
            if (event.type === 'loot') {
              outbox.loot.push({ playerId: player.id, message: event.message as LootMessage });
            }
          }
        }
      }
    }

    // Работа идёт, пока игрок жив: полосу двигает клиент, а конец назначает
    // сервер — иначе изделие зависело бы от частоты кадров у мастера.
    if (player.crafting) {
      player.crafting.remaining -= dt;
      if (player.crafting.remaining <= 0) {
        for (const event of finishCraft(player)) {
          if (event.type === 'crafting') {
            outbox.crafting.push({
              playerId: player.id,
              message: craftingMessage(player, event.note as string | undefined),
            });
          }
          if (event.type === 'inventory') outbox.inventory.push(player);
          if (event.type === 'loot') {
            outbox.loot.push({ playerId: player.id, message: event.message as LootMessage });
          }
        }
      }
    }

    // Мёртвый не двигается и не действует, только отсчитывает время до подъёма.
    if (!combat.alive) {
      player.deadFor += dt;
      player.pendingInputs.length = 0;

      // Смерть прерывает работу: заряд ноды цел, замок не поддался.
      if (player.work) {
        player.work = null;
        outbox.gathering.push({
          playerId: player.id,
          message: workMessage(player, 'Работа брошена'),
        });
      }

      // Смерть прерывает работу: сырьё цело, изделия нет.
      if (player.crafting) {
        player.crafting = null;
        outbox.crafting.push({
          playerId: player.id,
          message: craftingMessage(player, 'Работа брошена'),
        });
      }

      /**
       * Ранняя просьба о воскрешении не пропадает, а ждёт срока.
       *
       * Раньше сервер её молча отбрасывал, если игрок нажимал кнопку в первые
       * три секунды. Клиент к тому моменту уже убирал экран смерти, и человек
       * оставался ходить мёртвым: невидимый для других, без возможности бить
       * и с нулём здоровья. Отказ без ответа — худший вид отказа.
       */
      if (player.wantsRespawn && canRespawn(player)) {
        player.wantsRespawn = false;
        outbox.life.push({ playerId: player.id, message: respawnPlayer(world, player) });
        // Воскрешение меняет положение и здоровье — пишем немедленно.
        outbox.criticalSaves.push(player);
      }
      continue;
    }

    const before = combat.action?.phase;
    const { enteredActive } = tickCombatant(combat, dt, player.maxima);

    // Блок ест стамину, пока поднят щит.
    if (combat.blocking) {
      combat.vitals.stamina -= BLOCK_DRAIN * dt;
      combat.sinceStaminaUse = 0;
      if (combat.vitals.stamina <= 0) {
        combat.vitals.stamina = 0;
        combat.blocking = false;
      }
    }

    applyMovement(world, player, dt);

    // Фаза удара наступила — единственный момент, когда проверяется попадание.
    if (enteredActive && combat.action && !combat.action.resolved) {
      combat.action.resolved = true;
      const kind = combat.action.kind;

      if (kind === 'attack' || kind === 'heavy') {
        const skill = skillForWeapon(player);
        // Оружие в руке заменяет кулак; пустая рука бьёт как раньше.
        const weapon = weaponDamageOf(player.equipment);
        const outcome = resolveMelee(
          combat,
          kind,
          world.combatantsIn(player.instanceId),
          world.history,
          world.tick,
          player.pendingViewTick ?? world.tick,
          { id: skill, level: player.skills[skill].level },
          weapon > 0 ? weapon : FIST_DAMAGE,
        );
        collectOutcome(world, outcome, outbox);
      }

      if (kind === 'dodge') {
        applyDodgeImpulse(combat);
      }

      if (kind === 'cast' && combat.action.spellId) {
        castSpell(world, player, combat.action.spellId as SpellId, outbox);
      }
    }

    void before;
  }
}

/**
 * Прогоняет накопленный ввод через общий шаг симуляции.
 *
 * Множитель скорости считается общей с клиентом формулой movementSpeedFactor:
 * раньше сервер применял блок, рывок и перегруз, а клиент о них не знал, и
 * предсказание расходилось при каждом поднятом щите.
 */
function applyMovement(world: World, player: Player, dt: number): void {
  const combat = player.combat;
  const baseScale = player.state.speedScale;
  const dashing = combat.action?.kind === 'dodge' && combat.action.phase === 'active';
  // Накат: бросок кончился, а инерция ещё несёт.
  const gliding = combat.action?.kind === 'dodge' && combat.action.phase === 'recovery';

  // За тик прогоняем ограниченное число вводов: остальные подождут следующего.
  // Так пачка, пришедшая после сетевой заминки, не разгоняет игрока рывком
  // и при этом не теряется.
  const batch = player.pendingInputs.splice(0, MAX_INPUTS_PER_TICK);

  for (const input of batch) {
    // Бежать можно только налегке и не в бою: щит, замах и пустая стамина
    // отменяют бег. Те же условия проверяет клиент у себя.
    const sprinting =
      input.sprint &&
      !combat.blocking &&
      !combat.action &&
      combat.vitals.stamina > 0 &&
      (input.forward !== 0 || input.right !== 0);

    const scale = movementSpeedFactor({
      blocking: combat.blocking,
      dashing,
      gliding,
      sprinting,
      acting: Boolean(combat.action) && combat.action?.kind !== 'dodge',
      slowFactor: speedMultiplier(combat),
      weightFactor: weightSpeedFactor(player.attributes, player.carriedWeight),
    });

    const colliders = world.collidersAt(player.instanceId, player.state.pos.x, player.state.pos.z);
    player.state = step({ ...player.state, speedScale: baseScale * scale }, input, colliders);
    player.state.speedScale = baseScale;

    if (sprinting) {
      combat.vitals.stamina = Math.max(0, combat.vitals.stamina - SPRINT_DRAIN * input.dt);
      combat.sinceStaminaUse = 0;
    }

    player.lastProcessedSeq = input.seq;
    player.pitch = input.pitch;
  }

  // Единственное место, где боевая позиция синхронизируется с движением.
  combat.pos = player.state.pos;
  combat.yaw = player.state.yaw;
  player.dirty = true;
}

/**
 * Применение заклинания в момент, когда каст дошёл до конца.
 * Снаряд не бьёт мгновенно: он вылетает телом и летит, поэтому от «Уголька»
 * можно отойти, а «Разряд» наказывает за неподвижность.
 */
function castSpell(world: World, caster: Player, spellId: SpellId, outbox: Outbox): void {
  const spell = SPELLS[spellId];
  // Перезарядка отсчитывается от момента применения, а не от начала чтения.
  caster.spellCooldowns[spellId] = world.elapsed + spell.cooldown;
  const skillLevel = caster.skills[spell.skill].level;

  if (spell.shape === 'projectile') {
    world.projectiles.push(
      createProjectile(world.nextEntityId('x'), caster.combat, spellId, caster.pitch, skillLevel),
    );
    return;
  }

  const outcome =
    spell.shape === 'cone'
      ? resolveCone(caster.combat, spellId, world.combatantsIn(caster.instanceId), skillLevel)
      : resolveSelfSpell(caster.combat, spellId, skillLevel, caster.maxima.health);

  collectOutcome(world, outcome, outbox);
}

// ---------- мобы ----------

function tickMobs(world: World, dt: number, outbox: Outbox): void {
  for (const [instanceId, list] of world.mobs) {
    const players = [...world.players.values()].filter((p) => p.instanceId === instanceId);

    for (const mob of list) {
      // Мёртвые отсчитывают воскрешение всегда: иначе мир бы не восстанавливался,
      // пока игроки в другом конце карты.
      if (!mob.alive) {
        tickRespawn(mob, dt);
        continue;
      }

      // Живые вдали от всех не думают: считать ИИ для пустых чанков незачем.
      if (!world.isMobActive(mob, players)) continue;

      tickCombatant(mob, dt, {
        health: mob.profile.health,
        mana: 0,
        stamina: 100,
      });

      const targets: MobTarget[] = players.map((player) => ({
        id: player.id,
        pos: player.state.pos,
        alive: player.combat.alive,
      }));

      const decision = decideMob(mob, targets, dt);
      world.stepMob(mob, decision.input, dt);

      if (!decision.strike) continue;

      const target = players.find((player) => player.id === mob.targetId);
      if (!target || !target.combat.alive) continue;

      // Моб бьёт по текущей позиции: он не «видит прошлое», отматывать нечего.
      const distance = Math.hypot(
        target.state.pos.x - mob.pos.x,
        target.state.pos.z - mob.pos.z,
      );
      if (distance > mob.profile.attackRange + target.combat.radius) {
        // Игрок успел отойти за время замаха — это и есть награда за реакцию.
        outbox.combat.push({ event: missOf(mob), near: mob.pos, instanceId });
        continue;
      }

      const result = applyDamage(target.combat, mob.profile.damage, {
        blockReduction: 0.75,
        staminaOnBlock: 18,
      });

      outbox.combat.push({
        event: {
          t: 'combat',
          kind: result.dodged ? 'dodged' : result.blocked ? 'blocked' : 'hit',
          attackerId: mob.id,
          attackerName: mob.name,
          targetId: target.id,
          targetName: target.name,
          amount: result.applied,
          backstab: false,
          x: target.state.pos.x,
          y: target.state.pos.y + target.combat.height * 0.7,
          z: target.state.pos.z,
        },
        near: target.state.pos,
        instanceId,
      });

      if (result.blocked) grantExperience(world, target.id, 'block', 4, outbox);
      if (result.dodged) grantExperience(world, target.id, 'evasion', 4, outbox);
      if (result.killed) handlePlayerDeath(world, target, mob.name, outbox);
    }
  }
}

// ---------- снаряды ----------

function tickProjectiles(world: World, dt: number, outbox: Outbox): void {
  for (let i = world.projectiles.length - 1; i >= 0; i--) {
    const projectile = world.projectiles[i]!;
    const colliders = world.collidersAt(projectile.instanceId, projectile.pos.x, projectile.pos.z);
    const hit = stepProjectile(
      projectile,
      dt,
      world.combatantsIn(projectile.instanceId),
      colliders,
    );

    if (hit) {
      outbox.combat.push({
        event: hit.event,
        near: projectile.pos,
        instanceId: projectile.instanceId,
      });

      if (hit.victim) {
        const spell = SPELLS[projectile.spellId];
        grantExperience(world, projectile.ownerId, spell.skill, 3, outbox);

        if (hit.killed) {
          handleDeath(world, hit.victim, projectile.ownerId, projectile.ownerName, outbox);
        }
      }

      world.projectiles.splice(i, 1);
      continue;
    }

    if (projectile.lifetime <= 0) world.projectiles.splice(i, 1);
  }
}

// ---------- смерть ----------

/** Инстанс, в котором произошло событие: берём у любого из участников. */
function instanceOfEvent(world: World, event: CombatEvent): string {
  const attacker = world.playerByCombatantId(event.attackerId);
  if (attacker) return attacker.instanceId;
  const target = world.playerByCombatantId(event.targetId);
  if (target) return target.instanceId;
  return 'overworld';
}

function collectOutcome(world: World, outcome: CombatOutcome, outbox: Outbox): void {
  for (const event of outcome.events) {
    outbox.combat.push({
      event,
      near: { x: event.x, z: event.z },
      instanceId: instanceOfEvent(world, event),
    });
  }
  for (const gain of outcome.experience) {
    grantExperience(world, gain.combatantId, gain.skill, gain.amount, outbox);
  }
  for (const death of outcome.deaths) {
    handleDeath(world, death.victim, death.killer.id, death.killer.name, outbox);
  }
  // Причину говорим один раз за замах, а не по разу на каждую цель в конусе.
  const said = new Set<string>();
  for (const refusal of outcome.refusals) {
    if (said.has(refusal.attackerId)) continue;
    said.add(refusal.attackerId);
    outbox.itemErrors.push({ playerId: refusal.attackerId, message: refusal.reason });
  }
}

function handleDeath(
  world: World,
  victim: Combatant,
  killerId: string,
  killerName: string,
  outbox: Outbox,
): void {
  const player = world.playerByCombatantId(victim.id);
  if (player) {
    handlePlayerDeath(world, player, killerName, outbox);
    return;
  }

  const mob = world.mobByCombatantId(victim.instanceId, victim.id);
  if (!mob) return;

  killMob(mob);
  grantExperience(world, killerId, skillOfKiller(world, killerId), EXPERIENCE_PER_KILL, outbox);

  const killer = world.playerByCombatantId(killerId);
  if (!killer) return;

  // Убитый зверь снимает часть кармы: замаливать делом быстрее, чем ждать.
  forgiveForMob(killer.combat);

  const rolled = rollLoot(mob);
  if (rolled.length === 0) return;

  // Лут кладётся в рюкзак. Что не влезло — остаётся на земле, то есть
  // теряется: это первая ситуация, где игрок платит за набитый рюкзак.
  const taken: { itemId: string; name: string; count: number }[] = [];
  let lost = 0;

  for (const entry of rolled) {
    const result = addItem(killer.inventory, entry.itemId, entry.count);
    killer.inventory = result.grid;

    const got = entry.count - result.leftover;
    if (got > 0) taken.push({ itemId: entry.itemId, name: entry.name, count: got });
    lost += result.leftover;
  }

  refreshLoadout(killer);
  outbox.inventory.push(killer);

  outbox.loot.push({
    playerId: killer.id,
    message: { t: 'loot', from: mob.name, items: taken, lost },
  });
}

/**
 * Смерть в открытом мире вещей не отнимает — по замыслу полная ставка только
 * в подземельях. Здесь наказание — время и путь обратно.
 */
/**
 * Чем платит убийца.
 *
 * Красный при смерти **рискует** надетым и теряет часть наработанного опыта.
 * Именно рискует: наказание должно пугать, а не превращать первую ошибку
 * в конец персонажа. И не даром — иначе краснеть ничего не стоит.
 *
 * Роняется одна вещь из надетого, выбранная случайно: прощаться со шлемом
 * обиднее, чем с любой вещью из рюкзака, и разница между «сходил в набег»
 * и «сходил удачно» становится ощутимой.
 */
export function punishRedDeath(player: Player, outbox: Outbox): void {
  if (flagFor(player.combat) !== 'red') return;

  for (const id of Object.keys(player.skills) as SkillId[]) {
    const progress = player.skills[id];
    progress.experience = Math.max(0, Math.round(progress.experience * (1 - RED_SKILL_PENALTY)));
  }

  if (Math.random() >= RED_DROP_CHANCE) return;

  const worn = (Object.keys(player.equipment) as EquipSlot[]).filter(
    (slot) => player.equipment[slot],
  );
  if (worn.length === 0) return;

  const slot = worn[Math.floor(Math.random() * worn.length)]!;
  const lost = player.equipment[slot];
  const equipment = { ...player.equipment };
  delete equipment[slot];
  player.equipment = equipment;
  refreshLoadout(player);

  outbox.inventory.push(player);
  outbox.itemErrors.push({
    playerId: player.id,
    message: `Ты потерял: ${lost ? itemDef(lost.defId).name : 'снаряжение'}`,
  });
}

function handlePlayerDeath(
  world: World,
  player: Player,
  killerName: string,
  outbox: Outbox,
): void {
  void world;
  player.combat.alive = false;
  player.combat.action = null;
  player.combat.blocking = false;
  player.deadFor = 0;
  player.dirty = true;

  punishRedDeath(player, outbox);

  outbox.life.push({
    playerId: player.id,
    message: { t: 'life', event: 'died', killerName },
  });
  // Смерть — критичное событие: пишем немедленно, а не пакетом.
  outbox.criticalSaves.push(player);
}

/** Можно ли уже воскреснуть. */
export function canRespawn(player: Player): boolean {
  return !player.combat.alive && player.deadFor >= DEATH_DELAY;
}

export function respawnPlayer(world: World, player: Player): LifeMessage {
  player.combat.alive = true;
  player.combat.vitals.health = player.maxima.health;
  player.combat.vitals.stamina = player.maxima.stamina;
  player.combat.vitals.mana = player.maxima.mana;
  player.combat.invulnerable = 2;
  player.combat.wardRemaining = 0;
  player.combat.slowRemaining = 0;
  player.deadFor = 0;
  // Просьбу гасим здесь, в одном месте на оба пути воскрешения: иначе
  // оставшийся флаг поднял бы игрока сразу после следующей смерти.
  player.wantsRespawn = false;

  /**
   * Воскрешение возвращает **и в город, и в мир**.
   *
   * Раньше оно двигало только координаты, а инстанс оставляло прежним. Пока
   * инстанс один, разницы нет; с подземельями это значило бы воскреснуть
   * внутри подземелья на городских координатах — то есть в пустоте, потому
   * что города там нет.
   */
  world.moveToInstance(player, OVERWORLD, SPAWN_POINT);

  return { t: 'life', event: 'respawned', spawn: SPAWN_POINT };
}

// ---------- навыки и лут ----------

function grantExperience(
  world: World,
  combatantId: string,
  skill: SkillId,
  amount: number,
  outbox: Outbox,
): void {
  const player = world.playerByCombatantId(combatantId);
  if (!player) return;

  const result = gainExperience(player.skills[skill], amount);
  player.skills[skill] = result.progress;
  if (result.levelsGained > 0) {
    player.dirty = true;
    outbox.skillUps.push({
      playerId: player.id,
      message: { t: 'skillUp', skill, level: result.progress.level },
    });
  }
}

function skillForWeapon(player: Player): SkillId {
  // Инвентаря ещё нет: класс задаёт, какой навык тренируется кулаками.
  if (player.characterClass === 'mage') return 'evocation';
  if (player.characterClass === 'ranger') return 'archery';
  return 'blade';
}

function skillOfKiller(world: World, killerId: string): SkillId {
  const player = world.playerByCombatantId(killerId);
  return player ? skillForWeapon(player) : 'blade';
}

function rollLoot(mob: Mob): { itemId: ItemId; name: string; count: number }[] {
  const items: { itemId: ItemId; name: string; count: number }[] = [];
  for (const entry of MOBS[mob.mobId].loot) {
    if (Math.random() > entry.chance) continue;
    // Таблицы лута ссылаются на предметы по идентификатору; несуществующие
    // молча пропускаем, иначе опечатка в таблице роняла бы весь бой.
    if (!isItemId(entry.itemId)) continue;

    const count = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
    items.push({ itemId: entry.itemId, name: entry.name, count });
  }
  return items;
}

function missOf(mob: Mob): CombatEvent {
  return {
    t: 'combat',
    kind: 'miss',
    attackerId: mob.id,
    attackerName: mob.name,
    targetId: '',
    targetName: '',
    amount: 0,
    backstab: false,
    x: mob.pos.x,
    y: mob.pos.y,
    z: mob.pos.z,
  };
}

// ---------- история для лагкомпенсации ----------

function recordHistory(world: World): void {
  for (const player of world.players.values()) {
    world.history.record(player.id, world.tick, player.state.pos, player.state.yaw);
  }
  for (const list of world.mobs.values()) {
    for (const mob of list) {
      if (mob.alive) world.history.record(mob.id, world.tick, mob.pos, mob.yaw);
    }
  }
}
