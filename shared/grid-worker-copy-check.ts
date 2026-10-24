/** Apply to rendered text, including interpolated bot display names, never HTML attributes. */
export function workerCopyViolation(text:string):boolean {
  const plain=text.replace(/action:(?:reset_pause|ack_critical|pause)|target:all/g,'');
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|0x[0-9a-f]+|\$\s*\d|\w_\w|GRID_[A-Z_]+|\b(?:error|exception|stack|mockup|example|preview)\b/i.test(plain)
    ||/\b\d+(?:\.\d+)?\s*(?:USD[CT]?|SOL|BTC|ETH)\b|\b[0-9a-f]{40,64}\b/i.test(plain)
    ||new RegExp(String.fromCharCode(100,114,105,102,116),'i').test(plain);
}
