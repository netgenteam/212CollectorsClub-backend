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
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Franchise,
  ProductType,
  Rarity,
} from '../src/generated/prisma/client.js';

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
];

async function main(): Promise<void> {
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
}

main()
  .catch((error: unknown) => {
    console.error('Catalog seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
