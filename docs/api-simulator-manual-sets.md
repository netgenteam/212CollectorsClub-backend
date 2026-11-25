# Contrato de API: sets manuales del simulador, CSV, imágenes y tasas (Epic 22)

> Para el equipo de **frontend** (panel admin y simulador público). Describe la API **real**: se verificó contra el
> código, contra Swagger (`/api/docs-json`) y contra una app en vivo. Además, `test/api-doc-examples.e2e-spec.ts` ejecuta
> los ejemplos de este documento contra el sistema real y **falla si el documento y el comportamiento divergen** (rutas,
> ejemplos JSON, CSV de ejemplo y catálogo de errores). Los bloques marcados con `<!-- example: ... -->` y las tablas de
> rutas y de errores son leídos por ese test: si los editas, mantén su formato.
>
> Convención de los ejemplos: `<uuid>` = cualquier UUID y `<iso>` = cualquier fecha ISO 8601 UTC.

## 0. Convenciones generales

- **Base:** `/api/v1` (todas las rutas de este documento). Swagger: `GET /api/docs-json` (no se monta con `NODE_ENV=production` salvo `SWAGGER_ENABLED=true`).
- **Auth admin:** `Authorization: Bearer <accessToken>` obtenido en `POST /api/v1/admin/auth/login` (`{usernameOrEmail, password}`). El login devuelve `{accessToken, tokenType: "Bearer", expiresIn: 28800}`: el token **expira a las 8 h (28800 s)**; pasado ese tiempo (o tras un logout) cualquier ruta responde `401` con `errorCode: INVALID_ADMIN_TOKEN` y hay que volver a iniciar sesión. Sin token o con token inválido: la misma respuesta `401`.
- **Ids** UUID; fechas ISO UTC; importes en **USD** (número JSON con a lo sumo 2 decimales).
- **Dos formas de error** (el frontend debe manejar ambas):
  1. Error de negocio: `{ "statusCode": 422, "errorCode": "SIMULATOR_SET_NOT_READY", "message": "...", "details": { ... } }` (`details` solo en algunos).
  2. Error de validación estándar (DTO, uuid inválido, query inválida): **sin `errorCode`**: `{ "message": ["campo ..."], "error": "Bad Request", "statusCode": 400 }` (`message` es un arreglo, o una cadena para un uuid inválido).
- **Paginación:** `?page=1&limit=N` y respuesta `{ "data": [...], "meta": { page, limit, total, totalPages, hasNextPage, hasPreviousPage } }`.
- **Auditoría:** toda escritura de sets, cartas e imports queda en el log inmutable. Si ese log no se puede escribir la escritura falla cerrada: `503 AUDIT_UNAVAILABLE`, no se cambió nada, reintentar en unos segundos.
- **Archivos subidos** se sirven en `/uploads/public/simulator/<uuid>.<ext>` (sin prefijo `/api`).

## 1. Resumen y flujo admin recomendado

Un **set manual** es un conjunto de cartas que el admin crea y mantiene a mano (reemplaza al antiguo set ingerido desde tcgapi y a la config `pack_simulator`). Cada set tiene una **plantilla** de sobre (qué slots lo componen) y está **inactivo** al crearse. Solo los sets **activos y con suficiencia de cartas** aparecen en el simulador público.

Flujo recomendado en el panel:

1. **Crear el set**: `POST /admin/simulator/manual-sets {name, imageUrl?, template?}`. Sin `template` se guarda una copia de la plantilla por defecto (§4). Queda inactivo.
2. **Subir imágenes** (portada del set y, si se quiere, de las cartas): `POST /admin/simulator/images` y usar la `url` devuelta como `imageUrl` (§6). Se asigna con `PATCH` del set / carta.
3. **Cargar cartas**: una a una (`POST .../cards`) o masivamente por **CSV** (`POST .../cards/import`, primero con `?dryRun=true` para validar sin escribir; §5).
4. **Leer `readiness`** del set (`GET /admin/simulator/manual-sets/:id`, o la lista): `ready` y `missing[]` dicen si se puede activar y qué falta (§4.3). Repetir 3 hasta que `ready` sea `true`.
5. **Activar**: `PATCH .../manual-sets/:id {"isActive": true}`. Si no hay suficiencia responde `422 SIMULATOR_SET_NOT_READY` con el mismo detalle (`details.missing`).

Reglas que el panel debe respetar: un set **activo** no se puede borrar (`409 SIMULATOR_SET_ACTIVE`; desactivar primero); borrar o cambiar de rareza una carta, o editar la plantilla, de un set **activo** se rechaza con `422 SIMULATOR_SET_NOT_READY` si el set dejaría de ser abrible (en un set inactivo siempre se permite). Importar o crear cartas solo suma y nunca rompe la suficiencia. El **nombre** del set es único sin distinguir mayúsculas ni espacios repetidos (`409 SIMULATOR_SET_NAME_TAKEN`). El **número de carta** (`number`) es único dentro del set **sin distinguir mayúsculas** (`A1` y `a1` son el mismo número; `409 SIMULATOR_CARD_NUMBER_TAKEN`, y `DUPLICATE_NUMBER` en el CSV); el valor se guarda y se devuelve tal como lo escribió el admin. Dos cartas sin número sí pueden coexistir.

## 2. Rutas

Todas con `AdminAuthGuard` salvo las públicas. «Resp.» es el status de éxito.

