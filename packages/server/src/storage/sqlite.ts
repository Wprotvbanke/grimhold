import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  BANK_HEIGHT,
  BANK_WIDTH,
  BACKPACK_HEIGHT,
  BACKPACK_WIDTH,
  addItem,
  createBackpack,
  createBank,
  createHotbar,
  isItemId,
  isRecipeId,
  MAX_SKILL_LEVEL,
  SKILLS,
  emptyProgress,
  itemDef,
  sanitizeGrid,
  sanitizeHotbar,
  type CharacterClass,
  type Equipment,
  type Grid,
  type ItemId,
  type PlacedItem,
  type Race,
  type RecipeId,
  type Progress,
  type SkillId,
  type SkillProgress,
} from '@grimhold/shared';
import type { AccountRecord, CharacterRecord, CharacterSave, Storage } from './types.js';

/**
 * Реализация хранилища на встроенном в Node SQLite.
 *
 * Выбран ради нулевых зависимостей на этапе разработки. Вся игровая логика
 * ходит через интерфейс Storage, поэтому PostgreSQL на проде — это ещё один
 * файл рядом, а не переделка сервера.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS characters (
    id               TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    race             TEXT NOT NULL,
    class            TEXT NOT NULL,
    x                REAL NOT NULL,
    y                REAL NOT NULL,
    z                REAL NOT NULL,
    yaw              REAL NOT NULL DEFAULT 0,
    instance_id      TEXT NOT NULL DEFAULT 'overworld',
    created_at       INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    inventory        TEXT NOT NULL DEFAULT '',
    equipment        TEXT NOT NULL DEFAULT '',
    known_recipes    TEXT NOT NULL DEFAULT '',
    skills           TEXT NOT NULL DEFAULT '',
    progress         TEXT NOT NULL DEFAULT '',
    karma            REAL NOT NULL DEFAULT 0,
    purple_for       REAL NOT NULL DEFAULT 0,
    hotbar           TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);

  CREATE TABLE IF NOT EXISTS banks (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    items      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
`;

/**
 * Столбцы, появившиеся после первой версии схемы.
 *
 * CREATE TABLE IF NOT EXISTS не добавляет столбцы в уже существующую таблицу,
 * поэтому базы, созданные до этой вехи, надо дополнить вручную — иначе
 * персонажи вчерашнего дня перестали бы открываться.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'characters', column: 'inventory', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'characters', column: 'equipment', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'characters', column: 'known_recipes', definition: "TEXT NOT NULL DEFAULT ''" },
  // Карма и фиолетовый переживают перезаход: иначе выйти и зайти означало бы
  // смыть с себя убийство, и весь флаг ничего бы не стоил.
  { table: 'characters', column: 'karma', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'characters', column: 'purple_for', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'characters', column: 'hotbar', definition: "TEXT NOT NULL DEFAULT ''" },
  // Прокачка переживает перезаход. Пока столбца не было, каждый вход обнулял
  // всё нажитое — а до сотого уровня одного навыка идут тысячи боёв.
  { table: 'characters', column: 'skills', definition: "TEXT NOT NULL DEFAULT ''" },
  // Очки роста — заработанная ценность, теряться при обновлении они не вправе.
  { table: 'characters', column: 'progress', definition: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Что кладётся новому персонажу.
 *
 * Инструментов тут нет намеренно: их делают сами из того, что лежит под
 * ногами за воротами — ветка, камень, волокно. Выданный топор делал первые
 * минуты прелюдией, а не игрой, и держал весь мир на одной вещи: потерял —
 * и мир закрылся.
 *
 * Бинты и факелы остаются: это расходники, а не ступень.
 */
const STARTER_KIT: { itemId: ItemId; count: number }[] = [
  { itemId: 'bandage', count: 3 },
  { itemId: 'torch', count: 2 },
];

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  created_at: number;
}

