import { LegalMarkdownService } from './legal-markdown.service.js';
import { detectPlaceholders } from './legal-placeholders.js';
import {
  LEGAL_SEED_FILES,
  loadLegalSeedTemplates,
  type LegalSeedTemplate,
} from './legal-seed.service.js';
import { LEGAL_SLUGS } from './legal-slugs.js';

/**
 * Story 19.3 (AC2-AC4): the six seed templates, checked against the REAL
 * validator (async, worker thread) and the real placeholder detector.
 */
const md = new LegalMarkdownService();
afterAll(() => md.onModuleDestroy());

const SIMULATOR =
  'Simulación recreativa sin valor económico: no se compra, no se ganan premios ni se canjean cartas';
const OWNER_TOKENS = [
  '[[RAZON_SOCIAL]]',
  '[[RIF]]',
  '[[DOMICILIO_FISCAL]]',
  '[[EMAIL_CONTACTO]]',
  '[[TELEFONO]]',
];

let templates: Record<string, string>;
beforeAll(async () => {
  const list: LegalSeedTemplate[] = await loadLegalSeedTemplates();
  templates = Object.fromEntries(list.map((t) => [t.slug, t.bodyMd]));
});

describe('legal seed templates (Story 19.3)', () => {
  it('there is exactly one template per real document, in slug order', async () => {
    const list = await loadLegalSeedTemplates();
    expect(list.map((t) => t.slug)).toEqual([...LEGAL_SLUGS]);
    expect(Object.keys(LEGAL_SEED_FILES).sort()).toEqual(
      [...LEGAL_SLUGS].sort(),
    );
  });

  it.each([...LEGAL_SLUGS])(
    '%s: passes LegalMarkdownService.validate (no HTML, images or forbidden schemes)',
    async (slug) => {
      const res = await md.validate(templates[slug]);
      expect(res.toc.length).toBeGreaterThan(3);
      expect(Buffer.byteLength(templates[slug], 'utf8')).toBeLessThan(200_000);
    },
  );

  it.each([...LEGAL_SLUGS])(
    '%s: starts with the template header and has pending placeholders (cannot be published as is)',
    (slug) => {
      const body = templates[slug];
      const first = body.split('\n').find((l) => l.trim() !== '') ?? '';
      expect(first).toMatch(
        /^> \*\*Plantilla — revisar con un abogado antes de publicar\./,
      );
      expect(first).toContain('no es asesoría jurídica');
      const tokens = detectPlaceholders(body).map((p) => p.token);
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      // the header itself carries a token, so deleting nothing can never publish
      expect(detectPlaceholders(first).length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(['terminos', 'privacidad', 'aviso-legal'])(
    '%s: every seller datum is a placeholder',
    (slug) => {
      const tokens = new Set(
        detectPlaceholders(templates[slug]).map((p) => p.token),
      );
      for (const t of OWNER_TOKENS.slice(0, 4))
        expect(tokens.has(t)).toBe(true);
    },
  );

  it.each([...LEGAL_SLUGS])(
    '%s: never invents seller data (no emails, phones, RIF numbers or street addresses)',
    (slug) => {
      const body = templates[slug];
      expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(body).not.toMatch(/\b[JGVEP]-?\d{7,9}-?\d?\b/);
      expect(body).not.toMatch(/(?:\+?58|0[24]\d{2})[\s-]?\d{3}[\s-]?\d{4}/);
      expect(body).not.toMatch(/€/);
      expect(body).not.toMatch(/\bjamás\b/i);
    },
  );

  it('terminos: simulator clause (exact), minors clause (FR-116), Venezuelan law, USD and Pago Móvil', () => {
    const b = templates.terminos;
    expect(b).toContain(SIMULATOR);
    expect(b).toMatch(/representante legal/);
    expect(b).toMatch(/cancelar.*pedidos que sospeche/s);
    expect(b).toMatch(/18 años/);
    expect(b).toMatch(/leyes de la República Bolivariana de Venezuela/);
    expect(b).toMatch(/dólares estadounidenses \(USD\)/);
    expect(b).toMatch(/Pago Móvil/);
    expect(b).toMatch(/cédula/);
  });

  it('aviso-legal: IP/affiliation disclaimer names every rights holder', () => {
    for (const name of [
      'Nintendo',
      'Creatures',
      'GAME FREAK',
      'The Pokémon Company',
      'Wizards of the Coast',
      'Konami',
    ]) {
      expect(templates['aviso-legal']).toContain(name);
    }
    expect(templates['aviso-legal']).toMatch(
      /no está afiliado, patrocinado ni respaldado/,
    );
  });

  it.each(['privacidad', 'cookies'])(
    '%s: declares the aggregate anonymous view beacon and GPC / DNT (A72)',
    (slug) => {
      const b = templates[slug];
      expect(b).toMatch(/no usa cookies ni identificadores/);
      expect(b).toMatch(/Global Privacy Control \(GPC\)/);
      expect(b).toMatch(/Do Not Track \(DNT\)/);
      expect(b).toMatch(/agregad/);
    },
  );

  it('cookies: essential vs non-essential categories, the latter off by default and unused today', () => {
    const b = templates.cookies;
    expect(b).toMatch(/Esenciales/);
    expect(b).toMatch(/Analíticas \(desactivadas por defecto\)/);
    expect(b).toMatch(/Marketing \(desactivadas por defecto\)/);
    for (const c of [
      'cc_session',
      'cartId',
      'wishlistId',
      '212_cookie_prefs',
    ]) {
      expect(b).toContain(`\`${c}\``);
    }
  });

  it('privacidad: cédula kept encrypted, masked and for the fiscal term; no absolute claims', () => {
    const b = templates.privacidad;
    expect(b).toMatch(/cifrad/);
    expect(b).toMatch(/enmascarad/);
    expect(b).toMatch(/plazo que exija la normativa fiscal/);
    expect(b).toMatch(/Stripe/);
  });

  it.each([...LEGAL_SLUGS])(
    '%s: every `[[` is a detected placeholder (grep parity; no token escapes the detector)',
    (slug) => {
      const raw = (templates[slug].match(/\[\[/g) ?? []).length;
      expect(detectPlaceholders(templates[slug])).toHaveLength(raw);
    },
  );

  /**
   * Claims about features that are NOT implemented yet (or owner facts) must
   * carry their own marker in the same line (paragraph / bullet / table row).
   * Marker -> story that makes the claim true.
   */
  const C = '[[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]]';
  const A = '[[CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO]]';
  const E = '[[CONFIRMAR_DECLARACION_DE_MAYORIA_DE_EDAD_IMPLEMENTADA]]';
  const O = '[[CONFIRMAR_PRODUCTOS_ORIGINALES_CON_EL_DUENO]]';
  const L = '[[CONFIRMAR_CEDULA_EN_ALMACENAMIENTO_LOCAL_DEL_NAVEGADOR]]';
  const claims: [string, RegExp, string][] = [
    ['terminos', /se guarda cifrado, se muestra enmascarado/, C],
    ['envios', /se guarda cifrada y se muestra enmascarada/, C],
    ['privacidad', /\(obligatorio para facturar y despachar\)/, C],
    ['privacidad', /Se guarda \*\*cifrado\*\* en los pedidos/, C],
    ['privacidad', /cifrado de la cédula/, C],
    ['terminos', /el sistema guarda la versión de estos términos/, A],
    ['terminos', /Cada pedido se rige por la versión que aceptaste/, A],
    ['privacidad', /\*\*Aceptaciones:\*\*/, A],
    ['privacidad', /Probar tu aceptación de los términos/, A],
    ['terminos', /Al registrarte o comprar declaras ser mayor/, E],
    ['privacidad', /tu declaración de mayoría de edad/, E],
    [
      'privacidad',
      /quedando registro de cada consulta/,
      '[[CONFIRMAR_REGISTRO_DE_CONSULTAS_DE_CEDULA_IMPLEMENTADO]]',
    ],
    [
      'privacidad',
      /se eliminan al cerrar sesión y, si la sesión vence/,
      '[[CONFIRMAR_BORRADO_DE_SESIONES_VENCIDAS_IMPLEMENTADO]]',
    ],
    [
      'privacidad',
      /Carritos y listas de deseos anónimos/,
      '[[CONFIRMAR_BORRADO_DE_CARRITOS_Y_LISTAS_ANONIMOS_VENCIDOS_IMPLEMENTADO]]',
    ],
    [
      'aviso-legal',
      /originales de fabricantes; no vendemos falsificaciones/,
      O,
    ],
    ['terminos', /Solo vendemos producto que creemos original/, O],
    ['privacidad', /Almacenamiento local de tu navegador/, L],
    ['cookies', /Puedes borrarlo desde la configuración/, L],
  ];
  it.each(claims)(
    '%s: the claim /%s/ carries %s on its own line',
    (slug, claim, marker) => {
      const lines = templates[slug].split('\n').filter((l) => claim.test(l));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const l of lines) expect(l).toContain(marker);
    },
  );

  it('cookies/privacidad do not hide the local storage of the cédula', () => {
    for (const slug of ['cookies', 'privacidad']) {
      expect(templates[slug]).toContain('localStorage');
    }
    expect(templates.cookies).toContain('`212_customer_addresses_*`');
    expect(templates.cookies).toContain('`212_cart_images`');
    expect(templates.cookies).toContain('`212_saved_products`');
    expect(templates.privacidad).toMatch(/sin cifrar/);
  });

  it('envios: does not promise a status e-mail (none is sent today)', () => {
    expect(templates.envios).not.toMatch(/avisaremos por correo/i);
    expect(templates.envios).not.toMatch(/por correo del cambio de estado/i);
  });

  it('every marker fits the detector length', () => {
    for (const slug of LEGAL_SLUGS) {
      for (const p of detectPlaceholders(templates[slug])) {
        expect(p.token.length - 4).toBeLessThanOrEqual(80);
      }
    }
  });
});