| Ruta | Auth | Query | Body | Resp. |
|---|---|---|---|---|
| `GET /api/v1/admin/simulator/manual-sets` | admin | `page`, `limit` (1..100, def. 20), `active=true\|false`, `q` (nombre, sin distinguir mayúsculas) | - | 200 `{data: SetDto[], meta}` |
| `POST /api/v1/admin/simulator/manual-sets` | admin | - | `{name, imageUrl?, template?}` (`isActive` se ignora) | 201 `SetDto` (inactivo) |
| `GET /api/v1/admin/simulator/manual-sets/:id` | admin | - | - | 200 `SetDto` |
| `PATCH /api/v1/admin/simulator/manual-sets/:id` | admin | - | `{name?, imageUrl? (null borra), template?, isActive?}` | 200 `SetDto` |
| `DELETE /api/v1/admin/simulator/manual-sets/:id` | admin | - | - | 204 (borra también sus cartas) |
| `GET /api/v1/admin/simulator/manual-sets/:id/cards` | admin | `page`, `limit` (1..100, def. 50), `tier`, `q` (nombre) | - | 200 `{data: CardDto[], meta}` (orden `name`, `id`) |
| `POST /api/v1/admin/simulator/manual-sets/:id/cards` | admin | - | `{name, rarityTier, number?, imageUrl?, marketPriceUsd?}` | 201 `CardDto` |
| `PATCH /api/v1/admin/simulator/manual-sets/:id/cards/:cardId` | admin | - | cualquier subconjunto de los campos; `number`, `imageUrl`, `marketPriceUsd` aceptan `null` | 200 `CardDto` |
| `DELETE /api/v1/admin/simulator/manual-sets/:id/cards/:cardId` | admin | - | - | 204 |
| `POST /api/v1/admin/simulator/manual-sets/:id/cards/import` | admin | `dryRun=true\|false` | multipart, campo `file` (CSV) | 201 `{dryRun:false,rows,imported}`; con `dryRun=true` 200 `{dryRun:true,rows,imported:0}` |
| `POST /api/v1/admin/simulator/images` | admin | - | multipart, campo `file` (imagen) | 201 `{url,width,height,bytes}` |
| `GET /api/v1/simulator/sets` | pública | - | - | 200 `{data: [...]}` (cabecera `Cache-Control: public, max-age=60`) |
| `POST /api/v1/simulator/packs` | pública (límite por IP) | - | `{setId}` (UUID) | 200 sobre |

Notas: un cambio sin efecto efectivo (`PATCH {}` o con los mismos valores) responde 200 con el recurso y no escribe nada. En `PATCH` del set, `isActive` activa/desactiva (idempotente). Cambiar el nombre/otros campos y `isActive` a la vez es válido. `name` de set y de carta: 1..120 caracteres (se recorta; en el set además se **colapsan los espacios internos**: `"Mi  set"` se guarda y devuelve como `"Mi set"`); `number` ≤ 30 (vacío = `null`); `imageUrl` ≤ 300 (§6.3).

### 2.1 `SetDto`

`cardCountByTier` siempre trae las 8 claves. `readiness` sale del mismo cálculo que usa la activación (§4.3). Ejemplo de un set recién creado con la plantilla por defecto:

<!-- example: set-empty -->
```json
{
  "id": "<uuid>",
  "name": "Mi set de prueba",
  "imageUrl": null,
  "isActive": false,
  "template": {
    "slots": [
      { "kind": "fixed", "tier": "COMMON", "count": 4 },
      { "kind": "fixed", "tier": "UNCOMMON", "count": 3 },
      { "kind": "reverse", "count": 2 },
      {
        "kind": "rare",
        "odds": {
          "RARE": 70,
          "HYPER_RARE": 1,
          "ULTRA_RARE": 6,
          "DOUBLE_RARE": 15,
          "ILLUSTRATION_RARE": 6,
          "SPECIAL_ILLUSTRATION_RARE": 2
        }
      }
    ]
  },
  "cardCount": 0,
  "cardCountByTier": {
    "COMMON": 0,
    "UNCOMMON": 0,
    "RARE": 0,
    "DOUBLE_RARE": 0,
    "ULTRA_RARE": 0,
    "ILLUSTRATION_RARE": 0,
    "SPECIAL_ILLUSTRATION_RARE": 0,
    "HYPER_RARE": 0
  },
  "readiness": {
    "ready": false,
    "missing": [
      { "slot": "fixed:COMMON", "tier": "COMMON", "required": 4, "available": 0 },
      { "slot": "fixed:UNCOMMON", "tier": "UNCOMMON", "required": 3, "available": 0 },
      { "slot": "reverse", "tier": null, "required": 9, "available": 0 },
      { "slot": "rare:RARE", "tier": "RARE", "required": 1, "available": 0 },
      { "slot": "rare:DOUBLE_RARE", "tier": "DOUBLE_RARE", "required": 1, "available": 0 },
      { "slot": "rare:ULTRA_RARE", "tier": "ULTRA_RARE", "required": 1, "available": 0 },
      { "slot": "rare:ILLUSTRATION_RARE", "tier": "ILLUSTRATION_RARE", "required": 1, "available": 0 },
      { "slot": "rare:SPECIAL_ILLUSTRATION_RARE", "tier": "SPECIAL_ILLUSTRATION_RARE", "required": 1, "available": 0 },
      { "slot": "rare:HYPER_RARE", "tier": "HYPER_RARE", "required": 1, "available": 0 }
    ]
  },
  "createdAt": "<iso>",
  "updatedAt": "<iso>"
}
```

