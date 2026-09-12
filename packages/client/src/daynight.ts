import * as THREE from 'three';
import { sunHeight } from '@grimhold/shared';
import type { Sky } from './sky.js';

/**
 * Смена дня и ночи.
 *
 * Свет мира собран здесь целиком и меняется одним куском. Это главное:
 * «крутить солнце», оставив остальное на месте, нельзя — картинка разваливается
 * на несогласованные части. Цвет светила, заполняющий свет, туман и небо
 * обязаны идти вместе, поэтому они заданы **состояниями** (полночь, рассвет,
 * полдень, закат) и плавным переходом между ними, а не формулами по углу.
 *
 * Состояния проще подобрать на глаз, и в них невозможно случайно заехать
 * в серую кашу, чего с формулами не избежать.
 *
 * Время берётся из общих часов (`shared/src/daytime.ts`), то есть из номера
 * тика сервера: ночь наступает у всех одновременно.
 */

interface Palette {
  /** Момент суток, к которому относится состояние: 0 — полночь. */
  at: number;
  /** Светило: днём солнце, ночью луна. Светит всегда то, что видно. */
  sun: number;
  sunIntensity: number;
  /** Небо и земля заполняющего света. */
  skyLight: number;
  groundLight: number;
  fill: number;
  ambient: number;
  /** Цвет тумана и подкраска небесного купола — они обязаны совпадать. */
  haze: number;
  fogNear: number;
  fogFar: number;
}

/**
 * Сутки восемью состояниями.
 *
 * Ночь намеренно тёмная, но не чёрная: в полной темноте игра от первого лица
 * перестаёт читаться, а игрок тянется крутить гамму. Видно должно быть силуэты
 * и небо, а подробности — только при огне.
 */
const DAY: Palette[] = [
  {
    at: 0,
    sun: 0x6f86c4,
    sunIntensity: 0.32,
    skyLight: 0x2b3a5c,
    groundLight: 0x14161c,
    fill: 0.42,
    ambient: 0.07,
    haze: 0x141d30,
    fogNear: 18,
    fogFar: 85,
  },
  {
    at: 0.2,
    sun: 0x8a7fb0,
    sunIntensity: 0.45,
    skyLight: 0x44506e,
    groundLight: 0x211f21,
    fill: 0.72,
    ambient: 0.11,
    haze: 0x2b3145,
    fogNear: 22,
    fogFar: 100,
  },
  {
    at: 0.28,
    sun: 0xffa863,
    sunIntensity: 1.7,
    skyLight: 0x9db0cd,
    groundLight: 0x54402f,
    fill: 1.25,
    ambient: 0.18,
    haze: 0x6b6274,
    fogNear: 30,
    fogFar: 130,
  },
  {
    at: 0.38,
    sun: 0xffd6a4,
    sunIntensity: 2.3,
    skyLight: 0xbcd0e8,
    groundLight: 0x6b5f4c,
    fill: 1.6,
    ambient: 0.24,
    haze: 0x7f8aa0,
    fogNear: 40,
    fogFar: 155,
  },
  {
    at: 0.5,
    sun: 0xfff1d8,
    sunIntensity: 2.7,
    skyLight: 0xcadcf2,
    groundLight: 0x7a6e59,
    fill: 1.75,
    ambient: 0.28,
    haze: 0x93a0b4,
    fogNear: 48,
    fogFar: 175,
  },
  {
    at: 0.66,
    sun: 0xffd9a0,
    sunIntensity: 2.2,
    skyLight: 0xbcc9e0,
    groundLight: 0x6e6047,
    fill: 1.55,
    ambient: 0.24,
    haze: 0x84889a,
    fogNear: 42,
    fogFar: 160,
  },
  {
    at: 0.76,
    sun: 0xff7d45,
    sunIntensity: 1.5,
    skyLight: 0x8f7d96,
    groundLight: 0x4a3628,
    fill: 1.1,
    ambient: 0.16,
    haze: 0x6a4c52,
    fogNear: 28,
    fogFar: 120,
  },
  {
    at: 0.85,
    sun: 0x7d78b8,
    sunIntensity: 0.6,
    skyLight: 0x3c4866,
    groundLight: 0x1d1e24,
    fill: 0.6,
    ambient: 0.1,
    haze: 0x27304a,
    fogNear: 20,
    fogFar: 92,
  },
];

export interface DayNight {
  /** Куда и с какой силой светит светило — пригодится теням и факелам. */
  readonly sun: THREE.DirectionalLight;
  /** Светло ли сейчас снаружи: по этому фонари гаснут и зажигаются. */
  daylight: boolean;
  update(time: number, camera: THREE.Camera): void;
}

const scratch = new THREE.Color();
const other = new THREE.Color();

