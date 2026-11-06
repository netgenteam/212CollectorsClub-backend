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
const md = new LegalMarkdownService({ timeoutMs: 30_000 }); // 19.3b: roomy test deadline, product default stays 3 s;
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
  // Story 19.3a: the cédula is only mandatory when CHECKOUT_REQUIRE_SHIPPING
  // is on (false by default); no storefront component shows the tracking number.
  const R =
    '[[CONFIRMAR_CHECKOUT_REQUIRE_SHIPPING_ACTIVO_PARA_CEDULA_OBLIGATORIA]]';
  const G = '[[CONFIRMAR_SEGUIMIENTO_VISIBLE_AL_CLIENTE]]';
  // Story 20.6 (QA round 2): the immutable audit log keeps the IP of customer actions for good.
  const IPA = '[[CONFIRMAR_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]';
  // Story 20.7: the usage log keeps the IP and the user agent of every visitor for 7 days.
  const USO = '[[CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO]]';
  const claims: [string, RegExp, string][] = [
    ['privacidad', /\*\*Registro de uso \(7 días\):\*\*/, USO],
    ['privacidad', /Registro de uso \(incluida la dirección IP/, USO],
    ['privacidad', /el registro de uso de tu cuenta/, USO],
    ['privacidad', /\*\*Registro de auditoría \(inmutable\):\*\*/, IPA],
    ['privacidad', /Registro de auditoría \(incluida la dirección IP/, IPA],
    ['privacidad', /que no se borra ni se anonimiza/, IPA],
    ['terminos', /se guarda cifrado, se muestra enmascarado/, C],
    ['envios', /se guarda cifrada y se muestra enmascarada/, C],
    ['privacidad', /\(obligatorio para facturar y despachar/, C],
    ['privacidad', /obligatorio para facturar y despachar/, R],
    ['terminos', /obligatorio para completar la compra/, R],
    ['envios', /Es obligatoria /, R],
    ['envios', /registramos la agencia y el número de guía/, G],
    ['privacidad', /Se guarda \*\*cifrado\*\* en los pedidos/, C],
    ['privacidad', /cifrado de la cédula/, C],
    ['terminos', /el sistema guarda la versión de estos términos/, A],
    ['terminos', /Cada pedido se rige por la versión que aceptaste/, A],
    ['privacidad', /\*\*Aceptaciones:\*\*/, A],
    ['privacidad', /Probar tu aceptación de los términos/, A],
    [
      'terminos',
      /Al registrarte, o al volver a aceptar los documentos cuando te lo pidamos, declaras ser mayor/,
      E,
    ],
    ['privacidad', /tu declaración de mayoría de edad/, E],
    [
      'privacidad',
      /quedando registro de cada consulta/,
      '[[CONFIRMAR_REGISTRO_DE_CONSULTAS_DE_CEDULA_IMPLEMENTADO]]',
    ],
    [
      'privacidad',
      /la sesión vencida se elimina 7 días después de vencer/,
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
    [
      'privacidad',
      /Datos de facturación del comprador/,
      '[[CONFIRMAR_DATOS_DE_FACTURACION_DEL_COMPRADOR_IMPLEMENTADOS]]',
    ],
    [
      'privacidad',
      /Cómo pedirlo/,
      '[[CONFIRMAR_CANAL_DE_SOLICITUDES_DE_CIERRE_DE_CUENTA]]',
    ],
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

  it('cookies/privacidad say the address book left the browser and that the old unencrypted copy is purged (Story 20.9)', () => {
    for (const slug of ['cookies', 'privacidad']) {
      expect(templates[slug]).toContain('localStorage');
      expect(templates[slug]).toMatch(/sin cifrar/);
    }
    // the legacy key is still named (a visitor may still have it) but it is no longer a row of the live table
    expect(templates.cookies).not.toMatch(/^\| `212_customer_addresses_\*`/m);
    expect(templates.cookies).toContain('`212_customer_addresses_*`');
    expect(templates.cookies).toContain('`212_cart_images`');
    expect(templates.cookies).toContain('`212_saved_products`');
    expect(templates.privacidad).toMatch(
      /Ya no guarda tu libreta de direcciones/,
    );
    expect(templates.privacidad).toMatch(/borra esos datos del navegador/);
  });

  it('Story 20.10: privacidad describes what the Epic 20 changed (billing data, how to ask for the closing, backups, fiscal term)', () => {
    const t = templates.privacidad;
    const bullet = t
      .split('\n')
      .find((l) => l.includes('**Datos de facturación del comprador:**'));
    expect(bullet).toBeDefined();
    expect(bullet).toMatch(/nombre o razón social/);
    expect(bullet).toMatch(/cédula o RIF/);
    expect(bullet).toMatch(/\*\*cifrado\*\*/);
    expect(bullet).toContain(
      '[[CONFIRMAR_DATOS_DE_FACTURACION_DEL_COMPRADOR_IMPLEMENTADOS]]',
    );
    // A93: while there is no self-service, the request goes through the contact channel and an admin executes it
    const ask = t.split('\n').find((l) => l.includes('**Cómo pedirlo:**'));
    expect(ask).toBeDefined();
    expect(ask).toMatch(/no existe un botón de autoservicio/);
    expect(ask).toContain('[[EMAIL_CONTACTO]]');
    expect(ask).toContain(
      '[[CONFIRMAR_CANAL_DE_SOLICITUDES_DE_CIERRE_DE_CUENTA]]',
    );
    // A94: backups keep what they had until they rotate; purges are not retroactive
    expect(t).toMatch(
      /Copias de seguridad de la base de datos[^\n]*no\*\* se aplican de forma retroactiva/,
    );
    // the buyer fiscal data follows the fiscal term and is never purged automatically
    expect(t).toMatch(
      /Pedidos y datos de factura[^\n]*\[\[PLAZO_CONSERVACION_FISCAL\]\]/,
    );
    // the address book of the account is on the server, cedula encrypted
    expect(t).toMatch(
      /Libreta de direcciones de tu cuenta[^\n]*\*\*cifrada\*\*/,
    );
  });

  it('Story 19.3a: removed claims stay removed', () => {
    expect(templates.envios).not.toMatch(/verás un enlace/);
    expect(templates.devoluciones).not.toMatch(/48 a 72/);
    expect(templates.privacidad).not.toMatch(/mientras mantengas la cuenta/);
    expect(templates.privacidad).toMatch(/90 días de creada la sesión/);
  });

  it('Story 20.7: privacidad declares the usage log (IP, user agent, 7 days, what it never keeps) with its markers', () => {
    const t = templates.privacidad;
    const line = t
      .split('\n')
      .find((l) => l.includes('**Registro de uso (7 días):**'));
    expect(line).toBeDefined();
    expect(line).toMatch(/dirección IP/);
    expect(line).toMatch(/agente de usuario/);
    expect(line).toMatch(/identificador interno de tu cuenta/);
    expect(line).toMatch(/\*\*No\*\* guarda .*cookies.*cédula/);
    expect(line).toContain(
      '[[CONFIRMAR_CON_ABOGADO_BASE_LEGAL_DEL_REGISTRO_DE_USO]]',
    );
    expect(t).toMatch(
      /Registro de uso \(incluida la dirección IP[^\n]*\*\*7 días\*\*/,
    );
    expect(t).toMatch(/registro de uso de tu cuenta se borra/);
  });

  it('Story 19.4a: the age declaration is made at registration / re-acceptance (FR-116), not "al comprar"', () => {
    for (const [slug, text] of Object.entries(templates)) {
      expect(text, slug).not.toMatch(/registrarte o comprar/);
      expect(text, slug).not.toMatch(/al comprar[^.]*mayor de 18/i);
    }
    expect(templates.terminos).toMatch(/Al registrarte, o al volver a aceptar/);
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
