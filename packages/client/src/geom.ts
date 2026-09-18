import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * «Геометрия»: реплика crt-geom — пятый вид старого телевизора.
 *
 * Сам crt-geom под GPL и нам закрыт; это его **реплика от DariusG под MIT**
 * (`crt-geom-mini` из набора RetroArch), и по виду она — то, что владелец
 * хотел с самого начала: выпуклый экран со скруглёнными углами, строки
 * с гауссовым профилем, ширина которых зависит от яркости, и точечная маска
 * зелёный/пурпурный по столбцам. Разбор — docs/crt.md.
 *
 * Что изменено при переносе:
 *
 * - **Эмулируемое разрешение — ручка `pixel`**, как у Лоттеса: у автора
 *   источник низкий сам по себе, у нас кадр в полный экран.
 * - **`sqrt` на выходе убран.** Автор читает экранный (sRGB) кадр, смешивает
 *   и извлекает корень — грубая гамма. У нас свет линейный, кодирует его сам
 *   проход; оставь корень — картинка выгорит.
 * - **Чересстрочность выключена по умолчанию** (у автора включена): она
 *   мигает рядами через кадр, и в игре от первого лица это режет глаза.
 *   Ручка `interlace` есть, и при `prefers-reduced-motion` она не работает.
 * - `strength` — наша общая сила эффекта, как у Лоттеса.
 */

/*
------------------------------------------------------------------------------
CRT-Geom replica by DariusG 2024-2026. MIT License.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: The above copyright
notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
------------------------------------------------------------------------------
*/

const FRAGMENT = /* glsl */ `
uniform float pixel;
uniform float strength;
uniform float curvature;
uniform float curveAmount;
uniform float cornersize;
uniform float dotMask;
uniform float scanlineWeight;
uniform float interlace;
uniform float frame;
uniform float motion;

vec2 simpleWarp(vec2 pos) {
  pos = pos * 2.0 - 1.0;
  pos *= vec2(1.0 + (pos.y * pos.y) * (curveAmount * 0.2), 1.0 + (pos.x * pos.x) * (curveAmount * 0.3));
  return pos * 0.5 + 0.5;
}

/* Профиль луча: чем ярче, тем шире строка. */
vec4 scanlineWeights(float distance, vec4 color) {
  float wid = 0.3 + 0.1 * dot(color.rgb, vec3(0.3, 0.6, 0.1));
  float w = distance / wid;
  return vec4((0.1 + scanlineWeight) * exp(-w * w) / wid);
}

vec4 tex(vec2 c) {
  return max(texture2D(inputBuffer, c), 0.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 texSize = resolution / pixel;
  vec2 fragCoord = uv * resolution;

  vec2 vpos = uv * 1.0001;
  vec2 xy = (curvature > 0.5) ? simpleWarp(vpos) : vpos;
  vec2 warped = xy;

  // Скруглённые углы: гипербола от расстояния до краёв.
  vec2 corn = min(xy, 1.0 - xy);
  if (curvature > 0.5) corn.x = (cornersize * 0.001) / corn.x;

  if (xy.y < 0.0 || xy.y > 1.0 || xy.x < 0.0 || xy.x > 1.0) {
    outputColor = vec4(0.0, 0.0, 0.0, inputColor.a);
    return;
  }

  // Чересстрочность: ряды через кадр, только когда рядов больше двухсот.
  vec2 ilfac = vec2(1.0, (interlace * motion > 0.5) ? clamp(floor(texSize.y / 200.0), 1.0, 2.0) : 1.0);
  vec2 ilvec = vec2(0.0, (ilfac.y > 1.5) ? mod(frame, 2.0) : 0.0);
  vec2 one = ilfac / texSize;

  vec2 ratio = (xy * texSize - vec2(0.5) + ilvec) / ilfac;
  vec2 uvRatio = fract(ratio);
  xy = (floor(ratio) * ilfac + vec2(0.5) - ilvec) / texSize;

  // Катмулл-Ром по горизонтали.
  float FF = uvRatio.x * uvRatio.x;
  vec4 lobes = vec4(FF * uvRatio.x, FF, uvRatio.x, 1.0);
  vec4 InvX;
  InvX.x = dot(vec4(-0.5, 1.0, -0.5, 0.0), lobes);
  InvX.y = dot(vec4(1.5, -2.5, 0.0, 1.0), lobes);
  InvX.z = dot(vec4(-1.5, 2.0, 0.5, 0.0), lobes);
  InvX.w = dot(vec4(0.5, -0.5, 0.0, 0.0), lobes);

  vec4 col = mat4(
    tex(xy + vec2(-one.x, 0.0)),
    tex(xy),
    tex(xy + vec2(one.x, 0.0)),
    tex(xy + vec2(2.0 * one.x, 0.0))) * InvX;
  vec4 col2 = mat4(
    tex(xy + vec2(-one.x, one.y)),
    tex(xy + vec2(0.0, one.y)),
    tex(xy + one),
    tex(xy + vec2(2.0 * one.x, one.y))) * InvX;

  vec4 weights = scanlineWeights(uvRatio.y, col);
  vec4 weights2 = scanlineWeights(1.0 - uvRatio.y, col2);
  vec3 res = (col * weights + col2 * weights2).rgb;

  // Точечная маска: столбцы попеременно зелёные и пурпурные.
  vec3 mask = mix(vec3(1.0, 1.0 - dotMask, 1.0), vec3(1.0 - dotMask, 1.0, 1.0 - dotMask), floor(mod(fragCoord.x, 2.0)));
  res *= mask;

  vec3 plain = tex(warped).rgb;
  res = mix(plain, res, strength);

  if ((curvature > 0.5 && corn.y <= corn.x) || corn.x < 0.00001) res = vec3(0.0);
  outputColor = vec4(res, inputColor.a);
}
`;

export interface GeomOptions {
  /** Размер эмулируемого пикселя в экранных пикселях. */
  pixel: number;
  /** Общая сила эффекта, 0…1. */
  strength: number;
  /** Кривизна: включена ли и сколько (0…0.5). */
  curvature: number;
  curveAmount: number;
  /** Размер скруглённого угла, 0.005…0.3. */
  cornersize: number;
  /** Сила точечной маски, 0…1. */
  dotMask: number;
  /** Вес строк, 0.1…0.5. */
  scanlineWeight: number;
  /** Чересстрочность: 0 или 1. У автора 1, у нас 0 — мигает. */
  interlace: number;
}

const DEFAULTS: GeomOptions = {
  pixel: 3,
  strength: 0.8,
  curvature: 1,
  curveAmount: 0.15,
  cornersize: 0.05,
  dotMask: 0.3,
  scanlineWeight: 0.3,
  interlace: 0,
};

export class GeomEffect extends Effect {
  constructor(options: Partial<GeomOptions> = {}) {
    const s = { ...DEFAULTS, ...options };
    const still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    super('GeomEffect', FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['pixel', new THREE.Uniform(s.pixel)],
        ['strength', new THREE.Uniform(s.strength)],
        ['curvature', new THREE.Uniform(s.curvature)],
        ['curveAmount', new THREE.Uniform(s.curveAmount)],
        ['cornersize', new THREE.Uniform(s.cornersize)],
        ['dotMask', new THREE.Uniform(s.dotMask)],
        ['scanlineWeight', new THREE.Uniform(s.scanlineWeight)],
        ['interlace', new THREE.Uniform(s.interlace)],
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
