// 20x20 stroke icons for the toolbars.
const PATHS: Record<string, React.ReactNode> = {
  cursor: <path d="M5 3l11 7-5 1.2L8.6 16z" />,
  segment: <><path d="M4.5 15.5l11-11" /><circle cx="4" cy="16" r="1.6" /><circle cx="16" cy="4" r="1.6" /></>,
  rayLine: <><path d="M5 15l14-14" /><circle cx="4" cy="16" r="1.6" /></>,
  straightLine: <path d="M1 19L19 1" />,
  horizontalStraightLine: <path d="M1 10h18" />,
  horizontalRayLine: <><path d="M6 10h13" /><circle cx="4.5" cy="10" r="1.6" /></>,
  verticalStraightLine: <path d="M10 1v18" />,
  parallelStraightLine: <path d="M2 13L13 2M7 18L18 7" />,
  rect: <rect x="3" y="5" width="14" height="10" rx="1" />,
  fibonacciLine: <path d="M2 4h16M2 8h16M2 11h16M2 16h16" />,
  fib: <path d="M2 4h16M2 8h16M2 11h16M2 16h16" />,
  measure: <path d="M10 2v16M6 6l4-4 4 4M6 14l4 4 4-4" />,
  note: <path d="M4 4h12M10 4v12" />,
  longPosition: <><rect x="3" y="3" width="14" height="7" fill="currentColor" opacity=".25" /><rect x="3" y="10" width="14" height="4" /><path d="M7 7l3-3 3 3" /></>,
  shortPosition: <><rect x="3" y="6" width="14" height="4" /><rect x="3" y="10" width="14" height="7" fill="currentColor" opacity=".25" /><path d="M7 13l3 3 3-3" /></>,
  eye: <><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z" /><circle cx="10" cy="10" r="2.5" /></>,
  lock: <><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6a3 3 0 016 0v3" /></>,
  priceLine: <><path d="M2 12h10" /><path d="M13 9h5v6h-5z" /></>,
  magnet: <path d="M5 3v7a5 5 0 0010 0V3M5 6h3M12 6h3" />,
  trash: <path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12" />,
  candle: <><path d="M6 2v3M6 13v5M14 2v5M14 14v4" /><rect x="4" y="5" width="4" height="8" rx=".5" /><rect x="12" y="7" width="4" height="7" rx=".5" fill="currentColor" /></>,
  line: <path d="M2 15l5-6 4 3 7-8" />,
  layout1: <rect x="2.5" y="3.5" width="15" height="13" rx="1" />,
  layout2: <><rect x="2.5" y="3.5" width="15" height="13" rx="1" /><path d="M10 3.5v13" /></>,
  gear: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>,
  play: <path d="M6 4l10 6-10 6z" fill="currentColor" />,
  pause: <path d="M6 4v12M14 4v12" strokeWidth="3" />,
  step: <><path d="M4 4l8 6-8 6z" fill="currentColor" /><path d="M15 4v12" strokeWidth="2" /></>,
  stepBack: <><path d="M16 4l-8 6 8 6z" fill="currentColor" /><path d="M5 4v12" strokeWidth="2" /></>,
  selectBar: <><path d="M10 2v16" strokeDasharray="2 2" /><path d="M3 10h4M13 10h4M5 8l-2 2 2 2M15 8l2 2-2 2" /></>,
  back: <path d="M12 4l-6 6 6 6" />,
  chart: <path d="M3 17V3M3 17h14M6 13l3-4 3 2 4-6" />,
};

export function Icon({ name }: { name: string }) {
  return <svg viewBox="0 0 20 20">{PATHS[name]}</svg>;
}
