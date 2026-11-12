// Loaded as a plain script before the page's module. If the page fails to
// start (most often because the browser mixed files from two versions of
// Bedrock just after an update), say so and offer a reload, instead of
// leaving an empty page. Errors after the page is ready are not its business.
(function () {
  const ready = () => !!(window.bedrock?.ready || window.trainer?.ready || window.setup?.ready);
  function show(e) {
    if (ready()) return;
    let box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.className = 'fatal';
      document.body.append(box);
    }
    if (!box.hidden) return; // the page already said what went wrong
    box.textContent = 'Bedrock could not start. If it was just updated, part of the old version may still be loaded: reload the page. ';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Reload';
    b.addEventListener('click', () => location.reload());
    box.append(b);
    const why = document.createElement('small');
    why.textContent = ` (${e?.message || 'unknown error'})`;
    box.append(why);
    box.hidden = false;
  }
  window.addEventListener('error', show);
})();
