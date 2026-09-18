import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * Кинескоп по Лоттесу: второй вид «старого телевизора».
 *
 * Перенос шейдера Тимоти Лоттеса «CRT styled scan-line shader» — автор
 * выпустил его в Public Domain («Please take and use, change, or whatever»).
 * Взят из сборки для DOSBox (`tyrells/dosbox-svn-shaders`, `crt/crt-lottes.glsl`);
 * разбор и сравнение с newpixie — docs/crt.md.
 *
 * Чем отличается от newpixie. Тот — «телевизор с помехами»: кривизна,
 * разведение цветов, шум, мерцание, бегущие строки. Этот — «хороший
 * аркадный монитор»: картинка сперва собирается из **крупных пикселей**
 * (эмулируемое низкое разрешение), затем каждый ряд пикселей рисуется как
 * строка луча с гауссовым профилем, поверх — теневая маска и мягкое
 * свечение. Ничего не дрожит и не шумит.
 *
 * Про «пиксели». Шейдер писался для эмуляторов, где источник — 320×240,
 * и строки идут по рядам источника. У нас источник в полный экран, и строк
 * вышло бы столько, что они слились бы в серость. Поэтому эмулируемое
 * разрешение задаётся ручкой `pixel` — размером одного «пикселя» в экранных
 * пикселях, — и все отсчёты берутся из середин этих клеток.
 *
 * Про цвет. Оригинал переводит sRGB в линейный на входе и обратно на выходе;
 * внутри `EffectPass` свет уже линейный, а кодирует его сам проход — обе
 * ступени убраны. За краями кадра — чёрное, как и у автора.
 */

/*
------------------------------------------------------------------------------
PUBLIC DOMAIN CRT STYLED SCAN-LINE SHADER by Timothy Lottes.
"It is an example what I personally would want as a display option for pixel
art games. Please take and use, change, or whatever."
------------------------------------------------------------------------------
*/

/**
 * Общая часть шейдера Лоттеса: ручки и функции без \`main\`.
 *
 * Вынесена, потому что многопроходный вид (lottes-multi.ts) считает свечение
 * тем же кодом, но отдельным проходом в свой буфер. Здесь нет объявлений
 * \`inputBuffer\` и \`resolution\`: внутри \`EffectPass\` их даёт библиотека, а свой
 * материал объявляет их сам.
 */
