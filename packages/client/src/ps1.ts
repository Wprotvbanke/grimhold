import * as THREE from 'three';

/**
 * Вид в духе King's Field: текстуры эпохи PlayStation.
 *
 * Важно: это стилизация, а не чужие файлы. Текстуры игр FromSoftware —
 * их собственность, поэтому мы берём текстуру CC0-модели и прогоняем её
 * через ту же обработку, что давало железо PS1:
 *
 *  1. Низкое разрешение (64×64) — у PS1 память под текстуры была крошечной.
 *  2. Точечная фильтрация без мипмапов — отсюда знаменитая «зернистость».
 *  3. 15-битный цвет: 5 бит на канал вместо 8.
 *  4. Упорядоченный дизеринг по матрице Байера — так на PS1 боролись
 *     с полосами после квантования, и это половина её узнаваемого вида.
 *  5. Сдвиг палитры в сырой землистый зелёно-серый — цветовая гамма
 *     подземелий King's Field.
 */

/** Размер текстуры. 64 — типичный размер для персонажа на PS1. */
const TEXTURE_SIZE = 64;

/** Матрица Байера 4×4: тот самый упорядоченный дизеринг. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Насколько сильно уводить цвет в землистый зелёный. */
const TINT = { r: 0.86, g: 0.9, b: 0.74 };
/** Общее затемнение: подземелья King's Field мрачные. */
const GAIN = 0.82;
/** Обесцвечивание: 0 — оригинал, 1 — полностью серый. */
const DESATURATE = 0.45;

/**
 * Прогоняет текстуру материала через обработку PS1.
 * Если исходное изображение недоступно, возвращает null — вызывающий код
 * оставит материал как есть.
 */
export function ps1ifyTexture(source: THREE.Texture | null): THREE.CanvasTexture | null {
  const image = source?.image as CanvasImageSource | undefined;
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  // Сжатие до 64×64 — первый и главный шаг к нужному виду.
  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  let data: ImageData;
  try {
    data = context.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  } catch {
    // Текстура из другого источника могла «испачкать» холст.
    return null;
  }

  const pixels = data.data;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const i = (y * TEXTURE_SIZE + x) * 4;

      let r = pixels[i]!;
      let g = pixels[i + 1]!;
      let b = pixels[i + 2]!;

      // Обесцвечивание к яркости.
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      r += (luma - r) * DESATURATE;
      g += (luma - g) * DESATURATE;
      b += (luma - b) * DESATURATE;

      // Землистый оттенок и затемнение.
      r *= TINT.r * GAIN;
      g *= TINT.g * GAIN;
      b *= TINT.b * GAIN;

      // Дизеринг перед квантованием: смещаем на долю ступени.
      const threshold = (BAYER[y & 3]![x & 3]! / 16 - 0.5) * 8;

      pixels[i] = quantize5bit(r + threshold);
      pixels[i + 1] = quantize5bit(g + threshold);
      pixels[i + 2] = quantize5bit(b + threshold);
    }
  }
  context.putImageData(data, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  // Без сглаживания и мипмапов — иначе весь эффект смажется.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;
  texture.colorSpace = source!.colorSpace;
  texture.wrapS = source!.wrapS;
  texture.wrapT = source!.wrapT;
  texture.flipY = false;
  texture.needsUpdate = true;

  return texture;
}

/** 5 бит на канал — цветность PS1. */
function quantize5bit(value: number): number {
  const clamped = Math.max(0, Math.min(255, value));
  return Math.round(clamped / 8) * 8;
}

/**
 * Переводит всю модель на материалы эпохи PS1: без физически корректного
 * освещения, с точечной фильтрацией и лёгким самосвечением, чтобы существо
 * читалось в темноте подземелья.
 */
export function applyPs1Look(root: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.Material>();

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const replaced = materials.map((material) => {
      const existing = converted.get(material);
      if (existing) return existing;

      const source = material as THREE.MeshStandardMaterial;
      const map = ps1ifyTexture(source.map ?? null);

      // Ламберт вместо PBR: на PS1 никакой шероховатости и металличности не было.
      const flat = new THREE.MeshLambertMaterial({
        map: map ?? source.map,
        color: map ? 0xffffff : 0xa8a08c,
        emissive: 0x1a1a16,
        side: source.side,
        transparent: source.transparent,
        alphaTest: source.alphaTest,
      });

      converted.set(material, flat);
      return flat;
    });

    mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0]!;
  });
}
