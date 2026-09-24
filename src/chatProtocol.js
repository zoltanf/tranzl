const MAX_TEXT = 200000;
const MAX_MEDIA = 40 * 1024 * 1024;
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 1000) throw new Error('Invalid conversation.');
  let textSize = 0, mediaSize = 0, images = 0, audio = 0;
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('Invalid conversation message.');
    textSize += message.content.length;
    if (message.media != null && !Array.isArray(message.media)) throw new Error('Invalid attachments.');
    for (const file of message.media || []) {
      if (message.role !== 'user') throw new Error('Only user messages may contain attachments.');
      if (!file || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data) || file.data.length % 4 !== 0) throw new Error('Invalid media data.');
      if (file.kind === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)) images++;
      else if (file.kind === 'audio' && ['wav', 'mp3', 'flac'].includes(file.format)) audio++;
      else throw new Error('Unsupported media type.');
      mediaSize += file.data.length * 3 / 4;
      if (mediaSize > MAX_MEDIA) throw new Error('Conversation media exceeds 40 MB. Start a new chat.');
    }
  }
  if (textSize > MAX_TEXT) throw new Error('Conversation text exceeds 200,000 characters. Start a new chat or use smaller documents.');
  if (images > 12 || audio > 2) throw new Error('A conversation can contain up to 12 images/scanned pages and 2 audio clips. Start a new chat.');
}
function openAIMessages(messages) {
  return messages.map(({ role, content, media }) => ({ role, content: media?.length ? [
    { type: 'text', text: content }, ...media.flatMap(file => [...(file.name ? [{ type: 'text', text: `Attachment: ${String(file.name).slice(0, 300)}` }] : []), file.kind === 'image'
      ? { type: 'image_url', image_url: { url: `data:${file.mime};base64,${file.data}` } }
      : { type: 'input_audio', input_audio: { data: file.data, format: file.format } }]),
  ] : content }));
}
function ollamaMessages(messages) {
  if (messages.some(m => m.media?.some(f => f.kind === 'audio'))) throw new Error('Audio attachments currently require the Embedded backend. Choose it in Settings.');
  return messages.map(({ role, content, media }) => ({ role, content: media?.some(f => f.name) ? `${content}\n\nImages in order: ${media.map((f, i) => `${i + 1}. ${String(f.name || 'Image').slice(0, 300)}`).join('; ')}` : content, ...(media?.length ? { images: media.map(f => f.data) } : {}) }));
}
module.exports = { validateMessages, openAIMessages, ollamaMessages };
