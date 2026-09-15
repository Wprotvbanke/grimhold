import {
  CORPSE_SECONDS,
  LIT_AGGRO,
  MOBS,
  WALK_SPEED,
  attributesFor,
  createMoveState,
  fullVitals,
  type MobId,
  type MobProfile,
  type MoveInput,
  type MoveState,
  type Vec3,
} from '@grimhold/shared';
import type { Combatant } from './combatant.js';

/**
 * Мобы.
 *
 * Конечный автомат: дремлет → заметил → преследует → бьёт → возвращается.
 * Двигается через тот же step(), что и игроки, поэтому коллизии, скорость
 * и работа с чанками у него уже правильные.
 *
 * Навмеша нет. Наверху, в открытых диких землях, моб идёт к цели напрямую;
 * под землёй дорогу по проходам подсказывает `guide` — комнаты и двери знает
 * генератор этажа, а не тот, кто идёт. И там и там остаётся обход по факту:
 * упёрся — пробует в сторону (см. `trackStuck`). Стен моб не «видит»:
 * он узнаёт о них тем же способом, что живой, — попыткой пройти.
 */

export type MobPhase = 'idle' | 'chase' | 'attack' | 'return' | 'flee' | 'dead';

export interface Mob extends Combatant {
  mobId: MobId;
  profile: MobProfile;
  state: MoveState;
  phase: MobPhase;
  /** Точка спавна: от неё отсчитывается желание вернуться. */
  home: Vec3;
  targetId: string | null;
  /** Где моб был в прошлом шаге — по этому меряется пройденный путь. */
  lastPos: Vec3;
  /** Сколько метров погони накопилось с прошлого броска кости. */
  chaseMetres: number;
  /** Секунд, пока моб ни на кого не бросается: только что отстал. */
  giveUpFor: number;
  /**
   * Откуда прилетело. По этой точке моб решает, куда бежать: от неё или к ней.
   *
   * Хранится точка, а не боец: стрелявший успеет уйти, пока моб бежит, —
   * а бежать он должен **от места выстрела**, как человек, который спрятался
   * от того, что видел.
   */
  hurtFrom: Vec3 | null;
  /** Секунд, пока моб удирает и не смотрит ни на кого. */
  fleeFor: number;
  /**
   * Секунд ярости: моб идёт на обидчика, не считаясь ни с дальностью зрения,
   * ни с бросками кости на отставание. Без этого стрелка с сорока метров
   * никто никогда не догонит — он просто вне поля зрения.
   */
  rageFor: number;
  /** Секунд до следующего удара. */
  attackCooldown: number;
  /** Секунд до конца замаха, если он замахнулся. */
  windupRemaining: number;
  /** Секунд до воскрешения после смерти. */
  respawnIn: number;
  /**
   * Сколько секунд моб упирается: идёт, а с места почти не двигается.
   *
   * Из этого рождается обход. Стены моб не «видит» — он узнаёт о них тем же
   * способом, что и живой: попробовал пройти и не смог.
   */
  stuckFor: number;
  /** Куда обходить: −1 влево, 1 вправо, 0 — прямо. */
  sidestep: -1 | 0 | 1;
  /** Сколько секунд ещё идти боком. */
  sidestepFor: number;
}

const RESPAWN_SECONDS = 45;
/**
 * Насколько дольше aggroRange моб держится за цель, прежде чем бросить.
 *
 * Запас щедрый: основной способ отстать теперь не этот порог, а бросок кости
 * на каждом метре погони (см. ниже). Порог остался как «дальше он тебя просто
 * не видит», а не как поводок.
 */
const CHASE_TOLERANCE = 2.2;

/**
 * Базовый шанс отстать за метр погони — на самой границе привязки и при
 * нулевом упорстве. Всё остальное множители: упорство моба и то, насколько
 * далеко он забрёл от дома.
 */
const GIVE_UP_PER_METRE = 0.35;

/** Дальше этого от дома моб разворачивается без всяких бросков кости. */
const HARD_LEASH_SCALE = 3;

/** Сколько секунд отставший моб ни на кого не смотрит. */
const GIVE_UP_SECONDS = 6;

