/** Pure geometry used by the trusted chrome's controlled tab drag lifecycle. */
export const TAB_DRAG_START_PX = 6;
export const TAB_DETACH_DISTANCE_PX = 80;

export interface DragPoint { x: number; y: number }
export interface DragRect { left: number; right: number; top: number; bottom: number }

export function tabDragStarted(start: DragPoint, point: DragPoint): boolean {
  return Math.max(Math.abs(point.x - start.x), Math.abs(point.y - start.y)) >= TAB_DRAG_START_PX;
}

/**
 * A horizontal strip only tears a tab off after a large vertical pull. A
 * vertical strip uses the equivalent horizontal pull. Moving beyond either
 * end of a strip continues to mean reorder, not accidental detachment.
 */
export function tabDetachDistance(point: DragPoint, strip: DragRect, vertical: boolean): number {
  if (vertical) {
    if (point.x < strip.left) return strip.left - point.x;
    if (point.x > strip.right) return point.x - strip.right;
    return 0;
  }
  if (point.y < strip.top) return strip.top - point.y;
  if (point.y > strip.bottom) return point.y - strip.bottom;
  return 0;
}

export function shouldDetachTab(point: DragPoint, strip: DragRect, vertical: boolean): boolean {
  return tabDetachDistance(point, strip, vertical) >= TAB_DETACH_DISTANCE_PX;
}

/** Return the insertion slot nearest to the pointer (0..rects.length). */
export function tabDropIndex(point: DragPoint, rects: DragRect[], vertical: boolean): number {
  const coordinate = vertical ? point.y : point.x;
  for (let i = 0; i < rects.length; i += 1) {
    const center = vertical
      ? (rects[i].top + rects[i].bottom) / 2
      : (rects[i].left + rects[i].right) / 2;
    if (coordinate < center) return i;
  }
  return rects.length;
}
