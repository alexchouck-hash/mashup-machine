interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: string;
  color?: string;
  disabled?: boolean;
  /** Value applied on double-click — the usual "reset to centre" DJ affordance. */
  resetTo?: number;
  onChange: (v: number) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  display,
  color,
  disabled,
  resetTo,
  onChange,
}: SliderProps) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="lbl">{label}</span>
        <span className="text-[11px] font-mono text-slate-400 tabular-nums">
          {display ?? value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}
        style={
          color
            ? ({ '--thumb': color, '--thumb-glow': `${color}66` } as React.CSSProperties)
            : undefined
        }
      />
    </label>
  );
}
