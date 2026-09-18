import * as THREE from 'three';

/**
 * Шейдер плиты панели.
 *
 * Панель — HTML поверх холста, и кинескопы постобработки (docs/crt.md)
 * её не трогают: мир изгибается и идёт строками, а плита лежит сверху
 * ровная. Владелец захотел плиту «с шейдером» — и вот свой, только для
 * неё: картинка плиты рисуется одним квадратом на отдельном маленьком
 * холсте, а ячейки, полосы, лицо и компас остаются DOM-элементами сверху
 * и работают как прежде (перетаскивание, наведение, подсказки).
 *
 * Что делает: строки развёртки, маска люминофора по столбцам, зерно,
 * слабое мерцание и медленная бегущая полоса. **Кривизны нет нарочно**:
 * изогнутая плита разъехалась бы с ячейками, которые лежат над ней
 * в своих камнях. Прозрачные вырезы картинки (окно лица, щели полосок)
 * остаются прозрачными: альфа берётся из текстуры как есть.
 *
 * Свой код, не перенос: эффекты те же, что у кинескопов, но записаны
 * заново в двадцать строк — лицензии переносить нечего.
 */

/** Ручки на глаз владельца. `strength` — общая сила, 0 — чистая картинка. */
export const PANEL_FX = {
  strength: 0.7,
  /** Тёмная доля строки развёртки. */
  scan: 0.22,
  /** Сколько столбца забирает маска люминофора. */
  mask: 0.14,
  /** Размах зерна. */
  grain: 0.05,
  /** Мерцание и бегущая полоса — движение; гасится при prefers-reduced-motion. */
  flicker: 0.025,
  roll: 0.06,
  /** Яркость плиты целиком: 1 — как в файле. Владелец просил немного темнее. */
  brightness: 0.85,
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec2 size;
uniform float time;
uniform float strength;
uniform float scan;
uniform float mask;
uniform float grain;
uniform float flicker;
uniform float roll;
uniform float motion;
uniform float brightness;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  vec4 base = texture2D(map, uv);

  // Лёгкий цветной разъезд по краям — как у кинескопа со сведением.
  float fringe = 0.0012 * strength;
  float r = texture2D(map, uv + vec2(fringe, 0.0)).r;
  float b = texture2D(map, uv - vec2(fringe, 0.0)).b;
  vec3 col = mix(base.rgb, vec3(r, base.g, b), strength) * brightness;

  // Строки развёртки: одна тёмная на два пикселя холста.
  float line = 0.5 + 0.5 * sin(uv.y * size.y * 3.14159265);
  col *= 1.0 - scan * strength * line;

  // Маска люминофора: столбцы красный-зелёный-синий.
  float column = mod(floor(uv.x * size.x), 3.0);
  vec3 phosphor = vec3(column == 0.0 ? 1.0 : 0.0, column == 1.0 ? 1.0 : 0.0, column == 2.0 ? 1.0 : 0.0);
  col *= mix(vec3(1.0), phosphor * 1.5 + 0.5, mask * strength);

  // Зерно: живое, но с частотой кадров, а не с частотой холста.
  float noise = hash(floor(uv * size * 0.5) + floor(time * 24.0));
  col += (noise - 0.5) * grain * strength;

  // Мерцание и бегущая полоса — только если движение не запрещено.
  col *= 1.0 + motion * flicker * strength * sin(time * 120.0);
  float band = fract(uv.y - time * 0.06);
  col *= 1.0 + motion * roll * strength * smoothstep(0.0, 0.08, band) * smoothstep(0.16, 0.08, band);

  // Холст с прозрачностью ждёт цвет, умноженный на альфу.
  gl_FragColor = vec4(col * base.a, base.a);
}
`;

export interface PanelFx {
  /** Каждый кадр, пока панель видна. `now` — миллисекунды. */
  update(now: number): void;
}

export function createPanelFx(canvas: HTMLCanvasElement, url: string): PanelFx {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  } catch (error) {
    // Нет WebGL — плита остаётся картинкой из CSS, панель работает как прежде.
    console.warn('[панель] шейдер плиты не завёлся, плита без него', error);
    return { update() {} };
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const uniforms = {
    map: { value: null as THREE.Texture | null },
    size: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    strength: { value: PANEL_FX.strength },
    scan: { value: PANEL_FX.scan },
    mask: { value: PANEL_FX.mask },
    grain: { value: PANEL_FX.grain },
    flicker: { value: PANEL_FX.flicker },
    roll: { value: PANEL_FX.roll },
    brightness: { value: PANEL_FX.brightness },
    motion: { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Цвет уже умножен на альфу в шейдере, смешивать нечего.
    blending: THREE.NoBlending,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let ready = false;
  new THREE.TextureLoader().load(
    url,
    (texture) => {
      // Значения как в файле: ни в линейное, ни обратно — плита не освещается.
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      uniforms.map.value = texture;
      ready = true;
      // Картинка теперь рисуется шейдером — фон CSS под ней не нужен, иначе
      // на полупрозрачных краях они сложатся вдвое.
      canvas.style.background = 'none';
    },
    undefined,
    () => console.warn(`[панель] не загрузилась ${url}`),
  );

  let width = 0;
  let height = 0;

  return {
    update(now) {
      if (!ready) return;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (w !== width || h !== height) {
        width = w;
        height = h;
        renderer.setSize(w, h, false);
        uniforms.size.value.set(w, h);
      }
      uniforms.time.value = now / 1000;
      renderer.render(scene, camera);
    },
  };
}
