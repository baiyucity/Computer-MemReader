export interface TreemapEntry { id: string; value: number }
export interface TreemapRect<T> { item: T; x: number; y: number; width: number; height: number }

/** Squarified treemap: each positive item owns exactly its share of the rectangle. */
export function layoutTreemap<T extends TreemapEntry>(items: T[], width: number, height: number): TreemapRect<T>[] {
  if (!(width > 0 && height > 0)) return [];
  const usable = items.filter(item => Number.isFinite(item.value) && item.value > 0).sort((a, b) => b.value - a.value);
  const sum = usable.reduce((value, item) => value + item.value, 0);
  if (!sum) return [];
  const scale = width * height / sum;
  let remaining = usable.map(item => ({ item, area: item.value * scale }));
  const rects: TreemapRect<T>[] = [];
  let box = { x: 0, y: 0, width, height };

  const worstRatio = (row: typeof remaining, edge: number) => {
    if (!row.length || edge <= 0) return Infinity;
    const areas = row.map(entry => entry.area);
    const area = areas.reduce((a, b) => a + b, 0);
    return Math.max(edge * edge * Math.max(...areas) / (area * area), area * area / (edge * edge * Math.min(...areas)));
  };

  while (remaining.length) {
    const edge = Math.min(box.width, box.height);
    const row = [remaining[0]];
    let count = 1;
    while (count < remaining.length && worstRatio([...row, remaining[count]], edge) <= worstRatio(row, edge)) {
      row.push(remaining[count++]);
    }
    const rowArea = row.reduce((area, entry) => area + entry.area, 0);
    const horizontal = box.width < box.height;
    const thickness = horizontal ? rowArea / box.width : rowArea / box.height;
    let offset = 0;
    row.forEach((entry, index) => {
      const length = index === row.length - 1 ? edge - offset : entry.area / thickness;
      rects.push({
        item: entry.item,
        x: box.x + (horizontal ? offset : 0),
        y: box.y + (horizontal ? 0 : offset),
        width: horizontal ? length : thickness,
        height: horizontal ? thickness : length,
      });
      offset += length;
    });
    box = horizontal
      ? { ...box, y: box.y + thickness, height: Math.max(0, box.height - thickness) }
      : { ...box, x: box.x + thickness, width: Math.max(0, box.width - thickness) };
    remaining = remaining.slice(count);
  }
  return rects;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const level = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** level;
  return `${value.toFixed(level === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[level]}`;
}

export function percentage(value: number, total: number): string {
  if (!(total > 0 && value > 0)) return '0%';
  const result = value / total * 100;
  if (result < 0.1) return '<0.1%';
  return `${result.toFixed(result >= 10 ? 1 : 2).replace(/\.0$/, '')}%`;
}
