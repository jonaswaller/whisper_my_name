/**
 * Every action a hotkey can trigger.
 *
 * Nothing is button-only: he trades with his hand on the numpad while watching
 * the game, so any action that exists must be bindable to a key. Buttons remain
 * as a mouse fallback and as a way to learn the keys.
 *
 * Defaults map onto a full Windows numpad, which has exactly enough keys:
 * 0-9 plus / * - + . and Enter.
 */

export type ActionId =
  | 'buyA1' | 'buyA2' | 'buyA3'
  | 'buyB1' | 'buyB2' | 'buyB3'
  | 'sellA' | 'sellB'
  | 'sellAskA' | 'sellAskB'
  | 'sellMaxA' | 'sellMaxB'
  | 'sellLimitA' | 'sellLimitB'
  | 'sellBelowBidA' | 'sellBelowBidB'
  | 'buyBidA' | 'buyBidB'
  | 'cancelAll'
  | 'nextMarket';

export interface ActionSpec {
  id: ActionId;
  /** Shown in the rebinding list. */
  label: string;
  /** Groups the rebinding list into sections. */
  group: 'Buy' | 'Sell now' | 'Standing (limit)' | 'Other';
  /** Longer explanation for the rebinding UI. */
  hint?: string;
}

export const ACTIONS: ActionSpec[] = [
  { id: 'buyA1', label: 'Buy A — small', group: 'Buy' },
  { id: 'buyA2', label: 'Buy A — semi-big', group: 'Buy' },
  { id: 'buyA3', label: 'Buy A — big', group: 'Buy' },
  { id: 'buyB1', label: 'Buy B — small', group: 'Buy' },
  { id: 'buyB2', label: 'Buy B — semi-big', group: 'Buy' },
  { id: 'buyB3', label: 'Buy B — big', group: 'Buy' },

  { id: 'sellA', label: 'Sell all A', group: 'Sell now', hint: 'market — takes the bid immediately' },
  { id: 'sellB', label: 'Sell all B', group: 'Sell now', hint: 'market — takes the bid immediately' },

  { id: 'sellAskA', label: 'Sell A at ASK', group: 'Standing (limit)', hint: 'rests at the offer' },
  { id: 'sellAskB', label: 'Sell B at ASK', group: 'Standing (limit)', hint: 'rests at the offer' },
  { id: 'sellMaxA', label: 'Sell A at 99.9c', group: 'Standing (limit)', hint: 'declines unless the market allows 0.999' },
  { id: 'sellMaxB', label: 'Sell B at 99.9c', group: 'Standing (limit)', hint: 'declines unless the market allows 0.999' },
  {
    id: 'sellLimitA',
    label: 'Sell A at typed price',
    group: 'Standing (limit)',
    hint: 'uses the price in A’s box',
  },
  {
    id: 'sellLimitB',
    label: 'Sell B at typed price',
    group: 'Standing (limit)',
    hint: 'uses the price in B’s box',
  },

  {
    id: 'sellBelowBidA',
    label: 'Sell A below BID',
    group: 'Standing (limit)',
    hint: 'whole position, 1c under the bid — fills what it can, the rest rests',
  },
  {
    id: 'sellBelowBidB',
    label: 'Sell B below BID',
    group: 'Standing (limit)',
    hint: 'whole position, 1c under the bid — fills what it can, the rest rests',
  },
  { id: 'buyBidA', label: 'Buy A at BID (resting)', group: 'Standing (limit)', hint: 'fixed $ amount, joins the bid queue' },
  { id: 'buyBidB', label: 'Buy B at BID (resting)', group: 'Standing (limit)', hint: 'fixed $ amount, joins the bid queue' },

  { id: 'cancelAll', label: 'Cancel all resting orders', group: 'Other' },
  { id: 'nextMarket', label: 'Next market (Game 1 → 2)', group: 'Other' },
];

export type Bindings = Partial<Record<ActionId, string>>;

/**
 * Full-numpad defaults for Windows.
 *
 * The digits keep his original layout (1-3 buy A, 4-6 buy B, 7/8 sell, 9 next),
 * and the operator keys take the standing-order actions so every feature has a
 * key without needing a modifier chord.
 */
export const NUMPAD_BINDINGS: Bindings = {
  buyA1: 'num1', buyA2: 'num2', buyA3: 'num3',
  buyB1: 'num4', buyB2: 'num5', buyB3: 'num6',
  sellA: 'num7', sellB: 'num8',
  nextMarket: 'num9',
  cancelAll: 'num0',
  sellAskA: 'numdiv',      // /
  sellAskB: 'nummult',     // *
  sellMaxA: 'numsub',      // -
  sellMaxB: 'numadd',      // +
  sellLimitA: 'numdec',        // .
  // NOT 'numenter': Electron rejects it outright ("conversion failure from
  // numenter"), so that action would never bind. Shift+. keeps B on the same
  // physical key as A. Verified to register.
  sellLimitB: 'Shift+numdec',
  // The bare numpad is full. Ctrl + the key he already uses for the FAK
  // version gives the resting version of the same trade: Ctrl+7/8 = sell A/B
  // under the bid, Ctrl+1/4 = buy A/B at the bid. Ctrl is used rather than
  // Shift because Windows treats Shift+numpad-digit as a temporary Num Lock
  // toggle and sends the navigation key instead (see NUMLOCK_OFF_ALIASES).
  sellBelowBidA: 'Control+num7',
  sellBelowBidB: 'Control+num8',
  buyBidA: 'Control+num1',
  buyBidB: 'Control+num4',
};

