import { CHUNK_SIZE, chunkCenter, type ChunkSource } from './chunks.js';
import type { LootEntry, MobId } from './mobs.js';
import { boxFromCenter } from './math.js';
import type { LevelBox } from './level.js';

/**
 * Подземелье.
 *
 * Устроено как **тот же мир с другим `instanceId` и другой землёй под ногами**,
 * а не как отдельный уровень. Замысел обещал «смещение в мировом пространстве»,
 * но за краем мира генератор чанков отдавал пустоту — пола там нет. Смещение
 * и не нужно: инстанс уже изолирует, поэтому подземелье занимает те же
 * координаты вокруг нуля, просто в своём инстансе.
 *
 * Раскладка **выводится из зерна**, как и дикие земли: сервер и клиент строят
 * одинаковые стены, ничего не пересылая. Зерно лежит прямо в имени инстанса —
 * `dungeon.7f3a`, — поэтому клиенту достаточно знать, где он.
 */

export const DUNGEON_PREFIX = 'dungeon.';

/**
 * Где подземелье лежит в координатах.
 *
 * Далеко от мира — и это **не косметика, а способ починить целый класс ошибок**.
 * Все проверки места в игре считаются по координатам: безопасная зона города,
 * расстояние до казны, показ городских построек. Инстанс изолирует сущности,
 * но не координаты, и подземелье, стоящее на месте города, наследует его
 * правила: внизу нельзя было драться, казна открывалась из зала, а посреди
 * подземелья стояла таверна.
 *
 * Уведённое подземелье делает все эти проверки верными само собой — включая
 * те, которых ещё не написали. Полагаться на расстояние надёжнее, чем на
 * память: забытую проверку не видно, она просто тихо работает неправильно.
 *
 * Мир занимает ±224 метра, так что пересечься не с чем.
 */
export const DUNGEON_ORIGIN_CHUNK = 128;

/**
 * Сколько человек помещается в один зал.
 *
 * Из замысла: «инстанс на 12 игроков, соло и группы вместе». Подземелье не
 * личная комната — внутри флаги не действуют, и встреча с чужаком там такая же
 * часть вылазки, как нежить.
 */
export const DUNGEON_CAPACITY = 12;

/**
 * Сколько секунд зал принимает новых.
 *
 * Лобби пока нет, и это его замена: спустившиеся в одну минуту попадают вместе,
 * опоздавший получает свой зал. Без окна человек подсаживался бы к тому, кто
 * уже унёс всю добычу, и заставал пустые сундуки.
 */
export const DUNGEON_JOIN_SECONDS = 90;

/** Сколько чанков в ширину занимает этаж. Один — этого хватает первому срезу. */
export const DUNGEON_RADIUS = 0;

/** Середина этажа в мировых координатах. */
export const DUNGEON_CENTER = {
  x: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
  z: DUNGEON_ORIGIN_CHUNK * CHUNK_SIZE,
};


/**
 * Настенные факелы зала.
 *
 * Темнота — механика вехи 6, но включать её раньше переносного огня значит
 * отдать игроку чёрный экран: первый же спуск кончился тем, что зал приняли
 * за несуществующий. Пока огонь стоит по стенам, как в городе, — видно, куда
 * идти, и видно, что это подземелье, а не пустота.
 *
 * Когда появится факел в руке, этот свет станет редким и неровным: тогда
 * темнота начнёт работать на игру, а не против неё.
 */
export const DUNGEON_LAMPS: readonly { x: number; z: number }[] = [
  // Вдоль пути от входа к выходу: по ним и ориентируются.
  { x: -6, z: 22 },
  { x: 6, z: 22 },
  { x: -6, z: 8 },
  { x: 6, z: 8 },
  { x: -6, z: -8 },
  { x: 6, z: -8 },
  // У ниши с порталом.
  { x: -4, z: -22 },
  { x: 4, z: -22 },
  // По углам зала, чтобы стены читались, а не тонули.
  { x: -26, z: 26 },
  { x: 26, z: 26 },
  { x: -26, z: -26 },
  { x: 26, z: -26 },
].map((spot) => ({ x: DUNGEON_CENTER.x + spot.x, z: DUNGEON_CENTER.z + spot.z }));

/** Высота факела над полом. */
export const DUNGEON_LAMP_HEIGHT = 2.7;

/** Высота зала: в потолок упираться не должно, но и неба тут нет. */
const HALL_HEIGHT = 4;
const WALL = 1;

/** Где игрок появляется, войдя вниз. */
export const DUNGEON_ENTRY = {
  x: DUNGEON_CENTER.x,
  y: 0.1,
  z: DUNGEON_CENTER.z + 24,
};

