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
}

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
  composer.autoRenderToScreen = true;

  const overlay = new OverlayPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(overlay);
  composer.addPass(
    new EffectPass(
      camera,
      new BloomEffect({ mipmapBlur: true, ...BLOOM }),
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      new HueSaturationEffect({ saturation: SATURATION }),
      new BrightnessContrastEffect({ contrast: CONTRAST }),
      new VignetteEffect(VIGNETTE),
    ),
  );

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
    configure({ effects, antialias }) {
      enabled = effects === 'on';
      // Сглаживание рендерера до буфера не доходит — у буфера оно своё,
      // и его, в отличие от рендерера, можно менять на ходу.
      composer.multisampling = antialias ? SAMPLES : 0;
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
