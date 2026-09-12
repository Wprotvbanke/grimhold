import type { CharacterClass, Equipment, Grid, Hotbar, Race, RecipeId } from '@grimhold/shared';

/**
 * Интерфейс хранилища. Весь доступ к БД идёт только через него —
 * поэтому переезд с SQLite на PostgreSQL будет заменой одной реализации,
 * а не правкой игровой логики.
 */

export interface AccountRecord {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

export interface CharacterRecord {
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
  createdAt: number;
  lastSeenAt: number;
  playtimeSeconds: number;
  /**
   * Рюкзак, надетое и изученные рецепты хранятся как JSON в строке персонажа,
   * а не таблицей на предмет. Так сохранение остаётся одним UPDATE вместо
   * сорока INSERT. Разносить на строки будем, когда понадобится искать
   * предметы по миру — то есть под аукцион.
   */
  inventory: Grid;
  equipment: Equipment;
  knownRecipes: RecipeId[];
  hotbar: Hotbar;
}

/** То, что меняется в игре и подлежит пакетной записи. */
export interface CharacterSave {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  lastSeenAt: number;
  playtimeSeconds: number;
  inventory: Grid;
  equipment: Equipment;
  knownRecipes: RecipeId[];
  hotbar: Hotbar;
}

export interface Storage {
  createAccount(username: string, passwordHash: string, salt: string): AccountRecord;
  findAccountByUsername(username: string): AccountRecord | null;

  listCharacters(accountId: string): CharacterRecord[];
  findCharacterByName(name: string): CharacterRecord | null;
  getCharacter(id: string): CharacterRecord | null;
  createCharacter(
    accountId: string,
    name: string,
    race: Race,
    characterClass: CharacterClass,
    spawn: { x: number; y: number; z: number },
  ): CharacterRecord;

  /** Пакетная запись в одной транзакции — основной путь сохранения. */
  saveCharacters(saves: CharacterSave[]): void;

  /**
   * Банк привязан к аккаунту, а не к персонажу: это общий склад,
   * и на вехе 6 именно он станет тем, ради чего выносят добычу.
   */
  getBank(accountId: string): Grid;
  saveBank(accountId: string, bank: Grid): void;

  close(): void;
}
