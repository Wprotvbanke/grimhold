import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/**
 * Кинескоп: картинка «как на старом телевизоре».
 *
 * Перенос финального прохода шейдера newpixie Маттиаса Густавссона
 * (MIT или Public Domain на выбор — шапка ниже) из формата RetroArch
 * в эффект `postprocessing`. Разбор, лицензия и порядок пробы — docs/crt.md.
 *
 * Пока это **только финальный проход**: кривизна, разведение цветов, уровни,
 * виньетка, бегущие строки, маска, тонмаппинг, шум, мерцание. Послесвечение
 * и ореолы (проходы накопления и размытия) не перенесены — они требуют своих
 * буферов, и сперва надо увидеть, нужен ли этот вид вообще.
 *
 * Про цвет. Оригинал ждёт на входе экранную (sRGB) картинку, возводит её
 * в степень 2.2 и дальше считает в линейном свете, а его «filmic» на выходе
 * даёт снова экранную. У нас внутри `EffectPass` свет уже линейный, поэтому
 * степень на входе убрана, а выход filmic возвращён в линейный — кодировать
 * в sRGB будет сам проход, как и всё остальное. Иначе гамма легла бы дважды.
 *
 * Про края. Кривизна выталкивает углы за пределы кадра; в RetroArch там
 * чёрное (clamp_to_border), в WebGL такого режима нет и края размазались бы
 * полосами. Поэтому за пределами кадра отсчёт — чёрный, руками.
 */

/*
------------------------------------------------------------------------------
newpixie CRT by Mattias Gustavsson, adapted for slang by hunterk.
This software is available under 2 licenses - you may choose the one you like.
ALTERNATIVE A - MIT License. Copyright (c) 2016 Mattias Gustavsson.
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
ALTERNATIVE B - Public Domain (www.unlicense.org). This is free and
unencumbered software released into the public domain.
------------------------------------------------------------------------------
*/

