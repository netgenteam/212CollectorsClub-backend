> **Plantilla — revisar con un abogado antes de publicar.** Borrador orientativo, no es asesoría jurídica. Venezuela no tiene una ley integral de protección de datos personales; este texto se apoya en la Constitución (arts. 28 y 60) y en la jurisprudencia aplicable, que un abogado debe verificar. Reemplaza cada marcador entre dobles corchetes, revisa cada afirmación y elimina este bloque. [[ELIMINAR_AVISO_DE_PLANTILLA]]

## Política de Privacidad y Tratamiento de Datos

Versión del borrador: [[FECHA_VERSION]].

## 1. Responsable

El responsable del tratamiento es **[[RAZON_SOCIAL]]**, RIF **[[RIF]]**, domicilio fiscal [[DOMICILIO_FISCAL]]. Contacto para temas de privacidad: [[EMAIL_CONTACTO]] · [[TELEFONO]].

## 2. Qué datos recopilamos

- **Cuenta:** nombre, correo electrónico y contraseña (la contraseña se guarda con un algoritmo de hash, nunca en claro).
- **Libreta de direcciones de tu cuenta:** si guardas direcciones en tu cuenta, guardamos en nuestros servidores el nombre, el teléfono, la dirección, la agencia de envío y la cédula del destinatario (esta última **cifrada**). [[CONFIRMAR_LIBRETA_DE_DIRECCIONES_EN_SERVIDOR]]
- **Compra y envío:** nombre y teléfono del destinatario, dirección, agencia de envío, y número de **cédula o RIF** del comprador y/o del destinatario (obligatorio para facturar y despachar [[CONFIRMAR_CHECKOUT_REQUIRE_SHIPPING_ACTIVO_PARA_CEDULA_OBLIGATORIA]]). [[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]]
- **Datos de facturación del comprador:** el **nombre o razón social** y el número de **cédula o RIF** con que se emite la factura. Pueden ser los del destinatario o, si compras para otra persona o a nombre de una empresa, los de quien paga; el número se guarda **cifrado** igual que el del destinatario. [[CONFIRMAR_DATOS_DE_FACTURACION_DEL_COMPRADOR_IMPLEMENTADOS]]
- **Pago:** datos del pedido y, si pagas por Pago Móvil, el **comprobante** que subas. Si pagas con tarjeta, los datos de la tarjeta los recibe Stripe; la Tienda no los guarda.
- **Sesión:** dirección IP y agente de usuario (navegador) asociados a tu sesión iniciada, por seguridad.
- **Registro de auditoría (inmutable):** cuando realizas ciertas acciones (registrarte, aceptar o volver a aceptar los documentos legales, comprar —también como invitado— o restablecer tu contraseña) el sistema escribe un evento en un registro que **no se puede modificar ni borrar** y que guarda, junto con la fecha y el tipo de acción, tu **dirección IP** y, si tienes cuenta, el identificador interno de tu cuenta. No guarda tu correo, teléfono ni cédula. [[CONFIRMAR_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]
- **Registro de uso (7 días):** por seguridad y para diagnosticar fallos, el servidor anota cada petición que recibe: la fecha y hora, el tipo de petición y la **ruta genérica** de la función (por ejemplo, «consulta de pedido», nunca el número del pedido ni lo que aparezca después del signo de interrogación de la dirección web), el resultado, cuánto tardó, tu **dirección IP**, el **agente de usuario** de tu navegador (recortado) y, si tienes sesión iniciada, el identificador interno de tu cuenta. **No** guarda lo que escribes en los formularios, contraseñas, cookies, claves, correo, teléfono ni cédula. Los intentos fallidos de inicio de sesión de clientes solo quedan en este registro. [[CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO]] [[CONFIRMAR_CON_ABOGADO_BASE_LEGAL_DEL_REGISTRO_DE_USO]]
- **Contacto:** los mensajes que nos envías por el formulario.
- **Aceptaciones:** versión de los documentos que aceptas, fecha y hora, y tu declaración de mayoría de edad. [[CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO]] [[CONFIRMAR_DECLARACION_DE_MAYORIA_DE_EDAD_IMPLEMENTADA]]
- **Navegación:** cookies descritas en la [Política de Cookies](/cookies) y un contador anónimo de vistas de producto (sección 8).
- **Almacenamiento local de tu navegador:** el sitio guarda en tu propio dispositivo (`localStorage`, no en cookies) solo las miniaturas del carrito y los identificadores de tus productos guardados. **Ya no guarda tu libreta de direcciones ni ninguna cédula**: tus direcciones viven en nuestros servidores (arriba). Las versiones anteriores del sitio sí guardaban en el navegador la libreta, con la cédula del destinatario **sin cifrar**; la versión actual **borra esos datos del navegador** la primera vez que lo abres y, si había direcciones guardadas, te avisa para que las vuelvas a añadir en tu cuenta. Más detalles en la [Política de Cookies](/cookies). [[CONFIRMAR_CEDULA_EN_ALMACENAMIENTO_LOCAL_DEL_NAVEGADOR]]

## 3. Para qué los usamos y con qué base

| Finalidad | Base |
|---|---|
| Crear y gestionar tu cuenta y tus pedidos, cobrar, enviar | Ejecución del contrato |
| Facturar y cumplir obligaciones fiscales y contables | Obligación legal |
| Seguridad, prevención de fraude y de accesos indebidos (incluye el registro de uso) | Interés legítimo |
| Responder tus consultas | Tu solicitud |
| Probar tu aceptación de los términos | Interés legítimo y obligación de conservar prueba [[CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO]] |

No vendemos tus datos personales ni los usamos para publicidad de terceros.

## 4. Con quién los compartimos

Solo con quienes necesitamos para prestar el servicio: la pasarela de pago (Stripe, cuando esté habilitada), las agencias de encomienda que entregan tu pedido ([[LISTA_DE_AGENCIAS]]), el proveedor de correo transaccional ([[PROVEEDOR_CORREO]]), el proveedor de alojamiento ([[HOSTING]]) y, en su caso, nuestro contador o imprenta digital para la facturación ([[CONTADOR_O_IMPRENTA]]). También podemos comunicar datos a autoridades cuando la ley lo exija.

## 5. Transferencias internacionales

Algunos de esos proveedores (por ejemplo, Stripe o el alojamiento) pueden tratar datos fuera de Venezuela. [[CONFIRMAR_UBICACION_DE_PROVEEDORES]]

## 6. Cédula y datos de facturación

El número de cédula o RIF es obligatorio en la factura y en el despacho. Se guarda **cifrado** en los pedidos, se muestra **enmascarado** en pantalla y en las comunicaciones, y solo personal autorizado de la Tienda puede verlo completo, quedando registro de cada consulta. [[CONFIRMAR_REGISTRO_DE_CONSULTAS_DE_CEDULA_IMPLEMENTADO]] En los pedidos anteriores a la introducción del cifrado puede subsistir, **temporalmente y con acceso restringido**, una copia antigua de ese número **sin cifrar**, además de la cifrada; la retiraremos en una fase posterior de migración que aún no se ha completado (los pedidos nuevos solo la guardan cifrada). En los pedidos se **conserva durante el plazo que exija la normativa fiscal** ([[PLAZO_CONSERVACION_FISCAL]]) aunque cierres tu cuenta, porque forma parte del soporte de la factura. [[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]] [[CONFIRMAR_RETENCION_FISCAL_DE_CEDULA_IMPLEMENTADA]]

## 7. Cuánto tiempo los conservamos

- Cuenta: mientras la mantengas. Si pides cerrarla, se **anonimiza** (sección 9): se borran tus credenciales, sesiones, libreta de direcciones de la cuenta, carrito, lista de deseos y enlaces pendientes; se conservan los pedidos y sus soportes fiscales, los mensajes de contacto (según el plazo de abajo) y el registro de auditoría. [[CONFIRMAR_BORRADO_DE_CUENTA_IMPLEMENTADO]]
- Libreta de direcciones de tu cuenta (sección 2): en nuestros servidores, **cifrada** la cédula, hasta que cierres la cuenta; se borra cuando la cierras (sección 9). Las miniaturas del carrito y los productos guardados que están en el almacenamiento local de tu navegador no están en nuestros servidores y permanecen hasta que los borres desde tu navegador. [[CONFIRMAR_LIBRETA_DE_DIRECCIONES_EN_SERVIDOR]]
- Pedidos y datos de factura (incluidos el nombre o razón social y la cédula o RIF del comprador y del destinatario; de todos esos datos **solo la cédula o RIF se guarda cifrada**): durante el plazo fiscal indicado arriba ([[PLAZO_CONSERVACION_FISCAL]]). No se borran por una purga automática ni al cerrar tu cuenta.
- Sesiones (IP y agente): la sesión vencida se elimina 7 días después de vencer, y la IP y el agente de usuario se anulan a los 90 días de creada la sesión (una sesión todavía activa no se toca). [[CONFIRMAR_BORRADO_DE_SESIONES_VENCIDAS_IMPLEMENTADO]]
- Mensajes de contacto: [[PLAZO_CONSERVACION_CONTACTO]]. Cerrar tu cuenta **no** los borra (pueden formar parte de un reclamo o una disputa); siguen este mismo plazo.
- Registro de uso (incluida la dirección IP y el agente de usuario, sección 2): **7 días**; después se borra automáticamente. No sirve como prueba legal (para eso existe el registro de auditoría). Si cierras tu cuenta, el registro de uso de tu cuenta se borra en ese momento, pero **solo** el de las peticiones hechas con tu sesión iniciada (las únicas que llevan el identificador de tu cuenta). Las filas de las visitas **sin sesión iniciada** (las anteriores a iniciar sesión, las posteriores a cerrarla y las de cualquier visitante sin cuenta) no llevan ese identificador, solo tu dirección IP y el agente de usuario: **siguen existiendo hasta cumplirse los 7 días** y entonces se borran automáticamente; cerrar la cuenta no las adelanta. [[CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO]]
- Registro de auditoría (incluida la dirección IP de las acciones descritas en la sección 2): **para siempre**. Es un registro de seguridad y de prueba que por diseño no se modifica ni se borra, tampoco cuando cierras tu cuenta. [[CONFIRMAR_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]
- Carritos y listas de deseos anónimos: el identificador que los asocia a tu navegador dura 30 días con renovación; los registros vencidos se eliminan. [[CONFIRMAR_BORRADO_DE_CARRITOS_Y_LISTAS_ANONIMOS_VENCIDOS_IMPLEMENTADO]]
- Comprobantes de pago: [[PLAZO_CONSERVACION_COMPROBANTES]].
- Copias de seguridad de la base de datos: conservan los datos tal como estaban cuando se hicieron hasta que rotan ([[PLAZO_ROTACION_DE_COPIAS_DE_SEGURIDAD]]); las purgas y el cierre de cuenta **no** se aplican de forma retroactiva a las copias ya hechas.

## 8. Contador de vistas de producto

Cuando ves un producto, el sitio puede enviar una señal para sumar una vista a un contador agregado por producto y por día. Esa señal **no usa cookies ni identificadores**, no guarda tu dirección IP ni te identifica, y solo sirve para ordenar la vitrina. **Respetamos Global Privacy Control (GPC) y Do Not Track (DNT)**: si tu navegador los emite, no se envía ni se cuenta. [[CONFIRMAR_CON_ABOGADO_QUE_NO_REQUIERE_CONSENTIMIENTO]]

## 9. Tus derechos

Conforme al artículo 28 de la Constitución puedes solicitar **acceso, rectificación y supresión** de tus datos, y oponerte a ciertos usos, escribiendo a [[EMAIL_CONTACTO]] desde el correo de tu cuenta. Podremos conservar los datos que la ley nos obligue a mantener (sección 6). Responderemos en un plazo razonable: [[PLAZO_RESPUESTA_DERECHOS]].

**Cierre (supresión) de tu cuenta.** No es recomendable y solo lo hacemos cuando **tú** nos lo pides de forma expresa, desde el correo de tu cuenta o comprobando de otra manera que eres el titular. Es **irreversible**. **Cómo pedirlo:** por ahora no existe un botón de autoservicio en «Mi cuenta»; escribe a [[EMAIL_CONTACTO]] (o usa el formulario de contacto de la Tienda) indicando que quieres cerrar tu cuenta. Una persona autorizada de la Tienda verifica que eres el titular, te pide confirmar el correo de la cuenta y un motivo, y ejecuta el cierre; queda un registro de quién lo hizo, cuándo y con qué referencia de solicitud. [[CONFIRMAR_CANAL_DE_SOLICITUDES_DE_CIERRE_DE_CUENTA]] Si tienes pedidos que aún no terminaron (pendientes de pago o de verificación, o pagados y sin enviar), primero deben terminar o cancelarse. Al cerrarla ocurre esto:

- **Se borran de nuestros servidores:** tu contraseña y credenciales; todas tus sesiones iniciadas, que se cierran en todos tus dispositivos al instante; la libreta de direcciones de tu cuenta; tu carrito y tu lista de productos guardados; el registro de uso de tu cuenta (sección 2; solo las peticiones con sesión iniciada: el de las visitas sin sesión, identificado únicamente por la IP, se conserva hasta cumplir sus 7 días, sección 7) [[CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO]]; y los enlaces pendientes de verificación y de recuperación de contraseña.
- **Se reemplazan:** tu nombre por «Cuenta eliminada», y tu correo por una dirección inválida que no puede recibir mensajes; tu teléfono y tu imagen se borran. Tu correo original **queda libre**: si te registras otra vez con él, será una cuenta nueva, sin relación con la anterior (no recupera pedidos, listas ni aceptaciones).
- **Se conservan:** los pedidos, pagos y comprobantes de pago, con el nombre, el teléfono y la dirección de entrega (guardados en nuestra base de datos **sin cifrar**, con acceso restringido) y la cédula o RIF de la factura (**este es el único dato cifrado**), durante el plazo fiscal (sección 6); el registro de las versiones de documentos que aceptaste y la declaración de mayoría de edad (prueba legal, sección 3); los mensajes que nos enviaste por el formulario de contacto, durante el plazo de la sección 7; y el registro interno de auditoría, **que no se borra ni se anonimiza** y por eso conserva, para siempre, la dirección IP de las acciones que hiciste (sección 2), además de quién cerró la cuenta, cuándo y con qué referencia de solicitud, pero **nunca tu correo** (solo una huella irreversible con clave que permite atender una disputa). [[CONFIRMAR_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]
- **No podemos borrar desde nuestros servidores:** lo que está guardado en tu propio navegador (la libreta de direcciones, los productos guardados y las miniaturas del carrito en `localStorage`, sección 2): bórralo tú desde los ajustes de tu navegador; y las copias de seguridad, que conservan los datos hasta que rotan ([[PLAZO_ROTACION_DE_COPIAS_DE_SEGURIDAD]]). [[CONFIRMAR_BORRADO_DE_CUENTA_IMPLEMENTADO]]

## 10. Seguridad

Aplicamos medidas razonables: contraseñas con hash, cookies de sesión protegidas (httpOnly, con atributo Secure en producción), limitación de intentos de inicio de sesión, cifrado de la cédula [[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]] y acceso restringido a comprobantes. Ningún sistema es infalible; no podemos garantizar seguridad absoluta.

## 11. Menores de edad

La Tienda no está dirigida a menores sin supervisión; las compras de menores requieren a su representante legal (ver [Términos](/terminos)). Si crees que un menor nos dio datos sin autorización, escríbenos y los eliminaremos cuando la ley lo permita.

## 12. Alcance geográfico

La Tienda vende y envía dentro de Venezuela.

## 13. Cambios

Publicaremos las nuevas versiones con su fecha. Si el cambio es sustancial te lo informaremos.

## 🔗 Relacionado

[Términos](/terminos) · [Cookies](/cookies) · [Envíos](/envios) · [Aviso Legal](/aviso-legal)