/**
 * Обход препятствий: моб узнаёт о стене тем, что упёрся в неё.
 *
 * Пути он не ищет — вокруг открытые дикие земли, а в подземелье дорогу
 * по проходам подсказывает `guide` (см. `decideMob`). Но и подсказанная
 * дорога упирается в угол перегородки или в валун, и тогда единственное
 * честное поведение — попробовать в сторону, а не тереться о камень
 * бесконечно. Так вёл себя и живой: не пролез — обошёл.
 */
/** Доля ожидаемого шага, ниже которой моб считается упёршимся. */
const STUCK_SHARE = 0.35;
/** Сколько секунд упора нужно, чтобы начать обход. */
const STUCK_SECONDS = 0.4;
/** Сколько секунд моб идёт боком, обходя. */
const SIDESTEP_SECONDS = 1.1;
/** Насколько при обходе он ещё идёт вперёд: боком, но с напором. */
const SIDESTEP_FORWARD = 0.35;

/**
 * Шанс бросить погоню на очередном метре.
 *
 * Растёт квадратом расстояния от дома: у самого логова моб держится намертво,
 * за границей привязки сдаётся быстро. Упорство гасит этот шанс целиком —
 * у нежити он в десять раз ниже, чем у крысы.
 */
function giveUpChance(mob: Mob, distanceHome: number): number {
  const beyond = distanceHome / mob.profile.leash;
  return GIVE_UP_PER_METRE * (1 - mob.profile.aggression) * beyond * beyond;
}

/** Моб потерял интерес: цель забыта, домой, и какое-то время ни на кого. */
function giveUp(mob: Mob): void {
  mob.targetId = null;
  mob.chaseMetres = 0;
  mob.giveUpFor = GIVE_UP_SECONDS;
  mob.rageFor = 0;
  mob.phase = 'return';
}

/**
 * Какая доля здоровья должна уйти за один удар, чтобы зверь бросился бежать.
 *
 * Считается **долей, а не числом урона**: крыса от той же стрелы теряет
 * половину жизни, а умертвие — десятую часть, и бояться им положено по-разному.
 * Так «слабый убегает, сильный идёт на тебя» получается само, без деления
 * мобов на трусов и храбрецов.
 */
const PANIC_SHARE = 0.3;
/** Сколько секунд зверь удирает после тяжёлого попадания. */
const FLEE_SECONDS = 4;
/** Сколько секунд он идёт на обидчика после лёгкого. */
const RAGE_SECONDS = 12;

/**
 * Зверя ударили — он обязан отреагировать.
 *
 * До этого стрела с дальней дистанции не значила для него ничего: цели он
 * ищет сам и только в пределах своего зрения, поэтому стоял столбом, пока его
 * расстреливают. Теперь удар всегда что-то меняет, и что именно — решает
 * **тяжесть попадания**:
 *
 * - тяжёлое (`PANIC_SHARE` и больше от полного здоровья) — бежать прочь
 *   от места выстрела: зверю больно, и он не разбирается, кто там стрелял;
 * - лёгкое — идти на обидчика, не считаясь ни с дальностью зрения, ни
 *   с усталостью погони.
 *
 * Знание о стрелявшем не даётся даром: моб бежит **к точке выстрела**,
 * а не к самому стрелку, — то есть промахнуться мимо него он ещё может.
 */
export function alertMob(mob: Mob, attackerId: string, from: Vec3, damage: number): void {
  if (!mob.alive) return;

  mob.hurtFrom = { ...from };
  mob.giveUpFor = 0;

  const share = damage / Math.max(1, mob.profile.health);
  if (share >= PANIC_SHARE) {
    mob.targetId = null;
    mob.fleeFor = FLEE_SECONDS;
    mob.chaseMetres = 0;
    mob.rageFor = 0;
    mob.phase = 'flee';
    return;
  }

  mob.targetId = attackerId;
  mob.fleeFor = 0;
  mob.rageFor = RAGE_SECONDS;
  mob.phase = 'chase';
}

