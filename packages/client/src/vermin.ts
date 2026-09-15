import * as THREE from 'three';
import { DUNGEON_GATE, TOWN_SIZE } from '@grimhold/shared';

/**
 * Крысы бегут в люк.
 *
 * Раз в несколько минут от городских ворот к люку пробегает крыса и пропадает
 * у самого его края — уходит вниз. Это **картинка, а не механика**: сервер
 * о них не знает, убить их нельзя, столкновений у них нет. Смысл в другом:
 * подземелье должно чувствоваться живым и до спуска, а слова дворфа про
 * «существо, которое не похоже на крысу» — обещанием, а не надписью.
 *
 * Бегут они **по главным улицам** (полосы |x| ≤ 4.5 и |z| ≤ 4.5) и по проходу
 * к люку: там пусто, и пути в обход домов искать не надо — то же соображение,
 * что у дороги сквозных проверок в городе.
 *
 * **Крыса собрана из примитивов, а не взята моделью.** Готовой под CC0 нашлась
 * одна — мультяшная, с круглой головой и большими ушами; владелец забраковал
 * её («слишком милая»), а всё похожее на настоящую крысу лежит под CC-BY,
 * которую правило 4 не пускает. Здесь же силуэт тот, что нужен: длинное низкое
 * тело, острая морда, голый хвост, — и походка своя. Полтора десятка
 * треугольников на зверя, лицензии не требует.
 */

/** Длина тела без хвоста, метры. Крыса низкая: по холке всего 12 см. */
const BODY = 0.22;
const TALL = 0.12;

/** Скорость бега, м/с. Разброс — чтобы две крысы не выглядели одной. */
const SPEED = { min: 2.4, max: 3.4 };

/** Через сколько секунд после входа в игру пробежит первая. */
const FIRST = { min: 25, max: 70 };

/** И дальше — раз в столько секунд. Владелец просил каждые 3–5 минут. */
const EVERY = { min: 180, max: 300 };

/** У края люка крыса исчезает: считается, что ушла вниз. */
const ARRIVE = 1.3;

/**
 * Откуда бежит. Четверо ворот — от каждых своя дорога к люку по улицам;
 * у западных она короткая, они и так на нужной улице.
 */
const GATE = TOWN_SIZE / 2 - 4;
const ROUTES: readonly (readonly { x: number; z: number }[])[] = [
  [{ x: 0, z: -GATE }, { x: 0, z: 0 }, { x: DUNGEON_GATE.x, z: 0 }],
  [{ x: 0, z: GATE }, { x: 0, z: 0 }, { x: DUNGEON_GATE.x, z: 0 }],
  [{ x: GATE, z: 0 }, { x: 0, z: 0 }, { x: DUNGEON_GATE.x, z: 0 }],
  [{ x: -GATE, z: 0 }, { x: DUNGEON_GATE.x, z: 0 }],
];

/** Шерсть и голая кожа хвоста с лапами. */
const FUR = 0x3a322c;
const SKIN = 0x6b5a52;

interface Runner {
  group: THREE.Group;
  body: THREE.Object3D;
  tail: THREE.Object3D;
  route: readonly { x: number; z: number }[];
  step: number;
  speed: number;
  /** Своя фаза шага: крысы не семенят в ногу. */
  phase: number;
  /** Поперечный сдвиг: две крысы не бегут по одной ниточке. */
  offset: number;
}

export interface Vermin {
  /** Каждый кадр. `visible: false` — под землёй крыс города нет. */
  update(dt: number, visible: boolean): void;
}

function between(range: { min: number; max: number }): number {
  return range.min + Math.random() * (range.max - range.min);
}

/**
 * Крыса из примитивов: туловище, морда, уши, четыре лапы и хвост.
 *
 * Морда смотрит в +Z — как у всех наших моделей, чтобы разворот считался
 * той же формулой.
 */
