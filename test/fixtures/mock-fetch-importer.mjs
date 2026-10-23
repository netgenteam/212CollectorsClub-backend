// Preload for the importer e2e (Story 15.1): replaces global fetch so
// `scripts/import-tcgapi.mjs --dry-run` never touches the network.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const ROOTS = [
  { id: 'id-cartas-sueltas', slug: 'cartas-sueltas', name: 'Cartas Sueltas' },
  { id: 'id-sobres-y-cajas', slug: 'sobres-y-cajas', name: 'Sobres y Cajas' },
  { id: 'id-franquicia-tcg', slug: 'franquicia-tcg', name: 'Franquicia TCG' },
];
const FRANCHISES = [
  { id: 'id-franchise-pokemon', slug: 'franchise-pokemon', name: 'Pokemon' },
  {
    id: 'id-franchise-yu-gi-oh',
    slug: 'franchise-yu-gi-oh',
    name: 'Yu-Gi-Oh!',
  },
];

globalThis.fetch = async (input) => {
  const url = String(input);
  console.error(`MOCKFETCH ${url}`);
  if (url.startsWith('https://api.tcgapi.dev/')) {
    const sealed = url.includes('Sealed');
    return json({
      data: [
        {
          id: 1,
          name: sealed ? 'Booster Box Test' : 'Charizard',
          game_slug: 'pokemon',
          product_type: sealed ? 'Sealed Products' : 'Cards',
          image_url: 'https://example.test/img.png',
          market_price: 10,
        },
      ],
    });
  }
  if (url.includes('/categories?type=ROOT')) return json(ROOTS);
  if (url.includes('/categories?type=SUBCATEGORY')) return json(FRANCHISES);
  throw new Error(`unexpected fetch ${url}`);
};
