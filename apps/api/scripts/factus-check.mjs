// Verifies Factus (e-invoicing) and Factus Pay credentials in apps/api/.env.
// Never prints tokens or passwords. Checks only the services whose variables are filled.
// Warning: Factus Pay POST /auth revokes the previous token of that user (one active token per user).
process.loadEnvFile(new URL('../.env', import.meta.url));
const env = process.env;

const missingOf = (keys) => keys.filter((k) => !env[k]);
const base = (url) => url.replace(/\/$/, '');
const json = (res) => res.json().catch(() => ({}));

async function checkFactus() {
  const api = base(env.FACTUS_API_URL);
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
  const authBody = await json(auth);
  if (!auth.ok || !authBody.access_token) {
    throw new Error(`Factus: autenticación falló HTTP ${auth.status} ${authBody.error ?? ''} ${authBody.message ?? ''}`);
  }
  console.log(`✓ Factus: autenticación OK contra ${api} (token expira en ${authBody.expires_in}s)`);

  const ranges = await fetch(`${api}/v2/numbering-ranges?filter[is_active]=1`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${authBody.access_token}` },
  });
  const rangesBody = await json(ranges);
  if (!ranges.ok) throw new Error(`Factus: no se pudieron leer los rangos HTTP ${ranges.status} ${rangesBody.message ?? ''}`);
  const rows = rangesBody.data?.data ?? rangesBody.data ?? [];
  console.log('  Rangos de numeración activos (usa el "id" en FACTUS_NUMBERING_RANGE_ID):');
  console.table(
    rows.map((r) => ({ id: r.id, documento: r.document, prefijo: r.prefix, desde: r.from, hasta: r.to, actual: r.current })),
  );
}

async function checkFactusPay() {
  const api = base(env.FACTUS_PAY_API_URL);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const auth = await fetch(`${api}/auth`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: env.FACTUS_PAY_EMAIL, password: env.FACTUS_PAY_PASSWORD }),
  });
  const authBody = await json(auth);
  if (!auth.ok || !authBody.token) {
    throw new Error(`Factus Pay: autenticación falló HTTP ${auth.status} ${authBody.message ?? ''}`);
  }
  console.log(`✓ Factus Pay: autenticación OK contra ${api}`);

  // A lookup of a reference that cannot exist proves the token works without creating a collection.
  const probe = await fetch(`${api}/v1/collections/practimesa-check-${Date.now()}`, {
    headers: { ...headers, Authorization: `Bearer ${authBody.token}` },
  });
  if (probe.status !== 404) throw new Error(`Factus Pay: consulta de recaudos respondió HTTP ${probe.status} (esperado 404)`);
  console.log('✓ Factus Pay: token aceptado por /v1/collections');

  if ((env.FACTUS_PAY_WEBHOOK_KEY ?? '').length < 32) {
    console.warn('! Factus Pay: FACTUS_PAY_WEBHOOK_KEY debe tener al menos 32 caracteres aleatorios');
  }
}

const services = [
  ['Factus', ['FACTUS_API_URL', 'FACTUS_CLIENT_ID', 'FACTUS_CLIENT_SECRET', 'FACTUS_USERNAME', 'FACTUS_PASSWORD'], checkFactus],
  ['Factus Pay', ['FACTUS_PAY_API_URL', 'FACTUS_PAY_EMAIL', 'FACTUS_PAY_PASSWORD'], checkFactusPay],
];

let failed = false;
for (const [name, keys, check] of services) {
  const missing = missingOf(keys);
  if (missing.length) {
    console.log(`- ${name}: omitido, faltan en apps/api/.env: ${missing.join(', ')}`);
    continue;
  }
  try {
    await check();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
