import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ACTIONS, ATTACK_COOLDOWN, WALK_SPEED } from '@grimhold/shared';
import { ViewModel, type ViewModelState } from '../src/viewmodel.js';

/**
 * Анимации рук теперь готовые, из модели, поэтому проверять нечего в позах —
 * зато есть что проверить в выборе: какой клип идёт в каком состоянии, как
 * удар подгоняется под фазы сервера и гаснут ли руки после смерти.
 *
 * Модель сюда не грузится: она весит мегабайты, сжата Draco и приезжает по
 * сети. Клипы подставляются пустышками — нас интересует логика, а не файл.
 */

const IDLE_STATE: ViewModelState = {
  action: null,
  phase: null,
  blocking: false,
  speed: 0,
  onGround: true,
  alive: true,
};

/** Клип-пустышка нужной длины: дорожек в нём нет, длительность есть. */
function fakeClip(name: string, duration: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, []);
}

/** Те же клипы, что в модели, с теми же длительностями. */
const CLIPS = [
  ['rig|Equip', 0.73],
  ['rig|Idle', 5],
  ['rig|Idle_Fidget', 2],
  ['rig|Walk', 2.67],
  ['rig|Sprint_Type_1', 1.33],
  ['rig|Punch_R', 1],
  ['rig|Punch_L', 1],
  ['rig|Block_Start', 1.27],
  ['rig|Block_Loop', 1.67],
  ['rig|Block_Stop', 1],
  ['rig|Take_Start', 0.73],
  ['rig|Take_Loop', 1.67],
  ['rig|Take_Stop', 1.57],
] as const;

function createModel(race: 'human' | 'dwarf' | 'elf' = 'human'): ViewModel {
  const model = new ViewModel(race);
  model.useRig(createRig(), CLIPS.map(([name, duration]) => fakeClip(name, duration)), race);
  return model;
}

/**
 * Риг с теми костями, которые видмодель ищет по именам.
 *
 * Настоящая модель сюда не грузится, но плечи и кисти нужны: на плечах держится
 * разведение рук, и именно там однажды копился сдвиг.
 */
function createRig(): THREE.Group {
  const rig = new THREE.Group();
  for (const side of ['L', 'R'] as const) {
    const shoulder = new THREE.Bone();
    shoulder.name = `DEF-upper_arm${side}`;
    shoulder.position.set(side === 'L' ? 0.1 : -0.1, 1.4, 0);

    const hand = new THREE.Bone();
    hand.name = `DEF-hand${side}`;
    hand.position.set(0, -0.5, 0.2);

    shoulder.add(hand);
    rig.add(shoulder);
  }
  return rig;
}

/** Прогоняет несколько кадров, чтобы состояние успело примениться. */
function settle(model: ViewModel, seconds: number, state: ViewModelState): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) model.update(dt, state);
}

