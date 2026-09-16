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
  mobsForDungeon,
  TORCH_SECONDS,
  BAG_SECONDS,
  TOWN_CLEARANCE,
  insideTown,
  DUNGEON_CAPACITY,
  DUNGEON_JOIN_SECONDS,
  DUNGEON_CENTER,
  DUNGEON_ENTRY,
  DUNGEON_FLOORS,
  DUNGEON_BOSS,
  BOSS_FLOOR,
  PORTAL_SECONDS,
  floorCenter,
  floorArrival,
  floorOf,
  playerAabb,
  step,
  NODES,
  findNode,
  type ResourceNode,
  WORLD_CHUNK_RADIUS,
  dungeonSeed,
  routeFor,
  generateDungeonChunk,
  timeOfDay,
  TICK_RATE,
  RESPAWN_FORGIVE,
  isDungeon,
  type Vec3,
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
  type Progress,
  type ProgressMessage,
  emptyProgress,
  experienceForLevel,
  pointCost,
  totalPoints,
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
  createSack,
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
import { flagFor } from './pvp.js';
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

/** Как часто мобу пересчитывают дорогу по комнатам, в секундах. */
const ROUTE_REFRESH = 0.5;

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

/**
 * Работа, которая занимает время и показывается полосой.
 *
 * Добыча с ноды и вскрытие сундука отличаются только тем, что получится
 * в конце: и то и другое — стоять у цели и ждать. Общий тип нужен, чтобы
 * правила «отошёл — бросил» и «смерть прерывает» не пришлось писать дважды
 * и однажды разойтись.
 */
export interface Work {
  kind: 'node' | 'chest';
  /** Имя цели: по нему клиент узнаёт свою полосу. */
  id: string;
  /** Подпись над полосой. */
  name: string;
  /** Где стоит цель и с какого расстояния она поддаётся. */
  at: { x: number; z: number };
  range: number;
  duration: number;
  remaining: number;
  /** Для ноды — она сама: профиль и заряды нужны в конце работы. */
  node?: ResourceNode;
}

/**
 * Мешок павшего.
 *
 * То, что осталось от игрока, убитого в подземелье: его рюкзак целиком, как он
 * был уложен. Лежит на месте смерти и достаётся тому, кто дойдёт.
 *
 * Мешок живёт в памяти инстанса и умирает вместе с ним — как и всё остальное
 * в подземелье. Хранить его в базе нечего: забег кончился, зала больше нет.
 */
export interface Bag {
  id: string;
  instanceId: InstanceId;
  pos: { x: number; y: number; z: number };
  /** Имя павшего: по нему видно, чья это добыча. */
  owner: string;
  grid: Grid;
  /** Сколько секунд ещё лежать. */
  ttl: number;
}

/**
 * Что у игрока открыто: городская казна или чужой мешок.
 *
 * Одно поле, а не два флага. Два флага — это четыре состояния вместо двух,
 * из которых два бессмысленны, и однажды игрок оказался бы одновременно
 * у казны и у мешка, перекладывая вещи неизвестно куда.
 */
export type OpenContainer =
  | { kind: 'vault' }
  | { kind: 'bag'; bag: Bag }
  | { kind: 'chest'; instanceId: InstanceId; chestId: string; at: { x: number; z: number } };

