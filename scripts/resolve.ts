/**
 * Sanity-check a Polymarket URL without launching the app.
 *   npm run resolve -- "<url>"
 */

import { resolveEvent, defaultMarket } from '../src/agent/market.ts';

const url = process.argv[2];
if (!url) {
  console.error('usage: npm run resolve -- <polymarket url>');
  process.exit(1);
}

const event = await resolveEvent(url);
const pick = defaultMarket(event);

console.log(`\n${event.title}\n`);
for (const m of event.markets) {
  const mark = m.id === pick.id ? '>' : ' ';
  const state = m.closed ? 'CLOSED' : m.active ? 'open' : 'inactive';
  console.log(`${mark} [${m.kind.padEnd(6)}] ${m.question}  (${state})`);
  console.log(`    A: ${m.teamA.name} -> ${m.teamA.tokenId.slice(0, 16)}…`);
  console.log(`    B: ${m.teamB.name} -> ${m.teamB.tokenId.slice(0, 16)}…`);
  console.log(`    tick=${m.tickSize} minSize=${m.minOrderSize} negRisk=${m.negRisk}`);
}