function buildRat(): { group: THREE.Group; body: THREE.Group; tail: THREE.Object3D } {
  const fur = new THREE.MeshStandardMaterial({ color: FUR, roughness: 0.95, metalness: 0 });
  const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.9, metalness: 0 });

  const group = new THREE.Group();

  /**
   * Корпус — отдельный узел: туловище сжато по осям, и голова, привязанная
   * к нему напрямую, сплющилась бы вместе с ним. Здесь же и покачивание бега.
   */
  const body = new THREE.Group();
  body.position.y = TALL * 0.5;
  group.add(body);

  // Туловище — вытянутый шар: у крысы спина горбится, а не лежит доской.
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), fur);
  torso.scale.set(TALL * 0.82, TALL * 0.85, BODY * 1.1);
  body.add(torso);

  // Голова с острой мордой: конус вперёд — главное отличие от мультяшной.
  const head = new THREE.Mesh(new THREE.ConeGeometry(TALL * 0.42, BODY * 0.55, 8), fur);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, -TALL * 0.1, BODY * 0.66);
  body.add(head);

  // Уши маленькие и прижатые, а не круглые блюдца.
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.CircleGeometry(TALL * 0.26, 6), skin);
    ear.position.set(side * TALL * 0.3, TALL * 0.22, BODY * 0.33);
    ear.rotation.set(0, side * 0.6, 0);
    body.add(ear);
  }

  // Лапы — короткие столбики; при беге они качаются (см. update).
  const legs: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    for (const front of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.009, TALL * 0.55, 5), skin);
      leg.position.set(side * TALL * 0.42, TALL * 0.28, front * BODY * 0.3);
      group.add(leg);
      legs.push(leg);
    }
  }

  // Хвост длиннее тела, голый и волочится — по нему крысу и узнают.
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.003, BODY * 1.5, 5), skin);
  tail.rotation.x = Math.PI / 2 - 0.1;
  tail.position.set(0, TALL * 0.33, -BODY * 1.0);
  group.add(tail);

  for (const part of [torso, head, tail, ...legs]) part.castShadow = true;
  return { group, body, tail };
}

export function createVermin(scene: THREE.Scene): Vermin {
  const group = new THREE.Group();
  scene.add(group);
  const runners: Runner[] = [];
  let nextIn = between(FIRST);
  let elapsed = 0;

  /** Выпускает крысу от случайных ворот. */
  function release(): void {
    const route = ROUTES[Math.floor(Math.random() * ROUTES.length)]!;
    const rat = buildRat();
    rat.group.position.set(route[0]!.x, 0, route[0]!.z);
    group.add(rat.group);
    runners.push({
      group: rat.group,
      body: rat.body,
      tail: rat.tail,
      route,
      step: 1,
      speed: between(SPEED),
      phase: Math.random() * Math.PI * 2,
      offset: (Math.random() - 0.5) * 2.4,
    });
  }

  return {
    update(dt, visible) {
      group.visible = visible;
      if (!visible) return;

      elapsed += dt;
      nextIn -= dt;
      if (nextIn <= 0) {
        release();
        nextIn = between(EVERY);
      }

      for (let index = runners.length - 1; index >= 0; index--) {
        const runner = runners[index]!;

        // Последняя точка — сам люк; до неё крыса идёт по улицам.
        const last = runner.step >= runner.route.length;
        const point = last ? { x: DUNGEON_GATE.x, z: DUNGEON_GATE.z } : runner.route[runner.step]!;
        const aim = last
          ? point
          : {
              x: point.x + (runner.step < runner.route.length - 1 ? 0 : runner.offset),
              z: point.z + (runner.step < runner.route.length - 1 ? runner.offset : 0),
            };

        const dx = aim.x - runner.group.position.x;
        const dz = aim.z - runner.group.position.z;
        const left = Math.hypot(dx, dz);

        // Дошла до люка — пропала: считается, что ушла вниз.
        if (last && left <= ARRIVE) {
          group.remove(runner.group);
          runners.splice(index, 1);
          continue;
        }

        if (left < 0.4) {
          runner.step += 1;
          continue;
        }

        const travel = Math.min(left, runner.speed * dt);
        runner.group.position.x += (dx / left) * travel;
        runner.group.position.z += (dz / left) * travel;
        // Морда смотрит в +Z, как у всех наших моделей.
        runner.group.rotation.y = Math.atan2(dx, dz);

        /**
         * Семенит: тело подпрыгивает вдвое чаще шага, хвост качается следом.
         * Ног у крысы не разглядеть, а рывками в шаге видно, что она бежит,
         * а не едет по земле.
         */
        const gait = elapsed * runner.speed * 7 + runner.phase;
        runner.body.position.y = TALL * 0.5 + Math.sin(gait) * 0.012;
        runner.body.rotation.x = Math.sin(gait) * 0.08;
        runner.tail.rotation.y = Math.sin(gait * 0.5) * 0.35;
      }
    },
  };
}
