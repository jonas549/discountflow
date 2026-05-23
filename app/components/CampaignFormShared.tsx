import { useState } from "react";
import { ChevronDown, ChevronUp, Tag } from "lucide-react";

// ─── Styles ────────────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  fontSize: "14px",
  color: "#202223",
  background: "#fff",
  boxSizing: "border-box",
  outline: "none",
};

export const inputErrorStyle: React.CSSProperties = { ...inputStyle, borderColor: "#d82c0d" };

export const pickerBtnStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: "500",
  cursor: "pointer",
  color: "#202223",
};

export const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  background: "#f1f2f3",
  border: "1px solid #e1e3e5",
  borderRadius: "16px",
  padding: "3px 10px",
  fontSize: "12px",
  color: "#202223",
};

export const chipRemoveStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#8c9196",
  padding: "0 0 0 2px",
  fontSize: "14px",
  lineHeight: 1,
};

// ─── Section ───────────────────────────────────────────────────────────────────

export function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "10px",
        marginBottom: "16px",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: "14px",
          fontWeight: "600",
          color: "#202223",
          textAlign: "left",
        }}
      >
        {title}
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div style={{ padding: "0 18px 18px", borderTop: "1px solid #f1f2f3" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── FieldGroup ────────────────────────────────────────────────────────────────

export function FieldGroup({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: "16px" }}>
      <label
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: "500",
          color: "#202223",
          marginBottom: "5px",
        }}
      >
        {label}
      </label>
      {children}
      {helper && !error && (
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>{helper}</p>
      )}
      {error && (
        <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "4px" }}>{error}</p>
      )}
    </div>
  );
}

// ─── ProductChips ──────────────────────────────────────────────────────────────

export type ProductChipItem = { id: string; title: string; variantCount: number };

export function ProductChips({
  products,
  onRemove,
}: {
  products: ProductChipItem[];
  onRemove: (id: string) => void;
}) {
  if (products.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
      {products.map((p) => (
        <div
          key={p.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            background: "#f1f2f3",
            border: "1px solid #e1e3e5",
            borderRadius: "16px",
            padding: "3px 10px",
            fontSize: "12px",
            color: "#202223",
          }}
        >
          <Tag size={11} style={{ color: "#8c9196" }} />
          {p.title}
          <span style={{ color: "#8c9196", fontSize: "11px" }}>({p.variantCount} var.)</span>
          <button
            type="button"
            onClick={() => onRemove(p.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#8c9196",
              padding: "0 0 0 2px",
              fontSize: "14px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── StringChips (tags, vendors, product types) ────────────────────────────────

export function StringChips({
  values,
  onRemove,
}: {
  values: string[];
  onRemove: (v: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
      {values.map((v) => (
        <div key={v} style={chipStyle}>
          {v}
          <button type="button" onClick={() => onRemove(v)} style={chipRemoveStyle}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── CollectionChips ───────────────────────────────────────────────────────────

export function CollectionChips({
  collections,
  onRemove,
}: {
  collections: Array<{ id: string; title: string }>;
  onRemove: (id: string) => void;
}) {
  if (collections.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
      {collections.map((c) => (
        <div key={c.id} style={chipStyle}>
          {c.title}
          <button type="button" onClick={() => onRemove(c.id)} style={chipRemoveStyle}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── ActionBar ────────────────────────────────────────────────────────────────

export function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        background: "#ffffff",
        borderTop: "1px solid #e1e3e5",
        padding: "14px 24px",
        display: "flex",
        gap: "10px",
        alignItems: "center",
        zIndex: 10,
        marginLeft: "-24px",
        marginRight: "-24px",
      }}
    >
      {children}
    </div>
  );
}

// ─── GeneralErrorBanner ────────────────────────────────────────────────────────

export function GeneralErrorBanner({
  message,
  limitExceeded,
}: {
  message: string;
  limitExceeded?: boolean;
}) {
  return (
    <div
      style={{
        background: limitExceeded ? "#fff8e1" : "#fde8e8",
        border: `1px solid ${limitExceeded ? "#f9a825" : "#f97066"}`,
        borderRadius: "8px",
        padding: "12px 16px",
        color: limitExceeded ? "#a05c00" : "#c0392b",
        fontSize: "14px",
        marginBottom: "16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <span>{message}</span>
      {limitExceeded && (
        <a
          href="/app/plans"
          style={{
            fontSize: "13px",
            fontWeight: "600",
            color: "#008060",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Ver planes →
        </a>
      )}
    </div>
  );
}