### 2.2 `CardDto` y paginación `{data, meta}`

`marketPriceUsd` es un **número JSON** (`12.5`) o `null`. `number` e `imageUrl` también pueden ser `null`.

<!-- example: card -->
```json
{
  "id": "<uuid>",
  "setId": "<uuid>",
  "name": "Charizard ex",
  "rarityTier": "DOUBLE_RARE",
  "number": "001/165",
  "imageUrl": "https://img.example.com/c.png",
  "marketPriceUsd": 12.5,
  "createdAt": "<iso>",
  "updatedAt": "<iso>"
}
```

`GET .../cards` (tras importar la plantilla CSV de §5):

<!-- example: cards-page -->
```json
{
  "data": [
    {
      "id": "<uuid>",
      "setId": "<uuid>",
      "name": "Charizard ex",
      "rarityTier": "DOUBLE_RARE",
      "number": "001/165",
      "imageUrl": "https://img.example.com/c.png",
      "marketPriceUsd": 12.5,
      "createdAt": "<iso>",
      "updatedAt": "<iso>"
    },
    {
      "id": "<uuid>",
      "setId": "<uuid>",
      "name": "Pikachu",
      "rarityTier": "COMMON",
      "number": null,
      "imageUrl": null,
      "marketPriceUsd": null,
      "createdAt": "<iso>",
      "updatedAt": "<iso>"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 2,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

### 2.3 Imagen subida

<!-- example: image-ok -->
```json
{
  "url": "/uploads/public/simulator/<uuid>.png",
  "width": 1,
  "height": 1,
  "bytes": 68
}
```

### 2.4 Resultado del import

<!-- example: import-dry -->
```json
{ "dryRun": true, "rows": 2, "imported": 0 }
```

<!-- example: import-ok -->
```json
{ "dryRun": false, "rows": 2, "imported": 2 }
```

## 3. Catálogo de `errorCode`

`details` solo se lista donde existe. La forma de `SIMULATOR_SET_NOT_READY.details.missing` está en §4.3 y la de `SIMULATOR_CSV_INVALID.details.errors` en §5.5.

<!-- catalog:start -->
| errorCode | Status | `details` | Cuándo ocurre |
|---|---|---|---|
| `INVALID_ADMIN_TOKEN` | 401 | - | Falta el token admin o es inválido/expirado. |
| `SIMULATOR_SET_NOT_FOUND` | 404 | - | El set no existe (rutas admin) o no está activo/listo (público: ver §7). |
| `SIMULATOR_CARD_NOT_FOUND` | 404 | - | La carta no existe en ese set. |
| `SIMULATOR_SET_NAME_TAKEN` | 409 | - | Ya hay un set con ese nombre (sin distinguir mayúsculas ni espacios repetidos). |
| `SIMULATOR_CARD_NUMBER_TAKEN` | 409 | - | Otra carta del set usa ese `number` (sin distinguir mayúsculas). |
| `SIMULATOR_SET_ACTIVE` | 409 | - | Se intentó borrar un set activo; desactivarlo primero. |
| `SIMULATOR_SET_BUSY` | 409 | - | Otra petición mantiene bloqueado el set más de 5 s; reintentar en unos segundos. |
| `SIMULATOR_SET_NOT_READY` | 422 | `{missing: [{slot,tier,required,available}], reason?}` | Activar, borrar/editar la rareza de una carta o editar la plantilla de un set activo dejaría el set sin suficiencia. |
| `SIMULATOR_SET_LIMIT` | 422 | `{max}` | Ya existen `SIMULATOR_MAX_SETS` sets (def. 50). |
| `SIMULATOR_SET_CARD_LIMIT` | 422 | `{max, current, incoming}` | El set pasaría de `SIMULATOR_MAX_CARDS_PER_SET` cartas (def. 2000); `incoming` = 1 en alta manual o las filas del CSV. |
| `SIMULATOR_CSV_REQUIRED` | 400 | `{hint}` (si el campo tiene otro nombre) | No hay archivo en el campo `file`. |
| `SIMULATOR_CSV_MULTIPART_INVALID` | 400 | `{hint}` | Más de un archivo u otro defecto del multipart. |
| `SIMULATOR_CSV_TOO_LARGE` | 413 | `{maxBytes}` | El archivo supera `SIMULATOR_CSV_MAX_BYTES` (def. 1 MB). |
| `SIMULATOR_CSV_INVALID` | 422 | `{errors[{row,field,code,message}] (<=100), totalErrors, truncated}` | El CSV tiene errores (no se importa nada). Códigos en §5.5. |
| `SIMULATOR_IMAGE_REQUIRED` | 400 | `{hint}` (si el campo tiene otro nombre) | No hay archivo en el campo `file`. |
| `SIMULATOR_IMAGE_MULTIPART_INVALID` | 400 | `{hint}` | Más de un archivo u otro defecto del multipart. |
| `SIMULATOR_IMAGE_TOO_LARGE` | 413 | `{maxBytes}` | La imagen supera `SIMULATOR_IMAGE_MAX_BYTES` (def. 2 MB). |
| `SIMULATOR_IMAGE_DIMENSIONS` | 422 | `{width, height}` | Ancho fuera de 1..4096 px o alto > 4096 px. |
| `UNSUPPORTED_FILE_TYPE` | 400 | - | Imagen que no es jpg/png/webp/avif, o CSV binario (no texto). |
| `SIMULATOR_CONFIG_INVALID` | 400 | `{path}` | Plantilla mal formada (§4.4). |
| `SIMULATOR_ODDS_INVALID_SUM` | 400 | `{path, sum}` | Las probabilidades del slot `rare` no suman 100 (±0,001). |
<!-- catalog:end -->

**Texto con aspecto de dato personal o secreto (400 estándar con `message` como CADENA, no arreglo, y sin `errorCode`).** En JSON (no en CSV, donde es `UNSAFE_TEXT` por fila, §5.1) se rechazan con ese 400: `number` de carta (alta y `PATCH`), `imageUrl` de carta y de set, y `name` de **set**, cuando parecen un correo, teléfono, documento de identidad, tarjeta o secreto. Ejemplo: `{"message":"number must not contain emails, phone numbers, ID documents, card numbers or secrets","error":"Bad Request","statusCode":400}` (el texto cambia el nombre del campo: `name must not contain ...`, `imageUrl must not contain ...`). El `name` de una **carta** no pasa por este filtro (se guarda tal cual). Atención al manejo en el cliente: este 400 trae `message` string, el de validación de campos trae arreglo.

El filtro de fórmulas (`=`, `+`, `-`, `@` al inicio) rige **solo en el CSV** (`FORMULA`): por JSON, `name` y `number` que empiecen por `=` se aceptan.

Otros: `400` de validación estándar (sin `errorCode`: nombre vacío o de más de 120, `rarityTier` desconocido, `marketPriceUsd` inválido, `imageUrl` inválida, uuid mal formado, `limit` > 100, `active` no booleano, `dryRun` distinto de `true`/`false`); `503 AUDIT_UNAVAILABLE` (§0). El `message` de cada error es texto en inglés para depurar: el panel debe mapear por `errorCode`.

Ejemplo (activar sin suficiencia; set con solo `Charizard ex` DOUBLE_RARE y `Pikachu` COMMON de la plantilla CSV):

<!-- example: err-not-ready -->
```json
{
  "statusCode": 422,
  "errorCode": "SIMULATOR_SET_NOT_READY",
  "message": "The set does not have enough cards for its template.",
  "details": {
    "missing": [
      { "slot": "fixed:COMMON", "tier": "COMMON", "required": 4, "available": 1 },
      { "slot": "fixed:UNCOMMON", "tier": "UNCOMMON", "required": 3, "available": 0 },
      { "slot": "reverse", "tier": null, "required": 9, "available": 1 },
      { "slot": "rare:RARE", "tier": "RARE", "required": 1, "available": 0 },
      { "slot": "rare:ULTRA_RARE", "tier": "ULTRA_RARE", "required": 1, "available": 0 },
      { "slot": "rare:ILLUSTRATION_RARE", "tier": "ILLUSTRATION_RARE", "required": 1, "available": 0 },
      { "slot": "rare:SPECIAL_ILLUSTRATION_RARE", "tier": "SPECIAL_ILLUSTRATION_RARE", "required": 1, "available": 0 },
      { "slot": "rare:HYPER_RARE", "tier": "HYPER_RARE", "required": 1, "available": 0 }
    ]
  }
}
```

Ejemplo de validación estándar (sin `errorCode`):

<!-- example: err-validation -->
```json
{
  "message": ["setId must be a UUID"],
  "error": "Bad Request",
  "statusCode": 400
}
```

## 4. Tiers, suficiencia, plantilla y límites

### 4.1 Los 8 tiers

`COMMON`, `UNCOMMON`, `RARE`, `DOUBLE_RARE`, `ULTRA_RARE`, `ILLUSTRATION_RARE`, `SPECIAL_ILLUSTRATION_RARE`, `HYPER_RARE` (en `rarityTier`, `tier`, CSV y filtros). `promo` no existe: no entra en sobres.

### 4.2 Plantilla (`template`)

`{ "slots": [...] }` con slots en orden: `{kind:"fixed", tier, count 1..8}`, `{kind:"reverse", count 1..4}` y **exactamente un** `{kind:"rare", odds}` que debe ser **el último** (`odds` con claves de `RARE` a `HYPER_RARE`, valores ≥ 0 que suman 100 ±0,001; **puede omitir tiers**: `{"RARE": 100}` es válido y el POST lo devuelve tal cual, solo los tiers presentes con probabilidad > 0 exigen cartas). Entre 1 y 15 cartas en total (el slot `rare` cuenta 1). La plantilla por defecto es 4 COMMON + 3 UNCOMMON + 2 reverse + 1 rara = 10 cartas (ejemplo de §2.1). Un `reverse` toma cartas de la unión COMMON+UNCOMMON+RARE (las cartas manuales no tienen «impresión», así que `isReverse` solo marca el slot).

### 4.3 Regla de suficiencia (en lenguaje llano) y cómo leer `readiness.missing`

Un set está **listo** (`readiness.ready = true`) cuando el sobre puede armarse **siempre**, sin repetir cartas, sin importar el azar:

1. Por cada tier con slots `fixed`: hay al menos tantas cartas como slots `fixed` de ese tier suman. **El orden importa:** si un slot `reverse` va **antes** del último `fixed` de un tier COMMON/UNCOMMON/RARE, ese tier necesita además tantas cartas como slots `reverse` anteriores (el reverse podría llevarse cartas de ese tier).
2. Los slots `reverse` salen de COMMON+UNCOMMON+RARE tras reservar lo que usan los `fixed` de esos tres tiers: debe haber al menos `suma fixed C+U+R + suma reverse`.
3. Por cada tier con probabilidad > 0 en el slot `rare`: al menos **una carta libre** de ese tier (más las que consuman los `fixed` de ese tier).
4. Si `RARE` tiene probabilidad > 0 en el slot rare: COMMON+UNCOMMON+RARE debe sumar al menos `fixed C+U+R + reverse + 1` (el reverse podría agotar las RARE).

**Cómo leerlo.** `missing` es una lista; vacía = listo. Cada elemento: `{slot, tier, required, available}`:

- `slot`: `fixed:<TIER>` (regla 1), `reverse` (reglas 2 y 4; `tier` = `null`) o `rare:<TIER>` (regla 3).
- `required`: cuántas cartas se necesitan en total para ese slot; `available`: cuántas hay ahora. **Lo que falta = `required - available`.**
- Para `reverse`, `required`/`available` cuentan la **suma COMMON+UNCOMMON+RARE** del set (no un tier). Para `rare:<TIER>`, `available` es el total de ese tier y `required` incluye lo reservado por los `fixed`.
- Si la plantilla es inválida: `ready:false`, `missing: []` y `reason: "TEMPLATE_INVALID"` (el set es inactivable hasta corregir la plantilla).
- Mensaje sugerido al admin: «Faltan {required - available} cartas {tier} ({slot})». Un mismo tier puede aparecer en varios elementos; para `reverse` mostrar «Faltan N cartas Common/Uncommon/Rare en total».
- `missing` sale en el orden `fixed`, `reverse`, `rare` y es el mismo que trae `details.missing` de un `422 SIMULATOR_SET_NOT_READY`.

**Ejemplo 1 (plantilla por defecto).** El mínimo es 4 COMMON, 3 UNCOMMON, al menos 1 de cada tier con probabilidad > 0 y COMMON+UNCOMMON+RARE ≥ 10. Con 4 COMMON, 3 UNCOMMON, **2** RARE y 1 de cada uno de los otros 5 tiers, solo suman 9 C+U+R: falta 1.

<!-- example: not-ready-default -->
```json
{ "missing": [ { "slot": "reverse", "tier": null, "required": 10, "available": 9 } ] }
```

**Ejemplo 2 (corrección de orden de slots).** Plantilla `reverse x2, fixed COMMON x4, rare {RARE:100}` con 5 COMMON y 1 RARE: como el `reverse` va antes del `fixed COMMON`, COMMON necesita 4 + 2 = 6 (hay 5), y C+U+R debe ser al menos 4 + 2 + 1 = 7 (hay 6).

<!-- example: not-ready-order -->
```json
{
  "missing": [
    { "slot": "fixed:COMMON", "tier": "COMMON", "required": 6, "available": 5 },
    { "slot": "reverse", "tier": null, "required": 7, "available": 6 }
  ]
}
```

La suficiencia se exige al **activar** y, en un set **activo**, al borrar o cambiar de rareza una carta y al editar la plantilla. En un set inactivo `readiness` es informativo.

### 4.4 Límites y variables de entorno

| Variable | Default | Qué limita | Error |
|---|---|---|---|
| `SIMULATOR_MAX_SETS` | 50 | sets en total | `SIMULATOR_SET_LIMIT` |
| `SIMULATOR_MAX_CARDS_PER_SET` | 2000 | cartas por set | `SIMULATOR_SET_CARD_LIMIT` |
| `SIMULATOR_CSV_MAX_BYTES` | 1048576 (1 MB) | tamaño del CSV | `SIMULATOR_CSV_TOO_LARGE` |
| `SIMULATOR_CSV_MAX_ROWS` | 2000 | filas de datos por CSV | `SIMULATOR_CSV_INVALID` (`TOO_MANY_ROWS`) |
| `SIMULATOR_IMAGE_MAX_BYTES` | 2097152 (2 MB; si falta, usa `LANDING_IMAGE_MAX_BYTES`) | tamaño de la imagen | `SIMULATOR_IMAGE_TOO_LARGE` |
| `SIMULATOR_RATE_LIMIT_PER_MIN` | 30 | `POST /simulator/packs` por IP y minuto | 429 |

Fijos: nombre de set y de carta ≤ 120, `number` ≤ 30, `imageUrl` ≤ 300, imagen ≤ 4096 px por lado. Un valor inválido de las variables numéricas se ignora y se usa el default. Se leen al arrancar el proceso (cambiarlas requiere reinicio).

## 5. Importación por CSV

`POST /api/v1/admin/simulator/manual-sets/:id/cards/import[?dryRun=true]`, `multipart/form-data` con **un** archivo en el campo `file`. **Todo o nada:** si cualquier fila falla no se escribe nada y se devuelven todos los errores (hasta 100). El import **solo añade** cartas (no actualiza las existentes). `dryRun=true` valida y cuenta sin escribir, sin auditar y sin tocar el caché (200 `{dryRun:true,rows,imported:0}`); sin `dryRun` y todo bien: 201.

### 5.1 Formato exacto

- **Codificación:** UTF-8, con o sin BOM. Cualquier otra (p. ej. Excel «CSV (delimitado por comas)» en ANSI/Latin-1) da `ENCODING`. En Excel usar «CSV UTF-8».
- **Separador:** `,` o `;`, detectado en la cabecera (el que más aparezca fuera de comillas; empate = `,`). Comillas dobles RFC 4180 (`""` para una comilla; se admiten saltos de línea dentro de comillas). Líneas vacías se ignoran.
- **Cabecera obligatoria** en la primera línea, sin distinguir mayúsculas ni espacios: `name`, `rarity` (obligatorias) y `number`, `imageUrl`, `marketPriceUsd` (opcionales, cualquier orden). Columna desconocida: `UNKNOWN_COLUMN`; repetida: `DUPLICATE_COLUMN`; falta una obligatoria: `MISSING_COLUMN` (todas en la fila 1).
- **Cada fila** debe tener exactamente tantas columnas como la cabecera (`COLUMN_COUNT`).
- **`name`**: 1..120, no puede empezar por `=`, `+`, `-`, `@` ni tabulador (`FORMULA`, protección contra inyección de fórmulas en hojas de cálculo).
- **`number`** (opcional): ≤ 30, mismas reglas de fórmula, y no puede parecer correo, teléfono, documento de identidad, tarjeta o secreto (`UNSAFE_TEXT`). Único dentro del archivo y contra el set **sin distinguir mayúsculas** (`DUPLICATE_NUMBER`, se reporta en la segunda aparición). Cuidado: Excel suele convertir `001/165` en fecha; formatear la columna como texto.
- **`imageUrl`** (opcional): ruta propia `/uploads/public/(simulator|landing)/...` o URL `https://` sin credenciales, ≤ 300; nunca se descarga (`INVALID_URL`; `UNSAFE_TEXT` si parece PII).
- **`marketPriceUsd`** (opcional): `^\d{1,8}(\.\d{1,2})?$`, **punto** decimal, máx. 2 decimales (`INVALID_PRICE`). Sin la columna o vacío, la carta queda sin precio (no suma al total del sobre).
- **`rarity`**: el código del tier sin distinguir mayúsculas y con espacios o guiones en lugar de `_` (`DOUBLE_RARE`, `double rare`, `double-rare`) **o** el texto de rareza del TCG: `Common`, `Uncommon`, `Rare`, `Rare Holo`, `Holo Rare`, `Shiny Rare` (RARE), `Double Rare`, `Ultra Rare`, `ACE SPEC Rare` (ULTRA_RARE), `Illustration Rare`, `Special Illustration Rare`, `Hyper Rare`, `Secret Rare` (HYPER_RARE); textos parecidos se mapean por palabras clave (p. ej. `Rare Holo VMAX` = RARE). `promo`, vacío o desconocido: `INVALID_RARITY`.

