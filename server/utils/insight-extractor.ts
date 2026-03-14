import { createHash } from 'crypto'

// Extracts the content between ★ Insight markers
const INSIGHT_START_RE = /`★ Insight\s*[─\-]+`/
const INSIGHT_END_RE = /`[─\-]{10,}`/

export function extractInsightBlocks(text: string): string[] {
  const lines = text.split('\n')
  const results: string[] = []
  let inBlock = false
  let buffer: string[] = []

  for (const line of lines) {
    if (!inBlock && INSIGHT_START_RE.test(line)) {
      inBlock = true
      buffer = []
    } else if (inBlock && INSIGHT_END_RE.test(line)) {
      const content = buffer.join('\n').trim()
      if (content) results.push(content)
      inBlock = false
      buffer = []
    } else if (inBlock) {
      buffer.push(line)
    }
  }

  return results
}

// Fallback: extract significant text paragraphs (>150 chars)
export function extractSignificantText(text: string): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 150 && !p.startsWith('#') && !p.startsWith('```'))

  return paragraphs.slice(0, 3) // max 3 paragraphs per message
}

export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}
