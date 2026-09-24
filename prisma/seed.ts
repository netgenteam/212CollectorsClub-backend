// Catalog seed/mock data — Story 1.4 (FR-4).
//
// Populates a realistic mock catalog (>=10 Products across 4 Franchises and
// 5 Product Types/6 Rarities, their Categories, and >=1 Product Image each)
// so frontend work isn't blocked waiting on the client's real catalog.
//
// Idempotency strategy (an explicit Story 1.4 acceptance criterion): every
// row below carries a fixed, hardcoded `id`, and is written with `upsert`
// keyed on that id — never a bare `create`. Re-running this script against
// an already-seeded database updates those same rows in place instead of
// inserting duplicates, so row counts before/after a second run are
// identical. This was chosen over a "delete catalog tables, then reinsert"
// reset because it is safer to re-run unattended (e.g. a CI/deploy step)
// and never has to worry about FK ordering on the way down — only the
// deterministic ids need to stay stable across edits to this file.
import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Franchise,
  ProductType,
  Rarity,
} from '../src/generated/prisma/client.js';
import { SINGLETON_FX_RATE_ID } from '../src/checkout/fx-rate.constants.js';
import {
  LANDING_SECTION_BANNERS,
  LANDING_SECTION_TEXTS,
  type LandingBannerKey,
  type LandingTextKey,
} from '../src/admin-landing/landing-content.constants.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set — cannot run the catalog seed.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

interface SeedCategory {
  id: string;
  name: string;
  slug: string;
}

interface SeedImage {
  id: string;
  url: string;
  altText: string;
  sortOrder: number;
}

interface SeedProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  franchise: Franchise;
  productType: ProductType;
  rarity: Rarity;
  priceUsd: string;
  stock: number;
  categorySlug: string;
  images: SeedImage[];
}

const categories: SeedCategory[] = [
  {
    id: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
    name: 'Cartas Sueltas',
    slug: 'cartas-sueltas',
  },
  {
    id: '09d457d9-a402-4915-aca9-ec9648b9a9a8',
    name: 'Sobres y Cajas',
    slug: 'sobres-y-cajas',
  },
  {
    id: 'ae0e2aef-80bd-4d53-8f84-a0033ddf090a',
    name: 'Mazos Preconstruidos',
    slug: 'mazos-preconstruidos',
  },
  {
    id: '7bfd9c58-b7c4-490c-8232-6a463b87c262',
    name: 'Ediciones Especiales',
    slug: 'ediciones-especiales',
  },
];

