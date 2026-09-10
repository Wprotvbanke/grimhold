import * as THREE from 'three';
import {
  ACTIONS,
  RACES,
  WALK_SPEED,
  type ActionKind,
  type ActionPhase,
  type Race,
} from '@grimhold/shared';

/**
 * Руки от первого лица.
 *
 * Рисуются в отдельной сцене поверх мира с очисткой буфера глубины — иначе
 * при подходе к стене руки уезжали бы внутрь геометрии. Это стандартное
 * решение для видмодели в шутерах, и здесь оно нужно ровно по той же причине.
 *
 * Анимация привязана к фазам действия из combat.ts — тем самым, по которым
 * сервер проверяет попадание. Поэтому картинка не врёт: удар виден именно
 * тогда, когда он засчитывается.
 */

export interface ViewModelState {
  action: ActionKind | null;
  phase: ActionPhase | null;
  blocking: boolean;
  /** Горизонтальная скорость — по ней качаются руки при ходьбе. */
  speed: number;
  alive: boolean;
}

/** Поза руки: углы в плече и локте плюс смещение всей руки. */
interface ArmPose {
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  elbow: number;
  offsetZ: number;
  offsetY: number;
}

const IDLE_RIGHT: ArmPose = {
  shoulderX: -0.55,
  shoulderY: -0.35,
  shoulderZ: 0.18,
  elbow: 1.15,
  offsetZ: 0,
  offsetY: 0,
};

const IDLE_LEFT: ArmPose = {
  shoulderX: -0.45,
  shoulderY: 0.4,
  shoulderZ: -0.2,
  elbow: 1.05,
  offsetZ: 0,
  offsetY: 0,
};

/** Замах: кулак уходит назад и вверх — это видимый сигнал удара. */
const WINDUP_RIGHT: ArmPose = {
  shoulderX: -1.65,
  shoulderY: -0.75,
  shoulderZ: 0.55,
  elbow: 2.1,
  offsetZ: 0.12,
  offsetY: 0.05,
};

/** Удар: рука выброшена вперёд. */
const STRIKE_RIGHT: ArmPose = {
  shoulderX: 0.35,
  shoulderY: -0.12,
  shoulderZ: -0.1,
  elbow: 0.12,
  offsetZ: -0.34,
  offsetY: -0.02,
};

/** Блок: обе руки подняты перед лицом. */
const BLOCK_RIGHT: ArmPose = {
  shoulderX: -1.15,
  shoulderY: -0.15,
  shoulderZ: 0.5,
  elbow: 2.0,
  offsetZ: -0.1,
  offsetY: 0.14,
};

const BLOCK_LEFT: ArmPose = {
  shoulderX: -1.2,
  shoulderY: 0.2,
  shoulderZ: -0.55,
  elbow: 1.95,
  offsetZ: -0.16,
  offsetY: 0.16,
};

/** Рывок: руки прижаты. */
const DODGE_ARM: ArmPose = {
  shoulderX: -1.0,
  shoulderY: -0.2,
  shoulderZ: 0.3,
  elbow: 2.3,
  offsetZ: 0.08,
  offsetY: -0.12,
};

/** Каст: ладонь вперёд, в ней разгорается свет. */
const CAST_LEFT: ArmPose = {
  shoulderX: 0.1,
  shoulderY: 0.35,
  shoulderZ: -0.35,
  elbow: 0.55,
  offsetZ: -0.22,
  offsetY: 0.08,
};

