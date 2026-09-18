import * as THREE from 'three';
import { Effect } from 'postprocessing';

/**
 * «Строки по таблице»: седьмой вид старого телевизора, самый лёгкий.
 *
 * Перенос `GritsScanlines` torridgristle (Public Domain) из набора RetroArch.
 * Ни кривизны, ни маски, ни фильтров — только строки, и те **по таблице**:
 * яркость пикселя и фаза ряда выбирают множитель из картинки 4×4, где яркие
 * строки шире и светлее тёмных. Автор прикладывал таблицу PNG; здесь она
 * записана числами — шестнадцать значений, тянуть за ними файл незачем.
 * Разбор — docs/crt.md.
 *
 * Что изменено при переносе:
 *
 * - **Высота ряда — ручка `pixel`** (у автора проход растягивался вчетверо
 *   по вертикали, отсюда четыре по умолчанию).
 * - Яркость считается по обычной формуле (`0.299·R + 0.587·G + 0.114·B`) —
 *   у автора есть и вариант по своей таблице, и он выбирал его; разница
 *   на глаз в тонах, не в строках.
 * - Цветовая таблица «Sony Trinitron» у автора выключена — не переносилась.
 */

/*
------------------------------------------------------------------------------
GritsScanlines by torridgristle. license: public domain
(https://forums.libretro.com/t/lightweight-lut-based-scanline-glow-concept-prototype-glsl/18336/7)
------------------------------------------------------------------------------
*/

const FRAGMENT = /* glsl */ `
uniform float pixel;
uniform float opacity;

/*
 * Таблица автора (Scanline-LUT-4px.png), ряды — фаза внутри строки сверху
 * вниз, столбцы — яркость от тёмного к светлому. Выборка ближайшая, как
 * у автора (\`scanlines_LUT_linear = false\`).
 */
const mat4 TABLE = mat4(
  0.412, 1.000, 0.620, 0.157,
  0.608, 0.992, 0.761, 0.325,
  0.792, 0.992, 0.886, 0.541,
  0.961, 0.992, 0.953, 0.765);

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 org = max(inputColor.rgb, 0.0);
  float luminance = clamp(dot(org, vec3(0.299, 0.587, 0.114)), 0.0001, 0.9999);

  float rows = resolution.y / pixel;
  float phase = fract(uv.y * rows);
  int column = int(luminance * 4.0);
  int row = int(phase * 4.0);
  float screen = TABLE[column][row];

  outputColor = vec4((screen * opacity + (1.0 - opacity)) * org, inputColor.a);
}
`;

export interface GritsOptions {
  /** Высота строки в экранных пикселях. */
  pixel: number;
  /** Плотность строк, 0…1 — у автора 0.9. */
  opacity: number;
}

const DEFAULTS: GritsOptions = { pixel: 4, opacity: 0.9 };

export class GritsEffect extends Effect {
  constructor(options: Partial<GritsOptions> = {}) {
    const s = { ...DEFAULTS, ...options };
    super('GritsEffect', FRAGMENT, {
      uniforms: new Map<string, THREE.Uniform>([
        ['pixel', new THREE.Uniform(s.pixel)],
        ['opacity', new THREE.Uniform(s.opacity)],
      ]),
    });
  }
}
