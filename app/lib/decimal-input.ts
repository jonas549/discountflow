// Lectura de importes tecleados por el merchant.
//
// 🔴 Vive aquí y NO en tiered-calc.ts a propósito: ese módulo se compila dentro
//    del Wasm de la Function, y esto es exclusivamente de la interfaz. Meterlo
//    allí obligaría a redesplegar la Function para arreglar un input.
//
// El problema que resuelve, y por qué no basta con `Number(e.target.value)`:
//
// Un `<input type="number">` CONTROLADO destruye lo tecleado en cuanto aparece
// el separador decimal. El DOM sanea el valor: si el contenido no es un número
// válido —y "10." no lo es, porque está a medio escribir— `.value` devuelve
// CADENA VACÍA. Entonces `Number("")` da 0, el estado se pone a 0, React
// reescribe el input a "0", y los dígitos siguientes se acumulan encima:
//
//     tecleado 10.50  →  quedaba 50
//     tecleado 5.5    →  quedaba 5
//     tecleado 12.34  →  quedaba 34
//
// No era un artefacto de tecleo rápido: el separador nunca llegaba a entrar.
//
// Además, `type="number"` no acepta la coma como separador en la mayoría de
// navegadores con locale en-US, y en español se escribe 10,50. Los merchants de
// LATAM y España van a teclear coma.
//
// La solución es un input de TEXTO con un buffer: se conserva exactamente lo que
// el merchant escribió —incluido el estado intermedio "10," — y se parsea con
// tolerancia. Ver `DecimalInput` en TieredCampaignForm.tsx.

/**
 * Convierte lo tecleado en un número, o `null` si todavía no es uno.
 *
 * `null` NO es un error: es "sigue escribiendo". El llamador conserva el último
 * valor bueno y deja el texto intacto, que es lo que permite escribir un
 * separador sin que el campo se borre.
 *
 * Acepta coma y punto indistintamente: en español se escribe 10,50.
 *
 *   "10.50" → 10.5      "10,50" → 10.5
 *   "10."   → 10        "10,"   → 10     (a medio escribir, pero ya vale 10)
 *   ".5"    → 0.5       ",5"    → 0.5    (sin el cero de delante)
 *   ""      → 0         (campo vacío = sin descuento en este nivel)
 *   "."     → null      "abc" → null     "1,2,3" → null      "-5" → null
 */
export function parseDecimalInput(raw: string): number | null {
  const s = raw.trim().replace(/,/g, ".");

  if (s === "") return 0;

  // Un solo separador. Los dígitos de delante y de detrás son opcionales: "10."
  // es el estado normal a mitad de tecleo, y ".5" es como mucha gente escribe
  // medio peso. El separador suelto lo descarta el `isFinite` de abajo, porque
  // `Number(".")` es NaN.
  if (!/^\d*(\.\d*)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Número → texto para mostrar en el campo.
 *
 * Se usa solo cuando el valor cambia desde FUERA del input (cambiar de unidad,
 * quitar un nivel, abrir una campaña para editarla). Mientras el merchant
 * escribe manda su buffer, o se le borraría la coma en cada pulsación.
 *
 * Sale con punto, que es lo que el propio parser vuelve a aceptar; la coma es
 * una comodidad de entrada, no un formato de salida.
 */
export function formatDecimalInput(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}
