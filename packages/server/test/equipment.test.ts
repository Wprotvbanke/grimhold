import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_POINT, addProgress, pointCost, spendPoint } from '@grimhold/shared';
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

describe('прокачка переживает перезаход', () => {
  it('книга навыков возвращается целой', () => {
    /**
     * Навыки не сохранялись вовсе: каждый вход обнулял всё нажитое. При том
     * что до сотого уровня одного навыка идут тысячи боёв — то есть опыт
     * не значил ничего, и заметить это можно было только выйдя из игры.
     */
    const db = storage();
    const account = db.createAccount('Ветеран', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Ветеран', 'human', 'warrior', SPAWN_POINT);

    const skills = { ...character.skills, blade: { level: 17, experience: 42 } };
    db.saveCharacters([{ ...character, skills }]);

    const loaded = db.getCharacter(character.id)!;
    expect(loaded.skills.blade).toEqual({ level: 17, experience: 42 });
    // Нетронутые навыки остаются на нуле, а не пропадают из книги.
    expect(loaded.skills.archery).toEqual({ level: 0, experience: 0 });
  });
});

describe('очки роста', () => {
  it('копятся, вкладываются и переживают перезаход', () => {
    const db = storage();
    const account = db.createAccount('Копитель', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Копитель', 'human', 'warrior', SPAWN_POINT);

    // Свежий персонаж начинает с пустого роста, а не с пустоты в поле.
    expect(character.progress).toEqual({ pool: 0, points: 0, spent: { health: 0, stamina: 0, mana: 0 } });

    const earned = addProgress(character.progress, pointCost(0)).progress;
    const spent = spendPoint(earned, 'health')!;
    db.saveCharacters([{ ...character, progress: spent }]);

    expect(db.getCharacter(character.id)!.progress.spent.health).toBe(1);
  });

  it('испорченная строка не выдаёт лишнего', () => {
    const db = storage();
    const account = db.createAccount('Хитрец', 'hash', 'salt');
    const character = db.createCharacter(account.id, 'Хитрец', 'human', 'warrior', SPAWN_POINT);

    db.saveCharacters([
      {
        ...character,
        progress: { pool: -5, points: 2.7, spent: { health: -3, stamina: 1, mana: 0 } },
      },
    ]);

    const loaded = db.getCharacter(character.id)!.progress;
    expect(loaded.pool).toBe(0);
    expect(loaded.points).toBe(2);
    expect(loaded.spent.health).toBe(0);
  });
});
