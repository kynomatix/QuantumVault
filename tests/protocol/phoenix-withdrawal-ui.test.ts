import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PhoenixWithdrawalDetail } from '../../client/src/components/PhoenixWithdrawalDetail';

it.each(['pacifica', 'drift', 'flash', undefined, null])('hides withdrawal details for %s', activeProtocol => {
  expect(renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { activeProtocol, visible: true }))).toBe('');
});
it('shows the unknown Phoenix delay and stays hidden outside the open Equity tab', () => {
  const html = renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { activeProtocol: 'phoenix', visible: true }));
  expect(html).toContain('Withdrawals'); expect(html).toContain('Withdrawal delay not yet measured');
  expect(renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { activeProtocol: 'phoenix', visible: false }))).toBe('');
});
