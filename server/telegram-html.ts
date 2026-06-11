/**
 * Escape user/creator-derived VALUES before interpolating them into Telegram
 * messages sent with `parse_mode: 'HTML'`.
 *
 * Telegram's HTML mode only requires `&`, `<`, and `>` to be escaped in text
 * content. We deliberately escape only the dynamic values (bot names, market
 * symbols, error strings) — never the surrounding message templates — so the
 * intentional <b>/<i>/<code> formatting tags in those templates are preserved,
 * while a creator-controlled bot name like `<a href="…">` can no longer inject
 * live markup into a subscriber's chat.
 */
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