### 5.2 Plantilla descargable

Archivo: [`docs/cards-template.csv`](./cards-template.csv) (el panel puede ofrecerlo tal cual). Es también el de este bloque:

<!-- example: csv-template -->
```csv
name,rarity,number,imageUrl,marketPriceUsd
Charizard ex,Double Rare,001/165,https://img.example.com/c.png,12.50
Pikachu,common,,,
```

### 5.3 Numeración de filas

`row` cuenta **registros CSV**, no líneas físicas: la cabecera es la fila `1`, el primer registro de datos la `2`. Un registro con un campo entre comillas que ocupa varias líneas físicas cuenta como una sola fila. `row: 0` + `field: "file"` indican un error del archivo entero.

### 5.4 Ejemplo de archivo con errores

<!-- example: csv-invalid -->
```csv
name,rarity,number,imageUrl,marketPriceUsd
Charizard ex,Double Rare,001/165,https://img.example.com/c.png,12.50
,common,002/165,,
=SUM(A1),common,003/165,,
Pikachu,promo,004/165,,
Bulbasaur,common,001/165,,
Eevee,rare,005/165,ftp://x/y.png,1.234
Snorlax,rare,006/165
```

Respuesta (`422`, todos los errores de una pasada; una fila puede aportar más de uno, como la 7):

