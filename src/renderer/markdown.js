// Shared sanitized Markdown rendering for model output.
window.renderMarkdown = function (text) {
  const fragment = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }), {
    RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['img', 'style', 'form', 'video', 'audio', 'iframe'], FORBID_ATTR: ['style'],
  });
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove(); else input.disabled = true;
  }
  for (const link of fragment.querySelectorAll('a')) {
    if (!/^https:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  return fragment;
};
