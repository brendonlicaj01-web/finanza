import { useEffect, useMemo, useRef, useState } from 'react';
import type { Slice } from '../lib/portfolio';
import type { Snapshot } from '../lib/types';
import { compactMoney, date as fmtDate, money, pct } from '../lib/format';

/** Barre orizzontali per l'allocazione: un'unica serie, valore e peso etichettati a fine barra. */
export function AllocationBars({ slices }: { slices: Slice[] }) {
  const max = Math.max(...slices.map((s) => s.share), 0);
  return (
    <div className="alloc-list" role="list">
      {slices.map((s) => (
        <div className="alloc-row" role="listitem" key={s.key} title={`${s.label}: ${money(s.value)} (${pct(s.share)})`}>
          <span className="alloc-label">{s.label}</span>
          <div className="alloc-track" aria-hidden="true">
            <div className="alloc-bar" style={{ width: `${max > 0 ? (s.share / max) * 100 : 0}%` }} />
          </div>
          <span className="alloc-value">
            {money(s.value, { digits: 0 })} <span className="muted small">{pct(s.share)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

const SERIES = [
  { key: 'netWorth' as const, label: 'Patrimonio', color: 'var(--series-1)' },
  { key: 'invested' as const, label: 'Capitale versato', color: 'var(--series-2)' },
];

/** Andamento del patrimonio vs capitale investito, con mirino e tooltip al passaggio del mouse. */
export function NetWorthChart({ snapshots }: { snapshots: Snapshot[] }) {
  // La larghezza segue il contenitore, così testo e tratti restano a dimensione reale su ogni schermo.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 200 : 260;
  const pad = { top: 12, right: 12, bottom: 28, left: 64 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const geo = useMemo(() => {
    const times = snapshots.map((s) => new Date(s.date).getTime());
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const values = snapshots.flatMap((s) => [s.netWorth, s.invested]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    const x = (t: number) => (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
    const y = (v: number) => ih - ((v - lo) / (hi - lo)) * ih;
    const xs = times.map(x);
    const path = (k: 'netWorth' | 'invested') =>
      snapshots.map((s, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y(s[k]).toFixed(1)}`).join('');
    const area = `${path('netWorth')}L${xs[xs.length - 1].toFixed(1)},${ih}L${xs[0].toFixed(1)},${ih}Z`;

    // Etichette asse X: al massimo ~6, distribuite uniformemente.
    const every = Math.max(1, Math.ceil(snapshots.length / Math.max(2, Math.floor(iw / 110))));
    const idx = snapshots.map((_, i) => i).filter((i) => i % every === 0);
    const lastIdx = snapshots.length - 1;
    if (idx[idx.length - 1] !== lastIdx) {
      if (lastIdx - idx[idx.length - 1] < every / 2 && idx.length > 1) idx.pop();
      idx.push(lastIdx);
    }
    const xTicks = idx.map((i) => ({ i, s: snapshots[i] }));
    return { xs, y, ticks, path, area, xTicks };
  }, [snapshots, iw, ih]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W - pad.left;
    let best = 0;
    for (let i = 1; i < geo.xs.length; i++) {
      if (Math.abs(geo.xs[i] - px) < Math.abs(geo.xs[best] - px)) best = i;
    }
    setHover(best);
  };

  const last = snapshots[snapshots.length - 1];
  const h = hover !== null ? snapshots[hover] : null;
  const hx = hover !== null ? geo.xs[hover] : 0;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="legend" aria-hidden="true">
        {SERIES.map((s) => (
          <span key={s.key}>
            <span className="legend-key" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart-wrap" ref={wrapRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Andamento del patrimonio: ultimo valore ${money(last.netWorth)}, capitale investito ${money(last.invested)}`}
        >
          <g transform={`translate(${pad.left},${pad.top})`}>
            {geo.ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={iw} y1={geo.y(t)} y2={geo.y(t)} stroke="var(--grid)" strokeWidth={1} />
                <text
                  x={-10}
                  y={geo.y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill="var(--muted)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {compactMoney(t)}
                </text>
              </g>
            ))}
            {geo.xTicks.map(({ i, s }) => (
              <text
                key={s.date}
                x={geo.xs[i]}
                y={ih + 20}
                textAnchor={i === 0 ? 'start' : i === snapshots.length - 1 ? 'end' : 'middle'}
                fontSize={11}
                fill="var(--muted)"
              >
                {new Date(s.date).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' })}
              </text>
            ))}
            <path d={geo.area} fill="var(--series-1)" opacity={0.1} />
            {SERIES.map((s) => (
              <path
                key={s.key}
                d={geo.path(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {h && (
              <line x1={hx} x2={hx} y1={0} y2={ih} stroke="var(--axis)" strokeWidth={1} />
            )}
            {SERIES.map((s) => {
              const idx = hover ?? snapshots.length - 1;
              return (
                <circle
                  key={s.key}
                  cx={geo.xs[idx]}
                  cy={geo.y(snapshots[idx][s.key])}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}
            <rect
              x={-pad.left}
              y={0}
              width={iw + pad.left + pad.right}
              height={ih}
              fill="transparent"
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>
        {h && (
          <div
            className="tooltip"
            style={{
              left: `${((hx + pad.left) / W) * 100}%`,
              top: 0,
              transform: `translateX(${hx > iw * 0.6 ? 'calc(-100% - 12px)' : '12px'})`,
            }}
          >
            <div className="t-date">{fmtDate(h.date)}</div>
            {SERIES.map((s) => (
              <div className="t-row" key={s.key}>
                <span>
                  <span className="dot" style={{ background: s.color }} />
                  {s.label}
                </span>
                <strong>{money(h[s.key], { digits: 0 })}</strong>
              </div>
            ))}
            <div className="t-row">
              <span className="muted">Differenza</span>
              <span>{money(h.netWorth - h.invested, { sign: true, digits: 0 })}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