<!-- example: csv-invalid-response -->
```json
{
  "statusCode": 422,
  "errorCode": "SIMULATOR_CSV_INVALID",
  "message": "The CSV has errors; nothing was imported.",
  "details": {
    "errors": [
      { "row": 3, "field": "name", "code": "REQUIRED", "message": "name is required." },
      { "row": 4, "field": "name", "code": "FORMULA", "message": "name must not start with = + - @ (spreadsheet formula injection)." },
      { "row": 5, "field": "rarity", "code": "INVALID_RARITY", "message": "Unknown rarity (use a tier code such as DOUBLE_RARE or a rarity text such as \"Illustration Rare\")." },
      { "row": 6, "field": "number", "code": "DUPLICATE_NUMBER", "message": "number repeated in the file." },
      { "row": 7, "field": "imageUrl", "code": "INVALID_URL", "message": "imageUrl must be an own /uploads/public/(simulator|landing)/ path or an https:// URL (max 300, no credentials)." },
      { "row": 7, "field": "marketPriceUsd", "code": "INVALID_PRICE", "message": "marketPriceUsd must be 0..99999999.99 with a dot and at most 2 decimals." },
      { "row": 8, "field": "row", "code": "COLUMN_COUNT", "message": "Expected 5 columns, found 3." }
    ],
    "totalErrors": 7,
    "truncated": false
  }
}
```