interface CharacterRow {
  id: string;
  account_id: string;
  name: string;
  race: string;
  class: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  instance_id: string;
  created_at: number;
  last_seen_at: number;
  playtime_seconds: number;
  inventory: string;
  equipment: string;
  known_recipes: string;
  skills: string;
  progress: string;
  karma: number;
  purple_for: number;
  hotbar: string;
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Догоняет схему старых баз, не трогая данные. */
  private migrate(): void {
    for (const { table, column, definition } of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
      }[];
      if (columns.some((entry) => entry.name === column)) continue;

      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[бд] миграция: добавлен столбец ${table}.${column}`);
    }
  }

  createAccount(username: string, passwordHash: string, salt: string): AccountRecord {
    const record: AccountRecord = {
      id: randomUUID(),
      username,
      passwordHash,
      salt,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO accounts (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.username, record.passwordHash, record.salt, record.createdAt);
    return record;
  }

  findAccountByUsername(username: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username) as unknown as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  listCharacters(accountId: string): CharacterRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as unknown as CharacterRow[];
    return rows.map(toCharacter);
  }

  findCharacterByName(name: string): CharacterRecord | null {
    const row = this.db
      .prepare('SELECT * FROM characters WHERE name = ?')
      .get(name) as unknown as CharacterRow | undefined;
    return row ? toCharacter(row) : null;
  }

  getCharacter(id: string): CharacterRecord | null {
    const row = this.db
      .prepare('SELECT * FROM characters WHERE id = ?')
      .get(id) as unknown as CharacterRow | undefined;
    return row ? toCharacter(row) : null;
  }

  createCharacter(
    accountId: string,
    name: string,
    race: Race,
    characterClass: CharacterClass,
    spawn: { x: number; y: number; z: number },
  ): CharacterRecord {
    const now = Date.now();

    // Новичок выходит в мир с топором, бинтами и факелами: без этого он
    // не может ни добывать, ни лечиться, а здоровье само не восстанавливается.
    let inventory = createBackpack();
    for (const entry of STARTER_KIT) {
      inventory = addItem(inventory, entry.itemId, entry.count).grid;
    }

    const record: CharacterRecord = {
      id: randomUUID(),
      accountId,
      name,
      race,
      characterClass,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      instanceId: 'overworld',
      createdAt: now,
      lastSeenAt: now,
      playtimeSeconds: 0,
      inventory,
      equipment: {},
      knownRecipes: [],
      skills: emptySkillBook(),
      progress: emptyProgress(),
      hotbar: createHotbar(),
      karma: 0,
      purpleFor: 0,
    };

    this.db
      .prepare(
        `INSERT INTO characters
           (id, account_id, name, race, class, x, y, z, yaw, instance_id,
            created_at, last_seen_at, playtime_seconds, inventory, equipment, known_recipes,
            skills, progress, hotbar)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.accountId,
        record.name,
        record.race,
        record.characterClass,
        record.x,
        record.y,
        record.z,
        record.yaw,
        record.instanceId,
        record.createdAt,
        record.lastSeenAt,
        record.playtimeSeconds,
        JSON.stringify(record.inventory),
        JSON.stringify(record.equipment),
        JSON.stringify(record.knownRecipes),
        JSON.stringify(record.skills),
        JSON.stringify(record.progress),
        JSON.stringify(record.hotbar),
      );

