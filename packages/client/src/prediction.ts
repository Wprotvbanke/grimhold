import {
  INPUT_DT,
  type MoveInput,
  type MoveState,
  type SelfState,
  type Vec3,
  createMoveState,
  movementSpeedFactor,
  step,
  type Aabb,
  type SpeedModifiers,
} from '@grimhold/shared';

/** Коллизии вокруг точки. Мир чанковый, поэтому набор меняется по ходу движения. */
export type ColliderProvider = (x: number, z: number) => readonly Aabb[];

/**
 * Предсказание с реконсилиацией.
 *
 * Клиент не ждёт сервера: он применяет свой ввод немедленно и запоминает его.
 * Когда приходит снапшот с номером последнего обработанного ввода, клиент
 * ставит авторитетное состояние сервера и переигрывает поверх него все вводы,
 * которых сервер ещё не видел. Расхождение гасится плавно, а не рывком.
 *
 * Работает это только потому, что клиент и сервер зовут одну и ту же step().
 */

/** Расхождение больше этого — сервер явно прав, дёргаем мгновенно. */
const SNAP_DISTANCE = 2.5;
/** Скорость затухания видимой ошибки. */
const ERROR_DECAY = 12;

export interface PredictionStats {
  /** Сколько вводов ещё не подтверждено сервером. */
  pending: number;
  /** Модуль поправки, которую сервер внёс в последнем снапшоте. */
  correction: number;
  /** Оценка RTT по времени между отправкой ввода и его подтверждением. */
  rtt: number;
}

export class Predictor {
  state: MoveState;
  readonly stats: PredictionStats = { pending: 0, correction: 0, rtt: 0 };

  /** Неподтверждённые вводы — их и переигрываем после поправки. */
  private readonly pending: MoveInput[] = [];
  /** Время отправки каждого ввода, для оценки RTT. */
  private readonly sentAt = new Map<number, number>();
  /** Видимое смещение, гасящее рывок после поправки. */
  private readonly error = { x: 0, y: 0, z: 0 };
  private accumulator = 0;
  private seq = 0;
  private lastAck = -1;

  /**
   * Модификаторы скорости из намерения игрока.
   *
   * Сервер применяет блок, рывок, перегруз и стужу; если клиент о них не знает,
   * предсказание расходится при каждом поднятом щите, и сервер дёргает игрока
   * назад. Поэтому клиент считает ту же формулу по своему намерению — оно ему
   * известно мгновенно, а расхождение гасит реконсилиация.
   */
  private modifiers: Omit<SpeedModifiers, 'sprinting'> = {
    blocking: false,
    dashing: false,
    gliding: false,
    acting: false,
    slowFactor: 1,
    weightFactor: 1,
  };

  setModifiers(modifiers: Omit<SpeedModifiers, 'sprinting'>): void {
    this.modifiers = modifiers;
  }

  /**
   * Игрока перенесли: подземелье, воскрешение, портал.
   *
   * Это не поправка, а разрыв. Непринятые вводы относятся к прежнему месту
   * и переигрывать их здесь бессмысленно, а видимая ошибка обязана обнулиться:
   * иначе она секунду тянет картинку туда, откуда игрока уже забрали.
   */
  teleport(to: { x: number; y: number; z: number }): void {
    this.state.pos = { ...to };
    this.state.vel = { x: 0, y: 0, z: 0 };
    this.pending.length = 0;
    this.sentAt.clear();
    this.error.x = 0;
    this.error.y = 0;
    this.error.z = 0;
    this.stats.correction = 0;
  }

  /** Расовая скорость: множители состояния накладываются поверх неё. */
  private readonly baseSpeedScale: number;

  constructor(
    spawn: Vec3,
    private readonly colliders: ColliderProvider,
    options: { body?: MoveState['body']; speedScale?: number } = {},
  ) {
    this.state = createMoveState(spawn, options);
    this.baseSpeedScale = this.state.speedScale;
  }