const products: SeedProduct[] = [
  {
    id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
    name: 'Charizard VMAX',
    slug: 'charizard-vmax',
    description:
      'Carta individual Charizard VMAX, ilustración a página completa. Pieza destacada para coleccionistas de Pokémon.',
    franchise: Franchise.POKEMON,
    productType: ProductType.SINGLE_CARD,
    rarity: Rarity.ULTRA_RARE,
    priceUsd: '89.99',
    stock: 12,
    categorySlug: 'cartas-sueltas',
    images: [
      {
        id: '2eda5451-a7e4-4455-a6e3-98a13eaba941',
        url: 'https://picsum.photos/seed/charizard-vmax-1/600/800',
        altText: 'Charizard VMAX - frente',
        sortOrder: 0,
      },
      {
        id: '279f0610-62fb-4260-bf50-35f084dded91',
        url: 'https://picsum.photos/seed/charizard-vmax-2/600/800',
        altText: 'Charizard VMAX - reverso',
        sortOrder: 1,
      },
    ],
  },
  {
    id: '343c080e-6b92-48d0-9369-6cee233cf673',
    name: 'Pikachu Promo Card',
    slug: 'pikachu-promo',
    description:
      'Carta promocional de Pikachu, edición de evento limitada. Ideal para empezar una colección.',
    franchise: Franchise.POKEMON,
    productType: ProductType.SINGLE_CARD,
    rarity: Rarity.PROMO,
    priceUsd: '14.99',
    stock: 40,
    categorySlug: 'cartas-sueltas',
    images: [
      {
        id: '1f472e90-747b-48e2-81af-9be3854c1b3b',
        url: 'https://picsum.photos/seed/pikachu-promo-1/600/800',
        altText: 'Pikachu Promo Card',
        sortOrder: 0,
      },
    ],
  },
  {
    id: '6519e34c-3c48-4b5b-9f79-53e7293513ba',
    name: 'Pokémon Scarlet & Violet - Sobre',
    slug: 'sv-booster-pack',
    description:
      'Sobre individual de la expansión Scarlet & Violet, 10 cartas por sobre.',
    franchise: Franchise.POKEMON,
    productType: ProductType.BOOSTER_PACK,
    rarity: Rarity.COMMON,
    priceUsd: '4.99',
    stock: 200,
    categorySlug: 'sobres-y-cajas',
    images: [
      {
        id: '6c0ce311-ab0c-4a6f-b7bd-07680eb5b473',
        url: 'https://picsum.photos/seed/sv-booster-pack-1/600/800',
        altText: 'Sobre Pokémon Scarlet & Violet',
        sortOrder: 0,
      },
    ],
  },
  {
    id: '7abf28f6-a761-4d1a-b2a7-f1e1a05e2a19',
    name: 'Pokémon Scarlet & Violet - Caja de Sobres',
    slug: 'sv-booster-box',
    description:
      'Caja sellada con 36 sobres de la expansión Scarlet & Violet.',
    franchise: Franchise.POKEMON,
    productType: ProductType.BOOSTER_BOX,
    rarity: Rarity.RARE,
    priceUsd: '149.99',
    stock: 15,
    categorySlug: 'sobres-y-cajas',
    images: [
      {
        id: '1db08150-77bd-4ea0-98cd-f56585a01325',
        url: 'https://picsum.photos/seed/sv-booster-box-1/600/800',
        altText: 'Caja Pokémon Scarlet & Violet - cerrada',
        sortOrder: 0,
      },
      {
        id: 'aa8b166c-8c27-4d72-b1af-fab87aa22032',
        url: 'https://picsum.photos/seed/sv-booster-box-2/600/800',
        altText: 'Caja Pokémon Scarlet & Violet - contenido',
        sortOrder: 1,
      },
    ],
  },
  {
    id: '76f4d753-8142-417e-ba0f-f0c426369a8d',
    name: 'Monkey D. Luffy - Carta Líder',
    slug: 'luffy-leader-card',
    description:
      'Carta líder de Monkey D. Luffy, arte alternativo de edición secreta.',
    franchise: Franchise.ONE_PIECE,
    productType: ProductType.SINGLE_CARD,
    rarity: Rarity.SECRET_RARE,
    priceUsd: '59.99',
    stock: 8,
    categorySlug: 'cartas-sueltas',
    images: [
      {
        id: '833db562-54c8-4d95-b981-365acf0ecba5',
        url: 'https://picsum.photos/seed/luffy-leader-card-1/600/800',
        altText: 'Monkey D. Luffy - carta líder',
        sortOrder: 0,
      },
    ],
  },
  {
    id: '4b904156-c25d-48ad-818e-b2e78224df97',
    name: 'One Piece Romance Dawn - Sobre',
    slug: 'op-romance-dawn-booster-pack',
    description:
      'Sobre individual del set inicial Romance Dawn del TCG de One Piece.',
    franchise: Franchise.ONE_PIECE,
    productType: ProductType.BOOSTER_PACK,
    rarity: Rarity.UNCOMMON,
    priceUsd: '4.49',
    stock: 180,
    categorySlug: 'sobres-y-cajas',
    images: [
      {
        id: '1c4cc2b1-c980-4876-8808-3e278e35a563',
        url: 'https://picsum.photos/seed/op-romance-dawn-booster-pack-1/600/800',
        altText: 'Sobre One Piece Romance Dawn',
        sortOrder: 0,
      },
    ],
  },
  {
    id: '8bae3dd3-da83-4509-9ee6-07ee83fb5954',
    name: 'One Piece - Mazo Straw Hat Crew',
    slug: 'op-straw-hat-starter-deck',
    description:
      'Mazo preconstruido listo para jugar, tripulación de Sombrero de Paja.',
    franchise: Franchise.ONE_PIECE,
    productType: ProductType.STARTER_DECK,
    rarity: Rarity.RARE,
    priceUsd: '12.99',
    stock: 60,
    categorySlug: 'mazos-preconstruidos',
    images: [
      {
        id: 'c675574d-09ac-4d9a-93c9-473a6f741f59',
        url: 'https://picsum.photos/seed/op-straw-hat-starter-deck-1/600/800',
        altText: 'Mazo One Piece Straw Hat Crew',
        sortOrder: 0,
      },
    ],
  },
  {
    id: 'c1701d9e-5fd2-4083-98f2-ce751d7ed64b',
    name: 'Magic: The Gathering - Lata Coleccionable Black Lotus Reprint',
    slug: 'mtg-black-lotus-reprint-tin',
    description:
      'Lata de colección de edición especial con reimpresión conmemorativa y cartas exclusivas.',
    franchise: Franchise.MAGIC_THE_GATHERING,
    productType: ProductType.COLLECTOR_TIN,
    rarity: Rarity.ULTRA_RARE,
    priceUsd: '39.99',
    stock: 20,
    categorySlug: 'ediciones-especiales',
    images: [
      {
        id: '73896af4-63b7-4984-918d-0a2848249b04',
        url: 'https://picsum.photos/seed/mtg-black-lotus-reprint-tin-1/600/800',
        altText: 'Lata coleccionable Black Lotus Reprint - cerrada',
        sortOrder: 0,
      },
      {
        id: '862e403e-4e19-47f7-9d2a-2c8c6e0212cc',
        url: 'https://picsum.photos/seed/mtg-black-lotus-reprint-tin-2/600/800',
        altText: 'Lata coleccionable Black Lotus Reprint - contenido',
        sortOrder: 1,
      },
    ],
  },
  {
    id: '0992a698-3b4f-446e-9fc0-22fb4fe8847a',
    name: 'Blue-Eyes White Dragon',
    slug: 'ygo-blue-eyes-white-dragon',
    description:
      'Carta individual Blue-Eyes White Dragon, una de las cartas más icónicas de Yu-Gi-Oh!.',
    franchise: Franchise.YU_GI_OH,
    productType: ProductType.SINGLE_CARD,
    rarity: Rarity.ULTRA_RARE,
    priceUsd: '24.99',
    stock: 25,
    categorySlug: 'cartas-sueltas',
    images: [
      {
        id: '2f6e265f-d450-4a4a-9db1-86bf6c50ce57',
        url: 'https://picsum.photos/seed/ygo-blue-eyes-white-dragon-1/600/800',
        altText: 'Blue-Eyes White Dragon',
        sortOrder: 0,
      },
    ],
  },
  {
    id: 'f45cfd6e-43b0-40f3-93e1-49d4d60741ba',
    name: 'Yu-Gi-Oh! Legendary Duelists - Caja de Sobres',
    slug: 'ygo-legendary-duelists-booster-box',
    description:
      'Caja sellada con 36 sobres de la serie Legendary Duelists de Yu-Gi-Oh!.',
    franchise: Franchise.YU_GI_OH,
    productType: ProductType.BOOSTER_BOX,
    rarity: Rarity.RARE,
    priceUsd: '99.99',
    stock: 10,
    categorySlug: 'sobres-y-cajas',
    images: [
      {
        id: 'b8c3c087-8b19-4dbd-a0ee-20ff00e0ff52',
        url: 'https://picsum.photos/seed/ygo-legendary-duelists-booster-box-1/600/800',
        altText: 'Caja Yu-Gi-Oh! Legendary Duelists',
        sortOrder: 0,
      },
    ],
  },
  // Story 4.3: two Products dedicated exclusively to the PayPal checkout/
  // webhook e2e suite (test/payments-paypal.e2e-spec.ts) — every other
  // seeded Product above is already claimed by an existing *.e2e-spec.ts
  // file's own Product.stock mutations (see checkout.e2e-spec.ts's and
  // proof-of-payment.e2e-spec.ts's own comments on cross-file flakiness
  // under Vitest's parallel file execution).
  {
    id: '769f36ae-c8ea-4535-97df-11872d7915cc',
    name: 'Dragon Ball Super - Union Force Sobre',
    slug: 'dbs-union-force-booster-pack',
    description:
      'Sobre de 12 cartas de la serie Union Force de Dragon Ball Super Card Game.',
    franchise: Franchise.DRAGON_BALL_SUPER,
    productType: ProductType.BOOSTER_PACK,
    rarity: Rarity.RARE,
    priceUsd: '4.99',
    stock: 50,
    categorySlug: 'sobres-y-cajas',
    images: [
      {
        id: '7baec38e-00b0-4efd-8888-fd234a4205b4',
        url: 'https://picsum.photos/seed/dbs-union-force-booster-pack-1/600/800',
        altText: 'Sobre Dragon Ball Super Union Force',
        sortOrder: 0,
      },
    ],
  },
  {
    id: '79daad73-ebc4-4157-af82-2c9714e31668',
    name: 'Magic: The Gathering - Mazo Planeswalker Inicial',
    slug: 'mtg-planeswalker-starter-deck',
    description:
      'Mazo preconstruido de 60 cartas listo para jugar, ideal para nuevos jugadores de Magic: The Gathering.',
    franchise: Franchise.MAGIC_THE_GATHERING,
    productType: ProductType.STARTER_DECK,
    rarity: Rarity.UNCOMMON,
    priceUsd: '19.99',
    stock: 30,
    categorySlug: 'mazos-preconstruidos',
    images: [
      {
        id: 'e223e205-1d6a-4c82-9285-7d2d915b258f',
        url: 'https://picsum.photos/seed/mtg-planeswalker-starter-deck-1/600/800',
        altText: 'Mazo inicial Magic: The Gathering Planeswalker',
        sortOrder: 0,
      },
    ],
  },
];