export const LOTTES_COMMON = /* glsl */ `
uniform float pixel;
uniform float strength;
uniform float hardScan;
uniform float hardPix;
/*
 * Не \`warp\`: библиотека, склеивая эффекты, даёт uniform и функции одинаковую
 * приставку без учёта регистра, и \`warp\` с \`Warp\` становились одним именем.
 */
uniform vec2 curveAmount;
uniform float maskDark;
uniform float maskLight;
uniform float shadowMask;
uniform float brightBoost;
uniform float hardBloomPix;
uniform float hardBloomScan;
uniform float bloomAmount;
uniform float shape;

/* Эмулируемое разрешение: экран, порезанный на клетки по \`pixel\`. */
vec2 sourceSize() {
  return resolution / pixel;
}

/* Ближайший эмулируемый пиксель со сдвигом на клетки. За краем — чёрное. */
vec3 Fetch(vec2 pos, vec2 off) {
  vec2 size = sourceSize();
  pos = (floor(pos * size + off) + vec2(0.5)) / size;
  if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) return vec3(0.0);
  return brightBoost * max(texture2D(inputBuffer, pos).rgb, 0.0);
}

/* Расстояние в эмулируемых пикселях до ближайшей клетки. */
vec2 Dist(vec2 pos) {
  pos = pos * sourceSize();
  return -((pos - floor(pos)) - vec2(0.5));
}

float Gaus(float pos, float scale) {
  return exp2(scale * pow(abs(pos), shape));
}

vec3 Horz3(vec2 pos, float off) {
  vec3 b = Fetch(pos, vec2(-1.0, off));
  vec3 c = Fetch(pos, vec2(0.0, off));
  vec3 d = Fetch(pos, vec2(1.0, off));
  float dst = Dist(pos).x;
  float wb = Gaus(dst - 1.0, hardPix);
  float wc = Gaus(dst, hardPix);
  float wd = Gaus(dst + 1.0, hardPix);
  return (b * wb + c * wc + d * wd) / (wb + wc + wd);
}

vec3 Horz5(vec2 pos, float off) {
  vec3 a = Fetch(pos, vec2(-2.0, off));
  vec3 b = Fetch(pos, vec2(-1.0, off));
  vec3 c = Fetch(pos, vec2(0.0, off));
  vec3 d = Fetch(pos, vec2(1.0, off));
  vec3 e = Fetch(pos, vec2(2.0, off));
  float dst = Dist(pos).x;
  float wa = Gaus(dst - 2.0, hardPix);
  float wb = Gaus(dst - 1.0, hardPix);
  float wc = Gaus(dst, hardPix);
  float wd = Gaus(dst + 1.0, hardPix);
  float we = Gaus(dst + 2.0, hardPix);
  return (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);
}

vec3 Horz7(vec2 pos, float off) {
  vec3 a = Fetch(pos, vec2(-3.0, off));
  vec3 b = Fetch(pos, vec2(-2.0, off));
  vec3 c = Fetch(pos, vec2(-1.0, off));
  vec3 d = Fetch(pos, vec2(0.0, off));
  vec3 e = Fetch(pos, vec2(1.0, off));
  vec3 f = Fetch(pos, vec2(2.0, off));
  vec3 g = Fetch(pos, vec2(3.0, off));
  float dst = Dist(pos).x;
  float wa = Gaus(dst - 3.0, hardBloomPix);
  float wb = Gaus(dst - 2.0, hardBloomPix);
  float wc = Gaus(dst - 1.0, hardBloomPix);
  float wd = Gaus(dst, hardBloomPix);
  float we = Gaus(dst + 1.0, hardBloomPix);
  float wf = Gaus(dst + 2.0, hardBloomPix);
  float wg = Gaus(dst + 3.0, hardBloomPix);
  return (a * wa + b * wb + c * wc + d * wd + e * we + f * wf + g * wg)
    / (wa + wb + wc + wd + we + wf + wg);
}

/* Вес строки луча для текущей точки. */
float Scan(vec2 pos, float off) {
  return Gaus(Dist(pos).y + off, hardScan);
}

float BloomScan(vec2 pos, float off) {
  return Gaus(Dist(pos).y + off, hardBloomScan);
}

/* Три ближайшие строки складываются в точку. */
vec3 Tri(vec2 pos) {
  vec3 a = Horz3(pos, -1.0);
  vec3 b = Horz5(pos, 0.0);
  vec3 c = Horz3(pos, 1.0);
  return a * Scan(pos, -1.0) + b * Scan(pos, 0.0) + c * Scan(pos, 1.0);
}

/* Мягкое свечение вокруг ярких строк. */
vec3 Bloom(vec2 pos) {
  vec3 a = Horz5(pos, -2.0);
  vec3 b = Horz7(pos, -1.0);
  vec3 c = Horz7(pos, 0.0);
  vec3 d = Horz7(pos, 1.0);
  vec3 e = Horz5(pos, 2.0);
  return a * BloomScan(pos, -2.0) + b * BloomScan(pos, -1.0) + c * BloomScan(pos, 0.0)
    + d * BloomScan(pos, 1.0) + e * BloomScan(pos, 2.0);
}

/* Кривизна экрана. */
vec2 Warp(vec2 pos) {
  pos = pos * 2.0 - 1.0;
  // Кривизна тоже слабеет вместе с общей силой эффекта.
  vec2 amount = curveAmount * strength;
  pos *= vec2(1.0 + (pos.y * pos.y) * amount.x, 1.0 + (pos.x * pos.x) * amount.y);
  return pos * 0.5 + 0.5;
}

/* Теневая маска: вид выбирает \`shadowMask\` — 1 телевизор, 2 решётка, 3 и 4 VGA. */
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
`;

