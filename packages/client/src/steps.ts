import { isSafe } from '@grimhold/shared';
import type { Place, SoundApi, SoundId } from './sound.js';

/**
 * По чему ступают: под землёй и в городе — камень, в диких землях — трава.
 *
 * Считается из места, а не из земли под ногами: сама земля знает только вид
 * коробки, а коробка «пол» есть и в городе, и в таверне, и в подземелье.
 * Место отвечает на тот же вопрос одной строкой и без обхода геометрии.
 */
export function surfaceAt(x: number, z: number, underground: boolean): Surface {
  return underground || isSafe(x, z) ? 'stone' : 'grass';
}

/**
 * Шаги.
 *
 * Шаг звучит **по пройденному расстоянию**, а не по таймеру. Таймер отстукивает
 * одно и то же и у бегущего, и у крадущегося; расстояние само даёт темп:
 * побежал — шаги чаще, остановился — тишина.
 *
 * И длина шага — **от роста**. Это одно правило вместо таблицы на каждого:
 * огр ступает редко и тяжело, крыса семенит, и новый моб звучит по своему
 * размеру сам, без отдельной строки, которую забудут добавить.
 */

type Sound = Pick<SoundApi, 'play'>;

export type Surface = 'stone' | 'grass';

const STEP: Record<Surface, SoundId> = { stone: 'stepStone', grass: 'stepGrass' };

/** Длина шага в долях роста. */
const STRIDE_PER_HEIGHT = 0.8;
/** Медленнее этого не идут, а переминаются — шагов не слышно. */
const MOVING = 0.4;
/** Свои шаги тише чужих: они всегда под ухом и быстро надоедают. */
const OWN_GAIN = 0.55;

/**
 * Громкость чужого шага по росту: крыса едва слышна, огр топает.
 *
 * Потолок нужен, чтобы босс не заглушал удары, пределов снизу — чтобы
 * крысу всё-таки было слышно в тишине подземелья.
 */
function gainFor(height: number): number {
  return Math.min(1.4, Math.max(0.35, height / 1.8));
}

export interface Walker extends Place {
  id: string;
  speed: number;
  height: number;
}

export interface Steps {
  own(dt: number, speed: number, onGround: boolean, height: number, surface: Surface): void;
  others(dt: number, walkers: Iterable<Walker>, surface: Surface): void;
}

/**
 * Прибавляет пройденное и говорит, пора ли ступить.
 *
 * Не больше одного шага за кадр: после свёрнутой вкладки кадр бывает длинным,
 * и без этого все накопленные шаги прозвучали бы разом.
 */
function advance(travel: number, distance: number, stride: number): [number, boolean] {
  const next = travel + distance;
  return next >= stride ? [next % stride, true] : [next, false];
}

export function createSteps(sound: Sound): Steps {
  let ownTravel = 0;
  /** Сколько каждый прошёл с прошлого шага. Ушедших из снапшота забываем. */
  const travel = new Map<string, number>();
  const seen = new Set<string>();

  return {
    own(dt, speed, onGround, height, surface) {
      const stride = height * STRIDE_PER_HEIGHT;
      // Стоя и в прыжке не шагают. Первый шаг после остановки — через полшага:
      // тронулся — и почти сразу слышно, но не щелчком в ту же секунду.
      if (!onGround || speed < MOVING) {
        ownTravel = stride / 2;
        return;
      }
      const [next, step] = advance(ownTravel, speed * dt, stride);
      ownTravel = next;
      if (step) sound.play(STEP[surface], undefined, OWN_GAIN);
    },

    others(dt, walkers, surface) {
      seen.clear();
      for (const walker of walkers) {
        seen.add(walker.id);
        const stride = walker.height * STRIDE_PER_HEIGHT;
        if (walker.speed < MOVING) {
          travel.set(walker.id, stride / 2);
          continue;
        }
        const [next, step] = advance(travel.get(walker.id) ?? stride / 2, walker.speed * dt, stride);
        travel.set(walker.id, next);
        if (step) sound.play(STEP[surface], walker, gainFor(walker.height));
      }
      for (const id of travel.keys()) {
        if (!seen.has(id)) travel.delete(id);
      }
    },
  };
}
