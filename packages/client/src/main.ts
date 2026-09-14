import * as THREE from 'three';
import {
  BAG_RANGE,
  BANK,
  CHEST_HEIGHT,
  CHEST_RANGE,
  CHEST_SIZE,
  dungeonChests,
  dungeonSeed,
  isDungeon,
  DUNGEON_EXIT,
  DUNGEON_EXIT_RANGE,
  floorOf,
  stairsDown,
  stairsUp,
  DUNGEON_GATE,
  FLAG_COLORS,
  DASH_WEIGHT_LIMIT,
  DAY_START,
  INTERP_DELAY_MS,
  MAX_STEP_DT,
  CORPSE_SECONDS,
  MOBS,
  NODES,
  RACES,
  SKILLS,
  itemDef,
  type ItemId,
  TICK_MS,
  eyeHeight,
  sunHeight,
  timeOfDay,
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
  createProjectileLights,
  createBagMesh,
  createProjectileMesh,
  createScene,
  setAnisotropy,
  mobTagHeight,
  tagHeight,
} from './scene.js';
import { createAdmin } from './admin.js';
import { TORCH_LIGHT, createCarriedLights, flicker, makeHalo } from './lights.js';
import { InventoryUi } from './inventoryui.js';
import { guardBrowserKeys, toggleFullCapture, wireFullCapture } from './keyboard.js';
import { createQuality } from './quality.js';
import { createFrameStats } from './frames.js';
import { createSettings, loadSettings } from './settings.js';
import { createSound } from './sound.js';
import { createCues } from './cues.js';
import { createSteps, surfaceAt, type Walker } from './steps.js';
import { createAtmosphere } from './atmosphere.js';
import { createLabour, labourForWork, type Worker } from './labour.js';
import { createShowcase } from './showcase.js';
import { Ui } from './ui.js';
import { ViewModel } from './viewmodel.js';

const SERVER_URL = `ws://${location.hostname}:8080`;

const hud = document.getElementById('hud')!;
const labels = document.getElementById('labels')!;

/**
 * Сглаживание краёв читается из сохранённых настроек до всего остального:
 * поменять его у готового рендерера нельзя, только при создании.
 */
const renderer = new THREE.WebGLRenderer({ antialias: loadSettings().antialias });
renderer.setSize(innerWidth, innerHeight);
// Разрешение задаёт quality.ts: оно отступает при просадке и возвращается,
// когда запас появился. Постоянное число тут подходило бы ровно одной машине.
const quality = createQuality(renderer);
renderer.shadowMap.enabled = true;
/**
 * Тени: обычный PCF, а не мягкий.
 *
 * `PCFSoftShadowMap` в этой версии three удалён — он молча подменялся на
 * обычный и писал предупреждение в каждый запуск. Пишем то, что получаем
 * на самом деле; мягкость, если понадобится, придётся добирать разрешением
 * карты и смещением, а не этим флагом.
 */
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// Руки рисуются вторым проходом поверх мира, поэтому очисткой управляем сами.
renderer.autoClear = false;
// Счётчики отрисовки считаем за весь кадр, а не за последний проход:
// сбрасываем их сами, в начале кадра.
renderer.info.autoReset = false;
document.body.appendChild(renderer.domElement);

// Потолок анизотропии — у видеокарты свой; берём её предел, а не число
// из головы: на ходу слабая фильтрация земли читается как дрожь картинки.
setAnisotropy(renderer.capabilities.getMaxAnisotropy());

const world = createScene();
const scene = world.scene;
/** Пробная модель на площади — см. showcase.ts. */
const showcase = createShowcase(scene);

/** Лампы снарядов: пул постоянного размера, см. scene.ts. */
const projectileLights = createProjectileLights(scene);

/**
 * Лампы для чужих факелов и список тех, кому они достанутся.
 *
 * Список переиспользуется, а не собирается заново каждый кадр: это кадр
 * за кадром, и мусор отсюда потом аукается рывками сборки.
 */
const carriedLights = createCarriedLights(scene);
const carried: { x: number; y: number; z: number }[] = [];

/** Частота тика сервера: из неё выводится время суток. Придёт с приветствием. */
let serverTickRate = 1000 / TICK_MS;

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';

/**
 * Свет от заклинания «Светоч». Держится на камере, поэтому светит туда же,
 * куда смотрит игрок. В подземелье это станет выбором: видеть или не выдавать себя.
 */
const lanternLight = new THREE.PointLight(0xffd9a0, 0, 16, 2);
camera.add(lanternLight);
scene.add(camera);

/**
 * Звук. Слушатель сидит на камере: слышно оттуда, откуда видно.
 *
 * Заводится до настроек — сохранённая громкость применяется сразу, как только
 * они создадутся, и к этому моменту ей должно быть к чему примениться.
 */
const sound = createSound(camera, scene);

/** Звуки боя: что звучит на какое событие — и как одному замаху не звучать очередью. */
const cues = createCues(sound);

/** Шаги: свои и всех, кто рядом, — по пройденному, а не по таймеру. */
const steps = createSteps(sound);

/**
 * Кто сейчас идёт рядом — для чужих шагов.
 *
 * Список переиспользуется, а не собирается заново: он обновляется каждый
 * кадр, и мусор отсюда аукался бы рывками сборки — как у `carried`.
 */
const walkers: Walker[] = [];

/** Дальше этого чужие шаги не слышны — и голоса не просят. */
const STEP_RANGE = 20;

/** Звуки вылазки: фон по месту, свой огонь, гонг хозяина глубины, порталы, отдышка. */
const atmosphere = createAtmosphere(sound);

/** Звук работы: удары топора, кирки и замка — свои и соседей. */
const labour = createLabour(sound);

/** Кто рядом работает — для чужих ударов. Переиспользуется, как `walkers`. */
const workers: Worker[] = [];

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

/**
 * Рюкзак. Пока он открыт, захват мыши отпущен — иначе нельзя перетаскивать
 * вещи, а движение в это время только мешало бы.
 */
