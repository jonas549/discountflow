// Aviso de la pantalla de editar: parte de la selección guardada no volvió de
// Shopify. Antes la lista quedaba vacía sin decir nada y parecía que la campaña
// no tenía colección ni productos.
export function SeleccionFaltanteBanner({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div
      role="alert"
      data-testid="seleccion-faltante"
      style={{
        background: "#fff8e1",
        border: "1px solid #f9a825",
        borderRadius: 8,
        padding: "12px 16px",
        margin: "12px 0",
        fontSize: 14,
        color: "#5c4400",
      }}
    >
      <strong>
        No se {count === 1 ? "pudo cargar 1 elemento guardado" : `pudieron cargar ${count} elementos guardados`} de
        esta campaña.
      </strong>
      <div style={{ marginTop: 4 }}>
        Puede ser un fallo momentáneo de Shopify o que ya no existan en la tienda. Recarga la página antes de
        guardar: lo que no aparece en pantalla no se incluye al guardar una selección nueva.
      </div>
    </div>
  );
}
