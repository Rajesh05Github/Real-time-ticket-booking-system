const ITEMS = [
  { swatch: 'bg-seat-available ring-1 ring-inset ring-seat-available-ring', label: 'Available' },
  { swatch: 'bg-seat-selected', label: 'Selected' },
  { swatch: 'bg-seat-reserved', label: 'Held' },
  { swatch: 'bg-seat-sold', label: 'Sold' },
] as const;

export function SeatLegend(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-fg-muted">
      {ITEMS.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className={`size-3.5 rounded ${item.swatch}`} />
          {item.label}
        </div>
      ))}
    </div>
  );
}
