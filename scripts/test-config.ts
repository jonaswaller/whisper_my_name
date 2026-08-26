/**
 * Config merge rules.
 *
 * The renderer keeps a config snapshot from startup. If a size edit is allowed
 * to carry bindings back, every rebind made since launch is silently reverted —
 * which is exactly what happened: changing a size reset the hotkeys.
 */
import { loadConfig, saveConfig, DEFAULT_CONFIG, validateTier, validateStanding } from '../src/agent/config.ts';
import { validateAccelerator, ACTIONS, NUMPAD_BINDINGS, MAC_BINDINGS, findConflict } from '../src/agent/actions.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (!ok) failures += 1;
}

console.log('\nconfig:\n');

const dir = mkdtempSync(join(tmpdir(), 'wmn-'));

// A rebind, then a size edit that carries the OLD bindings back.
const saved = { ...structuredClone(DEFAULT_CONFIG), bindings: { ...DEFAULT_CONFIG.bindings, sellA: 'F5' } };
saveConfig(saved as any, dir);

const reloaded = loadConfig(dir);
check('a rebind survives a round trip to disk', reloaded.bindings.sellA, 'F5');

// Simulate the main-process merge: editable fields from the renderer, bindings kept local.
const stale = { ...reloaded, tiers: { ...reloaded.tiers, A: [{ label: 'small', notional: 99, slippageCents: 3 }, reloaded.tiers.A[1]] }, bindings: DEFAULT_CONFIG.bindings };
const { bindings: _drop, ...editable } = stale as any;
const merged = { ...reloaded, ...editable, bindings: reloaded.bindings };
check('a size edit does NOT revert bindings', merged.bindings.sellA, 'F5');
check('the size edit still applies', merged.tiers.A[0].notional, 99);

// Legacy shape from before actions were a flat map.
saveConfig({ ...structuredClone(DEFAULT_CONFIG), bindings: { buyA: ['num1', 'num2', 'num3'], buyB: ['num4', 'num5', 'num6'], sellA: 'num7', sellB: 'num8', nextMarket: 'num9' } } as any, dir);
const migrated = loadConfig(dir);
check('legacy bindings migrate to action ids', [migrated.bindings.buyA1, migrated.bindings.sellB], ['num1', 'num8']);
check('legacy triple: big keeps its key as tier 2, semi-big key is dropped', [migrated.bindings.buyA2, migrated.bindings.buyB2], ['num3', 'num6']);
check('new actions get their default key', Boolean(migrated.bindings.sellAskA), true);

check('tier validation rejects an over-cap size', validateTier({ label: 'x', notional: 99999, slippageCents: 3 }, 5000) !== null, true);
check('tier validation accepts a sane size', validateTier({ label: 'x', notional: 250, slippageCents: 8 }, 5000), null);

// A bare letter is a GLOBAL hotkey: typing it anywhere fires a live order and
// swallows the keystroke. Numpad and F keys are safe bare; letters are not.
console.log('\naccelerator safety:\n');
check('bare letter is rejected', validateAccelerator('X') !== null, true);
check('bare digit is rejected', validateAccelerator('4') !== null, true);
check('letter with a modifier is fine', validateAccelerator('CommandOrControl+Alt+X'), null);
check('bare numpad key is fine', validateAccelerator('num4'), null);
check('bare numpad operator is fine', validateAccelerator('numdiv'), null);
check('bare F key is fine', validateAccelerator('F5'), null);
// Navigation keys share a virtual key with the numpad under Num Lock off, so
// binding one would make the real arrow/Home/Delete keys place orders and
// swallow them from every text field.
check('arrow keys are rejected', validateAccelerator('Up') !== null, true);
check('Home is rejected', validateAccelerator('Home') !== null, true);
check('Delete is rejected', validateAccelerator('Delete') !== null, true);
check('arrow WITH a modifier is fine', validateAccelerator('Control+Up'), null);

// Sides are independent: editing A must not touch B.
check('editing side A leaves side B alone', merged.tiers.B[0].notional, DEFAULT_CONFIG.tiers.B[0].notional);

// A pre-split config had one shared array; copy it to both sides rather than
// resetting his sizes to defaults.
saveConfig({ ...structuredClone(DEFAULT_CONFIG), tiers: [
  { label: 'small', notional: 7, slippageCents: 1 },
  { label: 'semi-big', notional: 77, slippageCents: 2 },
  { label: 'big', notional: 777, slippageCents: 3 },
] } as any, dir);
const oldTiers = loadConfig(dir);
check('legacy shared tiers copy to both sides', [oldTiers.tiers.A[0].notional, oldTiers.tiers.B[0].notional], [7, 7]);
check('legacy triple keeps small and BIG, drops the middle', [oldTiers.tiers.B[1].notional, oldTiers.tiers.B[1].slippageCents], [777, 3]);
check('tiers are now exactly two per side', [oldTiers.tiers.A.length, oldTiers.tiers.B.length], [2, 2]);