interface Arm {
  root: THREE.Group;
  shoulder: THREE.Group;
  forearm: THREE.Group;
  hand: THREE.Mesh;
  pose: ArmPose;
}

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);

  private readonly right: Arm;
  private readonly left: Arm;
  private readonly castGlow: THREE.PointLight;

  /** Локальная фаза действия: анимация стартует по клику, не дожидаясь сервера. */
  private localAction: { kind: ActionKind; elapsed: number } | null = null;
  /** Последнее действие, о котором сообщил сервер — чтобы ловить смену, а не наличие. */
  private lastServerAction: ActionKind | null = null;
  private bobPhase = 0;

  constructor(race: Race) {
    const profile = RACES[race];

    // Дворф коренастее и руки у него толще и короче, эльф — наоборот.
    const scale = profile.height / 1.8;
    const thickness = profile.radius / 0.35;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffe6c4, 2.2);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb0d8, 0.9);
    rim.position.set(0.8, 0.2, -0.6);
    this.scene.add(rim);

    this.right = this.buildArm(1, scale, thickness, profile.color);
    this.left = this.buildArm(-1, scale, thickness, profile.color);
    this.scene.add(this.right.root, this.left.root);

    this.castGlow = new THREE.PointLight(0x9ec8ff, 0, 1.2, 2);
    this.left.hand.add(this.castGlow);
  }

  /** Начать анимацию немедленно по нажатию — до ответа сервера. */
  beginAction(kind: ActionKind): void {
    this.localAction = { kind, elapsed: 0 };
  }

  /** Хватает ли стамины: те же числа, по которым решает сервер. */
  static staminaCost(kind: 'attack' | 'heavy' | 'dodge'): number {
    return ACTIONS[kind].staminaCost;
  }

  update(dt: number, state: ViewModelState): void {
    if (this.localAction) {
      this.localAction.elapsed += dt;
      if (this.localAction.elapsed > totalDuration(this.localAction.kind)) {
        this.localAction = null;
      }
    }

    /**
     * Сервер отстаёт на полпинга: к моменту, когда он сообщает «бью»,
     * локальная анимация уже идёт, а когда она закончилась — он всё ещё
     * может сообщать о том же ударе. Поэтому реагируем только на смену
     * действия, а не на его наличие: иначе руки махали бы дважды.
     */
    if (state.action !== this.lastServerAction) {
      if (state.action && !this.localAction) {
        this.localAction = { kind: state.action, elapsed: 0 };
      }
      this.lastServerAction = state.action;
    }

    const kind = this.localAction?.kind ?? null;
    const phase = kind ? localPhase(kind, this.localAction!.elapsed) : null;

    // Покачивание при ходьбе. Без него руки выглядят приклеенными к экрану.
    this.bobPhase += dt * (4 + (state.speed / WALK_SPEED) * 7);
    const bobAmount = Math.min(state.speed / WALK_SPEED, 1) * 0.022;
    const bobY = Math.sin(this.bobPhase * 2) * bobAmount;
    const bobX = Math.cos(this.bobPhase) * bobAmount * 1.3;

    const targetRight = this.rightTarget(kind, phase, state);
    const targetLeft = this.leftTarget(kind, phase, state);

    // Удар должен быть резким, возврат — плавным: разная скорость подхода.
    const snap = phase === 'active' ? 34 : 13;
    applyPose(this.right, targetRight, dt, snap, bobX, bobY);
    applyPose(this.left, targetLeft, dt, snap, -bobX, bobY);

    // Свет в ладони разгорается по мере чтения заклинания.
    const casting = kind === 'cast';
    const target = casting ? 2.4 : 0;
    this.castGlow.intensity += (target - this.castGlow.intensity) * Math.min(1, dt * 8);

    this.scene.visible = state.alive;
  }

  /** Рисует руки поверх мира, очистив глубину, чтобы они не резались стенами. */
  render(renderer: THREE.WebGLRenderer, aspect: number): void {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  private rightTarget(kind: ActionKind | null, phase: ActionPhase | null, state: ViewModelState): ArmPose {
    if (kind === 'dodge') return DODGE_ARM;
    if (state.blocking) return BLOCK_RIGHT;

    if (kind === 'attack' || kind === 'heavy') {
      if (phase === 'windup') return WINDUP_RIGHT;
      if (phase === 'active') return STRIKE_RIGHT;
      // Восстановление: рука возвращается через промежуточное положение.
      return mixPose(STRIKE_RIGHT, IDLE_RIGHT, 0.5);
    }

    return IDLE_RIGHT;
  }

  private leftTarget(kind: ActionKind | null, phase: ActionPhase | null, state: ViewModelState): ArmPose {
    if (kind === 'cast') return CAST_LEFT;
    if (kind === 'dodge') return { ...DODGE_ARM, shoulderY: -DODGE_ARM.shoulderY, shoulderZ: -DODGE_ARM.shoulderZ };
    if (state.blocking) return BLOCK_LEFT;

    // При замахе левая рука уходит чуть вперёд — корпус разворачивается.
    if ((kind === 'attack' || kind === 'heavy') && phase === 'windup') {
      return { ...IDLE_LEFT, shoulderX: -0.7, offsetZ: -0.08 };
    }

    return IDLE_LEFT;
  }

  private buildArm(side: 1 | -1, scale: number, thickness: number, color: number): Arm {
    const skin = new THREE.MeshLambertMaterial({ color: shade(color, 1.25) });
    const sleeve = new THREE.MeshLambertMaterial({ color: shade(color, 0.65) });

    const upperLength = 0.3 * scale;
    const foreLength = 0.34 * scale;
    const radius = 0.055 * scale * thickness;

    const root = new THREE.Group();
    root.position.set(side * 0.22 * scale * thickness, -0.28 * scale, -0.12);

    const shoulder = new THREE.Group();
    root.add(shoulder);

    const upper = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius * 1.05, upperLength, 3, 8),
      sleeve,
    );
    // Капсула растёт по Y, а рука должна идти вперёд — отсюда поворот.
    upper.rotation.x = Math.PI / 2;
    upper.position.z = -upperLength / 2;
    shoulder.add(upper);

    const forearm = new THREE.Group();
    forearm.position.z = -upperLength;
    shoulder.add(forearm);

    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(radius, foreLength, 3, 8), skin);
    lower.rotation.x = Math.PI / 2;
    lower.position.z = -foreLength / 2;
    forearm.add(lower);

    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2.3, radius * 2.1, radius * 2.4),
      skin,
    );
    hand.name = side === 1 ? 'hand-right' : 'hand-left';
    hand.position.z = -foreLength - radius * 0.8;
    forearm.add(hand);

    const pose: ArmPose = side === 1 ? { ...IDLE_RIGHT } : { ...IDLE_LEFT };
    return { root, shoulder, forearm, hand, pose };
  }
}

