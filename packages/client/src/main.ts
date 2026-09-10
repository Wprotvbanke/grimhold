import * as THREE from 'three';
import {
  INTERP_DELAY_MS,
  MAX_STEP_DT,
  CORPSE_SECONDS,
  MOBS,
  RACES,
  SKILLS,
  SPELLS,
  SPELL_BAR,
  TICK_MS,
  eyeHeight,
  type CharacterSummary,
  type CombatEvent,
  type EntitySnapshot,
  type ProjectileSnapshot,
} from '@grimhold/shared';
import { CombatUi } from './combatui.js';
import { Controls } from './controls.js';
import { EntityInterpolator, type InterpolatedPose } from './interpolation.js';
import {
  createCharacterModel,
  createMobModel,
  hasMobModel,
  hasModel,
  type CharacterModel,
} from './models.js';
import { Connection } from './net.js';
import { Predictor } from './prediction.js';
import {
  createAvatar,
  createMobMesh,
  createProjectileMesh,
  createScene,
  mobTagHeight,
  tagHeight,
} from './scene.js';
import { Ui } from './ui.js';
import { ViewModel } from './viewmodel.js';

const SERVER_URL = `ws://${location.hostname}:8080`;

const hud = document.getElementById('hud')!;
const labels = document.getElementById('labels')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// Руки рисуются вторым проходом поверх мира, поэтому очисткой управляем сами.
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

const world = createScene();
const scene = world.scene;
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';

/**
 * Свет от заклинания «Светоч». Держится на камере, поэтому светит туда же,
 * куда смотрит игрок. В подземелье это станет выбором: видеть или не выдавать себя.
 */
const lanternLight = new THREE.PointLight(0xffd9a0, 0, 16, 2);
camera.add(lanternLight);
scene.add(camera);

/** Всё, что появляется только после входа в мир конкретным персонажем. */
interface GameSession {
  character: CharacterSummary;
  predictor: Predictor;
  eye: number;
  /** Руки от первого лица: своя сцена, свои габариты под расу. */
  hands: ViewModel;
}

let game: GameSession | null = null;

const ui = new Ui({
  onLogin: (username, password) => {
    if (!username || !password) return ui.showAuth('Введите имя и пароль');
    connection.login(username, password);
  },
  onRegister: (username, password) => {
    if (username.length < 3) return ui.showAuth('Имя от 3 символов');
    if (password.length < 6) return ui.showAuth('Пароль от 6 символов');
    connection.register(username, password);
  },
  onCreateCharacter: (name, race, characterClass) => {
    if (name.length < 3) return ui.showCharacterError('Имя от 3 символов');
    connection.send({ t: 'createCharacter', name, race, characterClass });
  },
  onEnterWorld: (characterId) => connection.send({ t: 'enterWorld', characterId }),
  onChatSend: (channel, text) => connection.send({ t: 'chat', channel, text }),
});

const combatUi = new CombatUi(() => {
  connection.send({ t: 'respawn' });
  // Жест пользователя ещё «живой» — только здесь захват мыши и разрешён.
  controls.requestLock();
});

/**
 * Снапшот, который игрок видит прямо сейчас. Чужие рисуются с задержкой
 * интерполяции, поэтому «видимый» тик отстаёт от последнего полученного —
 * именно его сервер использует, чтобы отмотать цели при проверке попадания.
 */
function viewTick(): number {
  const latest = connection.latestSnapshot?.tick ?? 0;
  return Math.max(0, latest - Math.ceil(INTERP_DELAY_MS / TICK_MS));
}

