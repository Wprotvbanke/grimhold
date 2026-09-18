import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * «Лоттес без муара»: третий вид старого телевизора.
 *
 * Перенос `moire-resolve` хантерка из набора RetroArch (Public Domain, по
 * работам Тимоти Лоттеса). Это не заплатка поверх другого шейдера, а свой
 * экран: кривизна и теневая маска как у Лоттеса, но вместо строк луча —
 * **дрожание точки выборки** на долю пикселя каждый кадр. Тонкая решётка
 * маски на высоком разрешении даёт муар; когда точка выборки чуть гуляет,
 * муар усредняется во времени и глазом не читается. Разбор — docs/crt.md.
 *
 * Что изменено при переносе и почему:
 *
 * - **Считаем в пикселях, а не в долях экрана.** В файле RetroArch узор
 *   4×MSAA (`Quad4`, сдвиги на ±0.25) и дрожание применяются к координате
 *   0…1 — в четверть экрана, — а результат зажимается в 0…1 функцией,
 *   которая у Лоттеса дизерила **цвет**. Это перепутано: у автора всё это
 *   считалось в пикселях. Берём замысел: сдвиги в долях пикселя.
 * - **Усреднение 21 положения выборки убрано.** Оно усредняло не цвет, а
 *   координаты, и при симметричном наборе даёт почти ту же точку — только
 *   гасит дрожание. Оставлено само дрожание с силой `mitigation`.
 * - **Строки** у автора выключены по умолчанию и рассчитаны на источник
 *   ниже экрана (при 1:1 они гасили бы весь кадр). Здесь они идут по
 *   виртуальным рядам высотой `thickness` и тоже выключены.
 * - Перевод в гамму и обратно убран: внутри прохода свет линейный.
 */

/*
------------------------------------------------------------------------------
Moire compensation by hunterk, based on work from Timothy Lottes
(https://www.shadertoy.com/view/4dfyWj, https://www.shadertoy.com/view/MtSfRK).
license: public domain
------------------------------------------------------------------------------
*/

