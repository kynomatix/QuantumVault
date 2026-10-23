// Explicit placeholders, never credentials copied from any environment.
export function gridWorkerFixtureUrl(): string {
  const url = new URL('postgresql://localhost/EXAMPLE');
  url.username = 'EXAMPLE';
  url.password = 'EXAMPLE';
  return url.toString();
}