export function createMob(id: string, mobId: MobId, home: Vec3, instanceId: string): Mob {
  const profile = MOBS[mobId];
  // Атрибуты мобу нужны только ради общих формул регенерации.
  const attributes = attributesFor('human', 'warrior');
  const vitals = fullVitals(attributes);
  vitals.health = profile.health;

  return {
    id,
    kind: 'mob',
    karma: 0,
    purpleFor: 0,
    name: profile.name,
    instanceId,
    mobId,
    profile,
    pos: { ...home },
    yaw: 0,
    radius: profile.radius,
    height: profile.height,
    vitals,
    attributes,
    armor: profile.armor,
    alive: true,
    action: null,
    blocking: false,
    invulnerable: 0,
    sinceStaminaUse: 0,
    exhaustedFor: 0,
    // Щитов у зверья нет, рывков они не делают.
    blockSkill: 0,
    evasionSkill: 0,
    riposteFor: 0,
    wardArmor: 0,
    wardRemaining: 0,
    slowFactor: 1,
    slowRemaining: 0,
    lightRemaining: 0,
    dodgeCooldown: 0,
    swingCooldown: 0,
    state: createMoveState(home, {
      body: { radius: profile.radius, height: profile.height },
      speedScale: profile.speedScale,
    }),
    phase: 'idle',
    home: { ...home },
    targetId: null,
    lastPos: { ...home },
    chaseMetres: 0,
    giveUpFor: 0,
    hurtFrom: null,
    fleeFor: 0,
    rageFor: 0,
    attackCooldown: 0,
    windupRemaining: 0,
    respawnIn: 0,
    stuckFor: 0,
    sidestep: 0,
    sidestepFor: 0,
  };
}

export interface MobTarget {
  id: string;
  pos: Vec3;
  alive: boolean;
  /** Несёт огонь: такого замечают дальше — см. `LIT_AGGRO`. */
  lit?: boolean;
}

export interface MobDecision {
  /** Намерение движения — уходит в общий step(). */
  input: MoveInput;
  /** Моб завершил замах и бьёт: сервер должен проверить попадание. */
  strike: boolean;
}

/**
 * Один шаг мышления моба. Чистая логика: ничего не мутирует, кроме самого моба,
 * и не знает ни о сети, ни о базе.
 */
