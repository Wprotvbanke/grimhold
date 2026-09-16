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
