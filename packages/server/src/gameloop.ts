import {
  TORCH_SECONDS,
  RESPAWN_DELAY,
  RESPAWN_STREAK_MAX,
  MAX_INPUTS_PER_TICK,
  BLOCK_DRAIN,
  MOBS,
  SPAWN_POINT,
  SPELLS,
  SPRINT_DRAIN,
  EXHAUSTION_SECONDS,
  addItem,
  createBackpack,
  createSack,
  isDungeon,
  itemDef,
  gainExperience,
  experienceFor,
  movementSpeedFactor,
  isItemId,
  KARMA_DECAY_PER_SECOND,
  RED_DROP_CHANCE,
  RED_SKILL_PENALTY,
  step,
  weaponDamageOf,
  weightSpeedFactor,
  findByDefId,
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
import { forgetMissing } from './commands/hotbar.js';
import { consumeOne } from './commands/items.js';
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
import { alertMob, decideMob, killMob, tickRespawn, type Mob, type MobTarget } from './mob.js';
import { applyDamage } from './combatant.js';
import { createProjectile, spawnArrow, stepProjectile } from './projectile.js';
import { isLit, refreshLoadout, vitalsFor, type Player, type World } from './world.js';

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
  /**
   * Игроки, которым надо переслать состояние открытого хранилища.
   *
   * Мешок может истлеть или опустеть, пока игрок в него смотрит: панель
   * обязана закрыться сама, иначе он будет перекладывать вещи из того,
   * чего уже нет.
   */
  bank: Player[];
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
    bank: [],
    criticalSaves: [],
  };
}

/**
 * Срок лежания. Правило и числа — в общем коде (`shared/combat.ts`): его
 * видит игрок на экране смерти и по нему же ждут сквозные проверки.
 *
 * Счётчик быстрых смертей живёт только в памяти. Это верно по существу:
 * перезаход не должен стирать наказание, но и сервер, переживший перезапуск,
 * начинает с чистого листа вместе со всем миром.
 */
export function deathDelay(world: World, player: Player): number {
  return RESPAWN_DELAY * 2 ** Math.min(world.deathStreak(player.accountId), RESPAWN_STREAK_MAX);
}

export function tickWorld(world: World, dt: number, outbox: Outbox): void {
  world.tick++;
  world.stepNpcs(dt);
  world.tickNodes(dt);
  expireBags(world, outbox, dt);

  tickPlayers(world, dt, outbox);
  tickMobs(world, dt, outbox);
  tickProjectiles(world, dt, outbox);
  recordHistory(world);
}

/**
 * Мешки истлевают, опустевшие убираются.
 *
 * Тот, кто смотрел внутрь, узнаёт об этом сразу: панель закрывается, а не
 * остаётся окном в пустоту.
 */
function expireBags(world: World, outbox: Outbox, dt: number): void {
  const gone = world.tickBags(dt);
  if (gone.length === 0) return;

  for (const player of world.players.values()) {
    const open = player.container;
    if (open?.kind !== 'bag' || !gone.includes(open.bag)) continue;

    player.container = null;
    outbox.bank.push(player);
    outbox.itemErrors.push({ playerId: player.id, message: 'Мешок истлел' });
  }
}

/**
 * Факел прогорает.
 *
 * Кончился — берётся следующий из связки в той же руке, а связка кончилась —
 * рука пустеет. Это и делает темноту вопросом: факел не снаряжение, а запас,
 * и вниз его надо нести.
 */
function burnTorch(player: Player, dt: number, outbox: Outbox): void {
  player.torchLeft -= dt;
  if (player.torchLeft > 0) return;

  const held = player.equipment.offHand;
  const left = (held?.count ?? 1) - 1;
  const equipment = { ...player.equipment };

  if (held && left > 0) {
    equipment.offHand = { ...held, count: left };
    player.torchLeft = TORCH_SECONDS;
  } else {
    delete equipment.offHand;
    player.torchLeft = 0;
  }

  player.equipment = equipment;
  refreshLoadout(player);
  outbox.inventory.push(player);
  outbox.itemErrors.push({
    playerId: player.id,
    message: left > 0 ? 'Факел прогорел, зажжён следующий' : 'Факел прогорел',
  });
}

// ---------- игроки ----------