const inventoryUi = new InventoryUi({
  onMove: (fromX, fromY, toX, toY, rotate) =>
    connection.send({ t: 'moveItem', fromX, fromY, toX, toY, rotate }),
  onEquip: (x, y) => connection.send({ t: 'equip', x, y }),
  onAssignHotbar: (index, itemId) => connection.send({ t: 'setHotbar', index, itemId }),
  onUseHotbar: (index) => useHotbar(index),
  onUnequip: (slot, to) =>
    connection.send({ t: 'unequip', slot, toX: to?.x, toY: to?.y, rotate: to?.rotate }),
  onUse: (x, y) => connection.send({ t: 'useItem', x, y }),
  onDrop: (x, y) => connection.send({ t: 'dropItem', x, y }),
  onCraft: (recipeId) => connection.send({ t: 'craft', recipeId }),
  onDeposit: (x, y, to) =>
    connection.send({ t: 'bankMove', dir: 'deposit', x, y, toX: to?.x, toY: to?.y, rotate: to?.rotate }),
  onWithdraw: (x, y, to) =>
    connection.send({ t: 'bankMove', dir: 'withdraw', x, y, toX: to?.x, toY: to?.y, rotate: to?.rotate }),
  onSpendPoint: (into) => connection.send({ t: 'spendPoint', into }),
  onBankArrange: (x, y, toX, toY, rotate) =>
    connection.send({ t: 'bankMove', dir: 'arrange', x, y, toX, toY, rotate }),
  onTradeOffer: (x, y) => connection.send({ t: 'tradeOffer', x, y }),
  onTradeWithdraw: (index) => connection.send({ t: 'tradeWithdraw', index }),
  onTradeLock: (locked) => connection.send({ t: 'tradeLock', locked }),
  onTradeRespond: (accept) => connection.send({ t: 'tradeRespond', accept }),
  onTradeCancel: () => connection.send({ t: 'tradeCancel' }),
  onClose: () => {
    // Закрыл рюкзак — закрыл и сундук: держать казну открытой из диких земель
    // сервер всё равно не даст.
    if (bankOpen) connection.send({ t: 'closeBank' });
    controls.suspended = false;
    if (game && !combatUi.dead) ui.setResumeHint(!controls.locked);
  },
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
    // Подсказка вместо экрана паузы: мир видно всегда.
    ui.setResumeHint(!locked && !ui.chatFocused && !combatUi.dead && !inventoryUi.open);
    if (locked) controls.suspended = false;

    /**
     * Меню настроек **само не открывается**.
     *
     * Раньше оно всплывало на отпускание мыши — это должно было изображать
     * «нажал Escape». Но мышь отпускается и сама: при переключении на другое
     * окно, при сворачивании браузера, при любом уходе фокуса, — и человек,
     * вернувшись в игру, каждый раз заставал меню посреди экрана.
     *
     * Открывает его теперь F1 и только он: это нажатие принадлежит игре
     * и не значит ничего другого.
     */
    if (locked) settings.hide();
  },
  onAction: (kind) => {
    if (!game || combatUi.dead) return;

    // Руки дёргаются сразу, не дожидаясь ответа сервера, — иначе удар
    // ощущается вязким. Но по тем же правилам, по которым откажет сервер:
    // хватает ли стамины и вышла ли пауза после прошлого удара. Иначе
    // анимацию можно спамить вхолостую — бьёшь, а урона и траты нет.
    // Рывок под тяжестью не пройдёт — скажем об этом сразу, а не молча.
    // Молчаливый отказ игрок читает как залипшую клавишу.
    if (kind === 'dodge' && !dashAllowed) {
      ui.system('Слишком тяжело для рывка — сбрось груз');
      return;
    }

    const stamina = connection.latestSnapshot?.self.stamina ?? 0;
    if (stamina < ViewModel.staminaCost(kind, evasionLevel) || !game.hands.beginAction(kind)) {
      return;
    }

    // Звук — там же, где руки: сразу и по тем же правилам, по которым пройдёт
    // удар. Отказанный удар молчит так же, как молчат руки.
    const bowInHand = mainHandItem !== null && itemDef(mainHandItem as ItemId).skill === 'archery';
    cues.ownAction(kind, bowInHand);

    connection.send({ t: 'action', kind, seq: actionSeq++, viewTick: viewTick() });
  },
  onBlock: (active) => {
    if (!game) return;
    connection.send({ t: 'block', active });
  },
  onHotbar: (index) => useHotbar(index),
  onHarvest: () => {
    if (!game || combatUi.dead) return;
    // E — единственная клавиша взаимодействия. У казны она открывает сундук,
    // в лесу бьёт по ноде: игроку не нужно помнить две.
    if (aimedPlace === 'vault') {
      opening = 'vault';
      connection.send({ t: 'openBank' });
      return;
    }
    if (aimedPlace === 'descent') {
      connection.send({ t: 'enterDungeon' });
      return;
    }
    if (aimedPlace === 'portal') {
      connection.send({ t: 'leaveDungeon' });
      return;
    }
    if (aimedPlace === 'stairsDown' || aimedPlace === 'stairsUp') {
      connection.send({ t: 'stairs', down: aimedPlace === 'stairsDown' });
      return;
    }
    if (aimedBag) {
      opening = 'bag';
      connection.send({ t: 'openBag', bagId: aimedBag });
      return;
    }
    if (aimedChest) {
      connection.send({ t: 'openChest', chestId: aimedChest });
      return;
    }
    if (aimedNode) connection.send({ t: 'harvest', nodeId: aimedNode });
  },
  /**
   * Одна клавиша на всё, что касается отряда.
   *
   * Смотришь на человека — зовёшь; зовут тебя — принимаешь. Две клавиши здесь
   * были бы двумя, о которых надо помнить, а зовут и принимают в игре раз
   * за вылазку.
   */
  onParty: () => {
    if (!game || combatUi.dead) return;
    const target = playerInFront();
    // Смотришь на человека — зовёшь; смотришь в пустоту — принимаешь. Признака
    // «мне пришло приглашение» клиент не держит: кто кого звал, помнит сервер,
    // и он же ответит, если звать было некому.
    connection.send(
      target
        ? { t: 'party', action: 'invite', targetId: target.id }
        : { t: 'party', action: 'accept' },
    );
  },
  onTrade: () => {
    if (!game || combatUi.dead || tradeOpen) return;
    const target = playerInFront();
    if (!target) {
      ui.system('Рядом никого нет — подойди ближе и смотри на человека');
      return;
    }
    connection.send({ t: 'tradeInvite', targetId: target.id });
    ui.system(`Предложил обмен: ${target.name ?? 'игрок'}`);
  },
});

const connection = new Connection(SERVER_URL, {
  onAuthenticated: (username, characters, max) => ui.showCharacters(username, characters, max),
  onAuthError: (message) => ui.showCharacterError(message),
  onWelcome: (message) => {
    // Частота тика нужна часам мира: время суток выводится из номера тика.
    serverTickRate = message.tickRate;
    // Стрелки могли перевести до входа — иначе у вошедшего был бы свой час.
    daytimeShift = message.daytimeShift;
    adminUi.allow(message.admin);
    startGame(message.character, message.spawn);
  },
  onChat: (message) => ui.appendChat(message),
  onCombat: (event) => handleCombatEvent(event),
  onSkillUp: (message) => {
    ui.system(`Навык вырос: ${SKILLS[message.skill].name} → ${message.level}`);
    // Рост слышен: строку в чате посреди боя легко пропустить, звук — нет.
    sound.play('skillUp');
  },
  onLife: (message) => {
    if (message.event === 'died') {
      combatUi.showDeath(message.killerName, message.respawnIn ?? 0);
      ui.setResumeHint(false);
      document.exitPointerLock();
      // Факел гаснет вместе с жизнью — и его треск тоже, не дожидаясь снапшота.
      atmosphere.died();
    } else {
      combatUi.hideDeath();
      // Захват мыши уже запрошен при клике по кнопке. Если браузер его не дал,
      // подсказка объяснит, что делать.
      ui.setResumeHint(!controls.locked);
    }
  },
  onLoot: (message) => {
    const list = message.items.map((item) => `${item.name} ×${item.count}`).join(', ');
    if (list && message.onGround) {
      // Мешок на земле — это ещё не добыча: сказать надо ровно это, иначе
      // игрок решит, что вещи уже у него, и уйдёт.
      ui.system(`${message.from} оставил мешок: ${list}`);
    } else if (list) {
      ui.system(`С «${message.from}»: ${list}`);
      // Руки тянутся и забирают добычу — видно, что она попала именно к тебе.
      game?.hands.playTake();
      // И слышно: монеты звенят, остальное шуршит.
      sound.play(message.items.some((item) => item.itemId === 'coin') ? 'coins' : 'pickup');
    }
    // Не влезшее в рюкзак теряется — об этом надо сказать прямо.
    if (message.lost > 0) {
      ui.system(`Рюкзак полон, потеряно предметов: ${message.lost}`);
    }
  },
  onInventory: (message) => {
    inventoryUi.update(message);
    // Что в руке — нужно подсказке у ресурсных нод: киркой жилу берут,
    // мечом нет, и игрок должен видеть это до того, как замахнётся.
    mainHandItem = message.equipment.mainHand?.defId ?? null;
    // У лука своё движение выстрела — рукам надо знать, что он в руке.
    game?.hands.setWeapon(mainHandItem);
    // Что в левой руке — по нему клиент решает, каким светом светить:
    // пламенем факела или ровным светом «Светоча».
    offHandItem = message.equipment.offHand?.defId ?? null;
    // Рывок пропадает раньше скорости: вес должен быть выбором, а не штрафом.
    dashAllowed = message.weight <= message.capacity * DASH_WEIGHT_LIMIT;
    // Перегруз замедляет, и предсказание обязано знать об этом сразу,
    // иначе сервер начнёт дёргать игрока назад на каждом шаге.
    weightFactor = weightSpeedFactorFor(message.weight, message.capacity);
  },
  onTrade: (message) => {
    tradeOpen = message.stage === 'open' || message.stage === 'invited';
    if (tradeOpen) openInventory();
    inventoryUi.setTrade(message);
    if (message.note) ui.system(message.note);
  },
  onBank: (message) => {
    // Казна открывается тем же люком, что и спуск в подземелье, мешок
    // павшего — как свой рюкзак. Только на открытии: переложенная вещь
    // присылает хранилище заново.
    if (message.open && !bankOpen) {
      sound.play(opening === 'bag' ? 'backpack' : 'transition');
      opening = null;
    }
    bankOpen = message.open;
    // Сундук открывают из мира: курсор надо вернуть до того, как рисовать
    // казну, иначе панель видно, а взять из неё нечем.
    if (message.open) openInventory();
    inventoryUi.setBank(message);
  },
  onCrafting: (message) => {
    inventoryUi.setCrafting(message);
    // Ремесло звучит ударами, пока идёт полоса. Звука «готово» нет намеренно:
    // сообщение не отличает готовое изделие от прерванной работы, и он соврал бы.
    if (message.recipeId) {
      game?.hands.beginWork(message.remaining);
      labour.begin('craft');
    } else {
      game?.hands.endWork();
      labour.end();
    }
  },
  onProgress: (message) => {
    inventoryUi.setProgress(message);
    // Рывок зависит от уклонения, и клиент обязан знать уровень: иначе он
    // откажет в броске, который сервер разрешает.
    evasionLevel = message.skills.find((entry) => entry.skill === 'evasion')?.level ?? 0;
    game?.hands.setEvasion(evasionLevel);
  },
  onDaytime: (shift) => {
    daytimeShift = shift;
  },
  onWorld: (message) => {
    /**
     * Переезд между мирами.
     *
     * Предсказание надо посадить в новую точку до первого же кадра: иначе
     * оно секунду тянет игрока обратно, в место, которого в этом инстансе
     * нет, — и человек видит, как его выдёргивает из зала в пустоту.
     */
    world.setInstance(message.instanceId);
    if (game) {
      game.predictor.teleport(message.spawn);
      world.streamChunks(message.spawn.x, message.spawn.z);
    }
    // Переезд слышен — спуск, лестница, портал, воскрешение. И звуки забывают
    // прошлый мир: жив ли там был хозяин глубины, к новому отношения не имеет.
    atmosphere.moved();
    undergroundNow = message.instanceId !== 'overworld';
    dungeonSeedNow = isDungeon(message.instanceId) ? dungeonSeed(message.instanceId) : null;
    // Чужой забег к новому отношения не имеет: список вскрытого придёт заново.
    openedChests.clear();
    chestsKnown = false;
    aimedChest = null;
    syncBags([]);
    // Сервер представит всех заново: память о знакомых относилась к прежнему
    // миру, и держать её — значит однажды подписать чужого человека чужим
    // именем.
    identities.clear();
  },
  onGathering: (message) => {
    ui.setGathering(message);
    // Полоса идёт — руки должны работать, а не висеть неподвижно. И звучать:
    // топор рубит, кирка бьёт, замок сундука щёлкает.
    if (message.nodeId) {
      game?.hands.beginWork(message.remaining);
      labour.begin(labourForWork(message.nodeId));
    } else {
      game?.hands.endWork();
      labour.end();
    }
  },
  onItemError: (message) => inventoryUi.showError(message),
  onDisconnected: () => {
    if (game) ui.system('Связь потеряна, переподключаюсь…');
  },
});

