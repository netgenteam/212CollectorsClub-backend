#!/usr/bin/env node
/**
 * Importa N productos de prueba desde tcgapi.dev al backend desplegado,
 * usando la API admin pública (login → POST multipart /admin/products).
 * Pasa por las mismas validaciones y el mismo almacenamiento de imágenes
 * que un alta manual desde el dashboard. Sin dependencias (Node >= 20).
 *
 * Uso:
 *   node scripts/import-tcgapi.mjs            # importa
 *   node scripts/import-tcgapi.mjs --dry-run  # solo muestra el mapeo, no escribe
 *   node scripts/import-tcgapi.mjs --cleanup  # borra lo importado (lee el manifest)
 *
 * Variables de entorno (o archivo scripts/.env.import, ver .env.import.example):
 *   API_BASE_URL     p.ej. https://api.midominio.com/api/v1   (obligatoria)
 *   ADMIN_USER       usuario o email del admin                (obligatoria)
 *   ADMIN_PASSWORD                                            (obligatoria)
 *   TCGAPI_KEY       API key de tcgapi.dev                    (obligatoria)
 *   TCG_GAME         slug de juego tcgapi (default: pokemon)
 *   TCG_QUERY        texto de búsqueda, >= 2 chars (default: charizard)
 *   TCG_TYPE         Cards | Sealed Products (default: Cards)
 *   LIMIT            productos a crear (default: 10)
 *   CATEGORY_ID      uuid de categoría (override); si falta se resuelve por slug:
 *                    cartas-sueltas (Cards) o sobres-y-cajas (Sealed Products)
 *   STOCK            stock inicial por producto (default: 5)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, '.tcgapi-import-manifest.json');
const TCGAPI_BASE = 'https://api.tcgapi.dev/v1';
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

loadEnvFile(join(HERE, '.env.import'));

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const CLEANUP = args.has('--cleanup');

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    fail(`Falta la variable de entorno ${name}`);
  }
  return value;
};

const API = env('API_BASE_URL').replace(/\/+$/, '');

// ---------------------------------------------------------------- mapeos

const FRANCHISE_BY_GAME = {
  pokemon: 'POKEMON',
  'pokemon-japan': 'POKEMON',
  magic: 'MAGIC_THE_GATHERING',
  yugioh: 'YU_GI_OH',
  'one-piece-card-game': 'ONE_PIECE',
  'dragon-ball-super-ccg': 'DRAGON_BALL_SUPER',
  'dragon-ball-super-fusion-world': 'DRAGON_BALL_SUPER',
  naruto: 'NARUTO',
};

function mapRarity(raw = '') {
  const r = raw.toLowerCase();
  if (r.includes('promo')) return 'PROMO';
  if (/secret|hyper|special illustration|gold|manga|alternate art/.test(r)) {
    return 'SECRET_RARE';
  }
  if (/ultra|illustration|double rare|\bex\b|\bgx\b|\bv(max|star)?\b|mythic|super rare|leader/.test(r)) {
    return 'ULTRA_RARE';
  }
  if (r.includes('uncommon')) return 'UNCOMMON';
  if (r.includes('rare')) return 'RARE';
  return 'COMMON';
}

function mapProductType(card) {
  if (card.product_type !== 'Sealed Products') return 'SINGLE_CARD';
  const n = card.name.toLowerCase();
  if (n.includes('booster box') || n.includes('display')) return 'BOOSTER_BOX';
  if (n.includes('booster') || n.includes('pack')) return 'BOOSTER_PACK';
  if (n.includes('tin')) return 'COLLECTOR_TIN';
  if (n.includes('deck')) return 'STARTER_DECK';
  return 'ACCESSORY';
}

function pickPrice(card) {
  const raw =
    card.market_price ?? card.median_price ?? card.low_price ?? card.lowest_with_shipping;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : 1;
}

function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200)
    .replace(/-+$/, '');
}

// Story 15.1 (FR-63 iv, A31): slug de la subcategoría de franquicia (etiqueta).
// Un single lleva SOLO la etiqueta de franquicia, nunca una de formato.
const FRANCHISE_TAG_SLUG = {
  POKEMON: 'franchise-pokemon',
  ONE_PIECE: 'franchise-one-piece',
  MAGIC_THE_GATHERING: 'franchise-magic-the-gathering',
  YU_GI_OH: 'franchise-yu-gi-oh',
  DRAGON_BALL_SUPER: 'franchise-dragon-ball-super',
  NARUTO: 'franchise-naruto',
};
const ROOT_SLUG_BY_TYPE = { 'Sealed Products': 'sobres-y-cajas' };
const DEFAULT_ROOT_SLUG = 'cartas-sueltas';

function franchiseOf(card) {
  return FRANCHISE_BY_GAME[card.game_slug ?? process.env.TCG_GAME] ?? 'OTHER';
}

function toProductFields(card, categoryId, stock, franchiseTagId) {
  const setPart = card.set_name ? ` (${card.set_name})` : '';
  const numberPart = card.number ? ` #${card.number}` : '';
  // El id de tcgapi al final hace el slug único y la importación idempotente:
  // re-ejecutar devuelve 409 PRODUCT_SLUG_TAKEN y ese producto se salta.
  const slug = slugify(`${card.name} ${card.set_name ?? ''} ${card.number ?? ''} tcg-${card.id}`);
  const fields = {
    name: `${card.name}${numberPart}`.slice(0, 200),
    slug,
    description: [
      `${card.name}${setPart}.`,
      card.rarity ? `Rareza: ${card.rarity}.` : '',
      card.printing ? `Impresión: ${card.printing}.` : '',
      '[Producto de prueba importado desde tcgapi.dev]',
    ]
      .filter(Boolean)
      .join(' '),
    franchise: franchiseOf(card),
    productType: mapProductType(card),
    rarity: mapRarity(card.rarity),
    editionLanguage: 'EN',
    priceUsd: String(pickPrice(card)),
    stock: String(stock),
    categoryId,
  };
  if (franchiseTagId) fields.categoryIds = JSON.stringify([franchiseTagId]);
  if (card.tcgplayer_url?.startsWith('https://')) {
    fields.marketReferences = JSON.stringify([
      { provider: 'TCGPLAYER', label: 'TCGplayer', url: card.tcgplayer_url },
    ]);
  }
  return fields;
}

// ---------------------------------------------------------------- HTTP

async function tcgapiSearch() {
  const limit = Number(env('LIMIT', '10'));
  const params = new URLSearchParams({
    q: env('TCG_QUERY', 'charizard'),
    game: env('TCG_GAME', 'pokemon'),
    type: env('TCG_TYPE', 'Cards'),
    sort: 'price_desc',
    // Pedimos de más para poder descartar las que no traen imagen.
    per_page: String(Math.min(limit * 3, 200)),
  });
  const res = await fetch(`${TCGAPI_BASE}/search?${params}`, {
    headers: { 'X-API-Key': env('TCGAPI_KEY') },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`tcgapi.dev ${res.status}: ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`);
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining) console.log(`tcgapi.dev: quedan ${remaining} peticiones hoy`);
  return (body.data ?? []).filter((c) => c.image_url).slice(0, limit);
}

async function api(path, { token, ...init } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  return { res, body };
}

async function login() {
  const { res, body } = await api('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      usernameOrEmail: env('ADMIN_USER'),
      password: env('ADMIN_PASSWORD'),
    }),
  });
  if (!res.ok || !body?.accessToken) {
    fail(`Login admin falló (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

async function listCategories(query) {
  const { res, body } = await api(`/categories?${query}`);
  const list = Array.isArray(body) ? body : body?.data;
  if (!res.ok || !Array.isArray(list)) fail(`GET /categories?${query} falló (${res.status})`);
  return list;
}

// Resuelve por slug (no por "la primera pública"). CATEGORY_ID sigue como override.
async function resolveCategoryId() {
  if (process.env.CATEGORY_ID) return process.env.CATEGORY_ID;
  const slug = ROOT_SLUG_BY_TYPE[env('TCG_TYPE', 'Cards')] ?? DEFAULT_ROOT_SLUG;
  const root = (await listCategories('type=ROOT')).find((c) => c.slug === slug);
  if (!root) fail(`No existe la categoría "${slug}"; aplica la migración epic15 o define CATEGORY_ID`);
  console.log(`Usando categoría "${root.name}" (${root.id})`);
  return root.id;
}

// Mapa slug -> id de las subcategorías de franquicia (1 sola petición).
async function resolveFranchiseTagIds() {
  const list = await listCategories('type=SUBCATEGORY&dimension=FRANCHISE');
  return new Map(list.map((c) => [c.slug, c.id]));
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`imagen ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!ALLOWED_IMAGE_TYPES.includes(type)) throw new Error(`tipo de imagen no permitido: ${type}`);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  return { blob: new Blob([await res.arrayBuffer()], { type }), filename: `card.${ext}` };
}

// ---------------------------------------------------------------- flujos

async function runImport() {
  const cards = await tcgapiSearch();
  if (!cards.length) fail('tcgapi.dev no devolvió cartas con imagen para esa búsqueda');

  const categoryId = await resolveCategoryId();
  const franchiseTagIds = await resolveFranchiseTagIds();
  const tagIdOf = (card) => franchiseTagIds.get(FRANCHISE_TAG_SLUG[franchiseOf(card)]);
  const stock = Number(env('STOCK', '5'));

  if (DRY_RUN) {
    for (const card of cards) {
      const { description, ...rest } = toProductFields(card, categoryId, stock, tagIdOf(card));
      console.log(rest);
    }
    console.log(`\n[dry-run] ${cards.length} productos mapeados, nada escrito.`);
    return;
  }

  const token = await login();
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];
  let created = 0;

  try {
    for (const card of cards) {
      const fields = toProductFields(card, categoryId, stock, tagIdOf(card));
      try {
        const { blob, filename } = await downloadImage(card.image_url);
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('images', blob, filename);

        const { res, body } = await api('/admin/products', { method: 'POST', body: form, token });
        if (res.status === 409) {
          console.log(`= ${fields.name}: ya existe (slug ${fields.slug}), se omite`);
          continue;
        }
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);

        manifest.push({ id: body.id, slug: fields.slug, tcgapiId: card.id });
        writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
        created++;
        console.log(`+ ${fields.name} — $${fields.priceUsd} [${fields.rarity}] → ${body.id}`);
      } catch (error) {
        console.error(`✗ ${fields.name}: ${error.message}`);
      }
    }
  } finally {
    await api('/admin/auth/logout', { method: 'POST', token });
  }
  console.log(`\nCreados ${created}/${cards.length}. Manifest: ${MANIFEST}`);
}

async function runCleanup() {
  if (!existsSync(MANIFEST)) fail(`No hay manifest en ${MANIFEST}; nada que borrar`);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const token = await login();
  const remaining = [];
  try {
    for (const item of manifest) {
      const { res, body } = await api(`/admin/products/${item.id}`, { method: 'DELETE', token });
      if (res.ok || res.status === 404) {
        console.log(`- ${item.slug}: ${res.status === 404 ? 'ya no existía' : body.hardDeleted ? 'borrado' : 'desactivado (tiene historial)'}`);
      } else {
        console.error(`✗ ${item.slug}: ${res.status} ${JSON.stringify(body)}`);
        remaining.push(item);
      }
    }
  } finally {
    await api('/admin/auth/logout', { method: 'POST', token });
  }
  writeFileSync(MANIFEST, JSON.stringify(remaining, null, 2));
  console.log(`\nLimpieza terminada; ${remaining.length} pendientes en el manifest.`);
}

// ---------------------------------------------------------------- util

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

await (CLEANUP ? runCleanup() : runImport());
