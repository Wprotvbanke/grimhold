import { z } from 'zod';
import type { Race } from './races.js';
import type { CharacterClass } from './classes.js';
import type { ActionKind, ActionPhase } from './combat.js';
import type { MobId } from './mobs.js';
import type { PvpFlag } from './pvp.js';
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

export const PROTOCOL_VERSION = 21;
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

/**
 * Служебная команда ведущего: выдать себе вещь или перевести стрелки часов.
 *
 * Право проверяет сервер по аккаунту, а не по наличию окна у клиента: меню —
 * это удобство, а не пропуск. Присланная кем угодно команда просто
 * не выполнится.
 */
export const AdminSchema = z.object({
  t: z.literal('admin'),
  do: z.enum(['give', 'time']),
  itemId: z.string().max(64).optional(),
  count: z.number().int().min(1).max(999).optional(),
  /** Время суток: 0 — полночь, 0.25 — рассвет, 0.5 — полдень, 0.75 — закат. */
  time: z.number().min(0).max(1).optional(),
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

/**
 * Снять надетое.
 *
 * Клетка назначения необязательна, как и у казны: щелчок по слоту её не знает
 * и место ищет сервер, перетаскивание знает — вещь ложится именно туда.
 */
export const UnequipSchema = z.object({
  t: z.literal('unequip'),
  slot: SlotSchema,
  toX: z.number().int().min(0).max(15).optional(),
  toY: z.number().int().min(0).max(15).optional(),
  rotate: z.boolean().optional(),
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

/**
 * Изготовить вещь по рецепту.
 *
 * Клиент шлёт только имя рецепта. Доступен ли он этой расе, изучен ли,
 * хватает ли сырья и влезает ли результат — решает сервер.
 */
/**
 * Вскрыть сундук в подземелье.
 *
 * Клиент шлёт только имя сундука. Где он стоит, не вскрыт ли уже и дошёл ли
 * до него игрок — решает сервер: сундук он восстанавливает из зерна инстанса
 * тем же генератором, что и клиент.
 */
export const OpenChestSchema = z.object({
  t: z.literal('openChest'),
  chestId: z.string().max(32),
});

/**
 * Обыскать мешок, оставшийся от павшего.
 *
 * Клиент шлёт только имя мешка: дошёл ли до него игрок и лежит ли он ещё,
 * решает сервер. Дальше мешок работает как казна — тем же сообщением и теми
 * же переносами.
 */
export const OpenBagSchema = z.object({
  t: z.literal('openBag'),
  bagId: z.string().max(32),
});

export const CraftSchema = z.object({
  t: z.literal('craft'),
  recipeId: z.string().max(48),
});

/**
 * Удар по ресурсной ноде.
 *
 * Клиент шлёт только имя ноды — намерение, а не результат. Что выпало, хватает
 * ли инструмента, не истощена ли она и не далеко ли до неё, решает сервер:
 * ноду он восстанавливает по имени тем же генератором, что и клиент.
 */
export const HarvestSchema = z.object({
  t: z.literal('harvest'),
  nodeId: z.string().max(32),
});

/**
 * Подойти к городской казне и открыть её.
 *
 * Расстояние проверяет сервер: клиент шлёт намерение, а не факт «я у сундука».
 */
export const OpenBankSchema = z.object({
  t: z.literal('openBank'),
});

export const CloseBankSchema = z.object({
  t: z.literal('closeBank'),
});

/**
 * Переложить вещь между рюкзаком и казной или внутри казны.
 *
 * Клетка назначения необязательна: щелчок её не знает, и тогда место ищет
 * сервер. Перетаскивание знает — и тогда вещь ложится именно туда, вместе
 * с поворотом. Казна раскладывается по тем же правилам, что и рюкзак:
 * хранилище, в котором нельзя навести порядок, быстро превращается в свалку.
 */
export const BankMoveSchema = z.object({
  t: z.literal('bankMove'),
  dir: z.enum(['deposit', 'withdraw', 'arrange']),
  x: z.number().int().min(0).max(15),
  y: z.number().int().min(0).max(15),
  toX: z.number().int().min(0).max(15).optional(),
  toY: z.number().int().min(0).max(15).optional(),
  rotate: z.boolean().optional(),
});

/**
 * Прямой обмен между игроками.
 *
 * Предложение — это обещание, а не залог: вещи остаются в рюкзаке, и что они
 * на месте, сервер проверяет в момент сделки. Иначе пришлось бы возвращать
 * отложенное при каждом разрыве связи, а место под возврат к тому моменту
 * могло быть уже занято.
 */
export const TradeInviteSchema = z.object({
  t: z.literal('tradeInvite'),
  targetId: z.string().max(48),
});

export const TradeRespondSchema = z.object({
  t: z.literal('tradeRespond'),
  accept: z.boolean(),
});

/** Положить вещь из рюкзака на стол. Координаты — клетка рюкзака. */
export const TradeOfferSchema = z.object({
  t: z.literal('tradeOffer'),
  x: z.number().int().min(0).max(15),
  y: z.number().int().min(0).max(15),
});

/** Забрать со стола своё предложение под номером. */
export const TradeWithdrawSchema = z.object({
  t: z.literal('tradeWithdraw'),
  index: z.number().int().min(0).max(31),
});

/**
 * Подтвердить или снять подтверждение.
 *
 * Любое изменение любой из сторон снимает оба: иначе подтвердивший первым
 * соглашался бы на то, чего не видел.
 */
export const TradeLockSchema = z.object({
  t: z.literal('tradeLock'),
  locked: z.boolean(),
});

export const TradeCancelSchema = z.object({
  t: z.literal('tradeCancel'),
});

/**
 * Спуститься в подземелье или выйти из него.
 *
 * Клиент шлёт только намерение: стоит ли он у люка, свободно ли место, куда
 * его поставить — решает сервер.
 */
export const EnterDungeonSchema = z.object({
  t: z.literal('enterDungeon'),
});

export const LeaveDungeonSchema = z.object({
  t: z.literal('leaveDungeon'),
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
  AdminSchema,
  MoveItemSchema,
  EquipSchema,
  UnequipSchema,
  UseItemSchema,
  DropItemSchema,
  SetHotbarSchema,
  UseHotbarSchema,
  HarvestSchema,
  OpenChestSchema,
  OpenBagSchema,
  CraftSchema,
  OpenBankSchema,
  CloseBankSchema,
  BankMoveSchema,
  EnterDungeonSchema,
  LeaveDungeonSchema,
  TradeInviteSchema,
  TradeRespondSchema,
  TradeOfferSchema,
  TradeWithdrawSchema,
  TradeLockSchema,
  TradeCancelSchema,
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
export type HarvestMessage = z.infer<typeof HarvestSchema>;
export type OpenChestMessage = z.infer<typeof OpenChestSchema>;
export type OpenBagMessage = z.infer<typeof OpenBagSchema>;
export type CraftMessage = z.infer<typeof CraftSchema>;
export type OpenBankMessage = z.infer<typeof OpenBankSchema>;
export type CloseBankMessage = z.infer<typeof CloseBankSchema>;
export type BankMoveMessage = z.infer<typeof BankMoveSchema>;
export type EnterDungeonMessage = z.infer<typeof EnterDungeonSchema>;
export type LeaveDungeonMessage = z.infer<typeof LeaveDungeonSchema>;
export type TradeInviteMessage = z.infer<typeof TradeInviteSchema>;
export type TradeRespondMessage = z.infer<typeof TradeRespondSchema>;
export type TradeOfferMessage = z.infer<typeof TradeOfferSchema>;
export type TradeWithdrawMessage = z.infer<typeof TradeWithdrawSchema>;
export type TradeLockMessage = z.infer<typeof TradeLockSchema>;
export type TradeCancelMessage = z.infer<typeof TradeCancelSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- Сервер -> Клиент ----------

/**
 * Сущность в снапшоте.
 *
 * **Опознание едет один раз.** Имя, вид, раса и порода не меняются никогда,
 * но раньше ехали двадцать раз в секунду и занимали 45% каждой сущности.
 * Теперь они приходят при первом появлении в поле зрения, а дальше сущность
 * узнаётся по `id`; вышел из радиуса и вернулся — представят заново.
 *
 * Поэтому у клиента обязана быть память на опознанных: сущность без имени —
 * это не ошибка, это «ты его уже знаешь».
 */
export interface EntitySnapshot {
  id: string;
  name?: string;
  /** Игрок, мирный житель или зверьё — от этого зависит подпись и модель. */
  kind?: 'player' | 'npc' | 'mob';
  race?: Race;
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
  /**
   * Цвет ника: мирный, полез в драку или убийца.
   *
   * Шлётся только игрокам — зверью флаги ни к чему. По нему видно, кого
   * можно бить без последствий, и решение это принимается на глаз, за секунду.
   */
  flag?: PvpFlag;
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
  /** Открыто ли служебное меню. Решает сервер — клиент только рисует. */
  admin: boolean;
  /** Сдвиг часов мира, поставленный ведущим. Ноль — часы идут как заведены. */
  daytimeShift: number;
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
  /**
   * Сколько секунд лежать. Растёт с каждой быстрой смертью, и игрок обязан
   * видеть это число: молчаливо неработающая кнопка читается как поломка.
   */
  respawnIn?: number;
}

/** Что выпало с убитого. Инвентаря пока нет — показываем в чате. */
export interface LootMessage {
  t: 'loot';
  from: string;
  items: { itemId: string; name: string; count: number }[];
  /** Сколько не влезло в рюкзак и осталось на земле. */
  lost: number;
  /**
   * Добыча лежит мешком, а не попала в рюкзак.
   *
   * Так падает всё с убитых: игрок сам решает, что брать. Клиенту это нужно,
   * чтобы не соврать — «получено» и «лежит рядом» разные вещи.
   */
  onGround?: boolean;
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

/**
 * Содержимое открытого хранилища: городской казны или мешка павшего.
 *
 * Одно сообщение на оба, потому что для игрока это одно и то же окно с чужой
 * сеткой, и правила переноса в нём те же. Приходит только пока хранилище
 * открыто: закрытое клиенту не нужно, а лежит в нём самое ценное.
 */
export interface BankMessage {
  t: 'bank';
  open: boolean;
  grid: Grid;
  /** Что именно открыто — подписью над сеткой. */
  title: string;
}

/** Одна строка на столе обмена. */
export interface TradeEntry {
  itemId: string;
  name: string;
  count: number;
}

/**
 * Состояние стола обмена. Приходит обеим сторонам при любом изменении:
 * оба должны видеть одно и то же, иначе подтверждение ничего не значит.
 */
export interface TradeMessage {
  t: 'trade';
  stage: 'invited' | 'open' | 'done' | 'closed';
  /** Имя собеседника — с кем именно идёт разговор. */
  partner: string;
  mine: TradeEntry[];
  theirs: TradeEntry[];
  myLock: boolean;
  theirLock: boolean;
  /** Чем кончилось: «обмен состоялся», «он отказался» и так далее. */
  note?: string;
}

/**
 * Ход изготовления.
 *
 * Шлётся дважды: когда работа начата и когда кончилась. Между этими двумя
 * сообщениями полосу двигает клиент по известной длительности — гнать её
 * тиками означало бы двадцать пакетов в секунду ради одной шкалы.
 */
export interface CraftingMessage {
  t: 'crafting';
  /** Что делают. `null` — работа кончилась, полосу убрать. */
  recipeId: string | null;
  /** Название изделия — подписью над полосой. */
  name: string;
  /** Сколько всего секунд занимает работа. */
  duration: number;
  /** Сколько осталось на момент отправки. */
  remaining: number;
  /** Чем кончилось, если кончилось. */
  note?: string;
}

/**
 * Ход добычи.
 *
 * Устроено как `crafting`: два сообщения — начало и конец, между ними полосу
 * двигает клиент по известной длительности. Гнать шкалу тиками означало бы
 * двадцать пакетов в секунду ради картинки.
 */
export interface GatheringMessage {
  t: 'gathering';
  /**
   * Над чем работают: имя ноды или имя сундука. `null` — работа кончилась,
   * полосу убрать.
   *
   * Полоса у сундука и полоса у дерева — одна и та же механика: стоишь,
   * ждёшь, отошёл — бросил. Заводить ради сундука второе сообщение значило бы
   * держать две шкалы, которые обязаны вести себя одинаково.
   */
  nodeId: string | null;
  /** Название ноды — подписью над полосой. */
  name: string;
  duration: number;
  remaining: number;
  /** Чем кончилось, если кончилось. */
  note?: string;
}

/**
 * Где игрок находится: имя инстанса и куда его поставили.
 *
 * Клиенту это нужно, чтобы строить правильную землю под ногами: раскладка
 * подземелья выводится из зерна в имени инстанса, как дикие земли выводятся
 * из координат чанка. Поэтому по сети едет имя, а не геометрия.
 */
/**
 * Стрелки часов переведены.
 *
 * Время суток обе стороны выводят из номера тика — пересылать его каждый кадр
 * незачем. А вот сдвиг, поставленный ведущим, вывести неоткуда: о нём надо
 * сказать, и сказать всем сразу, иначе ночь наступит у одного.
 */
export interface DaytimeMessage {
  t: 'daytime';
  shift: number;
}

export interface WorldMessage {
  t: 'world';
  instanceId: string;
  spawn: { x: number; y: number; z: number };
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
  /** Свой флаг и карма: игрок должен видеть, во что он себя вогнал. */
  flag: PvpFlag;
  karma: number;
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
  /**
   * Имена истощённых ресурсных нод поблизости.
   *
   * Шлём **исключения, а не состояние всего мира**: ноды рождаются одним
   * генератором на обеих сторонах, и клиент знает про каждую всё, кроме одного
   * — сняли с неё урожай или нет. Нетронутых тысячи, выработанных единицы,
   * поэтому дешевле перечислить вторые.
   */
  depletedNodes: string[];
  /**
   * Имена вскрытых сундуков подземелья.
   *
   * По той же причине, что и выработанные ноды: сундуки клиент выводит из
   * зерна инстанса сам и знает про них всё, кроме одного — добрались до них
   * или нет. Наверху список всегда пуст.
   */
  openedChests: string[];
  /**
   * Мешки павших поблизости.
   *
   * Отдельным списком, а не сущностями снапшота: у мешка нет ни имени, ни
   * здоровья, ни действий — только место. Пихать его в общий список значило бы
   * тащить с ним половину полей, которых у него нет.
   */
  bags: BagSnapshot[];
}

/** Мешок, оставшийся от павшего. Всё остальное про него знает сервер. */
export interface BagSnapshot {
  id: string;
  x: number;
  y: number;
  z: number;
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
  | BankMessage
  | TradeMessage
  | CraftingMessage
  | GatheringMessage
  | WorldMessage
  | DaytimeMessage
  | ItemErrorMessage
  | ErrorMessage;

export type { EquipSlot };

/** Сколько персонажей на аккаунт. */
export const MAX_CHARACTERS = 3;

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}
