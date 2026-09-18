import * as THREE from 'three';
import {
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  Pass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { CrtEffect } from './crt.js';
import { LottesEffect } from './lottes.js';
import { MoireEffect } from './moire.js';
import { createLottesMultipass } from './lottes-multi.js';
import { GeomEffect } from './geom.js';
import { HyllianEffect } from './hyllian.js';
import { GritsEffect } from './grits.js';

/**
 * Постобработка: свечение огня, мрачный цвет, тёмные края кадра.
 *
 * Зачем. В игре про темноту главное на экране — огонь, а без постобработки
 * стекло фонаря и факел были просто залитыми пятнами: светящееся ничем
 * не отличалось от светлого. Свечение (bloom) ловит только то, что ярче
 * белого, — пламя, стёкла, окна, заклинания, — и даёт ему ореол.
 *
 * Как устроено. Мир и руки рисуются не на экран, а в буфер с половинной
 * точностью (HalfFloat): только в нём яркость может быть больше единицы,
 * и свечение отличает огонь от белой стены. Дальше один проход, в котором
 * `postprocessing` склеивает все эффекты в один шейдер:
 *
 *   свечение → тонмаппинг ACES → насыщенность и контраст → затемнение краёв.
 *
 * Тонмаппинг переезжает сюда: в буфер three его не применяет, а применить
 * его дважды — значит выцветить картинку. Экспозицию эффект берёт у рендерера.
 *
 * Выключенные эффекты — прежний путь, прямо на экран. Переключение один раз
 * пересобирает шейдеры материалов (у пути в буфер и на экран они разные),
 * поэтому это настройка в F1, а не что-то, что меняется посреди игры.
 *
 * Цена — см. docs/performance.md, «Постобработка».
 */

export interface PostSettings {
  effects: 'on' | 'off';
  antialias: boolean;
  /**
   * Кинескоп поверх всего — см. docs/crt.md. Работает только при включённых
   * эффектах. Видов два: `newpixie` (crt.ts) и `lottes` (lottes.ts).
   */
  crt: CrtKind;
}

export type CrtKind = 'off' | 'newpixie' | 'lottes' | 'moire' | 'lottes2' | 'geom' | 'hyllian' | 'grits';

export interface PostProcessing {
  configure(settings: PostSettings): void;
  /**
   * Нарисовать кадр. `overlay` — второй проход поверх мира (руки): он
   * рисуется в тот же буфер, чтобы на руки ложились те же свет и цвет.
   */
  render(overlay: (() => void) | null): void;
}

/**
 * Проход, который рисует руки в буфер мира.
 *
 * Руки чистят только глубину и рисуются поверх — ровно как на экран, только
 * цель другая. Своего буфера не просят: результат остаётся во входном.
 */
class OverlayPass extends Pass {
  draw: (() => void) | null = null;

  constructor() {
    super('OverlayPass');
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    if (!this.draw) return;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    this.draw();
  }
}

/**
 * Настройки эффектов. Подобраны на глаз под сумерки и подземелье — и должны
 * приниматься глазами владельца, как звук ушами.
 */
const BLOOM = {
  /** Светится только то, что ярче белого: огонь, стёкла, окна, заклинания. */
  luminanceThreshold: 1,
  luminanceSmoothing: 0.25,
  intensity: 0.9,
  radius: 0.65,
};
/** Мир чуть приглушённее: небо и кирпич были слишком сочными для мрачного фэнтези. */
const SATURATION = -0.15;
const CONTRAST = 0.08;
/** Тёмные края кадра: взгляд собирается в центр, темнота — ближе. */
const VIGNETTE = { offset: 0.35, darkness: 0.55 };
/** Сколько отсчётов сглаживания у буфера, когда сглаживание включено. */
const SAMPLES = 4;

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostProcessing {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
  });
  /**
   * Кто рисует на экран, решаем сами: последним стоит кинескоп, и когда он
   * выключен, библиотека дорисовывала бы кадр на экран лишним проходом
   * копирования. Дешевле переставить флаг на основной проход.
   */
  composer.autoRenderToScreen = false;

  const overlay = new OverlayPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(overlay);
  const grading = new EffectPass(
    camera,
    new BloomEffect({ mipmapBlur: true, ...BLOOM }),
    new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
    new HueSaturationEffect({ saturation: SATURATION }),
    new BrightnessContrastEffect({ contrast: CONTRAST }),
    new VignetteEffect(VIGNETTE),
  );
  composer.addPass(grading);

  /**
   * Кинескоп — отдельным проходом и строго последним: он сам делает свой
   * тонмаппинг и ждёт готовую картинку. Поставить его до ACES значило бы
   * сжечь цвета дважды.
   */
  /**
   * Каждый вид — один или несколько проходов; у многопроходного Лоттеса
   * свечение считается отдельным проходом в свой буфер.
   */
  const tubes: Record<Exclude<CrtKind, 'off'>, Pass[]> = {
    newpixie: [new EffectPass(camera, new CrtEffect())],
    lottes: [new EffectPass(camera, new LottesEffect())],
    moire: [new EffectPass(camera, new MoireEffect())],
    lottes2: createLottesMultipass(camera),
    geom: [new EffectPass(camera, new GeomEffect())],
    hyllian: [new EffectPass(camera, new HyllianEffect())],
    grits: [new EffectPass(camera, new GritsEffect())],
  };
  for (const passes of Object.values(tubes)) for (const pass of passes) composer.addPass(pass);

  let enabled = true;
  /**
   * Размер буфера рисования, под который собраны буферы эффектов.
   *
   * Разрешение меняет не только окно: quality.ts двигает множитель на ходу
   * и зовёт `renderer.setSize` сам. Сверять размер каждый кадр дешевле, чем
   * протягивать сюда каждое место, где его меняют.
   */
  const built = new THREE.Vector2();
  const drawing = new THREE.Vector2();

  return {
    configure({ effects, antialias, crt: tube }) {
      enabled = effects === 'on';
      // Сглаживание рендерера до буфера не доходит — у буфера оно своё,
      // и его, в отличие от рендерера, можно менять на ходу.
      composer.multisampling = antialias ? SAMPLES : 0;
      // На экран рисует тот, кто стоит последним из включённых: включён
      // самое большее один кинескоп, остальные выключены целиком.
      for (const [kind, passes] of Object.entries(tubes)) {
        for (const [index, pass] of passes.entries()) {
          pass.enabled = kind === tube;
          pass.renderToScreen = pass.enabled && index === passes.length - 1;
        }
      }
      grading.renderToScreen = tube === 'off';
    },

    render(draw) {
      if (!enabled) {
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(scene, camera);
        draw?.();
        return;
      }

      renderer.getDrawingBufferSize(drawing);
      if (!drawing.equals(built)) {
        built.copy(drawing);
        composer.setSize(innerWidth, innerHeight, false);
      }

      overlay.draw = draw;
      composer.render();
    },
  };
}
