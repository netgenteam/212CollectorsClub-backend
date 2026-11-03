> **Plantilla — revisar con un abogado antes de publicar.** Borrador orientativo, no es asesoría jurídica. Venezuela no tiene una ley integral de protección de datos personales; este texto se apoya en la Constitución (arts. 28 y 60) y en la jurisprudencia aplicable, que un abogado debe verificar. Reemplaza cada marcador entre dobles corchetes, revisa cada afirmación y elimina este bloque. [[ELIMINAR_AVISO_DE_PLANTILLA]]

## Política de Privacidad y Tratamiento de Datos

Versión del borrador: [[FECHA_VERSION]].

## 1. Responsable

El responsable del tratamiento es **[[RAZON_SOCIAL]]**, RIF **[[RIF]]**, domicilio fiscal [[DOMICILIO_FISCAL]]. Contacto para temas de privacidad: [[EMAIL_CONTACTO]] · [[TELEFONO]].

## 2. Qué datos recopilamos

- **Cuenta:** nombre, correo electrónico y contraseña (la contraseña se guarda con un algoritmo de hash, nunca en claro).
- **Compra y envío:** nombre y teléfono del destinatario, dirección, agencia de envío, y número de **cédula o RIF** del comprador y/o del destinatario (obligatorio para facturar y despachar). [[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]]
- **Pago:** datos del pedido y, si pagas por Pago Móvil, el **comprobante** que subas. Si pagas con tarjeta, los datos de la tarjeta los recibe Stripe; la Tienda no los guarda.
- **Sesión:** dirección IP y agente de usuario (navegador) asociados a tu sesión iniciada, por seguridad.
- **Contacto:** los mensajes que nos envías por el formulario.
- **Aceptaciones:** versión de los documentos que aceptas, fecha y hora, y tu declaración de mayoría de edad. [[CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO]] [[CONFIRMAR_DECLARACION_DE_MAYORIA_DE_EDAD_IMPLEMENTADA]]
- **Navegación:** cookies descritas en la [Política de Cookies](/cookies) y un contador anónimo de vistas de producto (sección 8).
- **Almacenamiento local de tu navegador:** el sitio guarda en tu propio dispositivo (`localStorage`, no en cookies) las miniaturas del carrito, los productos guardados y tu libreta de direcciones, que incluye nombre, teléfono, dirección y la cédula del destinatario **sin cifrar**. Esos datos permanecen en tu dispositivo hasta que los borres desde tu navegador. Más detalles en la [Política de Cookies](/cookies). [[CONFIRMAR_CEDULA_EN_ALMACENAMIENTO_LOCAL_DEL_NAVEGADOR]]

## 3. Para qué los usamos y con qué base

| Finalidad | Base |
|---|---|
| Crear y gestionar tu cuenta y tus pedidos, cobrar, enviar | Ejecución del contrato |
| Facturar y cumplir obligaciones fiscales y contables | Obligación legal |
| Seguridad, prevención de fraude y de accesos indebidos | Interés legítimo |
| Responder tus consultas | Tu solicitud |
| Probar tu aceptación de los términos | Interés legítimo y obligación de conservar prueba [[CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO]] |

No vendemos tus datos personales ni los usamos para publicidad de terceros.

## 4. Con quién los compartimos

Solo con quienes necesitamos para prestar el servicio: la pasarela de pago (Stripe, cuando esté habilitada), las agencias de encomienda que entregan tu pedido ([[LISTA_DE_AGENCIAS]]), el proveedor de correo transaccional ([[PROVEEDOR_CORREO]]), el proveedor de alojamiento ([[HOSTING]]) y, en su caso, nuestro contador o imprenta digital para la facturación ([[CONTADOR_O_IMPRENTA]]). También podemos comunicar datos a autoridades cuando la ley lo exija.

## 5. Transferencias internacionales

Algunos de esos proveedores (por ejemplo, Stripe o el alojamiento) pueden tratar datos fuera de Venezuela. [[CONFIRMAR_UBICACION_DE_PROVEEDORES]]

## 6. Cédula y datos de facturación

El número de cédula o RIF es obligatorio en la factura y en el despacho. Se guarda **cifrado** en los pedidos, se muestra **enmascarado** en pantalla y en las comunicaciones, y solo personal autorizado de la Tienda puede verlo completo, quedando registro de cada consulta. [[CONFIRMAR_REGISTRO_DE_CONSULTAS_DE_CEDULA_IMPLEMENTADO]] En los pedidos se **conserva durante el plazo que exija la normativa fiscal** ([[PLAZO_CONSERVACION_FISCAL]]) aunque cierres tu cuenta, porque forma parte del soporte de la factura. [[CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA]] [[CONFIRMAR_RETENCION_FISCAL_DE_CEDULA_IMPLEMENTADA]]

## 7. Cuánto tiempo los conservamos

- Cuenta y libreta de direcciones: mientras mantengas la cuenta.
- Pedidos y datos de factura: durante el plazo fiscal indicado arriba.
- Sesiones (IP y agente): mientras dure la sesión; se eliminan al cerrar sesión y, si la sesión vence sin cerrarla, al vencer. [[CONFIRMAR_BORRADO_DE_SESIONES_VENCIDAS_IMPLEMENTADO]]
- Mensajes de contacto: [[PLAZO_CONSERVACION_CONTACTO]].
- Carritos y listas de deseos anónimos: el identificador que los asocia a tu navegador dura 30 días con renovación; los registros vencidos se eliminan. [[CONFIRMAR_BORRADO_DE_CARRITOS_Y_LISTAS_ANONIMOS_VENCIDOS_IMPLEMENTADO]]
- Comprobantes de pago: [[PLAZO_CONSERVACION_COMPROBANTES]].

## 8. Contador de vistas de producto

Cuando ves un producto, el sitio puede enviar una señal para sumar una vista a un contador agregado por producto y por día. Esa señal **no usa cookies ni identificadores**, no guarda tu dirección IP ni te identifica, y solo sirve para ordenar la vitrina. **Respetamos Global Privacy Control (GPC) y Do Not Track (DNT)**: si tu navegador los emite, no se envía ni se cuenta. [[CONFIRMAR_CON_ABOGADO_QUE_NO_REQUIERE_CONSENTIMIENTO]]

## 9. Tus derechos

Conforme al artículo 28 de la Constitución puedes solicitar **acceso, rectificación y supresión** de tus datos, y oponerte a ciertos usos, escribiendo a [[EMAIL_CONTACTO]] desde el correo de tu cuenta. Podremos conservar los datos que la ley nos obligue a mantener (sección 6). Responderemos en un plazo razonable: [[PLAZO_RESPUESTA_DERECHOS]].

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
