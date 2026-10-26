/** The strokes of an icon, one after another, at most this far apart. */
const STAGGER_MS = 40;
/** Strokes after this many start with the last, so a busy icon is drawn as soon as a simple one. */
const MAX_STAGGERED = 4;

const SHAPES = "path, line, polyline, polygon, circle, rect, ellipse";

/** When stroke `index` of an icon starts drawing, in ms. */
export const strokeDelay = (index: number): number => Math.min(index, MAX_STAGGERED) * STAGGER_MS;

/**
 * A ref for an icon (a Lucide one, say) that draws its strokes on, one after another, as it
 * mounts: the mark of an empty state as it appears. Each shape is measured as one unit
 * (`pathLength`) and takes `.gram-draw`, so Reduced fades the icon in and Off shows it drawn.
 */
export const drawOn = (element: SVGSVGElement | null) => {
  if (element === null) return;
  element.querySelectorAll<SVGGeometryElement>(SHAPES).forEach((shape, index) => {
    shape.setAttribute("pathLength", "1");
    shape.classList.add("gram-draw");
    shape.style.animationDelay = `${strokeDelay(index)}ms`;
  });
};