### 5.5 Códigos de `details.errors[].code`

Por campo: `REQUIRED`, `TOO_LONG`, `FORMULA`, `UNSAFE_TEXT`, `INVALID_RARITY`, `INVALID_URL`, `INVALID_PRICE`, `DUPLICATE_NUMBER`, `COLUMN_COUNT` (campo `row`). De cabecera (fila 1): `UNKNOWN_COLUMN`, `DUPLICATE_COLUMN`, `MISSING_COLUMN`. De archivo (`row: 0`, `field: "file"`): `EMPTY` (sin cabecera o sin filas), `ENCODING` (no es UTF-8), `TOO_MANY_ROWS` (más de `SIMULATOR_CSV_MAX_ROWS`), `MALFORMED_CSV` (comillas sin cerrar u otro defecto de sintaxis; el mensaje indica la línea aproximada). `details.truncated` es `true` si hubo más de 100 errores (`totalErrors` trae el total real). Un archivo con más de `SIMULATOR_CSV_MAX_ROWS` filas se corta en `TOO_MANY_ROWS` sin validar el resto.

Otros errores de este endpoint: `SIMULATOR_CSV_REQUIRED`, `SIMULATOR_CSV_MULTIPART_INVALID`, `SIMULATOR_CSV_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE` (archivo binario), `SIMULATOR_SET_CARD_LIMIT`, `SIMULATOR_SET_NOT_FOUND`, `SIMULATOR_SET_BUSY`.

