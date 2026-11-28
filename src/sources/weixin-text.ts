import { wordCount } from '../infra/text.ts'

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
 * Splits a long reply into several WeChat messages at paragraph/sentence
 * boundaries, keeping each under the IM word ceiling. A single paragraph that
 * still exceeds it is split by characters as a last resort.
 */
export function splitWeixinText(text: string, maxWords = 100): string[] {
  const chunks: string[] = []
  const push = (value: string): void => { if (value.trim()) chunks.push(value.trim()) }
  const hard = (paragraph: string): void => {
    let buffer = ''
    for (const char of Array.from(paragraph)) {
      if (buffer && wordCount(buffer + char) > maxWords) { push(buffer); buffer = char }
      else buffer += char
    }
    push(buffer)
  }
  const pack = (parts: string[]): void => {
    let current = ''
    for (const part of parts) {
      const candidate = current ? `${current}\n${part}` : part
      if (wordCount(candidate) <= maxWords) { current = candidate; continue }
      if (current) push(current)
      if (wordCount(part) <= maxWords) current = part
      else { hard(part); current = '' }
    }
    push(current)
  }
  const paragraphs = text.split(/\n{2,}/)
  let current = ''
  for (const paragraph of paragraphs) {
    if (wordCount(paragraph) > maxWords) {
      push(current); current = ''
      const sentences = paragraph.match(/[^。！？.!?\n]+[。！？.!?]?|[^\n]+\n?/g) ?? [paragraph]
      pack(sentences)
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (wordCount(candidate) <= maxWords) current = candidate
    else { push(current); current = paragraph }
  }
  push(current)
  return chunks.length ? chunks : [text]
}
