/**
 * Снимок игры настоящим браузером.
 *
 *   npx tsx scripts/screenshot.ts [файл.png]
 *
 * Нужен потому, что глазами картинку видит только человек, а правки вида от
 * первого лица приходится делать вслепую. Замеры по костям при этом врут:
 * однажды они показывали кулаки у краёв кадра, а на экране руки были
 * гигантскими и сведёнными в центр — ошибка нашлась только на снимке.
 *
 * Работает против запущенного `npm run dev` и входит тестовой учётной записью.
 */
import puppeteer from 'puppeteer';

const OUTPUT = process.argv[2] ?? 'screenshot.png';

const browser = await puppeteer.launch({
  headless: true,
  // Без этих флагов WebGL в headless не поднимается: нужен программный вывод.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (message) => {
    const text = message.text();
    if (/ошибк|error|\[sky\]/i.test(text)) console.log('  [браузер]', text.slice(0, 200));
  });

  /**
   * `GRIMHOLD_FX=off` — снять без постобработки.
   *
   * Сравнивать «с эффектами» и «без» можно только двумя снимками подряд:
   * часы мира идут, и кадр в сумерках против кадра ночью ничего не докажет.
   * Настройки живут в localStorage, поэтому кладём их туда до загрузки игры.
   */
  if (process.env.GRIMHOLD_FX === 'off') {
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('grimhold.settings', JSON.stringify({ effects: 'off' }));
    });
  }

  /**
   * `GRIMHOLD_SLOW=мбит` — придушить канал.
   *
   * Локально всё читается с диска за доли секунды, и экран загрузки
   * не поймать в кадр. А главное — на быстром канале не видно того,
   * ради чего он сделан: как игра выглядит, пока качается.
   */
  const slow = Number(process.env.GRIMHOLD_SLOW ?? 0);
  if (slow > 0) {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 60,
      downloadThroughput: (slow * 1_000_000) / 8,
      uploadThroughput: (slow * 500_000) / 8,
    });
  }

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(2000);

  await page.type('#authUser', 'test');
  await page.type('#authPass', 'test123');
  await page.click('#loginBtn');
  await wait(4000);

  /**
   * Перебираем персонажей: часть может быть занята прошлой сессией.
   *
   * `GRIMHOLD_CHAR=номер` — начать с этого персонажа. Нужно, когда снимку
   * важен не мир, а рюкзак: у первого он забит вещами прошлых проверок,
   * и выданная вещь в него просто не влезает.
   */
  const first = Number(process.env.GRIMHOLD_CHAR ?? 0);
  let entered = false;
  for (let step = 0; step < 3 && !entered; step++) {
    const index = (first + step) % 3;
    await page.evaluate((i) => {
      const buttons = [...document.querySelectorAll('#charList button')];
      (buttons[i] as HTMLButtonElement | undefined)?.click();
    }, index);
    await wait(2500);
    entered = await page.evaluate(() => document.querySelector('#charScreen')?.hasAttribute('hidden') === true);
  }
  if (!entered) throw new Error('не удалось войти ни одним персонажем');

  /**
   * `loading` вторым аргументом — снять сам экран загрузки.
   *
   * Он живёт секунды: ждать, как обычно, двенадцать — значит снять уже
   * построенный город. Поэтому стреляем сразу после выбора персонажа.
   */
  if (process.argv[3] === 'loading') {
    await wait(Number(process.env.GRIMHOLD_AFTER ?? 1500));
    await page.screenshot({ path: OUTPUT });
    const state = await page.evaluate(() => {
      const node = document.getElementById('loading');
      if (!node) return { found: false };
      const style = getComputedStyle(node);
      return {
        found: true,
        hidden: node.hasAttribute('hidden'),
        display: style.display,
        opacity: style.opacity,
        zIndex: style.zIndex,
        background: style.backgroundImage.slice(0, 60),
        fill: (document.getElementById('loadingFill') as HTMLElement | null)?.style.width,
        text: document.getElementById('loadingText')?.textContent,
      };
    });
    console.log('  [loading]', JSON.stringify(state));
    await page.screenshot({ path: OUTPUT });
    console.log(`снимок сохранён: ${OUTPUT}`);
    await browser.close();
    process.exit(0);
  }

  // Ждём загрузку моделей и пару секунд игры.
  await wait(12000);

  /**
   * `GRIMHOLD_WALK=секунды` — пройти вперёд перед снимком.
   *
   * С точки появления до городских стен семьдесят метров, и стыки кладки
   * или створки ворот оттуда не разглядеть. Прямо вперёд — северная арка.
   */
  /**
   * `GRIMHOLD_TP="x, z"` или `"x, y, z"` — перенестись в точку перед снимком,
   * через телепорт служебного меню. До люка за лавкой или до угла таверны
   * от точки появления не дойти одной клавишей W.
   */
  const place = process.env.GRIMHOLD_TP;
  if (place) {
    await page.keyboard.press('F2');
    await wait(600);
    await page.type('#adminTeleport', place);
    await page.keyboard.press('Enter');
    await wait(600);
    await page.click('#adminClose');
    await wait(3000);
  }

  /**
   * `GRIMHOLD_HOUR=noon|dawn|dusk|midnight` — перевести часы мира.
   *
   * Небо и свет проверяются только в своё время суток: луну днём не увидишь,
   * а ночью не увидишь, как она уходит. Час задаётся латиницей — русское
   * слово из оболочки доезжает сюда испорченным, и кнопка не находится.
   */
  const HOURS: Record<string, string> = {
    dawn: 'Рассвет',
    noon: 'Полдень',
    dusk: 'Закат',
    midnight: 'Полночь',
  };
  const hour = HOURS[process.env.GRIMHOLD_HOUR ?? ''];
  if (hour) {
    await page.keyboard.press('F2');
    // Ждём факта, а не паузы: меню доходит до игры не всегда за полсекунды,
    // и клик по кнопке часов уходил в пустоту — время оставалось прежним.
    await page.waitForFunction(
      () => document.getElementById('admin')?.hasAttribute('hidden') === false,
      { timeout: 10000 },
    );
    const clicked = await page.evaluate((label: string) => {
      const buttons = [...document.querySelectorAll('#adminHours button')] as HTMLButtonElement[];
      const wanted = buttons.find((button) => button.textContent === label);
      wanted?.click();
      return { found: !!wanted, buttons: buttons.map((button) => button.textContent) };
    }, hour);
    console.log('  [clock]', JSON.stringify(clicked));
    await wait(600);
    await page.click('#adminClose');
    // Солнце едет к новому часу не мгновенно.
    await wait(6000);
  }

  /**
   * `GRIMHOLD_PITCH=градусы` — посмотреть вверх (или вниз при минусе).
   *
   * Небо в кадр иначе не попадает: взгляд от первого лица смотрит в горизонт,
   * а луна высоко.
   */
  const pitch = Number(process.env.GRIMHOLD_PITCH ?? 0);
  const turn = Number(process.env.GRIMHOLD_YAW ?? 0);
  if (pitch !== 0 || turn !== 0) {
    await page.mouse.click(800, 450);
    await wait(600);
    // Поворот вокруг себя: `GRIMHOLD_YAW=градусы`, вправо — плюс.
    if (turn !== 0) {
      await page.mouse.move(800 + turn * 8.7, 450, { steps: 12 });
      await wait(500);
    }
    // Мышь в захвате двигает взгляд: вверх — это отрицательное смещение.
    // Восемь с лишним пикселей на градус — чувствительность игры (0.002 рад
    // на пиксель); без этого «посмотри на 80°» поднимало голову на тридцать.
    if (pitch !== 0) {
      await page.mouse.move(800 + turn * 8.7, 450 - pitch * 8.7, { steps: 12 });
      await wait(800);
    }
  }

  /**
   * `GRIMHOLD_TORCH=1` — выдать факел и взять его в левую руку.
   *
   * Внизу мгла на пять метров и своего огня нет: без факела кадр подземелья
   * выходит чёрным, и по нему ничего не докажешь.
   */
  if (process.env.GRIMHOLD_TORCH === '1') {
    await page.keyboard.press('F2');
    await wait(600);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      buttons.find((button) => button.textContent === 'Факел')?.click();
    });
    await wait(800);
    await page.click('#adminClose');
    await wait(500);
    await page.keyboard.press('Tab');
    await wait(900);
    await page.evaluate(() => {
      const torch = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Факел'),
      );
      torch?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await wait(900);
    await page.keyboard.press('Tab');
    await wait(1500);
  }

  /**
   * `GRIMHOLD_DIVE=1` — спуститься в подземелье (E у люка), а `GRIMHOLD_TP2` —
   * перенестись уже внизу. Иначе обитателей дна снять нечем: пешком до них
   * идти через три этажа.
   */
  if (process.env.GRIMHOLD_DIVE === '1') {
    await page.click('canvas');
    await wait(500);
    await page.keyboard.press('KeyE');
    await wait(3500);
  }

  const under = process.env.GRIMHOLD_TP2;
  if (under) {
    await page.keyboard.press('F2');
    await wait(600);
    // Поле чистим прямо в DOM: в нём лежат координаты первого переноса,
    // а два набора чисел подряд телепорт считает мусором и молчит.
    await page.evaluate(() => {
      (document.getElementById('adminTeleport') as HTMLInputElement).value = '';
    });
    await page.type('#adminTeleport', under);
    await page.keyboard.press('Enter');
    await wait(600);
    await page.click('#adminClose');
    await wait(900);
  }

  const walk = Number(process.env.GRIMHOLD_WALK ?? 0);
  if (walk > 0) {
    // Щелчок по координатам, а не по элементу: подсказка входа лежит поверх
    // холста, и puppeteer отказывался его жать — «не кликабельно».
    await page.mouse.click(800, 450);
    await wait(600);
    await page.keyboard.down('KeyW');
    await wait(walk * 1000);
    await page.keyboard.up('KeyW');
    await wait(1200);
  }

  /**
   * Второй аргумент — что открыть перед снимком.
   *
   * Панели живут за клавишей, и снять их иначе нельзя: мышь захвачена,
   * а интерфейс поверх мира. Пока был только мир, аргумента не требовалось.
   */
  const open = process.argv[3];
  if (open === 'inventory') {
    await page.keyboard.press('Tab');
    await wait(1200);
    // Третий аргумент — вкладка окна: craft, growth, help. Без него — рюкзак.
    const tab = process.argv[4];
    if (tab) {
      await page.click(`.inv-tab[data-page="${tab}"]`);
      await wait(800);
    }
  }

  /**
   * `bow` — выдать себе лук со стрелами и выстрелить.
   *
   * Единственный способ снять выстрел: до лука в игре надо дойти ремеслом
   * и свитком, а снимок нужен сейчас. Идёт через служебное меню, то есть
   * теми же командами, что и у живого ведущего.
   */
  /**
   * `axe` — выдать грубый топор и взять его в руку.
   *
   * Ждём **факта**, а не пауз: то F2 не доходит до игры, то рюкзак ещё
   * уезжает — и кадр выходит то со служебным меню, то вовсе без рук
   * (docs/checks.md, то же правило, что у сквозных проверок).
   */
  /**
   * `potion` — выдать зелья, положить на панель и выпить одно.
   *
   * Проверяется то, что видно только глазами: картинка на ячейке и отсчёт
   * отката поверх неё.
   */
  /**
   * `stack` — проверить складывание: выдать зелья двумя стопками и перетащить
   * одну на другую мышью, как это делает игрок.
   */
  /**
   * `bank` — открыть казну: там окно шире обычного, и раскладку видно только так.
   */
  if (open === 'bank') {
    await page.keyboard.press('F2');
    await page.waitForFunction(
      () => document.getElementById('admin')?.hasAttribute('hidden') === false,
      { timeout: 10000 },
    );
    await page.evaluate(() => {
      (document.getElementById('adminTeleport') as HTMLInputElement).value = '';
    });
    await page.type('#adminTeleport', '-4, 4');
    await page.keyboard.press('Enter');
    await wait(800);
    await page.click('#adminClose');
    await wait(1200);

    // Смотрим на ларец и открываем его тем же E, что и в игре. Ждём факта:
    // подсказка «Казна — E» появляется не в тот же миг, что и подход.
    await page.mouse.click(800, 450);
    await wait(800);
    for (let tries = 0; tries < 6; tries++) {
      await page.keyboard.press('KeyE');
      await wait(700);
      const open = await page.evaluate(
        () => document.getElementById('bankCol')?.hasAttribute('hidden') === false,
      );
      if (open) break;
    }
    await wait(800);
  }

  if (open === 'stack') {
    const shown = (id: string) =>
      page.waitForFunction(
        (node: string) => document.getElementById(node)?.hasAttribute('hidden') === false,
        { timeout: 10000 },
        id,
      );

    await page.keyboard.press('F2');
    await shown('admin');
    // Две выдачи подряд: первая заполнит стопку, вторая ляжет рядом.
    for (let round = 0; round < 2; round++) {
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
        buttons.find((button) => button.textContent === 'Зелье лечения')?.click();
      });
      await wait(500);
    }
    await page.click('#adminClose');
    await wait(500);

    await page.keyboard.press('Tab');
    await shown('inventory');
    await wait(600);

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.inv-item')]
        .filter((node) => (node as HTMLElement).title.includes('Зелье'))
        .map((node) => node.textContent?.trim() || '1'),
    );
    console.log('  [stack] до:', JSON.stringify(before));

    const spots = await page.evaluate(() => {
      const potions = [...document.querySelectorAll('.inv-item')].filter((node) =>
        (node as HTMLElement).title.includes('Зелье'),
      ) as HTMLElement[];
      if (potions.length < 2) return null;
      const from = potions[0]!.getBoundingClientRect();
      const to = potions[1]!.getBoundingClientRect();
      return {
        fromX: from.left + from.width / 2,
        fromY: from.top + from.height / 2,
        toX: to.left + to.width / 2,
        toY: to.top + to.height / 2,
      };
    });
    if (spots) {
      await page.mouse.move(spots.fromX, spots.fromY);
      await page.mouse.down();
      await page.mouse.move(spots.toX, spots.toY, { steps: 14 });
      await wait(300);
      await page.mouse.up();
      await wait(700);
    } else {
      console.log('  [stack] двух стопок не нашлось');
    }

    const after = await page.evaluate(() =>
      [...document.querySelectorAll('.inv-item')]
        .filter((node) => (node as HTMLElement).title.includes('Зелье'))
        .map((node) => node.textContent?.trim() || '1'),
    );
    console.log('  [stack] после:', JSON.stringify(after));
  }

  /**
   * `magic` — выдать свитки, вставить один в клетки умений и повесить
   * на панель. Проверяется то, что видно только глазами: цвет свитка
   * в ряду умений и та же картинка в ячейке панели.
   */
  if (open === 'magic') {
    const shown = (id: string) =>
      page.waitForFunction(
        (node: string) => document.getElementById(node)?.hasAttribute('hidden') === false,
        { timeout: 10000 },
        id,
      );

    await page.keyboard.press('F2');
    await shown('admin');
    // Все три разряда сразу: смысл ряда умений в том, что цвета разные.
    await page.evaluate(() => {
      const wanted = ['Огненный шар', 'Заморозка', 'Заживление ран'];
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      for (const name of wanted) buttons.find((button) => button.textContent === name)?.click();
    });
    await wait(800);
    await page.click('#adminClose');
    await wait(500);

    await page.keyboard.press('Tab');
    await shown('inventory');

    // Тащим свитки в клетки умений мышью — тем же путём, что и игрок.
    for (let slot = 0; slot < 3; slot++) {
      const spot = await page.evaluate((index: number) => {
        const item = [...document.querySelectorAll('#backpackWrap .inv-item')].find((node) =>
          (node as HTMLElement).title.startsWith('Свиток') ||
          (node as HTMLElement).classList.contains('kind-spell'),
        ) as HTMLElement | undefined;
        const cell = document.querySelectorAll('#scrollCells .cell')[index];
        if (!item || !cell) return null;
        const from = item.getBoundingClientRect();
        const to = cell.getBoundingClientRect();
        return {
          fromX: from.left + from.width / 2,
          fromY: from.top + from.height / 2,
          toX: to.left + to.width / 2,
          toY: to.top + to.height / 2,
        };
      }, slot);
      if (!spot) continue;

      await page.mouse.move(spot.fromX, spot.fromY);
      await page.mouse.down();
      await page.mouse.move(spot.toX, spot.toY, { steps: 12 });
      await page.mouse.up();
      await wait(400);
    }

    // И один — на панель быстрого доступа, в седьмую ячейку.
    const onBar = await page.evaluate(() => {
      const item = document.querySelector('#scrollWrap .inv-item') as HTMLElement | null;
      const cell = document.querySelectorAll('#hotbar .hot')[6];
      if (!item || !cell) return null;
      const from = item.getBoundingClientRect();
      const to = cell.getBoundingClientRect();
      return {
        fromX: from.left + from.width / 2,
        fromY: from.top + from.height / 2,
        toX: to.left + to.width / 2,
        toY: to.top + to.height / 2,
      };
    });
    if (onBar) {
      await page.mouse.move(onBar.fromX, onBar.fromY);
      await page.mouse.down();
      await page.mouse.move(onBar.toX, onBar.toY, { steps: 12 });
      await page.mouse.up();
      await wait(500);
    }

    /**
     * `GRIMHOLD_CAST=1` — закрыть рюкзак и прочесть свиток с панели.
     *
     * Иначе не увидеть ни снаряда, ни отсчёта отката на ячейке: и то и другое
     * живёт ровно секунду после нажатия.
     */
    /**
     * `GRIMHOLD_MEDITATE=1` — сесть медитировать и снять кадр с виньеткой.
     *
     * Два подвоха, на которые уже наступали:
     * - **клетки умений могли забиться** прошлыми прогонами, и свежий свиток
     *   в них не влезет; поэтому сперва ищем «Медитацию» среди вставленных
     *   и только потом выдаём новую;
     * - **на полном запасе маны медитация кончается в тот же тик**, поэтому
     *   перед ней тратим ману огненными шарами.
     */
    if (process.env.GRIMHOLD_MEDITATE === '1') {
      /**
       * Рюкзак открываем, только если он закрыт.
       *
       * Режим `magic` оставляет окно открытым, и слепое нажатие Tab его
       * закрывало — дальше скрипт ждал открытия, которого никто не делал.
       */
      const openBag = async (): Promise<void> => {
        const already = await page.evaluate(
          () => document.getElementById('inventory')?.hasAttribute('hidden') === false,
        );
        if (!already) await page.keyboard.press('Tab');
        await shown('inventory');
      };

      await openBag();

      /** Лежит ли «Медитация» в клетках умений. */
      const inserted = async (): Promise<boolean> =>
        page.evaluate(() =>
          [...document.querySelectorAll('#scrollWrap .inv-item')].some((node) =>
            (node as HTMLElement).title.startsWith('Медитация'),
          ),
        );

      if (!(await inserted())) {
        await page.keyboard.press('Tab');
        await wait(300);
        await page.keyboard.press('F2');
        await shown('admin');
        await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
          buttons.find((button) => button.textContent === 'Медитация')?.click();
        });
        await wait(600);
        await page.click('#adminClose');
        await wait(400);
        await openBag();

        // Двойной щелчок по свитку в рюкзаке вставляет его в клетки умений —
        // тот же путь, которым это делает игрок.
        const spot = await page.evaluate(() => {
          const item = [...document.querySelectorAll('#backpackWrap .inv-item')].find((node) =>
            (node as HTMLElement).title.startsWith('Медитация'),
          ) as HTMLElement | undefined;
          if (!item) return null;
          const box = item.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        if (spot) {
          // Двойной щелчок: puppeteer шлёт его двумя, как настоящая мышь.
          await page.mouse.click(spot.x, spot.y);
          await page.mouse.click(spot.x, spot.y);
          await wait(500);
        }
      }

      // Вешаем именно «Медитацию» на восьмую ячейку — по имени, а не по месту
      // в ряду: порядок свитков в клетках зависит от прошлых прогонов.
      const drag = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#scrollWrap .inv-item')].find((node) =>
          (node as HTMLElement).title.startsWith('Медитация'),
        ) as HTMLElement | undefined;
        const hot = document.querySelectorAll('#hotbar .hot')[7];
        if (!item || !hot) return null;
        const from = item.getBoundingClientRect();
        const to = hot.getBoundingClientRect();
        return {
          fromX: from.left + from.width / 2,
          fromY: from.top + from.height / 2,
          toX: to.left + to.width / 2,
          toY: to.top + to.height / 2,
        };
      });
      if (drag) {
        await page.mouse.move(drag.fromX, drag.fromY);
        await page.mouse.down();
        await page.mouse.move(drag.toX, drag.toY, { steps: 12 });
        await page.mouse.up();
        await wait(500);
      }

      await page.keyboard.press('Tab');
      await wait(500);
      await page.mouse.click(800, 450);
      await wait(400);

      // Тратим ману: шар стоит четырнадцать, запас у первого персонажа семьдесят.
      for (let shot = 0; shot < 5; shot++) {
        await page.keyboard.press('Digit7');
        await wait(1900);
      }

      await page.keyboard.press('Digit8');
      await wait(Number(process.env.GRIMHOLD_AFTER ?? 3000));

      // Метки латиницей: консоль Windows показывает вывод в другой кодировке.
      const state = await page.evaluate(() => {
        const layer = document.getElementById('meditation');
        const cell = document.querySelectorAll('#hotbar .hot')[7] as HTMLElement | undefined;
        const name = cell?.title.split(String.fromCharCode(10))[0] ?? 'pusto';
        return `${layer?.className || 'net klassa'} | yacheika 8: ${name}`;
      });
      console.log(`vignette: ${state}`);
    }

    if (process.env.GRIMHOLD_CAST === '1') {
      await page.keyboard.press('Tab');
      await wait(600);
      await page.mouse.click(800, 450);
      await wait(400);
      await page.keyboard.press('Digit7');
      await wait(Number(process.env.GRIMHOLD_AFTER ?? 900));
    } else {
      await wait(Number(process.env.GRIMHOLD_AFTER ?? 600));
    }
  }

  if (open === 'potion') {
    const shown = (id: string) =>
      page.waitForFunction(
        (node: string) => document.getElementById(node)?.hasAttribute('hidden') === false,
        { timeout: 10000 },
        id,
      );

    await page.keyboard.press('F2');
    await shown('admin');
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      buttons.find((button) => button.textContent === 'Зелье лечения')?.click();
    });
    await wait(600);
    await page.click('#adminClose');
    await wait(500);

    // Кладём на панель перетаскиванием — тем же путём, что и игрок.
    await page.keyboard.press('Tab');
    await shown('inventory');
    const spot = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Зелье'),
      ) as HTMLElement | undefined;
      const cell = document.querySelectorAll('#hotbar .hot')[0];
      if (!item || !cell) return null;
      const from = item.getBoundingClientRect();
      const to = cell.getBoundingClientRect();
      return {
        fromX: from.left + from.width / 2,
        fromY: from.top + from.height / 2,
        toX: to.left + to.width / 2,
        toY: to.top + to.height / 2,
      };
    });
    if (spot) {
      await page.mouse.move(spot.fromX, spot.fromY);
      await page.mouse.down();
      await page.mouse.move(spot.toX, spot.toY, { steps: 12 });
      await page.mouse.up();
      await wait(500);
    }
    await page.keyboard.press('Tab');
    await wait(800);

    // Пьём и снимаем кадр, пока идёт откат.
    await page.mouse.click(800, 450);
    await wait(400);
    // Сперва ранимся: на полном здоровье лечение не покажет себя ничем.
    if (process.env.GRIMHOLD_HURT === '1') {
      await page.keyboard.press('F2');
      await shown('admin');
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('#adminHours button')] as HTMLButtonElement[];
        buttons.find((button) => button.textContent === 'Ранить')?.click();
      });
      await wait(500);
      await page.click('#adminClose');
      await wait(500);
      await page.mouse.click(800, 450);
      await wait(400);
    }

    // Жмём ту ячейку, где зелье: у разных персонажей панель своя.
    const slot = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#hotbar .hot')];
      const at = cells.findIndex((cell) => (cell as HTMLElement).title.includes('Зелье'));
      return at >= 0 ? at + 1 : 1;
    });
    const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const;
    await page.keyboard.press(keys[slot - 1] ?? 'Digit1');
    await wait(Number(process.env.GRIMHOLD_AFTER ?? 1200));

    // `GRIMHOLD_BAG=1` — заодно открыть рюкзак: на одном кадре и сетка
    // с картинкой вещи, и отсчёт на панели.
    if (process.env.GRIMHOLD_BAG === '1') {
      await page.keyboard.press('Tab');
      await shown('inventory');
      await wait(600);
    }
  }

  if (open === 'axe') {
    const shown = (id: string) =>
      page.waitForFunction(
        (node: string) => document.getElementById(node)?.hasAttribute('hidden') === false,
        { timeout: 10000 },
        id,
      );
    const hidden = (id: string) =>
      page.waitForFunction(
        (node: string) => document.getElementById(node)?.hasAttribute('hidden') === true,
        { timeout: 10000 },
        id,
      );

    await page.keyboard.press('F2');
    await shown('admin');
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      buttons.find((button) => button.textContent === 'Грубый топор')?.click();
    });
    await wait(600);
    // Закрываем кнопкой: открытое меню ставит курсор в поле поиска,
    // и второго F2 игра не видит вовсе.
    await page.click('#adminClose');
    await hidden('admin');

    await page.keyboard.press('Tab');
    await shown('inventory');
    await page.evaluate(() => {
      const axe = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Грубый топор'),
      );
      axe?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    /**
     * Топор в слоте — значит надет. Не дождались — снимаем **как есть**,
     * с открытым рюкзаком: на кадре будет видно, что пошло не так, а падение
     * скрипта не показало бы ничего.
     */
    /**
     * `GRIMHOLD_SWING=мс` — ударить и снять кадр посреди замаха.
     *
     * Иначе клип удара не проверить: он длится полторы секунды и играет
     * один раз. Первый щелчок захватывает мышь, второй бьёт.
     */
    let worn = true;
    try {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.slot.filled')].some((node) =>
            node.textContent?.includes('Грубый топор'),
          ),
        { timeout: 8000 },
      );
    } catch {
      worn = false;
      console.log('  ···  топор в слот не попал — снимаю рюкзак как есть');
    }

    if (worn) {
      await page.keyboard.press('Tab');
      await hidden('inventory');
      // Захват мыши: без него игра показывает подсказку и руки в кадр не идут.
      await page.mouse.click(800, 450);
      await wait(2500);
    }
  }

  if (open === 'bow') {
    await page.keyboard.press('F2');
    await wait(600);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#adminItems button')] as HTMLButtonElement[];
      for (const name of ['Охотничий лук', 'Стрелы']) {
        buttons.find((button) => button.textContent === name)?.click();
      }
    });
    await wait(900);
    await page.keyboard.press('F2');
    await wait(600);

    // Надеваем лук двойным щелчком по нему в рюкзаке.
    await page.keyboard.press('Tab');
    await wait(900);
    await page.evaluate(() => {
      const bow = [...document.querySelectorAll('.inv-item')].find((node) =>
        node.textContent?.includes('Охотничий лук'),
      );
      bow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await wait(900);
    await page.keyboard.press('Tab');
    await wait(900);

    // Захват мыши нужен, чтобы дошёл удар: без него клик уходит браузеру.
    await page.click('canvas');
    await wait(700);
    await page.mouse.down({ button: 'left' });
    await wait(80);
    await page.mouse.up({ button: 'left' });
    await wait(Number(process.argv[4] ?? 250));
  }

  /**
   * `GRIMHOLD_SPIN=n` — n кадров по кругу вместо одного.
   *
   * Мышь в игре захвачена, и повернуться иначе нельзя. Нужно, когда знаешь,
   * что цель рядом, но не знаешь, с какой стороны: моб успевает отойти,
   * пока идёт вход в игру.
   */
  const spin = Number(process.env.GRIMHOLD_SPIN ?? 0);
  if (spin > 0) {
    await page.click('canvas');
    await wait(400);
    for (let shot = 0; shot < spin; shot++) {
      await page.mouse.move(800 + shot * 180, 450);
      await wait(450);
      await page.screenshot({ path: OUTPUT.replace(/\.png$/, `_${shot}.png`) });
    }
    console.log(`снимков по кругу: ${spin}`);
  }

  const swing = Number(process.env.GRIMHOLD_SWING ?? 0);
  if (swing > 0) {
    await page.mouse.click(800, 450);
    await wait(600);
    await page.mouse.down();
    await page.mouse.up();
    await wait(swing);
  }

  await page.screenshot({ path: OUTPUT });
  console.log(`снимок сохранён: ${OUTPUT}`);
} finally {
  await browser.close();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