/**
 * Ячейка панели. Что произойдёт — надеть, применить или прочесть заклинание —
 * решает сервер по виду предмета; клиент шлёт только номер ячейки.
 */
function useHotbar(index: number): void {
  if (!game || combatUi.dead) return;
  connection.send({ t: 'useHotbar', index, viewTick: viewTick() });
}

// Захват мыши возвращается щелчком по миру: отдельного экрана паузы нет,
// он только закрывал происходящее и мешал.
renderer.domElement.addEventListener('mousedown', () => {
  if (!game || combatUi.dead || inventoryUi.open) return;
  if (!controls.locked) controls.requestLock();
});

/**
 * Отпустить мышь и показать рюкзак.
 *
 * Отдельно от клавиши, потому что панель поднимается не только по `I`:
 * казну и стол обмена открывают из мира, и без этого курсор оставался
 * захваченным — панель видно, а взять вещь нечем.
 */
function openInventory(): void {
  if (!game || combatUi.dead) return;
  controls.suspended = true;

  /**
   * Рюкзак поднимается **до** того, как отпущена мышь.
   *
   * Порядок важен: на отпускание мыши открывается меню настроек, и оно смотрит,
   * не занят ли игрок чем-то ещё. Отпусти захват первым — и поверх рюкзака
   * вылезет меню, потому что в тот момент рюкзак ещё не считался открытым.
   */
  inventoryUi.show();
  document.exitPointerLock();
  ui.setResumeHint(false);
}

/**
 * Клавиша рюкзака — целиком здесь, и только здесь.
 *
 * Controls её не слышит: пока рюкзак открыт, захват мыши отпущен и боевой ввод
 * приостановлен. Когда-то обработчик стоял в обоих местах, и одно нажатие
 * открывало рюкзак и тут же его закрывало — то есть он не открывался вовсе.
 */
function toggleInventory(): void {
  if (!game || combatUi.dead || ui.chatFocused) return;

  if (inventoryUi.open) {
    inventoryUi.hide();
    // Жест пользователя ещё «живой» — только под ним браузер и вернёт захват.
    controls.requestLock();
    return;
  }

  // Звучит только открытие по клавише: казна и обмен звучат по-своему.
  sound.play('backpack');
  openInventory();
}

/**
 * Клавиатура принадлежит игре, пока игрок в ней: мышь захвачена или открыт
 * рюкзак. В чате и на экранах входа она возвращается браузеру — там печатают.
 */
guardBrowserKeys(() => (controls.locked && !controls.suspended) || inventoryUi.open);
wireFullCapture((full, captured) => ui.setCaptureHint(full, captured));

