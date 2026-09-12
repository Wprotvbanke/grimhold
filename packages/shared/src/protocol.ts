import { z } from 'zod';
import type { Race } from './races.js';
import type { CharacterClass } from './classes.js';
import type { ActionKind, ActionPhase } from './combat.js';
import type { MobId } from './mobs.js';
import type { SpellId } from './spells.js';
import type { Equipment, Grid, Hotbar } from './inventory.js';
import type { EquipSlot } from './items.js';
import type { RecipeId } from './recipes.js';
import type { SkillId } from './skills.js';

/**
 * Сетевой протокол. Правило, от которого зависит вся будущая античит-обвязка:
 * клиент присылает ТОЛЬКО намерения, никогда результаты.
 *
 * Можно: "я жму вперёд", "я хочу ударить в этом направлении".
 * Нельзя: "моя позиция теперь X", "я нанёс 50 урона".
 *
 * Пока протокол в JSON — читаемость важнее байтов при 50 игроках.
 * Бинарный формат появится, когда состав пакетов устоится.
 */

export const PROTOCOL_VERSION = 6;
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

/**
 * Клиент шлёт ввод фиксированным шагом, а не по кадрам: тогда сервер и клиент
 * прогоняют одинаковые числа, и предсказание сходится побитово.
 */
export const INPUT_RATE = 60;
export const INPUT_DT = 1 / INPUT_RATE;

/**
 * Радиус интереса. Сервер шлёт только то, что рядом — это и экономия трафика,
 * и защита от wallhack: данных о далёких игроках у клиента просто нет.
 */
export const AOI_RADIUS = 45;

/**
 * Задержка отрисовки чужих игроков. Их позиции интерполируются между снапшотами,
 * поэтому показываем прошлое — иначе на каждой потере пакета была бы дырка.
 */
export const INTERP_DELAY_MS = 110;

/** Максимум вводов от одного клиента за тик — грубый предохранитель от флуда. */
export const MAX_INPUTS_PER_TICK = 12;

// ---------- Клиент -> Сервер ----------

const RaceSchema = z.enum(['human', 'dwarf', 'elf']);
const ClassSchema = z.enum(['warrior', 'ranger', 'mage']);

/** Имя персонажа и логин: буквы, цифры и пробел внутри — без управляющих символов. */
const NameSchema = z
  .string()
  .trim()
  .min(3)
  .max(16)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'недопустимые символы');

export const RegisterSchema = z.object({
  t: z.literal('register'),
  protocol: z.number().int(),
  username: NameSchema,
  password: z.string().min(6).max(72),
});

export const LoginSchema = z.object({
  t: z.literal('login'),
  protocol: z.number().int(),
  username: NameSchema,
  password: z.string().min(1).max(72),
});

export const CreateCharacterSchema = z.object({
  t: z.literal('createCharacter'),
  name: NameSchema,
  race: RaceSchema,
  characterClass: ClassSchema,
});

export const EnterWorldSchema = z.object({
  t: z.literal('enterWorld'),
  characterId: z.string().min(1).max(64),
});

/**
 * Боевое намерение. `viewTick` — снапшот, который игрок видел в момент удара:
 * по нему сервер отматывает цели назад и проверяет попадание там, где они были
 * на экране атакующего, а не там, где они уже оказались.
 */
export const ActionSchema = z.object({
  t: z.literal('action'),
  kind: z.enum(['attack', 'heavy', 'dodge']),
  seq: z.number().int().nonnegative(),
  viewTick: z.number().int().nonnegative(),
});

export const BlockSchema = z.object({
  t: z.literal('block'),
  active: z.boolean(),
});

export const CastSchema = z.object({
  t: z.literal('cast'),
  spellId: z.enum(['ember', 'frostbite', 'lightning', 'mend', 'wardskin', 'lantern']),
  viewTick: z.number().int().nonnegative(),
});

export const RespawnSchema = z.object({
  t: z.literal('respawn'),
});

const SlotSchema = z.enum(['head', 'chest', 'legs', 'hands', 'mainHand', 'offHand']);

/**
 * Работа с вещами. Клиент говорит «перенеси предмет отсюда сюда» —
 * влезает ли он и что при этом происходит, решает исключительно сервер.
 * Предметы адресуются клеткой, в которой лежат: отдельные идентификаторы
 * экземпляров не нужны, а значит нечему и разъезжаться.
 */
