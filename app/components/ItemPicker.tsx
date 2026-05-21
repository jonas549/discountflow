import { useState, useEffect, useMemo } from "react";

export type PickerItem = { id: string; label: string; sublabel?: string };

type ItemPickerProps = {
  open: boolean;
  title: string;
  items: PickerItem[];
  selectedIds: string[];
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
};

export function ItemPicker({
  open,
  title,
  items,
  selectedIds,
  onConfirm,
  onCancel,
}: ItemPickerProps) {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<string[]>(selectedIds);

  useEffect(() => {
    if (open) {
      setChecked(selectedIds);
      setSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(
    () =>
      search.trim()
        ? items.filter((item) =>
            item.label.toLowerCase().includes(search.toLowerCase())
          )
        : items,
    [items, search]
  );

  const toggle = (id: string) =>
    setChecked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          width: "480px",
          maxWidth: "90vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 48px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #e1e3e5",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "16px", fontWeight: "600", color: "#202223" }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              fontSize: "20px",
              cursor: "pointer",
              color: "#6d7175",
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid #f1f2f3",
            flexShrink: 0,
          }}
        >
          <input
            type="text"
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #c9cccf",
              borderRadius: "6px",
              fontSize: "14px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "32px 20px",
                textAlign: "center",
                color: "#8c9196",
                fontSize: "14px",
              }}
            >
              Sin resultados
            </div>
          ) : (
            filtered.map((item) => {
              const isChecked = checked.includes(item.id);
              return (
                <label
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "10px 20px",
                    cursor: "pointer",
                    background: isChecked ? "#f1f8f5" : "transparent",
                    borderBottom: "1px solid #f1f2f3",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(item.id)}
                    style={{
                      width: "16px",
                      height: "16px",
                      cursor: "pointer",
                      flexShrink: 0,
                      accentColor: "#008060",
                    }}
                  />
                  <div>
                    <div style={{ fontSize: "14px", color: "#202223" }}>
                      {item.label}
                    </div>
                    {item.sublabel && (
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#8c9196",
                          marginTop: "2px",
                        }}
                      >
                        {item.sublabel}
                      </div>
                    )}
                  </div>
                </label>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            padding: "14px 20px",
            borderTop: "1px solid #e1e3e5",
            flexShrink: 0,
            background: "#fff",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              border: "1px solid #c9cccf",
              borderRadius: "6px",
              background: "#fff",
              fontSize: "14px",
              cursor: "pointer",
              color: "#202223",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(checked)}
            style={{
              padding: "8px 20px",
              border: "none",
              borderRadius: "6px",
              background: checked.length > 0 ? "#008060" : "#c9cccf",
              fontSize: "14px",
              cursor: checked.length > 0 ? "pointer" : "default",
              color: "#fff",
              fontWeight: "500",
            }}
          >
            {checked.length > 0 ? `Agregar (${checked.length})` : "Agregar"}
          </button>
        </div>
      </div>
    </div>
  );
}