const controls = new Controls(renderer.domElement, {
  onChatKey: (channel) => {
    if (!game) return;
    controls.suspended = true;
    document.exitPointerLock();
    ui.openChat(channel);
  },
  onLockChange: (locked) => {
    if (!game) return;
    // Пока чат открыт или игрок мёртв, пауза не показывается.
    ui.setPaused(!locked && !ui.chatFocused && !combatUi.dead);
    if (locked) controls.suspended = false;
  },
  onAction: (kind) => {
    if (!game || combatUi.dead) return;

    // Руки дёргаются сразу, не дожидаясь ответа сервера, — иначе удар
    // ощущается вязким. Но только если стамины хватает: правило то же,
    // по которому сервер откажет, поэтому картинка не обманет.
    const stamina = connection.latestSnapshot?.self.stamina ?? 0;
    if (stamina >= ViewModel.staminaCost(kind)) game.hands.beginAction(kind);

    connection.send({ t: 'action', kind, seq: actionSeq++, viewTick: viewTick() });
  },
  onBlock: (active) => {
    if (!game) return;
    connection.send({ t: 'block', active });
  },
  onCast: (index) => {
    if (!game || combatUi.dead) return;
    const spellId = SPELL_BAR[index];
    if (!spellId) return;

    // Перезарядку сервер проверит сам; здесь только чтобы не спамить впустую.
    const now = performance.now();
    if (!combatUi.isReady(spellId, now)) return;

    combatUi.markCast(spellId, now);
    game.hands.beginAction('cast');
    connection.send({ t: 'cast', spellId, viewTick: viewTick() });
    ui.system(`Читаешь: ${SPELLS[spellId].name}`);
  },
});

const connection = new Connection(SERVER_URL, {
  onAuthenticated: (username, characters, max) => ui.showCharacters(username, characters, max),
  onAuthError: (message) => ui.showCharacterError(message),
  onWelcome: (message) => startGame(message.character, message.spawn),
  onChat: (message) => ui.appendChat(message),
  onCombat: (event) => handleCombatEvent(event),
  onSkillUp: (message) =>
    ui.system(`Навык вырос: ${SKILLS[message.skill].name} → ${message.level}`),
  onLife: (message) => {
    if (message.event === 'died') {
      combatUi.showDeath(message.killerName);
      ui.setPaused(false);
      document.exitPointerLock();
    } else {
      combatUi.hideDeath();
      // Захват мыши уже запрошен при клике по кнопке. Если браузер его не дал,
      // покажем подсказку паузы вместо молчаливой невозможности двигаться.
      ui.setPaused(!controls.locked);
    }
  },
  onLoot: (message) => {
    const list = message.items.map((item) => `${item.name} ×${item.count}`).join(', ');
    ui.system(`С «${message.from}» выпало: ${list}`);
  },
  onDisconnected: () => {
    if (game) ui.system('Связь потеряна, переподключаюсь…');
  },
});

document.getElementById('pauseHint')!.addEventListener('click', () => {
  ui.setPaused(false);
  controls.requestLock();
});

interface Avatar {
  group: THREE.Group;
  placeholder: THREE.Group | null;
  model: CharacterModel | null;
  tag: HTMLDivElement;
  entity: EntitySnapshot;
  interpolator: EntityInterpolator;
  pose: InterpolatedPose;
  /** Секунд с момента смерти — по нему тело заваливается и оседает. */
  deathTime: number;
}

const avatars = new Map<string, Avatar>();
const projectiles = new Map<string, THREE.Object3D>();
const renderPos = { x: 0, y: 0, z: 0 };

let lastFrame = performance.now();
let lastSnapshotTick = -1;
let actionSeq = 0;

