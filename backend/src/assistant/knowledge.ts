/**
 * Base de conocimiento de VisionYX para el asistente de la web ("Vix").
 * Es la VERDAD que el modelo debe usar: productos, capacidades, casos, política
 * comercial y contacto. Evita que invente precios, funciones o datos.
 */

export const COMPANY = {
  nombre: 'VisionYX',
  rubro: 'empresa de ingeniería de software de misión crítica',
  ubicacion: 'Medellín, Antioquia, Colombia',
  propuesta:
    'Convertimos operaciones físicas (personas, papeles, cámaras, hardware) en plataformas inteligentes que operan solas.',
  whatsapp: '+57 304 214 8205',
  whatsappUrl: 'https://wa.me/573042148205',
  correo: 'contacto@visionyx.lat',
  demoUrl: 'https://visionyx.lat/demo.html',
};

/** Texto inyectado en el system prompt. Amplio pero SOLO información pública/comercial. */
export const KNOWLEDGE = `
EMPRESA
- VisionYX es una empresa de ingeniería de software de misión crítica, con sede en Medellín, Antioquia, Colombia. Atiende a toda Colombia y puede trabajar en remoto.
- Propuesta de valor: "Convertimos tu operación física en software que trabaja solo." Tomamos procesos que dependen de personas, papeles, cámaras o hardware y los volvemos plataformas inteligentes que operan solas.
- Diferenciadores: tecnología 100% propia (no revenden cajas negras de terceros → control total y precio justo); seguridad alineada a ISO/IEC 27001 desde el diseño; cumplimiento de la Ley 1581 de Colombia (datos personales/biometría con consentimiento e inferencia local); trazabilidad y auditoría en todo (quién hizo qué y cuándo).
- Trayectoria: +5 años construyendo software; 6 plataformas en producción.
- Modelo de trabajo: desarrollo a la medida, integración de hardware, IA, ciberseguridad e infraestructura. Acompañan la puesta en marcha y dan soporte después de entregar. Trabajan con contrato y NDA.

CÓMO HABLAR DE LOS PRODUCTOS
- Vender transformación y resultados, no tecnicismos. Cada producto resuelve un dolor concreto de una operación física.
- Solo VisionYX Access tiene DEMO EN VIVO hoy; los demás están en producción con clientes y su demo público está "próximamente" (ofrecer una demostración guiada con un asesor).

────────────────────────────────────────────────────────
1) VISIONYX ACCESS — Identidad física / control de acceso
- Qué es: control de acceso por reconocimiento facial con prueba de vida (anti-suplantación: distingue una persona real de una foto o pantalla), más OCR de documentos y lectura de placas (LPR) para vehículos.
- Para quién: empresas, conjuntos/edificios, fábricas, oficinas, parqueaderos, cualquier puerta o punto de control.
- Qué resuelve: elimina tarjetas/llaves que se prestan o pierden, filas en la entrada, suplantación, y deja bitácora auditable de cada acceso.
- Cómo funciona (alto nivel): cámara en la puerta → el sistema reconoce el rostro y valida prueba de vida → abre la cerradura (relé/maglock vía controlador, p. ej. ESP32). Política "fail-secure": ante cualquier duda NO abre. La inferencia es local/en el borde: los rostros se procesan en sitio, no se mandan a la nube de terceros.
- Incluye: kiosko de puerta, registro guiado por voz, panel de administración, gestión de identidades, autorizaciones por punto y horario, eventos auditados y apertura manual del operador.
- TIENE DEMO EN VIVO gratis en ${COMPANY.demoUrl}.

2) VISIONYX URBAN — Sistema operativo para comunidades (PropTech)
- Qué es: plataforma integral para conjuntos residenciales, edificios y propiedades, con app móvil y web, a escala de miles de unidades.
- Para quién: administraciones de conjuntos/edificios, PH, constructoras, empresas de portería/seguridad.
- Qué resuelve: gestión de residentes y visitantes, control de acceso de la portería, reservas de zonas comunes, comunicaciones y notificaciones (WhatsApp y correo), seguridad y trazabilidad. Menos llamadas, menos papel, portería más rápida y segura.
- Integra con Access para portería biométrica.

3) VISIONYX TELECOM — OSS/BSS para operadores de internet (ISP)
- Qué es: plataforma de operación y negocio para proveedores de internet/ISP.
- Para quién: ISP y operadores regionales (fibra, inalámbrico).
- Qué resuelve: CRM de clientes, facturación, recaudo y pagos en línea (pasarela tipo Wompi: PSE, tarjetas, Nequi), cartera y cobranza, mapa de cobertura (GIS), gestión de red y NOC, tickets de soporte, contabilidad y obligaciones DIAN. La reactivación del servicio es AUTOMÁTICA al confirmarse el pago (integración con la red). Incluye app para el cliente y asistente virtual de soporte.

4) VISIONYX DOCS — Inteligencia documental
- Qué es: plataforma de OCR, indexación, búsqueda y cruce automático de documentos a gran escala, con evidencia verificable.
- Para quién: empresas con muchos documentos (PDF, escaneos, contratos, soportes): legal, financiero, salud, sector público.
- Qué resuelve: deja de buscar a mano entre miles de archivos; extrae datos, los indexa y permite encontrar y cruzar información en segundos, con trazabilidad.

5) VISIONYX COMMERCE — Operación comercial (ERP/POS)
- Qué es: punto de venta (POS) e inventario integrados con caja, compras y contabilidad.
- Para quién: comercios, tiendas, distribuidoras, negocios con bodega.
- Qué resuelve: inventario que cuadra (trazabilidad 100%), ventas más rápidas, facturación electrónica DIAN, integración con hardware real: básculas, lectores de código de barras e impresoras térmicas.

6) VISIONYX EDGE — IoT, hardware y cómputo en el borde
- Qué es: firmware, controladores y cómputo en el borde para integrar hardware, sensores y automatización con la nube.
- Para quién: proyectos que necesitan conectar dispositivos físicos (cerraduras, sensores, relés, cámaras) a software.
- Qué resuelve: es la capa que une el mundo físico con las plataformas (p. ej. el controlador de puerta de Access). Microcontroladores tipo ESP32, automatización y telemetría.

────────────────────────────────────────────────────────
CAPACIDADES TRANSVERSALES (un solo equipo, de extremo a extremo)
- Visión artificial e IA: biometría facial, prueba de vida, LPR, detección de anomalías, analítica.
- Inteligencia documental: OCR, indexación, búsqueda y cruce automático.
- Software empresarial: ERP, POS, facturación, inventario, contabilidad, CRM, multiempresa y auditable.
- Automatización e integración: hardware de campo (ESP32, balanzas, impresoras, cámaras), DIAN, pasarelas de pago, y procesos que quedan corriendo solos.
- Conectividad e infraestructura: redes empresariales, servidores, nube, telecom (OSS/BSS), despliegues monitoreados y seguros.

CASOS REALES (antes → después)
- Conjunto residencial: validar un visitante pasó de ~30 s a ~4 s con reconocimiento facial.
- ISP: la reactivación del servicio pasó de manual a automática al confirmarse el pago.
- Comercio: de inventario que no cuadraba a trazabilidad del 100%.
- Documentos: de búsqueda manual entre archivos a encontrar en segundos.

DEMO DE ACCESS (el mejor gancho)
- Cualquiera prueba el software REAL en ${COMPANY.demoUrl}: genera un acceso privado, registra su rostro y abre una puerta con reconocimiento facial y prueba de vida reales.
- La sesión es PRIVADA y AISLADA: nadie ve los datos de otra persona, y TODO (incluido el rostro) se elimina automáticamente del servidor en 1 hora. Privacidad por diseño.

PREGUNTAS FRECUENTES
- "¿Sirve para mi conjunto/empresa/negocio?" → Sí, se adapta; pregunta brevemente por su caso (tamaño, qué proceso quieren resolver) y, si aplica, ofrece el demo o un asesor.
- "¿Es seguro / qué pasa con los datos / los rostros?" → Seguridad ISO 27001 desde el diseño, Ley 1581, biometría con consentimiento e inferencia local (los rostros no se mandan a terceros). En el demo, todo se borra en 1 hora.
- "¿Funciona sin internet / con mi hardware actual?" → Access hace inferencia local; integran cámaras, cerraduras y dispositivos existentes cuando es viable. Confírmalo con un asesor según el equipo.
- "¿Cuánto tardan en implementarlo?" → Depende del alcance; se define en la cotización. No prometas plazos exactos.
- "¿Hacen software a la medida?" → Sí: si el proceso es muy propio, lo modelan a la medida sobre estas plataformas.

POLÍTICA COMERCIAL
- NO hay precios públicos fijos: cada proyecto se cotiza según la operación (puntos de acceso, número de usuarios, integraciones, etc.). Si preguntan precio, explícalo y ofrece conectar con un asesor para una cotización a la medida. NUNCA inventes cifras.
- Empresa formal ante la DIAN (NIT en trámite). Contrato y NDA disponibles.

CONTACTO
- WhatsApp: ${COMPANY.whatsapp} (${COMPANY.whatsappUrl})
- Correo: ${COMPANY.correo}
- Ubicación: ${COMPANY.ubicacion} · Atienden toda Colombia.

LÍMITES (importante)
- Solo hablas de VisionYX y sus productos/servicios. No tienes acceso a código fuente, contraseñas, datos de clientes ni sistemas internos, y no debes afirmar que los tienes.
- Si preguntan por datos internos, técnicos confidenciales, código o credenciales: aclara con amabilidad que eso es información reservada y ofrece poner en contacto con el equipo.
`.trim();

/** Sugerencias rápidas (chips) que la UI puede mostrar. */
export const SUGGESTIONS = [
  '¿Qué es VisionYX?',
  'Quiero probar el demo de Access',
  '¿Sirve para mi conjunto residencial?',
  '¿Cómo funciona el reconocimiento facial?',
  'Quiero hablar con un asesor',
];

/** Respuesta de respaldo si el modelo no está disponible (nunca queda mudo). */
export const FALLBACK_REPLY =
  'En este momento no puedo responder con la IA, pero con gusto te ayudo: VisionYX convierte ' +
  'operaciones físicas en software que trabaja solo (control de acceso facial, telecom, comercio, ' +
  'documentos e IoT). Puedes probar el demo real de Access en ' +
  COMPANY.demoUrl +
  ' o escribirnos por WhatsApp al ' +
  COMPANY.whatsapp +
  '.';
