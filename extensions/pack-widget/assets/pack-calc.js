/* GENERADO — NO EDITAR A MANO.
 * Fuente: app/lib/discounts/pack-calc.ts
 * Regenerar: npm run build:pack-widget
 * Editar este archivo crea una segunda fuente de verdad del cálculo y
 * el precio del widget dejaría de coincidir con el del checkout.
 */
"use strict";
var DiscountFlowPackCalc = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // app/lib/discounts/pack-calc.ts
  var pack_calc_exports = {};
  __export(pack_calc_exports, {
    MAX_PACK_CATALOG: () => MAX_PACK_CATALOG,
    MAX_PACK_PERCENT: () => MAX_PACK_PERCENT,
    MAX_PACK_TIERS: () => MAX_PACK_TIERS,
    MIN_PACK_PERCENT: () => MIN_PACK_PERCENT,
    MIN_PACK_PRODUCTS: () => MIN_PACK_PRODUCTS,
    buildPackPreview: () => buildPackPreview,
    computePack: () => computePack,
    normalizePackCatalog: () => normalizePackCatalog,
    normalizePackTiers: () => normalizePackTiers,
    packMinimumProducts: () => packMinimumProducts,
    resolveNextPackTier: () => resolveNextPackTier,
    resolvePackTier: () => resolvePackTier,
    savingsCents: () => savingsCents,
    validatePack: () => validatePack
  });
  var MIN_PACK_PRODUCTS = 2;
  var MIN_PACK_PERCENT = 0;
  var MAX_PACK_PERCENT = 99;
  var MAX_PACK_CATALOG = 24;
  var MAX_PACK_TIERS = 5;
  function normalizePackCatalog(raw) {
    if (!Array.isArray(raw)) return [];
    const vistos = /* @__PURE__ */ new Set();
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const productId = item.productId;
      if (typeof productId !== "string" || !productId) continue;
      if (vistos.has(productId)) continue;
      vistos.add(productId);
      const percentRaw = item.percent;
      const percent = typeof percentRaw === "number" && Number.isFinite(percentRaw) && percentRaw >= 0 ? Math.min(percentRaw, MAX_PACK_PERCENT) : void 0;
      out.push(percent === void 0 ? { productId } : { productId, percent });
    }
    return out;
  }
  function normalizePackTiers(raw) {
    if (!Array.isArray(raw)) return [];
    const porMin = /* @__PURE__ */ new Map();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { minProducts, percent } = item;
      if (typeof minProducts !== "number" || !Number.isFinite(minProducts)) continue;
      if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
      if (minProducts < MIN_PACK_PRODUCTS) continue;
      if (percent < MIN_PACK_PERCENT) continue;
      porMin.set(Math.floor(minProducts), Math.min(percent, MAX_PACK_PERCENT));
    }
    return [...porMin.entries()].map(([minProducts, percent]) => ({ minProducts, percent })).sort((a, b) => a.minProducts - b.minProducts);
  }
  function resolvePackTier(tiers, distinctProducts) {
    let vigente = null;
    for (const t of tiers) {
      if (distinctProducts >= t.minProducts) vigente = t;
      else break;
    }
    return vigente;
  }
  function resolveNextPackTier(tiers, distinctProducts) {
    for (const t of tiers) {
      if (t.minProducts > distinctProducts) {
        return {
          productsNeeded: t.minProducts - distinctProducts,
          percent: t.percent
        };
      }
    }
    return null;
  }
  function packMinimumProducts(mode, tiers) {
    if (mode === "PER_PRODUCT") return MIN_PACK_PRODUCTS;
    return tiers.length ? tiers[0].minProducts : MIN_PACK_PRODUCTS;
  }
  function computePack(mode, catalog, tiers, lines) {
    var _a, _b, _c;
    const distinctProducts = new Set(lines.map((l) => l.productId)).size;
    const minimo = packMinimumProducts(mode, tiers);
    if (mode === "PACK_SIZE" && tiers.length === 0)
      return { applies: false, reason: "NO_CONFIG", distinctProducts, nextTier: null };
    if (distinctProducts < minimo) {
      return {
        applies: false,
        reason: "BELOW_MINIMUM",
        distinctProducts,
        // En PER_PRODUCT no hay niveles, pero sí hay un "te falta 1 para que
        // arranque": se expresa con el mismo tipo para que el widget y el aviso
        // del carrito no necesiten dos caminos.
        nextTier: mode === "PACK_SIZE" ? resolveNextPackTier(tiers, distinctProducts) : { productsNeeded: minimo - distinctProducts, percent: 0 }
      };
    }
    const percentPorProducto = /* @__PURE__ */ new Map();
    for (const p of catalog) percentPorProducto.set(p.productId, (_a = p.percent) != null ? _a : 0);
    let resultado;
    let appliedPercent = null;
    if (mode === "PER_PRODUCT") {
      resultado = [];
      for (const line of lines) {
        const percent = (_b = percentPorProducto.get(line.productId)) != null ? _b : 0;
        if (percent <= 0) continue;
        resultado.push({ lineId: line.lineId, percent });
      }
    } else {
      const tier = resolvePackTier(tiers, distinctProducts);
      const percent = (_c = tier == null ? void 0 : tier.percent) != null ? _c : 0;
      appliedPercent = percent;
      resultado = percent > 0 ? lines.map((l) => ({ lineId: l.lineId, percent })) : [];
    }
    if (resultado.length === 0)
      return {
        applies: false,
        reason: "NOTHING_TO_DISCOUNT",
        distinctProducts,
        nextTier: null
      };
    return {
      applies: true,
      mode,
      lines: resultado,
      distinctProducts,
      appliedPercent,
      nextTier: mode === "PACK_SIZE" ? resolveNextPackTier(tiers, distinctProducts) : null
    };
  }
  function savingsCents(unitPrice, quantity, percent) {
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 0;
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    const totalCents = Math.round(unitPrice * 100) * Math.floor(quantity);
    return Math.round(totalCents * percent / 100);
  }
  function buildPackPreview(mode, catalog, tiers, lines) {
    const outcome = computePack(mode, catalog, tiers, lines);
    let subtotalCents = 0;
    for (const l of lines) {
      subtotalCents += Math.round(l.unitPrice * 100) * Math.floor(l.quantity);
    }
    if (!outcome.applies) {
      return {
        applies: false,
        reason: outcome.reason,
        distinctProducts: outcome.distinctProducts,
        appliedPercent: null,
        nextTier: outcome.nextTier,
        rows: [],
        subtotal: subtotalCents / 100,
        savings: 0,
        total: subtotalCents / 100
      };
    }
    const porLinea = new Map(lines.map((l) => [l.lineId, l]));
    let savingsTotalCents = 0;
    const rows = [];
    for (const r of outcome.lines) {
      const line = porLinea.get(r.lineId);
      if (!line) continue;
      const cents = savingsCents(line.unitPrice, line.quantity, r.percent);
      savingsTotalCents += cents;
      rows.push({
        productId: line.productId,
        lineId: r.lineId,
        percent: r.percent,
        savings: cents / 100
      });
    }
    return {
      applies: true,
      reason: null,
      distinctProducts: outcome.distinctProducts,
      appliedPercent: outcome.appliedPercent,
      nextTier: outcome.nextTier,
      rows,
      subtotal: subtotalCents / 100,
      savings: savingsTotalCents / 100,
      total: (subtotalCents - savingsTotalCents) / 100
    };
  }
  function validatePack(mode, catalog, tiers) {
    const errors = [];
    const warnings = [];
    if (catalog.length === 0) {
      errors.push("Eleg\xED al menos un producto para el pack.");
    } else if (catalog.length < MIN_PACK_PRODUCTS) {
      errors.push(
        `Un pack necesita al menos ${MIN_PACK_PRODUCTS} productos para que el comprador pueda armarlo.`
      );
    }
    if (catalog.length > MAX_PACK_CATALOG) {
      errors.push(
        `El pack admite hasta ${MAX_PACK_CATALOG} productos. Elegiste ${catalog.length}.`
      );
    }
    if (mode === "PER_PRODUCT") {
      const conDescuento = catalog.filter((p) => {
        var _a;
        return ((_a = p.percent) != null ? _a : 0) > 0;
      });
      if (conDescuento.length === 0)
        errors.push("Ning\xFAn producto tiene descuento: el pack no rebajar\xEDa nada.");
      else if (conDescuento.length < catalog.length)
        warnings.push(
          `${catalog.length - conDescuento.length} de ${catalog.length} productos est\xE1n al 0%: entran al pack pero no rebajan.`
        );
    } else {
      if (tiers.length === 0) {
        errors.push("Agreg\xE1 al menos un nivel de descuento por tama\xF1o del pack.");
      } else {
        if (tiers.length > MAX_PACK_TIERS)
          errors.push(`M\xE1ximo ${MAX_PACK_TIERS} niveles. Definiste ${tiers.length}.`);
        if (tiers.every((t) => t.percent <= 0))
          errors.push("Todos los niveles est\xE1n al 0%: el pack no rebajar\xEDa nada.");
        const tope = tiers[tiers.length - 1];
        if (tope.minProducts > catalog.length)
          warnings.push(
            `El nivel de ${tope.minProducts} productos es inalcanzable: el pack solo ofrece ${catalog.length}.`
          );
        for (let i = 1; i < tiers.length; i++) {
          if (tiers[i].percent < tiers[i - 1].percent) {
            warnings.push(
              `El nivel de ${tiers[i].minProducts} productos descuenta menos que el anterior. Revis\xE1 que sea intencional.`
            );
            break;
          }
        }
      }
    }
    return { errors, warnings };
  }
  return __toCommonJS(pack_calc_exports);
})();
