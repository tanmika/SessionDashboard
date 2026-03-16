/** State → CSS color string. Used by sidebar and session cards. */
export function stateColor(state: string): string {
  switch (state) {
    case 'active': return 'var(--green)'
    case 'waiting_permission': return 'var(--danger)'
    case 'waiting_user': return 'var(--orange)'
    case 'inactive': return 'rgba(148, 163, 184, 0.5)'
    case 'idle': return 'var(--muted)'
    case 'ended': return 'rgba(255,255,255,0.15)'
    default: return 'var(--muted)'
  }
}
