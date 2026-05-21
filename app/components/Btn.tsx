/**
 * Btn — sistema de botones reutilizable para DiscountFlow.
 *
 * Variantes:
 *   primary     — verde #008060, texto blanco  (acción principal / positiva)
 *   secondary   — fondo blanco, borde gris     (acción secundaria / neutral)
 *   muted       — fondo gris claro #E1E3E5     (acción de pausa / desactivar)
 *   destructive — fondo rojo pastel #FED3D1    (eliminar / acción peligrosa)
 *
 * Tamaños:
 *   sm — padding 5×12 px, 13 px  (botones de tabla)
 *   md — padding 8×16 px, 14 px  (barras de acción)
 */
import React from "react";
import { Link } from "react-router";

export type BtnVariant = "primary" | "secondary" | "muted" | "destructive";
export type BtnSize = "sm" | "md";

const BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  borderRadius: "6px",
  fontWeight: "500",
  fontFamily: "inherit",
  textDecoration: "none",
  whiteSpace: "nowrap",
  lineHeight: 1.4,
  cursor: "pointer",
  transition: "opacity 0.12s",
};

const VARIANTS: Record<BtnVariant, React.CSSProperties> = {
  primary: { background: "#008060", color: "#ffffff", border: "none" },
  secondary: { background: "#ffffff", color: "#202223", border: "1px solid #c9cccf" },
  muted: { background: "#E1E3E5", color: "#202223", border: "none" },
  destructive: { background: "#FED3D1", color: "#D72C0D", border: "none" },
};

const SIZES: Record<BtnSize, React.CSSProperties> = {
  sm: { padding: "5px 12px", fontSize: "13px" },
  md: { padding: "8px 16px", fontSize: "14px" },
};

// ─── <Btn> — elemento <button> ────────────────────────────────────────────────

type BtnProps = {
  variant?: BtnVariant;
  size?: BtnSize;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  name?: string;
  value?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export function Btn({
  variant = "secondary",
  size = "md",
  disabled,
  type = "button",
  name,
  value,
  onClick,
  style,
  children,
}: BtnProps) {
  return (
    <button
      type={type}
      name={name}
      value={value}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...BASE,
        ...VARIANTS[variant],
        ...SIZES[size],
        ...(disabled ? { opacity: 0.6, cursor: "not-allowed" } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ─── <LinkBtn> — elemento <Link> con look de botón ────────────────────────────

type LinkBtnProps = {
  to: string;
  variant?: BtnVariant;
  size?: BtnSize;
  onClick?: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export function LinkBtn({
  to,
  variant = "secondary",
  size = "md",
  onClick,
  style,
  children,
}: LinkBtnProps) {
  return (
    <Link
      to={to}
      onClick={onClick}
      style={{
        ...BASE,
        ...VARIANTS[variant],
        ...SIZES[size],
        ...style,
      }}
    >
      {children}
    </Link>
  );
}