/** Игрок печатает — клавиши принадлежат полю, а не игре. */
function typingInto(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

window.addEventListener('keydown', (event) => {
  // Иначе Tab не увести из поля в поле на экране входа: обработчик висит
  // на окне и видит нажатия из полей ввода тоже.
  if (typingInto(event.target)) return;

  if (event.code === 'Tab') {
    // Обязательно: иначе браузер уведёт фокус на свои элементы, и следующее
    // нажатие уйдёт уже не игре.
    event.preventDefault();
    toggleInventory();
    return;
  }

  // Полный экран берём на себя: только вход через API отдаёт игре Ctrl+W,
  // Ctrl+T и прочие клавиши браузера, нативный полный экран — нет.
  if (event.code === 'F11') {
    event.preventDefault();
    void toggleFullCapture(document.documentElement);
    return;
  }

  /**
   * Настройки картинки и звука — F1.
   *
   * Не Escape: его при захваченной мыши браузер забирает себе, и до игры оно
   * доходит только в полном экране. F1 приходит всегда и означает одно.
   */
  if (event.code === 'F1') {
    event.preventDefault();
    if (!game) return;
    if (settings.open) {
      settings.hide();
      controls.requestLock();
    } else {
      adminUi.hide();
      settings.show();
      if (controls.locked) document.exitPointerLock();
    }
    return;
  }

  /**
   * Служебное меню ведущего — F2. У обычного аккаунта не открывается:
   * `allow` приходит с приветствием, а команды всё равно проверяет сервер.
   */
  if (event.code === 'F2') {
    event.preventDefault();
    if (!game) return;
    if (adminUi.open) {
      adminUi.hide();
      controls.requestLock();
    } else {
      settings.hide();
      adminUi.show();
      // В меню печатают в поле поиска: на время ввода клавиатура принадлежит
      // ему, а не миру. Иначе «доспех» уводил бы персонажа гулять.
      controls.suspended = true;
      if (controls.locked) document.exitPointerLock();
    }
    return;
  }

  if (event.code === 'Escape') {
    // Escape закрывает рюкзак, но захват не возвращает: курсор остаётся
    // свободным — вещи ещё могут понадобиться.
    if (inventoryUi.open) {
      inventoryUi.hide();
      return;
    }
    // Открытые меню он тоже закрывает — так привычно, и это единственное,
    // что Escape здесь делает: открывают меню F1 и F2.
    if (settings.open) {
      settings.hide();
      controls.requestLock();
      return;
    }
    if (adminUi.open) {
      adminUi.hide();
      controls.requestLock();
    }
  }
});

/**
 * Опознанная сущность.
 *
 * Сервер присылает имя, вид и расу **один раз** — при первом появлении в поле
 * зрения; дальше в снапшоте едет только изменяемое. Поэтому у клиента есть
 * память на опознанных, а всё, что рисует людей и зверьё, работает с этим
 * типом, а не с сырым снапшотом: рисовать безымянную сущность нечем.
 */
type KnownEntity = EntitySnapshot & {
  name: string;
  kind: NonNullable<EntitySnapshot['kind']>;
  race: NonNullable<EntitySnapshot['race']>;
};

/** Кого уже представили: id — имя, вид, раса, порода. */
const identities = new Map<string, Pick<KnownEntity, 'name' | 'kind' | 'race' | 'mobId'>>();

/**
 * Дополняет сущность опознанием из памяти.
 *
 * `null` — сущность, которую нам не представляли: рисовать её нечем. В норме
 * этого не бывает (сервер представляет заново каждого, кто вошёл в радиус),
 * но молчать о пропаже дешевле, чем рисовать безымянного истукана.
 */
function identify(entity: EntitySnapshot): KnownEntity | null {
  if (entity.name !== undefined && entity.kind !== undefined && entity.race !== undefined) {
    identities.set(entity.id, {
      name: entity.name,
      kind: entity.kind,
      race: entity.race,
      mobId: entity.mobId,
    });
    return entity as KnownEntity;
  }

  const known = identities.get(entity.id);
  return known ? { ...entity, ...known } : null;
}

interface Avatar {
  group: THREE.Group;
  placeholder: THREE.Group | null;
  model: CharacterModel | null;
  tag: HTMLDivElement;
  entity: KnownEntity;
  interpolator: EntityInterpolator;
  pose: InterpolatedPose;
  /** Секунд с момента смерти — по нему тело заваливается и оседает. */
  deathTime: number;
  /** Сколько ещё отыгрывать вздрагивание от удара. */
  hurtTime: number;
  /** Огонёк в руке: есть, пока сущность несёт факел. */
  flame: THREE.Sprite | null;
}

const avatars = new Map<string, Avatar>();

/**
 * Чья полоска здоровья висит на экране.
 *
 * Держим отдельно, чтобы обновлять её по снапшотам: событие боя знает только
 * факт удара, а остаток здоровья приходит следующим сообщением.
 */
let targetId: string | null = null;
const projectiles = new Map<string, THREE.Object3D>();
const renderPos = { x: 0, y: 0, z: 0 };

let lastFrame = performance.now();
/** Когда в последний раз обновляли замер в меню. */
let lastReadout = 0;
/** Когда в последний раз переписывали отладочную строку. */
let lastHud = 0;
/** Когда в последний раз искали цель под перекрестием. */
let lastAim = 0;

/**
 * Замер кадра.
 *
 * Средний FPS почти ничего не говорит о плавности: двести кадров с одним
 * застрявшим на десяток выглядят хуже ровных шестидесяти. Меряем разброс.
 */
const frameStats = createFrameStats();

/**
 * Настройки картинки и звука. Они же экран паузы: мышь отпущена — меню открыто.
 *
 * Отдельного экрана паузы в игре нет намеренно, мир видно всегда; меню
 * не закрывает его целиком и снимается тем же щелчком, что возвращает мышь.
 */
const settings = createSettings(
  (chosen) => {
    quality.configure({ resolution: chosen.resolution, shadows: chosen.shadows });
    sound.setVolumes(chosen);
  },
  () => controls.requestLock(),
  // Громкость отпустили — короткий образец, чтобы слышно было, на что поставил.
  () => sound.play('confirm'),
);
/**
 * Служебное меню ведущего. Заводится всегда, показывается только тому,
 * кому разрешил сервер: решение о правах приходит с приветствием.
 */
const adminUi = createAdmin(
  (message) => connection.send(message),
  // Закрыли меню — мышь и клавиатура возвращаются миру.
  () => controls.requestLock(),
);

/** Сдвиг часов мира, поставленный ведущим. Приходит с приветствием и с ним же. */
let daytimeShift = 0;

let lastSnapshotTick = -1;
let actionSeq = 0;
/** Штраф скорости за перегруз. Обновляется вместе с состоянием вещей. */
let weightFactor = 1;

/**
 * Тот же штраф, что считает сервер, но по числам из сообщения о вещах:
 * клиенту не нужны атрибуты, достаточно веса и предела.
 */
function weightSpeedFactorFor(weight: number, capacity: number): number {
  if (weight <= capacity) return 1;
  return Math.max(0.15, 1 - (weight - capacity) / capacity);
}

function startGame(character: CharacterSummary, spawn: { x: number; y: number; z: number }): void {
  const profile = RACES[character.race];
  const body = { radius: profile.radius, height: profile.height };

  // Раса решает, какие рецепты показывать: ремесло привязано к ней, а не
  // к классу. Рюкзак об этом не знает — он приходит без персонажа.
  inventoryUi.setRace(character.race);

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
  // Руки заводятся при входе, прокачка приходит раньше или позже — ставим то,
  // что уже известно, иначе первый рывок пойдёт по правилам новичка.
  game.hands.setEvasion(evasionLevel);
  game.hands.setWeapon(mainHandItem);

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
  ui.system('ЛКМ — удар, СКМ — тяжёлый, ПКМ — блок, Shift — бег, Ctrl — рывок в сторону.');
  ui.system('1…6 — панель, Tab — рюкзак. Вещи на панель кладутся перетаскиванием.');
  ui.setResumeHint(true);
}

/**
 * Главный цикл.
 *
 * Время кадра берётся **из метки браузера**, а не из `performance.now()`
 * в начале обработчика. Разница не косметическая: метка — это момент, к
 * которому кадр будет показан, и идёт она ровно по развёртке, а время входа
 * в обработчик гуляет от того, как ОС раздала процессор. Считая по второму,
 * мы вносили в движение камеры чужое дрожание планировщика.
 */
renderer.setAnimationLoop((frameTime: number) => {
  const now = frameTime;

  // Предел кадров. Браузер рисует по развёртке и своей синхронизации не отдаёт,
  // но неровный ход лечится именно этим: ровная доля частоты монитора кладёт
  // кадры на развёртку одинаково. Полтора миллисекунда допуска — чтобы из-за
  // дробей не пропускать каждый второй кадр.
  const cap = settings.current.fpsCap;
  if (cap > 0 && now - lastFrame < 1000 / cap - 1.5) return;

  const dt = Math.min((now - lastFrame) / 1000, MAX_STEP_DT);
  frameStats.push(now - lastFrame);
  lastFrame = now;

  if (game) {
    // 1. Ввод применяется немедленно и уходит на сервер. Модификаторы скорости
    // берутся из намерения игрока — той же формулой, что считает сервер.
    const authoritative = connection.latestSnapshot?.self;
    game.predictor.setModifiers({
      blocking: controls.blocking,
      dashing: authoritative?.action === 'dodge' && authoritative.phase === 'active',
      gliding: authoritative?.action === 'dodge' && authoritative.phase === 'recovery',
      acting: Boolean(authoritative?.action) && authoritative?.action !== 'dodge',
      slowFactor: 1,
      weightFactor: weightFactor,
      // Выдохшийся не бежит. Клиент обязан знать это сам: иначе он предсказывает
      // бег, которого сервер уже не даёт, и картинка дёргается.
      exhausted: (authoritative?.exhausted ?? 0) > 0,
    });
    game.predictor.setStamina(authoritative?.stamina ?? 1);

    // Сказать вслух, почему ноги вдруг не слушаются. Один раз на усталость:
    // повторять каждый кадр — значит забить чат.
    const winded = (authoritative?.exhausted ?? 0) > 0;
    if (winded && !wasWinded) ui.system('Ты выдохся — надо отдышаться');
    wasWinded = winded;

    for (const input of game.predictor.collectInputs(dt, controls.sample())) {
      connection.send({ t: 'input', ...input });
    }

    // 2. Свежий снапшот поправляет предсказание и кормит интерполяцию.
    consumeSnapshot();

    // 3. Камера идёт по предсказанию с затухающей поправкой.
    game.predictor.renderPosition(dt, renderPos);
    camera.position.set(renderPos.x, renderPos.y + game.eye, renderPos.z);
    camera.rotation.y = controls.yaw;
    camera.rotation.x = controls.pitch;

    // 4. Чужие рисуются в прошлом, плавно между снапшотами.
    updateAvatars(now, dt);
    showcase.update(dt, !undergroundNow);
    updateNametags();
    combatUi.updateCooldowns(now);

    // 5. Мир вокруг подгружается и выгружается по мере движения.
    world.streamChunks(renderPos.x, renderPos.z);

    /**
     * Прицел пересчитывается тридцать раз в секунду, а не каждый кадр.
     *
     * Это перебор всех нод вокруг с проверкой луча — работа не бесплатная,
     * а подсказка от неё меняется в лучшем случае раз в секунду. Задержка
     * в тридцать миллисекунд не значит ничего: нажатие E всё равно проверяет
     * сервер.
     */
    if (now - lastAim > 33) {
      lastAim = now;
      updateNodeHint(renderPos.x, renderPos.z);
      updateDelve();
    }

    // 6. Руки: поза берётся из авторитетного состояния, скорость — из предсказания.
    const self = connection.latestSnapshot?.self;

    /**
     * Свой огонь: факел в руке или «Светоч».
     *
     * Источник клиент выводит сам, по надетому: сервер шлёт только остаток
     * времени, а какой это свет — видно по левой руке. Числа факела общие
     * с городскими (`TORCH_LIGHT`): огонь в руке и огонь на стене — один
     * и тот же огонь, и разойдись они, в подземелье горел бы фонарик.
     *
     * «Светоч» остаётся бледным и ровным: это магия, а не пламя, и мерцать
     * ей незачем.
     */
    const torch = offHandItem === 'torch';
    const burning = (self?.light ?? 0) > 0;
    const wantLight = burning ? (torch ? TORCH_LIGHT.base * flicker(now / 1000, 0) : 34) : 0;

    // Мгла отступает перед своим огнём — сцене об этом надо сказать.
    world.setTorch(burning);
    lanternLight.color.setHex(torch ? TORCH_LIGHT.color : 0xffd9a0);
    lanternLight.distance = torch ? TORCH_LIGHT.range : 16;
    lanternLight.decay = torch ? TORCH_LIGHT.decay : 2;
    // Разгорание плавное, мерцание — нет: иначе оно бы сглаживалось в ровный
    // свет. За плавность отвечает только появление и угасание.
    lanternLight.intensity += (wantLight - lanternLight.intensity) * Math.min(1, dt * (burning ? 12 : 4));
    const velocity = game.predictor.state.vel;
    game.hands.update(dt, {
      action: self?.action ?? null,
      phase: self?.phase ?? null,
      blocking: controls.blocking,
      speed: Math.hypot(velocity.x, velocity.z),
      onGround: game.predictor.state.onGround,
      alive: self?.alive ?? true,
    });

    // Свои шаги — по той же скорости и тому же касанию земли, что у рук: руки
    // идут в шаг, и звук обязан идти в шаг с ними. Мёртвые не шагают.
    if (self?.alive ?? true) {
      steps.own(
        dt,
        Math.hypot(velocity.x, velocity.z),
        game.predictor.state.onGround,
        RACES[game.character.race].height,
        surfaceAt(renderPos.x, renderPos.z, undergroundNow),
      );
    }

    // Фон по месту: спрашивать каждый кадр дёшево, а меняется он только
    // на смене — у ворот, на спуске, на выходе.
    atmosphere.where(renderPos.x, renderPos.z, undergroundNow);
  } else {
    // Пока идёт вход — медленный облёт города вместо чёрного экрана.
    world.streamChunks(0, 0);
    const angle = now / 9000;
    camera.position.set(Math.cos(angle) * 18, 6, Math.sin(angle) * 18);
    camera.lookAt(0, 1.5, 0);
  }

  // Время суток берётся из тика сервера — общих часов мира. До входа в игру
  // тика нет, и город облетается в том же сумеречном утре, с которого
  // начинается день: показывать случайное время на экране входа незачем.
  // Замер в меню обновляется, только пока меню открыто: считать нечего,
  // когда его не видно.
  if (settings.open && now - lastReadout > 500) {
    lastReadout = now;
    frameStats.setMouseRate(controls.mouseRate);
    settings.setReadout(frameStats.readout());
  }

  const worldTime = connection.latestSnapshot
    ? timeOfDay(connection.latestSnapshot.tick, serverTickRate, daytimeShift)
    : DAY_START;
  world.update(now / 1000, worldTime, camera);

  // Руки живут в своей сцене со своим светом, но темнеть обязаны вместе
  // с миром: иначе ночью они светятся посреди тёмного города.
  game?.hands.setAmbience(Math.max(0, Math.min(1, sunHeight(worldTime) * 3)));

  quality.frame(now);

  // Счётчики обнуляем сами: проходов за кадр несколько (мир, руки, карта
  // теней), а three сбрасывает их в начале каждого — считался бы только
  // последний, то есть руки.
  renderer.info.reset();

  renderer.clear();
  renderer.render(scene, camera);
  // Второй проход с очисткой глубины: руки не режутся о стены впритык.
  if (game && !combatUi.dead) game.hands.render(renderer, camera.aspect);

  frameStats.setLoad(renderer.info.render.calls, renderer.info.render.triangles);
  // Отладочная строка переписывается несколько раз в секунду, а не каждый
  // кадр: это сборка длинной строки и запись в DOM, и на ста восьмидесяти
  // кадрах она стоит дороже, чем всё, что показывает.
  if (now - lastHud > 160) {
    lastHud = now;
    updateHud();
  }
});

/**
 * Что за нода перед игроком и можно ли её взять.
 *
 * Цель выбирается на клиенте, но это лишь подсказка: бить или не бить решает
 * сервер по своим числам. Здесь — только чтобы игрок понимал, куда смотрит.
 */
let aimedNode: string | null = null;
/** Открыт ли сундук казны. Ответ приходит с сервера, клиент его не решает. */
let bankOpen = false;
/**
 * Что игрок просил открыть последним: казну или мешок павшего.
 *
 * Сервер открывает оба одним сообщением `bank`, а звучать они должны
 * по-разному: казна — люком, мешок — как свой рюкзак. Отличить их можно
 * только по тому, что просили.
 */
let opening: 'vault' | 'bag' | null = null;
/** Внизу ли игрок. От этого зависит, что предлагает клавиша взаимодействия. */
let undergroundNow = false;
/** На что нацелен игрок из рукотворного: казна, спуск, портал, лестница. */
let aimedPlace: 'vault' | 'descent' | 'portal' | 'stairsDown' | 'stairsUp' | null = null;
/** Сундук под перекрестием и его имя — по нему уходит намерение вскрыть. */
let aimedChest: string | null = null;
/**
 * Зерно текущего подземелья.
 *
 * Клиент раскладывает сундуки тем же генератором, что и сервер, — по сети
 * едет только имя инстанса. Наверху зерна нет: там и сундуков нет.
 */
let dungeonSeedNow: number | null = null;
/** Вскрытые сундуки: приходят снапшотом, как выработанные ноды. */
const openedChests = new Set<string>();
/**
 * Пришёл ли уже список вскрытых в этом мире. Первый список — это то, что
 * вскрыли до тебя, и крышки звучать не должны: для тебя ничего не случилось.
 */
let chestsKnown = false;
/** Мешки павших: что видно на полу, то и приходит в снапшоте. */
const bags = new Map<string, { mesh: THREE.Object3D; x: number; y: number; z: number }>();
/** Мешок под перекрестием. */
let aimedBag: string | null = null;
/** Идёт ли разговор об обмене — приглашение или сам стол. */
let tradeOpen = false;
/** На каком расстоянии клиент вообще предлагает обмен. Сервер строже. */
const TRADE_REACH = 5;

/** Уровень уклонения: от него зависят откат и цена рывка. Приходит с прокачкой. */
let evasionLevel = 0;
/** Был ли игрок выдохшимся в прошлом кадре — по этому говорится о усталости. */
let wasWinded = false;
/** Что у игрока в основной руке. Приходит вместе с состоянием вещей. */
let mainHandItem: string | null = null;
/** Что во второй: по нему выбирается вид своего света — факел или «Светоч». */
let offHandItem: string | null = null;
/** Хватает ли лёгкости на рывок. Считается по тому же правилу, что у сервера. */
let dashAllowed = true;

const TOOL_NAMES: Record<string, string> = {
  axe: 'топор',
  pick: 'кирка',
  knife: 'нож',
};

/**
 * Кто перед игроком.
 *
 * Выбор собеседника — дело клиента, потому что «смотрю на него» есть только
 * на экране. Далеко ли до него и не занят ли он, решит сервер: здесь мы
 * ошибёмся разве что в пользу отказа.
 */
function playerInFront(): KnownEntity | null {
  const snapshot = connection.latestSnapshot;
  if (!snapshot) return null;

  const self = snapshot.self;
  const forwardX = -Math.sin(controls.yaw);
  const forwardZ = -Math.cos(controls.yaw);

  let best: KnownEntity | null = null;
  let bestScore = 0.4; // косинус: примерно 66° в каждую сторону
  for (const raw of snapshot.entities) {
    // Через опознание, а не по сырому снапшоту: имя и вид едут один раз,
    // и у давно знакомого соседа их в пакете нет. Сравнение с сырым полем
    // молча перестало бы находить кого бы то ни было.
    const entity = identify(raw);
    if (!entity || entity.kind !== 'player' || !entity.alive) continue;
    const dx = entity.x - self.x;
    const dz = entity.z - self.z;
    const distance = Math.hypot(dx, dz);
    if (distance > TRADE_REACH || distance < 0.01) continue;

    const score = (dx * forwardX + dz * forwardZ) / distance;
    if (score > bestScore) {
      bestScore = score;
      best = entity;
    }
  }
  return best;
}

/**
 * На что смотрит игрок.
 *
 * Подсказка `E` идёт за перекрестием, а не за корпусом: раньше она загоралась
 * от одной близости и не гасла, даже когда цель оставалась за спиной.
 */
const aimRay = new THREE.Ray();
const aimDirection = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const bankBox = new THREE.Box3(
  new THREE.Vector3(BANK.x - BANK.width / 2, 0, BANK.z - BANK.depth / 2),
  new THREE.Vector3(BANK.x + BANK.width / 2, BANK.height, BANK.z + BANK.depth / 2),
);
/** Запас к коробке казны: целятся в сундук, а не в его рёбра. */
const BANK_AIM_PADDING = 0.3;
bankBox.expandByScalar(BANK_AIM_PADDING);

/**
 * Сундук под перекрестием.
 *
 * Считается лучом, как и ноды: подсказка обязана идти за прицелом, а не
 * за близостью корпуса — иначе она загорается у сундука за спиной.
 */
const chestBox = new THREE.Box3();
/** Запас к коробке: целятся в сундук, а не в его рёбра. */
const CHEST_AIM_PADDING = 0.3;

function chestAt(x: number, z: number): { id: string } | null {
  if (dungeonSeedNow === null) return null;

  let best: { id: string } | null = null;
  let bestHit = Infinity;

  for (const chest of dungeonChests(dungeonSeedNow)) {
    // Дальность считаем по горизонтали от ног, как сервер: подсказка не
    // должна обещать то, в чём он откажет.
    if (Math.hypot(chest.x - x, chest.z - z) > CHEST_RANGE) continue;

    const half = CHEST_SIZE / 2 + CHEST_AIM_PADDING;
    chestBox.min.set(chest.x - half, 0, chest.z - half);
    chestBox.max.set(chest.x + half, CHEST_HEIGHT + CHEST_AIM_PADDING, chest.z + half);
    if (!aimRay.intersectBox(chestBox, aimPoint)) continue;

    const hit = aimPoint.distanceToSquared(aimRay.origin);
    if (hit >= bestHit) continue;
    best = chest;
    bestHit = hit;
  }

  return best;
}

/** Мешок под перекрестием. Считается лучом, как ноды и сундуки. */
const bagBox = new THREE.Box3();

function bagAt(x: number, z: number): string | null {
  let best: string | null = null;
  let bestHit = Infinity;

  for (const [id, bag] of bags) {
    if (Math.hypot(bag.x - x, bag.z - z) > BAG_RANGE) continue;

    bagBox.min.set(bag.x - 0.5, bag.y - 0.1, bag.z - 0.5);
    bagBox.max.set(bag.x + 0.5, bag.y + 0.9, bag.z + 0.5);
    if (!aimRay.intersectBox(bagBox, aimPoint)) continue;

    const hit = aimPoint.distanceToSquared(aimRay.origin);
    if (hit >= bestHit) continue;
    best = id;
    bestHit = hit;
  }

  return best;
}

/**
 * Строка вылазки: этаж, хозяин глубины и обратный отсчёт порталов.
 *
 * Всё берётся из снапшота, а не считается на месте: этаж клиент вывести бы
 * смог, а вот жив ли босс и сколько секунд открыты порталы — нет. И меняться
 * все три обязаны одним кадром, иначе на границе этажей подпись разъедется
 * с отсчётом.
 */
function updateDelve(): void {
  const self = connection.latestSnapshot?.self;
  if (!self || self.floor === undefined) {
    ui.setDelve('');
    return;
  }

  const parts = [`<b>Этаж ${self.floor + 1}</b>`];
  const left = Math.round(self.portalsFor ?? 0);

  if (self.bossAlive) {
    parts.push('<u>порталы заперты</u>');
  } else if (left > 0) {
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    parts.push(`<i>порталы открыты ${minutes}:${seconds}</i>`);
  } else {
    parts.push('порталы закрылись');
  }

  if (self.party && self.party > 1) parts.push(`отряд: ${self.party}`);
  ui.setDelve(parts.join(' · '));
}

function updateNodeHint(x: number, z: number): void {
  camera.getWorldDirection(aimDirection);
  aimRay.set(camera.position, aimDirection);

  // Казна перебивает ноду: в городе нод нет, а подсказка нужна одна.
  // Дальность считаем от ног, как сервер, а направление — по лучу из глаза.
  /**
   * Рукотворные цели идут перед нодами: под землёй нод нет вовсе, а в городе
   * их нет тем более. Подсказка при этом одна — и клавиша одна.
   */
  aimedPlace = null;
  aimedChest = null;
  aimedBag = null;

  /**
   * Мешок проверяется **до всего остального и в любом мире**.
   *
   * Мешки лежат и наверху — с каждого убитого зверя, — и внизу. И перебивают
   * они всё: мешок лежит там, где что-то уже случилось, и подобрать его важнее,
   * чем срубить дерево или вскрыть ящик.
   */
  const bag = bagAt(x, z);
  if (bag) {
    aimedNode = null;
    aimedBag = bag;
    ui.setNodeHint('Мешок', null, true, 'обыскать');
    return;
  }

  if (undergroundNow) {
    const floor = floorOf(x);

    if (
      floor === 0 &&
      Math.hypot(x - DUNGEON_EXIT.x, z - DUNGEON_EXIT.z) <= DUNGEON_EXIT_RANGE
    ) {
      aimedPlace = 'portal';
      aimedNode = null;
      // Запертый портал говорит об этом заранее: молчаливый отказ по нажатию
      // читается как поломка, а не как правило.
      const locked = connection.latestSnapshot?.self.bossAlive === true;
      ui.setNodeHint(
        locked ? 'Портал заперт: хозяин глубины жив' : 'Выход наверх',
        null,
        true,
        locked ? 'попробовать' : 'выйти',
      );
      return;
    }

    // Лестницы: те же ниши и та же клавиша, что у портала. Вниз — на восток,
    // наверх — на запад; где именно, знает общий код, а не число здесь.
    for (const [place, stairs] of [
      ['stairsDown', stairsDown(floor)],
      ['stairsUp', stairsUp(floor)],
    ] as const) {
      if (!stairs) continue;
      if (Math.hypot(x - stairs.x, z - stairs.z) > DUNGEON_EXIT_RANGE) continue;
      aimedPlace = place;
      aimedNode = null;
      ui.setNodeHint(
        place === 'stairsDown' ? `Спуск на этаж ${floor + 2}` : `Подъём на этаж ${floor}`,
        null,
        true,
        place === 'stairsDown' ? 'спуститься' : 'подняться',
      );
      return;
    }

    const chest = chestAt(x, z);
    if (chest) {
      aimedNode = null;
      aimedChest = chest.id;
      // Вскрытый открывается сразу, невскрытый — полосой. Обещать разное
      // одним словом нельзя: «вскрыть» у сломанного замка читалось бы
      // как «здесь пусто».
      const opened = openedChests.has(chest.id);
      ui.setNodeHint('Сундук', null, true, opened ? 'обыскать' : 'вскрыть');
      return;
    }
  } else if (
    Math.hypot(x - BANK.x, z - BANK.z) <= BANK.range &&
    aimRay.intersectsBox(bankBox)
  ) {
    aimedPlace = 'vault';
    aimedNode = null;
    ui.setNodeHint('Казна', null, true, 'открыть');
    return;
  } else if (Math.hypot(x - DUNGEON_GATE.x, z - DUNGEON_GATE.z) <= DUNGEON_GATE.range) {
    aimedPlace = 'descent';
    aimedNode = null;
    ui.setNodeHint('Спуск в подземелье', null, true, 'спуститься');
    return;
  }

  const node = world.nodes.targetAt(aimRay);
  aimedNode = node?.id ?? null;

  if (!node || world.nodes.isDepleted(node.id)) {
    ui.setNodeHint(node ? `${NODES[node.nodeId].name} — пусто` : '', null, false);
    return;
  }

  const profile = NODES[node.nodeId];
  const held = mainHandItem ? itemDef(mainHandItem as ItemId) : null;
  const ready =
    !profile.tool ||
    (held?.toolKind === profile.tool && (held.toolTier ?? 0) >= profile.toolTier);

  ui.setNodeHint(profile.name, profile.tool ? (TOOL_NAMES[profile.tool] ?? profile.tool) : null, ready);
}

/**
 * Разбирает **все** пришедшие снапшоты, а не последний.
 *
 * Опознание сущности едет ровно один раз — в том снапшоте, где она впервые
 * попала в поле зрения. Пока кадр брал только свежий, любой кадр длиннее
 * пятидесяти миллисекунд выбрасывал снапшот целиком, и если в нём ехало
 * представление, сущность оставалась безымянной **навсегда**: сервер второй
 * раз не представляет, пока она не выйдет из радиуса и не вернётся. Моб при
 * этом жив, ходит и бьёт — просто его не рисуют, а появляется он потом
 * в неожиданном месте, когда представление наконец доедет.
 *
 * Состояние мира берём из самого свежего — оно про «сейчас». Сущности
 * и выборки интерполяции — из каждого: пропущенный снапшот это и пропущенное
 * имя, и дырка в дорожке движения.
 */
function consumeSnapshot(): void {
  if (!game) return;
  const pending = connection.takeSnapshots();
  const newest = pending[pending.length - 1]?.message;
  if (!newest || newest.tick === lastSnapshotTick) return;
  lastSnapshotTick = newest.tick;

  game.predictor.reconcile(newest.self, newest.ack);
  combatUi.updateVitals(newest.self);
  // Выработанные ноды: клиент знает про них всё, кроме того, взяли ли с них
  // урожай, — это единственное, что приходит с сервера.
  world.nodes.setDepleted(newest.depletedNodes);
  // Вскрытые сундуки — те же исключения, что и выработанные ноды: всё
  // остальное про них клиент считает сам.
  // Новый в списке — крышка откинулась: слышно из точки, и соседу тоже.
  if (chestsKnown && dungeonSeedNow !== null) {
    for (const id of newest.openedChests) {
      if (openedChests.has(id)) continue;
      const chest = dungeonChests(dungeonSeedNow).find((candidate) => candidate.id === id);
      if (chest) sound.play('chestOpen', { x: chest.x, y: CHEST_HEIGHT, z: chest.z });
    }
  }
  chestsKnown = true;
  openedChests.clear();
  for (const id of newest.openedChests) openedChests.add(id);

  const seen = new Set<string>();
  for (const { message, at } of pending) {
    for (const raw of message.entities) {
      if (raw.id === connection.playerId) continue;
      const entity = identify(raw);
      if (!entity) continue;
      // Убирать будем по свежему снапшоту: в прошлых мог быть тот, кто уже ушёл.
      if (message === newest) seen.add(entity.id);
      ensureAvatar(entity).interpolator.push(entity, at);
    }
  }

  for (const [id, avatar] of avatars) {
    if (seen.has(id)) continue;
    scene.remove(avatar.group);
    avatar.tag.remove();
    avatars.delete(id);
  }

  syncProjectiles(newest.projectiles);
  syncBags(newest.bags);

  // Чужие замахи и стрелы звучат по свежему снапшоту — и только в начале:
  // «замахивается» он повторяет двадцать раз в секунду, а звук нужен один.
  cues.entities(newest.entities, connection.playerId);
  cues.projectiles(newest.projectiles);

  // Переходы вылазки — гонг, закрытие порталов, отдышка, свой огонь — тоже
  // по свежему снапшоту: звучит смена, а не состояние.
  atmosphere.self(newest.self, offHandItem === 'torch');
}

/**
 * Мешки на полу. Держим сцену в соответствии со снапшотом: мешок истлевает
 * сам, и пропасть он должен вместе с правом его обыскать.
 */
function syncBags(list: readonly { id: string; x: number; y: number; z: number }[]): void {
  const seen = new Set<string>();

  for (const bag of list) {
    seen.add(bag.id);
    let entry = bags.get(bag.id);
    if (!entry) {
      const mesh = createBagMesh();
      scene.add(mesh);
      entry = { mesh, x: bag.x, y: bag.y, z: bag.z };
      bags.set(bag.id, entry);
    }
    entry.x = bag.x;
    entry.y = bag.y;
    entry.z = bag.z;
    entry.mesh.position.set(bag.x, bag.y, bag.z);
  }

  for (const [id, entry] of bags) {
    if (seen.has(id)) continue;
    scene.remove(entry.mesh);
    entry.mesh.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    bags.delete(id);
    if (aimedBag === id) aimedBag = null;
  }
}

/** Снаряды живут недолго — просто держим сцену в соответствии со снапшотом. */
function syncProjectiles(list: ProjectileSnapshot[]): void {
  const seen = new Set<string>();

  projectileLights.update(list);

  for (const projectile of list) {
    seen.add(projectile.id);
    let mesh = projectiles.get(projectile.id);
    if (!mesh) {
      mesh = createProjectileMesh(projectile.spellId);
      scene.add(mesh);
      projectiles.set(projectile.id, mesh);
    }
    /**
     * Стрела смотрит туда, куда летит.
     *
     * Направление берётся из её же движения между снапшотами: у сгустка оно
     * не нужно (шар со всех сторон одинаков), а у древка летящая боком стрела
     * читается как ошибка. Первый кадр пропускаем — сравнивать ещё не с чем.
     */
    if (!projectile.spellId) {
      const moved =
        Math.abs(mesh.position.x - projectile.x) +
        Math.abs(mesh.position.y - projectile.y) +
        Math.abs(mesh.position.z - projectile.z);
      if (moved > 0.01) mesh.lookAt(projectile.x, projectile.y, projectile.z);
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

function ensureAvatar(entity: KnownEntity): Avatar {
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
    hurtTime: 0,
    flame: null,
  };
  avatars.set(entity.id, avatar);

  // Модель приезжает асинхронно; до неё существо стоит блокаут-заглушкой.
  const pending =
    entity.kind === 'mob' && entity.mobId
      ? hasMobModel(entity.mobId)
        ? createMobModel(entity.mobId)
        : null
      : hasModel(entity.race, entity.kind === 'npc')
        ? createCharacterModel(entity.race, entity.kind === 'npc')
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
  // Полоска цели идёт за снапшотами: в событии боя остатка здоровья нет,
  // и нарисованная по нему полоска застывала на значении до удара —
  // смертельный удар оставлял её на половине. Подпись обновляется тем же
  // вызовом: в ней стоит процент, и разъехаться с полоской он не должен.
  if (targetId && combatUi.targetVisible) {
    const target = avatars.get(targetId);
    if (target) {
      const hp = target.entity.alive ? target.entity.hp : 0;
      combatUi.setTarget(nameFor({ ...target.entity, hp }), hp);
    }
  }

  /**
   * Чужие шаги прошлого кадра звучат в начале этого.
   *
   * Список собирается в обходе ниже, а обход длинный и выходит из себя через
   * `continue` в нескольких местах — звать шаги после него значило бы искать
   * каждый выход. Задержка в один кадр на слух не заметна.
   */
  steps.others(dt, walkers, surfaceAt(camera.position.x, camera.position.z, undergroundNow));
  walkers.length = 0;
  // Удары работы — своей и соседей — по тому же правилу: список прошлого кадра.
  labour.tick(dt, workers);
  workers.length = 0;
  carried.length = 0;

  for (const avatar of avatars.values()) {
    avatar.interpolator.sample(now, avatar.pose);
    avatar.interpolator.prune(now);

    avatar.group.position.set(avatar.pose.x, avatar.pose.y, avatar.pose.z);
    avatar.group.rotation.y = avatar.pose.yaw;

    // Работает — его удары должны быть слышны. Дальность решает сам звук:
    // замок сундука слышно дальше шагов, и отрезать его здесь по шагам нельзя.
    if (avatar.entity.alive && avatar.entity.work) {
      workers.push({
        id: avatar.entity.id,
        x: avatar.pose.x,
        y: avatar.pose.y,
        z: avatar.pose.z,
        work: avatar.entity.work,
      });
    }

    // Идёт рядом — его шаги должны быть слышны. Дальних и мёртвых не берём:
    // голоса на них не хватит, а слышно их всё равно не было бы.
    if (
      avatar.entity.alive &&
      Math.hypot(avatar.pose.x - camera.position.x, avatar.pose.z - camera.position.z) <= STEP_RANGE
    ) {
      walkers.push({
        id: avatar.entity.id,
        x: avatar.pose.x,
        y: avatar.pose.y,
        z: avatar.pose.z,
        speed: avatar.pose.speed,
        height:
          avatar.entity.kind === 'mob' && avatar.entity.mobId
            ? MOBS[avatar.entity.mobId].height
            : RACES[avatar.entity.race].height,
      });
    }

    /**
     * Огонь в чужой руке.
     *
     * Ореол висит на самой сущности — по нему её видно сквозь мглу, как
     * уличный факел. Свет же берётся из отдельного пула: лампа, заведённая
     * на каждого встречного, стоила бы перекомпиляции всех материалов сцены.
     */
    const lit = avatar.entity.lit === true && avatar.entity.alive;
    if (lit && !avatar.flame) {
      avatar.flame = makeHalo(0xffb257, 1.3);
      avatar.flame.position.set(0.35, 1.2, 0);
      avatar.group.add(avatar.flame);
    } else if (!lit && avatar.flame) {
      avatar.group.remove(avatar.flame);
      avatar.flame = null;
    }
    if (lit) carried.push(avatar.pose);

    if (!avatar.entity.alive) {
      animateCorpse(avatar, dt);
      continue;
    }

    // Замах: модель, у которой есть клип атаки, отыгрывает его по-настоящему.
    const winding = avatar.entity.phase === 'windup';
    if (avatar.model?.has('attack') && winding) avatar.model.play('attack');

    // Удар перебивает и ходьбу, и стойку: иначе непонятно, попал ты или нет.
    avatar.hurtTime = Math.max(0, avatar.hurtTime - dt);
    const flinching = avatar.hurtTime > 0 && !winding;
    if (flinching) avatar.model?.play('hurt');

    // Живой — сбрасываем всё, что осталось от прошлой смерти.
    avatar.deathTime = 0;
    avatar.group.rotation.x = 0;
    avatar.group.rotation.z = 0;

    // У блокаут-заглушек замах показывается раздуванием: клипа атаки у них нет.
    avatar.group.scale.setScalar(winding && !avatar.model?.has('attack') ? 1.06 : 1);

    if (avatar.model) {
      if (!flinching && (!winding || !avatar.model.has('attack'))) {
        const moving = avatar.pose.speed > 0.4;
        // Темп шага задаётся настоящей скоростью: иначе ноги едут по земле.
        if (moving) avatar.model.pace(avatar.pose.speed);
        avatar.model.play(moving ? 'walk' : 'idle');
      }
      avatar.model.update(dt);
    }
  }

  // Ламп меньше, чем факелоносцев в теории: ближние важнее.
  carried.sort(
    (a, b) =>
      (a.x - renderPos.x) ** 2 +
      (a.z - renderPos.z) ** 2 -
      ((b.x - renderPos.x) ** 2 + (b.z - renderPos.z) ** 2),
  );
  carriedLights.update(now / 1000, carried);
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
/** Были ли ники показаны в прошлом кадре — чтобы не писать в DOM впустую. */
let tagsShown = false;

/**
 * Насколько далеко читаются ники, метры.
 *
 * Радиус интереса — сорок пять метров, и подписи на всю эту даль превращали
 * Alt в разведку: с одного конца площади видно, кто стоит на другом. Двенадцать
 * метров — это «рядом»: разглядеть собеседника, прежде чем заговорить, и узнать
 * того, кто уже подошёл вплотную. Дальше — силуэт, и решать по нему.
 *
 * В подземелье это и есть часть напряжения: чужого видно, а кто он — нет.
 */
const NAME_RANGE = 12;

/** Цвет метки своего: тёплая зелень, ни на один флаг не похожая. */
const ALLY_COLOR = '#8fd694';

/** Есть ли рядом хоть один свой. Без этого ники не зажигаются вовсе. */
function hasAllies(): boolean {
  for (const avatar of avatars.values()) {
    if (avatar.entity.ally === true) return true;
  }
  return false;
}

function updateNametags(): void {
  /**
   * Пока ники скрыты, в DOM не пишем вовсе.
   *
   * Раньше каждому аватару каждый кадр проставлялся `display: none` — и это
   * при том, что ники видно только с зажатым Alt. На ста восьмидесяти кадрах
   * такая запись стоит дороже, чем сами ники.
   */
  /**
   * Свои — исключение из этого правила.
   *
   * Внизу флаги не действуют, все всем враги, и видно на пять метров: без
   * постоянной метки отряд не отличить от чужаков, а держать Alt всю вылазку
   * невозможно. Поэтому ники своих висят всегда, и только они.
   */
  const allies = hasAllies();
  if (!controls.showNames && !allies) {
    if (tagsShown) {
      for (const avatar of avatars.values()) avatar.tag.style.display = 'none';
      tagsShown = false;
    }
    return;
  }
  tagsShown = true;

  const projected = new THREE.Vector3();

  const eye = camera.position;

  for (const avatar of avatars.values()) {
    const ally = avatar.entity.ally === true;
    if (!controls.showNames && !ally) {
      avatar.tag.style.display = 'none';
      continue;
    }

    // У мёртвых подписи нет: тело уже не цель. И у далёких — тоже, кроме
    // своих: метка на спутнике за мглой и есть то, ради чего отряд заводят.
    const far =
      Math.hypot(avatar.group.position.x - eye.x, avatar.group.position.z - eye.z) > NAME_RANGE;
    if (!avatar.entity.alive || (far && !ally)) {
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

    avatar.tag.textContent = ally ? `${avatar.entity.name} ◆` : nameFor(avatar.entity);
    // Цвет ника говорит, кого можно бить без последствий. Решение это
    // принимается на глаз и за секунду, поэтому оно в имени, а не в меню.
    // У своих он свой и перебивает флаг: внизу флагов всё равно нет.
    avatar.tag.style.color = ally ? ALLY_COLOR : FLAG_COLORS[avatar.entity.flag ?? 'white'];
    avatar.tag.style.display = 'block';
    avatar.tag.style.left = `${((projected.x + 1) / 2) * innerWidth}px`;
    avatar.tag.style.top = `${((1 - projected.y) / 2) * innerHeight}px`;
  }
}

function handleCombatEvent(event: CombatEvent): void {
  const selfId = connection.playerId ?? '';
  combatUi.showEvent(event, projectToScreen(event.x, event.y, event.z), selfId);
  // Исход удара звучит из точки удара: свой рядом, чужая драка — издалека.
  cues.combat(event);

  // Полоска цели: показываем, по кому попал именно ты.
  if (event.attackerId === selfId && event.targetId) {
    const target = avatars.get(event.targetId);
    if (target) {
      // Событие боя приходит раньше снапшота, поэтому здоровье в нём ещё
      // старое. Вычитаем урон сразу, а дальше полоску догоняют снапшоты.
      const guess = event.kind === 'death' ? 0 : target.entity.hp;
      targetId = event.targetId;
      combatUi.showTarget(nameFor({ ...target.entity, hp: guess }), guess);
    }
  }

  // Вздрагивание от удара. Бьёт кто угодно и по кому угодно: чужая драка
  // читается со стороны так же, как своя.
  if (event.kind === 'hit' && event.targetId) {
    const target = avatars.get(event.targetId);
    if (target?.model?.has('hurt')) target.hurtTime = HURT_SECONDS;
  }
}

/** Сколько длится вздрагивание. Ровно столько же в клипе — см. stopmotion.ts. */
const HURT_SECONDS = 0.45;

/** Переводит мировую точку в экранную. Возвращает null, если она за спиной. */
function projectToScreen(x: number, y: number, z: number): { x: number; y: number } | null {
  const point = new THREE.Vector3(x, y, z).project(camera);
  if (point.z > 1) return null;
  return {
    x: ((point.x + 1) / 2) * innerWidth,
    y: ((1 - point.y) / 2) * innerHeight,
  };
}

function nameFor(entity: KnownEntity): string {
  if (entity.kind === 'mob' && entity.mobId) {
    const percent = Math.round(entity.hp * 100);
    return `${MOBS[entity.mobId].name} · ${percent}%`;
  }
  if (entity.kind === 'npc') return `${entity.name} · ${RACES[entity.race].name}`;
  return entity.name;
}

function updateHud(): void {
  if (!game || ui.inMenus) {
    hud.textContent = '';
    return;
  }

  const { pending, correction, rtt } = game.predictor.stats;
  const snapshot = connection.latestSnapshot;
  const pos = game.predictor.state.pos;

  const frame = frameStats.measure();
  hud.textContent =
    `${game.character.name} · ${RACES[game.character.race].name}\n` +
    `связь: ${connection.status}   пинг: ${rtt.toFixed(0)} мс\n` +
    `тик: ${snapshot?.tick ?? '—'}  ack: ${snapshot?.ack ?? '—'}  в полёте: ${pending}\n` +
    `поправка: ${(correction * 100).toFixed(1)} см\n` +
    `позиция: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}\n` +
    `рядом: ${avatars.size}   чанков: ${world.loadedChunks}
` +
    // Не средний FPS, а разброс: двести кадров с одним застрявшим на десяток
    // выглядят хуже ровных шестидесяти, и дрожание живёт именно в разбросе.
    `кадр: ${frame.median.toFixed(1)} мс (${Math.round(frame.fps)} в секунду)  ` +
    `рывков: ${(frame.stutter * 100).toFixed(1)}%   качество: ${quality.scale.toFixed(2)}`;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
