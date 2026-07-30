# Setup — read this first

Trading hotkeys for Polymarket LoL markets. Eight keys on your numpad, no mouse,
no browser tab.

Everything runs on **your** computer. Your key never leaves it.

---

## One-time setup (about 10 minutes)

### 1. Install Node

Download the **LTS** version from <https://nodejs.org> and run the installer.
Accept every default. Restart your computer afterwards.

### 2. Get the code

Download the repo as a ZIP from GitHub and unzip it somewhere you'll find again
— `C:\Users\<you>\Desktop\whisper_my_name` is fine.

### 3. Open a terminal in that folder

Open the folder in File Explorer, click the address bar, type `powershell`, and
press Enter. A blue window opens, already pointed at the right place.

Then run this once:

```
npm install
```

It prints a lot and takes a minute or two. Warnings are normal. Errors in red
that stop it are not — send Stu a screenshot.

### 4. Get your two Polymarket values

Go to <https://polymarket.com> and log in.

**Your wallet address** — click your profile menu (top right). Copy the account
wallet address. It looks like:

```
0x2e234dae75c793f67a35089c9d99245e1c58470b
```

**Your private key** — in Settings, find the option to export or reveal your
private key. It's about twice as long:

```
0x6a1f...  (64 characters after the 0x)
```

> **The private key is the account.** Anyone who has it can drain the wallet,
> instantly and permanently. Don't paste it into Discord, email, screenshots, or
> a chat with an AI. It goes in one file on your computer and nowhere else.
>
> If Settings has no export option, stop here and tell Stu — there's a different
> route and it's not worth guessing at.

### 5. Put them in the config file

In the project folder there's a file called `.env.example`. Make a copy of it and
rename the copy to exactly `.env` (no `.example`, no `.txt`).

Open `.env` in Notepad and fill in the two lines:

```
SIGNER_PRIVATE_KEY=0x6a1f...          <- the long one
POLYMARKET_WALLET_ADDRESS=0x254311... <- the short one
```

They're different lengths and it's easy to swap them. If you do, the app refuses
to start and tells you which one is wrong, so no harm done.

### 6. Check it works

```
npm run verify-auth
```

You want to see your wallet type and a list of test orders. **This places
nothing** — it only proves Polymarket accepts your credentials.

---

## Running it

```
npm start
```

A window opens. **It starts in DRY RUN** — every key works, the screen reacts,
but nothing is sent. Stay here until the keys feel right.

**To trade for real:** click the yellow `DRY RUN` badge at the top right. It asks
you to confirm, then turns red and says `LIVE`. Click it again to go back.

### Arming a match

Paste the match URL from Polymarket into the box at the top and click **Arm**.
Any URL for the match works, e.g.:

```
https://polymarket.com/esports/league-of-legends/lpl/lol-al-edg-2026-07-31
```

A dropdown appears with that match's markets — the overall series, Game 1, Game
2, and so on. Pick the one you're trading. **Team A is the left column, Team B is
the right.**

Wait for the log to say `all keys loaded`. That means every hotkey is presigned
and will fire instantly.

---

## The keys

```
        ┌─────┬─────┬─────┐
        │  7  │  8  │  9  │   sell A · sell B · next game
        ├─────┼─────┼─────┤
        │  4  │  5  │  6  │   TEAM B   small · semi-big · big
        ├─────┼─────┼─────┤
        │  1  │  2  │  3  │   TEAM A   small · semi-big · big
        └─────┴─────┴─────┘
```

Your **numpad**, laid out exactly as it sits under your hand. They work while
the stream is fullscreen — you don't need to click the window first.

- **1–3** buy Team A, **4–6** buy Team B. Left to right = bigger.
- **7 / 8** sell your whole position in A or B.
- **9** jumps to the next game in the series, so you don't touch the mouse
  between Game 1 and Game 2.

Every key is also a button on screen — click them instead while you're learning.
Identical behaviour.

> **Num Lock:** the app registers both the numpad digits and the keys Windows
> sends when Num Lock is off, so it works either way. If a key ever does nothing,
> check Num Lock anyway and tell Stu.

### Changing your sizes

The dollar amount and the slippage on each button are editable boxes — click,
type, press Enter. It takes effect on the very next keypress. No restart.

- **Left box = dollars.** How much you spend.
- **Right box = slippage in cents.** How much worse than the current price you'll
  accept.

---

## Reading the screen

Each side shows:

- **Bid / ask** and the size sitting at each.
- **Your position** — shares, average price, and profit or loss right now.
- **`loaded`** under each button — that key is presigned and will fire instantly.
  It reloads itself within a second of firing.
- A **greyed-out button** means the price has moved past your slippage and that
  order couldn't fill. It's telling you before you press, not after.

Top right, three lights: **book** (prices streaming), **fills** (trade
confirmations), **conn** (connection warm, with its speed in ms). All three
green is healthy.

---

## Things that look wrong but aren't

**You got more shares than you expected.** Normal. You spend the dollar amount,
and if you fill better than your cap you get *more shares for the same money*.
Buying $250 with the price at 0.60 gets you about 417 shares, not 250.

**"killed (no liquidity inside cap), free".** Nobody was selling within your
slippage, so nothing happened. **It costs you nothing.** Widen the slippage or
try again.

**Slippage "clamped".** A share can never be worth more than $1. With the price
at 0.85, a 20c tolerance is really only 14c — there's nowhere above 0.99 to bid.

**Orders take a moment.** Polymarket holds every market order about a quarter of
a second on their side. Nobody can beat that, and no amount of tuning changes it.

---

## If something breaks

**Windows warns about an unknown publisher** — expected, the app isn't code
signed. Click More info → Run anyway.

**"no private key found"** — the `.env` file is named wrong. Windows may have
saved it as `.env.txt`. Turn on file extensions in Explorer and check.

**"not a 20-byte address" / "not a 32-byte private key"** — the two values are
swapped in `.env`.

**Nothing happens when you press a key** — check the log at the bottom. If it
says nothing at all, another app may have claimed that key; tell Stu and he can
rebind it.

**Everything looks frozen** — check the three lights. If one is red it's
reconnecting on its own. Closing and reopening the app is always safe; it
remembers the last match you armed.

Log lines at the bottom are worth screenshotting when something's off — they say
exactly what was sent and what came back.