function applyPose(
  arm: Arm,
  target: ArmPose,
  dt: number,
  speed: number,
  bobX: number,
  bobY: number,
): void {
  const t = 1 - Math.exp(-speed * dt);

  arm.pose.shoulderX += (target.shoulderX - arm.pose.shoulderX) * t;
  arm.pose.shoulderY += (target.shoulderY - arm.pose.shoulderY) * t;
  arm.pose.shoulderZ += (target.shoulderZ - arm.pose.shoulderZ) * t;
  arm.pose.elbow += (target.elbow - arm.pose.elbow) * t;
  arm.pose.offsetZ += (target.offsetZ - arm.pose.offsetZ) * t;
  arm.pose.offsetY += (target.offsetY - arm.pose.offsetY) * t;

  arm.shoulder.rotation.set(arm.pose.shoulderX, arm.pose.shoulderY, arm.pose.shoulderZ);
  arm.forearm.rotation.x = arm.pose.elbow;

  const base = arm.root.userData.base as { x: number; y: number; z: number } | undefined;
  if (!base) {
    arm.root.userData.base = {
      x: arm.root.position.x,
      y: arm.root.position.y,
      z: arm.root.position.z,
    };
  }
  const origin = arm.root.userData.base as { x: number; y: number; z: number };
  arm.root.position.set(
    origin.x + bobX,
    origin.y + bobY + arm.pose.offsetY,
    origin.z + arm.pose.offsetZ,
  );
}

function mixPose(a: ArmPose, b: ArmPose, k: number): ArmPose {
  return {
    shoulderX: a.shoulderX + (b.shoulderX - a.shoulderX) * k,
    shoulderY: a.shoulderY + (b.shoulderY - a.shoulderY) * k,
    shoulderZ: a.shoulderZ + (b.shoulderZ - a.shoulderZ) * k,
    elbow: a.elbow + (b.elbow - a.elbow) * k,
    offsetZ: a.offsetZ + (b.offsetZ - a.offsetZ) * k,
    offsetY: a.offsetY + (b.offsetY - a.offsetY) * k,
  };
}

/** Фазы берутся из тех же таймингов, по которым сервер считает удар. */
function localPhase(kind: ActionKind, elapsed: number): ActionPhase {
  const timing = timingFor(kind);
  if (elapsed < timing.windup) return 'windup';
  if (elapsed < timing.windup + timing.active) return 'active';
  return 'recovery';
}

function totalDuration(kind: ActionKind): number {
  const timing = timingFor(kind);
  return timing.windup + timing.active + timing.recovery;
}

function timingFor(kind: ActionKind) {
  if (kind === 'attack') return ACTIONS.attack.timing;
  if (kind === 'heavy') return ACTIONS.heavy.timing;
  if (kind === 'dodge') return ACTIONS.dodge.timing;
  // Блок и каст держатся сервером; для рук хватает короткого цикла.
  return { windup: 0.5, active: 0.1, recovery: 0.4 };
}

/** Осветляет или затемняет цвет расы — для кожи и рукава. */
function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}