/**
 * DELIBERATELY EMPTY — do not reintroduce these.
 *
 * These used to map each numpad key to the key Windows sends with Num Lock OFF
 * (num8 -> Up, num4 -> Left, num7 -> Home, numdec -> Delete, ...) so bindings
 * survived either Num Lock state.
 *
 * Windows sends the SAME virtual key for numpad-with-Num-Lock-off as for the
 * dedicated navigation keys, and Electron cannot distinguish them. Registering
 * them globally therefore meant:
 *   - the ARROW KEYS placed live orders (left/right/up/down = buy 4/6/8/2)
 *   - Home, End, Delete, Insert and PageUp/Down were swallowed system-wide,
 *     so text fields could not be edited with the keyboard
 *
 * Requiring Num Lock ON is a far smaller cost than either of those.
 */
export const NUMLOCK_OFF_ALIASES: Record<string, string> = {};

/** Mac dev fallback — laptops have no numpad, and bare digits can't be global. */
export const MAC_BINDINGS: Bindings = {
  buyA1: 'CommandOrControl+Alt+1',
  buyA2: 'CommandOrControl+Alt+2',
  buyA3: 'CommandOrControl+Alt+3',
  buyB1: 'CommandOrControl+Alt+4',
  buyB2: 'CommandOrControl+Alt+5',
  buyB3: 'CommandOrControl+Alt+6',
  sellA: 'CommandOrControl+Alt+7',
  sellB: 'CommandOrControl+Alt+8',
  nextMarket: 'CommandOrControl+Alt+9',
  cancelAll: 'CommandOrControl+Alt+0',
  sellAskA: 'CommandOrControl+Alt+J',
  sellAskB: 'CommandOrControl+Alt+K',
  sellMaxA: 'CommandOrControl+Alt+N',
  sellMaxB: 'CommandOrControl+Alt+M',
  sellLimitA: 'CommandOrControl+Alt+U',
  sellLimitB: 'CommandOrControl+Alt+I',
  sellBelowBidA: 'CommandOrControl+Alt+H',
  sellBelowBidB: 'CommandOrControl+Alt+L',
  buyBidA: 'CommandOrControl+Alt+Y',
  buyBidB: 'CommandOrControl+Alt+O',
};

/** Short display label — the numpad key, without modifier noise. */
export function shortKey(accelerator: string | undefined): string {
  if (!accelerator) return '—';
  const last = accelerator.split('+').pop() ?? '';
  const numpad: Record<string, string> = {
    numdiv: '/', nummult: '*', numsub: '-', numadd: '+',
    numdec: '.', numenter: 'Enter',
  };
  const lower = last.toLowerCase();
  if (numpad[lower]) return numpad[lower]!;
  return last.replace(/^num/i, '');
}

/**
 * Keys that are safe to bind on their own.
 *
 * Numpad keys and function keys don't appear in ordinary typing, so binding
 * them bare is fine. A bare letter or digit is not: these are GLOBAL hotkeys,
 * so binding "X" means typing an x in any application fires a live order — and
 * swallows the keystroke so it never reaches what you were typing into.
 */
function isSafeBare(key: string): boolean {
  const k = key.toLowerCase();
  if (/^num([0-9]|div|mult|sub|add|dec|enter)$/.test(k)) return true;
  if (/^f([1-9]|1\d|2[0-4])$/.test(k)) return true;
  // Navigation keys are NOT safe: on Windows they share a virtual key with the
  // numpad under Num Lock off, so binding one grabs the real arrow/Home/Delete
  // key too — placing orders from arrow keys and breaking text editing.
  return false;
}

/**
 * Reject accelerators that would misfire during normal typing.
 * Returns the reason, or null when the binding is acceptable.
 */
export function validateAccelerator(accelerator: string): string | null {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1] ?? '';
  const hasModifier = parts.length > 1;

  if (!key) return 'no key captured';
  if (hasModifier || isSafeBare(key)) return null;

  const nav = ['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'clear'];
  if (nav.includes(key.toLowerCase())) {
    return `"${key}" cannot be used: Windows sends the same key for the numpad with Num Lock off, so binding it would make the arrow/navigation keys place orders.`;
  }
  return `"${key}" on its own would fire while you type anywhere. Hold Ctrl/Cmd, Alt or Shift, or use a numpad or F key.`;
}

/** Which action currently owns this accelerator, if any. */
export function findConflict(
  bindings: Bindings,
  accelerator: string,
  ignore?: ActionId,
): ActionId | null {
  for (const [id, accel] of Object.entries(bindings) as [ActionId, string][]) {
    if (id !== ignore && accel && accel.toLowerCase() === accelerator.toLowerCase()) return id;
  }
  return null;
}