function startGame(character: CharacterSummary, spawn: { x: number; y: number; z: number }): void {
  const profile = RACES[character.race];
  const body = { radius: profile.radius, height: profile.height };

  game?.hands.dispose();

  game = {
    character,
    predictor: new Predictor(spawn, (x, z) => world.collidersAt(x, z), {
      body,
      speedScale: profile.speedScale,
    }),
    eye: eyeHeight(body),
    hands: new ViewModel(character.race),
  };

  renderPos.x = spawn.x;
  renderPos.y = spawn.y;
  renderPos.z = spawn.z;
  // Чанки под ногами должны существовать до первого шага симуляции.
  world.streamChunks(spawn.x, spawn.z);
  lastSnapshotTick = -1;

  ui.enterGame();
  combatUi.show(true);
  combatUi.hideDeath();
  ui.system(`Добро пожаловать, ${character.name}.`);
  ui.system('ЛКМ — удар, Shift+ЛКМ — тяжёлый, ПКМ — блок, C — рывок, 1…6 — заклинания.');
  ui.setPaused(true);
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, MAX_STEP_DT);
  lastFrame = now;

  if (game) {
    // 1. Ввод применяется немедленно и уходит на сервер.
    for (const input of game.predictor.collectInputs(dt, controls.sample())) {
      connection.send({ t: 'input', ...input });
    }

    // 2. Свежий снапшот поправляет предсказание и кормит интерполяцию.
    consumeSnapshot(now);

    // 3. Камера идёт по предсказанию с затухающей поправкой.
    game.predictor.renderPosition(dt, renderPos);
    camera.position.set(renderPos.x, renderPos.y + game.eye, renderPos.z);
    camera.rotation.y = controls.yaw;
    camera.rotation.x = controls.pitch;

    // 4. Чужие рисуются в прошлом, плавно между снапшотами.
    updateAvatars(now, dt);
    updateNametags();
    combatUi.updateCooldowns(now);

    // 5. Мир вокруг подгружается и выгружается по мере движения.
    world.streamChunks(renderPos.x, renderPos.z);

    // 6. Руки: поза берётся из авторитетного состояния, скорость — из предсказания.
    const self = connection.latestSnapshot?.self;

    // Свет «Светоча» плавно разгорается и гаснет по остатку времени с сервера.
    const wantLight = (self?.light ?? 0) > 0 ? 34 : 0;
    lanternLight.intensity += (wantLight - lanternLight.intensity) * Math.min(1, dt * 4);
    const velocity = game.predictor.state.vel;
    game.hands.update(dt, {
      action: self?.action ?? null,
      phase: self?.phase ?? null,
      blocking: controls.blocking,
      speed: Math.hypot(velocity.x, velocity.z),
      alive: self?.alive ?? true,
    });
  } else {
    // Пока идёт вход — медленный облёт города вместо чёрного экрана.
    world.streamChunks(0, 0);
    const angle = now / 9000;
    camera.position.set(Math.cos(angle) * 18, 6, Math.sin(angle) * 18);
    camera.lookAt(0, 1.5, 0);
  }

  world.update(now / 1000);

  renderer.clear();
  renderer.render(scene, camera);
  // Второй проход с очисткой глубины: руки не режутся о стены впритык.
  if (game && !combatUi.dead) game.hands.render(renderer, camera.aspect);

  updateHud(dt);
});

function consumeSnapshot(now: number): void {
  const snapshot = connection.latestSnapshot;
  if (!game || !snapshot || snapshot.tick === lastSnapshotTick) return;
  lastSnapshotTick = snapshot.tick;

  game.predictor.reconcile(snapshot.self, snapshot.ack);
  combatUi.updateVitals(snapshot.self);

  const seen = new Set<string>();
  for (const entity of snapshot.entities) {
    if (entity.id === connection.playerId) continue;
    seen.add(entity.id);
    ensureAvatar(entity).interpolator.push(entity, now);
  }

  for (const [id, avatar] of avatars) {
    if (seen.has(id)) continue;
    scene.remove(avatar.group);
    avatar.tag.remove();
    avatars.delete(id);
  }

  syncProjectiles(snapshot.projectiles);
}