    return record;
  }

  /**
   * Пакетная запись в одной транзакции. Именно это спасает базу от шторма
   * инсертов: десятки изменений между флашами схлопываются в одну запись
   * на персонажа, и все они уходят за один коммит.
   */
  saveCharacters(saves: CharacterSave[]): void {
    if (saves.length === 0) return;

    const statement = this.db.prepare(
      `UPDATE characters
          SET x = ?, y = ?, z = ?, yaw = ?, last_seen_at = ?, playtime_seconds = ?,
              inventory = ?, equipment = ?, known_recipes = ?, skills = ?, progress = ?,
              hotbar = ?,
              karma = ?, purple_for = ?, instance_id = ?
        WHERE id = ?`,
    );

    this.db.exec('BEGIN');
    try {
      for (const save of saves) {
        statement.run(
          save.x,
          save.y,
          save.z,
          save.yaw,
          save.lastSeenAt,
          save.playtimeSeconds,
          JSON.stringify(save.inventory),
          JSON.stringify(save.equipment),
          JSON.stringify(save.knownRecipes),
          JSON.stringify(save.skills),
          JSON.stringify(save.progress),
          JSON.stringify(save.hotbar),
          save.karma,
          save.purpleFor,
          save.instanceId,
          save.id,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getBank(accountId: string): Grid {
    const row = this.db
      .prepare('SELECT items FROM banks WHERE account_id = ?')
      .get(accountId) as unknown as { items: string } | undefined;

    return sanitizeGrid(parseJson(row?.items), BANK_WIDTH, BANK_HEIGHT);
  }

  saveBank(accountId: string, bank: Grid): void {
    this.db
      .prepare(
        `INSERT INTO banks (account_id, items, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
      )
      .run(accountId, JSON.stringify(bank), Date.now());
  }

  close(): void {
    this.db.close();
  }
}

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    salt: row.salt,
    createdAt: row.created_at,
  };
}

function toCharacter(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    race: row.race as Race,
    characterClass: row.class as CharacterClass,
    x: row.x,
    y: row.y,
    z: row.z,
    yaw: row.yaw,
    instanceId: row.instance_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    playtimeSeconds: row.playtime_seconds,
    // Данные из базы никогда не принимаются на веру: предмет мог исчезнуть
    // из игры между версиями, а раскладка — разъехаться.
    inventory: sanitizeGrid(parseJson(row.inventory), BACKPACK_WIDTH, BACKPACK_HEIGHT),
    equipment: sanitizeEquipment(parseJson(row.equipment)),
    skills: sanitizeSkills(parseJson(row.skills)),
    progress: sanitizeProgress(parseJson(row.progress)),
    knownRecipes: sanitizeRecipes(parseJson(row.known_recipes)),
    karma: Math.max(0, row.karma ?? 0),
    purpleFor: Math.max(0, row.purple_for ?? 0),
    hotbar: sanitizeHotbar(parseJson(row.hotbar)),
  };
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Надетое проверяется так же строго, как рюкзак. */
/**
 * Надетое при загрузке из базы.
 *
 * **Не через сетку.** Раньше каждый слот проверялся раскладкой один на один —
 * и это молча съедало всё, что больше клетки: меч 2×4, лук 2×4, кираса 2×2.
 * В слоте вещь лежит целиком, размер там не значит ничего, а проверка размера
 * означала «снять с игрока всё оружие при каждом перезаходе».
 *
 * Проверяем то, что здесь действительно важно: предмет существует, его больше
 * нуля и он **годится для этого слота** — иначе испорченная строка надела бы
 * меч на голову.
 */
function sanitizeEquipment(raw: unknown): Equipment {
  const result: Equipment = {};
  if (!raw || typeof raw !== 'object') return result;

  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;

    const { defId, count } = value as PlacedItem;
    if (typeof defId !== 'string' || !isItemId(defId)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;

    const def = itemDef(defId);
    if (def.slot !== slot) continue;

    result[slot as keyof Equipment] = {
      defId,
      count: Math.min(Math.floor(count), def.stack),
      x: 0,
      y: 0,
      rotated: false,
    };
  }
  return result;
}

/**
 * Книга навыков из базы.
 *
 * Недостающие навыки добиваются нулями: список навыков со временем растёт,
 * и вчерашний персонаж не должен открываться с дырами. Отрицательное
 * и запредельное отбрасывается — уровень выше сотого не значит ничего.
 */
function sanitizeSkills(raw: unknown): Record<SkillId, SkillProgress> {
  const book = emptySkillBook();
  if (!raw || typeof raw !== 'object') return book;

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(id in book) || !value || typeof value !== 'object') continue;

    const { level, experience } = value as SkillProgress;
    if (!Number.isFinite(level) || !Number.isFinite(experience)) continue;

    book[id as SkillId] = {
      level: Math.max(0, Math.min(MAX_SKILL_LEVEL, Math.floor(level))),
      experience: Math.max(0, experience),
    };
  }
  return book;
}

/**
 * Рост персонажа из базы.
 *
 * Очки — это часы игры, поэтому отрицательные и дробные значения
 * отбрасываются молча, а не «чинятся» на глазок: испорченная строка не должна
 * ни отнять заработанное, ни выдать лишнего.
 */
function sanitizeProgress(raw: unknown): Progress {
  const empty = emptyProgress();
  if (!raw || typeof raw !== 'object') return empty;

  const source = raw as Progress;
  const whole = (value: unknown): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;

  return {
    pool: Number.isFinite(source.pool) ? Math.max(0, source.pool) : 0,
    points: whole(source.points),
    spent: {
      health: whole(source.spent?.health),
      stamina: whole(source.spent?.stamina),
      mana: whole(source.spent?.mana),
    },
  };
}

/** Пустая книга: все навыки на нуле. */
function emptySkillBook(): Record<SkillId, SkillProgress> {
  const book = {} as Record<SkillId, SkillProgress>;
  for (const id of Object.keys(SKILLS) as SkillId[]) book[id] = { level: 0, experience: 0 };
  return book;
}

function sanitizeRecipes(raw: unknown): RecipeId[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is RecipeId => typeof entry === 'string' && isRecipeId(entry));
}
