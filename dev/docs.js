// TxUI Help — client-side interactivity (no dependencies).

// ── OS shortcut toggle ────────────────────────────────────────────────────────
function setOS(os){
  document.body.classList.toggle('show-mac', os === 'mac');
  document.body.classList.toggle('show-win', os === 'win');
  document.querySelectorAll('#osToggle button').forEach(b => b.classList.toggle('active', b.dataset.os === os));
  try{ localStorage.setItem('txui-docs-os', os); }catch(e){}
}
(function initOS(){
  let os;
  try{ os = localStorage.getItem('txui-docs-os'); }catch(e){}
  if(!os){ os = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win'; }
  setOS(os);
})();

// ── theme ─────────────────────────────────────────────────────────────────────
function toggleTheme(){
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try{ localStorage.setItem('txui-docs-theme', next); }catch(e){}
}
(function initTheme(){
  let t;
  try{ t = localStorage.getItem('txui-docs-theme'); }catch(e){}
  if(t) document.documentElement.setAttribute('data-theme', t);
})();

// ── table filters ─────────────────────────────────────────────────────────────
function filterTable(inputId, tableId){
  const q = document.getElementById(inputId).value.toLowerCase().trim();
  const rows = document.querySelectorAll('#' + tableId + ' tbody tr');
  rows.forEach(r => {
    const hay = r.getAttribute('data-search') || r.textContent.toLowerCase();
    r.style.display = !q || hay.includes(q) ? '' : 'none';
  });
}
function filterEngine(selectId, tableId){
  const eng = document.getElementById(selectId).value;
  document.querySelectorAll('#' + tableId + ' tbody tr').forEach(r => {
    const engs = (r.getAttribute('data-engines') || '').split(' ');
    r.style.display = !eng || engs.includes(eng) ? '' : 'none';
  });
}
function filterAllTables(inputId, wrapId){
  const q = document.getElementById(inputId).value.toLowerCase().trim();
  document.querySelectorAll('#' + wrapId + ' tbody tr').forEach(r => {
    const hay = r.getAttribute('data-search') || r.textContent.toLowerCase();
    r.style.display = !q || hay.includes(q) ? '' : 'none';
  });
}

// ── global search across sections ─────────────────────────────────────────────
function globalSearch(q){
  q = q.toLowerCase().trim();
  const sections = document.querySelectorAll('.doc-section');
  const nores = document.getElementById('noresults');
  if(!q){ clearGlobal(); return; }
  let anyVisible = false;
  sections.forEach(sec => {
    if(sec.id === 'cheatsheet'){ sec.hidden = true; return; }
    // Match against panel-doc blocks, guide-doc blocks, table rows, and paragraphs.
    let hit = false;
    const blocks = sec.querySelectorAll('.panel-doc, .guide-doc');
    if(blocks.length){
      blocks.forEach(b => {
        const show = b.textContent.toLowerCase().includes(q);
        b.style.display = show ? '' : 'none';
        if(show) hit = true;
      });
    }
    const rows = sec.querySelectorAll('table.ref tbody tr');
    if(rows.length){
      rows.forEach(r => {
        const show = (r.getAttribute('data-search') || r.textContent.toLowerCase()).includes(q);
        r.style.display = show ? '' : 'none';
        if(show) hit = true;
      });
    }
    if(!blocks.length && !rows.length){
      hit = sec.textContent.toLowerCase().includes(q);
    }
    sec.hidden = !hit;
    if(hit) anyVisible = true;
  });
  nores.hidden = anyVisible;
}
function clearGlobal(){
  document.getElementById('globalSearch').value = '';
  document.querySelectorAll('.doc-section').forEach(s => s.hidden = false);
  document.querySelectorAll('.panel-doc, .guide-doc').forEach(b => b.style.display = '');
  document.querySelectorAll('table.ref tbody tr').forEach(r => r.style.display = '');
  const nr = document.getElementById('noresults'); if(nr) nr.hidden = true;
}

// ── scrollspy for the side nav ────────────────────────────────────────────────
(function scrollspy(){
  const links = [...document.querySelectorAll('.sidenav a')];
  const map = {};
  links.forEach(a => { const id = a.getAttribute('href').slice(1); const el = document.getElementById(id); if(el) map[id] = a; });
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if(e.isIntersecting){
        links.forEach(l => l.classList.remove('active'));
        if(map[e.target.id]) map[e.target.id].classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('.doc-section').forEach(s => obs.observe(s));
})();

// keyboard: '/' focuses search
document.addEventListener('keydown', e => {
  if(e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT'){
    e.preventDefault();
    document.getElementById('globalSearch').focus();
  }
});