/**
 * Story 4.1 (AD-4): seeds the single `FxRateSetting` row checkout reads at
 * order-creation time. `200.0000` is an illustrative placeholder value
 * only, not a real-world-accurate VES/USD figure — there is still no admin
 * endpoint to edit it (a known, documented gap; see the model's doc
 * comment in schema.prisma), so whoever runs this seed against a fresh
 * environment should update this literal, or update the row directly in
 * Postgres, to something reasonably current before relying on real
 * checkout totals.
 */
const FX_RATE_VES_PER_USD_SEED_VALUE = '200.0000';

/**
 * Story 7.1 (FR-3, AD-11): seeds exactly one initial `AdminUser` so Epic
 * 7-10 stories are testable end-to-end without a separate manual bootstrap
 * step — credentials come exclusively from `ADMIN_SEED_USERNAME`/
 * `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` env vars, never hardcoded here.
 *
 * **Requires all three vars.** If any is missing, this step is skipped
 * with a warning (not a thrown error) — running `pnpm prisma:seed` must
 * stay safe for anyone who only needs the catalog seed and hasn't set up
 * Epic 7 env vars yet; the rest of `main()` (FX rate, catalog) still runs.
 *
 * **Idempotency**: `upsert`ed keyed on `username` (unique), matching the
 * rest of this file's "re-running never duplicates" rule — but unlike the
 * catalog rows above (keyed on a fixed literal `id`), the key here has to
 * be the env-derived `username` since there is no meaningful fixed id for
 * a credential that is, by design, environment-specific. On every re-run
 * the password hash is refreshed to match the CURRENT `ADMIN_SEED_PASSWORD`
 * — convenient in development (edit `.env`, re-run the seed, done) but see
 * `.env.example`'s own note: this makes the seed unsafe to re-run against a
 * production AdminUser whose password has since been rotated through a
 * real channel, since it would silently reset it back to this placeholder.
 */
