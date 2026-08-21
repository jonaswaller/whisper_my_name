# AI Handoff — whisper_my_name

Read this before changing anything. Most of what follows was learned by spending
real money against the live venue, not from documentation, and several items
contradict what the API appears to do.

---

## What this is

An Electron desktop app that trades Polymarket LoL esports moneyline markets by
hotkey. It runs locally on the trader's own machine — no server, no VPS.

**Two different people are involved and it matters:**

- **The developer** (repo owner) works on a **Mac**. Mac bindings are a dev
  fallback only.
- **The trader** — the actual user — is on **Windows with a numpad**, in Israel,
  behind a VPN. Every product decision serves him. When a change is
  platform-specific, Windows is the one that counts.

He watches a live game fullscreen with a hand on the numpad. That constrains
everything: hotkeys must be global, feedback must be visible at a glance, and an
action that silently does nothing is worse than one that fails loudly.

---

## Run it

```bash
npm install
npm start          # build + launch Electron
npm test           # 52 unit tests, no network, no money
npm run typecheck
```

CLI harnesses that talk to the live venue:

```bash
npm run resolve -- "<url>"                    # URL -> tokens, tick, markets
npm run trade -- "<url>"                      # live book + what each key would send
npm run trade -- "<url>" --fire B1 --live --amount 3
npx tsx scripts/verify-auth.ts                # auth go/no-go, places nothing
npx tsx scripts/test-limits-live.ts "<url>" --live   # full standing-order lifecycle
```

`.env` takes `SIGNER_PRIVATE_KEY` + `POLYMARKET_WALLET_ADDRESS` (aliases
`POLY_PRIVATE_KEY` / `POLY_PROXY_ADDRESS` also work). **`.env` is gitignored and
the repo is public — never commit it, never print the key.**

---

## Layout

```
src/agent/
  market.ts       URL -> two CLOB token ids, tick, min size, market picker
  book.ts         streaming top-of-book (WSS), staleness, live tick size
  sizing.ts       slippage -> price cap, sell floors, unfillable veto
  presign.ts      pre-signed order cache with staleness rules
  executor.ts     POST a signed order, interpret the response
  fills.ts        user-channel fills, price-inversion fix, position tracking
  positions.ts    account-wide positions from the Data API
  limitOrders.ts  GTC standing sells AND buys, cancel, list open orders
  warmth.ts       keeps the HTTP connection hot
  watcher.ts      polls another trader's activity
  session.ts      orchestration — everything a keypress touches
  config.ts       sizes/slippage/dry-run, persisted to config.local.json
  actions.ts      the action registry and key bindings
src/main/         Electron main process, global hotkeys, IPC
src/renderer/     HUD (plain HTML/JS, no framework)
scripts/          tests + live harnesses
```

---

## Venue behaviours you will get wrong if you assume

Every one of these was found by testing. None are obvious from the API surface.

**Buys are denominated in DOLLARS, sells in SHARES.** `amount` on a market BUY
is USD notional; the venue spends it at any price ≤ the cap and delivers
`amount / fill_price` shares. Filling below the cap means *more shares for the
same money*. A live $3 buy at a 0.19 cap filled 18 shares at 0.16. Sells take
`shares` + `minPrice` instead.

**`makingAmount`/`takingAmount` swap meaning by side.** On a BUY, making is USDC
out and taking is shares in. On a SELL it is reversed. Reading them the same way
both times reported a real sell of 18 shares at $0.15 as *"2.7 shares at $6.67"*
— a price that cannot exist on a venue capped at $1. `executor.dispatch()`
therefore requires the side as an argument.

**FAK kills emit nothing.** The user WebSocket is silent for a killed FAK order,
so the POST response is the *only* authority on whether an order died. The
websocket is the fast path for fills and nothing else.

**Trades push three times.** `TRADE_STATUS_MATCHED`, then `MINED`, then
`CONFIRMED` — all with the same trade id. Counting all three triples every
position. Only MATCHED is a fill. Note the `TRADE_STATUS_` prefix: matching the
bare word `MATCHED` silently dropped every fill.

