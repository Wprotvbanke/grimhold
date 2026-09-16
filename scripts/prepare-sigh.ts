/**
 * Подготовка звука лечения — вздоха облегчения.
 *
 *   npx tsx scripts/prepare-sigh.ts
 *
 * Лечение звучало интерфейсным «подтверждением» из набора Kenney, и владелец
 * назвал его противным — справедливо: бип в мрачном средневековье слышен как
 * чужой. Нужен человеческий выдох.
 *
 * Исходник — CC0-запись со студийного микрофона: «Sigh by the mouth»,
 * <https://bigsoundbank.com/sigh-by-the-mouth-s1405.html>, шесть секунд.
 * Файл лежит в `assets/source/sigh_source.ogg` — папка не в репозитории
 * (docs/git.md), скачать заново можно по ссылке выше. Шесть секунд на глоток лечения — это не звук, а
 * сцена, поэтому берём самую громкую полутора-секундную часть: собственно
 * выдох, без подхода и без хвоста.
 *
 * **Почему через браузер.** В проекте нет ffmpeg, а Ogg Vorbis на Node
 * декодировать нечем. Зато есть puppeteer, а в нём — `decodeAudioData`,
 * то есть полноценный декодер. Вырезаем, сводим в моно и пишем WAV: `.wav`
 * в папке звуков уже лежат (взмахи, факел), и движок читает их наравне с ogg.
 */
import puppeteer from 'puppeteer';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'assets/source/sigh_source.ogg');
const OUTPUT = resolve(ROOT, 'packages/client/public/sounds/sigh_relief.wav');

/** Сколько секунд оставить. Вздох в бою короткий: это выдох, а не сцена. */
const KEEP = 1.5;
/** Частота на выходе. Дыхание — звук низкий, верхов ему не надо. */
const RATE = 22050;
/** Плавные края, секунды: щелчок на срезе слышен лучше самого вздоха. */
const FADE_IN = 0.06;
const FADE_OUT = 0.35;
/** До какого уровня поднимаем самый громкий отсчёт. Не до края — с запасом. */
const PEAK = 0.85;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

const bytes = [...readFileSync(SOURCE)];

/**
 * Декодирование и обрезка идут **в браузере**: там живёт декодер Ogg.
 * Наружу возвращается уже готовая моно-дорожка числами.
 */
const track: number[] = await page.evaluate(
  async (raw: number[], keep: number, rate: number, fadeIn: number, fadeOut: number, peak: number) => {
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(new Uint8Array(raw).buffer);

    // Сводим в моно: вздох записан почти одинаково в оба уха, а звук в игре
    // всё равно позиционный — стерео там теряется.
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < length; i++) mono[i]! += data[i]! / decoded.numberOfChannels;
    }

    /**
     * Где сам выдох.
     *
     * Ищем окно нужной длины с наибольшей энергией — так находится громкая
     * часть, а не тишина перед ней. Считаем скользящей суммой: перебор всех
     * окон по отдельности для шести секунд был бы квадратичным.
     */
    const window = Math.min(length, Math.round(keep * decoded.sampleRate));
    let sum = 0;
    for (let i = 0; i < window; i++) sum += mono[i]! * mono[i]!;
    let best = sum;
    let at = 0;
    for (let i = window; i < length; i++) {
      sum += mono[i]! * mono[i]! - mono[i - window]! * mono[i - window]!;
      if (sum > best) {
        best = sum;
        at = i - window + 1;
      }
    }

    // Пересчёт частоты — линейной выборкой: дыхание широкополосно и ровно,
    // на нём разница между линейной выборкой и честным фильтром не слышна.
    const outLength = Math.round((window / decoded.sampleRate) * rate);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const source = at + (i / rate) * decoded.sampleRate;
      const left = Math.floor(source);
      const frac = source - left;
      const a = mono[Math.min(length - 1, left)]!;
      const b = mono[Math.min(length - 1, left + 1)]!;
      out[i] = a + (b - a) * frac;
    }

    // Края гасим: срез посреди дыхания щёлкает громче самого вздоха.
    const inSamples = Math.round(fadeIn * rate);
    const outSamples = Math.round(fadeOut * rate);
    for (let i = 0; i < inSamples; i++) out[i]! *= i / inSamples;
    for (let i = 0; i < outSamples; i++) {
      out[outLength - 1 - i]! *= i / outSamples;
    }

    let loudest = 0;
    for (const value of out) loudest = Math.max(loudest, Math.abs(value));
    const gain = loudest > 0 ? peak / loudest : 1;

    return [...out].map((value) => value * gain);
  },
  bytes,
  KEEP,
  RATE,
  FADE_IN,
  FADE_OUT,
  PEAK,
);

await browser.close();

/** WAV: заголовок на 44 байта и 16-битные отсчёты. */
function wav(samples: number[], rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    data.writeInt16LE(Math.round(clamped * 32767), index * 2);
  });

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

writeFileSync(OUTPUT, wav(track, RATE));

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} КБ`;
console.log(`исходник: ${kilobytes(statSync(SOURCE).size)}`);
console.log(
  `готово: ${OUTPUT} — ${(track.length / RATE).toFixed(2)} с, ${RATE} Гц моно,` +
    ` ${kilobytes(statSync(OUTPUT).size)}`,
);
