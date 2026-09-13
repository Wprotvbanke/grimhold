import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_POINT } from '@grimhold/shared';
import { SqliteStorage } from '../src/storage/sqlite.js';

/**
 * Надетое переживает перезаход.
 *
 * Проверка появилась после того, как **всё оружие пропадало при входе**:
 * экипировка при загрузке проходила через сетку один на один, и всё, что
 * больше клетки — меч 2×4, лук 2×4, кираса 2×2, — не помещалось и молча
 * терялось. Ошибок при этом не было нигде: сервер честно отдавал то, что
 * сумел прочитать.
 */

function storage(): SqliteStorage {
  return new SqliteStorage(join(mkdtempSync(join(tmpdir(), 'grimhold-')), 'test.db'));
}

describe('надетое переживает перезаход', () => {
  it('и крупные вещи тоже', () => {
    const db = storage();
    const account = db.createAccount('Ратмир', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Ратмир', 'human', 'warrior', SPAWN_POINT);

    db.saveCharacters([
      {
        ...character,
        equipment: {
          mainHand: { defId: 'iron_sword', count: 1, x: 0, y: 0, rotated: false },
          chest: { defId: 'iron_cuirass', count: 1, x: 0, y: 0, rotated: false },
          offHand: { defId: 'torch', count: 2, x: 0, y: 0, rotated: false },
        },
      },
    ]);

    const loaded = db.getCharacter(character.id)!;
    expect(loaded.equipment.mainHand?.defId).toBe('iron_sword');
    expect(loaded.equipment.chest?.defId).toBe('iron_cuirass');
    // Стопка в слоте не теряется: факелов было два, два и осталось.
    expect(loaded.equipment.offHand?.count).toBe(2);
  });

  it('но не то, что в этот слот не надевается', () => {
    // Испорченная строка не должна надеть меч на голову.
    const db = storage();
    const account = db.createAccount('Кривой', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Кривой', 'human', 'warrior', SPAWN_POINT);

    db.saveCharacters([
      {
        ...character,
        equipment: { head: { defId: 'iron_sword', count: 1, x: 0, y: 0, rotated: false } },
      },
    ]);

    expect(db.getCharacter(character.id)!.equipment.head).toBeUndefined();
  });
});
