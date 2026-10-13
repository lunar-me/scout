import type { KeyEventParams } from './hands';

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

/**
 * `code`, `windowsVirtualKeyCode` and — where the key also INSERTS something —
 * `text`, for the named keys an agent presses.
 *
 * Not decoration. Blink derives `KeyboardEvent.keyCode` from
 * `windowsVirtualKeyCode`, and a `keyDown` that carries only `key: 'Enter'`
 * arrives with `keyCode === 0` — which is both a tell and a functional
 * failure, because the great majority of form-submit handlers on the web test
 * `keyCode === 13`.
 *
 * `text` is on the table rather than special-cased below because TWO of these
 * keys insert a character and the second one was missed for as long as this
 * function has existed. Blink inserts a printable character from `text`; a
 * `keyDown` without it moves the caret and types nothing, while
 * `Input.dispatchKeyEvent` reports success.
 *
 * SPACE IS THE ONLY PRINTABLE CHARACTER THAT IS ALSO A NAMED KEY, so it was the
 * only one that took this branch and lost its `text`. Measured on the fleet by
 * `packages/bench`: three consecutive WebVoyager rows searched Allrecipes for
 * `veganchocolatechipcookies`, `MostPopularRecipesofthe1960s` and
 * `EasyVegetarianSpinachLasagna` — word order and capitalisation perfect, every
 * space gone — then spent all 20 steps and $0.0087 each looking for a token
 * that does not exist. Every multi-word `fill` in every run ever executed was
 * affected: search boxes, addresses, names, card fields. The anchors never
 * caught it because saucedemo's credentials are single tokens, which is also
 * why the one regression test here typed `OUTCRAWL-ZF501WUC`.
 */
const NAMED_KEYS: Record<
  string,
  { readonly code: string; readonly keyCode: number; readonly text?: string } | undefined
> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

/**
 * The US-layout physical key behind every printable ASCII character that is
 * neither a letter nor a digit. A shifted character shares its unshifted key,
 * as it does on the keyboard.
 *
 * WITHOUT THIS, SEVEN CHARACTERS NEVER REACHED A FIELD. The printable branch of
 * {@link keyEventParams} derived `windowsVirtualKeyCode` from the character's
 * own code point, which is right for letters and digits and lands every
 * punctuation mark on whichever Windows virtual key shares its number: `.` is
 * 46, VK_DELETE, and `#` `$` `%` `&` `'` `(` are 35-40, End, Home and the four
 * arrows. Blink runs a keydown carrying an editing key's code as that key's
 * command and inserts nothing, so `.` deleted forward and `$` sent the caret
 * home. Measured 2026-09-23 on the production binary through this binding, each
 * character typed as `a<ch>b` into an empty field: exactly those seven of 59
 * came out wrong (`.` gave "ab", `$` gave "ba"), and a checkout email typed as
 * `…@gmail.com` arrived as `…@gmailcom`.
 */
const PUNCTUATION_KEYS: Record<string, { readonly code: string; readonly keyCode: number } | undefined> = {
  '!': { code: 'Digit1', keyCode: 49 },
  '@': { code: 'Digit2', keyCode: 50 },
  '#': { code: 'Digit3', keyCode: 51 },
  $: { code: 'Digit4', keyCode: 52 },
  '%': { code: 'Digit5', keyCode: 53 },
  '^': { code: 'Digit6', keyCode: 54 },
  '&': { code: 'Digit7', keyCode: 55 },
  '*': { code: 'Digit8', keyCode: 56 },
  '(': { code: 'Digit9', keyCode: 57 },
  ')': { code: 'Digit0', keyCode: 48 },
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186 },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188 },
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189 },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222 },
};

/**
 * The `Input.dispatchKeyEvent` parameters for one key transition.
 *
 * EXPORTED, because `./hands-deps` plans keystrokes and needs the identical
 * table. A planner that filled in its own `code` and `windowsVirtualKeyCode`
 * would be a second copy of the mapping this comment block exists to justify,
 * and the two would drift on the first key somebody added to one of them.
 */