## 6. Imágenes

`POST /api/v1/admin/simulator/images`, `multipart/form-data`, **un** archivo en el campo `file`.

1. **Formatos:** jpg, png, webp, avif; se decide por el **contenido** (no por la extensión ni el `Content-Type`). Otro formato: `400 UNSUPPORTED_FILE_TYPE`.
2. **Tamaño:** hasta `SIMULATOR_IMAGE_MAX_BYTES` (2 MB por defecto): `413 SIMULATOR_IMAGE_TOO_LARGE {maxBytes}`. Dimensiones: ancho 1..4096 y alto ≤ 4096 px, **sin proporción obligatoria** (`422 SIMULATOR_IMAGE_DIMENSIONS {width,height}`). Recomendación de UX: cartas ≈ 63x88 (retrato).
3. **Uso:** la respuesta `{url,width,height,bytes}` (§2.3) trae `url` relativa (`/uploads/public/simulator/<uuid>.<ext>`); se envía **tal cual** como `imageUrl` del set o de la carta (`PATCH` / `POST` / columna `imageUrl` del CSV) y se muestra con `<host de la API><url>` (la ruta no lleva `/api`). Además de rutas propias (`/uploads/public/simulator/...` y, para conservar la imagen de sets migrados, `/uploads/public/landing/...`), `imageUrl` acepta `https://` sin credenciales (nunca se descarga); `http://`, `ftp://`, `..` o rutas externas dan 400 de validación (o `INVALID_URL` en CSV).
4. Las imágenes huérfanas (set o carta borrados, o reemplazadas) **no se eliminan** del disco.

## 7. Endpoints públicos y compatibilidad con el frontend

### 7.1 Sin cambio de forma

`GET /api/v1/simulator/sets` devuelve solo sets **activos y listos** (`[]` hasta activar uno). `cardCount` = total de cartas del set; `gameSlug` es siempre `pokemon`.

<!-- example: public-sets -->
```json
{
  "data": [
    {
      "setId": "<uuid>",
      "gameSlug": "pokemon",
      "name": "Mi set de prueba",
      "cardCount": 15,
      "imageUrl": null
    }
  ]
}
```

`POST /api/v1/simulator/packs` con `{"setId": "<uuid>"}` devuelve el sobre (10 cartas con la plantilla por defecto, sin repetidas, la rara al final; nada se persiste). Forma (cartas abreviadas):

<!-- example: pack mode=shape -->
```json
{
  "set": { "setId": "<uuid>", "gameSlug": "pokemon", "name": "Mi set de prueba" },
  "cards": [
    {
      "position": 1,
      "id": "<uuid>",
      "name": "Squirtle",
      "number": "015/165",
      "rarityTier": "COMMON",
      "rarityRaw": "COMMON",
      "isReverse": false,
      "imageUrl": null,
      "marketPriceUsd": 0.25,
      "product": null
    },
    "<...hasta 10 cartas con la misma forma>"
  ],
  "totalValueUsd": 3.4,
  "pricedCards": 6,
  "unpricedCards": 4
}
```

### 7.2 Diferencias respecto al simulador anterior (el frontend debe adaptarse)

- **`product` es siempre `null`.** Antes podía ser `{slug, priceUsd}` (enlace «Cómpralo»). **El tipo `SimCard.product` de `212CollectorsClub-frontend/lib/simulator/logic.ts` debe admitir `null`** (`product?: { slug: string; priceUsd: number } | null`); `components/simulator/simulator-modal.tsx` ya hace `c.product && ...`, así que el tipo es el cambio mínimo.
- **`setId` es ahora un UUID.** Con un slug viejo (p. ej. `pokemon-sv3`) `POST /simulator/packs` responde **`400`** de validación estándar (`setId must be a UUID`), no 404 (ejemplo `err-validation` de §3). UUID inexistente, set inactivo o no listo: `404 SIMULATOR_SET_NOT_FOUND`. Si el frontend tenía un set seleccionado guardado (localStorage, URL), debe tratar el 400 y el 404 como «volver al selector».
- `rarityRaw = rarityTier` (ya no hay texto crudo del TCG); `id` de la carta es el UUID de la carta manual; `number` puede ser `null`; `marketPriceUsd` número o `null`; `gameSlug` fijo `pokemon`.
- Un set desactivado deja de abrirse al instante; la lista pública puede tardar hasta 60 s en reflejarlo (caché).
- La config antigua (`pack_simulator`) ya **no afecta** al público.

## 8. FX (tasas): `GET /admin/fx/status`

