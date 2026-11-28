/** Personal WeChat renders plain text; remove the most visible Markdown syntax while keeping links readable. */
export function plainWeixinText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => label.trim() === url.trim() ? url : `${label.trim()} ${url.trim()}`)
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
}


/**
 * Splits a long reply into several WeChat messages at paragraph or sentence
 * boundaries. The gateway accepted a 2,700-character test message; 2,000 leaves
 * room for client-side rendering and keeps one wall of text from filling a chat.
 */
export function splitWeixinText(text: string, maxChars = 2_000): string[] {
  const chunks: string[] = []
  const push = (value: string): void => { if (value.trim()) chunks.push(value.trim()) }
  const hard = (paragraph: string): void => {
    let buffer = ''
    for (const char of Array.from(paragraph)) {
      if (buffer && buffer.length + char.length > maxChars) { push(buffer); buffer = char }
      else buffer += char
    }
    push(buffer)
  }
  const pack = (parts: string[]): void => {
    let current = ''
    for (const part of parts) {
      const candidate = current ? `${current}\n${part}` : part
      if (candidate.length <= maxChars) { current = candidate; continue }
      if (current) push(current)
      if (part.length <= maxChars) current = part
      else { hard(part); current = '' }
    }
    push(current)
  }
  let current = ''
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > maxChars) {
      push(current); current = ''
      const sentences = paragraph.match(/[^。！？.!?\n]+[。！？.!?]?|[^\n]+\n?/g) ?? [paragraph]
      pack(sentences)
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length <= maxChars) current = candidate
    else { push(current); current = paragraph }
  }
  push(current)
  return chunks.length ? chunks : [text]
}