  /**
   * Нарезает время кадра на фиксированные шаги и применяет их немедленно.
   * Возвращает вводы, которые надо отправить серверу.
   */
  collectInputs(
    dt: number,
    intent: {
      forward: number;
      right: number;
      jump: boolean;
      sprint: boolean;
      yaw: number;
      pitch: number;
    },
  ): MoveInput[] {
    this.accumulator = Math.min(this.accumulator + dt, INPUT_DT * 8);

    const produced: MoveInput[] = [];
    while (this.accumulator >= INPUT_DT) {
      this.accumulator -= INPUT_DT;

      const input: MoveInput = {
        seq: this.seq++,
        forward: intent.forward,
        right: intent.right,
        yaw: intent.yaw,
        pitch: intent.pitch,
        jump: intent.jump,
        sprint: intent.sprint,
        dt: INPUT_DT,
      };

      this.state = this.simulate(this.state, input);
      this.pending.push(input);
      this.sentAt.set(input.seq, performance.now());
      produced.push(input);
    }

    this.stats.pending = this.pending.length;
    return produced;
  }

  /** Принимает авторитетное состояние и переигрывает непринятые вводы. */
  reconcile(authoritative: SelfState, ack: number): void {
    if (ack < this.lastAck) return;
    this.lastAck = ack;

    const sent = this.sentAt.get(ack);
    if (sent !== undefined) {
      this.stats.rtt = performance.now() - sent;
    }

    // Чистим всегда, а не только при удачном замере: иначе записи о вводах,
    // которые сервер не подтвердил поимённо, копились бы всю сессию.
    for (const seq of this.sentAt.keys()) {
      if (seq <= ack) this.sentAt.delete(seq);
    }

    const before = { ...this.state.pos };

    // Отбрасываем всё, что сервер уже учёл.
    while (this.pending.length > 0 && this.pending[0]!.seq <= ack) {
      this.pending.shift();
    }

    this.state = {
      ...this.state,
      pos: { x: authoritative.x, y: authoritative.y, z: authoritative.z },
      vel: { x: authoritative.vx, y: authoritative.vy, z: authoritative.vz },
      onGround: authoritative.onGround,
    };

    // Переигрываем непринятое — иначе откатились бы в прошлое.
    for (const input of this.pending) {
      this.state = this.simulate(this.state, input);
    }

    const dx = before.x - this.state.pos.x;
    const dy = before.y - this.state.pos.y;
    const dz = before.z - this.state.pos.z;
    const distance = Math.hypot(dx, dy, dz);
    this.stats.correction = distance;

    if (distance > SNAP_DISTANCE) {
      // Слишком далеко — телепорт был осмысленным (или нас поправили жёстко).
      this.error.x = this.error.y = this.error.z = 0;
    } else {
      this.error.x += dx;
      this.error.y += dy;
      this.error.z += dz;
    }
  }

  /** Один шаг с теми же модификаторами скорости, что применяет сервер. */
  private simulate(state: MoveState, input: MoveInput): MoveState {
    const sprinting =
      input.sprint &&
      !this.modifiers.blocking &&
      !this.modifiers.acting &&
      (input.forward !== 0 || input.right !== 0);

    const factor = movementSpeedFactor({ ...this.modifiers, sprinting });
    const base = this.baseSpeedScale;

    const next = step(
      { ...state, speedScale: base * factor },
      input,
      this.colliders(state.pos.x, state.pos.z),
    );
    next.speedScale = base;
    return next;
  }

  /** Позиция для камеры: предсказание плюс затухающая поправка. */
  renderPosition(dt: number, out: { x: number; y: number; z: number }): void {
    const decay = Math.exp(-ERROR_DECAY * dt);
    this.error.x *= decay;
    this.error.y *= decay;
    this.error.z *= decay;

    out.x = this.state.pos.x + this.error.x;
    out.y = this.state.pos.y + this.error.y;
    out.z = this.state.pos.z + this.error.z;
  }
}
