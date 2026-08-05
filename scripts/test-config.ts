/**
 * Config merge rules.
 *
 * The renderer keeps a config snapshot from startup. If a size edit is allowed
 * to carry bindings back, every rebind made since launch is silently reverted —
 * which is exactly what happened: changing a size reset the hotkeys.
 */
import { loadConfig, saveConfig, DEFAULT_CONFIG, validateTier } from '../src/agent/config.ts';
import { validateAccelerator } from '../src/agent/actions.ts';
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
const stale = { ...reloaded, tiers: { ...reloaded.tiers, A: [{ label: 'small', notional: 99, slippageCents: 3 }, reloaded.tiers.A[1], reloaded.tiers.A[2]] }, bindings: DEFAULT_CONFIG.bindings };
const { bindings: _drop, ...editable } = stale as any;
const merged = { ...reloaded, ...editable, bindings: reloaded.bindings };
check('a size edit does NOT revert bindings', merged.bindings.sellA, 'F5');
check('the size edit still applies', merged.tiers.A[0].notional, 99);

// Legacy shape from before actions were a flat map.
saveConfig({ ...structuredClone(DEFAULT_CONFIG), bindings: { buyA: ['num1', 'num2', 'num3'], buyB: ['num4', 'num5', 'num6'], sellA: 'num7', sellB: 'num8', nextMarket: 'num9' } } as any, dir);
const migrated = loadConfig(dir);
check('legacy bindings migrate to action ids', [migrated.bindings.buyA1, migrated.bindings.sellB], ['num1', 'num8']);
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
check('legacy slippage survives too', oldTiers.tiers.B[2].slippageCents, 3);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