/** Портал наружу. Стоит у дальней стены: выход надо заслужить дорогой. */
export const DUNGEON_EXIT = {
  x: DUNGEON_CENTER.x,
  z: DUNGEON_CENTER.z - 27,
};
/**
 * С какого расстояния портал откликается.
 *
 * Чуть шире самой метки: она скромная, и упираться в неё носом, чтобы нажать,
 * было бы наказанием за то, что её нашли.
 */
export const DUNGEON_EXIT_RANGE = 4.2;
/**
 * Знак выхода: половина стороны и место, где он нарисован.
 *
 * Сперва он лежал краской на полу, но пол видно только под ногами: идущий
 * смотрит вперёд, и семиметровый знак под собой замечал не сразу. На задней
 * стене ниши он оказывается ровно на линии взгляда и читается через весь зал.
 *
 * Размер поэтому и меньше — вдвое против напольного. Не из экономии: стена
 * высотой четыре метра, и знак обязан на ней помещаться, а не упираться
 * в потолок обрезанным краем.
 */
export const DUNGEON_EXIT_MARK = 1.7;
/** Внутренняя грань задней стенки ниши: на ней и краска. */
export const DUNGEON_EXIT_WALL = DUNGEON_EXIT.z - 5;
/** Середина знака по высоте: на уровне глаз идущего, а не под потолком. */
export const DUNGEON_EXIT_MARK_HEIGHT = 1.95;

export function isDungeon(instanceId: string): boolean {
  return instanceId.startsWith(DUNGEON_PREFIX);
}

/** Имя нового подземелья. Зерно в имени — значит оно есть и у клиента. */
export function dungeonInstance(seed: number): string {
  return `${DUNGEON_PREFIX}${(seed >>> 0).toString(36)}`;
}

export function dungeonSeed(instanceId: string): number {
  return parseInt(instanceId.slice(DUNGEON_PREFIX.length), 36) >>> 0;
}

/** То же зерно, что у чанков: одинаковые числа на обеих сторонах. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Один этаж: зал с колоннами и глухими стенами по краю.
 *
 * Это ещё не процедурная сборка комнат из вехи 6 — это самый тонкий ломоть,
 * на котором видно, работает ли связка «вошёл, походил, вышел». Комнаты,
 * коридоры и этажи встанут сюда же, когда связка окажется живой.
 */
export function generateDungeonChunk(seed: number): ChunkSource {
  return (cx: number, cz: number): LevelBox[] => {
    // Этаж один и конечен: за его пределами ничего нет, и туда не выйти —
    // край закрыт стеной, как и край мира.
    const dx = cx - DUNGEON_ORIGIN_CHUNK;
    const dz = cz - DUNGEON_ORIGIN_CHUNK;
    if (Math.abs(dx) > DUNGEON_RADIUS || Math.abs(dz) > DUNGEON_RADIUS) return [];

    const { x: originX, z: originZ } = chunkCenter(cx, cz);
    const half = CHUNK_SIZE / 2;
    const boxes: LevelBox[] = [];

    // Пол и потолок. Потолок нужен не для красоты: без него сверху светит
    // небо, и подземелье перестаёт быть подземельем.
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(originX, -0.5, originZ, CHUNK_SIZE, 1, CHUNK_SIZE),
    });
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(originX, HALL_HEIGHT + 0.5, originZ, CHUNK_SIZE, 1, CHUNK_SIZE),
    });

    // Стены по краю этажа.
    for (const [wx, wz, w, d] of [
      [0, -half, CHUNK_SIZE, WALL],
      [0, half, CHUNK_SIZE, WALL],
      [-half, 0, WALL, CHUNK_SIZE],
      [half, 0, WALL, CHUNK_SIZE],
    ] as const) {
      boxes.push({
        kind: 'brick',
        box: boxFromCenter(originX + wx, HALL_HEIGHT / 2, originZ + wz, w, HALL_HEIGHT, d),
      });
    }

    const layout = hallLayout(seed);

    // Колонны: укрытия и ориентиры. Без них зал — пустая коробка, в которой
    // некуда спрятаться и не за что зацепиться глазом.
    for (const pillar of layout.pillars) {
      boxes.push({
        kind: 'pillar',
        box: boxFromCenter(
          pillar.x,
          HALL_HEIGHT / 2,
          pillar.z,
          pillar.width,
          HALL_HEIGHT,
          pillar.width,
        ),
      });
    }

    // Сундуки стоят прямо в геометрии зала: так они и видны, и телесны,
    // и приходят на обе стороны одним генератором — пересылать нечего.
    for (const chest of layout.chests) {
      boxes.push({
        kind: 'chest',
        box: boxFromCenter(chest.x, CHEST_HEIGHT / 2, chest.z, CHEST_SIZE, CHEST_HEIGHT, CHEST_SIZE),
      });
    }

    addExitMark(boxes);
    return boxes;
  };
}