const FRAGMENT = /* glsl */ `
uniform float curvature;
uniform float vignette;
uniform float scanroll;
uniform float scanBase;
uniform float strength;
uniform float wiggle;
uniform float frame;
uniform float motion;

/*
 * Отсчёт кадра с поправкой на растяжение экрана. За пределами кадра — чёрное:
 * так в оригинале даёт clamp_to_border, которого в WebGL нет.
 */
vec3 tsample(vec2 tc) {
  tc = tc * vec2(1.025, 0.92) + vec2(-0.0125, 0.04);
  if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0) return vec3(0.0);
  return max(texture2D(inputBuffer, tc).rgb, 0.0) * 1.25;
}

vec3 filmic(vec3 c) {
  vec3 x = max(vec3(0.0), c - vec3(0.004));
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}

vec2 curve(vec2 uv) {
  uv = uv - 0.5;
  uv *= vec2(0.925, 1.095);
  uv *= curvature;
  uv.x *= 1.0 + pow(abs(uv.y) / 4.0, 2.0);
  uv.y *= 1.0 + pow(abs(uv.x) / 3.0, 2.0);
  uv /= curvature;
  uv += 0.5;
  uv = uv * 0.92 + 0.04;
  return uv;
}

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 fragCoord = uv * resolution;

  // Медленное время — для помех, они у оригинала выключены.
  float t = mod(frame, 849.0) * 36.0;
  vec2 curvedUv = mix(curve(uv), uv, 0.4);
  float scale = -0.101;
  vec2 scuv = curvedUv * (1.0 - scale) + scale / 2.0 + vec2(0.003, -0.001);

  /* Цвет с разведением каналов */
  float x = wiggle * sin(0.1 * t + curvedUv.y * 13.0) * sin(0.23 * t + curvedUv.y * 19.0)
    * sin(0.3 + 0.11 * t + curvedUv.y * 23.0) * 0.0012;
  float o = sin(fragCoord.y * 1.5) / resolution.x;
  x += o * 0.25;
  // Быстрое время — для строк, шума и мерцания.
  t = mod(frame, 640.0) * motion;

  vec3 col;
  col.r = tsample(vec2(x + scuv.x + 0.0009, scuv.y + 0.0009)).r + 0.02;
  col.g = tsample(vec2(x + scuv.x + 0.0000, scuv.y - 0.0011)).g + 0.02;
  col.b = tsample(vec2(x + scuv.x - 0.0015, scuv.y + 0.0000)).b + 0.02;

  /* Уровни */
  col *= vec3(0.95, 1.05, 0.95);
  col = clamp(col * 1.3 + 0.75 * col * col + 1.25 * col * col * col * col * col, vec3(0.0), vec3(10.0));

  /* Виньетка */
  float vig = (1.0 - 0.99 * vignette)
    + 16.0 * curvedUv.x * curvedUv.y * (1.0 - curvedUv.x) * (1.0 - curvedUv.y);
  vig = 1.3 * pow(vig, 0.5);
  col *= vig;

  float st = t * scanroll;

  /*
   * Строки развёртки.
   *
   * В оригинале база 0.35: строки гасили кадр почти втрое, и ночью в городе
   * не было видно ничего. Владелец попросил светлее — база поднята, размах
   * оставлен: строки видны, но света не отнимают.
   */
  float scans = clamp(scanBase + 0.18 * sin(6.0 * st - curvedUv.y * resolution.y * 1.5), 0.0, 1.0);
  col *= pow(scans, 0.9);

  /* Маска: вертикальные полосы люминофора */
  col *= 1.0 - 0.23 * clamp(mod(fragCoord.x, 3.0) / 2.0, 0.0, 1.0);

  /* Тонмаппинг — даёт экранный свет */
  col = filmic(col);

  /* Шум */
  vec2 seed = curvedUv * resolution;
  col -= 0.015 * pow(vec3(rand(seed + t), rand(seed + t * 2.0), rand(seed + t * 3.0)), vec3(1.5));

  /* Мерцание */
  col *= 1.0 - 0.004 * (sin(50.0 * t + curvedUv.y * 2.0) * 0.5 + 0.5);

  // Обратно в линейный: кодировать в sRGB будет сам проход.
  vec3 effect = pow(max(col, 0.0), vec3(2.2));

  /*
   * Общая сила: смесь с чистым кадром **в той же выгнутой точке** — иначе
   * два кадра расходятся по кривизне и двоятся. За краем экрана чисто чёрное.
   */
  vec3 clean = texture2D(inputBuffer, curvedUv).rgb;
  if (curvedUv.x < 0.0 || curvedUv.x > 1.0 || curvedUv.y < 0.0 || curvedUv.y > 1.0) clean = vec3(0.0);
  outputColor = vec4(mix(clean, effect, strength), inputColor.a);
}
`;

/** Ручки оригинала с его же значениями по умолчанию. */
export interface CrtOptions {
  /** Кривизна экрана, 0.0001…4. */
  curvature: number;
  /** Своя виньетка шейдера, 0…1. */
  vignette: number;
  /** Бегут ли строки: 0 или 1. */
  scanroll: number;
  /** Помехи (дрожание строк): 0 или 1. */
  wiggle: number;
  /**
   * Яркость между строками, 0…1. В оригинале 0.35 — и кадр гас почти втрое;
   * владелец попросил светлее, ночью в городе не было видно ничего.
   */
  scanBase: number;
  /** Общая сила, 0…1: смесь с чистым кадром. Владелец просил на четверть слабее. */
  strength: number;
}

const DEFAULTS: CrtOptions = {
  curvature: 2,
  vignette: 1,
  scanroll: 1,
  wiggle: 0,
  scanBase: 0.65,
  strength: 0.75,
};

export class CrtEffect extends Effect {
  constructor(options: Partial<CrtOptions> = {}) {
    const settings = { ...DEFAULTS, ...options };
    /**
     * Мерцание и шум — движение ради движения; кому оно вредно, тот просит
     * браузер его убрать, и мы слушаемся: время для них стоит.
     */
    const still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    super('CrtEffect', FRAGMENT, {
      // Читает кадр не в своей точке — библиотека должна знать, что смешивать
      // это с другими эффектами в один проход нельзя.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['curvature', new THREE.Uniform(settings.curvature)],
        ['vignette', new THREE.Uniform(settings.vignette)],
        ['scanroll', new THREE.Uniform(settings.scanroll)],
        ['scanBase', new THREE.Uniform(settings.scanBase)],
        ['strength', new THREE.Uniform(settings.strength)],
        ['wiggle', new THREE.Uniform(settings.wiggle)],
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
