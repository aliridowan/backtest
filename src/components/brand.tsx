// The BacktestMind mark, shared by the landing page and the dashboard.
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="url(#lg)" />
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2962ff" /><stop offset="1" stopColor="#7b4dff" /></linearGradient></defs>
      <path d="M10 8v16M16 6v20M22 10v12" stroke="#fff" strokeOpacity=".55" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="8" y="12" width="4" height="8" rx="1" fill="#fff" />
      <rect x="14" y="9" width="4" height="9" rx="1" fill="#fff" />
      <rect x="20" y="13" width="4" height="6" rx="1" fill="#fff" />
    </svg>
  );
}
