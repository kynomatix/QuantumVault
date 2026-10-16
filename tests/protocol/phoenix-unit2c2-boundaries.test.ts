import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoenixSignalPanel } from '../../client/src/components/PhoenixSignalPanel';

it('shows disabled Lab Start, unknown signal, position and protection on first render',()=>{
  const html=renderToStaticMarkup(createElement(PhoenixSignalPanel,{botId:'EXAMPLE-bot'}));
  expect(html).toContain('Check the Lab source in this bot’s Settings.');expect(html).toMatch(/disabled=""[^>]*title="Lab source is unknown/);
  expect(html).toContain('Signal: unknown');expect(html).toContain('Position: unknown');expect(html).toContain('TP/SL: unknown');
});
it('keeps both incumbent webhook secret checks ahead of their Phoenix early returns',()=>{
  const source=readFileSync('server/routes.ts','utf8');
  for(const marker of ['app.post("/api/webhook/tradingview/:botId"','app.post("/api/webhook/user/:walletAddress"']) {
    const start=source.indexOf(marker);expect(start).toBeGreaterThan(0);
    const branch=source.indexOf('handlePhoenixTradingView',start),region=source.slice(start,branch);
    expect(region).toContain('secureTokenMatches');expect(region).toContain("activeProtocol === 'phoenix'");
    expect(source.slice(branch,branch+260)).toMatch(/return handlePhoenixTradingView/);
  }
});
