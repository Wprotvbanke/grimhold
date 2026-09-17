import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_POINT } from '@grimhold/shared';
import { SqliteStorage } from '../src/storage/sqlite.js';

/**
 * Удаление персонажа.
 *
 * Проверяется то, что необратимо: строка исчезает, место освобождается,
 * а соседи по учётной записи остаются на месте. Подтверждение именем живёт
 * в `session.ts` и проверяется живым клиентом — здесь только хранилище.
 */

function storage(): SqliteStorage {
  return new SqliteStorage(join(mkdtempSync(join(tmpdir(), 'grimhold-')), 'test.db'));
}

describe('персонажа стирают насовсем', () => {
  it('он исчезает, а соседи остаются', () => {
    const db = storage();
    const account = db.createAccount('Хозяин', 'hash', 'salt');
    const first = db.createCharacter(account.id, 'Первый', 'human', 'warrior', SPAWN_POINT);
    const second = db.createCharacter(account.id, 'Второй', 'elf', 'mage', SPAWN_POINT);

    db.deleteCharacter(first.id);

    expect(db.getCharacter(first.id)).toBeNull();
    // Место освободилось — ради этого удаление и заводили.
    expect(db.listCharacters(account.id).map((entry) => entry.id)).toEqual([second.id]);
  });

  it('имя освобождается для нового персонажа', () => {
    const db = storage();
    const account = db.createAccount('Хозяин', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Торин', 'dwarf', 'warrior', SPAWN_POINT);

    db.deleteCharacter(character.id);

    // Имена в игре уникальны на весь мир: стёртое должно снова стать
    // свободным, иначе удаление тихо отнимает имя навсегда.
    expect(db.findCharacterByName('Торин')).toBeNull();
    expect(() =>
      db.createCharacter(account.id, 'Торин', 'human', 'ranger', SPAWN_POINT),
    ).not.toThrow();
  });
});
