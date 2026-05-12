export interface TimeRange {
  since?: string
  until?: string
}

export interface TimeRangeInput {
  range?: string
  since?: string
  until?: string
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfLocalWeek(date: Date): Date {
  const day = date.getDay()
  const daysSinceMonday = (day + 6) % 7
  return addDays(startOfLocalDay(date), -daysSinceMonday)
}

function parseDateBoundary(value: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const parsed = dateOnly
    ? new Date(`${value}T00:00:00`)
    : new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid time value "${value}". Use ISO time or YYYY-MM-DD.`)
  }

  return parsed.toISOString()
}

export function resolveTimeRange(input: TimeRangeInput): TimeRange | undefined {
  const now = new Date()
  let since: string | undefined
  let until: string | undefined

  if (input.range) {
    switch (input.range) {
      case 'today': {
        const start = startOfLocalDay(now)
        since = start.toISOString()
        until = addDays(start, 1).toISOString()
        break
      }
      case 'yesterday': {
        const today = startOfLocalDay(now)
        since = addDays(today, -1).toISOString()
        until = today.toISOString()
        break
      }
      case 'week':
      case 'this-week': {
        const start = startOfLocalWeek(now)
        since = start.toISOString()
        until = addDays(start, 7).toISOString()
        break
      }
      case 'last-week': {
        const thisWeek = startOfLocalWeek(now)
        since = addDays(thisWeek, -7).toISOString()
        until = thisWeek.toISOString()
        break
      }
      default:
        throw new Error(`Invalid range "${input.range}". Use today, yesterday, week, this-week, or last-week.`)
    }
  }

  if (input.since) since = parseDateBoundary(input.since)
  if (input.until) until = parseDateBoundary(input.until)

  if (!since && !until) return undefined

  if (since && until && since >= until) {
    throw new Error(`Invalid time range: since must be earlier than until.`)
  }

  return { since, until }
}

export function isInTimeRange(timestamp: string, range: TimeRange | undefined): boolean {
  if (!range) return true
  if (range.since && timestamp < range.since) return false
  if (range.until && timestamp >= range.until) return false
  return true
}