export function decideMob(
  mob: Mob,
  candidates: MobTarget[],
  dt: number,
  /**
   * Куда идти, чтобы попасть в точку: в подземелье это середина ближайшего
   * прохода, наверху — сама точка. Подземелье о себе знает само (`routeFor`
   * в общем коде), а моб — нет, и знать не должен.
   */
  guide?: (mob: Mob, to: Vec3) => Vec3,
): MobDecision {
  const toward = (destination: Vec3): Vec3 => guide?.(mob, destination) ?? destination;
  const idle: MoveInput = {
    seq: 0,
    forward: 0,
    right: 0,
    yaw: mob.yaw,
    pitch: 0,
    jump: false,
    sprint: false,
    dt,
  };

  mob.attackCooldown = Math.max(0, mob.attackCooldown - dt);
  mob.giveUpFor = Math.max(0, mob.giveUpFor - dt);
  mob.fleeFor = Math.max(0, mob.fleeFor - dt);
  mob.rageFor = Math.max(0, mob.rageFor - dt);

  // Путь меряем по факту, а не по скорости из профиля: моб упирается в камни
  // и заборы, и «пройденный метр» должен быть настоящим — иначе застрявший
  // у стены моб отстал бы от игрока, стоя на месте.
  const moved = horizontalDistance(mob.pos, mob.lastPos);
  mob.chaseMetres += moved;
  mob.lastPos = { ...mob.pos };
  trackStuck(mob, moved, dt);

  if (!mob.alive) {
    mob.phase = 'dead';
    return { input: idle, strike: false };
  }

  // Замах уже идёт — доводим его до удара, что бы ни случилось.
  if (mob.windupRemaining > 0) {
    mob.windupRemaining -= dt;
    if (mob.windupRemaining <= 0) {
      mob.windupRemaining = 0;
      mob.attackCooldown = mob.profile.attackCooldown;
      return { input: { ...idle, yaw: mob.yaw }, strike: true };
    }
    return { input: { ...idle, yaw: mob.yaw }, strike: false };
  }

  /**
   * Удирает.
   *
   * Перебивает всё, кроме начатого замаха: раненому зверю не до выбора целей.
   * Бежит он **от места выстрела** — не от стрелка, которого мог и не видеть.
   * Дом при этом не тянет назад: спасаться домой через того, кто в тебя
   * стреляет, — бессмыслица.
   */
  if (mob.fleeFor > 0 && mob.hurtFrom) {
    mob.phase = 'flee';
    const away = {
      x: mob.pos.x * 2 - mob.hurtFrom.x,
      y: mob.pos.y,
      z: mob.pos.z * 2 - mob.hurtFrom.z,
    };
    return { input: moveToward(mob, away, dt), strike: false };
  }

  const target = mob.targetId
    ? candidates.find((c) => c.id === mob.targetId && c.alive)
    : undefined;

  const distanceHome = horizontalDistance(mob.pos, mob.home);

  // Совсем уж далеко — разворот без разговоров: иначе один невезучий бросок
  // кости мог бы утащить моба через полкарты.
  if (distanceHome > mob.profile.leash * HARD_LEASH_SCALE) {
    giveUp(mob);
    return { input: moveToward(mob, mob.home, dt), strike: false };
  }

  if (target) {
    const distance = horizontalDistance(mob.pos, target.pos);

    // Цель убежала слишком далеко — теряем интерес. Но не в ярости: обидчика
    // с сорока метров иначе не догнать, он просто вне поля зрения.
    if (mob.rageFor <= 0 && distance > mob.profile.aggroRange * CHASE_TOLERANCE) {
      giveUp(mob);
      return { input: moveToward(mob, mob.home, dt), strike: false };
    }

    /**
     * Бросок кости на каждый пройденный метр.
     *
     * Жёсткого поводка нет намеренно: на его границе моб дёргался — шаг за
     * черту разворачивал его домой, шаг обратно возвращал погоню, и так
     * каждый кадр. Здесь же убегание от моба — это растянутая во времени
     * проверка удачи: чем дальше он от дома, тем вероятнее отстанет.
     */
    while (mob.chaseMetres >= 1) {
      mob.chaseMetres -= 1;
      // В ярости кость не бросают: пока она не остынет, зверь идёт до конца.
      if (mob.rageFor <= 0 && Math.random() < giveUpChance(mob, distanceHome)) {
        giveUp(mob);
        return { input: moveToward(mob, mob.home, dt), strike: false };
      }
    }

    mob.yaw = yawToward(mob.pos, target.pos);

    if (distance <= mob.profile.attackRange) {
      mob.phase = 'attack';
      // Замах виден игроку — за это время можно отойти или поставить блок.
      if (mob.attackCooldown <= 0) mob.windupRemaining = mob.profile.windup;
      return { input: { ...idle, yaw: mob.yaw }, strike: false };
    }

    mob.phase = 'chase';
    return { input: moveToward(mob, toward(target.pos), dt), strike: false };
  }

  /**
   * Обидчик потерялся, а злость осталась — идём к месту, откуда прилетело.
   *
   * Так стрелок из-за угла не становится невидимкой: зверь придёт туда, где
   * его видели в последний раз, и уже там осмотрится. Промахнуться мимо
   * стрелка он при этом может — и это честно.
   */
  if (!target && mob.rageFor > 0 && mob.hurtFrom) {
    mob.phase = 'chase';
    if (horizontalDistance(mob.pos, mob.hurtFrom) > 1.5) {
      return { input: moveToward(mob, toward(mob.hurtFrom), dt), strike: false };
    }
    mob.rageFor = 0;
  }

  // Погоня кончилась — счётчик метров ни к чему.
  mob.chaseMetres = 0;

  // Только что отстал: бредёт домой и никого не замечает. Без этой паузы он
  // тут же цеплялся бы за ту же цель и весь бросок кости был бы впустую.
  if (mob.giveUpFor > 0) {
    if (distanceHome > 1.5) {
      mob.phase = 'return';
      return { input: moveToward(mob, mob.home, dt), strike: false };
    }
    mob.phase = 'idle';
    return { input: idle, strike: false };
  }

  /**
   * Цели нет — ищем ближайшую в радиусе обнаружения.
   *
   * Радиус свой у каждой цели, а не общий: несущего огонь видно дальше.
   * Поэтому сравнивается не расстояние с расстоянием, а **запас** до своего
   * предела: иначе факелоносец в пятнадцати метрах проигрывал бы тёмному
   * в четырнадцати, хотя заметен куда сильнее.
   */
  let nearest: MobTarget | null = null;
  let bestSlack = 0;
  for (const candidate of candidates) {
    if (!candidate.alive) continue;
    const range = mob.profile.aggroRange * (candidate.lit ? LIT_AGGRO : 1);
    const slack = range - horizontalDistance(mob.pos, candidate.pos);
    if (slack > bestSlack) {
      nearest = candidate;
      bestSlack = slack;
    }
  }

  if (nearest) {
    mob.targetId = nearest.id;
    mob.phase = 'chase';
    return { input: moveToward(mob, toward(nearest.pos), dt), strike: false };
  }

  // Никого рядом: возвращаемся домой или дремлем.
  if (distanceHome > 1.5) {
    mob.phase = 'return';
    return { input: moveToward(mob, toward(mob.home), dt), strike: false };
  }

  mob.phase = 'idle';
  return { input: idle, strike: false };
}