async function seedAdminUser(): Promise<void> {
  const username = process.env.ADMIN_SEED_USERNAME;
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!username || !email || !password) {
    console.warn(
      'Skipping AdminUser seed: ADMIN_SEED_USERNAME/ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD ' +
        'are not all set (see .env.example). Story 7.1+ admin routes will have no ' +
        'AdminUser to authenticate against until these are set and the seed is re-run.',
    );
    return;
  }

  console.log(`Seeding initial AdminUser (username="${username}")...`);
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.adminUser.upsert({
    where: { username },
    create: { username, email, passwordHash },
    update: { email, passwordHash },
  });
}

/**
 * Story 10.1 (AD-9): seeds one placeholder row per fixed editable key in
 * `landing-content.constants.ts` — so `GET /api/v1/landing-content` has
 * real values to return from day one, before any admin has ever logged in
 * and edited anything (an explicit item in this story's verification
 * checklist: "public GET without prior data -> valid structure, never an
 * error").
 *
 * **Idempotency, never clobbers an admin's real edit on re-seed**: both
 * loops below `upsert` keyed on the fixed `(section, key)` unique
 * constraint, but — unlike the catalog rows earlier in this file, which
 * `update` their seed value unconditionally on every run — the `update`
 * branch here is `{}` (a no-op), matching `FxRateSetting`'s own seed
 * pattern just above. Once an admin has edited a field through the real
 * `PUT` endpoints, re-running this seed (e.g. on every fresh deploy) must
 * never silently revert that edit back to the placeholder.
 */
