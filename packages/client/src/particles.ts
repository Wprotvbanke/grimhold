import * as THREE from 'three';

/**
 * Живой воздух: пылинки в свете своего огня под землёй и мошкара у фонарей
 * ночью.
 *
 * Ни то ни другое ничего не освещает и ни на что не влияет — это картинка,
 * как ореол огня. Смысл один: неподвижный воздух в кадре читается как макет,
 * а медленно плывущая пыль у факела — как подвал, где давно никто не дышал.
 *
 * **Две пачки точек — два вызова отрисовки**, сколько бы пылинок ни было.
 * Точки двигает процессор: их пара сотен, это дешевле любого шейдера,
 * который пришлось бы писать и поддерживать. Буфер заводится один раз.
 *
 * Правило ламп тут не нарушается: частицы не источники света.
 */

/** Сколько пылинок висит вокруг игрока. */
const DUST_COUNT = 180;
/** Куб вокруг глаз, в котором живёт пыль, м: полуширина и полувысота. */
const DUST_HALF = 4;
const DUST_HALF_HEIGHT = 2;
/** Насколько яркой пыль становится, когда горит свой огонь. */
const DUST_OPACITY = 0.55;

/** Сколько фонарей одновременно обзаводятся мошкарой — ближайшие. */
const SWARMS = 6;
/** Мошек у одного фонаря. */
const SWARM_SIZE = 12;
/** Дальше этого мошкару у фонаря не видно, и считать её незачем, м. */
const SWARM_RANGE = 30;
const GNAT_OPACITY = 0.85;

export interface Place {
  x: number;
  y: number;
  z: number;
}

export interface AirState {
  underground: boolean;
  /** Горит ли свой огонь — факел или «Светоч». */
  lit: boolean;
  /** Насколько светло снаружи, 0..1: мошкара вьётся, пока фонари горят. */
  daylight: number;
  /** Уличные огни: у них и вьётся мошкара. */
  lamps: readonly Place[];
}

export interface Particles {
  update(dt: number, elapsed: number, camera: THREE.Camera, state: AirState): void;
}