export function keyEventParams(key: string, type: 'keyDown' | 'keyUp'): KeyEventParams {
  // A LINE BREAK IS THE RETURN KEY. A person types a newline with Return, and
  // Return on a Mac keyboard is key `Enter`, code `Enter`, virtual key 13 with
  // text `\r` on the keydown: exactly `press('Enter')`. `\n` used to take the
  // printable branch below and go out as virtual key 10 with text `\n`, which
  // Blink drops: measured 2026-09-30 on browser .43 and .44 alike (Build40's lab,
  // n=3 each), a textarea sent `x`, `\n`, `y` read `xy` while a real Enter
  // between two keys put the line break in. In production run_38630f3c
  // (httpbin.org/forms/post) `fill('Ring\nRing')` read back `RingRing` and the
  // run spent its steps on it. `\r` is the same key (the planner folds `\r\n`
  // into one before it gets here).
  if (key === '\n' || key === '\r') {
    return keyEventParams('Enter', type);
  }
  // ANOTHER NAME FOR A KEY ON THE TABLE is that key. Models write them, and
  // each was refused as unknown: `Space` 6 of 6 presses in the 14 days to
  // 2026-10-03 (production run records), `Down` 1 of 1.
  const alias = KEY_ALIASES[key];
  if (alias !== undefined) {
    return keyEventParams(alias, type);
  }
  const named = NAMED_KEYS[key];
  if (named !== undefined) {
    return {
      type,
      key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      nativeVirtualKeyCode: named.keyCode,
      // From the TABLE, and only on `keyDown`, exactly as the printable branch
      // below does it. Special-casing one key here is what dropped space: the
      // condition named the key it was written for instead of the property it
      // was testing for.
      ...(type === 'keyDown' && named.text !== undefined ? { text: named.text } : {}),
    };
  }
  if ([...key].length !== 1) {
    throw new RangeError(
      `press(${JSON.stringify(key)}): not a single character and not a known named key. ` +
        `Known: ${Object.keys(NAMED_KEYS).join(', ')}.`,
    );
  }
  const upper = key.toUpperCase();
  const punctuation = PUNCTUATION_KEYS[key];
  // Letters and digits are their own virtual key code. A character outside the
  // US layout — an accented letter, `€` — keeps its code point, and every
  // non-ASCII code point is above the editing keys (8-46).
  const keyCode = punctuation?.keyCode ?? upper.charCodeAt(0);
  return {
    type,
    key,
    // `code` is the physical key. For a printable character the honest answer
    // is the US-layout key that produces it; anything else would need a layout
    // this process does not know.
    code:
      punctuation?.code ??
      (/^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : ''),
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(type === 'keyDown' ? { text: key } : {}),
  };
}

/** Other names models give the keys on {@link NAMED_KEYS}. `Return` is Enter, as `classifyIrreversible` already reads it. */
const KEY_ALIASES: Record<string, string | undefined> = {
  Space: ' ',
  Spacebar: ' ',
  Esc: 'Escape',
  Return: 'Enter',
  Del: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

/** A modifier key as `Input.dispatchKeyEvent` sends it: CDP's bit for it, and its left-hand key. */
export interface ModifierKey {
  readonly key: 'Meta' | 'Control' | 'Shift' | 'Alt';
  readonly code: string;
  readonly keyCode: number;
  readonly bit: number;
}

export const MODIFIER_KEYS: Readonly<Record<ModifierKey['key'], ModifierKey>> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
};

/**
 * One editing chord as this platform's keyboard performs it: the modifiers
 * held, in the order they go down, the key pressed under them, and the editing
 * command the renderer runs with it.
 */
export interface EditingChord {
  readonly modifiers: readonly ModifierKey[];
  readonly key: string;
  /** Absent where the key itself does it under the modifier (Shift+Tab, Shift+Arrow). */
  readonly command?: string;
}

type ChordSpec = { readonly mods: readonly ModifierKey['key'][]; readonly key: string };

/** What a chord means, and how each platform's keyboard says it. */
interface ChordMeaning {
  readonly command?: string;
  readonly mac: ChordSpec;
  readonly other: ChordSpec;
}

const chordMeaning = (command: string | undefined, mac: ChordSpec, other: ChordSpec): ChordMeaning =>
  command === undefined ? { mac, other } : { command, mac, other };

/**
 * THE EDITING CHORDS `press` performs, keyed by how a model writes them.
 *
 * A model writes the Windows chord (`Control+a`) as often as the Mac one, and
 * every session presents as a MacBook, so each is performed as THIS platform's
 * keyboard performs that edit: select-all from `Control+a` goes out as Cmd+A on
 * a Mac. Control+A was refused 18 of 18 times in the 14 days to 2026-10-03
 * (production run records; `Control+a` 16, `Control+A` 2), and run_e41333ca
 * (demoqa, 10:38Z) then set a date another way.
 *
 * WHY `command`. On macOS these chords belong to the application menu and
 * Cocoa's key bindings, which a key event sent to the page never reaches; a
 * real keystroke arrives at the renderer with the editing command attached,
 * and so do these. MEASURED on the production fleet (one machine, browser .56,
 * 2026-10-03 10:47Z, n=1 each): Cmd+A, Cmd+ArrowUp, Cmd+Z and Cmd+Shift+Z did
 * nothing without the command and selected / moved / undid / redid with it;
 * Control+A did nothing at all. Shift+Tab and Shift+ArrowLeft worked without
 * one, so none is sent (the other Shift+arrows were not measured). The page saw the same trusted keydown/keyup sequence
 * either way: the command is not visible to it.
 */