describe('руки от первого лица', () => {
  it('вход в мир начинается с доставания рук, потом стойка', () => {
    const model = createModel();
    expect(model.playing, 'руки не достаются').toBe('equip');

    settle(model, 1.2, IDLE_STATE);
    expect(model.playing, 'после доставания не вернулись в стойку').toBe('idle');
  });

  it('на ходу шаг, на бегу спринт', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    settle(model, 0.3, { ...IDLE_STATE, speed: WALK_SPEED * 0.8 });
    expect(model.playing).toBe('walk');

    settle(model, 0.3, { ...IDLE_STATE, speed: WALK_SPEED * 1.6 });
    expect(model.playing).toBe('sprint');
  });

  it('блок держится петлёй и закрывается выходом', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    const blocking = { ...IDLE_STATE, blocking: true };
    model.update(1 / 60, blocking);
    expect(model.playing, 'нет входа в блок').toBe('blockStart');

    settle(model, 1.5, blocking);
    expect(model.playing, 'блок не перешёл в петлю').toBe('blockLoop');

    model.update(1 / 60, IDLE_STATE);
    expect(model.playing, 'нет выхода из блока').toBe('blockStop');
  });

  it('подбор вещи играется целиком: тянемся, берём, убираем руку', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    model.playTake();
    model.update(1 / 60, IDLE_STATE);
    expect(model.playing).toBe('takeStart');

    settle(model, 1, IDLE_STATE);
    expect(model.playing).toBe('takeLoop');

    settle(model, 2, IDLE_STATE);
    expect(model.playing).toBe('takeStop');
  });

  it('удар начинается сразу по нажатию, не дожидаясь сервера', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    model.beginAction('attack');
    model.update(1 / 60, IDLE_STATE);

    // Состояние с сервера ещё пустое, а кулак уже пошёл.
    expect(model.playing === 'punchRight' || model.playing === 'punchLeft').toBe(true);
  });

  it('серия ударов чередует руки', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    const played: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      model.beginAction('attack');
      model.update(1 / 60, IDLE_STATE);
      played.push(model.playing);
      settle(model, totalOf('attack') + 0.4, IDLE_STATE);
    }
    expect(played[0], 'оба удара одной рукой').not.toBe(played[1]);
  });

  it('удары нельзя спамить: пауза та же, что у сервера', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    expect(model.beginAction('attack'), 'первый удар не прошёл').toBe(true);
    expect(model.beginAction('attack'), 'второй удар прошёл сразу').toBe(false);

    // Ждём ровно столько, сколько держит сервер: пауза плюс замах с ударом.
    const timing = ACTIONS.attack.timing;
    settle(model, ATTACK_COOLDOWN + timing.windup + timing.active + 0.05, IDLE_STATE);
    expect(model.beginAction('attack'), 'после паузы удар не пошёл').toBe(true);
  });

  it('спам по кнопке не заставляет руки махать чаще, чем бьёт сервер', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    // Пять секунд жмём как из пулемёта — считаем, сколько ударов началось.
    let swings = 0;
    for (let i = 0; i < 300; i++) {
      if (model.beginAction('attack')) swings++;
      model.update(1 / 60, IDLE_STATE);
    }

    const timing = ACTIONS.attack.timing;
    const period = ATTACK_COOLDOWN + timing.windup + timing.active;
    const possible = Math.ceil(5 / period) + 1;
    expect(swings, `махов ${swings}, а сервер пропустит не больше ${possible}`).toBeLessThanOrEqual(possible);
  });

  it('обе руки бьют с одинаковой скоростью', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    // Проходим два удара серии и смотрим, как растянут каждый клип.
    const speeds: number[] = [];
    for (let i = 0; i < 2; i++) {
      model.beginAction('attack');
      model.update(1 / 60, IDLE_STATE);

      const clip = model.playing!;
      const action = model.actionFor(clip)!;
      // Сколько секунд идёт клип с учётом растяжения — это и есть темп удара.
      speeds.push(action.getClip().duration / action.timeScale);
      settle(model, totalOf('attack') + 0.4, IDLE_STATE);
    }

    expect(speeds[0]).toBeCloseTo(speeds[1]!, 3);
  });

  it('тяжёлый удар идёт медленнее лёгкого', () => {
    const light = createModel();
    settle(light, 1.2, IDLE_STATE);
    light.beginAction('attack');
    light.update(1 / 60, IDLE_STATE);
    const lightAction = light.actionFor(light.playing!)!;

    const heavy = createModel();
    settle(heavy, 1.2, IDLE_STATE);
    heavy.beginAction('heavy');
    heavy.update(1 / 60, IDLE_STATE);
    const heavyAction = heavy.actionFor(heavy.playing!)!;

    const seconds = (a: THREE.AnimationAction) => a.getClip().duration / a.timeScale;
    expect(seconds(heavyAction)).toBeGreaterThan(seconds(lightAction));
  });

  it('после удара руки возвращаются в стойку', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);
    model.beginAction('attack');
    settle(model, totalOf('attack') + 0.3, IDLE_STATE);
    expect(model.playing).toBe('idle');
  });

  it('в прыжке руки взмахивают, на земле возвращаются в стойку', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);
    expect(model.playing).toBe('idle');

    // Оторвались от земли — руки взмахивают.
    const air = { ...IDLE_STATE, onGround: false };
    model.update(1 / 60, air);
    expect(model.playing, 'нет взмаха в прыжке').toBe('equip');

    // Держится, пока летим, и не начинается заново каждый кадр.
    settle(model, 0.3, air);
    expect(model.playing).toBe('equip');

    // Приземлились — возвращаемся к стойке.
    settle(model, 1.5, IDLE_STATE);
    expect(model.playing).toBe('idle');
  });

  it('удар в прыжке важнее взмаха', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    const air = { ...IDLE_STATE, onGround: false };
    model.update(1 / 60, air);
    model.beginAction('attack');
    model.update(1 / 60, air);

    expect(model.playing === 'punchRight' || model.playing === 'punchLeft').toBe(true);
  });

  it('руки не уползают: в стойке плечи стоят на месте', () => {
    const model = createModel();
    settle(model, 1.2, IDLE_STATE);

    const shoulder = model.scene.getObjectByName('DEF-upper_armL')!;
    const before = shoulder.position.clone();

    // Полминуты покоя. Здесь и ломалось: разведение считалось от «позы,
    // которую выставил микшер», а стойка позицию плеча не трогает вовсе,
    // и сдвиг ложился сам на себя кадр за кадром. Руки уезжали за край экрана
    // и возвращались, только когда клип удара переписывал позицию.
    settle(model, 30, IDLE_STATE);

    expect(shoulder.position.distanceTo(before), 'плечо уползло').toBeLessThan(1e-6);
  });

  it('после смерти руки не рисуются', () => {
    const model = createModel();
    settle(model, 0.5, { ...IDLE_STATE, alive: false });
    expect(model.scene.visible).toBe(false);
  });

  it('стоимость стамины берётся из тех же правил, что и у сервера', () => {
    expect(ViewModel.staminaCost('attack')).toBe(ACTIONS.attack.staminaCost);
    expect(ViewModel.staminaCost('heavy')).toBe(ACTIONS.heavy.staminaCost);
    expect(ViewModel.staminaCost('dodge')).toBe(ACTIONS.dodge.staminaCost);
  });
});

function totalOf(kind: 'attack' | 'heavy'): number {
  const timing = ACTIONS[kind].timing;
  return timing.windup + timing.active + timing.recovery;
}