/** Снаряды живут недолго — просто держим сцену в соответствии со снапшотом. */
function syncProjectiles(list: ProjectileSnapshot[]): void {
  const seen = new Set<string>();

  for (const projectile of list) {
    seen.add(projectile.id);
    let mesh = projectiles.get(projectile.id);
    if (!mesh) {
      mesh = createProjectileMesh(projectile.spellId);
      scene.add(mesh);
      projectiles.set(projectile.id, mesh);
    }
    mesh.position.set(projectile.x, projectile.y, projectile.z);
  }

  for (const [id, mesh] of projectiles) {
    if (seen.has(id)) continue;
    scene.remove(mesh);
    // Геометрию надо освобождать явно: за долгую сессию снарядов улетают сотни.
    mesh.traverse((node) => {
      const asMesh = node as THREE.Mesh;
      if (asMesh.isMesh) asMesh.geometry.dispose();
    });
    projectiles.delete(id);
  }
}

function ensureAvatar(entity: EntitySnapshot): Avatar {
  const existing = avatars.get(entity.id);
  if (existing) {
    existing.entity = entity;
    return existing;
  }

  const group = new THREE.Group();
  const placeholder =
    entity.kind === 'mob' && entity.mobId
      ? createMobMesh(entity.mobId)
      : createAvatar(entity.race);
  group.add(placeholder);
  scene.add(group);

  const tag = document.createElement('div');
  tag.className = 'nametag';
  tag.textContent = nameFor(entity);
  labels.appendChild(tag);

  const avatar: Avatar = {
    group,
    placeholder,
    model: null,
    tag,
    entity,
    interpolator: new EntityInterpolator(),
    pose: { x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw, speed: 0 },
    deathTime: 0,
  };
  avatars.set(entity.id, avatar);

  // Модель приезжает асинхронно; до неё существо стоит блокаут-заглушкой.
  const pending =
    entity.kind === 'mob' && entity.mobId
      ? hasMobModel(entity.mobId)
        ? createMobModel(entity.mobId)
        : null
      : hasModel(entity.race)
        ? createCharacterModel(entity.race)
        : null;

  if (pending) {
    void pending.then((model) => {
      if (!model || avatars.get(entity.id) !== avatar) return;
      if (avatar.placeholder) {
        avatar.group.remove(avatar.placeholder);
        avatar.placeholder = null;
      }
      model.root.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) node.castShadow = true;
      });
      avatar.group.add(model.root);
      avatar.model = model;
    });
  }

  return avatar;
}

function updateAvatars(now: number, dt: number): void {
  for (const avatar of avatars.values()) {
    avatar.interpolator.sample(now, avatar.pose);
    avatar.interpolator.prune(now);

    avatar.group.position.set(avatar.pose.x, avatar.pose.y, avatar.pose.z);
    avatar.group.rotation.y = avatar.pose.yaw;

    if (!avatar.entity.alive) {
      animateCorpse(avatar, dt);
      continue;
    }

    // Замах: модель, у которой есть клип атаки, отыгрывает его по-настоящему.
    const winding = avatar.entity.phase === 'windup';
    if (avatar.model?.has('attack') && winding) avatar.model.play('attack');

    // Живой — сбрасываем всё, что осталось от прошлой смерти.
    avatar.deathTime = 0;
    avatar.group.rotation.x = 0;
    avatar.group.rotation.z = 0;

    // У блокаут-заглушек замах показывается раздуванием: клипа атаки у них нет.
    avatar.group.scale.setScalar(winding && !avatar.model?.has('attack') ? 1.06 : 1);

    if (avatar.model) {
      if (!winding || !avatar.model.has('attack')) {
        avatar.model.play(avatar.pose.speed > 0.4 ? 'walk' : 'idle');
      }
      avatar.model.update(dt);
    }
  }
}

/**
 * Падение тела. Мгновенное исчезновение читалось как баг: непонятно,
 * добил ты противника или он убежал. Теперь тело заваливается набок,
 * оседает в землю и растворяется — сервер держит его в снапшотах
 * ровно столько, сколько идёт эта анимация.
 */