Cambio **aditivo**: `sources` conserva forma y claves (`BCV_USD`, `BCV_EUR`, `PARALELO_USD`; cada una `{rate, providerUpdatedAt, fetchedAt}` del último snapshot válido, o `null` si nunca hubo uno) y ahora las **3 fuentes se leen en cada ciclo** (antes solo la activa se refrescaba). Se añade **`sourceStates`**, siempre con las 3 claves y todos los campos `null` si la fuente nunca se intentó:

```json
"sourceStates": {
  "BCV_EUR": {
    "lastAttemptAt": "<iso>", "lastSuccessAt": "<iso>",
    "lastError": "Reading rejected: DATE_REGRESSION", "lastErrorAt": "<iso>",
    "rejectedReading": { "at": "<iso>", "rate": 1034.5, "reason": "DATE_REGRESSION", "source": "BCV_EUR", "rawRate": "1034.5", "providerUpdatedAt": "<iso>" }
  },
  "BCV_USD": { "lastAttemptAt": "<iso>", "lastSuccessAt": "<iso>", "lastError": null, "lastErrorAt": null, "rejectedReading": null },
  "PARALELO_USD": { "...": "misma forma" }
}
```

**Tipos (importante para el cliente):** `rate` en el status raíz y en `sources[k]` es un **string decimal** con 4 decimales (`"922.5637"`), igual que `vesPerUsd` en `/admin/fx/settings`; dentro de `sourceStates[k].rejectedReading`, en cambio, `rate` es un **número** (`1034.5`) y `rawRate` un **string** (`"1034.5"`), `providerUpdatedAt` y `at` son strings ISO. Estos tipos los fija `test/fx-epic22-regression.e2e-spec.ts` (el ejemplo de arriba no está marcado como ejecutable porque depende de un rechazo del proveedor).

Los errores por fuente viajan en `sourceStates`, **no** dentro de `sources[k]`. El resto del status (`source`, `rate`, `providerUpdatedAt`, `fetchedAt`, `stale`, `hardStale`, `lastError`, `rejectedReading`) no cambia y describe la fuente **activa**. `POST /admin/fx/refresh` ahora refresca las **3** fuentes y devuelve el status más `result` (`UPDATED | NOOP | MANUAL | REJECTED | FAILED | SKIPPED`, de la activa). Con la fuente `MANUAL` activa se registran las 3 lecturas pero la tasa no cambia.

**Panel de tasas (sugerencia).** Mostrar una tarjeta por fuente con `sources[k].rate` y `providerUpdatedAt`, y un aviso si `sourceStates[k].lastError` no es `null` (mostrar `lastError` y la fecha `lastErrorAt`). Si `rejectedReading` de la fuente **activa** no es `null` ofrecer «Aceptar lectura rechazada» (`POST /admin/fx/accept-rejected`); `hardStale`/`stale` siguen significando que la tasa activa es vieja. Otras rutas sin cambio: `GET/PUT /admin/fx/settings`, `GET /admin/fx/history`, `GET /admin/fx/audit`.

**Cambio de comportamiento (no de forma):** la referencia de variación es el último snapshot **vigente** (según `FX_VARIATION_REFERENCE_MAX_AGE_HOURS`, def. 96 h). Una lectura que varía más de `maxVariationPct` se rechaza una vez (`REJECTED`, `rejectedReading`) y se **acepta sola en un ciclo posterior** si el proveedor la repite (±0,5 %) con fecha nueva. Ese cambio queda en el log de auditoría (`GET /admin/audit/events`) como `FX_RATE_CHANGED` con `after.confirmedAfterRejection: true` y `after.candidateProviderUpdatedAt`. Un valor ≤ 0, no finito o con fecha futura se rechaza siempre.

## 9. Endpoints `deprecated` y plan de retiro

Marcados `deprecated: true` en Swagger; siguen funcionando pero **no afectan al simulador público**:

| Ruta | Estado |
|---|---|
| `GET /api/v1/admin/simulator/config` | deprecated |
| `PUT /api/v1/admin/simulator/config` | deprecated (valida y guarda, sin efecto en el público) |
| `GET /api/v1/admin/simulator/sets` | deprecated (sets ingeridos desde tcgapi con diagnóstico de cobertura; puede devolver `[]`) |
| `PUT /api/v1/admin/landing-content/pack_simulator/:key` | deprecated |

Plan: el panel admin nuevo debe dejar de llamarlos y usar solo `manual-sets`. Tras desplegar y adaptar el frontend, se retirarán en una story posterior (no antes de que el frontend no los use; no se retiran en el Epic 22). Las rutas BFF actuales del frontend `app/api/admin/simulator/{config,sets}` quedan obsoletas.

---

### Apéndice: qué se verificó en vivo

Recorrido con `curl` contra una app real (BD clonada de desarrollo): crear set, subir imagen (válida, 5000 px, 3 MB, no imagen, sin campo, dos archivos), `dryRun`, import de la plantilla y de un CSV con `;` y BOM, CSV con errores, malformado, vacío, Latin-1, columna desconocida, activar sin/con suficiencia, borrar set activo, nombre repetido, plantilla inválida, probabilidades que no suman 100, límites (`SIMULATOR_MAX_SETS`, `SIMULATOR_MAX_CARDS_PER_SET`, `SIMULATOR_CSV_MAX_BYTES`, `SIMULATOR_CSV_MAX_ROWS` reducidos), sobre público, slug viejo (400), set desactivado (404) y `GET /admin/fx/status`. Los ejemplos de este documento se re-ejecutan en cada `pnpm test:e2e`.
