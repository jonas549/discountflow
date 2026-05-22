// Spanish (LATAM) translations. No external i18n library — single-language app.
// See DECISIONS.md for rationale.

export const es = {
  nav: {
    inicio: "Inicio",
    campanas: "Campañas",
    analiticas: "Analíticas",
    soporte: "Soporte",
  },
  dashboard: {
    titulo: "Bienvenido a DiscountFlow",
    kpi: {
      campanasActivas: "Campañas activas",
      productosEnDescuento: "Productos en descuento",
      ingresosAtribuidos: "Ingresos atribuidos",
      conversionesMes: "Conversiones del mes",
      vsUltimoMes: "vs mes anterior",
    },
    accionesRapidas: "Acciones rápidas",
    crearCampana: "Crear nueva campaña",
    verAnaliticas: "Ver analíticas",
    centroDeSoporte: "Centro de soporte",
    campanasRecientes: "Campañas recientes",
    sinCampanas:
      "Aún no tienes campañas. Crea tu primera campaña para empezar.",
    crearCTA: "Crear campaña",
  },
  campanas: {
    titulo: "Campañas",
    subtitulo: "Crea y gestiona tus campañas de descuento",
    crearSeccion: "Crear una campaña",
    tusCampanas: "Tus campañas",
    sinCampanas: "Aún no has creado campañas",
    crear: "Crear",
    masInfo: "Más información",
    proximamente: "Próximamente",
    porcentaje: {
      titulo: "Descuento por porcentaje",
      descripcion:
        "Aplica un porcentaje de descuento a productos seleccionados con precio tachado visible.",
      ejemplo: "20% de descuento en zapatos",
    },
    rango: {
      titulo: "Rango de precio",
      descripcion:
        "Establece un precio fijo promocional para productos seleccionados durante un período.",
      ejemplo: "Camisetas a $15 toda la semana",
    },
    bxgy: {
      titulo: "Compra X, lleva Y",
      descripcion:
        "Ofrece productos gratis o con descuento cuando el cliente compre cierta cantidad.",
      ejemplo: "Compra 2 camisas, lleva una gorra gratis",
    },
    tabla: {
      nombre: "Nombre",
      tipo: "Tipo",
      estado: "Estado",
      descuento: "Descuento",
      productos: "Productos",
      inicio: "Inicio",
      fin: "Fin",
      acciones: "Acciones",
    },
    acciones: {
      editar: "Editar",
      pausar: "Pausar",
      reactivar: "Reactivar",
      eliminar: "Eliminar",
      siEliminar: "Sí, eliminar",
      cancelar: "Cancelar",
      modalTitulo: "¿Eliminar campaña?",
      modalTexto: "Estás a punto de eliminar la campaña",
      modalAdvertencia:
        "Esta acción revertirá los descuentos aplicados y eliminará la campaña permanentemente. No se puede deshacer.",
    },
  },
  nuevaPorcentaje: {
    titulo: "Descuento por porcentaje",
    volver: "← Volver a campañas",
    secInfoGeneral: "1. Información general",
    secDescuento: "2. Descuento",
    secProductos: "3. Productos",
    secProgramacion: "4. Programar campaña",
    nombreLabel: "Nombre de la campaña",
    nombreHelper:
      "Este nombre te ayuda a identificar la campaña internamente",
    nombrePlaceholder: "Ej. 20% off Black Friday",
    tipoLabel: "Tipo de campaña",
    tipoPorcentaje: "Porcentaje de descuento",
    descuentoLabel: "Valor del descuento (%)",
    descuentoHelper: "Introduce un valor entre 1 y 99",
    opAvanzadas: "Opciones avanzadas",
    checkCompare:
      "Si el producto ya tiene precio comparativo, calcular el descuento sobre ese precio",
    modoLabel: "Seleccionar productos por",
    modoProductos: "Productos y variantes específicas",
    modoColecciones: "Colecciones",
    modoTags: "Tags de producto",
    modoTipo: "Tipo de producto",
    modoVendedor: "Vendedor",
    modoTienda: "Toda la tienda",
    btnSeleccionarProductos: "Seleccionar productos",
    btnSeleccionarColecciones: "Seleccionar colecciones",
    btnSeleccionarTags: "Seleccionar tags",
    btnSeleccionarVendedores: "Seleccionar vendedores",
    btnSeleccionarTipos: "Seleccionar tipos de producto",
    coleccionLabel: "Colección",
    coleccionPlaceholder: "Selecciona una colección",
    tipoProductoLabel: "Tipo de producto",
    tipoProductoPlaceholder: "Ej. Camisetas",
    vendedorLabel: "Vendedor",
    vendedorPlaceholder: "Ej. Nike",
    msgTodaTienda:
      "Se aplicará a todos los productos de la tienda.",
    excluirToggle: "Excluir productos",
    excluirHelper:
      "Excluye productos específicos que NO recibirán el descuento",
    btnExcluirProductos: "Seleccionar exclusiones",
    programarToggle: "Programar campaña",
    fechaInicioLabel: "Fecha y hora de inicio",
    fechaFinLabel: "Fecha y hora de fin (opcional)",
    msgInmediato:
      "La campaña se activa inmediatamente al guardar.",
    previewTitulo: "Vista previa del descuento",
    previewEjemplo: "Precio de ejemplo: $100.00",
    resumenTitulo: "Resumen",
    resumenNombre: "Nombre",
    resumenTipo: "Tipo",
    resumenTipoPorcentaje: "Porcentaje de descuento",
    resumenDescuento: "Descuento",
    resumenProductos: "Productos",
    resumenInicio: "Inicio",
    resumenFin: "Fin",
    resumenInmediato: "Inmediato",
    resumenSinFin: "Sin fecha de fin",
    sinDefinir: "—",
    btnCancelar: "Cancelar",
    btnBorrador: "Guardar como borrador",
    btnActivar: "Crear y activar",
    btnCargando: "Guardando...",
    errNombre: "El nombre de la campaña es requerido",
    errDescuento: "El descuento debe estar entre 1 y 99",
    errProductos: "Debes seleccionar al menos un producto",
    errFechas: "La fecha de fin debe ser posterior a la de inicio",
    productosSeleccionados: "productos seleccionados",
    productosExcluidos: "excluidos",
    fechaInicioHelper: "Sin fecha: la campaña comienza al activarse",
    fechaFinHelper: "Sin fecha: la campaña no tiene fecha de fin",
    checkCompareDesc:
      "El descuento se calcula sobre el precio tachado si el producto ya lo tiene configurado.",
  },
  nuevaBxgy: {
    titulo: "Compra X, obtén Y",
    volver: "← Volver a campañas",
    secInfoGeneral: "1. Información general",
    secCompraX: "2. ¿Qué debe comprar el cliente?",
    secRecibeY: "3. ¿Qué recibe el cliente?",
    secDescuento: "4. Descuento sobre Y",
    secProgramacion: "5. Programar campaña",
    nombreLabel: "Nombre de la campaña",
    nombreHelper: "Este nombre te ayuda a identificar la campaña internamente",
    nombrePlaceholder: "Ej. Compra 2 lleva 1 gratis - Verano",
    // X section
    xCantidadLabel: "Cantidad mínima a comprar",
    xCantidadHelper: "El cliente debe agregar al menos esta cantidad al carrito",
    // Y section
    yCantidadLabel: "Cantidad que recibe el cliente",
    yCantidadHelper: "Unidades del producto Y que se descuentan",
    modoSameAsX: "El mismo producto X",
    // Discount section
    descuentoTipoLabel: "Tipo de descuento sobre Y",
    descuentoGratis: "100% gratis",
    descuentoPorcentaje: "Porcentaje de descuento",
    descuentoValorLabel: "Valor del descuento (%)",
    descuentoValorHelper: "Introduce un valor entre 1 y 99",
    // Dates (reuse from nuevaPorcentaje)
    fechaInicioLabel: "Fecha y hora de inicio",
    fechaFinLabel: "Fecha y hora de fin (opcional)",
    fechaInicioHelper: "Sin fecha: la campaña comienza al activarse",
    fechaFinHelper: "Sin fecha: la campaña no tiene fecha de fin",
    // Preview panel
    previewTitulo: "Vista previa del beneficio",
    previewCompra: "Compra",
    previewDe: "de",
    previewLleva: "Lleva",
    previewGratis: "GRATIS",
    previewOff: "OFF",
    previewProductoX: "producto seleccionado",
    previewProductoY: "producto seleccionado",
    // Summary
    resumenTitulo: "Resumen",
    resumenNombre: "Nombre",
    resumenTipo: "Tipo",
    resumenTipoBxgy: "Compra X, obtén Y",
    resumenCompra: "Compra",
    resumenRecibe: "Recibe",
    resumenDescuento: "Descuento",
    resumenInicio: "Inicio",
    resumenFin: "Fin",
    resumenInmediato: "Inmediato",
    resumenSinFin: "Sin fecha de fin",
    sinDefinir: "—",
    // Buttons
    btnCancelar: "Cancelar",
    btnBorrador: "Guardar como borrador",
    btnActivar: "Crear y activar",
    btnCargando: "Guardando...",
    // Errors
    errNombre: "El nombre de la campaña es requerido",
    errXProductos: "Debes seleccionar al menos un producto para la sección Compra X",
    errYProductos: "Debes seleccionar al menos un producto para la sección Recibe Y",
    errXCantidad: "La cantidad mínima debe ser al menos 1",
    errYCantidad: "La cantidad recibida debe ser al menos 1",
    errDescuentoValor: "El descuento debe estar entre 1 y 99",
    errFechas: "La fecha de fin debe ser posterior a la de inicio",
    // Shared selection strings (reuse from nuevaPorcentaje)
    modoLabel: "Seleccionar productos por",
    modoProductos: "Productos específicos",
    modoColecciones: "Colecciones",
    modoTags: "Tags de producto",
    modoVendedor: "Vendedor",
    modoTipo: "Tipo de producto",
    modoTienda: "Toda la tienda",
    btnSeleccionarProductos: "Seleccionar productos",
    btnSeleccionarColecciones: "Seleccionar colecciones",
    btnSeleccionarTags: "Seleccionar tags",
    btnSeleccionarVendedores: "Seleccionar vendedores",
    btnSeleccionarTipos: "Seleccionar tipos de producto",
    msgTodaTienda: "Se aplicará a todos los productos de la tienda.",
    excluirToggle: "Excluir productos de X",
    excluirHelper: "Excluye productos específicos que NO activarán la regla",
    btnExcluirProductos: "Seleccionar exclusiones",
    // Tooltip for BXGY campaigns in table
    tooltipGestionado: "Este descuento se gestiona desde DiscountFlow. Evita editarlo directamente desde la sección Descuentos de Shopify.",
  },
  editarBxgy: {
    titulo: "Editar campaña Compra X, obtén Y",
    btnGuardar: "Guardar cambios",
    btnCargando: "Guardando...",
    reemplazarSeleccion: "Reemplazar selección",
  },
  editarPorcentaje: {
    titulo: "Editar campaña",
    btnGuardar: "Guardar cambios",
    btnCargando: "Guardando...",
    productosActuales: "productos configurados actualmente",
    reemplazarSeleccion: "Reemplazar selección",
  },
  nuevaRango: {
    titulo: "Rango de precio",
    volver: "← Volver a campañas",
    secInfoGeneral: "1. Información general",
    secPrecio: "2. Precio promocional",
    secProductos: "3. Productos",
    secProgramacion: "4. Programar campaña",
    nombreLabel: "Nombre de la campaña",
    nombreHelper: "Este nombre te ayuda a identificar la campaña internamente",
    nombrePlaceholder: "Ej. Camisetas a $15 esta semana",
    tipoDescuentoLabel: "Tipo de descuento",
    modoFijo: "Precio fijo nuevo",
    modoMonto: "Monto fijo de descuento",
    valorLabel: "Valor",
    helperFijo: "Todos los productos pasarán a costar este precio",
    helperMonto: "Se restará este monto al precio actual de cada producto",
    previewTitulo: "Vista previa del descuento",
    previewEjemplo: "Precio de ejemplo: $50.00",
    previewPendiente: "Ingresa un modo y valor para ver la vista previa",
    previewNota: "Productos no elegibles serán omitidos automáticamente al activar",
    resumenTitulo: "Resumen",
    resumenNombre: "Nombre",
    resumenTipo: "Tipo",
    resumenTipoRango: "Rango de precio",
    resumenModo: "Modo",
    resumenValor: "Valor",
    resumenProductos: "Productos",
    resumenInicio: "Inicio",
    resumenFin: "Fin",
    resumenInmediato: "Inmediato",
    resumenSinFin: "Sin fecha de fin",
    sinDefinir: "—",
    btnCancelar: "Cancelar",
    btnBorrador: "Guardar como borrador",
    btnActivar: "Crear y activar",
    btnCargando: "Guardando...",
    errNombre: "El nombre de la campaña es requerido",
    errValor: "El valor debe ser mayor a 0",
    errProductos: "Debes seleccionar al menos un producto",
    errFechas: "La fecha de fin debe ser posterior a la de inicio",
    productosSeleccionados: "productos seleccionados",
    fechaInicioLabel: "Fecha y hora de inicio",
    fechaFinLabel: "Fecha y hora de fin (opcional)",
    fechaInicioHelper: "Sin fecha: la campaña comienza al activarse",
    fechaFinHelper: "Sin fecha: la campaña no tiene fecha de fin",
    msgTodaTienda: "Se aplicará a todos los productos de la tienda.",
    excluirToggle: "Excluir productos",
    excluirHelper: "Excluye productos específicos que NO recibirán el descuento",
    btnExcluirProductos: "Seleccionar exclusiones",
    skippedBanner: (n: number) =>
      `⚠️ ${n} producto${n !== 1 ? "s" : ""} no recibió el descuento porque su precio original es menor o igual al precio nuevo.`,
  },
  editarRango: {
    titulo: "Editar campaña Rango de precio",
    btnGuardar: "Guardar cambios",
    btnCargando: "Guardando...",
    productosActuales: "productos configurados actualmente",
    reemplazarSeleccion: "Reemplazar selección",
  },
  analytics: {
    titulo: "Analíticas",
    subtitulo: "Rendimiento de campañas",
    proximamente:
      "Las analíticas detalladas estarán disponibles próximamente. Crea y activa campañas para comenzar a ver datos.",
  },
  soporte: {
    titulo: "Soporte",
    necesitasAyuda: "¿Necesitas ayuda?",
    descripcion:
      "Nuestro equipo está disponible para ayudarte a configurar y optimizar tus campañas de descuento.",
    contactar: "Contactar soporte",
    recursos: "Recursos",
    guiaInicio: "Guía de inicio",
    tiposCampanas: "Tipos de campañas explicados",
    faq: "Preguntas frecuentes",
  },
};

export function estadoLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: "Borrador",
    ACTIVE: "Activa",
    PAUSED: "Pausada",
    COMPLETED: "Finalizada",
    CANCELLED: "Cancelada",
  };
  return map[status] ?? status;
}

export function tipoLabel(type: string): string {
  const map: Record<string, string> = {
    PERCENTAGE: "Porcentaje",
    RANGE: "Rango de precio",
    BXGY: "Compra X, obtén Y",
  };
  return map[type] ?? type;
}

export function estadoColor(
  status: string
): "success" | "warning" | "critical" | "info" | "new" {
  const map: Record<
    string,
    "success" | "warning" | "critical" | "info" | "new"
  > = {
    ACTIVE: "success",
    DRAFT: "info",
    PAUSED: "warning",
    COMPLETED: "new",
    CANCELLED: "critical",
  };
  return map[status] ?? "info";
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