/**
 * Метка выхода: ниша в стене.
 *
 * Портал был невидим — просто точка на полу, — и игрок в первом же забеге
 * заблудился в собственном зале. Ниша нужна не для красоты: стена, которая
 * расступается, читается как выход издалека. Где именно встать, говорит знак
 * на полу; и знак, и свет над ним ставит клиент.
 */
function addExitMark(boxes: LevelBox[]): void {
  const { x, z } = DUNGEON_EXIT;

  // Ниша: пол и потолок уходят за линию стены, образуя карман.
  const pocket = 6.6;

  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, -0.5, z - 2.5, pocket, 1, 6),
  });
  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, HALL_HEIGHT + 0.5, z - 2.5, pocket, 1, 6),
  });
  // Боковины кармана, чтобы он был карманом, а не дырой в стене.
  for (const side of [-1, 1]) {
    boxes.push({
      kind: 'brick',
      box: boxFromCenter(
        x + side * (pocket / 2),
        HALL_HEIGHT / 2,
        z - 2.5,
        WALL,
        HALL_HEIGHT,
        6,
      ),
    });
  }
  // Задняя стенка кармана: сквозь портал не проходят, в него входят.
  boxes.push({
    kind: 'brick',
    box: boxFromCenter(x, HALL_HEIGHT / 2, z - 5.5, pocket, HALL_HEIGHT, WALL),
  });

  // Кольца на полу больше нет: на его месте знак, нарисованный краской.
  // Он ничего не преграждает и живёт целиком на клиенте — см. scene.ts,
  // `exitMark`. Серверу знать о краске нечего.
}

// ---------- сундуки ----------

/**
 * Сундук: то, ради чего вниз и идут.
 *
 * Устроен как ресурсная нода, а не как предмет мира: раскладка выводится из
 * зерна инстанса, сервер хранит только **вскрытые**. Нетронутый сундук не
 * занимает ни байта ни в памяти, ни в сети — его знают обе стороны, потому
 * что обе считают его одним генератором.
 */
export interface DungeonChest {
  /** Устойчивое имя вида `chest.номер`: по нему сервер находит сундук заново. */
  id: string;
  x: number;
  z: number;
}

/** Сторона сундука и его высота: по ним же строится коробка в зале. */
export const CHEST_SIZE = 1.1;
export const CHEST_HEIGHT = 0.85;

/** С какого расстояния сундук поддаётся. Та же мерка, что у нод. */
export const CHEST_RANGE = 3.2;

/**
 * Сколько секунд вскрывается сундук.
 *
 * Заметно дольше любой добычи, и это главное в нём: замысел вехи обещал
 * «уязвим и слышен». Пока идёт полоса, игрок стоит на месте спиной к залу —
 * и чужая жадность становится чужой ошибкой.
 */
export const CHEST_TIME = 5;

/** Сколько сундуков в зале: от и до. */
const CHESTS_MIN = 4;
const CHESTS_MAX = 6;

/**
 * Что лежит в сундуках.
 *
 * Свитки рецептов падают **здесь**, а не с умертвия: замысел с самого начала
 * привязывал рецептурный ярус к подземельям, и до сих пор они висели на мобе
 * временно, за неимением другого источника. Теперь у похода вниз есть причина,
 * которой нет наверху.
 */
export const CHEST_LOOT: readonly LootEntry[] = [
  { itemId: 'coin', name: 'Монеты', chance: 0.9, min: 12, max: 60 },
  { itemId: 'grave_silver', name: 'Могильное серебро', chance: 0.45, min: 1, max: 4 },
  { itemId: 'crude_ingot', name: 'Грубый слиток', chance: 0.35, min: 1, max: 3 },
  { itemId: 'health_potion', name: 'Зелье здоровья', chance: 0.3, min: 1, max: 2 },
  { itemId: 'recipe_scrap', name: 'Обрывок рецепта', chance: 0.25, min: 1, max: 2 },
  // Свитки трёх ремёсел: выпавший чужой прочесть нельзя, и это не досада,
  // а повод торговать.
  { itemId: 'scroll_iron_sword', name: 'Свиток: железный меч', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_iron_helm', name: 'Свиток: железный шлем', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_hunting_bow', name: 'Свиток: охотничий лук', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_leather_cap', name: 'Свиток: кожаный шлем', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_health_potion', name: 'Свиток: зелье здоровья', chance: 0.09, min: 1, max: 1 },
  { itemId: 'scroll_stamina_draught', name: 'Свиток: настой сил', chance: 0.09, min: 1, max: 1 },
];