const FRAGMENT = /* glsl */ `
uniform float mitigation;
uniform vec2 curveAmount;
uniform float maskDark;
uniform float maskLight;
uniform float shadowMask;
uniform float thickness;
uniform float darkness;
uniform float scanlines;
uniform float frame;
uniform float motion;

/* Шум, чуть подправленный из https://www.shadertoy.com/view/4djSRW. */
float Noise(vec2 p, float x) {
  p += x;
  vec3 p3 = fract(vec3(p.xyx) * 10.1031);
  p3 += dot(p3, p3.yzx + 19.19);
  return (fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0) / pow(2.0, 11.0 - mitigation);
}

/* Узор 4×MSAA по целым координатам пикселя. */
vec2 Quad4(vec2 pp) {
  int q = (int(pp.x) & 1) + ((int(pp.y) & 1) << 1);
  if (q == 0) return pp + vec2(0.25, -0.25);
  if (q == 1) return pp + vec2(0.25, 0.25);
  if (q == 2) return pp + vec2(-0.25, -0.25);
  return pp + vec2(-0.25, 0.25);
}

vec2 Rot(float r, float a) {
  return vec2(r * cos(a * 3.14159), r * sin(a * 3.14159));
}

/* Дрожащее положение выборки: узор плюс случайный сдвиг в круге. */
vec2 Jit(vec2 pp, float t) {
  pp = Quad4(pp);
  float n = Noise(pp, fract(t));
  float m = Noise(pp, fract(t * 0.333)) * 0.5 + 0.5;
  m = sqrt(m) / 4.0;
  return pp + Rot(0.707 * 0.5 * m, n);
}

vec2 Warp(vec2 pos) {
  pos = pos * 2.0 - 1.0;
  pos *= vec2(1.0 + (pos.y * pos.y) * curveAmount.x, 1.0 + (pos.x * pos.x) * curveAmount.y);
  return pos * 0.5 + 0.5;
}

/* Теневая маска Лоттеса: 1 телевизор, 2 решётка, 3 и 4 VGA. */
vec3 Mask(vec2 pos) {
  vec3 mask = vec3(maskDark);
  if (shadowMask == 1.0) {
    float line = maskLight;
    float odd = 0.0;
    if (fract(pos.x * 0.166666666) < 0.5) odd = 1.0;
    if (fract((pos.y + odd) * 0.5) < 0.5) line = maskDark;
    pos.x = fract(pos.x * 0.333333333);
    if (pos.x < 0.333) mask.r = maskLight;
    else if (pos.x < 0.666) mask.g = maskLight;
    else mask.b = maskLight;
    mask *= line;
  } else if (shadowMask == 2.0) {
    pos.x = fract(pos.x * 0.333333333);
    if (pos.x < 0.333) mask.r = maskLight;
    else if (pos.x < 0.666) mask.g = maskLight;
    else mask.b = maskLight;
  } else if (shadowMask == 3.0) {
    pos.x += pos.y * 3.0;
    pos.x = fract(pos.x * 0.166666666);
    if (pos.x < 0.333) mask.r = maskLight;
    else if (pos.x < 0.666) mask.g = maskLight;
    else mask.b = maskLight;
  } else if (shadowMask == 4.0) {
    pos.xy = floor(pos.xy * vec2(1.0, 0.5));
    pos.x += pos.y * 3.0;
    pos.x = fract(pos.x * 0.166666666);
    if (pos.x < 0.333) mask.r = maskLight;
    else if (pos.x < 0.666) mask.g = maskLight;
    else mask.b = maskLight;
  }
  return mask;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Время автора: секунды по кадрам, кольцом в десять минут. Стоит при
  // prefers-reduced-motion — тогда дрожание превращается в постоянный узор.
  float t = mod(frame * motion / 60.0, 600.0);

  vec2 fragCoord = uv * resolution;
  vec2 pp = Jit(fragCoord, t) / resolution;
  vec2 cc = Warp(pp);

  vec3 col = max(texture2D(inputBuffer, cc).rgb, 0.0);

  if (scanlines > 0.5 && mod(fragCoord.y, thickness * 2.0) < thickness) col *= 1.0 - darkness;
  if (shadowMask > 0.0) col *= Mask(cc * resolution * 1.000001);

  // За выгнутым краем — чёрное.
  if (cc.x <= 0.0001 || cc.x >= 0.9999 || cc.y <= 0.0001 || cc.y >= 0.9999) col = vec3(0.0);

  outputColor = vec4(col, inputColor.a);
}
`;

/** Ручки автора с его значениями по умолчанию. */
export interface MoireOptions {
  /** Сила дрожания, 1…10: чем больше, тем дальше гуляет точка выборки. */
  mitigation: number;
  /** Кривизна по осям. */
  warp: [number, number];
  maskDark: number;
  maskLight: number;
  /** Вид маски: 0 нет, 1 телевизор, 2 решётка, 3 и 4 VGA. */
  shadowMask: number;
  /** Строки: высота ряда в пикселях и насколько тёмный ряд гасится. */
  thickness: number;
  darkness: number;
  /** Строки выключены у автора по умолчанию. */
  scanlines: number;
}

const DEFAULTS: MoireOptions = {
  mitigation: 4,
  warp: [0.031, 0.041],
  maskDark: 0.5,
  maskLight: 1.5,
  shadowMask: 3,
  thickness: 2,
  darkness: 0.35,
  scanlines: 0,
};

export class MoireEffect extends Effect {
  constructor(options: Partial<MoireOptions> = {}) {
    const s = { ...DEFAULTS, ...options };
    const still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    super('MoireEffect', FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['mitigation', new THREE.Uniform(s.mitigation)],
        ['curveAmount', new THREE.Uniform(new THREE.Vector2(s.warp[0], s.warp[1]))],
        ['maskDark', new THREE.Uniform(s.maskDark)],
        ['maskLight', new THREE.Uniform(s.maskLight)],
        ['shadowMask', new THREE.Uniform(s.shadowMask)],
        ['thickness', new THREE.Uniform(s.thickness)],
        ['darkness', new THREE.Uniform(s.darkness)],
        ['scanlines', new THREE.Uniform(s.scanlines)],
        ['frame', new THREE.Uniform(0)],
        ['motion', new THREE.Uniform(still ? 0 : 1)],
      ]),
    });
  }

  override update(): void {
    const frame = this.uniforms.get('frame')!;
    frame.value = (frame.value as number) + 1;
  }
}
