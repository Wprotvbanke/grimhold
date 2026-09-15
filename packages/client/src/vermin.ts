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
const FUR = 0x4a4038;
const SKIN = 0x7d6c62;

interface Runner {
  group: THREE.Group;
  parts: RatParts;
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

/** Что у крысы шевелится на бегу. */
interface RatParts {
  group: THREE.Group;
  /** Корпус целиком: подпрыгивает и качается. */
  body: THREE.Group;
  /** Голова: водит из стороны в сторону, будто принюхивается. */
  head: THREE.Group;
  /** Лапы: передние и задние ходят навстречу друг другу. */
  legs: { mesh: THREE.Object3D; front: number; side: number }[];
  /** Звенья хвоста от основания к кончику — по ним идёт волна. */
  tail: THREE.Object3D[];
}

/**
 * Крыса из примитивов: горбатое туловище, острая морда, лапы и хвост звеньями.
 *
 * Морда смотрит в +Z — как у всех наших моделей, чтобы разворот считался
 * той же формулой.
 */
function buildRat(): RatParts {
  // Шерсть у каждой своя, чуть светлее или темнее: одинаковые звери читаются
  // как копии одного, даже когда бегут порознь.
  const shade = 0.85 + Math.random() * 0.35;
  const fur = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  fur.color.setHex(FUR).multiplyScalar(shade);
  const skin = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  skin.color.setHex(SKIN).multiplyScalar(shade);

  const group = new THREE.Group();

  /**
   * Корпус — отдельный узел: туловище сжато по осям, и голова, привязанная
   * к нему напрямую, сплющилась бы вместе с ним. Здесь же покачивание бега.
   */
  const body = new THREE.Group();
  body.position.y = TALL * 0.5;
  group.add(body);

  // Туловище — вытянутый шар: у крысы спина горбится, а не лежит доской.
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), fur);
  torso.scale.set(TALL * 0.82, TALL * 0.85, BODY * 1.1);
  body.add(torso);

  /**
   * Круп выше плеч — тот самый горб.
   *
   * У бегущей крысы зад приподнят, а голова опущена к земле: по этой линии
   * её и узнают со спины. Ровное тело-бочонок читалось хомяком.
   */
  const rump = new THREE.Mesh(new THREE.SphereGeometry(0.5, 9, 7), fur);
  rump.scale.set(TALL * 0.78, TALL * 0.92, BODY * 0.6);
  rump.position.set(0, TALL * 0.12, -BODY * 0.3);
  body.add(rump);

  // Голова отдельным узлом: она водит по сторонам, а тело идёт прямо.
  const head = new THREE.Group();
  head.position.set(0, -TALL * 0.12, BODY * 0.42);
  body.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), fur);
  skull.scale.setScalar(TALL * 0.62);
  head.add(skull);

  // Морда длинная и острая — главное отличие от мультяшной.
  const snout = new THREE.Mesh(new THREE.ConeGeometry(TALL * 0.26, BODY * 0.42, 7), fur);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -TALL * 0.08, BODY * 0.3);
  head.add(snout);

  // Уши маленькие и прижатые, а не круглые блюдца.
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.CircleGeometry(TALL * 0.22, 6), skin);
    ear.position.set(side * TALL * 0.26, TALL * 0.2, -TALL * 0.05);
    ear.rotation.set(0, side * 0.7, 0);
    head.add(ear);
  }

  // Лапы — короткие столбики; на бегу передние и задние ходят навстречу.
  const legs: RatParts['legs'] = [];
  for (const side of [-1, 1]) {
    for (const front of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * TALL * 0.4, TALL * 0.42, front * BODY * 0.34);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.008, TALL * 0.46, 5), skin);
      shin.position.y = -TALL * 0.23;
      leg.add(shin);
      group.add(leg);
      legs.push({ mesh: leg, front, side });
    }
  }

  /**
   * Хвост из трёх звеньев, а не палкой.
   *
   * По звеньям пускается волна, и хвост живёт: одной длинной палкой он выдавал
   * поделку из кубиков, как бы ни был длинным.
   */
  const tail: THREE.Object3D[] = [];
  let anchor: THREE.Object3D = group;
  let width = 0.011;
  for (let link = 0; link < 3; link++) {
    const joint = new THREE.Group();
    joint.position.set(0, link === 0 ? TALL * 0.4 : 0, link === 0 ? -BODY * 0.55 : -BODY * 0.42);
    const piece = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.72, width, BODY * 0.42, 5), skin);
    piece.rotation.x = Math.PI / 2;
    piece.position.z = -BODY * 0.21;
    piece.castShadow = true;
    joint.add(piece);
    anchor.add(joint);
    anchor = joint;
    tail.push(joint);
    width *= 0.72;
  }
  // Первое звено чуть задрано, дальше хвост опускается к земле.
  tail[0]!.rotation.x = -0.25;

  for (const part of [torso, rump, skull, snout]) part.castShadow = true;
  return { group, body, head, legs, tail };
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
      parts: rat,
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
         * Семенит.
         *
         * Ног у крысы издали не разглядеть, а рывками в шаге видно, что она
         * бежит, а не едет по земле. Поэтому качается всё разом: корпус вдвое
         * чаще шага, голова — вполовину реже, лапы навстречу друг другу,
         * а по хвосту идёт волна с отставанием от звена к звену.
         */
        const gait = elapsed * runner.speed * 7 + runner.phase;
        const parts = runner.parts;
        parts.body.position.y = TALL * 0.5 + Math.sin(gait) * 0.012;
        parts.body.rotation.x = Math.sin(gait) * 0.07;
        parts.head.rotation.y = Math.sin(gait * 0.37) * 0.3;
        parts.head.rotation.x = 0.12 + Math.sin(gait * 0.5) * 0.08;
        for (const leg of parts.legs) {
          leg.mesh.rotation.x = Math.sin(gait + (leg.front > 0 ? 0 : Math.PI)) * 0.5;
        }
        for (const [link, joint] of parts.tail.entries()) {
          joint.rotation.y = Math.sin(gait * 0.45 - link * 0.9) * 0.28;
        }
      }
    },
  };
}