/** Мягкая круглая точка вместо квадрата. Рисуется кодом, файла не нужно. */
function dotTexture(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const paint = canvas.getContext('2d')!;
  const gradient = paint.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function cloud(count: number, material: THREE.PointsMaterial): { points: THREE.Points; positions: Float32Array } {
  const positions = new Float32Array(count * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(geometry, material);
  // Точки ездят за игроком и за фонарями: сфера границ устареет на первом кадре.
  points.frustumCulled = false;
  points.visible = false;
  return { points, positions };
}

/** Плавное приближение к цели без привязки к частоте кадров. */
function approach(current: number, target: number, dt: number, rate: number): number {
  return current + (target - current) * Math.min(1, dt * rate);
}

export function createParticles(scene: THREE.Scene): Particles {
  const texture = dotTexture();

  const dustMaterial = new THREE.PointsMaterial({
    map: texture,
    color: 0xffd9a8,
    size: 0.035,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Туман пыль гасит сам: дальние пылинки тонут во мгле, как всё остальное.
    fog: true,
  });
  const dust = cloud(DUST_COUNT, dustMaterial);
  scene.add(dust.points);

  /** Своё место каждой пылинки внутри куба и её неспешный дрейф. */
  const dustHome = Array.from({ length: DUST_COUNT }, () => ({
    x: (Math.random() * 2 - 1) * DUST_HALF,
    y: (Math.random() * 2 - 1) * DUST_HALF_HEIGHT,
    z: (Math.random() * 2 - 1) * DUST_HALF,
    phase: Math.random() * Math.PI * 2,
    // Пыль в стоячем воздухе оседает и снова поднимается — очень медленно.
    drift: 0.04 + Math.random() * 0.08,
  }));

  const gnatMaterial = new THREE.PointsMaterial({
    map: texture,
    color: 0xffe2b0,
    size: 0.03,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  const gnats = cloud(SWARMS * SWARM_SIZE, gnatMaterial);
  scene.add(gnats.points);

  const gnatPhase = Array.from({ length: SWARMS * SWARM_SIZE }, () => ({
    radius: 0.25 + Math.random() * 0.45,
    speed: 2.5 + Math.random() * 3,
    tilt: Math.random() * Math.PI * 2,
    offset: Math.random() * Math.PI * 2,
  }));

  /** Ближайшие фонари — записи переиспользуются, кадр за кадром без мусора. */
  const nearest: { lamp: Place | null; distance: number }[] = Array.from({ length: SWARMS }, () => ({
    lamp: null,
    distance: Infinity,
  }));

  return {
    update(dt, elapsed, camera, state) {
      const eye = camera.position;

      // ---------- пыль ----------
      const dustWanted = state.underground && state.lit ? DUST_OPACITY : 0;
      dustMaterial.opacity = approach(dustMaterial.opacity, dustWanted, dt, 2);
      dust.points.visible = dustMaterial.opacity > 0.01;

      if (dust.points.visible) {
        for (const [index, mote] of dustHome.entries()) {
          mote.y -= mote.drift * dt * Math.sin(elapsed * 0.3 + mote.phase);
          // Куб ездит за глазами, а пылинки остаются на месте в мире: иначе
          // пыль «прилипла» бы к лицу. Ушедшая за край появляется с другой стороны.
          const wrap = (value: number, center: number, half: number): number =>
            center + ((((value - center + half) % (half * 2)) + half * 2) % (half * 2)) - half;
          const x = wrap(mote.x + Math.sin(elapsed * 0.17 + mote.phase) * 0.3, eye.x, DUST_HALF);
          const y = wrap(mote.y, eye.y, DUST_HALF_HEIGHT);
          const z = wrap(mote.z + Math.cos(elapsed * 0.13 + mote.phase) * 0.3, eye.z, DUST_HALF);
          dust.positions[index * 3] = x;
          dust.positions[index * 3 + 1] = y;
          dust.positions[index * 3 + 2] = z;
          // Сдвиг копится в мировых координатах: пылинка помнит своё место.
          mote.x = x - Math.sin(elapsed * 0.17 + mote.phase) * 0.3;
          mote.z = z - Math.cos(elapsed * 0.13 + mote.phase) * 0.3;
          mote.y = y;
        }
        dust.points.geometry.attributes.position!.needsUpdate = true;
      }

      // ---------- мошкара ----------
      const night = state.underground ? 0 : 1 - state.daylight;
      gnatMaterial.opacity = approach(gnatMaterial.opacity, night * GNAT_OPACITY, dt, 1);
      gnats.points.visible = gnatMaterial.opacity > 0.01;
      if (!gnats.points.visible) return;

      for (const slot of nearest) {
        slot.lamp = null;
        slot.distance = Infinity;
      }
      for (const lamp of state.lamps) {
        const distance = Math.hypot(lamp.x - eye.x, lamp.z - eye.z);
        if (distance > SWARM_RANGE) continue;
        let worst = nearest[0]!;
        for (const slot of nearest) if (slot.distance > worst.distance) worst = slot;
        if (distance < worst.distance) {
          worst.lamp = lamp;
          worst.distance = distance;
        }
      }

      for (const [swarm, slot] of nearest.entries()) {
        for (let i = 0; i < SWARM_SIZE; i++) {
          const index = swarm * SWARM_SIZE + i;
          const at = index * 3;
          if (!slot.lamp) {
            // Лишний рой прячем под землю: так буфер не меняет размера.
            gnats.positions[at + 1] = -1000;
            continue;
          }
          // Мошка кружит у огня по своей наклонённой орбите и дёргается:
          // ровное кружение читается как механизм, а не как живое.
          const gnat = gnatPhase[index]!;
          const angle = elapsed * gnat.speed + gnat.offset;
          const jitter = Math.sin(elapsed * 17 + gnat.offset * 3) * 0.06;
          gnats.positions[at] = slot.lamp.x + Math.cos(angle) * (gnat.radius + jitter);
          gnats.positions[at + 1] = slot.lamp.y + Math.sin(angle * 1.3 + gnat.tilt) * gnat.radius * 0.6;
          gnats.positions[at + 2] = slot.lamp.z + Math.sin(angle) * (gnat.radius + jitter);
        }
      }
      gnats.points.geometry.attributes.position!.needsUpdate = true;
    },
  };
}