export interface Player {
  id: string;
  /** Идентификатор персонажа в базе — по нему идёт сохранение. */
  characterId: string;
  accountId: string;
  name: string;
  race: Race;
  characterClass: CharacterClass;
  playtimeSeconds: number;
  /**
   * Ведущий мира: ему открыто служебное меню (F2).
   *
   * Признак ставится при входе по имени аккаунта и живёт только в памяти:
   * права выдаёт запуск сервера, а не запись в базе, которую можно завести
   * себе самому через обычную регистрацию.
   */
  admin: boolean;
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
  /**
   * Начатая работа с полосой: добыча ноды или вскрытие сундука.
   *
   * Одно поле на оба случая, потому что это одна механика: стоишь у цели,
   * идёт полоса, отошёл — бросил, и ничего не потратил. Две работы
   * одновременно невозможны по построению.
   *
   * Где стоит цель, лежит рядом с именем: восстанавливать её из имени каждый
   * тик ради проверки расстояния — лишняя работа на ровном месте.
   */
  work: Work | null;
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
  /**
   * Рост самого персонажа: накопленный опыт, нераспределённые очки и то,
   * куда они вложены. Навыки учатся сами, а это — выбор игрока.
   */
  progress: Progress;
  /** Секунд до возможности воскреснуть. */
  deadFor: number;
  /**
   * Сколько ещё горит факел в левой руке.
   *
   * Живёт у игрока, а не у бойца: это не боевое состояние, а вещь, которая
   * тратится. Заводится при надевании, тратится каждый тик, кончился —
   * факел исчезает из руки.
   */
  torchLeft: number;
  /**
   * Сколько ещё нельзя пить расходники, секунды.
   *
   * Один на все зелья и бинты: раздельные откаты обходятся чередованием.
   */
  sipCooldown: number;
  /**
   * Лечение, которое ещё вливается: сколько осталось и за какое время.
   *
   * Зелье поднимает здоровье не разом, а тиками — см. `restoreOver`
   * у предмета. Живёт у игрока, а не у бойца: зелья пьют только игроки.
   */
  healing: { left: number; seconds: number } | null;
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
  /** Что открыто: казна или мешок павшего. Пока открыто, клиент видит сетку. */
  container: OpenContainer | null;
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
  /**
   * Кого этому игроку уже представили.
   *
   * Имя, вид и раса не меняются никогда, но ехали в каждом снапшоте и занимали
   * 45% каждой сущности. Теперь они уходят при первом появлении в поле зрения;
   * набор пересобирается каждый тик из тех, кто в нём виден, поэтому ушедший
   * за радиус и вернувшийся будет представлен заново — иначе клиент, успевший
   * забыть его аватар, получил бы сущность без имени.
   */
  introduced: Set<string>;
  /**
   * Отряд, если игрок в нём состоит.
   *
   * Живёт только в памяти и только на время сессии: внизу флаги не действуют,
   * и группа нужна ровно на один забег. Переживать перезаход ей незачем —
   * зато и разбирать её при выходе не надо.
   */
  partyId: string | null;
  /** От кого лежит непринятое приглашение. */
  partyInviteFrom: string | null;
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
  /**
   * Сдвиг часов мира, поставленный ведущим.
   *
   * Время суток обе стороны считают из номера тика — поле в снапшоте для него
   * не нужно. Сдвиг же вывести неоткуда, поэтому он лежит здесь и уходит
   * отдельным сообщением: и всем играющим сразу, и каждому входящему.
   */
  daytimeShift = 0;

  private readonly terrain = new Map<InstanceId, ChunkedWorld>();
  private nextId = 1;

  /**
   * Частые смерти и когда они были — по **аккаунту**, а не по персонажу.
   *
   * По аккаунту потому, что иначе наказание обходится: вышел, вошёл другим
   * персонажем — и счётчик чист. И живёт оно в мире, а не в игроке: игрок
   * исчезает вместе с соединением, а перезаход не должен стирать долг.
   */
  private readonly deaths = new Map<string, { streak: number; at: number }>();

  /** Сколько быстрых смертей подряд числится за аккаунтом. */
  deathStreak(accountId: string): number {
    return this.deaths.get(accountId)?.streak ?? 0;
  }

  /**
   * Записывает смерть и возвращает новую длину череды.
   *
   * Прожитое без смертей время прощает всё: наказывается упорство, а не
   * невезение.
   */
  recordDeath(accountId: string): number {
    // Заодно выметаем отлежавшихся: без этого карта растёт на каждый аккаунт,
    // который когда-либо умирал на этом сервере.
    for (const [id, seen] of this.deaths) {
      if (this.elapsed - seen.at >= RESPAWN_FORGIVE) this.deaths.delete(id);
    }

    const seen = this.deaths.get(accountId);
    const streak = seen ? seen.streak + 1 : 0;
    this.deaths.set(accountId, { streak, at: this.elapsed });
    return streak;
  }

  /**
   * Переводит стрелки на заданное время суток.
   *
   * Хранится не само время, а сдвиг: часы после перевода продолжают идти,
   * а не застывают на выбранном часе. Иначе ведущий, поставив полночь,
   * остановил бы мир для всех.
   */
  setDaytime(time: number): void {
    /**
     * «Сейчас» берётся **с уже накопленным сдвигом**.
     *
     * Без него второй перевод промахивался ровно на прежний сдвиг: первый
     * раз часы вставали куда просили, а дальше «полдень» давал то утро,
     * то вечер. Ошибка накапливалась и была почти незаметна — стрелки ведь
     * двигались, просто не туда.
     */
    const now = timeOfDay(this.tick, TICK_RATE, this.daytimeShift);
    this.daytimeShift = (((this.daytimeShift + time - now) % 1) + 1) % 1;
  }

  /**
   * Кого перенесли в другой инстанс с прошлой рассылки.
   *
   * Клиенту **обязательно** сказать о переезде: землю под ногами он строит
   * сам, по имени инстанса, и без этого сообщения продолжает строить прежнюю.
   * Именно так и вышло с воскрешением из подземелья: сервер поднимал игрока
   * в городе, а клиент оставался с генератором подземелья — за пределами зала
   * тот отдаёт пустоту, и человек оказывался в городе без пола.
   *
   * Список живёт здесь, а не в командах, потому что переносов уже три —
   * спуск, выход и воскрешение, — и добавится четвёртый. Забыть сообщение
   * в одном из них нельзя: оно уходит оттуда же, откуда происходит перенос.
   */
  private readonly moved = new Set<Player>();

