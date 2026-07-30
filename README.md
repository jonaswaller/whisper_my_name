# whisper_my_name

Hotkey trading for Polymarket LoL esports markets. Runs locally, places
dollar-denominated FAK (fill-and-kill) taker orders on moneyline markets.

> **Trading it, not working on it?** Read **[START-HERE.md](START-HERE.md)** —
> setup and daily use, no technical background assumed. This file is the
> engineering notes.

Eight keys, no mouse, no browser:

```
        ┌─────┬─────┬─────┐
        │  7  │  8  │  9  │   sell A · sell B · next market
        ├─────┼─────┼─────┤
        │  4  │  5  │  6  │   TEAM B   small → semi-big → big
        ├─────┼─────┼─────┤
        │  1  │  2  │  3  │   TEAM A   small → semi-big → big
        └─────┴─────┴─────┘
```

---

## Setup

Needs **Node 22+**.

```bash
npm install
cp .env.example .env      # then fill it in
```

`.env` takes the signer key and the account wallet address:

```bash
SIGNER_PRIVATE_KEY=0x...          # 64 hex chars — controls the wallet outright
POLYMARKET_WALLET_ADDRESS=0x...   # 40 hex chars — from polymarket.com profile menu
```

The two are different lengths, and pasting one into the other's slot is the
easiest mistake to make here. The loader checks both shapes and refuses to start
if they're swapped. `POLY_PRIVATE_KEY` / `POLY_PROXY_ADDRESS` also work.

**`.env` is gitignored. Never commit it.** Anyone with that key controls the
wallet, with no recovery.

Confirm the account can trade before anything else:

```bash
npm run verify-auth
```

Prints the resolved signer, wallet, and wallet type, and signs a few orders
locally. Places nothing.

## Running

```bash
npm start
```

Paste a match URL, hit **Arm**, pick which market from the dropdown. It starts in
**DRY RUN** — hotkeys light up the HUD and log the exact order but send nothing.
Click the `DRY RUN` badge to go live; it asks first.

Sizes and slippage are edited directly in the HUD and take effect on the next
keypress. Changing a size re-signs that tier immediately.

### Key bindings

Defaults are per-platform (`src/agent/config.ts`), overridable in
`config.local.json`:

- **Windows** — numpad `1`–`9`. Each is registered together with its
  Num-Lock-off twin (`num7`/`Home`, `num1`/`End`, …), so the keys work whether
  Num Lock is on or off. Without that, Num Lock off silently kills every hotkey.
- **macOS** — `Cmd+Alt+1` … `Cmd+Alt+9`, since laptops have no numpad.

Hotkeys are global: they fire while a stream is fullscreen. They're handled in
Electron's main process, so a press reaches the POST without an IPC hop or
waiting on a render frame.

## Testing without the UI

```bash
npm run resolve -- "<url>"          # URL -> tokens, tick size, market list
npm run trade -- "<url>"            # live book + what each hotkey would send
npm run trade -- "<url>" --fire B1 --live --amount 3
npm test                            # replay tests, no network, no money
```

`--fire` takes `A1 A2 A3 B1 B2 B3` or `SA` / `SB`. Without `--live` it signs and
stops. `--amount` overrides the tier so a real test can be a few dollars.

---

## How it works

```
  paste URL ──► Gamma API ──► two CLOB token ids
                                    │
      ┌─────────────────────────────┼──────────────────────────┐
      ▼                             ▼                          ▼
  market WSS                   presign cache              user WSS
  top of book                  6 signed buys              fills + positions
  in memory                    kept current
      │                             │                          │
      └──────────────► keypress ────┴──► POST ◄────────────────┘
                                          ▲
                                   warm connection
```

A keypress does no signing and no price lookup. Both were moved off the hot
path, because both are network round trips:

| | measured |
|---|---|
| book read + sizing + veto | ~0.2ms (in memory) |
| presigned order lookup | ~0ms (cache hit) |
| cold signature | **1,886ms** first time on a token |
| warm signature | ~334ms |
| POST, warm connection | ~95ms |
| Polymarket's own taker hold | **~250ms — nothing beats this** |

The venue's marketable-order delay dominates everything, which is why local
optimisation stops where it does.

### Things that are not obvious

**Buys are denominated in dollars, sells in shares.** `amount` on a market BUY
is USD notional; the venue spends it at any price up to the cap and delivers
`amount / fill_price` shares. Filling below the cap means *more shares for the
same money* — overdelivery is normal, not a bug. A live $3 buy at a 0.19 cap
filled 18 shares at 0.16.

**Slippage costs shares, not dollars.** He always spends the notional. A worse
fill just delivers fewer shares.

**Caps clamp at $0.99.** A share can't be worth more than $1, so at an ask of
0.85 a "20c" tolerance is really 14c. The HUD says so when it happens.

**`makingAmount`/`takingAmount` swap meaning by side.** On a BUY, making is USDC
out and taking is shares in; on a SELL it's reversed. Reading them the same way
both times reported a real sell of 18 shares at $0.15 as "2.7 shares at $6.67".

**The user channel confirms fills but never kills.** Polymarket emits nothing at
all for a FAK kill, so the POST response is the only authority on whether an
order died. It also sends `TRADE_STATUS_MATCHED`, then `MINED`, then `CONFIRMED`
for the same trade id — counting all three would triple every position.

**Fill prices can arrive inverted.** The venue can match a BUY of Team A against
a BUY of Team B, and quotes the trade from the counterparty's side. The true
price is then `1 - price`. Detection relies on recording which token each of our
orders was for, because watching both legs of a binary market makes a merge
indistinguishable from a direct trade by inspection alone.

**A presigned order goes stale downward, not upward.** If the ask rises, the
cached cap still fills with less slippage — harmless. If the ask *falls*, that
cap is far too generous: 0.85 → 0.70 would let an "8c" order pay up to 0.93. So
a cached order is only used while its cap is within a tick of what we'd sign now;
otherwise it signs inline and eats the latency.

### Safety

- Starts in dry run.
- `maxNotionalPerOrder` in `config.local.json` is a hard cap enforced below the
  UI, so a fat-fingered size can't get through just because it was typed.
- Orders whose cap is already below the ask are vetoed before dispatch — a
  guaranteed kill and a wasted round trip. Skipped when the book is stale, which
  fails open: swallowing a wanted trade is worse than one that might kill.
- Positions are seeded from the Data API on arm, so the sell keys never think
  he's flat when he isn't.

## Layout

```
src/agent/     market  book  sizing  presign  executor  fills  positions
               warmth  session  config  env
src/main/      Electron main process + hotkeys + preload bridge
src/renderer/  HUD (plain HTML/JS)
scripts/       CLI harness, auth check, replay tests, measurements
```

Prior art: order semantics, the price-inversion fix, the silent-kill behaviour,
and the connection-warmth approach were all derived from a production
Polymarket trading engine's field notes rather than from documentation.
