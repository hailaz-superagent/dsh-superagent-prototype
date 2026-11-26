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