function tickPlayers(world: World, dt: number, outbox: Outbox): void {
  for (const player of world.players.values()) {
    const combat = player.combat;

    // Карма сходит сама, фиолетовый гаснет по таймеру. И то и другое идёт
    // и у мёртвого: отлежаться от флага нельзя, но и висеть он вечно не должен.
    combat.karma = Math.max(0, combat.karma - KARMA_DECAY_PER_SECOND * dt);
    combat.purpleFor = Math.max(0, combat.purpleFor - dt);

    // Факел прогорает, пока он в руке, — и живой, и мёртвый: огонь не ждёт.
    if (player.torchLeft > 0) burnTorch(player, dt, outbox);

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
            // Сундук вскрыт — перед игроком открывается окно с добычей.
            if (event.type === 'bank') outbox.bank.push(player);
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
      if (player.wantsRespawn && canRespawn(world, player)) {
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

      if ((kind === 'attack' || kind === 'heavy') && shoots(player)) {
        // Лук в руке превращает удар в выстрел: махать луком незачем.
        shootArrow(world, player, outbox);
      } else if (kind === 'attack' || kind === 'heavy') {
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

/** Держит ли игрок лук: по нему удар становится выстрелом. */
function shoots(player: Player): boolean {
  return player.equipment.mainHand?.defId === 'hunting_bow';
}

/**
 * Выстрел из лука.
 *
 * Стрела тратится **в момент выстрела**, а не при попадании: потраченного
 * не вернуть, даже если промазал, — иначе промах ничего не стоит. Кончились
 * стрелы — говорим об этом вслух: молчащий лук читается как поломка.
 */
function shootArrow(world: World, player: Player, outbox: Outbox): void {
  const arrows = findByDefId(player.inventory, 'arrow');
  if (!arrows) {
    outbox.itemErrors.push({ playerId: player.id, message: 'Нет стрел' });
    return;
  }

  consumeOne(player, arrows);
  forgetMissing(player, 'arrow');
  refreshLoadout(player);
  outbox.inventory.push(player);

  const level = player.skills.archery.level;
  world.projectiles.push(
    spawnArrow(
      world.nextEntityId('arrow'),
      player.combat,
      player.pitch,
      weaponDamageOf(player.equipment),
      level,
    ),
  );
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
    // Бежать можно только налегке и не в бою: щит, замах, пустая стамина
    // и усталость отменяют бег. Те же условия проверяет клиент у себя.
    const exhausted = combat.exhaustedFor > 0;
    const sprinting =
      input.sprint &&
      !combat.blocking &&
      !combat.action &&
      !exhausted &&
      combat.vitals.stamina > 0 &&
      (input.forward !== 0 || input.right !== 0);

    const scale = movementSpeedFactor({
      blocking: combat.blocking,
      dashing,
      gliding,
      sprinting,
      acting: Boolean(combat.action) && combat.action?.kind !== 'dodge',
      exhausted,
      slowFactor: speedMultiplier(combat),
      weightFactor: weightSpeedFactor(player.attributes, player.carriedWeight),
    });

    const colliders = world.collidersAt(player.instanceId, player.state.pos.x, player.state.pos.z);
    player.state = step({ ...player.state, speedScale: baseScale * scale }, input, colliders);
    player.state.speedScale = baseScale;

    if (sprinting) {
      combat.vitals.stamina = Math.max(0, combat.vitals.stamina - SPRINT_DRAIN * input.dt);
      combat.sinceStaminaUse = 0;

      // Добежал досуха — выдохся. Три секунды медленного шага: и передышка
      // перед следующим рывком, и цена за то, что бежал без оглядки.
      if (combat.vitals.stamina <= 0) combat.exhaustedFor = EXHAUSTION_SECONDS;
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
        // Огонь в руке выдаёт: такого замечают дальше.
        lit: isLit(player),
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
      // Стрела и заклинание бьют больнее всего по тем, кто не видел стрелка:
      // зверю надо сказать, откуда прилетело.
      reactToHit(world, hit.event);

      if (hit.victim) {
        // Заклинание учит разрушению, стрела — стрельбе.
        const skill = projectile.spellId ? SPELLS[projectile.spellId].skill : 'archery';
        grantExperience(world, projectile.ownerId, skill, 3, outbox);

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
    reactToHit(world, event);
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

/**
 * Зверь узнаёт, что его ударили.
 *
 * Одно место на все виды урона — меч, стрела, заклинание: реакция на боль
 * не должна зависеть от того, чем эту боль причинили. Раньше её не было
 * вовсе, и зверь, подстреленный с сорока метров, продолжал стоять: цели он
 * ищет сам и только в пределах своего зрения.
 *
 * Точку берём у **стрелявшего**, а не у попадания: попадание случилось
 * в самом звере, и бежать «от него» было бы некуда.
 */
function reactToHit(world: World, event: CombatEvent): void {
  if (event.kind !== 'hit' || event.amount <= 0) return;

  const mob = world.mobByCombatantId(instanceOfEvent(world, event), event.targetId);
  if (!mob) return;

  const attacker = world.combatantsIn(mob.instanceId).find((one) => one.id === event.attackerId);
  if (!attacker) return;

  alertMob(mob, event.attackerId, attacker.pos, event.amount);
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
  // Цену победы назначает убитый: крыса учит на пятёрку, огр на сорок три.
  grantExperience(world, killerId, skillOfKiller(world, killerId), experienceFor(mob.profile), outbox);

  const killer = world.playerByCombatantId(killerId);
  if (!killer) return;

  // Убитый зверь снимает часть кармы: замаливать делом быстрее, чем ждать.
  forgiveForMob(killer.combat);

  /**
   * Добыча ложится **мешком на землю**, а не в рюкзак убийцы.
   *
   * Раньше шкуры и кости падали в рюкзак сами, и рюкзак забивался хламом
   * без спроса: набитый — и следующая добыча пропадала молча, «за полный
   * рюкзак». Теперь решает игрок: подошёл, открыл, взял нужное. Тот же
   * порядок, что у казны, и те же правила переноса.
   */
  let sack = createSack();
  for (const entry of rollLoot(mob)) {
    // Что не влезло в мешок — того зверь и не носил: мешок мал намеренно.
    sack = addItem(sack, entry.itemId, entry.count).grid;
  }

  const bag = world.dropBag(mob.instanceId, mob.pos, mob.name, sack);
  if (!bag) return;

  // Убийце говорим, что добыча есть и где она: иначе мешок теряется в траве.
  outbox.loot.push({
    playerId: killer.id,
    message: {
      t: 'loot',
      from: mob.name,
      items: sack.items.map((item) => ({
        itemId: item.defId,
        name: itemDef(item.defId).name,
        count: item.count,
      })),
      lost: 0,
      onGround: true,
    },
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

/**
 * Цена смерти в подземелье.
 *
 * **Надетое пропадает с убитым, рюкзак остаётся лежать.** Это и есть вторая
 * половина вылазки: без неё добыча внизу — бесплатные конфеты, а спуск ничем
 * не отличается от прогулки.
 *
 * Надетое именно пропадает, а не падает в мешок: иначе убийца уходил бы
 * в чужом доспехе, и разница между «набрал добычи» и «убил того, кто набрал»
 * исчезла бы. Добыча переходит, снаряжение — нет.
 *
 * Наверху ничего этого не происходит: там наказание — время и путь обратно.
 */
function spoilBelow(world: World, player: Player, outbox: Outbox): void {
  const worn = Object.keys(player.equipment).length;
  player.equipment = {};

  const bag = world.dropBag(player.instanceId, player.state.pos, player.name, player.inventory);
  if (bag) player.inventory = createBackpack();

  // Панель быстрого доступа не должна показывать то, чего больше нет.
  for (const id of new Set(player.hotbar.filter((entry): entry is ItemId => entry !== null))) {
    forgetMissing(player, id);
  }

  refreshLoadout(player);
  outbox.inventory.push(player);
  outbox.itemErrors.push({
    playerId: player.id,
    message: bag
      ? `Всё, что ты нёс, осталось внизу${worn > 0 ? '; снаряжение пропало' : ''}`
      : 'Снаряжение пропало вместе с тобой',
  });
}

/** Открыт наружу ради проверок: цена смерти внизу — правило, а не деталь. */
export function handlePlayerDeath(
  world: World,
  player: Player,
  killerName: string,
  outbox: Outbox,
): void {
  player.combat.alive = false;
  player.combat.action = null;
  player.combat.blocking = false;
  player.deadFor = 0;
  player.dirty = true;

  // Часто умирающий лежит дольше. Счётчик ведётся здесь, в одном месте на все
  // способы погибнуть: сорвись это в обработчик урона — и смерть от падения
  // или от голода однажды осталась бы бесплатной.
  world.recordDeath(player.accountId);

  // Порядок важен: внизу снаряжение уже пропало, и красному нечего ронять
  // сверх этого. Потеря опыта при этом остаётся — она про убийства, а не
  // про место смерти.
  if (isDungeon(player.instanceId)) spoilBelow(world, player, outbox);
  punishRedDeath(player, outbox);

  outbox.life.push({
    playerId: player.id,
    message: { t: 'life', event: 'died', killerName, respawnIn: deathDelay(world, player) },
  });
  // Смерть — критичное событие: пишем немедленно, а не пакетом.
  outbox.criticalSaves.push(player);
}

/** Можно ли уже воскреснуть. */
export function canRespawn(world: World, player: Player): boolean {
  return !player.combat.alive && player.deadFor >= deathDelay(world, player);
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
  if (result.levelsGained === 0) return;

  /**
   * Уровень вырос — тело окрепло.
   *
   * Пересчитываем здесь же: посчитай пределы только при входе, и полоса
   * вырастет лишь после перезахода, а до того будет врать. Само здоровье
   * не доливаем — прокачка не лечит.
   */
  player.maxima = vitalsFor(player.attributes, player.skills);

  player.dirty = true;
  outbox.skillUps.push({
    playerId: player.id,
    message: { t: 'skillUp', skill, level: result.progress.level },
  });
}

/**
 * Какой навык растёт от удара.
 *
 * Решает **вещь в руке**, а не класс. Пока решал класс, следопыт качал
 * стрельбу кулаками — и продолжал качать её же, потеряв лук: навык рос
 * без лука и без стрел, то есть за то, чего игрок не делал.
 *
 * Класс остаётся запасным ответом для пустых рук: драка без оружия — это
 * всё-таки драка, и чему-то она учить должна.
 */
function skillForWeapon(player: Player): SkillId {
  const held = player.equipment.mainHand?.defId;
  const skill = held ? itemDef(held).skill : undefined;
  if (skill) return skill;

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
