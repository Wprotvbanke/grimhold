import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CharacterClass, Race } from '@grimhold/shared';
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
    playtime_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);
`;

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
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
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
    };

    this.db
      .prepare(
        `INSERT INTO characters
           (id, account_id, name, race, class, x, y, z, yaw, instance_id, created_at, last_seen_at, playtime_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          SET x = ?, y = ?, z = ?, yaw = ?, last_seen_at = ?, playtime_seconds = ?
        WHERE id = ?`,
    );

    this.db.exec('BEGIN');
    try {
      for (const save of saves) {
        statement.run(save.x, save.y, save.z, save.yaw, save.lastSeenAt, save.playtimeSeconds, save.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
  };
}