  /** Забирает список переехавших: каждому надо разослать `world`. */
  takeInstanceMoves(): Player[] {
    if (this.moved.size === 0) return [];
    const list = [...this.moved];
    this.moved.clear();
    return list;
  }

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
    skills?: Record<SkillId, SkillProgress>;
    progress?: Progress;
    karma?: number;
    purpleFor?: number;
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
    const skills = character.skills ?? emptySkillBook();
    const progress = character.progress ?? emptyProgress();
    // Тело закаляется прокачкой: чем больше уровней в книге навыков, тем
    // выше пределы. Считаем при входе и потом пересчитываем при каждом росте.
    const maxima = vitalsFor(attributes, progress);

    const player: Player = {
      id,
      characterId: character.id,
      accountId: character.accountId,
      name: character.name,
      race: character.race,
      characterClass: character.characterClass,
      playtimeSeconds: character.playtimeSeconds,
      admin: false,
      lastAccountedAt: Date.now(),
      instanceId: character.instanceId,
      state,
      pendingInputs: [],
      lastProcessedSeq: -1,
      lastIntent: { forward: 0, right: 0, jump: false },
      work: null,
      crafting: null,
      wantsRespawn: false,
      dirty: true,
      attributes,
      maxima,
      skills,
      progress,
      deadFor: 0,
      torchLeft: 0,
      sipCooldown: 0,
      healing: null,
      spellCooldowns: {},
      inventory: character.inventory ?? createBackpack(),
      bank: character.bank ?? createBank(),
      container: null,
      trade: null,
      equipment: character.equipment ?? {},
      knownRecipes: character.knownRecipes ?? [],
      hotbar: character.hotbar ?? defaultHotbar(character.characterClass),
      carriedWeight: 0,
      pitch: 0,
      pendingViewTick: null,
      introduced: new Set(),
      partyId: null,
      partyInviteFrom: null,
      combat: {
        id,
        kind: 'player',
        karma: character.karma ?? 0,
        purpleFor: character.purpleFor ?? 0,
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
        exhaustedFor: 0,
        blockSkill: skills.block.level,
        evasionSkill: skills.evasion.level,
        riposteFor: 0,
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
    const player = this.players.get(id);
    const left = player?.instanceId;
    if (player) {
      this.moved.delete(player);
      // Отряд не переживает разрыв связи: метка на том, кого больше нет,
      // хуже отсутствия метки.
      this.leaveParty(player);
    }
    this.players.delete(id);
    this.history.forget(id);
    if (left) this.closeIfEmpty(left);
  }

  /**
   * Переносит игрока в другой инстанс.
   *
   * Инстанс живёт сразу в трёх местах: у игрока, у его бойца и в истории
   * позиций. Разойдись они — и человек окажется невидимым для одних и
   * уязвимым для других: снапшоты соберутся по одному полю, попадания
   * проверятся по другому.
   *
   * История позиций чистится: отматывать цель в инстанс, из которого она
   * ушла, бессмысленно, а попасть по ней оттуда — уже дыра.
   */
  moveToInstance(player: Player, instanceId: InstanceId, spawn: { x: number; y: number; z: number }): void {
    const left = player.instanceId;
    player.instanceId = instanceId;
    player.combat.instanceId = instanceId;

    player.state.pos = { ...spawn };
    player.state.vel = { x: 0, y: 0, z: 0 };
    player.combat.pos = player.state.pos;

    // Ввод, накопленный в прежнем месте, к новому отношения не имеет.
    player.pendingInputs.length = 0;
    // Хранилище остаётся в том мире, где стоит: открытый сундук или мешок
    // не едет с игроком наверх.
    player.container = null;
    // В новом мире знакомых нет: всех представят заново.
    player.introduced = new Set();
    this.history.forget(player.id);
    player.dirty = true;
    this.moved.add(player);

    this.closeIfEmpty(left);
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
      // Земля выводится из имени инстанса: подземелье — из зерна в нём,
      // всё остальное — обычные дикие земли. Так клиент строит ту же
      // геометрию, зная только, где он.
      terrain = new ChunkedWorld(
        isDungeon(instanceId) ? generateDungeonChunk(dungeonSeed(instanceId)) : undefined,
      );
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
   * Заселяет зал подземелья.
   *
   * Отдельно от диких земель, и не потому, что «так удобнее»: наверху состав
   * зависит от расстояния до города, внизу — от зерна забега. Общий код не
   * должен знать правил одного мира, иначе первый же чужой инстанс получит
   * чужих обитателей — ровно так подземелье однажды получило городскую
   * безопасную зону.
   */
  populateDungeon(instanceId: InstanceId): number {
    this.dungeonsOpenedAt.set(instanceId, Date.now());
    const terrain = this.terrainOf(instanceId);
    const seed = dungeonSeed(instanceId);
    const random = seededRandom(instanceId);
    const list: Mob[] = [];

    // Заселяются **все этажи сразу**, а не по мере прихода. Обитатели должны
    // стоять там, где они стояли до игрока: заселение по приходу означало бы,
    // что спускающийся вторым застаёт другой этаж, чем спустившийся первым.
    for (let floor = 0; floor < DUNGEON_FLOORS; floor++) {
      const center = floorCenter(floor);
      const arrival = floorArrival(floor);
      for (const mobId of mobsForDungeon(seed, floor)) {
        const home = findFreeSpot(terrain, center.x, center.z, random, {
          spread: CHUNK_SIZE - 16,
          away: { x: arrival.x, z: arrival.z, range: 20 },
        });
        if (!home) continue;
        list.push(createMob(`m${this.nextId++}`, mobId, home, instanceId));
      }
    }

    // Хозяин глубины ставится отдельно от раскладки: он один на забег, и от
    // него зависит не картинка, а порталы. Этаж берётся из `BOSS_FLOOR`
    // (сейчас первый), место — подальше от того угла, куда приходят: и от
    // лестницы, и от портала, иначе бой начинался бы с порога.
    const lair = floorCenter(BOSS_FLOOR);
    const arrival = floorArrival(BOSS_FLOOR);
    /*
     * Место боссу ищется так же, как всем, но с двумя оговорками.
     *
     * Первая: не ближе тридцати метров от прихода — на первом этаже в том же
     * углу стоит портал наверх, и босс у порога запирал выход собой.
     * Вторая: **не сдаваться после первой попытки**. Раньше при неудаче он
     * ставился в середину этажа без всякой проверки — то есть мог оказаться
     * в перегородке. Лучше подпустить его ближе ко входу, чем в камень.
     */
    const spot =
      findFreeSpot(terrain, lair.x, lair.z, random, {
        spread: CHUNK_SIZE - 24,
        away: { x: arrival.x, z: arrival.z, range: 30 },
      }) ??
      findFreeSpot(terrain, lair.x, lair.z, random, {
        spread: CHUNK_SIZE - 24,
        away: { x: arrival.x, z: arrival.z, range: 16 },
      }) ??
      findFreeSpot(terrain, lair.x, lair.z, random, { spread: CHUNK_SIZE - 24 }) ??
      // Совсем не повезло со случайными бросками — обходим этаж сеткой.
      // Бросок может не найти места и там, где оно есть; перебор не может.
      scanFreeSpot(terrain, lair.x, lair.z);
    if (!spot) return list.length;
    const boss = createMob(`m${this.nextId++}`, DUNGEON_BOSS, spot, instanceId);
    list.push(boss);
    this.dungeonBosses.set(instanceId, boss.id);
    this.portalsUntil.delete(instanceId);

    this.mobs.set(instanceId, list);
    return list.length;
  }

  // ---------- хозяин глубины и порталы ----------

  /** Кто в этом инстансе босс. Имя моба, а не сам моб: мобов чистят целиком. */
  private readonly dungeonBosses = new Map<InstanceId, string>();
  /** До какой секунды игрового времени порталы открыты. */
  private readonly portalsUntil = new Map<InstanceId, number>();

  /** Этот ли моб — хозяин глубины. Спрашивается в разборе смерти. */
  isDungeonBoss(instanceId: InstanceId, mobId: string): boolean {
    return this.dungeonBosses.get(instanceId) === mobId;
  }

  /**
   * Жив ли хозяин глубины.
   *
   * Пока жив — порталы заперты **всему инстансу**, а не тому, кто с ним дерётся.
   * В этом весь смысл: вылазка кончается общей развязкой, а не двенадцатью
   * личными.
   */
  bossAlive(instanceId: InstanceId): boolean {
    const id = this.dungeonBosses.get(instanceId);
    if (!id) return false;
    return this.mobByCombatantId(instanceId, id)?.alive === true;
  }

  /** Босс пал: порталы открываются на `PORTAL_SECONDS`. */
  openPortals(instanceId: InstanceId): void {
    this.portalsUntil.set(instanceId, this.elapsed + PORTAL_SECONDS);
  }

  /** Сколько секунд порталы ещё открыты. Ноль — заперты. */
  portalsFor(instanceId: InstanceId): number {
    const until = this.portalsUntil.get(instanceId);
    return until === undefined ? 0 : Math.max(0, until - this.elapsed);
  }

  // ---------- отряды ----------

  /**
   * Отряды: имя отряда — набор игроков.
   *
   * Живут только в памяти сервера и только на время сессии. Внизу флаги не
   * действуют, и отряд нужен ровно затем, чтобы отличить своего от чужого
   * в пяти метрах видимости; ничего больше он не даёт — ни общей добычи,
   * ни общего опыта, ни защиты от своего же удара.
   */
  private readonly parties = new Map<string, Set<string>>();
  private nextParty = 1;

  /** Сколько человек в отряде игрока, включая его самого. */
  partySize(player: Player): number {
    if (!player.partyId) return 1;
    return this.parties.get(player.partyId)?.size ?? 1;
  }

  /** Свои ли эти двое. */
  allies(a: Player, b: Player): boolean {
    return a.partyId !== null && a.partyId === b.partyId;
  }

  /** Принимает гостя в отряд зовущего, заводя отряд, если его ещё нет. */
  joinParty(host: Player, guest: Player): void {
    this.leaveParty(guest);
    if (!host.partyId) {
      const id = `p${this.nextParty++}`;
      host.partyId = id;
      this.parties.set(id, new Set([host.id]));
    }
    guest.partyId = host.partyId;
    this.parties.get(host.partyId)!.add(guest.id);
  }

  /**
   * Выводит игрока из отряда.
   *
   * Отряд из одного распускается: метка «свой» на самого себя бессмысленна,
   * а пустые отряды копились бы на каждый распавшийся.
   */
  leaveParty(player: Player): void {
    const id = player.partyId;
    player.partyId = null;
    if (!id) return;
    const members = this.parties.get(id);
    if (!members) return;
    members.delete(player.id);
    if (members.size > 1) return;
    for (const memberId of members) {
      const member = this.players.get(memberId);
      if (member) member.partyId = null;
    }
    this.parties.delete(id);
  }

  /** Кто в отряде игрока, кроме него самого. */
  partyMates(player: Player): Player[] {
    if (!player.partyId) return [];
    const members = this.parties.get(player.partyId);
    if (!members) return [];
    const result: Player[] = [];
    for (const memberId of members) {
      if (memberId === player.id) continue;
      const member = this.players.get(memberId);
      if (member) result.push(member);
    }
    return result;
  }

  /**
   * Ушедший последним гасит свет.
   *
   * Подземелье живёт ровно один забег и умирает, как только из него вышел
   * последний. Проверка стоит **в переезде и в выходе из игры**, а не в команде
   * выхода наверх: из подземелья уходят тремя путями — порталом, смертью
   * и разрывом связи, — и забыть один из них значило бы копить залы молча.
   *
   * Обычный мир не закрывается никогда: он один и общий.
   */
  private closeIfEmpty(instanceId: InstanceId): void {
    if (!isDungeon(instanceId)) return;
    for (const player of this.players.values()) {
      if (player.instanceId === instanceId) return;
    }

    for (const mob of this.mobs.get(instanceId) ?? []) this.mobRoutes.delete(mob.id);
    this.mobs.delete(instanceId);
    this.npcs.delete(instanceId);
    this.terrain.delete(instanceId);
    this.bags.delete(instanceId);
    this.dungeonsOpenedAt.delete(instanceId);
    this.dungeonBosses.delete(instanceId);
    this.portalsUntil.delete(instanceId);

    const prefix = `${instanceId}|`;
    for (const key of this.openedChests) {
      if (key.startsWith(prefix)) this.openedChests.delete(key);
    }
    for (const key of this.chestLoot.keys()) {
      if (key.startsWith(prefix)) this.chestLoot.delete(key);
    }
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

  /**
   * Куда мобу шагать, чтобы дойти до точки: середина ближайшего прохода.
   *
   * Наверху дорога не нужна — там открытые дикие земли, и прямая честна.
   * Внизу этаж нарезан комнатами, и прямая почти всегда упирается
   * в перегородку: моб из соседней комнаты всю погоню тёрся о стену
   * напротив игрока. Связи комнат знает генератор (`routeFor` в общем коде),
   * поэтому спрашиваем **его**, а не ищем путь заново.
   *
   * Дорога пересчитывается не каждый тик: комнаты не меняются, а цель
   * за полсекунды далеко не уходит.
   */
  mobGuide = (mob: Mob, to: Vec3): Vec3 => {
    if (!isDungeon(mob.instanceId)) return to;

    const floor = floorOf(mob.pos.x);
    // Цель на другом этаже — дороги туда нет: лестницами мобы не ходят.
    if (floor !== floorOf(to.x)) return to;

    const cached = this.mobRoutes.get(mob.id);
    const fresh =
      cached !== undefined &&
      this.elapsed - cached.at < ROUTE_REFRESH &&
      Math.hypot(cached.toX - to.x, cached.toZ - to.z) < 3 &&
      Math.hypot(cached.point.x - mob.pos.x, cached.point.z - mob.pos.z) > 1.2;
    if (fresh) return cached.point;

    const route = routeFor(dungeonSeed(mob.instanceId), floor, mob.pos, to);
    // Ближайшую дверь, до которой ещё идти: стоя в самом проходе, моб должен
    // целиться уже в следующий, иначе он топчется в двери.
    const next =
      route.find((point) => Math.hypot(point.x - mob.pos.x, point.z - mob.pos.z) > 1.2) ?? to;
    const point = { x: next.x, y: mob.pos.y, z: next.z };
    this.mobRoutes.set(mob.id, { at: this.elapsed, toX: to.x, toZ: to.z, point });
    return point;
  };

  /** Дорога, посчитанная мобу в прошлый раз: считать её каждый тик незачем. */
  private readonly mobRoutes = new Map<string, { at: number; toX: number; toZ: number; point: Vec3 }>();

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
      exhausted: round(combat.exhaustedFor),
      // Светит либо заклинание, либо факел — клиенту важно только «сколько
      // ещё». Берём больший остаток: гасить свет, пока горит второй источник,
      // было бы враньём.
      light: round(Math.max(combat.lightRemaining, player.torchLeft)),
      sip: round(player.sipCooldown),
      flag: flagFor(combat),
      karma: Math.round(combat.karma),
      // Подземельное едет только под землёй: наверху этих полей нет вовсе,
      // и клиент по их отсутствию понимает, что показывать нечего.
      ...(isDungeon(player.instanceId)
        ? {
            floor: floorOf(player.state.pos.x),
            bossAlive: this.bossAlive(player.instanceId),
            portalsFor: Math.round(this.portalsFor(player.instanceId)),
          }
        : {}),
      ...(player.partyId ? { party: this.partySize(player) } : {}),
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
    // Кто попал в снапшот этого тика: из них соберётся новая память о знакомых.
    const seen = new Set<string>();

    /** Опознание — только при первом появлении. Дальше сущность знают по id. */
    const introduce = (id: string, card: Partial<EntitySnapshot>): Partial<EntitySnapshot> => {
      seen.add(id);
      return viewer.introduced.has(id) ? {} : card;
    };

    for (const player of this.players.values()) {
      if (player.instanceId !== viewer.instanceId) continue;
      if (player.id !== viewer.id && !withinAoi(origin, player.state.pos)) continue;
      entities.push({
        id: player.id,
        ...introduce(player.id, { name: player.name, kind: 'player', race: player.race }),
        x: round(player.state.pos.x),
        y: round(player.state.pos.y),
        z: round(player.state.pos.z),
        yaw: round(player.state.yaw),
        hp: fraction(player.combat.vitals.health, player.maxima.health),
        alive: player.combat.alive,
        action: player.combat.action?.kind,
        phase: player.combat.action?.phase,
        flag: flagFor(player.combat),
        // Огонь в чужой руке виден всем — в этом вся цена факела.
        ...(isLit(player) ? { lit: true } : {}),
        // «Свой» считается для каждого получателя: это отношение, а не
        // свойство. И не едет в карточке опознания — отряд меняется, имя нет.
        ...(player.id !== viewer.id && this.allies(viewer, player) ? { ally: true } : {}),
        // Чужая работа слышна: сундук вскрывают «уязвимо и слышно», и без этого
        // поля сосед узнать о полосе не может — она уходит только работнику.
        ...(player.work ? { work: player.work.kind } : {}),
      });
    }

    for (const npc of this.npcs.get(viewer.instanceId) ?? []) {
      if (!withinAoi(origin, npc.state.pos)) continue;
      entities.push({
        id: npc.id,
        ...introduce(npc.id, { name: npc.name, kind: 'npc', race: npc.race }),
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
        ...introduce(mob.id, {
          name: mob.name,
          kind: 'mob',
          race: 'human',
          mobId: mob.mobId,
        }),
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

    viewer.introduced = seen;
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
        // Пусто у стрелы: клиент рисует её иначе, чем сгусток заклинания.
        ...(projectile.spellId ? { spellId: projectile.spellId } : {}),
        x: round(projectile.pos.x),
        y: round(projectile.pos.y),
        z: round(projectile.pos.z),
      });
    }
    return result;
  }

  // ---------- ресурсные ноды ----------

  /** Когда заведён каждый зал: по этому решается, принимает ли он ещё. */
  private readonly dungeonsOpenedAt = new Map<InstanceId, number>();

  /**
   * Зал, в который ещё можно подсесть.
   *
   * Лобби пока нет, и окно по времени его заменяет: спустившиеся в одну минуту
   * попадают вместе. Выбирается самый свежий из подходящих — так компания
   * собирается вокруг последнего спустившегося, а не растекается по залам.
   */
  joinableDungeon(): InstanceId | null {
    const now = Date.now();
    const crowd = new Map<InstanceId, number>();
    for (const player of this.players.values()) {
      if (!isDungeon(player.instanceId)) continue;
      crowd.set(player.instanceId, (crowd.get(player.instanceId) ?? 0) + 1);
    }

    let best: InstanceId | null = null;
    let freshest = 0;

    for (const [instanceId, since] of this.dungeonsOpenedAt) {
      if ((crowd.get(instanceId) ?? 0) >= DUNGEON_CAPACITY) continue;
      if (now - since > DUNGEON_JOIN_SECONDS * 1000) continue;
      if (since < freshest) continue;
      best = instanceId;
      freshest = since;
    }

    return best;
  }

  /** Мешки павших по инстансам. */
  private readonly bags = new Map<InstanceId, Bag[]>();

  /** Кладёт мешок на пол. Пустой не роняем: обыскивать в нём нечего. */
  dropBag(instanceId: InstanceId, pos: { x: number; y: number; z: number }, owner: string, grid: Grid): Bag | null {
    if (grid.items.length === 0) return null;

    const bag: Bag = {
      id: this.nextEntityId('bag'),
      instanceId,
      pos: { ...pos },
      owner,
      grid,
      ttl: BAG_SECONDS,
    };
    const list = this.bags.get(instanceId) ?? [];
    list.push(bag);
    this.bags.set(instanceId, list);
    return bag;
  }

  bagById(instanceId: InstanceId, id: string): Bag | null {
    return (this.bags.get(instanceId) ?? []).find((bag) => bag.id === id) ?? null;
  }

  /**
   * Отсчёт времени жизни мешков.
   *
   * Опустевший убирается: мешок, из которого вынесли всё, — это мусор на полу,
   * который выглядит как добыча.
   *
   * Но **не пока в него смотрят**. Иначе разбор мешка выходил односторонним:
   * вынул последнюю вещь — мешок исчез вместе с окном, и передумать уже
   * нельзя. А разбирают именно так: достал посмотреть, прикинул вес, положил
   * обратно. Пустой мешок под открытой панелью живёт до тех пор, пока её
   * не закроют, — и уходит на следующем же тике после этого.
   *
   * Истёкшее время жизни важнее: истлевший мешок исчезает и из-под руки —
   * иначе его можно держать вечно, не закрывая окна.
   */
  tickBags(dt: number): Bag[] {
    const gone: Bag[] = [];
    const watched = this.watchedBags();

    for (const [instanceId, list] of this.bags) {
      for (let i = list.length - 1; i >= 0; i--) {
        const bag = list[i]!;
        bag.ttl -= dt;
        if (bag.ttl > 0 && (bag.grid.items.length > 0 || watched.has(bag))) continue;

        list.splice(i, 1);
        gone.push(bag);
      }
      if (list.length === 0) this.bags.delete(instanceId);
    }

    return gone;
  }

  /** Мешки, в которые прямо сейчас кто-то смотрит. */
  private watchedBags(): Set<Bag> {
    const open = new Set<Bag>();
    for (const player of this.players.values()) {
      if (player.container?.kind === 'bag') open.add(player.container.bag);
    }
    return open;
  }

  /** Мешки в поле зрения: клиент рисует по ним метки на полу. */
  bagsFor(viewer: Player): { id: string; x: number; y: number; z: number }[] {
    const origin = viewer.state.pos;
    const result: { id: string; x: number; y: number; z: number }[] = [];

    for (const bag of this.bags.get(viewer.instanceId) ?? []) {
      if (!withinAoi(origin, bag.pos)) continue;
      result.push({ id: bag.id, x: round(bag.pos.x), y: round(bag.pos.y), z: round(bag.pos.z) });
    }
    return result;
  }

  /**
   * Вскрытые сундуки подземелий.
   *
   * Хранятся исключения, как и у нод: нетронутый сундук выводится из зерна
   * инстанса и не занимает ничего. Инстанс умирает вместе с забегом, поэтому
   * и запись живёт ровно столько же.
   */
  private readonly openedChests = new Set<string>();

  /**
   * Что лежит во вскрытых сундуках.
   *
   * Сундук — это **хранилище, а не выдача**: вскрыл, посмотрел, взял нужное,
   * остальное оставил. Значит его содержимое обязано где-то жить между двумя
   * открытиями. Живёт оно в инстансе и умирает вместе с ним: забег кончился —
   * зала больше нет.
   */
  private readonly chestLoot = new Map<string, Grid>();

  isChestOpen(instanceId: InstanceId, chestId: string): boolean {
    return this.openedChests.has(`${instanceId}|${chestId}`);
  }

  markChestOpen(instanceId: InstanceId, chestId: string, loot: Grid): void {
    this.openedChests.add(`${instanceId}|${chestId}`);
    this.chestLoot.set(`${instanceId}|${chestId}`, loot);
  }

  /** Содержимое вскрытого сундука. Пустая сетка — если его уже обобрали. */
  chestGrid(instanceId: InstanceId, chestId: string): Grid {
    return this.chestLoot.get(`${instanceId}|${chestId}`) ?? createSack();
  }

  setChestGrid(instanceId: InstanceId, chestId: string, grid: Grid): void {
    this.chestLoot.set(`${instanceId}|${chestId}`, grid);
  }

  /** Вскрытые сундуки этого инстанса: клиенту, чтобы нарисовать их пустыми. */
  openedChestsIn(instanceId: InstanceId): string[] {
    const prefix = `${instanceId}|`;
    const result: string[] = [];
    for (const key of this.openedChests) {
      if (key.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  }

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
/**
 * Пределы здоровья, маны и стамины по атрибутам и прокачке.
 *
 * Одно место на вход в игру и на рост уровня: посчитай их по-разному —
 * и полоса здоровья вырастет только после перезахода, а до того будет врать.
 */
export function vitalsFor(
  attributes: Attributes,
  progress: Progress,
): { health: number; mana: number; stamina: number } {
  return {
    health: maxHealth(attributes, progress.spent),
    mana: maxMana(attributes, progress.spent),
    stamina: maxStamina(attributes, progress.spent),
  };
}

/**
 * Прокачка целиком: навыки и рост персонажа.
 *
 * Считается по месту отправки, а не хранится: числа лежат у игрока, и держать
 * их вторую копию значит однажды показать устаревшую.
 */
export function progressMessage(player: Player): ProgressMessage {
  return {
    t: 'progress',
    skills: (Object.keys(SKILLS) as SkillId[]).map((skill) => ({
      skill,
      level: player.skills[skill].level,
      experience: Math.round(player.skills[skill].experience),
      next: experienceForLevel(player.skills[skill].level),
    })),
    pool: Math.round(player.progress.pool),
    toPoint: pointCost(totalPoints(player.progress)),
    points: player.progress.points,
    spent: { ...player.progress.spent },
  };
}

export function refreshLoadout(player: Player): void {
  player.combat.armor = equipmentArmor(player.equipment);
  player.carriedWeight = totalWeight(player.inventory) + equipmentWeight(player.equipment);

  /**
   * Факел зажигается и гаснет вместе с надеванием.
   *
   * Здесь, а не в команде надевания: рука пустеет и сама по себе — факел
   * прогорает, его отнимает смерть красного, он пропадает вместе со всем
   * снаряжением внизу. Пока это стояло в `handleEquip`, свет оставался гореть
   * у пустой руки.
   *
   * Остаток не сбрасывается, если факел тот же: снял посмотреть рюкзак
   * и надел обратно — он не должен становиться новым.
   */
  const torch = player.equipment.offHand?.defId === 'torch';
  if (torch && player.torchLeft <= 0) player.torchLeft = TORCH_SECONDS;
  if (!torch) player.torchLeft = 0;

  player.dirty = true;
}

/** Несёт ли игрок огонь. Одно место на всех: и снапшот, и зверьё смотрят сюда. */
export function isLit(player: Player): boolean {
  return player.torchLeft > 0 || player.combat.lightRemaining > 0;
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

/**
 * Перебор по сетке: последнее средство, когда случайные броски не нашли места.
 *
 * Медленнее броска, зато честно отвечает «места нет» только тогда, когда его
 * действительно нет. Зовётся раз на забег — для босса, которому место
 * обязано найтись: без него порталы не отпереть ничем.
 */
function scanFreeSpot(
  terrain: ChunkedWorld,
  originX: number,
  originZ: number,
): { x: number; y: number; z: number } | null {
  const half = (CHUNK_SIZE - 24) / 2;
  for (let dz = -half; dz <= half; dz += 2) {
    for (let dx = -half; dx <= half; dx += 2) {
      const candidate = { x: originX + dx, y: 0.1, z: originZ + dz };
      const body = playerAabb(candidate, { radius: 0.9, height: 2.9 });
      const blocked = terrain
        .collidersAt(candidate.x, candidate.z)
        .some((box) => box.maxY > 0.05 && aabbOverlap(body, box));
      if (!blocked) return candidate;
    }
  }
  return null;
}

/**
 * Ищет свободное место под спавн: моб внутри валуна застрянет навсегда.
 *
 * `away` держит место подальше от точки: в подземелье это вход, и нужен он
 * не для удобства — моб, стоящий вплотную к точке появления, бьёт раньше,
 * чем у игрока успевает собраться картинка.
 */
function findFreeSpot(
  terrain: ChunkedWorld,
  originX: number,
  originZ: number,
  random: () => number,
  options: { spread?: number; away?: { x: number; z: number; range: number } } = {},
): { x: number; y: number; z: number } | null {
  const spread = options.spread ?? CHUNK_SIZE - 12;

  for (let attempt = 0; attempt < 24; attempt++) {
    const x = originX + (random() - 0.5) * spread;
    const z = originZ + (random() - 0.5) * spread;
    if (options.away && Math.hypot(x - options.away.x, z - options.away.z) < options.away.range) {
      continue;
    }
    // Город вышел за свой чанк, а зверьё селится вокруг середины соседних:
    // без этой проверки волк рождался бы посреди улицы.
    if (insideTown(x, z, TOWN_CLEARANCE)) continue;
    const candidate = { x, y: 0.1, z };
    const body = playerAabb(candidate, { radius: 0.9, height: 2.9 });

    const blocked = terrain
      .collidersAt(x, z)
      .some((box) => box.maxY > 0.05 && aabbOverlap(body, box));

    if (!blocked) return candidate;
  }
  return null;
}