/** Сглаживание на концах: без него переход между состояниями видно изломом. */
function smooth(k: number): number {
  return k * k * (3 - 2 * k);
}

function mix(from: Palette, to: Palette, k: number): Palette {
  const lerp = (a: number, b: number): number => a + (b - a) * k;
  const lerpColor = (a: number, b: number): number =>
    scratch.setHex(a).lerp(other.setHex(b), k).getHex();

  return {
    at: 0,
    sun: lerpColor(from.sun, to.sun),
    sunIntensity: lerp(from.sunIntensity, to.sunIntensity),
    skyLight: lerpColor(from.skyLight, to.skyLight),
    groundLight: lerpColor(from.groundLight, to.groundLight),
    fill: lerp(from.fill, to.fill),
    ambient: lerp(from.ambient, to.ambient),
    haze: lerpColor(from.haze, to.haze),
    fogNear: lerp(from.fogNear, to.fogNear),
    fogFar: lerp(from.fogFar, to.fogFar),
  };
}

/** Состояние на данный момент суток. Список замкнут: после последнего — первый. */
export function paletteAt(time: number): Palette {
  for (let i = 0; i < DAY.length; i++) {
    const current = DAY[i]!;
    const next = DAY[(i + 1) % DAY.length]!;
    const start = current.at;
    const end = next.at > current.at ? next.at : next.at + 1;
    // Время до первого состояния принадлежит последнему отрезку, который
    // переваливает через полночь: сутки замкнуты, разрыва в них нет.
    const at = time < start ? time + 1 : time;
    if (at >= start && at < end) return mix(current, next, smooth((at - start) / (end - start)));
  }
  return mix(DAY[0]!, DAY[0]!, 0);
}

/** Насколько далеко от игрока светило: карта теней строится вокруг него. */
const SUN_DISTANCE = 60;

export function createDayNight(scene: THREE.Scene, sky: Sky): DayNight {
  const hemisphere = new THREE.HemisphereLight(0xbcd0e8, 0x6b5f4c, 1.6);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffd9a0, 2.2);
  /**
   * Тени.
   *
   * Карта нарочно небольшая и **тесная**: она ездит за игроком, и чем уже
   * охват, тем больше пикселей достаётся тому, что рядом. Сто метров при
   * 2048 давали и мыло, и лишний расход разом; тридцать при 1024 выглядят
   * лучше и стоят вчетверо дешевле.
   */
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 130;
  sun.shadow.camera.left = -32;
  sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  const fog = new THREE.Fog(0x5a6b82, 40, 150);
  scene.fog = fog;
  scene.background = new THREE.Color(0x5a6b82);

  const haze = new THREE.Color();

  const api: DayNight = {
    sun,
    daylight: true,

    update(time, camera) {
      const palette = paletteAt(time);
      haze.setHex(palette.haze);

      hemisphere.color.setHex(palette.skyLight);
      hemisphere.groundColor.setHex(palette.groundLight);
      hemisphere.intensity = palette.fill;
      ambient.intensity = palette.ambient;

      fog.color.copy(haze);
      fog.near = palette.fogNear;
      fog.far = palette.fogFar;
      // Цвет неба у горизонта и цвет тумана обязаны совпадать: иначе на
      // горизонте видно черту, где туман кончается, а небо начинается.
      (scene.background as THREE.Color).copy(haze);

      /**
       * Светит то, что видно: днём солнце, ночью луна с той же дуги, но
       * с обратной стороны. Отдельной лампы под луну нет намеренно — вторая
       * лампа с тенями стоит как первая, а разницы на экране нет.
       */
      const height = sunHeight(time);
      const above = Math.abs(height);
      const angle = (height >= 0 ? time : time + 0.5) * Math.PI * 2;

      sun.position.set(
        Math.cos(angle) * SUN_DISTANCE * 0.9,
        // Светило не ложится вплотную к горизонту: у самого края тени
        // растягиваются через всю карту и вылезают за её пределы.
        (0.18 + above * 0.82) * SUN_DISTANCE,
        Math.sin(angle) * SUN_DISTANCE * 0.7,
      );
      sun.color.setHex(palette.sun);
      sun.intensity = palette.sunIntensity;
      // castShadow не трогаем ни при каких обстоятельствах: смена этого флага
      // меняет шейдеры, и все материалы сцены компилируются заново — на закате
      // это был фриз на полсекунды. Ночью тени и так почти не видно: светило
      // слабое, и они растворяются сами.

      // Карту теней возим за игроком: она покрывает сотню метров, а мир больше.
      sun.target.position.copy(camera.position);
      sun.position.add(camera.position);

      api.daylight = height > 0;
      sky.update(time, haze, camera);
    },
  };

  return api;
}
