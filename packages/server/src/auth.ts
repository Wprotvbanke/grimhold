import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Пароли. Берём scrypt из стандартной библиотеки: он специально медленный
 * и требователен к памяти, поэтому перебор украденной базы дорог.
 * Внешних зависимостей не нужно.
 */

const KEY_LENGTH = 64;
/** Параметры подобраны так, чтобы проверка занимала десятки миллисекунд. */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface PasswordHash {
  hash: string;
  salt: string;
}

export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString('hex');
  return { hash, salt };
}

/** Сравнение идёт за постоянное время — иначе по задержке подбирают хеш побайтно. */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