**Fill prices can arrive inverted.** The venue can match a BUY of Team A against
a BUY of Team B and quotes the trade from the counterparty's side; the true
price is then `1 - price`. Watching both legs of a binary market makes a merge
match indistinguishable from a direct one by inspection, so `fills.ts` records
`orderId -> token we ordered` at dispatch and compares. Without that record it
takes the event at face value, which is the honest limit of what is knowable.

**`listOpenOrders` returns a paginated async iterator**, not an array
(`Paginated<OpenOrder[]>`). Treating it as an array yields nothing, silently —
the UI reads "nothing resting" while real orders sit on the book. Walk it with
`for await`.

**Tick size varies per market AND changes while a market is open.** The same LPL
market read 0.01 one week and 0.001 the next. Live match moneylines are usually
0.01; longshots and mature markets are often 0.001. **Never assume a tick.**
Read it from the book stream via `session.tickFor(tokenId)` — that is the single
source, and it handles the `tick_size_change` event.

**Polymarket holds every marketable order ~250ms** on their side. Makers are
exempt. This dominates all local latency work — do not micro-optimise below it.

**Signing is a network round trip**, not local crypto: ~1,886ms cold on a fresh
token, ~334ms warm. This is the entire reason `presign.ts` exists.

---

## Rules that will bite you

**Never bind navigation keys.** `NUMLOCK_OFF_ALIASES` in `actions.ts` is
deliberately an empty object with a long comment. It used to map numpad keys to
their Num-Lock-off twins (`num8 -> Up`, `num7 -> Home`, `numdec -> Delete`).
Windows sends the *same virtual key* for both and Electron cannot distinguish
them, so registering those globally meant **arrow keys placed live orders** and
`Home`/`End`/`Delete`/arrows were swallowed from every text field on the machine.
The trade-off is that **Num Lock must be ON**; there is no third option.
`validateAccelerator()` rejects nav keys for the same reason.

**`numenter` is not a valid Electron accelerator.** It throws. `Clear` too.
Verify any new accelerator by actually registering it in Electron before
shipping — I only caught these by running a real registration test.

**Bare letters and digits cannot be bound.** These are global hotkeys; binding
`X` means typing an x anywhere fires an order and swallows the keystroke. Only
numpad keys and F-keys are safe bare.

**Bindings are owned by the main process only.** The renderer holds a config
snapshot from startup; letting it send bindings back meant a size edit silently
reverted every rebind made since launch. `update-config` explicitly discards
them; `set-binding` is the only path.

**Every text input must call `guardInput()`.** Global hotkeys fire while typing
inside our own window. `stopPropagation` does nothing against them — they are
OS-level and never reach the DOM.

**"Sell at 99.9c" must decline, never round down.** Markets on a 0.01 tick
cannot price 0.999. Falling back to 0.99 is a full cent per share chosen on his
behalf. `TARGET_MAX_PRICE = 0.999` and the action refuses with a reason when the
tick does not allow it.

**Presigned orders go stale downward, not upward.** If the ask rises, the cached
cap still fills with *less* slippage — harmless. If the ask *falls*, the cap is
far too generous (0.85 → 0.70 would let an "8c" order pay 0.93). A cached order
is used only while its cap is within one tick of what we would sign now;
otherwise it signs inline and eats the latency. Correctness beats speed when
they conflict.

**Sells are guarded against double-press.** A sell takes ~650ms to send but the
position only updates when the fill lands. Two presses would sell the position
twice. Buys are deliberately *not* guarded — repeating a buy is legitimate.

**The Data API lags fills by more than 2.5s.** A position read immediately after
a confirmed fill returns 0. Poll for it; do not read once.

