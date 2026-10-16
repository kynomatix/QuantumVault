import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LabSourcePanel } from '../../client/src/components/LabSourcePanel';
it('renders unknown source state without linking or inventing metrics before loading', () => {
  const html = renderToStaticMarkup(createElement(LabSourcePanel, { botId: 'EXAMPLE', walletAddress: 'EXAMPLE', onLinked: () => {} }));
  expect(html).toContain('Lab source'); expect(html).not.toContain('Confirm this source'); expect(html).not.toContain('0.00%');
});
it('carries saved result identity through agent, history and heatmap deploys and keeps evidence server-managed', () => {
  const source = readFileSync('client/src/pages/QuantumLab.tsx', 'utf8');
  for (const value of ['resultId: target.resultId', 'resultId={agentDeployTarget.resultId}', 'resultId={selectedResult.id}', 'resultId={activeConfig.id}', 'labResultId: resultId']) expect(source).toContain(value);
  const body = source.slice(source.indexOf('const botRequestBody ='), source.indexOf("const res = await fetch('/api/trading-bots'", source.indexOf('const botRequestBody =')));
  expect(body).not.toMatch(/labDeploySnapshot|labLinkState|labStrategyId/);
  const drawer = readFileSync('client/src/components/BotManagementDrawer.tsx', 'utf8');
  const settings = drawer.slice(drawer.indexOf('<TabsContent value="settings"'));
  expect(settings.indexOf('title="Lab source"')).toBeLessThan(settings.indexOf('{moneyControls'));
  expect(settings).toContain("localBot?.botType === 'signal'");
});
