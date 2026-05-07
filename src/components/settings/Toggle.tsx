export function Toggle({ value, disabled, onChange, label }: {
  value: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={value} aria-label={label}
      disabled={disabled} onClick={() => onChange(!value)}
      style={{
        flexShrink: 0, width: "34px", height: "18px", borderRadius: "9999px",
        position: "relative", background: value ? "var(--info)" : "var(--border-default)",
        opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s", border: "none", padding: 0,
      }}
    >
      <span aria-hidden="true" style={{
        position: "absolute", top: "2px", left: value ? "18px" : "2px",
        width: "14px", height: "14px", borderRadius: "50%",
        background: "var(--bg-primary, #fff)", transition: "left 0.15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
      }} />
    </button>
  );
}
