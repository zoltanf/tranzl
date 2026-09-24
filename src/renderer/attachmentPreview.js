// Only app-created attachment images can open this local, read-only viewer.
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'attachment-preview-dialog';
  dialog.setAttribute('aria-labelledby', 'attachment-preview-title');
  const toolbar = document.createElement('div');
  toolbar.className = 'attachment-preview-toolbar';
  const title = document.createElement('strong');
  title.id = 'attachment-preview-title';
  const zoom = document.createElement('button');
  zoom.textContent = 'Actual size';
  zoom.setAttribute('aria-pressed', 'false');
  const close = document.createElement('button');
  close.textContent = 'Close';
  const viewport = document.createElement('div');
  viewport.className = 'attachment-preview-viewport';
  const image = document.createElement('img');
  viewport.append(image);
  toolbar.append(title, zoom, close);
  dialog.append(toolbar, viewport);
  document.body.append(dialog);
  let opener;
  close.onclick = () => dialog.close();
  zoom.onclick = () => {
    const actual = viewport.classList.toggle('actual-size');
    zoom.textContent = actual ? 'Fit to window' : 'Actual size';
    zoom.setAttribute('aria-pressed', String(actual));
  };
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    if (opener?.isConnected) opener.focus();
  });
  // Escape dismisses the preview without stopping an unrelated generation.
  document.addEventListener('keydown', event => {
    if (dialog.open && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); dialog.close();
    }
  }, true);
  function enable(thumbnail) {
    thumbnail.tabIndex = 0;
    thumbnail.setAttribute('role', 'button');
    thumbnail.setAttribute('aria-label', `Preview ${thumbnail.alt || 'attachment'}`);
    thumbnail.title = 'Click to preview';
    const open = () => {
      opener = thumbnail;
      title.textContent = thumbnail.alt || 'Attachment';
      image.alt = thumbnail.alt;
      image.src = thumbnail.src;
      viewport.classList.remove('actual-size');
      zoom.textContent = 'Actual size'; zoom.setAttribute('aria-pressed', 'false');
      dialog.showModal();
      viewport.scrollTo(0, 0);
      close.focus();
    };
    thumbnail.addEventListener('click', open);
    thumbnail.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
  }
  window.attachmentPreview = { enable };
})();