**Every action must stamp `session.stamp()`** — including paths that bail out
before any network call. There are ~29 stamp points (grep `this.stamp(`). "Nothing appeared to happen"
is exactly when the user needs to see why, and a stale latency reading
masquerading as current was a real complaint.

---

## Testing expectations

Unit tests use **real captured payloads**, not invented fixtures — the fills
tests replay an actual live trade including its MINED/CONFIRMED echoes.

Before claiming something works:

- `npm test` and `npm run typecheck`
- If it touches accelerators, **register them in real Electron** (see the
  pattern used to catch `numenter`)
- If it touches order placement, run `scripts/test-limits-live.ts` or a small
  `--live --amount 3` order. The trader's minimum is 5 **shares**, so a $3 test
  needs the cheaper side of the market.
- Assertions about venue behaviour must be tested, not reasoned about. Every
  item in the section above was originally a confident wrong assumption.

---

## State and open items

Working and verified live: auth, market resolution, book streaming, presigned
FAK buys, market sells, GTC standing sells at typed price / at ask / at 99.9c,
cancel and cancel-all, open-orders panel, per-side independent sizes, full
rebinding UI, account-wide inventory, and a watcher on another trader's fills.

Added 2026-08-19, unit-tested and HUD-smoke-tested but **not yet placed live**:
`sellBelowBid` (whole position at bid − `sellBelowBidCents`, default 1c,
marketable GTC — fills what the bid absorbs, rests the rest) and `buyAtBid`
(`limitBuyNotional` dollars, default $200, as a resting BUY at the bid, sized
in shares floored to 0.01). Defaults `Ctrl+num7/8` and `Ctrl+num1/4` — Ctrl,
not Shift, because Windows treats Shift+numpad-digit as a Num Lock override.
All 20 default accelerators were registered in real Electron on 2026-08-19.

Timing display (added 2026-08-21, after "my standing sell had 2000 ping"):
every order-outcome line ends with a trailing `NNNms`; a standing order's total
of 1s+ decomposes into `(sign X + post Y)` because signing is an inline network
round trip on that path (~334ms warm / ~1,886ms cold — no presign cache for
limit orders) and a cold draw otherwise reads as venue slowness. His 2000ms was
a cold sign, not the venue. Fill echoes from the user websocket now carry
`press→fill NNNms`: `expectOrder()` takes the keypress timestamp and
`Fill.sincePressMs` is the delta, null for fills we did not originate — never
guessed. The log paints any 1500ms+ duration red (`paintDurations`), the same
threshold as the ping bar. For FAK orders the POST total already IS
signal-to-fill (the venue decides fill-or-kill synchronously); press→fill on
the echo adds the ~0.65s p50 websocket propagation on top.
Decisions taken without client confirmation, easy to flip: the buy rests AT
the bid (his example said 69c on a 69/70 market; his heading said "ask");
"1 cent" is literal cents, not one tick; the resting buy is unguarded against
double-press like the FAK buys. `placeLimitBuy` shares `submitLimit()` with
`placeLimitSell`, so the POST/response handling cannot drift between sides.

Not yet done:

1. **Position refresh retry** for the Data API lag — arming right after a fill
   can seed a stale position.
2. **Auth failure at boot is permanent.** `boot()` returns early on a failed
   `createSecureClient`, `session` stays null, and every action answers "not
   ready" until restart. A brief VPN blip at launch bricks the app. Needs retry
   with backoff and a visible reconnect path. **This is the highest-value
   remaining fix** — he trades behind a VPN.
3. No live order has been placed through the **HUD** — only the CLI. The
   Electron path shares the code but is unproven end to end. The two resting
   hotkeys have not been placed live from anywhere yet — first live test should
   be a small `buyAtBid` on the cheap side priced well under the market so it
   rests, confirm it in the open-orders panel, then cancel.
4. Nobody has tested the **actual numpad on Windows hardware**. Registration is
   verified; the physical keys are not.

`START-HERE.md` is the non-technical setup guide for the trader. `README.md` is
the engineering overview. Keep both current.