/** Отсчёт до воскрешения. Возвращает true, если моба пора поднимать. */
export function tickRespawn(mob: Mob, dt: number): boolean {
  if (mob.alive) return false;
  mob.respawnIn -= dt;
  if (mob.respawnIn > 0) return false;

  mob.alive = true;
  mob.vitals.health = mob.profile.health;
  mob.pos = { ...mob.home };
  mob.state = createMoveState(mob.home, {
    body: { radius: mob.profile.radius, height: mob.profile.height },
    speedScale: mob.profile.speedScale,
  });
  mob.phase = 'idle';
  mob.targetId = null;
  mob.lastPos = { ...mob.home };
  mob.chaseMetres = 0;
  mob.giveUpFor = 0;
  mob.windupRemaining = 0;
  mob.stuckFor = 0;
  mob.sidestep = 0;
  mob.sidestepFor = 0;
  return true;
}

/**
 * Видно ли ещё тело. Первые CORPSE_SECONDS после смерти моб остаётся
 * в снапшотах с признаком alive: false, чтобы клиент успел уронить его,
 * а не убрать из сцены мгновенно.
 */
export function isCorpseVisible(mob: Mob): boolean {
  return !mob.alive && mob.respawnIn > RESPAWN_SECONDS - CORPSE_SECONDS;
}

export function killMob(mob: Mob): void {
  mob.alive = false;
  mob.phase = 'dead';
  mob.targetId = null;
  mob.windupRemaining = 0;
  mob.respawnIn = RESPAWN_SECONDS;
}

function moveToward(mob: Mob, destination: Vec3, dt: number): MoveInput {
  const yaw = yawToward(mob.pos, destination);
  mob.yaw = yaw;
  // Обходит — идёт боком, не переставая смотреть на цель: замах и удар
  // считаются по взгляду, и разворачивать его вбок значило бы бить в стену.
  const right = mob.sidestepFor > 0 ? mob.sidestep : 0;
  const forward = right === 0 ? 1 : SIDESTEP_FORWARD;
  return { seq: 0, forward, right, yaw, pitch: 0, jump: false, sprint: false, dt };
}

/**
 * Упёрся ли моб и не пора ли обходить.
 *
 * Меряется по **факту**: сколько он прошёл за шаг против того, сколько должен
 * был. Стена, валун, угол перегородки и другой моб дают одно и то же — и
 * лечатся одинаково.
 */
function trackStuck(mob: Mob, moved: number, dt: number): void {
  if (mob.sidestepFor > 0) {
    mob.sidestepFor -= dt;
    if (mob.sidestepFor <= 0) mob.sidestep = 0;
    return;
  }

  const moving = mob.phase === 'chase' || mob.phase === 'return' || mob.phase === 'flee';
  const expected = WALK_SPEED * mob.profile.speedScale * dt;
  if (!moving || expected <= 0 || moved >= expected * STUCK_SHARE) {
    mob.stuckFor = 0;
    return;
  }

  mob.stuckFor += dt;
  if (mob.stuckFor < STUCK_SECONDS) return;
  mob.stuckFor = 0;
  // Сторона выбирается случайно: угадать, с какой стороны короче, моб не может,
  // а всегда одна и та же сторона запирала бы его в одном и том же углу.
  mob.sidestep = Math.random() < 0.5 ? -1 : 1;
  mob.sidestepFor = SIDESTEP_SECONDS;
}

/** При forward = 1 движение идёт в (-sin yaw, -cos yaw) — отсюда обратное преобразование. */
function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
