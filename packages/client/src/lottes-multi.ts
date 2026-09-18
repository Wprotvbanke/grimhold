import * as THREE from 'three';
import { Effect, EffectAttribute, EffectPass, Pass } from 'postprocessing';
import { LOTTES_COMMON, LOTTES_DEFAULTS, lottesUniforms, type LottesOptions } from './lottes.js';

/**
 * Лоттес в два прохода: «аркадный монитор» с мягким свечением.
 *
 * Перенос `crt-lottes-multipass` из набора RetroArch — тот же шейдер Тимоти
 * Лоттеса (Public Domain), разложенный хантерком на два прохода. Разница
 * с однопроходным видом (lottes.ts) одна, но заметная: **свечение считается
 * отдельно, в свой буфер, и читается оттуда с линейной фильтрацией** —
 * выходит мягче и без ступенек; сила свечения у автора здесь 0.4 против 0.15.
 *
 * Как устроено у нас: `LottesBloomPass` — свой проход, который рисует
 * свечение в собственный буфер и **не подменяет кадр** (`needsSwap = false`),
 * а `LottesScanEffect` в обычном `EffectPass` собирает строки и маску из кадра
 * и подмешивает свечение из того буфера. Общий код шейдера — `LOTTES_COMMON`
 * из lottes.ts, здесь только два `main`.
 */

/*
------------------------------------------------------------------------------
PUBLIC DOMAIN CRT STYLED SCAN-LINE SHADER by Timothy Lottes;
multipass split by hunterk. "Please take and use, change, or whatever."
------------------------------------------------------------------------------
*/

const VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/** Первый проход: только свечение, в свой буфер. */
const BLOOM_FRAGMENT = /* glsl */ `
uniform sampler2D inputBuffer;
uniform vec2 resolution;
in vec2 vUv;
out vec4 fragColor;
${LOTTES_COMMON}
void main() {
  fragColor = vec4(Bloom(vUv) * bloomAmount, 1.0);
}
`;

/** Второй проход: строки и маска из кадра плюс свечение из буфера. */
const SCAN_FRAGMENT = /* glsl */ `
uniform sampler2D bloomBuffer;
${LOTTES_COMMON}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 pos = Warp(uv);
  vec3 col = Tri(pos);
  if (shadowMask > 0.0) col *= Mask(uv * resolution * 1.000001);
  // Свечение уже умножено на bloomAmount в своём проходе; автор подмешивает
  // его ещё раз тем же числом — так у него и есть, оставляем.
  col += mix(vec3(0.0), max(texture2D(bloomBuffer, pos).rgb, 0.0), bloomAmount);

  vec3 plain = max(texture2D(inputBuffer, pos).rgb, 0.0);
  col = mix(plain, col, strength);

  if (pos.x <= 0.0001 || pos.x >= 0.9999 || pos.y <= 0.0001 || pos.y >= 0.9999) col = vec3(0.0);
  outputColor = vec4(col, inputColor.a);
}
`;

/** У многопроходного вида свечение вчетверо сильнее — так у автора. */
const MULTI_DEFAULTS: LottesOptions = { ...LOTTES_DEFAULTS, bloomAmount: 0.4 };

class LottesBloomPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;

  constructor(options: LottesOptions) {
    super('LottesBloomPass');
    // Кадр идёт дальше как есть: этот проход только пишет своё рядом.
    this.needsSwap = false;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    const uniforms: Record<string, THREE.IUniform> = {
      inputBuffer: new THREE.Uniform(null),
      resolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
    };
    for (const [name, uniform] of lottesUniforms(options)) uniforms[name] = uniform;

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: BLOOM_FRAGMENT,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.material;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    (this.material.uniforms.resolution!.value as THREE.Vector2).set(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    this.material.uniforms.inputBuffer!.value = inputBuffer?.texture ?? null;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    super.dispose();
    this.target.dispose();
    this.material.dispose();
  }
}

class LottesScanEffect extends Effect {
  constructor(options: LottesOptions, bloom: THREE.Texture) {
    const uniforms = lottesUniforms(options);
    uniforms.set('bloomBuffer', new THREE.Uniform(bloom));
    super('LottesScanEffect', SCAN_FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms,
    });
  }
}

/** Оба прохода в порядке, в котором их класть в композер. */
export function createLottesMultipass(camera: THREE.Camera, options: Partial<LottesOptions> = {}): Pass[] {
  const settings = { ...MULTI_DEFAULTS, ...options };
  const bloom = new LottesBloomPass(settings);
  const scan = new EffectPass(camera, new LottesScanEffect(settings, bloom.target.texture));
  return [bloom, scan];
}
