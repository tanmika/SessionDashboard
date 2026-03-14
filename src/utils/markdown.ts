import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked: use synchronous renderer, GitHub-flavored breaks
marked.setOptions({
  breaks: true,   // single newline → <br>
  gfm: true,      // GitHub Flavored Markdown (tables, strikethrough, etc.)
})

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string

  // Wrap tables in a scrollable container so they never overflow fixed-width cards
  const wrapped = raw
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')

  return DOMPurify.sanitize(wrapped, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 's',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote',
      'code', 'pre',
      'a', 'hr',
      'div',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  })
}
