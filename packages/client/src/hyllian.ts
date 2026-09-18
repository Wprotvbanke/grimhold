import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * «Монитор Хиллиана»: шестой вид старого телевизора.
 *
 * Перенос `crt-hyllian` Хиллиана (MIT) из сборки для DOSBox. В отличие от
 * остальных — **без кривизны**: это не телевизор, а хороший монитор. Кадр
 * собирается из эмулируемых пикселей кубическим фильтром по горизонтали
 * (с гашением звона), каждый ряд рисуется лучом, ширина которого растёт
 * с яркостью, поверх — люминофорная маска столбцами и подъём цвета.
 * Разбор — docs/crt.md.
 *
 * Что изменено при переносе:
 *
 * - **Эмулируемое разрешение — ручка `pixel`**, как у Лоттеса.
 * - **Гамма на входе и выходе убрана**: автор возводит экранный кадр в 2.4
 *   и возвращает в 2.2; у нас свет линейный, кодирует его сам проход.
 * - `strength` — наша общая сила эффекта.
 */

/*
------------------------------------------------------------------------------
Hyllian's CRT Shader. Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com
MIT License. Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom
the Software is furnished to do so, subject to the following conditions: The
above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
"AS IS", WITHOUT WARRANTY OF ANY KIND.
------------------------------------------------------------------------------
*/

const FRAGMENT = /* glsl */ `
uniform float pixel;
uniform float strength;
uniform float phosphor;
uniform float sharpness;
uniform float colorBoost;
uniform float scanlinesStrength;
uniform float beamMinWidth;
uniform float beamMaxWidth;
uniform float antiRinging;

/* Кубический фильтр по горизонтали: B = 0, C = 0.5 (Катмулл-Ром). */
const float B = 0.0;
const float C = 0.5;
const mat4 invX = mat4(
  (-B - 6.0 * C) / 6.0, (12.0 - 9.0 * B - 6.0 * C) / 6.0, -(12.0 - 9.0 * B - 6.0 * C) / 6.0, (B + 6.0 * C) / 6.0,
  (3.0 * B + 12.0 * C) / 6.0, (-18.0 + 12.0 * B + 6.0 * C) / 6.0, (18.0 - 15.0 * B - 12.0 * C) / 6.0, -C,
  (-3.0 * B - 6.0 * C) / 6.0, 0.0, (3.0 * B + 6.0 * C) / 6.0, 0.0,
  B / 6.0, (6.0 - 2.0 * B) / 6.0, B / 6.0, 0.0);

vec4 tex(vec2 c) {
  return max(texture2D(inputBuffer, c), 0.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 source = resolution / pixel;
  vec2 textureSize = vec2(sharpness * source.x, source.y);
  vec2 fragCoord = uv * resolution;

  vec2 dx = vec2(1.0 / textureSize.x, 0.0);
  vec2 dy = vec2(0.0, 1.0 / textureSize.y);

  vec2 pixCoord = uv * textureSize + vec2(-0.5, 0.5);
  vec2 tc = (floor(pixCoord) + vec2(0.5, 0.5)) / textureSize;
  vec2 fp = fract(pixCoord);

  vec4 c00 = tex(tc - dx - dy);
  vec4 c01 = tex(tc - dy);
  vec4 c02 = tex(tc + dx - dy);
  vec4 c03 = tex(tc + 2.0 * dx - dy);
  vec4 c10 = tex(tc - dx);
  vec4 c11 = tex(tc);
  vec4 c12 = tex(tc + dx);
  vec4 c13 = tex(tc + 2.0 * dx);

  vec4 minSample = min(min(c01, c11), min(c02, c12));
  vec4 maxSample = max(max(c01, c11), max(c02, c12));

  vec4 lobes = vec4(fp.x * fp.x * fp.x, fp.x * fp.x, fp.x, 1.0);
  vec4 invXPx = invX * lobes;
  vec4 color0 = mat4(c00, c01, c02, c03) * invXPx;
  vec4 color1 = mat4(c10, c11, c12, c13) * invXPx;

  // Гашение звона: не выходить за пределы соседей.
  vec4 aux = color0;
  color0 = mix(aux, clamp(color0, minSample, maxSample), antiRinging);
  aux = color1;
  color1 = mix(aux, clamp(color1, minSample, maxSample), antiRinging);

  // Луч: чем ярче, тем шире строка.
  float pos0 = fp.y;
  float pos1 = 1.0 - fp.y;
  vec4 lum0 = mix(vec4(beamMinWidth), vec4(beamMaxWidth), color0);
  vec4 lum1 = mix(vec4(beamMinWidth), vec4(beamMaxWidth), color1);
  vec4 d0 = clamp(pos0 / (lum0 + 0.0000001), 0.0, 1.0);
  vec4 d1 = clamp(pos1 / (lum1 + 0.0000001), 0.0, 1.0);
  d0 = exp(-10.0 * scanlinesStrength * d0 * d0);
  d1 = exp(-10.0 * scanlinesStrength * d1 * d1);

  vec4 color = clamp(color0 * d0 + color1 * d1, 0.0, 1.0);
  color *= colorBoost;

  // Люминофор: столбцы попеременно зелёные и пурпурные.
  vec4 mask = mix(vec4(1.0, 0.7, 1.0, 1.0), vec4(0.7, 1.0, 0.7, 1.0), floor(mod(fragCoord.x, 2.0)));
  color *= mix(vec4(1.0), mask, phosphor);

  vec3 plain = tex(uv).rgb;
  outputColor = vec4(mix(plain, color.rgb, strength), inputColor.a);
}
`;

export interface HyllianOptions {
  /** Размер эмулируемого пикселя в экранных пикселях. */
  pixel: number;
  /** Общая сила эффекта, 0…1. */
  strength: number;
  /** Люминофорная маска: 0 или 1. */
  phosphor: number;
  /** Резкость по горизонтали, 1…5 (целое). */
  sharpness: number;
  /** Подъём цвета, 1…2. */
  colorBoost: number;
  /** Сила строк, 0…1. */
  scanlinesStrength: number;
  /** Ширина луча в темноте и на свету, 0…1. */
  beamMinWidth: number;
  beamMaxWidth: number;
  /** Гашение звона фильтра, 0…1. */
  antiRinging: number;
}

const DEFAULTS: HyllianOptions = {
  pixel: 3,
  strength: 0.8,
  phosphor: 1,
  sharpness: 1,
  colorBoost: 1.5,
  scanlinesStrength: 0.72,
  beamMinWidth: 0.86,
  beamMaxWidth: 1,
  antiRinging: 0.8,
};

export class HyllianEffect extends Effect {
  constructor(options: Partial<HyllianOptions> = {}) {
    const s = { ...DEFAULTS, ...options };
    super('HyllianEffect', FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['pixel', new THREE.Uniform(s.pixel)],
        ['strength', new THREE.Uniform(s.strength)],
        ['phosphor', new THREE.Uniform(s.phosphor)],
        ['sharpness', new THREE.Uniform(s.sharpness)],
        ['colorBoost', new THREE.Uniform(s.colorBoost)],
        ['scanlinesStrength', new THREE.Uniform(s.scanlinesStrength)],
        ['beamMinWidth', new THREE.Uniform(s.beamMinWidth)],
        ['beamMaxWidth', new THREE.Uniform(s.beamMaxWidth)],
        ['antiRinging', new THREE.Uniform(s.antiRinging)],
      ]),
    });
  }
}