/**
 * Кто живёт в зале.
 *
 * Мало и тяжело, а не много и тяжело. Первый состав был из шести элитных
 * нежитей, и проверка это показала прямо: одиночка не доходил до портала
 * ни разу. Зал — одна комната, разойтись в ней негде, поэтому риск задаётся
 * качеством противника, а не количеством; толпа здесь читается не как
 * опасность, а как запертая дверь.
 *
 * Умертвие — редкий гость и главная причина уйти с добычей, не жадничая.
 */
export function mobsForDungeon(seed: number): MobId[] {
  const random = mulberry32(seed ^ 0x5bf03635);
  const roster: MobId[] = ['skeleton', 'skeleton', 'ghoul'];
  const extra: MobId[] = ['skeleton', 'ghoul', 'ghoul', 'wight'];
  roster.push(extra[Math.floor(random() * extra.length)]!);
  return roster;
}

interface HallLayout {
  pillars: { x: number; z: number; width: number }[];
  chests: DungeonChest[];
}

/**
 * Разобранные раскладки: генератор зовут каждый кадр прицеливания.
 *
 * Список ограничен, потому что зерно у каждого забега своё: без предела
 * сервер за сутки накопил бы раскладку каждого подземелья, которое когда-либо
 * заводили. Старые вытесняются — заново собрать их всё равно дёшево.
 */
const layouts = new Map<number, HallLayout>();
const LAYOUT_CACHE = 32;

/**
 * Раскладка зала: колонны и сундуки **из одного потока чисел**.
 *
 * Порознь их считать нельзя: два независимых генератора рано или поздно
 * поставят сундук внутрь колонны, и вскрыть его будет неоткуда. Здесь сундуки
 * расставляются после колонн и знают про них.
 */
export function hallLayout(seed: number): HallLayout {
  const cached = layouts.get(seed);
  if (cached) return cached;

  const random = mulberry32(seed);
  const { x: originX, z: originZ } = DUNGEON_CENTER;
  const spread = CHUNK_SIZE / 2 - 6;

  const pillars: HallLayout['pillars'] = [];
  const count = 8 + Math.floor(random() * 6);
  for (let i = 0; i < count; i++) {
    const width = 1.4 + random() * 1.2;
    pillars.push({
      x: originX + (random() - 0.5) * (CHUNK_SIZE - 12),
      z: originZ + (random() - 0.5) * (CHUNK_SIZE - 12),
      width,
    });
  }

  const chests: DungeonChest[] = [];
  const wanted = CHESTS_MIN + Math.floor(random() * (CHESTS_MAX - CHESTS_MIN + 1));

  for (let attempt = 0; attempt < 200 && chests.length < wanted; attempt++) {
    const x = originX + (random() * 2 - 1) * spread;
    const z = originZ + (random() * 2 - 1) * spread;

    // У входа и у портала сундуков нет: добычу надо унести, а не подобрать
    // с порога. Между ними и лежит весь риск.
    if (Math.hypot(x - DUNGEON_ENTRY.x, z - DUNGEON_ENTRY.z) < 10) continue;
    if (Math.hypot(x - DUNGEON_EXIT.x, z - DUNGEON_EXIT.z) < 8) continue;

    const blocked =
      pillars.some((p) => Math.hypot(x - p.x, z - p.z) < p.width / 2 + CHEST_SIZE) ||
      chests.some((c) => Math.hypot(x - c.x, z - c.z) < CHEST_RANGE * 2);
    if (blocked) continue;

    chests.push({ id: `chest.${chests.length}`, x, z });
  }

  const layout: HallLayout = { pillars, chests };
  if (layouts.size >= LAYOUT_CACHE) layouts.delete(layouts.keys().next().value as number);
  layouts.set(seed, layout);
  return layout;
}

export function dungeonChests(seed: number): DungeonChest[] {
  return hallLayout(seed).chests;
}

/** Сундук по имени — как `findNode` у ресурсных нод: ничего не храня. */
export function findChest(seed: number, id: string): DungeonChest | null {
  return dungeonChests(seed).find((chest) => chest.id === id) ?? null;
}

// ---------- мешок павшего ----------

/**
 * Сколько секунд мешок лежит на полу.
 *
 * Три минуты — это «успей дойти», а не «вернись потом». Убийце должно хватить
 * времени обыскать павшего, но забег не должен превращаться в склад: мешок,
 * лежащий вечно, отменяет саму ставку подземелья.
 *
 * Здесь, а не в общем месте, потому что мешки пока роняют только внизу.
 * Появятся наверху — переедет вместе с ними.
 */
export const BAG_SECONDS = 180;

/** С какого расстояния мешок обыскивают. Та же мерка, что у сундука. */
export const BAG_RANGE = 3.2;
