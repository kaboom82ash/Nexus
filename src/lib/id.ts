/** Small collision-resistant id helper (no external deps). */
export function makeId(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36)
  return `${prefix}_${time}${rand}`
}