export const MoveItemSchema = z.object({
  t: z.literal('moveItem'),
  fromX: z.number().int().min(0).max(63),
  fromY: z.number().int().min(0).max(63),
  toX: z.number().int().min(0).max(63),
  toY: z.number().int().min(0).max(63),
  rotate: z.boolean(),
});

export const EquipSchema = z.object({
  t: z.literal('equip'),
  x: z.number().int().min(0).max(63),
  y: z.number().int().min(0).max(63),
});

export const UnequipSchema = z.object({
  t: z.literal('unequip'),
  slot: SlotSchema,
});

export const UseItemSchema = z.object({
  t: z.literal('useItem'),
  x: z.number().int().min(0).max(63),
  y: z.number().int().min(0).max(63),
});

export const DropItemSchema = z.object({
  t: z.literal('dropItem'),
  x: z.number().int().min(0).max(63),
  y: z.number().int().min(0).max(63),
});

/**
 * Панель горячих клавиш. Назначение хранит вид предмета, а нажатие —
 * только номер ячейки: что именно произойдёт, решает сервер по виду предмета.
 */
export const SetHotbarSchema = z.object({
  t: z.literal('setHotbar'),
  index: z.number().int().min(0).max(5),
  /** Пустая строка очищает ячейку. */
  itemId: z.string().max(48),
});

export const UseHotbarSchema = z.object({
  t: z.literal('useHotbar'),
  index: z.number().int().min(0).max(5),
  viewTick: z.number().int().nonnegative(),
});

export const ChatSchema = z.object({
  t: z.literal('chat'),
  channel: z.enum(['local', 'global']),
  text: z.string().trim().min(1).max(200),
});

export const InputSchema = z.object({
  t: z.literal('input'),
  seq: z.number().int().nonnegative(),
  forward: z.number().min(-1).max(1),
  right: z.number().min(-1).max(1),
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  jump: z.boolean(),
  sprint: z.boolean(),
  dt: z.number().min(0).max(0.1),
});

export const ClientMessageSchema = z.discriminatedUnion('t', [
  RegisterSchema,
  LoginSchema,
  CreateCharacterSchema,
  EnterWorldSchema,
  ChatSchema,
  InputSchema,
  ActionSchema,
  BlockSchema,
  CastSchema,
  RespawnSchema,
  MoveItemSchema,
  EquipSchema,
  UnequipSchema,
  UseItemSchema,
  DropItemSchema,
  SetHotbarSchema,
  UseHotbarSchema,
]);

export type RegisterMessage = z.infer<typeof RegisterSchema>;
export type LoginMessage = z.infer<typeof LoginSchema>;
export type CreateCharacterMessage = z.infer<typeof CreateCharacterSchema>;
export type EnterWorldMessage = z.infer<typeof EnterWorldSchema>;
export type ChatMessage = z.infer<typeof ChatSchema>;
export type InputMessage = z.infer<typeof InputSchema>;
export type ActionMessage = z.infer<typeof ActionSchema>;
export type BlockMessage = z.infer<typeof BlockSchema>;
export type CastMessage = z.infer<typeof CastSchema>;
export type MoveItemMessage = z.infer<typeof MoveItemSchema>;
export type EquipMessage = z.infer<typeof EquipSchema>;
export type UnequipMessage = z.infer<typeof UnequipSchema>;
export type UseItemMessage = z.infer<typeof UseItemSchema>;
export type DropItemMessage = z.infer<typeof DropItemSchema>;
export type SetHotbarMessage = z.infer<typeof SetHotbarSchema>;
export type UseHotbarMessage = z.infer<typeof UseHotbarSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- Сервер -> Клиент ----------

export interface EntitySnapshot {
  id: string;
  name: string;
  /** Игрок, мирный житель или зверьё — от этого зависит подпись и модель. */
  kind: 'player' | 'npc' | 'mob';
  race: Race;
  mobId?: MobId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Доля здоровья 0..1. Абсолютных чисел о чужих не шлём. */
  hp: number;
  alive: boolean;
  /** Что сущность делает — по этому клиент выбирает анимацию. */
  action?: ActionKind;
  phase?: ActionPhase;
}