async function seedLandingContent(): Promise<void> {
  console.log('Seeding landing content placeholders (texts + banners)...');

  const textDefaults: Record<LandingTextKey, string> = {
    heroTitle: '212 Collectors Club',
    heroSubtitle:
      'Tu tienda de TCG premium: cartas sueltas, sobres y cajas selladas.',
    heroCtaText: 'Comprar ahora',
    heroCtaUrl: '/productos',
    announcementBarText:
      'Envíos a todo Venezuela — pago móvil y PayPal disponibles.',
  };
  for (const [key, value] of Object.entries(textDefaults)) {
    await prisma.landingConfigEntry.upsert({
      where: { section_key: { section: LANDING_SECTION_TEXTS, key } },
      create: {
        section: LANDING_SECTION_TEXTS,
        key,
        valueType: 'text',
        value,
      },
      update: {},
    });
  }

  const bannerDefaults: Record<
    LandingBannerKey,
    { imageUrl: string; title: string; linkUrl: string }
  > = {
    banner1: {
      imageUrl: '/uploads/public/landing/banner-placeholder-1.jpg',
      title: 'Nuevo Drop 212 cada mes',
      linkUrl: '/productos?tag=nuevo',
    },
    banner2: {
      imageUrl: '/uploads/public/landing/banner-placeholder-2.jpg',
      title: 'Sobres sellados, garantía de autenticidad',
      linkUrl: '/productos?tipo=booster',
    },
    banner3: {
      imageUrl: '/uploads/public/landing/banner-placeholder-3.jpg',
      title: 'Únete al club de coleccionistas 212',
      linkUrl: '/contacto',
    },
  };
  for (const [key, value] of Object.entries(bannerDefaults)) {
    await prisma.landingConfigEntry.upsert({
      where: { section_key: { section: LANDING_SECTION_BANNERS, key } },
      create: {
        section: LANDING_SECTION_BANNERS,
        key,
        valueType: 'json',
        value,
      },
      update: {},
    });
  }
}

async function main(): Promise<void> {
  console.log('Seeding FX rate setting...');
  await prisma.fxRateSetting.upsert({
    where: { id: SINGLETON_FX_RATE_ID },
    create: {
      id: SINGLETON_FX_RATE_ID,
      vesPerUsd: FX_RATE_VES_PER_USD_SEED_VALUE,
    },
    // Never overwritten on re-seed once it exists — an already-seeded
    // environment may have had this rate legitimately edited directly in
    // Postgres (the only way to edit it until a future admin story adds a
    // real endpoint), and re-running the seed must not clobber that.
    update: {},
  });

  console.log(`Seeding ${categories.length} categories...`);
  const categoryIdBySlug = new Map<string, string>();
  for (const category of categories) {
    const row = await prisma.category.upsert({
      where: { id: category.id },
      create: category,
      update: { name: category.name, slug: category.slug },
    });
    categoryIdBySlug.set(row.slug, row.id);
  }

  console.log(`Seeding ${products.length} products (with their images)...`);
  for (const product of products) {
    const categoryId = categoryIdBySlug.get(product.categorySlug);
    if (!categoryId) {
      throw new Error(
        `Seed data error: unknown category slug "${product.categorySlug}" referenced by product "${product.slug}"`,
      );
    }

    const productFields = {
      name: product.name,
      slug: product.slug,
      description: product.description,
      franchise: product.franchise,
      productType: product.productType,
      rarity: product.rarity,
      priceUsd: product.priceUsd,
      stock: product.stock,
      categoryId,
    };

    await prisma.product.upsert({
      where: { id: product.id },
      create: { id: product.id, ...productFields },
      update: productFields,
    });

    for (const image of product.images) {
      const imageFields = {
        url: image.url,
        altText: image.altText,
        sortOrder: image.sortOrder,
        productId: product.id,
      };
      await prisma.productImage.upsert({
        where: { id: image.id },
        create: { id: image.id, ...imageFields },
        update: imageFields,
      });
    }
  }

  const [categoryCount, productCount, imageCount] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.productImage.count(),
  ]);
  console.log(
    `Seed complete. Categories=${categoryCount} Products=${productCount} ProductImages=${imageCount}`,
  );

  await seedAdminUser();
  await seedLandingContent();
}

main()
  .catch((error: unknown) => {
    console.error('Catalog seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