// The shape his config.local.json actually had on 2026-08-26: three tiers per
// side and a flat binding map with buyA3/buyB3 for "big" (num3/num6), with the
// semi-big keys 2 and 5 unbound by him. Opening the new build must leave him
// with his small and big sizes on his keys and nothing else.
saveConfig({
  ...structuredClone(DEFAULT_CONFIG),
  tiers: {
    A: [
      { label: 'small', notional: 4, slippageCents: 3 },
      { label: 'semi-big', notional: 246, slippageCents: 8 },
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
    B: [
      { label: 'small', notional: 2, slippageCents: 3 },
      { label: 'semi-big', notional: 246, slippageCents: 8 },
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
  },
  bindings: { ...DEFAULT_CONFIG.bindings, buyA1: 'num1', buyA2: null, buyA3: 'num3', buyB1: 'num4', buyB2: null, buyB3: 'num6' },
} as any, dir);
const his = loadConfig(dir);
check('his sizes: small survives per side', [his.tiers.A[0].notional, his.tiers.B[0].notional], [4, 2]);
check('his sizes: big survives with its slippage', [his.tiers.A[1].notional, his.tiers.A[1].slippageCents, his.tiers.B[1].label], [1000, 20, 'big']);
check('his keys: big moved from buyA3/buyB3 to tier 2', [his.bindings.buyA2, his.bindings.buyB2], ['num3', 'num6']);
check('his keys: the old buyA3/buyB3 ids are gone', ['buyA3' in his.bindings, 'buyB3' in his.bindings], [false, false]);
check('his keys: small untouched', [his.bindings.buyA1, his.bindings.buyB1], ['num1', 'num4']);

// A deliberately unbound big must stay unbound through the same move.
saveConfig({ ...structuredClone(DEFAULT_CONFIG), bindings: { ...DEFAULT_CONFIG.bindings, buyA3: null } } as any, dir);
check('an unbound big stays unbound after the tier move', loadConfig(dir).bindings.buyA2, null);

// An unbind must survive a restart. It is saved as an explicit null; only a
// MISSING key takes the default (that is how new actions arrive with a key).
{
  const unbound = { ...structuredClone(DEFAULT_CONFIG), bindings: { ...DEFAULT_CONFIG.bindings, buyA2: null, buyB2: null } };
  saveConfig(unbound as any, dir);
  const back = loadConfig(dir);
  check('an unbound key stays unbound after a restart', [back.bindings.buyA2, back.bindings.buyB2], [null, null]);
  check('other keys are untouched by the unbind', back.bindings.buyA1, DEFAULT_CONFIG.bindings.buyA1);
  check('a key never saved still gets its default', Boolean(back.bindings.sellA), true);
  check('an unbound key is not a conflict for anything', findConflict(back.bindings, 'num2'), null);
}

// --- the resting hotkeys' config ---------------------------------------------
console.log('\nstanding-order config:\n');

// A config.local.json written before these fields existed must boot with the
// documented defaults, and the new actions must arrive with a key.
{
  const { limitBuyNotional: _a, sellBelowBidCents: _b, ...older } = structuredClone(DEFAULT_CONFIG) as any;
  older.bindings = { ...older.bindings };
  delete older.bindings.sellBelowBidA;
  delete older.bindings.buyBidA;
  saveConfig(older, dir);
  const upgraded = loadConfig(dir);
  check('old config gets the $200 resting-buy default', upgraded.limitBuyNotional, 200);
  check('old config gets the 1c under-bid default', upgraded.sellBelowBidCents, 1);
  check('old config gets keys for the new actions', [Boolean(upgraded.bindings.sellBelowBidA), Boolean(upgraded.bindings.buyBidA)], [true, true]);
}

// Every action has a default on both platforms and no two share a key — a
// duplicate would double-register and Electron silently gives the key to
// whichever registered first.
for (const [name, map] of [['numpad', NUMPAD_BINDINGS], ['mac', MAC_BINDINGS]] as const) {
  check(`${name} defaults bind every action`, ACTIONS.filter((a) => !map[a.id]).map((a) => a.id), []);
  const dupes = ACTIONS.filter((a) => findConflict(map, map[a.id]!, a.id)).map((a) => a.id);
  check(`${name} defaults have no duplicate keys`, dupes, []);
  check(`${name} defaults all pass accelerator validation`, ACTIONS.filter((a) => validateAccelerator(map[a.id]!)).map((a) => a.id), []);
}

check('standing: sane values pass', validateStanding({ limitBuyNotional: 200, sellBelowBidCents: 1, maxNotionalPerOrder: 5000 }), null);
check('standing: resting buy above the cap is refused', validateStanding({ limitBuyNotional: 6000, sellBelowBidCents: 1, maxNotionalPerOrder: 5000 }) !== null, true);
check('standing: zero resting buy is refused', validateStanding({ limitBuyNotional: 0, sellBelowBidCents: 1, maxNotionalPerOrder: 5000 }) !== null, true);
check('standing: negative under-bid offset is refused', validateStanding({ limitBuyNotional: 200, sellBelowBidCents: -1, maxNotionalPerOrder: 5000 }) !== null, true);
check('standing: zero under-bid offset (sell AT the bid) is allowed', validateStanding({ limitBuyNotional: 200, sellBelowBidCents: 0, maxNotionalPerOrder: 5000 }), null);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