const FRAGMENT = /* glsl */ `
${LOTTES_COMMON}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 pos = Warp(uv);
  vec3 col = Tri(pos) + Bloom(pos) * bloomAmount;

  if (shadowMask > 0.0) col *= Mask(uv * resolution * 1.000001);

  /*
   * Общая сила эффекта: пиксели, строки, маска и свечение подмешиваются
   * к чистому кадру. Чистый кадр берётся **в той же выгнутой точке** —
   * смешай его с прямым, и по краям проступит второй, ровный контур.
   */
  vec3 plain = max(texture2D(inputBuffer, pos).rgb, 0.0);
  col = mix(plain, col, strength);

  // За выгнутым краем экрана — чёрное.
  if (pos.x <= 0.0001 || pos.x >= 0.9999 || pos.y <= 0.0001 || pos.y >= 0.9999) col = vec3(0.0);

  outputColor = vec4(col, inputColor.a);
}
`;

/** Ручки автора с его же значениями по умолчанию, плюс наш размер пикселя. */
export interface LottesOptions {
  /** Размер эмулируемого пикселя в экранных пикселях. Наша ручка, у автора источник и так низкий. */
  pixel: number;
  /**
   * Общая сила эффекта, 0…1. Наша ручка: 1 — как у автора, 0 — чистый кадр.
   * Владелец попросил ослабить всё на пятую часть — отсюда 0.8.
   */
  strength: number;
  /** Резкость строк: −8 мягко … −20 жёстко. */
  hardScan: number;
  /** Резкость пикселей по горизонтали. */
  hardPix: number;
  /** Кривизна по осям. */
  warp: [number, number];
  /** Тёмная и светлая ячейки маски. */
  maskDark: number;
  maskLight: number;
  /** Вид маски: 0 нет, 1 телевизор, 2 решётка, 3 и 4 VGA. */
  shadowMask: number;
  brightBoost: number;
  hardBloomPix: number;
  hardBloomScan: number;
  bloomAmount: number;
  /** Форма профиля луча: 2 — гаусс. */
  shape: number;
}

export const LOTTES_DEFAULTS: LottesOptions = {
  pixel: 3,
  strength: 0.8,
  hardScan: -8,
  hardPix: -3,
  warp: [0.031, 0.041],
  maskDark: 0.5,
  maskLight: 1.5,
  shadowMask: 3,
  brightBoost: 1,
  hardBloomPix: -1.5,
  hardBloomScan: -2,
  bloomAmount: 0.15,
  shape: 2,
};

/** Uniform-ы общей части — одни на все виды Лоттеса. */
export function lottesUniforms(s: LottesOptions): Map<string, THREE.Uniform> {
  return new Map<string, THREE.Uniform>([
    ['pixel', new THREE.Uniform(s.pixel)],
    ['strength', new THREE.Uniform(s.strength)],
    ['hardScan', new THREE.Uniform(s.hardScan)],
    ['hardPix', new THREE.Uniform(s.hardPix)],
    ['curveAmount', new THREE.Uniform(new THREE.Vector2(s.warp[0], s.warp[1]))],
    ['maskDark', new THREE.Uniform(s.maskDark)],
    ['maskLight', new THREE.Uniform(s.maskLight)],
    ['shadowMask', new THREE.Uniform(s.shadowMask)],
    ['brightBoost', new THREE.Uniform(s.brightBoost)],
    ['hardBloomPix', new THREE.Uniform(s.hardBloomPix)],
    ['hardBloomScan', new THREE.Uniform(s.hardBloomScan)],
    ['bloomAmount', new THREE.Uniform(s.bloomAmount)],
    ['shape', new THREE.Uniform(s.shape)],
  ]);
}

export class LottesEffect extends Effect {
  constructor(options: Partial<LottesOptions> = {}) {
    super('LottesEffect', FRAGMENT, {
      // Читает кадр не в своей точке: в один проход с другими эффектами не смешивать.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: lottesUniforms({ ...LOTTES_DEFAULTS, ...options }),
    });
  }
}
