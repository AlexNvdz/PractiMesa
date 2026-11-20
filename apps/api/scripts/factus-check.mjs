// Verifies Factus credentials in apps/api/.env and lists active numbering ranges.
// Never prints tokens or passwords.
process.loadEnvFile(new URL('../.env', import.meta.url));

const keys = ['FACTUS_API_URL', 'FACTUS_CLIENT_ID', 'FACTUS_CLIENT_SECRET', 'FACTUS_USERNAME', 'FACTUS_PASSWORD'];
const missing = keys.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Faltan en apps/api/.env: ${missing.join(', ')}`);
  process.exit(1);
}
const env = process.env;
const api = env.FACTUS_API_URL.replace(/\/$/, '');

const auth = await fetch(`${api}/oauth/token`, {
  method: 'POST',
  headers: { Accept: 'application/json' },
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: env.FACTUS_CLIENT_ID,
    client_secret: env.FACTUS_CLIENT_SECRET,
    username: env.FACTUS_USERNAME,
    password: env.FACTUS_PASSWORD,
  }),
});
const authBody = await auth.json().catch(() => ({}));
if (!auth.ok || !authBody.access_token) {
  console.error(`✗ Autenticación falló: HTTP ${auth.status} ${authBody.error ?? ''} ${authBody.message ?? ''}`);
  process.exit(1);
}
console.log(`✓ Autenticación OK contra ${api} (token expira en ${authBody.expires_in}s)`);

const ranges = await fetch(`${api}/v2/numbering-ranges?filter[is_active]=1`, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${authBody.access_token}` },
});
const rangesBody = await ranges.json().catch(() => ({}));
if (!ranges.ok) {
  console.error(`✗ No se pudieron leer los rangos: HTTP ${ranges.status} ${rangesBody.message ?? ''}`);
  process.exit(1);
}
const rows = rangesBody.data?.data ?? rangesBody.data ?? [];
console.log('Rangos de numeración activos (usa el "id" en FACTUS_NUMBERING_RANGE_ID):');
console.table(
  rows.map((r) => ({ id: r.id, documento: r.document, prefijo: r.prefix, desde: r.from, hasta: r.to, actual: r.current })),
);