function animateCorpse(avatar: Avatar, dt: number): void {
  avatar.deathTime += dt;

  // У кого есть анимация смерти — тот падает по-настоящему, скелет в их числе.
  if (avatar.model?.has('death')) {
    avatar.model.play('death');
    avatar.model.update(dt);
  } else {
    const fall = Math.min(avatar.deathTime / 0.55, 1);
    // Пологая кривая: сначала резко, потом мягко — как настоящее падение.
    const eased = 1 - (1 - fall) * (1 - fall);
    avatar.group.rotation.z = eased * (Math.PI / 2);
  }

  // Последнюю секунду тело уходит в землю.
  const sinkStart = Math.max(0, avatar.deathTime - (CORPSE_SECONDS - 1.2));
  const sink = Math.min(sinkStart / 1.2, 1);
  const height = avatar.entity.mobId
    ? MOBS[avatar.entity.mobId].height
    : RACES[avatar.entity.race].height;
  avatar.group.position.y = avatar.pose.y - sink * height * 1.1;

  avatar.group.scale.setScalar(1);
  avatar.tag.style.display = 'none';
}

/** Ники видны только пока зажат Alt — в подземелье это будет частью напряжения. */
function updateNametags(): void {
  const projected = new THREE.Vector3();

  for (const avatar of avatars.values()) {
    // У мёртвых подписи нет: тело уже не цель.
    if (!controls.showNames || !avatar.entity.alive) {
      avatar.tag.style.display = 'none';
      continue;
    }

    projected.copy(avatar.group.position);
    projected.y +=
      avatar.entity.kind === 'mob' && avatar.entity.mobId
        ? mobTagHeight(avatar.entity.mobId)
        : tagHeight(avatar.entity.race);
    projected.project(camera);

    if (projected.z > 1) {
      avatar.tag.style.display = 'none';
      continue;
    }

    avatar.tag.textContent = nameFor(avatar.entity);
    avatar.tag.style.display = 'block';
    avatar.tag.style.left = `${((projected.x + 1) / 2) * innerWidth}px`;
    avatar.tag.style.top = `${((1 - projected.y) / 2) * innerHeight}px`;
  }
}

function handleCombatEvent(event: CombatEvent): void {
  const selfId = connection.playerId ?? '';
  combatUi.showEvent(event, projectToScreen(event.x, event.y, event.z), selfId);

  // Полоска цели: показываем, по кому попал именно ты.
  if (event.attackerId === selfId && event.targetId) {
    const target = avatars.get(event.targetId);
    if (target) combatUi.showTarget(nameFor(target.entity), target.entity.hp);
  }
}

/** Переводит мировую точку в экранную. Возвращает null, если она за спиной. */
function projectToScreen(x: number, y: number, z: number): { x: number; y: number } | null {
  const point = new THREE.Vector3(x, y, z).project(camera);
  if (point.z > 1) return null;
  return {
    x: ((point.x + 1) / 2) * innerWidth,
    y: ((1 - point.y) / 2) * innerHeight,
  };
}

function nameFor(entity: EntitySnapshot): string {
  if (entity.kind === 'mob' && entity.mobId) {
    const percent = Math.round(entity.hp * 100);
    return `${MOBS[entity.mobId].name} · ${percent}%`;
  }
  if (entity.kind === 'npc') return `${entity.name} · ${RACES[entity.race].name}`;
  return entity.name;
}

function updateHud(dt: number): void {
  if (!game || ui.inMenus) {
    hud.textContent = '';
    return;
  }

  const { pending, correction, rtt } = game.predictor.stats;
  const snapshot = connection.latestSnapshot;
  const pos = game.predictor.state.pos;

  hud.textContent =
    `${game.character.name} · ${RACES[game.character.race].name}\n` +
    `связь: ${connection.status}   пинг: ${rtt.toFixed(0)} мс\n` +
    `тик: ${snapshot?.tick ?? '—'}  ack: ${snapshot?.ack ?? '—'}  в полёте: ${pending}\n` +
    `поправка: ${(correction * 100).toFixed(1)} см\n` +
    `позиция: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}\n` +
    `рядом: ${avatars.size}   чанков: ${world.loadedChunks}   кадр: ${(1 / dt).toFixed(0)} fps`;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
