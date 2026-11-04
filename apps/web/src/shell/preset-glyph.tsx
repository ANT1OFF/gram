import { GRID_SHAPES, type GridPreset } from "@gram/contracts";

const GLYPH_SIZE = 14;
const GLYPH_GAP = 1.5;

/** A preset's grid as a small glyph, for the layout items in the title bar's "…". */
export function PresetGlyph({ preset }: { preset: GridPreset }) {
  const { cols, rows } = GRID_SHAPES[preset];
  const width = (GLYPH_SIZE - GLYPH_GAP * (cols - 1)) / cols;
  const height = (GLYPH_SIZE - GLYPH_GAP * (rows - 1)) / rows;
  return (
    <svg aria-hidden viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`} className="size-3.5 shrink-0">
      {Array.from({ length: cols * rows }, (_, i) => (
        <rect
          key={i}
          x={(i % cols) * (width + GLYPH_GAP)}
          y={Math.floor(i / cols) * (height + GLYPH_GAP)}
          width={width}
          height={height}
          rx={1}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
