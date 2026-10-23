/**
 * Story 16.1: valid example values for the seven Home blocks, shared by the
 * unit (`landing-blocks.validation.spec.ts`) and e2e
 * (`test/landing-blocks.e2e-spec.ts`) suites. Test-only: not imported by
 * any production code.
 */
const line = [
  { text: 'OBSESIVO', style: 'solid' },
  { text: '.', style: 'accent' },
];

const panel = {
  eyebrow: 'Nuevo',
  titleLines: [line, [{ text: 'COLECCIONA', style: 'outline' }]],
  description: 'Descripción del panel.',
  ctas: [{ label: 'Ver catálogo', href: '/catalogo' }],
};

export function validBlock(
  block: string,
  productIds: string[] = [],
): Record<string, unknown> {
  switch (block) {
    case 'ticker':
      return { items: [{ text: 'Envíos a todo el país', accent: 'NUEVO' }] };
    case 'hero':
      return { panels: [0, 1, 2].map(() => structuredClone(panel)) };
    case 'heroScene':
      return {
        packImageUrl: '/img/pack.webp',
        cardImageUrls: [
          '/img/card-1.webp',
          '/img/card-2.png',
          '/uploads/public/landing/0b5d6a3e-1c1e-4b57-9d0a-2a8f2c7e9a10.webp',
        ],
      };
    case 'manifesto':
      return { items: [{ text: 'Colecciona', style: 'gradient' }] };
    case 'vitrina':
      return {
        eyebrow: 'Vitrina',
        titleLines: [line],
        ctaLabel: 'Ver todo',
        productIds,
      };
    case 'drop212':
      return {
        eyebrow: 'Drop 212',
        caption: 'Próximo drop',
        targetDate: '2026-12-25T00:00:00.000Z',
        tiers: [
          {
            id: 'tier-1',
            tier: 'Tier 1',
            title: 'Sobre',
            body: 'Contenido del tier.',
            cta: 'Reservar',
            ctaHref: 'https://example.com/reserva',
            featured: true,
            featuredLabel: 'Popular',
            ctaMagenta: false,
          },
        ],
      };
    case 'simulator':
      return {
        eyebrow: 'Simulador',
        titleLines: [line],
        description: 'Abre sobres virtuales.',
        ctaLabel: 'Abrir',
      };
    default:
      throw new Error(`unknown block ${block}`);
  }
}