/** Карточка персонажа для экрана выбора. */
export interface CharacterSummary {
  id: string;
  name: string;
  race: Race;
  characterClass: CharacterClass;
  playtimeSeconds: number;
  lastSeenAt: number;
}

export interface AuthenticatedMessage {
  t: 'authenticated';
  username: string;
  characters: CharacterSummary[];
  /** Сколько персонажей всего можно завести. */
  maxCharacters: number;
}

export interface AuthErrorMessage {
  t: 'authError';
  message: string;
}

export interface WelcomeMessage {
  t: 'welcome';
  playerId: string;
  tickRate: number;
  protocol: number;
  character: CharacterSummary;
  spawn: { x: number; y: number; z: number };
}

/** Событие боя — для звука, всплывающих чисел и вспышек на экране. */
export interface CombatEvent {
  t: 'combat';
  kind: 'hit' | 'blocked' | 'dodged' | 'miss' | 'death' | 'heal';
  attackerId: string;
  attackerName: string;
  targetId: string;
  targetName: string;
  amount: number;
  backstab: boolean;
  x: number;
  y: number;
  z: number;
}

/** Навык поднялся — коротко сообщаем игроку. */
export interface SkillUpMessage {
  t: 'skillUp';
  skill: SkillId;
  level: number;
}

/** Персонаж погиб или воскрес. */
export interface LifeMessage {
  t: 'life';
  event: 'died' | 'respawned';
  killerName?: string;
  spawn?: { x: number; y: number; z: number };
}

/** Что выпало с убитого. Инвентаря пока нет — показываем в чате. */
export interface LootMessage {
  t: 'loot';
  from: string;
  items: { itemId: string; name: string; count: number }[];
  /** Сколько не влезло в рюкзак и осталось на земле. */
  lost: number;
}

/**
 * Состояние вещей. Присылается целиком при любом изменении: рюкзак невелик,
 * а рассинхрон раскладки в игре с полной потерей лута стоит дороже трафика.
 */
export interface InventoryMessage {
  t: 'inventory';
  backpack: Grid;
  equipment: Equipment;
  knownRecipes: RecipeId[];
  hotbar: Hotbar;
  /** Текущий вес и предел без штрафа — для полосы нагрузки. */
  weight: number;
  capacity: number;
  /** Броня и урон оружия: чтобы игрок видел, что даёт надетое. */
  armor: number;
  weaponDamage: number;
}

/** Почему действие с вещью не прошло. Клиент показывает это игроку. */
export interface ItemErrorMessage {
  t: 'itemError';
  message: string;
}

export interface ChatBroadcast {
  t: 'chatMessage';
  channel: 'local' | 'global' | 'system';
  from: string;
  text: string;
}

/**
 * Авторитетное состояние самого игрока. Для реконсилиации мало одной позиции:
 * чтобы переиграть непринятые вводы, нужны ещё скорость и контакт с землёй.
 */
export interface SelfState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;

  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  stamina: number;
  maxStamina: number;
  alive: boolean;
  blocking: boolean;
  action?: ActionKind;
  phase?: ActionPhase;
  /** Оставшаяся неуязвимость рывка, секунды. */
  invulnerable: number;
  /** Сколько ещё горит «Светоч», секунды. */
  light: number;
}

/** Летящий снаряд заклинания. От него можно отойти, поэтому он в снапшоте. */
export interface ProjectileSnapshot {
  id: string;
  spellId: SpellId;
  x: number;
  y: number;
  z: number;
}

export interface SnapshotMessage {
  t: 'snapshot';
  tick: number;
  /** Номер последнего обработанного ввода этого игрока — основа реконсилиации. */
  ack: number;
  self: SelfState;
  entities: EntitySnapshot[];
  projectiles: ProjectileSnapshot[];
}

export interface ErrorMessage {
  t: 'error';
  message: string;
}

export type ServerMessage =
  | AuthenticatedMessage
  | AuthErrorMessage
  | WelcomeMessage
  | SnapshotMessage
  | ChatBroadcast
  | CombatEvent
  | SkillUpMessage
  | LifeMessage
  | LootMessage
  | InventoryMessage
  | ItemErrorMessage
  | ErrorMessage;

export type { EquipSlot };

/** Сколько персонажей на аккаунт. */
export const MAX_CHARACTERS = 3;

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}