const EDITING_CHORDS: Readonly<Record<string, ChordMeaning | undefined>> = (() => {
  const table: Record<string, ChordMeaning> = {};
  const primary = (letter: string, command: string, shift = false): void => {
    const mods = (mod: ModifierKey['key']): ModifierKey['key'][] => (shift ? [mod, 'Shift'] : [mod]);
    const meaning = chordMeaning(command, { mods: mods('Meta'), key: letter }, { mods: mods('Control'), key: letter });
    for (const mod of ['Control', 'Meta'] as const) {
      table[`${mods(mod).join('+')}+${letter}`] = meaning;
    }
  };
  primary('a', 'selectAll');
  primary('z', 'undo');
  primary('z', 'redo', true);
  table['Control+y'] = table['Control+Shift+z'] as ChordMeaning;
  // Start and end of the document: Ctrl+Home/End elsewhere, Cmd+Up/Down on a Mac.
  for (const [home, arrow, edge] of [
    ['Home', 'ArrowUp', 'Beginning'],
    ['End', 'ArrowDown', 'End'],
  ] as const) {
    for (const shift of [false, true]) {
      const extra: ModifierKey['key'][] = shift ? ['Shift'] : [];
      const meaning = chordMeaning(
        `moveTo${edge}OfDocument${shift ? 'AndModifySelection' : ''}`,
        { mods: ['Meta', ...extra], key: arrow },
        { mods: ['Control', ...extra], key: home },
      );
      for (const spelled of [['Control', ...extra, home], ['Meta', ...extra, home], ['Meta', ...extra, arrow]]) {
        table[spelled.join('+')] = meaning;
      }
    }
  }
  // Shift alone changes what the key does, on every platform.
  for (const key of ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    table[`Shift+${key}`] = chordMeaning(undefined, { mods: ['Shift'], key }, { mods: ['Shift'], key });
  }
  return table;
})();

const MODIFIER_NAMES: Readonly<Record<string, ModifierKey['key'] | undefined>> = {
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

/** Copy, cut and paste: the clipboard chords. */
const CLIPBOARD_LETTERS = new Set(['c', 'x', 'v']);

/**
 * The chord `key` names, performed as this platform's keyboard does it, or
 * `undefined` when `key` is not written as a chord (`Enter`, `a`).
 *
 * A chord this binding does not perform is REFUSED with what it does perform,
 * never sent as a literal. Copy, cut and paste among them: copying on the
 * fleet reached no paste, in the same session or another on the same Mac
 * (2026-10-03 10:47Z, n=1), so a paste would type nothing and a cut
 * would only delete. `fill` puts text in a field.
 */
export function editingChord(key: string, mac: boolean): EditingChord | undefined {
  const parts = key.trim().split('+');
  if (parts.length < 2 || parts.some((part) => part === '')) return undefined;
  const held = parts.slice(0, -1).map((part) => MODIFIER_NAMES[part.toLowerCase()]);
  if (held.some((name) => name === undefined)) return undefined;
  const last = parts[parts.length - 1] as string;
  const base = [...last].length === 1 ? last.toLowerCase() : (KEY_ALIASES[last] ?? last);
  // Canonical spelling: modifiers in one order, each once.
  const order: readonly ModifierKey['key'][] = ['Control', 'Meta', 'Alt', 'Shift'];
  const spelled = [...order.filter((name) => held.includes(name)), base].join('+');
  const meaning = EDITING_CHORDS[spelled];
  if (meaning === undefined) {
    const clipboard = CLIPBOARD_LETTERS.has(base) && (held.includes('Control') || held.includes('Meta'));
    throw new RangeError(
      `press(${JSON.stringify(key)}): ` +
        (clipboard
          ? 'there is no clipboard to copy to or paste from in this browser, so this chord would do nothing ' +
            '(or, for cut, only delete). To put text in a field, fill it.'
          : 'not a chord this browser performs.') +
        ' Chords it performs: Control+A (select all), Control+Z (undo), Control+Shift+Z or Control+Y (redo), ' +
        'Control+Home / Control+End (start / end of the text; add Shift to select to there), Shift+Tab, ' +
        'Shift+ArrowLeft/Right/Up/Down. Meta (Cmd) works in place of Control.',
    );
  }
  const spec = mac ? meaning.mac : meaning.other;
  return {
    modifiers: spec.mods.map((name) => MODIFIER_KEYS[name]),
    key: spec.key,
    ...(meaning.command === undefined ? {} : { command: meaning.command }),
  };
}
