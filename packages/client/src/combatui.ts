import {
  SPELLS,
  type CombatEvent,
  type SelfState,
  type SpellId,
} from '@grimhold/shared';

/**
 * Боевой интерфейс: полоски состояния, всплывающие числа урона, панель
 * заклинаний и экран смерти.
 *
 * Всё здесь — только отображение того, что прислал сервер. Ни одно число
 * не считается на клиенте: иначе полоска здоровья врала бы при рассинхроне.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Сколько всплывающих чисел держать на экране одновременно. */
const MAX_DAMAGE_LABELS = 24;

export class CombatUi {
  private readonly vitals = el<HTMLDivElement>('vitals');
  private readonly damageLayer = el<HTMLDivElement>('damage');
  private readonly hurt = el<HTMLDivElement>('hurt');
  private readonly deathScreen = el<HTMLDivElement>('deathScreen');
  private readonly targetInfo = el<HTMLDivElement>('targetInfo');

  /** Когда каждое заклинание снова готово, в миллисекундах performance.now(). */
  private readonly cooldowns = new Map<SpellId, number>();

  private hurtTimer = 0;
  private targetTimer = 0;

  constructor(onRespawn: () => void) {
    // Захват мыши браузер отдаёт только по жесту пользователя, поэтому
    // запрашиваем его прямо в обработчике клика, а не когда придёт ответ сервера.
    el<HTMLButtonElement>('respawnBtn').addEventListener('click', () => {
      this.deathScreen.hidden = true;
      onRespawn();
    });
  }

  show(visible: boolean): void {
    this.vitals.hidden = !visible;
  }

  /** Обновляет полоски. Числа приходят от сервера как есть. */
  updateVitals(self: SelfState): void {
    setBar('barHealth', self.health, self.maxHealth);
    setBar('barStamina', self.stamina, self.maxStamina);
    setBar('barMana', self.mana, self.maxMana);
  }

  updateCooldowns(now: number): void {
    if (this.hurtTimer > 0 && now > this.hurtTimer) {
      this.hurt.style.opacity = '0';
      this.hurtTimer = 0;
    }
    if (this.targetTimer > 0 && now > this.targetTimer) {
      this.targetInfo.hidden = true;
      this.targetTimer = 0;
    }
  }

  /** Заклинание ушло на перезарядку. Сервер всё равно проверит сам. */
  markCast(spellId: SpellId, now: number): void {
    const spell = SPELLS[spellId];
    this.cooldowns.set(spellId, now + (spell.castTime + spell.cooldown) * 1000);
  }

  isReady(spellId: SpellId, now: number): boolean {
    return (this.cooldowns.get(spellId) ?? 0) <= now;
  }

  /**
   * Показывает событие боя. Экранные координаты считает вызывающий код —
   * ему доступна камера.
   */
  showEvent(event: CombatEvent, screen: { x: number; y: number } | null, selfId: string): void {
    const incoming = event.targetId === selfId;

    if (incoming && event.kind === 'hit') {
      // Красная виньетка по краям — понятно, что бьют, даже если не видишь кем.
      this.hurt.style.opacity = '1';
      this.hurtTimer = performance.now() + 220;
    }

    if (!screen) return;

    const label = document.createElement('div');
    label.className = `dmg ${labelClass(event, incoming)}`;
    label.textContent = labelText(event);
    label.style.left = `${screen.x}px`;
    label.style.top = `${screen.y}px`;

    this.damageLayer.append(label);
    while (this.damageLayer.childElementCount > MAX_DAMAGE_LABELS) {
      this.damageLayer.firstElementChild?.remove();
    }
    setTimeout(() => label.remove(), 1000);
  }

  /** Полоска здоровья того, по кому попали — короткая, как в старых MMO. */
  showTarget(name: string, hp: number): void {
    this.setTarget(name, hp);
    this.targetInfo.hidden = false;
    this.targetTimer = performance.now() + 4000;
  }

  /**
   * Обновляет подпись и полоску, не продлевая показ.
   *
   * Имя и полоска правятся строго вместе: в подписи стоит процент здоровья,
   * и стоит обновить одно без другого, как цифра начинает спорить с полоской.
   *
   * Обновлять вообще приходится потому, что событие боя приходит раньше
   * снапшота: в момент удара клиент ещё знает здоровье цели до этого удара.
   * Нарисованная один раз полоска застывала на предпоследнем значении —
   * смертельный удар оставлял её на половине.
   */
  setTarget(name: string, hp: number): void {
    el<HTMLDivElement>('targetName').textContent = name;
    const fill = this.targetInfo.querySelector('#targetBar > i') as HTMLElement;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, hp))})`;
  }

  /** Кого показывает полоска прямо сейчас — пусто, если она скрыта. */
  get targetVisible(): boolean {
    return !this.targetInfo.hidden;
  }

  showDeath(killerName: string | undefined): void {
    el<HTMLParagraphElement>('deathCause').textContent = killerName
      ? `Тебя убил: ${killerName}`
      : 'Ты не пережил этот день';
    this.deathScreen.hidden = false;
  }

  hideDeath(): void {
    this.deathScreen.hidden = true;
    this.hurt.style.opacity = '0';
  }

  get dead(): boolean {
    return !this.deathScreen.hidden;
  }

}

function setBar(id: string, current: number, max: number): void {
  const bar = el<HTMLDivElement>(id);
  const fill = bar.querySelector('i') as HTMLElement;
  const text = bar.querySelector('span') as HTMLElement;
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  fill.style.transform = `scaleX(${ratio})`;
  text.textContent = `${Math.round(current)} / ${max}`;
}

function labelClass(event: CombatEvent, incoming: boolean): string {
  if (event.kind === 'heal') return 'heal';
  if (event.kind === 'blocked') return 'blocked';
  if (event.kind === 'dodged') return 'dodged';
  if (event.backstab) return 'crit';
  return incoming ? 'in' : 'out';
}

function labelText(event: CombatEvent): string {
  switch (event.kind) {
    case 'blocked':
      return `блок ${event.amount}`;
    case 'dodged':
      return 'уклонение';
    case 'miss':
      return 'мимо';
    case 'heal':
      return `+${event.amount}`;
    case 'death':
      return 'смерть';
    default:
      return event.backstab ? `${event.amount} в спину!` : String(event.amount);
  }
}
