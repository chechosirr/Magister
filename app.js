"use strict";
/* =====================================================================
   Magister — biblioteca en línea (versión estática para GitHub Pages)

   Replica el preview aprobado por Sergio: apertura con vuelo del
   nombre al header, escaparate a pantalla completa, categorías como
   filas deslizables, buscador, «Mi biblioteca» y «Mi cuenta».

   El catálogo (portadas, títulos, autores y categorías) es estático y
   vive en data.js/covers.js. Los TEXTOS de los libros no están en la
   página: se servirán desde el servidor propio de Magister cuando
   exista (ver SERVICIO-CUENTAS.md). Hoy cada libro va con
   hasContent=false y su ficha muestra «Contenido en preparación».
   ===================================================================== */

/* ---------------------------------------------------------------
   Capa de API del servicio de cuentas (VPS, patrón Rager)

   SEPARACIÓN DE CUENTAS (orden de Sergio): las cuentas de Magister
   son completamente independientes de las de Rager aunque ambos
   servicios vivan en el mismo VPS. En concreto:
   - Magister tendrá su PROPIO almacén de cuentas y su PROPIA clave
     en el VPS; jamás se reutiliza el almacén ni la clave de Rager.
   - Los tokens de sesión de Magister llevan su propio ámbito
     (prefijo «mgst_») y solo los valida el servicio de Magister
     contra su almacén: un token de Rager NO autentica en Magister
     y un token de Magister NO autentica en Rager.
   - No hay inicio de sesión cruzado ni SSO entre ambos.
   - Aquí, en el navegador, el token se guarda solo bajo la clave
     «magister-token» y nunca se lee ninguna sesión de Rager.

   Mientras el servicio no exista en el VPS, MAGISTER_API_ENABLED
   queda en false y la página funciona en MODO MUESTRA: catálogo y
   diseño completos y navegables; el panel de «Mi cuenta» muestra el
   formulario con el aviso de activación. Ninguna cuenta se finge
   guardada en el navegador.
   --------------------------------------------------------------- */
const MAGISTER_API_BASE = "https://puente.ragerservices.net/magister";
const MAGISTER_API_ENABLED = true;
/* Los diccionarios del lector SÍ están activos en la página
   publicada: el servicio magister-dict corre en el puente y
   responde con CORS abierto a cualquier origen (verificado el
   7-nov-2026 con Origin: https://chechosirr.github.io). La API
   de cuentas/chat (la constante de arriba) no se toca en este
   portado: conserva el valor que ya trae cada copia. */
const MAGISTER_DICT_ENABLED = true;

const TOKEN_KEY = "magister-token";
const PREVIEW_CHAPTERS = 1;

const CATEGORIES = window.MAGISTER_CATEGORIES || [];
const BOOKS = (window.MAGISTER_BOOKS || []).map((b) => ({
  ...b,
  coverUrl: (window.MAGISTER_COVERS || {})[b.gid] || null,
}));
const HERO_IMG = window.MAGISTER_HERO || "";
const BOOK_BY_ID = new Map(BOOKS.map((b) => [b.id, b]));

const SPINE_COLORS = {
  "Filosofía": "#2e4a6b",
  "Política": "#6e2434",
  "Economía": "#1f5c4d",
  "Religión": "#7c5a10",
  "Medicina y Anatomía": "#0e6b6b",
  "Novela": "#7a1f1f",
  "Poesía": "#33523f",
  "Teatro": "#1f4e4a",
  "Cuentos": "#9a6a1d",
  "Ensayo e historia": "#5b4326",
  "Clásicos universales": "#274156",
};
function spineColor(category) {
  return SPINE_COLORS[category] || "#4a3b2a";
}

/* ------------------------------------------------------------ API */

function loadToken() {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function saveToken(t) {
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* almacenamiento no disponible: la sesión vive en memoria */ }
}

async function apiCall(path, { method = "GET", body, token: tk } = {}) {
  if (!MAGISTER_API_ENABLED) {
    const err = new Error("El servicio de cuentas de Magister aún no está activo.");
    err.code = "API_OFF";
    throw err;
  }
  const res = await fetch(MAGISTER_API_BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Error del servicio (${res.status})`);
  }
  return data;
}

const api = {
  login: (email, password) => apiCall("/auth/login", { method: "POST", body: { email, password } }),
  me: (tk) => apiCall("/auth/me", { token: tk }),
  logout: (tk) => apiCall("/auth/logout", { method: "POST", token: tk }),
  myLibrary: (tk) => apiCall("/library", { token: tk }),
  addToLibrary: (tk, bookId) => apiCall("/library/add", { method: "POST", body: { bookId }, token: tk }),
  removeFromLibrary: (tk, bookId) => apiCall("/library/remove", { method: "POST", body: { bookId }, token: tk }),
  toggleFavorite: (tk, bookId, favorite) => apiCall("/library/favorite", { method: "POST", body: { bookId, favorite }, token: tk }),
  getBookDetail: (tk, bookId) => apiCall(`/books/${bookId}`, { token: tk }),
  getChapter: (tk, bookId, chapterIndex) => apiCall(`/books/${bookId}/chapters/${chapterIndex}`, { token: tk }),
};

/* ------------------------------------------------------------ estado */

let token = loadToken();
let user = null;               // {id, name, email, subscribed, admin} cuando hay sesión
let libraryEntries = [];       // biblioteca personal (del servicio)
let view = { name: "home" };   // home | library | categories | search | account | detail | reader | chat | epub
let viewHistory = [];          // pila de vistas para la flecha de volver del header
let catalogHidden = new Set(); // ids pausados/eliminados en el servicio (no se muestran al público)
let libTab = "estante";        // sección de «Tu biblioteca»: "estante" | "favoritos" | "recientes"
const libFilter = { estante: "", favoritos: "", recientes: "" }; // buscador propio de cada sección (r32): término por sección, vivo mientras se está en la vista
let authNotice = false;        // aviso de «servicio en activación» tras intentar entrar en modo muestra
let authError = "";
let authBusy = false;
/* Sesión y botón «atrás» (corrección 2026-11-07, reforzada): si el
   navegador restaura la app desde su caché tras cerrarse la sesión en
   otro lado, la vista restaurada seguiría «con sesión». Tres capas:
   (1) un «unload» vacío deja la app fuera de la caché atrás/adelante
   de Safari/iOS, que al volver la recarga; (2) al volver a mostrarse
   congelada (pageshow) se compara el token actual con el de la carga
   y si cambió se recarga; (3) si la app vuelve a verse sin recargarse
   (estaba abierta en segundo plano) y la sesión ya no existe, se
   recarga. */
let sessBorn = null;
let sessShown = false;
window.addEventListener("pageshow", (e) => {
  const cur = loadToken() || "";
  if ((e.persisted || sessShown) && sessBorn !== null && cur !== sessBorn) location.reload();
  if (sessBorn === null) sessBorn = cur;
  sessShown = true;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sessBorn !== null && sessBorn !== "" && (loadToken() || "") === "") location.reload();
});
window.addEventListener("unload", () => {});

let detailData = null;         // ficha cargada desde el servicio (con sesión)
let detailState = "idle";      // idle | loading | error
let detailError = "";
let chapterData = null;        // capítulo cargado desde el servicio
let chapterState = "idle";
let chapterError = "";
let readerFontSize = 19;

let splashSeen = false;
try { splashSeen = !!window.sessionStorage.getItem("magister-splash-v1"); } catch { splashSeen = false; }
let splashActive = !splashSeen;
let revealed = splashSeen;

/* ------------------------------------------------------------ utilidades */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function normalizeText(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function bookMatches(book, query) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const title = normalizeText(book.title);
  const author = normalizeText(book.author);
  return tokens.every((t) => title.includes(t) || author.includes(t));
}
function errorText(e) { return e instanceof Error ? e.message : String(e); }

/* ------------------------------------------------------------ piezas */

function coverHtml(book, large = false) {
  if (book.coverUrl) {
    return `<img src="${book.coverUrl}" alt="Portada de ${esc(book.title)}" class="cover-img" loading="lazy">`;
  }
  const c = spineColor(book.category);
  return `<div aria-label="Portada de ${esc(book.title)}" class="cover-typo${large ? " large" : ""}" style="background: linear-gradient(150deg, ${c}, ${c}dd 55%, #00000055)">
    <p class="t">${esc(book.title)}</p><p class="a">${esc(book.author)}</p></div>`;
}

function bookCardHtml(book) {
  return `<button type="button" class="book-card" data-action="open-book" data-id="${book.id}" aria-label="Ver ${esc(book.title)} de ${esc(book.author)}">
    <span class="cover-box">${coverHtml(book)}</span>
    <p class="bt">${esc(book.title)}</p>
    <p class="ba">${esc(book.author)}</p>
    ${book.hasContent ? "" : `<p class="soon">Próximamente</p>`}
  </button>`;
}

const SEARCH_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>`;
function searchBoxHtml({ dark = false, initial = "" } = {}) {
  return `<form class="searchbox ${dark ? "dark" : "light"}" role="search" aria-label="Buscar libros" data-search-form>
    ${SEARCH_ICON}
    <input type="search" aria-label="Buscar libros por título o autor" placeholder="Busca por título o autor…" value="${esc(initial)}">
    <button type="submit">Buscar</button>
  </form>`;
}

/* Buscador propio de cada sección de «Tu biblioteca» (r32): mismo
   aspecto que el de «Buscar libros», ajustado a la columna de
   contenido. Filtra en vivo la lista de ESA sección (evento input)
   y cada sección conserva su propio término mientras se está en
   la vista; el envío del formulario no navega a ningún sitio. */
function libSearchBoxHtml() {
  const donde = { estante: "tu estante", favoritos: "tus favoritos", recientes: "tus recientes" }[libTab];
  return `<form class="searchbox light" role="search" aria-label="Buscar en ${donde}" data-lib-search-form>
    ${SEARCH_ICON}
    <input type="search" data-lib-search-input aria-label="Buscar en ${donde} por título o autor" placeholder="Busca por título o autor…" value="${esc(libFilter[libTab])}">
    <button type="submit">Buscar</button>
  </form>`;
}

const LOCK_SVG = `<span class="lock-badge"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:14px;height:14px"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Suscripción</span>`;

/* ------------------------------------------------------------ vistas */

function escaparateHtml() {
  return `<section aria-label="Escaparate de la biblioteca" class="escaparate">
    <img src="${HERO_IMG}" alt="" aria-hidden="true" class="bg" loading="eager" decoding="async">
    <div class="veil" aria-hidden="true"></div>
    <div class="front">
      <p class="eyebrow">Biblioteca en línea · Obras maestras en español</p>
      <p class="brand metallic-text">MAGISTER</p>
      <p class="lede">Los grandes clásicos en español. Con tu cuenta lees una muestra gratuita de cada libro; con la suscripción, la biblioteca completa.</p>
      <div class="search-slot">${searchBoxHtml({ dark: true })}</div>
    </div>
  </section>`;
}

/* Lista de la sección activa de «Tu biblioteca», ya filtrada por el
   término de SU buscador (r32). Sin término: los estados vacíos de
   siempre; con término y cero coincidencias: «Sin resultados…». El
   filtrado en vivo repinta SOLO este bloque para no perder el foco
   del campo de búsqueda. */
function libSectionBodyHtml() {
  const q = (libFilter[libTab] || "").trim();
  const sinResultados = `<p class="small dim" style="margin:0">Sin resultados para «${esc(q)}»</p>`;
  if (libTab === "recientes") {
    let recs = recientesGet();
    if (q) recs = recs.filter((r) => { const b = BOOK_BY_ID.get(r.id); return !!b && bookMatches(b, q); });
    if (recs.length === 0) {
      if (q) return sinResultados;
      return `<div class="card dashed">
      <p class="small dim" style="margin:0">Todavía no abres ningún libro en el lector. Cuando leas uno, aparecerá aquí para seguir donde ibas.</p>
      <button type="button" class="btn-primary pad mt-3" data-action="goto-categories">Explorar</button>
    </div>`;
    }
    return `<div class="grid-books">${recs.map((r) => {
        const book = BOOK_BY_ID.get(r.id);
        let enCurso = false;
        try { enCurso = !!window.localStorage.getItem("magister-epub-pos-" + r.gid); } catch { enCurso = false; }
        return `<div>
        ${bookCardHtml(book)}
        <p class="lib-meta">${enCurso ? "En curso · " : ""}${esc(recientesFecha(r.ts))}</p>
      </div>`;
      }).join("")}</div>`;
  }
  let entries = libTab === "favoritos" ? libraryEntries.filter((e) => e.favorite) : libraryEntries;
  if (q) entries = entries.filter((e) => bookMatches(e.book, q));
  if (entries.length === 0) {
    if (q) return sinResultados;
    return `<div class="card dashed">
      <p class="small dim" style="margin:0">${libTab === "favoritos"
        ? "Todavía no marcas ningún favorito. Toca la estrella en un libro de tu estante."
        : "Tu estante está vacío. Busca en las categorías y añade tu primer libro."}</p>
      <button type="button" class="btn-primary pad mt-3" data-action="goto-categories">Explorar</button>
    </div>`;
  }
  return `<div class="grid-books">${entries.map((entry) => {
      const book = entry.book;
      return `<div>
        ${bookCardHtml(book)}
        <p class="lib-meta">${entry.finished ? "✓ Terminado" : (entry.currentChapter > 0 || entry.lastReadAt) ? `Capítulo ${entry.currentChapter + 1}` : "Sin empezar"}</p>
        <div class="lib-actions">
          <button type="button" class="fav${entry.favorite ? " on" : ""}" data-action="lib-fav" data-id="${book.id}" data-fav="${entry.favorite ? "0" : "1"}" aria-label="${entry.favorite ? `Quitar ${esc(book.title)} de favoritos` : `Marcar ${esc(book.title)} como favorito`}">${entry.favorite ? "★" : "☆"}</button>
          <button type="button" class="remove" data-action="lib-remove" data-id="${book.id}" aria-label="Quitar ${esc(book.title)} de tu biblioteca">Quitar</button>
        </div>
      </div>`;
    }).join("")}</div>`;
}

function libraryHtml() {
  const finishedCount = libraryEntries.filter((e) => e.finished).length;
  const tabCard = (t, label) => `<button type="button" class="lib-tabcard${libTab === t ? " active" : ""}" data-action="lib-tab" data-t="${t}" aria-pressed="${libTab === t ? "true" : "false"}">${label}</button>`;
  return `<div class="view-pad">
    <h1 class="view-title">Tu biblioteca</h1>
    <p class="small dim mt-1">${libraryEntries.length} ${libraryEntries.length === 1 ? "libro" : "libros"} en tu estante · ${finishedCount} terminados</p>
    <div class="lib-rule" aria-hidden="true"></div>
    <div class="lib-split">
      <nav class="lib-side" aria-label="Secciones de tu biblioteca">
        ${tabCard("estante", "Tu estante")}
        ${tabCard("favoritos", "Favoritos")}
        ${tabCard("recientes", "Recientes")}
      </nav>
      <div class="lib-content">
        <div class="lib-search">${libSearchBoxHtml()}</div>
        <div class="lib-list">${libSectionBodyHtml()}</div>
      </div>
    </div>
  </div>`;
}

function categoriesHtml() {
  const active = view.category;
  if (!active) {
    const byCat = new Map(CATEGORIES.map((c) => [c, []]));
    for (const b of visibleBooks()) if (byCat.has(b.category)) byCat.get(b.category).push(b);
    return `<div class="view-pad">
      <h1 class="view-title center">Categorías</h1>
      <div>${CATEGORIES.map((name) => {
        const list = byCat.get(name) || [];
        return `<section class="cat-block" aria-label="Categoría ${esc(name)}">
          <div class="cat-section-head">
            <h2>${esc(name)}</h2>
            <button type="button" data-action="select-category" data-cat="${esc(name)}">Ver todo (${list.length}) ›</button>
          </div>
          ${list.length === 0
            ? `<p class="small dim mt-2">Aún no hay libros del catálogo en esta categoría.</p>`
            : `<div class="drag-row no-scrollbar mt-3" role="region" aria-label="Libros de ${esc(name)}, fila deslizable">${list.map((book) => `<div class="cell">${bookCardHtml(book)}</div>`).join("")}</div>`}
        </section>`;
      }).join("")}</div>
    </div>`;
  }
  const shown = visibleBooks().filter((b) => b.category === active);
  return `<div class="view-pad">
    <h1 class="view-title center">Categorías</h1>
    <h2 class="font-display" style="margin:12px 0 0;font-size:20px;font-weight:700">${esc(active)}</h2>
    ${shown.length === 0
      ? `<p class="small dim mt-4">Aún no hay libros del catálogo en esta categoría.</p>`
      : `<div class="grid-books mt-4">${shown.map((book) => bookCardHtml(book)).join("")}</div>`}
  </div>`;
}

function searchHtml() {
  const query = view.query || "";
  let body;
  if (query.trim() === "") {
    body = `<p class="small dim mt-6" style="margin-top:24px">Escribe el título de un libro o el nombre de un autor para buscar en todo el catálogo.</p>`;
  } else {
    const results = visibleBooks().filter((b) => bookMatches(b, query));
    body = `<p class="small dim" style="margin-top:24px">${results.length} ${results.length === 1 ? "resultado" : "resultados"} para «${esc(query)}»</p>` +
      (results.length === 0
        ? `<div class="card dashed mt-4">
             <p class="small dim" style="margin:0">Ningún libro del catálogo coincide con esa búsqueda. Prueba con otra palabra del título o con el apellido del autor.</p>
             <button type="button" class="btn-primary pad mt-3" data-action="goto-categories">Explorar categorías</button>
           </div>`
        : `<div class="grid-books mt-4">${results.map((book) => bookCardHtml(book)).join("")}</div>`);
  }
  return `<div class="view-pad">
    <h1 class="view-title">Buscar libros</h1>
    <div class="mt-4" style="max-width:448px">${searchBoxHtml({ initial: query })}</div>
    ${body}
  </div>`;
}

function detailGateHtml() {
  return `<div style="padding-top:32px">
    <section aria-label="Cuenta necesaria para leer" class="card account-center center-card">
      <h1 class="font-display" style="margin:0;font-size:20px;font-weight:900">Necesitas tu cuenta para abrir este libro</h1>
      <p class="small dim" style="margin:8px 0 0;line-height:1.625">Los libros de Magister se abren solo con cuenta. Inicia sesión para leer la muestra gratuita de cada libro.</p>
      <button type="button" class="btn-primary block mt-4" data-action="require-auth">Iniciar sesión</button>
    </section>
  </div>`;
}

function detailHtml() {
  const book = BOOK_BY_ID.get(view.bookId);
  if (!token) return detailGateHtml();
  if (!book) return `<div style="padding-top:40px"><p class="small">Libro no encontrado.</p></div>`;
  if (detailState === "loading" || detailState === "idle") {
    return `<p class="dim" style="padding-top:40px">Cargando el libro…</p>`;
  }
  if (detailState === "error" || !detailData) {
    return `<div style="padding-top:40px">
      <p role="alert" class="small">${esc(detailError || "Libro no encontrado.")}</p>
    </div>`;
  }
  const d = detailData;
  const b = d.book;
  const readLabel = d.inLibrary && d.currentChapter > 0
    ? `Seguir en el capítulo ${d.currentChapter + 1}`
    : d.subscribed ? "Leer ahora" : "Leer la muestra gratuita";
  return `<div class="view-pad">
    <div class="detail-flex">
      <div class="detail-cover">${coverHtml(b, true)}</div>
      <div style="min-width:0">
        <p class="cat-tag" style="color:${spineColor(b.category)}">${esc(b.category)}</p>
        <h1 class="detail-title">${esc(b.title)}</h1>
        <p class="mt-1" style="font-size:15px;color:var(--dim)">${esc(b.author)}</p>
        <p class="small dim mt-2">${d.hasContent
          ? `${d.chapters.length} ${d.chapters.length === 1 ? "capítulo" : "capítulos"} · Desde nuestro servidor propio`
          : "Portada de muestra · Contenido en preparación"}</p>
        <div class="btn-row">
          ${d.hasContent
            ? `<button type="button" class="btn-primary pad" data-action="read" data-id="${b.id}" data-ch="${d.inLibrary ? d.currentChapter : 0}">${readLabel}</button>`
            : `<button type="button" class="btn-disabled" disabled>Contenido en preparación</button>`}
          ${d.inLibrary
            ? `<button type="button" class="btn-ghost" data-action="detail-fav" data-id="${b.id}" data-fav="${d.favorite ? "0" : "1"}">${d.favorite ? "★ Favorito" : "☆ Favorito"}</button>`
            : `<button type="button" class="btn-outline-accent" data-action="detail-add" data-id="${b.id}">+ Tu biblioteca</button>`}
        </div>
      </div>
    </div>
    ${!d.hasContent ? `<section aria-label="Contenido en preparación" class="card brass mt-6">
      <h2 class="font-display" style="margin:0;font-size:16px;font-weight:700">Este libro todavía no tiene su texto cargado</h2>
      <p class="small dim" style="margin:4px 0 0;line-height:1.625">La portada se muestra como muestra visual del catálogo mientras creamos nuestro servidor propio de libros. Cuando el contenido de este título se cargue desde ahí, podrás leer aquí la muestra gratuita con tu cuenta y el libro completo con suscripción.</p>
    </section>` : ""}
    ${d.hasContent && !d.subscribed ? `<section aria-label="Muestra gratuita y suscripción" class="card brass mt-6">
      <h2 class="font-display" style="margin:0;font-size:16px;font-weight:700">Estás con la muestra gratuita</h2>
      <p class="small dim" style="margin:4px 0 0;line-height:1.625">Con tu cuenta puedes leer el primer capítulo de este libro. Para seguir leyendo el resto debes suscribirte a Magister.</p>
      <button type="button" class="btn-primary pad mt-3" data-action="subscribe">Quiero suscribirme</button>
    </section>` : ""}
    ${d.hasContent ? `<h2 class="font-display mt-8" style="font-size:18px;font-weight:700">Capítulos</h2>
      <ol class="chapter-list">${d.chapters.map((c) => {
        const locked = !d.subscribed && c.index >= d.previewChapters;
        return `<li><button type="button" data-action="read" data-id="${b.id}" data-ch="${c.index}">
          <span>${c.index + 1}. ${esc(c.title)}</span>
          ${locked ? LOCK_SVG : ""}
          ${d.inLibrary && c.index === d.currentChapter ? `<span class="here-badge">Aquí vas</span>` : ""}
          ${d.inLibrary && d.finished && c.index < d.currentChapter ? `<span class="small dim">✓</span>` : ""}
        </button></li>`;
      }).join("")}</ol>`
    : `<p class="small dim mt-8">Todavía no hay capítulos para mostrar: el contenido de este libro se cargará desde el servidor propio de Magister.</p>`}
  </div>`;
}

function renderParagraphs(body) {
  return body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const avg = lines.reduce((acc, l) => acc + l.length, 0) / Math.max(lines.length, 1);
    const isVerse = lines.length > 2 && avg < 42;
    if (isVerse) return `<p style="white-space:pre-line">${esc(lines.join("\n"))}</p>`;
    return `<p>${esc(lines.join(" ").replace(/\s+/g, " "))}</p>`;
  }).join("");
}

function readerHtml() {
  const top = `<div class="reader-top">
      <button type="button" class="back-link" data-action="reader-exit">← Salir del libro</button>
      <div class="font-btns">
        <button type="button" data-action="font-dec" aria-label="Reducir tamaño de letra">A−</button>
        <button type="button" data-action="font-inc" aria-label="Aumentar tamaño de letra">A+</button>
      </div>
    </div>`;
  if (chapterState === "loading" || chapterState === "idle") {
    return `<div style="padding-top:16px">${top}<p class="dim" style="margin-top:40px">Abriendo el libro…</p></div>`;
  }
  if (chapterState === "error") {
    return `<div style="padding-top:16px">${top}<p role="alert" class="small" style="margin-top:40px">No se pudo abrir el capítulo: ${esc(chapterError)}</p></div>`;
  }
  const d = chapterData;
  if (d.contentPending) {
    return `<div style="padding-top:16px">${top}
      <article class="reader-article">
        <p class="reader-kicker">${esc(d.title)}</p>
        <section aria-label="Contenido en preparación" class="card center-card" style="margin-top:24px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)">
          <h1 class="font-display" style="margin:0;font-size:24px;font-weight:900">Contenido en preparación</h1>
          <p class="dim" style="margin:12px auto 0;max-width:448px;font-size:15px;line-height:1.625">Este libro todavía no tiene su texto cargado. Su portada se muestra como muestra visual del catálogo mientras creamos nuestro servidor propio de libros; cuando el contenido se cargue desde ahí, podrás leerlo aquí.</p>
          <button type="button" class="btn-primary block mt-5" style="max-width:320px;margin-left:auto;margin-right:auto" data-action="reader-exit">Volver a la ficha del libro</button>
        </section>
      </article></div>`;
  }
  if (d.locked) {
    return `<div style="padding-top:16px">${top}
      <article class="reader-article">
        <p class="reader-kicker">${esc(d.title)}</p>
        <section aria-label="Suscripción necesaria para seguir leyendo" class="card center-card" style="margin-top:24px">
          <h1 class="font-display" style="margin:0;font-size:24px;font-weight:900">Hasta aquí llega la muestra gratuita</h1>
          <p class="dim" style="margin:12px auto 0;max-width:448px;font-size:15px;line-height:1.625">Ya leíste el capítulo de muestra de este libro. Para seguir leyendo «${esc(d.title)}» y el resto de la biblioteca debes suscribirte a Magister.</p>
          <button type="button" class="btn-primary block mt-5" style="max-width:320px;margin-left:auto;margin-right:auto" data-action="subscribe">Quiero suscribirme</button>
          <div class="mt-4"><button type="button" class="back-link" data-action="reader-chapter" data-ch="${d.previewChapters - 1}">← Volver a la muestra</button></div>
        </section>
      </article></div>`;
  }
  const showPaywallEnd = !d.subscribed && d.chapterIndex === d.previewChapters - 1 && d.chapterCount > d.previewChapters;
  const isEnd = d.chapterIndex >= d.chapterCount - 1;
  return `<div style="padding-top:16px">${top}
    <article class="reader-article">
      <p class="reader-kicker">${esc(d.title)}</p>
      <h1 class="reader-h">${esc(d.chapterTitle)}</h1>
      <div class="reader-body reader-text" style="font-size:${readerFontSize}px">${renderParagraphs(d.body)}</div>
      ${showPaywallEnd ? `<section aria-label="Fin de la muestra gratuita" class="card brass center-card" style="margin-top:40px">
        <h2 class="font-display" style="margin:0;font-size:18px;font-weight:700">Fin de la muestra gratuita</h2>
        <p class="small dim" style="margin:4px auto 0;max-width:448px;line-height:1.625">Esto es todo lo que incluye la muestra con tu cuenta. Para seguir leyendo este libro debes suscribirte a Magister.</p>
        <button type="button" class="btn-primary pad mt-3" data-action="subscribe">Quiero suscribirme</button>
      </section>` : ""}
      <div class="reader-nav">
        <div class="progress" role="progressbar" aria-label="Progreso del libro" aria-valuenow="${d.chapterIndex + 1}" aria-valuemin="1" aria-valuemax="${d.chapterCount}">
          <div style="width:${((d.chapterIndex + 1) / d.chapterCount) * 100}%"></div>
        </div>
        <p class="dim" style="margin:8px 0 0;text-align:center;font-size:12px">Capítulo ${d.chapterIndex + 1} de ${d.chapterCount}</p>
        <div class="reader-nav-row">
          <button type="button" class="btn-ghost" data-action="reader-chapter" data-ch="${d.chapterIndex - 1}" ${d.chapterIndex === 0 ? "disabled style=\"opacity:0.4\"" : ""}>← Anterior</button>
          <label><span style="position:absolute;left:-9999px">Ir al capítulo</span>
            <select aria-label="Ir al capítulo" data-chapter-select>
              ${Array.from({ length: d.chapterCount }, (_, i) => `<option value="${i}" ${i === d.chapterIndex ? "selected" : ""}>Capítulo ${i + 1}${!d.subscribed && i >= d.previewChapters ? " · Suscripción" : ""}</option>`).join("")}
            </select></label>
          <button type="button" class="btn-primary pad" data-action="reader-chapter" data-ch="${d.chapterIndex + 1}" ${isEnd ? "disabled style=\"opacity:0.4\"" : ""}>Siguiente →</button>
        </div>
        ${isEnd && (d.subscribed || d.chapterCount <= d.previewChapters) ? `<p class="font-display" style="margin:16px 0 0;text-align:center;font-size:18px;font-weight:700">Fin del libro. ¡Buena lectura!</p>` : ""}
      </div>
    </article></div>`;
}

function accountHtml() {
  if (!user) {
    return `<div class="account-head">
      <h1 class="view-title">Mi cuenta</h1>
      <p class="intro">Con tu cuenta guardas tu biblioteca personal y tu avance de lectura en este dispositivo.</p>
      <section aria-label="Acceso de lectores" class="card account-center" style="margin-top:24px">
        <h2 class="font-display" style="margin:0;font-size:18px;font-weight:700">Tu cuenta de lector</h2>
        <form id="auth-form" class="form-stack" style="margin-top:16px">
          <div class="field">
            <label for="auth-email">Correo electrónico</label>
            <input id="auth-email" type="email" required autocomplete="email" placeholder="tu@correo.com">
          </div>
          <div class="field">
            <label for="auth-password">Contraseña</label>
            <input id="auth-password" type="password" required minlength="6" autocomplete="current-password" placeholder="Mínimo 6 caracteres">
          </div>
          ${authError ? `<p role="alert" class="form-error">${esc(authError)}</p>` : ""}
          ${authNotice ? `<p class="form-note">El servicio de cuentas de Magister se está activando en nuestro servidor propio. Muy pronto podrás entrar con tu cuenta desde aquí; mientras tanto, el catálogo completo ya se puede explorar.</p>` : ""}
          <button type="submit" class="btn-primary block" ${authBusy ? "disabled" : ""}>${authBusy ? "Un momento…" : "Entrar a tu biblioteca"}</button>
          <button type="button" class="forgot-link" data-action="open-help">Olvidé mi contraseña</button>
        </form>
      </section>
    </div>`;
  }
  const finishedCount = libraryEntries.filter((e) => e.finished).length;
  const favoriteCount = libraryEntries.filter((e) => e.favorite).length;
  const initial = (user.name.trim().charAt(0) || "L").toUpperCase();
  return `<div style="padding-top:32px">
    <h1 class="view-title">Mi cuenta</h1>
    <section aria-label="Datos de tu cuenta" class="card" style="margin-top:20px">
      <div style="display:flex;align-items:center;gap:16px">
        <span class="avatar" aria-hidden="true">${esc(initial)}</span>
        <div style="min-width:0">
          <p class="font-display" style="margin:0;font-size:20px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.name)}</p>
          <p class="small dim" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.email)}</p>
        </div>
      </div>
      <dl class="count-grid" style="margin:24px 0 0;padding:0">
        <div class="cell"><dd class="num" style="margin:0">${libraryEntries.length}</dd><dt class="lab">En tu biblioteca</dt></div>
        <div class="cell"><dd class="num" style="margin:0">${finishedCount}</dd><dt class="lab">Terminados</dt></div>
        <div class="cell"><dd class="num" style="margin:0">${favoriteCount}</dd><dt class="lab">Favoritos</dt></div>
      </dl>
      <div class="sub-box">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <h2 class="font-display" style="margin:0;font-size:16px;font-weight:700">Suscripción</h2>
          <span class="sub-pill ${user.subscribed ? "on" : "off"}">${user.subscribed ? "Activa" : "Sin suscripción"}</span>
        </div>
        <p class="small dim" style="margin:8px 0 0;line-height:1.625">${user.subscribed
          ? "Tu cuenta tiene acceso completo: puedes leer todos los libros de la biblioteca."
          : "Con tu cuenta lees gratis el primer capítulo de cada libro. La suscripción a Magister abre la lectura completa de toda la biblioteca; muy pronto podrás activarla aquí mismo."}</p>
      </div>
      <button type="button" class="btn-primary block" style="margin-top:24px" data-action="goto-library">Ir a tu biblioteca</button>
    </section>
    <button type="button" class="btn-logout" data-action="logout">Cerrar sesión</button>
  </div>`;
}

/* ------------------------------------------------------------ shell */

const TABS = [
  { name: "home", label: "Inicio" },
  { name: "categories", label: "Explorar" },
  { name: "library", label: "Mi biblioteca" },
  { name: "account", label: "Mi cuenta" },
];

const root = document.getElementById("root");
let headerEl, navEl, mainEl, menuEl;

function buildShell() {
  root.innerHTML = `
    ${splashActive ? `<div class="prepaint" aria-hidden="true"><img src="${HERO_IMG}" alt="" loading="eager" decoding="async"></div>` : ""}
    <header id="site-header">
      <div class="header-inner">
        <button type="button" id="hdr-back" data-action="back" aria-label="Volver" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>
        <span id="magister-logo" class="metallic-text">MAGISTER</span>
        <button type="button" id="hdr-menu-btn" data-action="menu-open" aria-label="Abrir menú"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg></button>
      </div>
    </header>
    <div id="menu-scrim" data-action="menu-close" hidden></div>
    <aside id="side-menu" aria-label="Menú">
      <button type="button" class="menu-close" data-action="menu-close" aria-label="Cerrar menú">×</button>
      <nav id="menu-items"></nav>
    </aside>
    <main id="main"></main>
    <button type="button" id="help-fab" data-action="open-help" hidden>Ayuda</button>
    ${splashActive ? `<div id="splash" role="button" aria-label="Saltar la apertura de Magister">
      <div id="splash-title" class="metallic-text">MAGISTER</div>
      <p class="splash-tag">Tu biblioteca de clásicos.</p>
    </div>` : ""}`;
  headerEl = root.querySelector("#site-header");
  navEl = root.querySelector("#hdr-menu-btn");
  menuEl = root.querySelector("#menu-items");
  mainEl = root.querySelector("#main");
}

function render() {
  if (view.name !== "epub" && epubOpen) destroyEpubReader();
  const inReader = view.name === "reader";
  const inEpub = view.name === "epub";
  const inChat = view.name === "chat" || view.name === "chathist";
  headerEl.classList.toggle("hidden", inReader || inChat || inEpub);
  headerEl.classList.toggle("absolute", view.name === "home" && !inReader);
  headerEl.classList.toggle("sticky", view.name !== "home" && !inReader && !inChat && !inEpub);
  if (splashActive && !revealed) headerEl.classList.add("invisible");
  else headerEl.classList.remove("invisible");

  // Menú desplegable (☰ a la derecha del header): la navegación ya
  // no va en una fila de botones bajo el nombre. El contenido depende
  // de la sesión (ver menuHtml()).
  if (menuEl) menuEl.innerHTML = menuHtml();
  closeMenu();
  const backBtn = document.getElementById("hdr-back");
  // La flecha de volver SOLO aparece dentro de una sección: en el
  // inicio NUNCA (ni en la portada del administrador), aunque el
  // historial interno tenga entradas. Dentro de una sección siempre
  // se muestra y al tocarla se vuelve a la vista inmediatamente
  // anterior (goBack; sin historial, al inicio).
  const onHome = view.name === "home" || view.name === "admin-home";
  if (backBtn) backBtn.hidden = onHome || inReader || inChat || inEpub;

  const fab = document.getElementById("help-fab");
  // El flotante «Ayuda» SOLO vive en la página de inicio y en el
  // formulario de inicio de sesión (vista de cuenta sin sesión);
  // fuera de Explorar, categorías, fichas, lector, biblioteca y
  // cuenta con sesión (regla de Sergio).
  if (fab) fab.hidden = !(revealed && (view.name === "home" || (view.name === "account" && !token)));

  mainEl.className = inEpub ? "epub-main" : (view.name === "home" || inChat ? "" : "wrap");
  let html = "";
  if (view.name === "home") html = escaparateHtml();
  else if (view.name === "library") html = token ? libraryHtml() : `<p class="dim" style="padding-top:40px">Inicia sesión para ver tu biblioteca.</p>`;
  else if (view.name === "categories") html = categoriesHtml();
  else if (view.name === "search") html = searchHtml();
  else if (view.name === "detail") html = detailHtml();
  else if (view.name === "reader") html = readerHtml();
  else if (view.name === "epub") html = epubHtml();
  else if (view.name === "account") html = accountHtml();
  else if (view.name === "admin-home") html = adminHomeHtml();
  else if (view.name === "chat") html = chatViewHtml();
  else if (view.name === "chats") html = chatsViewHtml();
  else if (view.name === "chathist") html = chatHistHtml();
  if (view.name !== "home" && view.name !== "chat" && view.name !== "chathist" && view.name !== "admin-home" && view.name !== "epub") {
    html += `<footer class="site-footer"><p>Catálogo en preparación: los libros se servirán desde el servidor propio de Magister. Las portadas se muestran como muestra visual del catálogo mientras se carga el contenido.</p></footer>`;
  }
  mainEl.innerHTML = html;
  if (view.name === "epub") {
    if (epubOpen && !mainEl.querySelector("#epub-viewer iframe")) destroyEpubReader();
    if (!epubOpen) initEpubReader();
  }
  attachDragRows();
  enhancePasswordEyes(mainEl);
}


/* ------------------------------------------------------ menú ☰ */

/* Contenido del menú desplegable según la sesión:
   - Administrador: sus funciones de la consola (Libros · Usuarios ·
     Top 100 · Registro de suscripciones · Ajustes de cuenta · Chat),
     que viven en el servicio y se abren con el traspaso de sesión.
   - Sin sesión o sesión normal: la navegación de la página.
   - Con cualquier sesión iniciada, al final: «Cerrar sesión» en rojo. */
const CONSOLE_BASE = "https://puente.ragerservices.net/magister/chat/admin";
function menuHtml() {
  const items = [];
  if (user && user.admin) {
    const t = encodeURIComponent(token || "");
    const link = (label, path) => `<a class="mi" href="${CONSOLE_BASE}${path}#t=${t}">${label}</a>`;
    items.push(link("Libros", "/libros"));
    items.push(link("Usuarios", "/usuarios"));
    items.push(link("Top 100", "/top"));
    items.push(link("Registro de suscripciones", "/suscripciones"));
    items.push(link("Ajustes de cuenta", "/ajustes"));
    items.push(link("Chat", "/chat"));
  } else {
    const cur = view.name;
    const tab = (name, label) => `<button type="button" class="mi${cur === name ? " active" : ""}" data-action="nav" data-tab="${name}">${label}</button>`;
    items.push(tab("home", "Inicio"));
    items.push(tab("categories", "Explorar"));
    items.push(tab("library", "Mi biblioteca"));
    items.push(`<button type="button" class="mi" data-action="open-chat">Pídenos tu libro</button>`);
    items.push(`<button type="button" class="mi" data-action="open-chats">Mis chats</button>`);
    items.push(tab("account", "Mi cuenta"));
  }
  if (token) items.push(`<button type="button" class="mi logout" data-action="logout">Cerrar sesión</button>`);
  return items.join("");
}

function openMenu() {
  const m = document.getElementById("side-menu");
  const sc = document.getElementById("menu-scrim");
  if (m) m.classList.add("open");
  if (sc) sc.hidden = false;
}
function closeMenu() {
  const m = document.getElementById("side-menu");
  const sc = document.getElementById("menu-scrim");
  if (m) m.classList.remove("open");
  if (sc) sc.hidden = true;
}

/* ------------------------------------------- volver (historial) */

function goBack() {
  const prev = viewHistory.pop();
  if (prev) { view = prev; render(); window.scrollTo(0, 0); }
  else { viewHistory = []; view = { name: "home" }; render(); window.scrollTo(0, 0); }
}

/* --------------------------------------- catálogo según servicio */

function visibleBooks() {
  return BOOKS.filter((b) => !catalogHidden.has(String(b.id)));
}

async function refreshCatalogState() {
  if (!MAGISTER_API_ENABLED) return;
  try {
    const j = await apiCall("/chat/catalogo-estado");
    const estados = (j && j.estados) || {};
    catalogHidden = new Set(Object.keys(estados).filter((k) => estados[k] === "pausado" || estados[k] === "eliminado"));
    render();
  } catch { /* sin conexión: se muestra el catálogo completo */ }
}

/* --------------------------------------------- ojos de contraseña */

const EYE_ON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
function enhancePasswordEyes(scope) {
  if (!scope) return;
  scope.querySelectorAll('input[type="password"]').forEach((inp) => {
    if (inp.dataset.eye) return;
    inp.dataset.eye = "1";
    const wrap = document.createElement("span");
    wrap.className = "pwwrap";
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pweye";
    b.setAttribute("aria-label", "Mostrar u ocultar la contraseña");
    b.innerHTML = EYE_ON_SVG;
    b.addEventListener("click", () => {
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_OFF_SVG : EYE_ON_SVG;
    });
    wrap.appendChild(b);
  });
}

function go(next, opts) {
  if (next.name !== "chat") chatStopPolling();
  if (opts && opts.replace) {
    view = next;
  } else if (next.name === "home" || next.name === "admin-home") {
    viewHistory = [];
    view = next;
  } else {
    viewHistory.push(view);
    view = next;
  }
  render();
  window.scrollTo(0, 0);
  if (next.name === "chat") chatStart();
}

/* Sin cuenta no se abre ningún libro: tocar uno lleva al lector a
   «Mi cuenta» para iniciar sesión (el servidor también lo exigirá). */
function openBook(bookId) {
  if (!token) { go({ name: "account" }); return; }
  if (MAGISTER_API_ENABLED) apiCall("/chat/lectura", { method: "POST", body: { id: bookId } }).catch(() => {});
  const book = BOOK_BY_ID.get(bookId);
  if (book && book.epub) {
    /* Libro con EPUB en la bodega: el lector se abre con ESTE
       libro (el servicio de lectura aplica el modelo de acceso:
       muestra del primer capítulo o libro completo). */
    epubCurrent = { id: book.id, gid: book.gid, title: book.title, author: book.author, acceso: null };
    recientesAdd(book);
    epubEnsureLibrary(bookId);
    go({ name: "epub" });
    return;
  }
  detailState = "loading"; detailData = null; detailError = "";
  go({ name: "detail", bookId });
  api.getBookDetail(token, bookId).then((d) => {
    detailData = d; detailState = "done"; if (view.name === "detail") render();
  }).catch((e) => {
    detailState = "error"; detailError = errorText(e); if (view.name === "detail") render();
  });
}

/* Al abrir un libro en el lector queda también en «Tu biblioteca»
   (si aún no estaba), para que el estante refleje lo leído. */
function epubEnsureLibrary(bookId) {
  if (!token || !MAGISTER_API_ENABLED) return;
  if (libraryEntries.some((e) => e.book && e.book.id === bookId)) return;
  api.addToLibrary(token, bookId)
    .then(() => api.myLibrary(token))
    .then((lib) => { libraryEntries = lib.entries || []; })
    .catch(() => { /* el estante se refresca en la próxima visita */ });
}

/* ------------------------------------------- recientes (local) */

/* Últimos libros abiertos en el lector, en este dispositivo:
   máximo 10, del más reciente al más antiguo, sin duplicados
   (reabrir un libro lo sube al frente). */
const RECIENTES_KEY = "magister-recientes-v1";
function recientesGet() {
  let a = null;
  try { a = JSON.parse(window.localStorage.getItem(RECIENTES_KEY) || "[]"); } catch { return []; }
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const r of a) {
    if (!r || typeof r !== "object" || !BOOK_BY_ID.has(r.id)) continue;
    out.push({ id: r.id, gid: r.gid, title: String(r.title || ""), author: String(r.author || ""), ts: typeof r.ts === "number" ? r.ts : 0 });
    if (out.length >= 10) break;
  }
  return out;
}
function recientesAdd(book) {
  try {
    const list = recientesGet().filter((r) => r.gid !== book.gid);
    list.unshift({ id: book.id, gid: book.gid, title: book.title, author: book.author, ts: Date.now() });
    window.localStorage.setItem(RECIENTES_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* sin almacenamiento */ }
}
function recientesFecha(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const mismoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mismoDia(d, new Date())) return "Hoy";
  if (mismoDia(d, new Date(Date.now() - 86400000))) return "Ayer";
  return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

function openChapter(bookId, chapter) {
  chapterState = "loading"; chapterData = null; chapterError = "";
  go({ name: "reader", bookId, chapter });
  api.getChapter(token, bookId, chapter).then((d) => {
    chapterData = d; chapterState = "done"; if (view.name === "reader") render();
  }).catch((e) => {
    chapterState = "error"; chapterError = errorText(e); if (view.name === "reader") render();
  });
}

async function refreshSession() {
  if (!token || !MAGISTER_API_ENABLED) return;
  try {
    const me = await api.me(token);
    if (!me.user) { saveToken(null); token = null; user = null; return; }
    user = me.user;
    const lib = await api.myLibrary(token);
    libraryEntries = lib.entries || [];
    render();
    maybeShowAdminWelcome();
  } catch { /* sin conexión con el servicio: se sigue en modo muestra */ }
}

/* ------------------------------------------------ bienvenida admin */

/* Experiencia de administrador (solo cuentas con admin=true): la
   página «Bienvenido, señor.» es su PÁGINA DE INICIO (vista
   admin-home), no una pantalla pasajera: al iniciar sesión — o al
   restaurarse la sesión — con una cuenta admin, la app aterriza en
   esa vista limpia, con la cabecera y su navegación de siempre
   (donde están «Chat» y «Cuentas»). Las cuentas normales nunca la
   ven: entran al escaparate como siempre. */
let adminWelcomeDeferred = false;

function adminHomeHtml() {
  // Pantalla estática (orden de Sergio): solo «Bienvenido, señor.»
  // en grande, centrado; sin textos descriptivos ni contenido extra.
  return `<div class="admin-home"><p class="admin-welcome-title">Bienvenido, señor.</p></div>`;
}

function maybeShowAdminWelcome() {
  if (!user || !user.admin) return;
  if (splashActive && !revealed) { adminWelcomeDeferred = true; return; }
  if (view.name !== "admin-home") go({ name: "admin-home" }, { replace: true });
}

function closeAdminWelcome() {
  const el = document.getElementById("admin-welcome");
  if (el) el.remove();
}

/* ------------------------------------------------------------ chat */

/* Chat interno de Magister (servicio propio en el VPS, rutas
   /magister/chat/... tras MAGISTER_API_BASE). Pantalla completa con
   estructura de app de mensajería y DOS entradas (órdenes de Sergio):

   - «Pídenos tu libro» (botón del header): SOLO con cuenta. La
     conversación es la de la cuenta y al crearla llega el saludo
     automático con el nombre del perfil: «Hola, {nombre}, ¿Qué libro
     te gustaría que agregáramos para ti?»
   - «Ayuda» (botón fijo abajo a la derecha, solo en Inicio): entra
     cualquiera, con cuenta o sin ella. Sin cuenta, el visitante deja
     su nombre (flujo libre de la v1, conversación en su navegador).
     El saludo automático de esta entrada NO lleva nombre: «Hola,
     ¿cómo podemos ayudarte hoy?»

   Una sola conversación por cuenta; sondeo corto (sin websockets). */
const CHAT_CONV_KEY = "magister-chat-conv";
const CHAT_NAME_KEY = "magister-chat-name";
const CHAT_CONTACT_KEY = "magister-chat-contact";

const CHAT_EXPLAIN = {
  libro: "¿No encuentras un libro en la biblioteca? Pídelo aquí: dinos cuál buscas y lo subimos para ti. También puedes escribirnos por cualquier otra cosa.",
  ayuda: "Escríbenos aquí lo que necesites: te respondemos en cuanto podamos.",
};

function chatLoad(key) { try { return window.localStorage.getItem(key) || ""; } catch { return ""; } }
function chatSave(key, val) { try { if (val) window.localStorage.setItem(key, val); else window.localStorage.removeItem(key); } catch { /* sin almacenamiento */ } }

let chatIntent = "libro";        // "libro" | "ayuda": última entrada usada
let chatAnonConv = chatLoad(CHAT_CONV_KEY);
/* Registro local de conversaciones anónimas de ESTE dispositivo
   («Mis chats»): cada conversación usada queda anotada; las
   finalizadas siguen en la lista para poder releerlas. */
const CHAT_CONVS_KEY = "magister-chat-convs";
function chatAnonIds() { try { return JSON.parse(chatLoad(CHAT_CONVS_KEY) || "[]") || []; } catch { return []; } }
function chatNoteAnonConv(id) {
  if (!id) return;
  const ids = chatAnonIds();
  if (!ids.includes(id)) { ids.push(id); while (ids.length > 30) ids.shift(); chatSave(CHAT_CONVS_KEY, JSON.stringify(ids)); }
}
if (chatAnonConv) chatNoteAnonConv(chatAnonConv);
let chatAnonStarted = !!chatLoad(CHAT_NAME_KEY);
let chatAcctMsgs = [];           // mensajes de la conversación de la cuenta
let chatAnonMsgs = [];           // mensajes de la conversación anónima
let chatPollTimer = null;
let chatSending = false;
let chatClosed = false;          // true tras «Finalizar chat» (cierre visible)
let chatReturn = { name: "home" };

function chatMode() { return token ? "account" : "anon"; }
function chatMsgs() { return chatMode() === "account" ? chatAcctMsgs : chatAnonMsgs; }
function chatSetMsgs(list) { if (chatMode() === "account") chatAcctMsgs = list; else chatAnonMsgs = list; }

async function chatFetch(path, opts = {}) {
  const res = await fetch(MAGISTER_API_BASE + "/chat" + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error del chat (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function chatTime(ts) {
  try { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

function chatMsgsHtml() {
  const msgs = chatMsgs();
  if (msgs.length === 0) {
    return `<p class="chat-empty">${chatMode() === "anon" && !chatAnonConv ? "Escribe tu mensaje y te respondemos en este mismo chat." : "Cargando la conversación…"}</p>`;
  }
  return msgs.map((m) => {
    const mine = m.f === "v";
    return `<div class="chat-msg ${mine ? "mine" : "theirs"}">
      <div class="chat-bubble">${esc(m.t)}</div>
      <p class="chat-meta">${mine ? "Tú" : "Magister"} · ${chatTime(m.ts)}</p>
    </div>`;
  }).join("");
}

function chatViewHtml() {
  const anonNeedsIntro = chatMode() === "anon" && !chatAnonConv && !chatAnonStarted;
  return `<div class="chatview">
    <div class="chatview-head">
      <button type="button" class="chatview-back" data-action="chat-back" aria-label="Volver">←</button>
      <div class="chatview-head-text">
        <p class="chatview-title">Magister</p>
        <p class="chatview-sub">${chatIntent === "libro" ? "Pídenos tu libro" : "Ayuda"}</p>
      </div>
      ${!anonNeedsIntro ? (chatClosed ? `<button type="button" class="chatview-endbtn" data-action="chat-new">Iniciar un chat nuevo</button>` : `<button type="button" class="chatview-endbtn" data-action="chat-finalize">Finalizar chat</button>`) : ""}
    </div>
    <p class="chatview-welcome">${esc(CHAT_EXPLAIN[chatIntent])}</p>
    ${anonNeedsIntro ? `<form id="chat-intro" class="chat-intro form-stack">
      <div class="field">
        <label for="chat-name">¿Cómo te llamas?</label>
        <input id="chat-name" type="text" required maxlength="60" autocomplete="name" placeholder="Tu nombre" value="${esc(chatLoad(CHAT_NAME_KEY))}">
      </div>
      <div class="field">
        <label for="chat-contact">Contacto (opcional: WhatsApp o correo)</label>
        <input id="chat-contact" type="text" maxlength="120" autocomplete="email" placeholder="Opcional" value="${esc(chatLoad(CHAT_CONTACT_KEY))}">
      </div>
      <p class="chat-error" role="alert" hidden></p>
      <button type="submit" class="btn-primary block">Empezar chat</button>
    </form>` : `<div id="chat-msgs" class="chatview-msgs" aria-live="polite">${chatMsgsHtml()}</div>
    <p class="chat-error" role="alert" hidden></p>
    ${chatClosed ? `<div class="chat-closed">
      <p class="chat-closed-title">Chat finalizado. Gracias por escribirnos.</p>
      <p class="chat-closed-sub">Si necesitas algo más, puedes empezar un chat nuevo.</p>
    </div>` : `<form id="chat-form" class="chatview-composer">
      <textarea id="chat-text" rows="1" maxlength="1000" placeholder="Escribe un mensaje…" aria-label="Escribe un mensaje"></textarea>
      <button type="submit" class="chat-send" aria-label="Enviar mensaje">➤</button>
    </form>`}`}
  </div>`;
}

function chatScrollBottom() {
  const el = document.getElementById("chat-msgs");
  if (el) el.scrollTop = el.scrollHeight;
}

function chatShowError(msg) {
  const err = document.querySelector(".chatview .chat-error");
  if (err) { err.textContent = msg || ""; err.hidden = !msg; }
}

async function chatPoll() {
  if (chatClosed) return;
  const mode = chatMode();
  if (mode === "anon" && !chatAnonConv) return;
  try {
    const after = chatMsgs().length;
    const q = mode === "account"
      ? `/poll?after=${after}&intent=${chatIntent}`
      : `/poll?conv=${encodeURIComponent(chatAnonConv)}&after=${after}`;
    const data = await chatFetch(q);
    if (data.messages && data.messages.length > 0) {
      chatSetMsgs(chatMsgs().concat(data.messages));
      const box = document.getElementById("chat-msgs");
      if (box) { box.innerHTML = chatMsgsHtml(); chatScrollBottom(); }
    }
    if (data.finalizada) {
      chatClosed = true;
      chatStopPolling();
      if (view.name === "chat") render();
    }
  } catch (e) {
    if (e.status === 401 && mode === "account") {
      // La sesión ya no vale: fuera del chat y a «Mi cuenta».
      chatStopPolling();
      saveToken(null); token = null; user = null; chatAcctMsgs = [];
      go({ name: "account" });
      return;
    }
    if (mode === "anon" && String(e.message || "").includes("no encontrada")) {
      // La conversación anónima ya no existe en el servidor: de cero.
      chatAnonConv = ""; chatAnonMsgs = []; chatSave(CHAT_CONV_KEY, "");
      if (view.name === "chat") render();
    }
    /* otros errores de red: se reintenta en el siguiente sondeo */
  }
}

function chatResetForNew() {
  chatClosed = false;
  if (chatMode() === "account") { chatAcctMsgs = []; }
  else { chatAnonConv = ""; chatAnonMsgs = []; chatAnonStarted = false; chatSave(CHAT_CONV_KEY, ""); }
}

/* «Finalizar chat» (orden de Sergio, todas las páginas): la
   conversación queda marcada como finalizada en el servidor (con
   cuenta, se archiva y la siguiente será nueva con su saludo) y el
   cliente ve el cierre; el historial no se borra del panel. */
async function chatFinalize() {
  try {
    if (chatMode() === "account") await chatFetch("/finalizar", { method: "POST", body: "{}" });
    else if (chatAnonConv) await chatFetch("/finalizar", { method: "POST", body: JSON.stringify({ conv: chatAnonConv }) });
  } catch (e) { /* si falla la red, se cierra localmente igual */ }
  chatClosed = true;
  chatStopPolling();
  if (view.name === "chat") render();
}

let chatOpening = false;
/* El saludo existe DESDE que el cliente entra al chat (orden de
   Sergio): al abrir —con cuenta, directo; el visitante, al tocar
   «Empezar chat»— la conversación se crea en el servidor con su
   saludo ya puesto, sin esperar a su primer mensaje. */
async function chatEnsureOpen() {
  if (chatOpening || chatClosed) return;
  if (chatMode() === "anon" && (!chatAnonStarted || chatAnonConv)) { chatPoll(); return; }
  chatOpening = true;
  try {
    if (chatMode() === "account") {
      await chatFetch("/open", { method: "POST", body: JSON.stringify({ intent: chatIntent }) });
    } else {
      const r = await chatFetch("/open", { method: "POST", body: JSON.stringify({ name: chatLoad(CHAT_NAME_KEY), contact: chatLoad(CHAT_CONTACT_KEY), intent: "ayuda" }) });
      if (r && r.conv) { chatAnonConv = r.conv; chatSave(CHAT_CONV_KEY, chatAnonConv); chatNoteAnonConv(chatAnonConv); }
    }
  } catch { /* sin red o sesión caída: el sondeo de abajo reintenta o expulsa */ }
  chatOpening = false;
  chatPoll();
}

function chatStart() {
  if (chatClosed) chatResetForNew();
  chatScrollBottom();
  chatEnsureOpen();
  if (!chatPollTimer) chatPollTimer = window.setInterval(chatPoll, 4000);
  const first = document.querySelector(".chatview input, .chatview textarea");
  if (first && chatMode() === "account") first.focus({ preventScroll: true });
}

function chatStopPolling() {
  if (chatPollTimer) { window.clearInterval(chatPollTimer); chatPollTimer = null; }
}

/* Entrada «Pídenos tu libro»: solo con cuenta (sin sesión → «Mi cuenta»).
   Entrada «Ayuda»: cualquiera, con cuenta o sin ella. */
function openChat(intent) {
  if (intent === "libro" && !token) { go({ name: "account" }); return; }
  chatIntent = intent;
  if (view.name !== "chat") chatReturn = { ...view };
  go({ name: "chat" });
}

/* -------------------------------- «Mis chats»: el registro del cliente
   La entrada vive en el menú ☰. Con cuenta, el registro sale de
   SU cuenta (la conversación activa y las finalizadas archivadas,
   en solo lectura); sin cuenta, de las conversaciones de este
   dispositivo. La activa abre el chat normal para seguir
   escribiendo; cualquier otra se lee con /conv en solo lectura. */
let chatHistList = null;   // null = cargando
let chatHistView = null;   // { msgs, finalizada } del hilo en lectura

function chatFecha(ts) {
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString("es", { day: "numeric", month: "short" }) + " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function chatsViewHtml() {
  let body;
  if (chatHistList === null) body = `<p class="dim">Cargando…</p>`;
  else if (!chatHistList.length) body = `<p class="dim">Todavía no tienes chats guardados.</p>`;
  else body = chatHistList.map((it) => `<button type="button" class="chats-item" data-action="chats-open" data-conv="${esc(it.conv)}" data-fin="${it.finalizada ? "1" : "0"}" data-act="${it.activa && !it.finalizada ? "1" : "0"}">
      <span class="chats-d">${esc(chatFecha(it.updated || it.created))}</span><span class="chats-tag${it.activa && !it.finalizada ? " on" : ""}">${it.finalizada ? "Finalizada" : (it.activa ? "Activa" : "Anterior")}</span>
      <span class="chats-p">${esc((it.last_f === "v" ? "Tú: " : "") + (it.last || ""))}</span>
    </button>`).join("");
  return `<section class="chatsview">
    <h2 class="chats-title">Mis chats</h2>
    <p class="dim">Tu registro de conversaciones con Magister. La activa se puede seguir escribiendo; las finalizadas quedan en solo lectura.</p>
    <div class="chats-list">${body}</div>
  </section>`;
}

async function loadChatsList() {
  chatHistList = null;
  if (view.name === "chats") render();
  try {
    const j = token
      ? await chatFetch("/myhistory")
      : await chatFetch("/myhistory", { method: "POST", body: JSON.stringify({ ids: chatAnonIds() }) });
    chatHistList = (j && j.chats) || [];
  } catch { chatHistList = []; }
  if (view.name === "chats") render();
}

function openChats() {
  go({ name: "chats" });
  loadChatsList();
}

async function openChatHist(conv, fin) {
  chatHistView = null;
  go({ name: "chathist" });
  try {
    const j = await chatFetch("/conv?conv=" + encodeURIComponent(conv));
    chatHistView = { msgs: (j && j.messages) || [], finalizada: !!(j && j.finalizada) };
  } catch { chatHistView = { msgs: [], finalizada: fin }; }
  if (view.name === "chathist") render();
}

function chatHistHtml() {
  if (!chatHistView) {
    return `<div class="chatview"><div class="chatview-head">
      <button type="button" class="chatview-back" data-action="chats-back" aria-label="Volver">←</button>
      <div class="chatview-head-text"><p class="chatview-title">Magister</p><p class="chatview-sub">Solo lectura</p></div>
    </div><p class="chat-empty" style="padding:26px 16px">Cargando la conversación…</p></div>`;
  }
  const msgs = chatHistView.msgs.map((m) => {
    const mine = m.f === "v";
    return `<div class="chat-msg ${mine ? "mine" : "theirs"}">
      <div class="chat-bubble">${esc(m.t)}</div>
      <p class="chat-meta">${mine ? "Tú" : "Magister"} · ${chatTime(m.ts)}</p>
    </div>`;
  }).join("");
  return `<div class="chatview">
    <div class="chatview-head">
      <button type="button" class="chatview-back" data-action="chats-back" aria-label="Volver">←</button>
      <div class="chatview-head-text">
        <p class="chatview-title">Magister</p>
        <p class="chatview-sub">${chatHistView.finalizada ? "Conversación finalizada" : "Conversación anterior"} · solo lectura</p>
      </div>
    </div>
    <div class="chatview-msgs">${msgs || `<p class="chat-empty">Sin mensajes.</p>`}</div>
  </div>`;
}

/* Pantalla de datos del visitante (igual que la de NEXO): solo pide
   nombre y contacto; al tocar «Empezar chat» aparece la conversación
   y esta se crea EN ESE MOMENTO en el servidor, con su saludo
   automático sin nombre ya puesto. */
function chatStartAnon(form) {
  const name = form.querySelector("#chat-name").value.trim();
  const contact = form.querySelector("#chat-contact").value.trim();
  if (!name) { chatShowError("Dinos tu nombre para poder responderte."); return; }
  chatSave(CHAT_NAME_KEY, name);
  chatSave(CHAT_CONTACT_KEY, contact);
  chatAnonStarted = true;
  render();
  chatEnsureOpen();
}

async function chatSendMessage(form) {
  if (chatSending) return;
  const input = form.querySelector("#chat-text");
  const text = input.value.trim();
  if (!text) return;
  chatSending = true; chatShowError("");
  try {
    let body;
    if (chatMode() === "account") body = { text, intent: chatIntent };
    else if (chatAnonConv) body = { conv: chatAnonConv, text };
    else body = { name: chatLoad(CHAT_NAME_KEY), contact: chatLoad(CHAT_CONTACT_KEY), text, intent: "ayuda" };
    const r = await chatFetch("/send", { method: "POST", body: JSON.stringify(body) });
    if (chatMode() === "anon" && !chatAnonConv && r && r.conv) {
      chatAnonConv = r.conv;
      chatSave(CHAT_CONV_KEY, chatAnonConv);
      chatNoteAnonConv(chatAnonConv);
    }
    input.value = "";
    input.style.height = "auto";
    await chatPoll();
  } catch (e) {
    if (e.status === 409) {
      // El servidor ya la tiene por finalizada: cierre local.
      chatClosed = true; chatStopPolling();
      if (view.name === "chat") render();
      return;
    }
    chatShowError(`No se pudo enviar: ${errorText(e)}`);
  } finally { chatSending = false; }
}

document.addEventListener("submit", (e) => {
  if (e.target.id === "chat-intro") { e.preventDefault(); chatStartAnon(e.target); }
  else if (e.target.id === "chat-form") { e.preventDefault(); chatSendMessage(e.target); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.id === "chat-text") {
    e.preventDefault();
    const form = document.getElementById("chat-form");
    if (form) chatSendMessage(form);
  }
});

/* ------------------------------------------------- filas deslizables */

function attachDragRows() {
  mainEl.querySelectorAll(".drag-row").forEach((el) => {
    if (el.dataset.dragReady) return;
    el.dataset.dragReady = "1";
    const drag = { down: false, startX: 0, startLeft: 0, moved: false };
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      drag.down = true; drag.startX = e.clientX; drag.startLeft = el.scrollLeft; drag.moved = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag.down) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 6) drag.moved = true;
      el.scrollLeft = drag.startLeft - dx;
    });
    const up = () => { drag.down = false; };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", (e) => {
      if (drag.moved) { e.preventDefault(); e.stopPropagation(); drag.moved = false; }
    }, true);
  });
}

/* ------------------------------------------------------------ eventos */

document.addEventListener("click", async (e) => {
  const splash = document.getElementById("splash");
  if (splash && e.target.closest("#splash")) { finishSplash(); return; }
  if (e.target.closest("#side-menu a")) closeMenu();
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.closest("#side-menu")) closeMenu();
  const action = el.dataset.action;
  const id = Number(el.dataset.id || 0);
  if (action === "menu-open") openMenu();
  else if (action === "menu-close") closeMenu();
  else if (action === "back") goBack();
  else if (action === "nav") {
    const tab = el.dataset.tab;
    viewHistory = [];
    if ((tab === "library" || tab === "account") && !token) { go({ name: "account" }, { replace: true }); return; }
    if (tab === "categories") go({ name: "categories" }, { replace: true });
    else if (tab === "library") go({ name: "library" }, { replace: true });
    else if (tab === "account") go({ name: "account" }, { replace: true });
    else go({ name: "home" });
  }
  else if (action === "open-book") openBook(id);
  else if (action === "select-category") go({ name: "categories", category: el.dataset.cat });
  else if (action === "back-categories") goBack();
  else if (action === "goto-categories") go({ name: "categories" });
  else if (action === "open-chat") openChat("libro");
  else if (action === "open-help") openChat("ayuda");
  else if (action === "admin-welcome-close") closeAdminWelcome();
  else if (action === "chat-back") go(chatReturn.name ? chatReturn : { name: "home" });
  else if (action === "open-chats") openChats();
  else if (action === "chats-open") {
    if (el.dataset.act === "1") openChat(chatIntent);
    else openChatHist(el.dataset.conv, el.dataset.fin === "1");
  }
  else if (action === "chats-back") go({ name: "chats" });
  else if (action === "chat-finalize") chatFinalize();
  else if (action === "chat-new") { chatResetForNew(); render(); chatStart(); }
  else if (action === "goto-home") { viewHistory = []; go({ name: "home" }, { replace: true }); }
  else if (action === "goto-library") go({ name: "library" });
  else if (action === "require-auth") go({ name: "account" });
  else if (action === "subscribe") go({ name: "account" });
  else if (action === "read") openChapter(id, Number(el.dataset.ch || 0));
  else if (action === "reader-exit") goBack();
  else if (action === "epub-muestra-ok") { const n = document.getElementById("epub-muestra-note"); if (n) n.hidden = true; }
  else if (action === "epub-exit") { epubPoke(); goBack(); }
  else if (action === "epub-font-inc") epubFontStep(10);
  else if (action === "epub-font-dec") epubFontStep(-10);
  else if (action === "epub-theme") epubToggleTheme();
  else if (action === "epub-toc") epubToggleToc();
  else if (action === "epub-search") epubToggleSearch();
  else if (action === "epub-search-close") epubSearchClose();
  else if (action === "epub-search-go") epubSearchRun();
  else if (action === "epub-search-cancel") epubSearchCancel();
  else if (action === "epub-search-go-result") epubSearchGoResult(el.dataset.cfi);
  else if (action === "epub-toc-go") epubGoTo(el.dataset.href);
  else if (action === "epub-dict-close") epubDictClose();
  else if (action === "epub-menu") epubToggleMenu();
  else if (action === "epub-notes") epubToggleNotes();
  else if (action === "epub-selmenu-close") epubSelMenuClose();
  else if (action === "epub-act-translate") epubActTranslate();
  else if (action === "epub-act-highlight") epubActHighlight();
  else if (action === "epub-act-note") epubActNoteAction(el);
  else if (action === "epub-act-viewnotes") epubActViewNotes();
  else if (action === "epub-act-underline") epubActUnderline();
  else if (action === "epub-palette-pick") epubPalettePick(el.dataset.modo, el.dataset.tipo, el.dataset.color);
  else if (action === "epub-palette-back") epubPaletteBack();
  else if (action === "epub-ws-close") epubWordSheetClose();
  else if (action === "epub-ws-translate") epubWsTranslate();
  else if (action === "epub-note-save") epubNoteSave();
  else if (action === "epub-noteview-close") epubNoteViewClose();
  else if (action === "epub-noteview-edit") epubNoteViewEdit();
  else if (action === "epub-noteview-del") epubNoteViewDel();
  else if (action === "epub-note-cancel") epubNoteCancel();
  else if (action === "epub-note-go") epubNoteGo(el.dataset.cfi);
  else if (action === "epub-note-del") epubNoteDel(el.dataset.cfi);
  else if (action === "reader-chapter") {
    const n = Number(el.dataset.ch);
    if (chapterData && n >= 0 && n < chapterData.chapterCount) openChapter(view.bookId, n);
  }
  else if (action === "font-inc") { readerFontSize = Math.min(26, readerFontSize + 1); render(); }
  else if (action === "font-dec") { readerFontSize = Math.max(15, readerFontSize - 1); render(); }
  else if (action === "lib-tab") { libTab = ["favoritos", "recientes"].includes(el.dataset.t) ? el.dataset.t : "estante"; render(); }
  else if (action === "lib-remove") {
    try { await api.removeFromLibrary(token, id); const lib = await api.myLibrary(token); libraryEntries = lib.entries || []; render(); } catch { /* modo muestra */ }
  }
  else if (action === "lib-fav") {
    try { await api.toggleFavorite(token, id, el.dataset.fav === "1"); const lib = await api.myLibrary(token); libraryEntries = lib.entries || []; render(); } catch { /* modo muestra */ }
  }
  else if (action === "detail-add") {
    try { await api.addToLibrary(token, id); openBook(id); } catch { /* modo muestra */ }
  }
  else if (action === "detail-fav") {
    try { await api.toggleFavorite(token, id, el.dataset.fav === "1"); openBook(id); } catch { /* modo muestra */ }
  }
  else if (action === "logout") {
    try { await api.logout(token); } catch { /* se cierra igual en local */ }
    closeAdminWelcome();
    saveToken(null); token = null; user = null; libraryEntries = [];
    chatAcctMsgs = [];
    go({ name: "home" });
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.matches("[data-lib-search-form]")) {
    // Buscador de sección de «Tu biblioteca» (r32): el filtrado es en
    // vivo (evento input); el envío solo evita salir de la vista.
    e.preventDefault();
    return;
  }
  if (form.matches("[data-search-form]")) {
    e.preventDefault();
    const input = form.querySelector("input[type=search]");
    go({ name: "search", query: (input.value || "").trim() });
    return;
  }
  if (form.id === "auth-form") {
    e.preventDefault();
    authError = ""; authNotice = false;
    if (!MAGISTER_API_ENABLED) {
      // Modo muestra: no se finge ninguna cuenta; se avisa con honestidad.
      authNotice = true; render(); return;
    }
    const email = document.getElementById("auth-email").value;
    const password = document.getElementById("auth-password").value;
    authBusy = true; render();
    try {
      const r = await api.login(email, password);
      saveToken(r.token); token = r.token; user = r.user;
      const lib = await api.myLibrary(token);
      libraryEntries = lib.entries || [];
      authBusy = false;
      render(); // «Mi cuenta» pasa a mostrar el panel de la cuenta, como en el preview
      maybeShowAdminWelcome();
    } catch (err) {
      authBusy = false; authError = errorText(err); render();
    }
  }
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-chapter-select]");
  if (sel) openChapter(view.bookId, Number(sel.value));
});

/* Buscadores de sección de «Tu biblioteca» (r32): al escribir se
   guarda el término de ESA sección y se repinta solo su lista, para
   que el campo no pierda el foco ni el cursor. */
document.addEventListener("input", (e) => {
  const inp = e.target.closest ? e.target.closest("[data-lib-search-input]") : null;
  if (!inp) return;
  libFilter[libTab] = inp.value;
  const list = document.querySelector(".lib-list");
  if (list) list.innerHTML = libSectionBodyHtml();
});

/* ------------------------------------------------------------ apertura */

/* ----------------------------------------------------------------
   Puentes mínimos para el bloque del lector ePub (la página
   publicada es solo en español y no lleva la capa i18n del
   preview): T devuelve la clave tal cual, porque las claves del
   lector SON el texto en español; langNombre pasa el código de
   idioma a su nombre en español. EPUB_LANG_NAMES vive dentro del
   propio bloque del lector y solo se consulta en tiempo de uso. */
function T(key) { return key; }
function langNombre(code) { return EPUB_LANG_NAMES[code] || code; }

/* ================================================================
   LECTOR EPUB (página publicada: se abre solo al tocar un
   libro, y con ese libro)

   Lector ePub de Magister: abre el EPUB del libro tocado, servido
   desde la bodega B2 por el servicio de lectura del puente
   (/magister/leer/<gid>: con cuenta, la muestra del primer
   capítulo; con suscripción, el libro completo), con epub.js
   (CDN jsDelivr, con unpkg de respaldo; JSZip igual).

   Segunda vuelta (pedidos de Sergio):
   - Temas: exactamente dos, Claro y Oscuro.
   - El índice se abre con un botón de tres rayas (☰).
   - Al seleccionar una palabra o frase aparece un menú con
     opciones: Significado (diccionario del Wikcionario, con
     dictionaryapi.dev de respaldo), Resaltar (anotación
     persistente por CFI, guardada en localStorage) y Nota (nota
     asociada a la selección, con su lista en el lector; el pasaje
     queda subrayado).
   - Los controles (barra superior y barra de progreso) se ocultan
     solos tras unos segundos sin tocar (lectura inmersiva) y un
     toque corto los trae de vuelta; mientras haya un panel, menú
     o tarjeta abiertos no se ocultan.
   - La posición se recuerda en localStorage.

   Tercera vuelta (correcciones de Sergio tras probar en iPhone):
   - Los controles no volvían con el toque: los toques sobre el
     texto caen dentro del iframe de epub.js (documento aparte) y
     la cáscara no los recibía. Ahora la escucha del toque vive
     dentro de cada documento del rendition, por touchend y por
     click, con red de seguridad en la cáscara.
   - Fuera el volteo 3D de la página entera (no funcionaba en su
     teléfono y no era lo pedido): al deslizar, solo se dobla UN
     POQUITO la esquina superior del lado del gesto y al soltar la
     página cambia de golpe. Sin botones de flecha para paginar.
   - Fuera la opción «Traducir» del menú de selección (y con ella
     todo el código de MyMemory).

   Cuarta vuelta (r15 — blindaje estructural, tras comprobar en el
   iPhone de Sergio que el libro cargaba y se veía pero el ÁREA DEL
   LIBRO no respondía a ningún toque: en su teléfono la entrada
   sobre el iframe de epub.js nunca llega a los manejadores, ni a
   los de dentro ni a los de encima; todo lo que le funcionó era
   DOM del documento padre o temporizadores):
   - La entrada táctil vive en una LÁMINA DE GESTOS del documento
     padre sobre el área del libro (epubAttachSheet): toque corto
     alterna los controles, el arrastre horizontal dobla la
     esquina (el mismo pliegue de la tercera vuelta) y al soltar
     cambia la página con rendition.next()/prev() programático.
     Ya no se depende de ninguna escucha dentro del iframe.
   - La selección de texto (Significado/Resaltar/Nota) se resuelve
     desde la lámina: el toque sostenido sin movimiento localiza la
     palabra bajo el dedo con caretRangeFromPoint/
     caretPositionFromPoint del documento del ePub (mismo origen),
     la selecciona y abre el menú; entonces la lámina se RETIRA
     (pointer-events:none) para que el ajuste fino de la selección
     sea el nativo del iframe, y vuelve sola cuando la selección
     se limpia y no queda ninguna tarjeta abierta (vigía por
     intervalo que decide por el estado real, no por ganchos).
   - Los assets del preview van versionados en el index
     (app.js?v=r15, styles.css?v=r15) para que ningún Safari mezcle
     builds, y el lector muestra su marca de build («r15») junto al
     progreso.
   - Todo lo que el lector lee de localStorage va saneado: JSON
     roto se descarta, los CFI se validan por forma y cada marca
     (resaltado/nota) se reaplica en su propio try/catch, de modo
     que un estado guardado por builds viejas nunca tumba la
     apertura. Y si aun así la inicialización falla, openReader
     cae a un modo mínimo funcional (portada, lámina y controles,
     sin posición ni marcas) en vez de a una pantalla muerta.
   - Auditoría de capas sobre el libro: .epub-loading y .epub-fold
     llevan pointer-events:none permanente; las tarjetas (índice,
     notas, diccionario, menús) solo existen para el tacto cuando
     están visibles (hidden = display:none); las barras con
     chrome-off no reciben toques. En lectura, el elemento que
     recibe el toque en el centro del libro es la lámina (o el
     iframe, solo mientras se ajusta una selección).

   Quinta vuelta (r16 — pedidos de Sergio tras confirmar que la
   r15 SÍ responde en su iPhone; la marca y la versión de los
   assets suben a «r16»):
   - Fuera el botón «Notas» de la barra. La selección de UN
     PASAJE (varias palabras) abre el menú compacto con
     exactamente: Subrayar · Resaltar · Aplicar nota · Buscar
     significado. La de UNA SOLA palabra abre en cambio una HOJA
     inferior (1/3 de pantalla, arrastrable hacia arriba hasta
     verla completa y cerrable hacia abajo o con su ×) que trae
     primero el cuadro del SIGNIFICADO ya cargado (Wikcionario),
     debajo el cuadro de TRADUCCIÓN bajo demanda (MyMemory —
     la traducción vuelve SOLO dentro de esta hoja, por orden
     expresa que deja sin efecto su retirada de la r13) y abajo
     las acciones Subrayar · Resaltar · Aplicar nota · Ver notas
     («Ver notas» abre la lista de siempre: pasaje, salto, borrar).
   - SUBRAYAR es anotación nueva, distinta de Resaltar: línea
     SÓLIDA dorada bajo el texto, persistente por CFI en su
     propio almacén y quitable re-seleccionando («Quitar
     subrayado»). La marca de las notas pasa a ser una línea de
     PUNTOS azul acero, para no confundirlas (ambas dibuja
     epub.js como «underline»; se diferencian por CSS del padre
     sobre la clase de cada marca: el pane vive en este
     documento).
   - Selección de VARIAS palabras a la vez: el toque sostenido
     engancha la palabra inicial y, SIN levantar el dedo, el
     arrastre extiende la selección palabra por palabra hasta
     donde va el dedo (resuelto desde el padre con
     caretRangeFromPoint/caretPositionFromPoint sobre el documento
     del ePub, actualizando el rango real dentro del iframe entre
     la palabra ancla y la palabra actual, en ambos sentidos). Al
     soltar, el menú abre con el pasaje completo. El arrastre SIN
     toque sostenido previo sigue siendo pase de página, y tras
     soltar el ajuste fino con los tiradores nativos sigue como
     en r15 (lámina retirada mientras haya selección viva).
   - El pase de página es un VOLTEO CILÍNDRICO estilo FlipHTML5
     (sustituye al pliegue de esquina en la vía de la lámina; el
     pliegue queda solo como respaldo si el volteo no puede
     montarse): al arrastrar, la hoja se levanta del borde y se
     enrolla sobre un cilindro invisible — zona plana, arco de
     radio R que se aprieta con el progreso y cola detrás —
     revelando la página siguiente DEBAJO. El anverso muestra el
     texto real; el REVERSO es papel blanquecino SEMITRANSPARENTE
     (tono según el tema) que deja traslucir apenas la página de
     debajo, sin texto espejado. Las superficies son clones del
     documento vivo (preparados al asentar cada página: página
     actual en franjas para el arco + plana, y las vecinas), todo
     con transforms y rAF, sin recalcular layout durante el
     gesto. Al soltar pasado el medio (o con gesto rápido) el
     volteo se completa solo y epub.js aterriza en la página
     destino; si no llega, la hoja se regresa con la misma
     fluidez.

   El lector solo se abre al tocar un libro (openBook) y siempre
   con ESE libro: sin cuenta no se abre ninguno (la página manda
   a «Mi cuenta») y el servicio de lectura exige la sesión y
   aplica el modelo (muestra del primer capítulo con cuenta;
   libro completo con suscripción o admin). La posición, las
   marcas y las notas se guardan POR LIBRO (clave con su gid).
   La salida usa goBack(): vuelve a la vista anterior y el
   header de la página no aparece dentro del lector, como ya es
   norma en la vista «reader».
   ================================================================ */

/* Marca de build del lector: va versionada en el index
   (app.js?v=r16) y visible junto al progreso, para saber qué
   código está corriendo en el teléfono de quien lo prueba. */
const EPUB_BUILD = "r32";
const EPUB_POS_KEY = "magister-epub-pos";
const EPUB_SET_KEY = "magister-epub-settings";
const EPUB_HL_KEY = "magister-epub-highlights-v1";
const EPUB_UL_KEY = "magister-epub-underlines-v1";
const EPUB_NOTES_KEY = "magister-epub-notes-v1";
const EPUB_CDNS = {
  jszip: [
    "https://cdn.jsdelivr.net/npm/jszip@3.1.5/dist/jszip.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js",
  ],
  epub: [
    "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js",
    "https://unpkg.com/epubjs@0.3.93/dist/epub.min.js",
  ],
};
const EPUB_THEMES = {
  oscuro: { bg: "#101014", ink: "#eae7de", head: "#f5f5f7", link: "#d3a24a" },
  claro: { bg: "#faf7f0", ink: "#2a251e", head: "#171310", link: "#8a5a12" },
};
const EPUB_CHROME_MS = 3000;
/* Papel del reverso de la hoja al voltear (r16): blanquecino
   semitransparente en Claro; en Oscuro, su equivalente oscuro
   también translúcido. La página de debajo se trasluce a través. */
const EPUB_PAPER = {
  oscuro: "rgba(43,43,50,0.88)",
  claro: "rgba(255,253,246,0.88)",
};
/* Tonos del volteo (r18): el sombreado vende la redondez del
   cilindro — sombra en la raíz del doblez, banda de luz en la
   cresta, atenuación hacia el borde libre y sombra proyectada
   suave sobre la página de debajo. Todo va SOBRE el anverso
   sólido (que lleva el fondo opaco del tema): son degradados
   de luz/sombra, nunca transparencia del anverso. Por tema. */
const EPUB_CURL_TONES = {
  oscuro: {
    arc: "linear-gradient(90deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.12) 20%, rgba(255,255,255,0.30) 40%, rgba(255,255,255,0.06) 58%, rgba(0,0,0,0.18) 78%, rgba(0,0,0,0.36) 100%)",
    arcPrev: "linear-gradient(270deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.12) 20%, rgba(255,255,255,0.30) 40%, rgba(255,255,255,0.06) 58%, rgba(0,0,0,0.18) 78%, rgba(0,0,0,0.36) 100%)",
    cast: "rgba(0,0,0,0.42)",
    root: "rgba(0,0,0,0.40)",
    crest: "rgba(255,255,255,0.30)",
    fall: "rgba(0,0,0,0.16)",
    shade: 0.30, sheen: 0.18,
    wash: "linear-gradient(90deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.03) 55%, rgba(255,255,255,0) 100%)",
    washPrev: "linear-gradient(270deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.03) 55%, rgba(255,255,255,0) 100%)",
  },
  claro: {
    arc: "linear-gradient(90deg, rgba(74,56,24,0.34) 0%, rgba(74,56,24,0.08) 22%, rgba(255,255,255,0.65) 44%, rgba(74,56,24,0.05) 60%, rgba(74,56,24,0.18) 80%, rgba(74,56,24,0.34) 100%)",
    arcPrev: "linear-gradient(270deg, rgba(74,56,24,0.34) 0%, rgba(74,56,24,0.08) 22%, rgba(255,255,255,0.65) 44%, rgba(74,56,24,0.05) 60%, rgba(74,56,24,0.18) 80%, rgba(74,56,24,0.34) 100%)",
    cast: "rgba(74,56,24,0.32)",
    root: "rgba(74,56,24,0.30)",
    crest: "rgba(255,255,255,0.75)",
    fall: "rgba(74,56,24,0.13)",
    shade: 0.22, sheen: 0.10,
    wash: "linear-gradient(90deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.14) 55%, rgba(255,255,255,0) 100%)",
    washPrev: "linear-gradient(270deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.14) 55%, rgba(255,255,255,0) 100%)",
  },
};
/* Doblez de esquina al pasar de página: tamaño máximo del pliegue
   (px), duración de su regreso cuando el gesto no llega, y
   recorrido mínimo al soltar para que la página cambie. */
const EPUB_FOLD_MAX = 96;
const EPUB_FOLD_MS = 224;
const EPUB_TURN_DX = 56;
/* r26 (Sergio: el pase estaba «muy sensible»): el punto efectivo
   del volteo avanzaba al 85 % del desplazamiento del dedo y la
   animación de asentamiento del curl subió a 336 ms (antes
   240 ms, +40 %); el pliegue clásico de reserva compartía la
   ganancia y su retorno pasó de 160 a 224 ms.
   r27 (Sergio: «vuelve a los parámetros de antes en que sigue el
   dedo 1:1 pero al soltar mantén el parámetro actual»): la
   ganancia del arrastre vuelve a 1 (seguimiento 1:1, como en
   r24/r25) y SE MANTIENEN las duraciones lentas de r26 al soltar
   (asentamiento 336 ms; retorno del pliegue de reserva 224 ms). */
const EPUB_TURN_GAIN = 1;
const EPUB_CURL_RELEASE_MS = 336;
/* r30 (precisión de Sergio con su captura photo-86): TOPE DURO de
   inclinación de la línea de doblez en los pases horizontales —
   15°, el ángulo medido sobre su captura (14,7°). La inclinación
   solo nace del Δy real del dedo, amarrada a este tope; sin sesgo
   automático (el de 30° de r24 quedó derogado por esta precisión)
   y sin que la punta cruce jamás al otro lado de su ancla. */
const EPUB_EDGE_TILT_MAX = 15;

let epubOpen = false;
/* Libro abierto en el lector (lo fija openBook con los datos del
   catálogo) y sus bytes, descargados del servicio de lectura.
   acceso: "completo" | "muestra", según la cabecera del servicio. */
let epubCurrent = null;
let epubBytes = null;
function epubPosKey() { return EPUB_POS_KEY + "-" + (epubCurrent ? epubCurrent.gid : "sinlibro"); }
let epubBook = null;
let epubRendition = null;
let epubInitSeq = 0;
let epubDictSeq = 0;
let epubFontPct = 110;
let epubThemeName = "oscuro";
let epubLastPct = -1;
/* Selección viva y su guarda contra disparos repetidos */
let epubSel = null;
let epubSelGuard = { key: "", at: 0 };
/* Gestos: deslizamiento (doblez de esquina) y toque (controles) */
let epubGesture = null;
let epubFold = null;
let epubTapAt = 0;
let epubTouchEndAt = 0;
/* Lámina de gestos del documento padre (r15): es la entrada
   táctil principal del lector. epubSheetOff = la lámina está
   retirada (modo selección: el tacto va directo al iframe). */
let epubSheetGesture = null;
/* Sello de la última selección cerrada por la lámina: sirve para
   no confundir el clic fantasma sobre una anotación con un toque
   deliberado en ella (ver epubOnAnnoTap). */
let epubSheetSelectAt = 0;
let epubSheetOff = false;
let epubSheetWatchId = 0;
let epubMouseAt = 0;
/* Controles que se ocultan solos */
let epubChromeTimer = 0;
/* Anotaciones aplicadas en esta sesión del lector */
const epubAnnoApplied = new Set();

function epubHtml() {
  return `<div class="epub-shell" id="epub-shell">
    <div class="epub-top">
      <button type="button" class="epub-exit" data-action="epub-exit" aria-label="${T("Salir del libro")}">←</button>
      <p class="epub-book-title">${esc(epubCurrent ? epubCurrent.title : T("Libro"))}</p>
      <div class="epub-tools">
        <button type="button" class="epub-iconbtn" data-action="epub-toc" aria-label="${T("Índice")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg></button>
        <button type="button" class="epub-iconbtn" data-action="epub-search" aria-label="${T("Buscar en el libro")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.6 16.6"/></svg></button>
        <button type="button" class="epub-iconbtn" data-action="epub-menu" aria-label="${T("Menú")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 8h9"/><circle cx="17" cy="8" r="2.3"/><path d="M20 16H11"/><circle cx="7" cy="16" r="2.3"/></svg></button>
      </div>
    </div>
    <div class="epub-stage" id="epub-stage">
      <div id="epub-viewer" class="epub-viewer"></div>
      <div class="epub-curl" id="epub-curl" hidden aria-hidden="true">
        <div id="epub-curl-revs"></div>
        <div class="cv-wrap" id="epub-curl-flat"><iframe tabindex="-1"></iframe><div class="cv-flatwash" id="epub-curl-wash"></div></div>
        <div class="cv-shadow" id="epub-curl-sha"></div>
        <div class="cv-shadow" id="epub-curl-shb"></div>
        <div class="cv-tail" id="epub-curl-tail"></div>
        <div id="epub-curl-strips"></div>
        <div class="cv-arc" id="epub-curl-arc"></div>
        <div class="cv-cast" id="epub-curl-cast"></div>
        <div class="cv-flap" id="epub-curl-flap" hidden>
          <div class="cv-flap-reflect"><iframe tabindex="-1"></iframe></div>
          <div class="cv-flap-paper"></div>
          <div class="cv-flap-band"></div>
        </div>
      </div>
      <div class="epub-sheet" id="epub-sheet" aria-hidden="true"></div>
      <div class="epub-fold" id="epub-fold" hidden aria-hidden="true"><div class="epub-fold-shade"></div><div class="epub-fold-flap"></div></div>
      <p class="epub-loading" id="epub-loading">${T("Abriendo el libro…")}</p>
      <p class="epub-muestra-note" id="epub-muestra-note" data-action="epub-muestra-ok" hidden>Muestra gratuita: estás leyendo el primer capítulo. Con la suscripción, el libro completo. <span aria-hidden="true">✕</span></p>
      <div class="epub-top-backdrop" id="epub-top-backdrop" hidden></div>
      <div class="epub-toc epub-topsheet" id="epub-toc" hidden>
        <div class="epub-panel-head">
          <p class="epub-toc-title">${T("Índice")}</p>
        </div>
        <div class="epub-topsheet-scroll" id="epub-toc-list"><p class="epub-toc-empty">${T("Cargando el índice…")}</p></div>
        <div class="epub-topsheet-grip" data-topgrip="epub-toc" aria-hidden="true"><span></span></div>
        <button type="button" class="epub-panel-x" data-action="epub-toc" aria-label="${T("Cerrar el índice")}">×</button>
      </div>
      <div class="epub-toc epub-topsheet" id="epub-search" hidden>
        <div class="epub-panel-head">
          <p class="epub-toc-title">${T("Buscar en el libro")}</p>
        </div>
        <div class="epub-search-bar">
          <input type="search" id="epub-search-input" class="epub-search-input" placeholder="${T("Escribe una palabra…")}" autocomplete="off">
          <button type="button" class="epub-search-go" data-action="epub-search-go">${T("Buscar")}</button>
        </div>
        <div class="epub-search-statusrow">
          <p class="epub-search-status" id="epub-search-status"></p>
          <button type="button" class="epub-search-cancel" id="epub-search-cancel" data-action="epub-search-cancel" hidden>${T("Cancelar")}</button>
        </div>
        <div class="epub-topsheet-scroll epub-search-results" id="epub-search-results"></div>
        <div class="epub-topsheet-grip" data-topgrip="epub-search" aria-hidden="true"><span></span></div>
        <button type="button" class="epub-panel-x" data-action="epub-search-close" aria-label="${T("Cerrar la búsqueda")}">×</button>
      </div>
      <div class="epub-toc epub-topsheet epub-menu" id="epub-menu" hidden>
        <div class="epub-panel-head">
          <p class="epub-toc-title">${T("Ajustes de lectura")}</p>
        </div>
        <div class="epub-menu-rows">
          <div class="epub-menu-row">
            <span class="epub-menu-label">${T("Tamaño de letra")}</span>
            <span class="epub-menu-btns">
              <button type="button" data-action="epub-font-dec" aria-label="${T("Reducir tamaño de letra")}">A−</button>
              <button type="button" data-action="epub-font-inc" aria-label="${T("Aumentar tamaño de letra")}">A+</button>
            </span>
          </div>
          <div class="epub-menu-row">
            <span class="epub-menu-label">${T("Tema")}</span>
            <button type="button" data-action="epub-theme" id="epub-theme-btn">${T("Tema: Oscuro")}</button>
          </div>
          <div class="epub-menu-row">
            <span class="epub-menu-label">${T("Notas")}</span>
            <button type="button" data-action="epub-notes">${T("Ver notas")}</button>
          </div>
          <div class="epub-menu-row">
            <span class="epub-menu-label">${T("Brillo")}</span>
            <input type="range" id="epub-bright" min="45" max="100" step="1" value="100" aria-label="${T("Brillo")}">
          </div>
        </div>
        <button type="button" class="epub-panel-x" data-action="epub-menu" aria-label="${T("Cerrar el menú")}">×</button>
      </div>
      <div class="epub-toc epub-notes" id="epub-notes" hidden>
        <div class="epub-panel-head">
          <p class="epub-toc-title">${T("Mis notas")}</p>
        </div>
        <div id="epub-notes-list"><p class="epub-toc-empty">${T("Cargando las notas…")}</p></div>
        <div class="epub-panel-foot">
          <button type="button" class="epub-dict-close" data-action="epub-notes" aria-label="${T("Cerrar las notas")}">×</button>
        </div>
      </div>
      <div class="epub-dict" id="epub-dict" hidden>
        <div class="epub-dict-head">
          <p class="epub-dict-word" id="epub-dict-word">${T("Palabra")}</p>
          <button type="button" class="epub-dict-close" data-action="epub-dict-close" aria-label="${T("Cerrar la tarjeta")}">×</button>
        </div>
        <div class="epub-dict-body" id="epub-dict-body"><p class="epub-dict-status">${T("Buscando…")}</p></div>
        <p class="epub-dict-src" id="epub-dict-src">${T("Diccionario · Wikcionario, el diccionario libre")}</p>
      </div>
      <div class="epub-dict epub-selmenu" id="epub-selmenu" hidden>
        <div class="epub-dict-head">
          <p class="epub-sel-text" id="epub-sel-text">«…»</p>
          <button type="button" class="epub-dict-close" data-action="epub-selmenu-close" aria-label="${T("Cerrar menú")}">×</button>
        </div>
        <div class="epub-sel-grid" id="epub-actions-menu">
          <button type="button" data-action="epub-act-underline" id="epub-act-underline">${T("Subrayar")}</button>
          <button type="button" data-action="epub-act-highlight" id="epub-act-highlight">${T("Resaltar")}</button>
          <button type="button" data-action="epub-act-note" id="epub-act-note-menu">${T("Aplicar nota")}</button>
          <button type="button" data-action="epub-act-translate">${T("Traducir")}</button>
        </div>
        <div class="epub-palette" id="epub-palette-menu" hidden>
          <p class="epub-palette-title">${T("Color")}</p>
          <div class="epub-palette-grid"></div>
          <button type="button" class="epub-palette-back" data-action="epub-palette-back">${T("Volver")}</button>
        </div>
        <div class="epub-recolor" id="epub-recolor-menu" hidden></div>
      </div>
      <div class="epub-wordsheet" id="epub-wordsheet" hidden>
        <div class="epub-ws-handle" id="epub-ws-handle"><span class="epub-ws-grip"></span></div>
        <div class="epub-ws-head">
          <p class="epub-ws-word" id="epub-ws-word">Palabra</p>
          <button type="button" class="epub-dict-close" data-action="epub-ws-close" aria-label="${T("Cerrar la hoja")}">×</button>
        </div>
        <div class="epub-ws-scroll" id="epub-ws-scroll">
          <div class="epub-ws-box">
            <p class="epub-ws-box-title">${T("Significado")}</p>
            <div id="epub-ws-meaning"><p class="epub-dict-status">${T("Buscando la definición…")}</p></div>
            <p class="epub-dict-src">${T("Diccionario · Wikcionario, el diccionario libre")}</p>
          </div>
          <div class="epub-ws-box">
            <p class="epub-ws-box-title">${T("Traducción")}</p>
            <select id="epub-ws-dict" class="epub-ws-dictsel" aria-label="${T("Diccionario de traducción")}"></select>
            <div id="epub-ws-trans"><p class="epub-dict-hint">${T("Toca «Traducir» para ver esta palabra en el otro idioma.")}</p></div>
            <button type="button" class="epub-note-btn primary epub-ws-trans-btn" data-action="epub-ws-translate" id="epub-ws-translate-btn">${T("Traducir")}</button>
          </div>
          <div class="epub-sel-grid epub-ws-actions" id="epub-actions-ws">
            <button type="button" data-action="epub-act-underline" id="epub-ws-act-underline">${T("Subrayar")}</button>
            <button type="button" data-action="epub-act-highlight" id="epub-ws-act-highlight">${T("Resaltar")}</button>
            <button type="button" data-action="epub-act-note">${T("Aplicar nota")}</button>
            <button type="button" data-action="epub-act-viewnotes">${T("Ver notas")}</button>
          </div>
          <div class="epub-palette" id="epub-palette-ws" hidden>
            <p class="epub-palette-title">${T("Color")}</p>
            <div class="epub-palette-grid"></div>
            <button type="button" class="epub-palette-back" data-action="epub-palette-back">${T("Volver")}</button>
          </div>
          <div class="epub-recolor" id="epub-recolor-ws" hidden></div>
        </div>
      </div>
      <div class="epub-dict epub-noteview" id="epub-noteview" hidden>
        <div class="epub-dict-head">
          <p class="epub-sel-text" id="epub-noteview-quote">«…»</p>
          <button type="button" class="epub-dict-close" data-action="epub-noteview-close" aria-label="${T("Cerrar la nota")}">×</button>
        </div>
        <p class="epub-noteview-text" id="epub-noteview-text"></p>
        <div class="epub-note-actions">
          <button type="button" class="epub-note-btn" data-action="epub-noteview-del">${T("Borrar")}</button>
          <button type="button" class="epub-note-btn primary" data-action="epub-noteview-edit">${T("Editar")}</button>
        </div>
      </div>
      <div class="epub-dict epub-noteed" id="epub-noteed" hidden>
        <div class="epub-dict-head">
          <p class="epub-sel-text" id="epub-note-quote">«…»</p>
          <button type="button" class="epub-dict-close" data-action="epub-note-cancel" aria-label="${T("Cancelar la nota")}">×</button>
        </div>
        <textarea id="epub-note-text" class="epub-note-textarea" rows="3" placeholder="${T("Escribe tu nota sobre este pasaje…")}"></textarea>
        <div class="epub-note-actions">
          <button type="button" class="epub-note-btn" data-action="epub-note-cancel">${T("Cancelar")}</button>
          <button type="button" class="epub-note-btn primary" data-action="epub-note-save">${T("Guardar nota")}</button>
        </div>
      </div>
    </div>
    <div class="epub-bottom">
      <div class="epub-progress">
        <div class="progress" role="progressbar" aria-label="${T("Progreso del libro")}"><div id="epub-prog-fill" style="width:0%"></div></div>
        <p class="epub-prog-txt" id="epub-prog-txt">…</p>
      </div>
      <span class="epub-build" id="epub-build" aria-hidden="true">${EPUB_BUILD}</span>
    </div>
  </div>`;
}

function epubLoadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("CDN no disponible: " + url));
    document.head.appendChild(s);
  });
}

async function epubLoadLibs() {
  if (!window.JSZip) {
    let ok = false;
    for (const u of EPUB_CDNS.jszip) { try { await epubLoadScript(u); ok = true; break; } catch { /* siguiente CDN */ } }
    if (!ok) throw new Error("No se pudo cargar JSZip");
  }
  if (!window.ePub) {
    let ok = false;
    for (const u of EPUB_CDNS.epub) { try { await epubLoadScript(u); ok = true; break; } catch { /* siguiente CDN */ } }
    if (!ok) throw new Error("No se pudo cargar epub.js");
  }
}

function epubSaveSettings() {
  try { window.localStorage.setItem(EPUB_SET_KEY, JSON.stringify({ font: epubFontPct, theme: epubThemeName })); } catch { /* sin almacenamiento */ }
}

/* --------------------------------- almacenamiento saneado (r15) */

/* Un CFI válido «por forma»: las builds viejas pudieron guardar
   cualquier cosa en las claves del lector, así que nada se usa sin
   pasar por aquí. */
function epubIsCfi(s) {
  return typeof s === "string" && s.length > 12 && s.indexOf("epubcfi(") === 0 && s.charAt(s.length - 1) === ")";
}

function epubStoreRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* sin almacenamiento */ }
}

function epubRestoreSettings() {
  let raw = null;
  try { raw = window.localStorage.getItem(EPUB_SET_KEY); } catch { raw = null; }
  if (!raw) return;
  let s = null;
  try { s = JSON.parse(raw); } catch { s = null; }
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    /* Ajustes ilegibles (JSON roto o de otra forma): se descartan
       y se sigue con los de por defecto; nunca tumban la apertura. */
    epubStoreRemove(EPUB_SET_KEY);
    return;
  }
  if (typeof s.font === "number" && isFinite(s.font) && s.font >= 80 && s.font <= 170) epubFontPct = s.font;
  if (s.theme === "papel") epubThemeName = "claro"; /* el antiguo «Papel» pasa a ser el «Claro» */
  else if (typeof s.theme === "string" && EPUB_THEMES[s.theme]) epubThemeName = s.theme;
}

function epubSyncChrome() {
  epubApplyBright();
  const t = EPUB_THEMES[epubThemeName] || EPUB_THEMES.oscuro;
  const stage = document.getElementById("epub-stage");
  if (stage) stage.style.background = t.bg;
  const btn = document.getElementById("epub-theme-btn");
  if (btn) btn.textContent = epubThemeName === "claro" ? T("Tema: Claro") : T("Tema: Oscuro");
}

/* ------------------------------------- controles que se ocultan */

function epubOverlayOpen() {
  return ["epub-toc", "epub-menu", "epub-notes", "epub-dict", "epub-selmenu", "epub-noteed", "epub-wordsheet", "epub-noteview", "epub-search"].some((id) => {
    const el = document.getElementById(id);
    return el && !el.hidden;
  });
}

function epubChromeClearTimer() {
  if (epubChromeTimer) { window.clearTimeout(epubChromeTimer); epubChromeTimer = 0; }
}

function epubChromeArm() {
  epubChromeClearTimer();
  epubChromeTimer = window.setTimeout(epubChromeHide, EPUB_CHROME_MS);
}

function epubChromeShow() {
  const sh = document.getElementById("epub-shell");
  if (sh) sh.classList.remove("chrome-off");
  epubChromeArm();
}

function epubChromeHide() {
  const sh = document.getElementById("epub-shell");
  if (!sh) return;
  if (epubOverlayOpen()) { epubChromeArm(); return; } /* con algo abierto, no se ocultan */
  sh.classList.add("chrome-off");
  epubChromeClearTimer();
}

function epubChromeHideNow() {
  const sh = document.getElementById("epub-shell");
  if (sh) sh.classList.add("chrome-off");
  epubChromeClearTimer();
}

function epubChromeToggle() {
  const sh = document.getElementById("epub-shell");
  if (!sh) return;
  if (sh.classList.contains("chrome-off")) epubChromeShow();
  else epubChromeHideNow();
}

/* Interacción cualquiera con los controles: si están visibles,
   reinicia la cuenta atrás de la ocultación. */
function epubPoke() {
  const sh = document.getElementById("epub-shell");
  if (sh && !sh.classList.contains("chrome-off")) epubChromeArm();
}

function epubCloseOverlays(except) {
  for (const id of ["epub-toc", "epub-menu", "epub-notes", "epub-dict", "epub-selmenu", "epub-noteed", "epub-wordsheet", "epub-noteview", "epub-search"]) {
    if (id === except) continue;
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  epubDictSeq++;
  epubTopBackdropSync();
  epubPoke();
}

/* --------------------------------------- contenido del ePub */

/* Estilos del tema inyectados en cada documento del ePub: es la vía
   directa de controlar fondo/tinta del texto con epub.js, y el
   gancho de contenido los reaplica en cada sección nueva. El mismo
   gancho registra la selección (diccionario y menú) y los gestos
   táctiles (paso de página y toque para los controles). */
/* Solo los estilos del tema en el documento (sin ganchos de
   selección ni de gestos): lo usa también la rendition oculta
   que prepara las páginas vecinas de otra sección para el
   volteo. */
function epubApplyThemeToDoc(contents) {
  const t = EPUB_THEMES[epubThemeName] || EPUB_THEMES.oscuro;
  const doc = contents && contents.document;
  if (!doc || !doc.head) return;
  let st = doc.getElementById("magister-epub-theme");
  if (!st) {
    st = doc.createElement("style");
    st.id = "magister-epub-theme";
    doc.head.appendChild(st);
  }
  st.textContent =
    "html, body { background: " + t.bg + " !important; }" +
    "body { color: " + t.ink + " !important; font-family: Georgia, 'Times New Roman', serif !important; line-height: 1.75 !important; }" +
    "h1, h2, h3 { color: " + t.head + " !important; }" +
    "a { color: " + t.link + " !important; }" +
    /* Sin selección nativa (r19): en iOS, el toque sostenido
       abría el seleccionador de Safari (tiradores azules y su
       menú) por encima de nuestro sistema. Con user-select y
       touch-callout desactivados en TODO el documento del libro,
       el sistema nunca puede crear su selección ni su lupa: la
       única selección es la nuestra (marca propia por rango). */
    "html, body, body * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }" +
    "::selection { background: transparent !important; }";
}

function epubStyleContents(contents) {
  epubApplyThemeToDoc(contents);
  const doc = contents && contents.document;
  if (!doc || !doc.head) return;
  /* Selección: epub.js avisa con su evento «selected», pero en
     táctil (iOS) la selección se consolida tras soltar los
     tiradores; estos escuchas propios con espera cubren ese caso
     sin salir del lector. */
  if (!contents.__mgDictHook) {
    contents.__mgDictHook = true;
    const check = () => {
      let raw = "";
      let cfi = "";
      try {
        const sel = contents.window.getSelection();
        raw = sel ? sel.toString() : "";
        if (raw && raw.trim() && sel.rangeCount) {
          try { cfi = contents.cfiFromRange(sel.getRangeAt(0)); } catch { cfi = ""; }
        }
      } catch { raw = ""; }
      if (raw && raw.trim()) epubOnSelected(raw, cfi);
    };
    doc.addEventListener("selectionchange", () => {
      window.clearTimeout(contents.__mgDictTimer);
      contents.__mgDictTimer = window.setTimeout(check, 400);
    });
    doc.addEventListener("mouseup", () => window.setTimeout(check, 20));
    doc.addEventListener("touchend", () => window.setTimeout(check, 500));
  }
  epubAttachGestures(contents);
}

/* ------------------------------------- gestos y doblez de esquina */

function epubStageEl() { return document.getElementById("epub-stage"); }

/* Toque corto = mostrar/ocultar los controles. Los toques sobre el
   texto caen DENTRO del iframe de epub.js, que es un documento
   aparte: la cáscara no los recibe (así se perdían en el iPhone y
   los controles no volvían). La escucha vive por eso dentro de
   cada documento del rendition (epubAttachGestures), con red de
   seguridad en la cáscara (epubAttachStageTap), y por dos vías
   —touchend y click— porque WebKit de iOS no siempre entrega
   ambas. Las marcas de tiempo evitan el doble alternado cuando un
   mismo toque genera los dos eventos: el click sintético que
   sigue a un touchend ya atendido se ignora, y dos alternados a
   menos de 350 ms cuentan como uno solo. */
function epubTapToggle() {
  const now = Date.now();
  if (now - epubTapAt < 350) return;
  epubTapAt = now;
  epubChromeToggle();
}

/* ---------------------------------- doblez de la esquina superior */

/* Al deslizar para cambiar de página, la esquina superior del lado
   del gesto se dobla UN POQUITO: un pliegue chico que crece con el
   arrastre hasta un tope, con el dorso en papel del tema y una
   sombrita sobre la página. Al soltar pasando un umbral corto, el
   pliegue termina de doblarse en un instante y la página cambia
   de golpe; si no llega al umbral, el pliegue se regresa. La
   página NUNCA se gira entera ni se mueve: el texto queda quieto
   y solo vive el pliegue — dos triángulos superpuestos con
   clip-path, sin instantáneas ni clones del documento (el aparato
   del volteo 3D era frágil en iOS y ya no existe). */
function epubFoldEl() { return document.getElementById("epub-fold"); }

function epubFoldSize(adv) {
  return Math.max(0, Math.min(EPUB_FOLD_MAX, 14 + adv * 0.5));
}

function epubFoldShow(dir, adv) {
  let el = epubFold;
  if (!el) {
    el = epubFoldEl();
    if (!el) return;
    const t = EPUB_THEMES[epubThemeName] || EPUB_THEMES.oscuro;
    el.style.setProperty("--fold-bg", t.bg);
    epubFold = el;
  }
  /* Generación del elemento (r30): cada uso nuevo invalida el
     temporizador de ocultado de un asentamiento anterior, para
     que nunca esconda el pliegue en mitad de otro gesto. */
  el.__foldGen = (el.__foldGen || 0) + 1;
  el.classList.toggle("next", dir > 0);
  el.classList.toggle("prev", dir < 0);
  el.style.transition = "none";
  el.style.opacity = "1";
  el.hidden = false;
  const s = epubFoldSize(adv);
  el.style.width = s + "px";
  el.style.height = s + "px";
}

function epubFoldSettle(dir, complete) {
  const el = epubFold;
  epubFold = null;
  if (complete && epubRendition) {
    /* Candado de vuelta (r30): el pliegue clásico comparte el
       candado del volteo — mientras su vuelta navega y asienta,
       NINGÚN gesto nuevo entra (epubSheetStart y los gestos del
       documento lo respetan). Sin este candado, una ráfaga de
       pases ultrarrápidos encadenaba vueltas sobre la misma
       navegación y la animación «se volvía loca» (Sergio). El
       candado se libera cuando la navegación asienta, con la
       misma red de seguridad de 800 ms del volteo. */
    epubCurlBusy = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      epubCurlBusy = false;
      epubCurlPoolSchedule();
    };
    try {
      const pr = dir > 0 ? epubRendition.next() : epubRendition.prev();
      if (pr && pr.then) pr.then(() => setTimeout(release, 60), () => setTimeout(release, 60));
      else setTimeout(release, 60);
    } catch { setTimeout(release, 60); }
    setTimeout(release, 800);
  }
  if (!el) return;
  const gen = (el.__foldGen = (el.__foldGen || 0) + 1);
  if (complete) {
    /* termina el doblez a su tamaño máximo y se desvanece */
    el.style.transition = "width 154ms ease-out, height 154ms ease-out, opacity 140ms ease 98ms";
    el.style.width = EPUB_FOLD_MAX + "px";
    el.style.height = EPUB_FOLD_MAX + "px";
    el.style.opacity = "0";
  } else {
    el.style.transition = "width " + EPUB_FOLD_MS + "ms ease, height " + EPUB_FOLD_MS + "ms ease, opacity " + EPUB_FOLD_MS + "ms ease";
    el.style.width = "0px";
    el.style.height = "0px";
    el.style.opacity = "0";
  }
  window.setTimeout(() => { if (el.__foldGen === gen) el.hidden = true; }, 340);
}

function epubFoldCancel() {
  if (epubFold) epubFoldSettle(0, false);
  else { const el = epubFoldEl(); if (el) el.hidden = true; }
}

/* Red de seguridad en la cáscara: un toque que caiga fuera del
   visor (los bordes del escenario) también alterna los controles.
   Los toques sobre paneles, tarjetas o botones no alternan: su
   objetivo no es el escenario ni el visor. */
function epubAttachStageTap() {
  const stage = epubStageEl();
  if (!stage || stage.__mgTapHook) return;
  stage.__mgTapHook = true;
  stage.addEventListener("click", (e) => {
    if (!epubOpen) return;
    if (e.target === stage || e.target.id === "epub-viewer") epubTapToggle();
  });
}

/* ------------------------------ lámina de gestos del padre (r15) */

/* LA entrada táctil del lector vive aquí: una lámina transparente
   del DOCUMENTO PADRE sobre el área del libro. En el iPhone de
   Sergio la entrada sobre el iframe de epub.js nunca llegó a
   ningún manejador (ni dentro del documento del ePub ni encima),
   así que toque, arrastre y toque sostenido se atienden en esta
   lámina, en el mismo documento que las barras que sí le
   funcionaban. La lámina es el elemento que recibe el toque en el
   centro del libro en todos los estados de lectura; solo se
   retira (pointer-events:none) mientras se ajusta una selección
   nativa dentro del iframe o hay una tarjeta abierta. */

const EPUB_LONGPRESS_MS = 450;

function epubSheetEl() { return document.getElementById("epub-sheet"); }

/* ¿Hay una selección viva en algún documento del ePub? El padre
   puede mirarlo: el iframe es del mismo origen. */
function epubAnySelection() {
  if (!epubRendition) return false;
  try {
    const list = epubRendition.getContents() || [];
    for (const c of list) {
      try {
        const sel = c.window.getSelection();
        if (sel && !sel.isCollapsed && String(sel.toString() || "").trim()) return true;
      } catch { /* contenido en cambio */ }
    }
  } catch { /* sin contenido todavía */ }
  return false;
}

function epubSheetSetOff(off) {
  epubSheetOff = !!off;
  const el = epubSheetEl();
  if (el) el.classList.toggle("off", epubSheetOff);
}

/* El vigía decide el estado de la lámina por el ESTADO REAL, no por
   ganchos sueltos: retirada mientras haya una tarjeta abierta o
   una selección viva (el tacto debe ir al iframe); puesta en
   cuanto todo eso se limpia. Corre por intervalo mientras el
   lector está abierto, así ningún camino olvidado la deja mal. */
function epubSheetSync() {
  if (!epubOpen) return;
  epubSheetSetOff(epubOverlayOpen() || epubAnySelection());
}

function epubSheetWatchStart() {
  if (epubSheetWatchId) return;
  epubSheetWatchId = window.setInterval(epubSheetSync, 450);
}

function epubSheetWatchStop() {
  if (epubSheetWatchId) { window.clearInterval(epubSheetWatchId); epubSheetWatchId = 0; }
}

/* Palabra bajo un punto, resuelta DESDE EL PADRE con el API de
   caret del propio documento del ePub (mismo origen):
   caretRangeFromPoint en WebKit, caretPositionFromPoint en
   Chromium/Firefox. Devuelve el Range de la palabra completa. */
const EPUB_WORD_CH = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñÀ-ÿ0-9'’_-]/;

function epubWordRangeAt(doc, x, y) {
  let node = null;
  let offset = 0;
  try {
    if (typeof doc.caretRangeFromPoint === "function") {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (typeof doc.caretPositionFromPoint === "function") {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    }
  } catch { node = null; }
  if (!node || node.nodeType !== 3) return null;
  const text = node.nodeValue || "";
  if (!text) return null;
  let a = Math.min(offset, text.length);
  let b = a;
  while (a > 0 && EPUB_WORD_CH.test(text.charAt(a - 1))) a--;
  while (b < text.length && EPUB_WORD_CH.test(text.charAt(b))) b++;
  if (b - a < 1) return null;
  try {
    const range = doc.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    return range;
  } catch { return null; }
}

/* Palabra bajo un punto de la página (coordenadas del documento
   padre) en los documentos visibles del ePub: localiza el iframe
   que contiene el punto y resuelve la palabra con el API de caret
   de su documento (mismo origen). */
function epubSheetLocateWord(clientX, clientY) {
  if (!epubRendition) return null;
  let all = [];
  try { all = epubRendition.getContents() || []; } catch { all = []; }
  for (const contents of all) {
    const doc = contents && contents.document;
    const win = doc && doc.defaultView;
    const frame = win && win.frameElement;
    if (!doc || !win || !frame) continue;
    const rect = frame.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const range = epubWordRangeAt(doc, clientX - rect.left, clientY - rect.top);
    if (!range) return null;
    return { contents, doc, win, range };
  }
  return null;
}

/* Arranque de la selección por toque sostenido (r16): engancha la
   palabra bajo el dedo y la deja VIVA como selección real dentro
   del iframe, SIN abrir el menú todavía. Si el dedo se queda, al
   soltar el menú abre con esa palabra (como en r15); si el dedo
   se arrastra sin levantarse, epubSheetExtendSelect extiende la
   selección palabra por palabra. La lámina sigue puesta durante
   este gesto — es quien recibe el arrastre — y se retira al
   soltar, para que el ajuste fino (los tiradores) sea el nativo
   del iframe; el vigía la repone cuando la selección se limpia. */
/* Marca temporal de NUESTRA selección (r19): la selección del
   lector ya no es una selección nativa del iframe — Safari la
   adoptaba y pintaba sus tiradores azules y su menú — sino una
   anotación propia (resaltado temporal por CFI, clase
   magister-seltemp) que pinta y mueve nuestro controlador: se
   crea al enganchar la palabra, crece palabra por palabra con
   el arrastre y se retira al cerrar la hoja/menú sin acción o al
   convertirse en marca persistente. */
let epubSelTempCfi = "";

function epubSelMarkPaint(g) {
  const ctx = g.selCtx;
  const range = g.selRange;
  if (!ctx || !range || !epubRendition) return;
  let cfi = "";
  try { cfi = ctx.contents.cfiFromRange(range); } catch { cfi = ""; }
  if (!cfi || cfi === epubSelTempCfi) return;
  epubSelMarkClear();
  try {
    epubRendition.annotations.add("highlight", cfi, {}, () => {}, "magister-seltemp", { fill: "#7ea0e8", "fill-opacity": "0.45" });
    epubSelTempCfi = cfi;
  } catch { /* la sección está cambiando */ }
}

function epubSelMarkClear() {
  if (!epubSelTempCfi) return;
  const cfi = epubSelTempCfi;
  epubSelTempCfi = "";
  if (epubRendition) {
    try { epubRendition.annotations.remove(cfi, "highlight"); } catch { /* no estaba */ }
  }
  try { document.querySelectorAll('g.magister-seltemp[data-epubcfi="' + cfi + '"]').forEach((n) => n.remove()); } catch { /* pane no listo */ }
  /* Si en ese CFI había un resaltado guardado, el remove del
     gestor puede haberse llevado su dibujo: se reaplica. */
  const saved = epubFindHighlight(cfi);
  if (saved && !epubAnnoDrawn("magister-hl", cfi)) {
    epubAnnoApplied.delete("highlight|" + cfi);
    epubAnnoAdd("highlight", saved);
  }
}

function epubSheetBeginSelect(g) {
  const hit = epubSheetLocateWord(g.x0, g.y0);
  if (!hit) return false;
  if (!hit.range.toString().trim()) return false;
  g.selCtx = { contents: hit.contents, doc: hit.doc, win: hit.win, anchor: hit.range };
  g.selRange = hit.range;
  epubSelMarkPaint(g);
  return true;
}

/* Extensión palabra por palabra (r16): con la palabra bajo el
   dedo AHORA, el rango vivo dentro del iframe pasa a ir de la
   palabra ancla a la palabra actual COMPLETA — hacia adelante
   (ancla → fin de la actual) o hacia atrás (inicio de la actual
   → ancla), según dónde caiga el dedo respecto al ancla. Si el
   dedo sale del texto o del documento ancla, se conserva la
   última extensión válida. */
function epubSheetExtendSelect(g, clientX, clientY) {
  const ctx = g.selCtx;
  if (!ctx) return;
  const frame = ctx.win.frameElement;
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  if (clientX < rect.left - 24 || clientX > rect.right + 24 || clientY < rect.top - 24 || clientY > rect.bottom + 24) return;
  const range = epubWordRangeAt(ctx.doc, clientX - rect.left, clientY - rect.top);
  if (!range) return;
  try {
    const nr = ctx.doc.createRange();
    if (ctx.anchor.compareBoundaryPoints(Range.START_TO_START, range) <= 0) {
      nr.setStart(ctx.anchor.startContainer, ctx.anchor.startOffset);
      nr.setEnd(range.endContainer, range.endOffset);
    } else {
      nr.setStart(range.startContainer, range.startOffset);
      nr.setEnd(ctx.anchor.endContainer, ctx.anchor.endOffset);
    }
    /* La extensión la pinta NUESTRA marca, no la selección
       nativa: el rango vivo solo vive en el gesto (g.selRange). */
    g.selRange = nr;
    epubSelMarkPaint(g);
  } catch { /* el contenido está cambiando de sección */ }
}

/* Cierre de la selección por toque sostenido: al soltar el
   dedo, la hoja (una palabra) o el menú (un pasaje) abren con el
   TEXTO COMPLETO del rango del gesto y su CFI. La marca propia
   queda pintada bajo la hoja/menú hasta que se elija acción o
   se cierre; nunca hay selección nativa que ajustar. */
function epubSheetFinishSelect(g) {
  const ctx = g.selCtx;
  if (!ctx) return;
  let text = "";
  let cfi = "";
  if (g.selRange) {
    text = g.selRange.toString() || "";
    if (text.trim()) { try { cfi = ctx.contents.cfiFromRange(g.selRange); } catch { cfi = ""; } }
  }
  if (!text.trim()) { epubSelMarkClear(); return; }
  epubSheetSelectAt = Date.now();
  epubOnSelected(text, cfi);
  epubSheetSetOff(true);
}

function epubSheetCancelGesture() {
  const g = epubSheetGesture;
  if (g && g.longTimer) window.clearTimeout(g.longTimer);
  epubSheetGesture = null;
}

function epubSheetStart(x, y) {
  if (!epubOpen || epubSheetOff || epubCurlBusy) return;
  epubSheetCancelGesture();
  epubSelMarkClear(); /* un gesto nuevo retira cualquier marca temporal olvidada */
  const g = { x0: x, y0: y, px: 0, py: 0, dir: 0, t0: Date.now(), longTimer: 0, longFired: false, pts: [{ x, t: Date.now() }] };
  /* Origen local y esquina candidata (r18): si el gesto nace en
     una esquina del área del libro, el pase empieza como doblez
     diagonal de esa esquina, no como cilindro de borde. */
  const sheet = epubSheetEl();
  if (sheet) {
    const r = sheet.getBoundingClientRect();
    g.ox = r.left; g.oy = r.top; g.W = r.width; g.H = r.height;
    const rx = x - r.left, ry = y - r.top;
    const side = rx > r.width * 0.62 ? 1 : rx < r.width * 0.38 ? -1 : 0;
    const vert = ry < r.height * 0.30 ? "top" : ry > r.height * 0.70 ? "bot" : "";
    if (side && vert) g.corner = { side, top: vert === "top" };
    /* Nacido en el CENTRO (r23): ni banda lateral ni banda
       vertical — el pase desde ahí tiene su propio enganche. */
    g.center = !side && !vert;
  }
  epubSheetGesture = g;
  g.longTimer = window.setTimeout(() => {
    if (epubSheetGesture !== g || g.dir || g.longFired) return;
    if (Math.abs(g.px) > 10 || Math.abs(g.py) > 10) return;
    g.longFired = true;
    epubSheetBeginSelect(g);
  }, EPUB_LONGPRESS_MS);
}

function epubSheetMove(x, y) {
  const g = epubSheetGesture;
  if (!g) return;
  /* Con la selección enganchada (r16), el arrastre la extiende
     palabra por palabra: no pagina ni dobla esquina. */
  if (g.selCtx) { epubSheetExtendSelect(g, x, y); return; }
  if (g.longFired) return;
  const dx = x - g.x0;
  const dy = y - g.y0;
  g.px = dx;
  g.py = dy;
  g.pts.push({ x, t: Date.now() });
  if (g.pts.length > 14) g.pts.shift();
  if (!g.dir) {
    /* Desde una esquina el fijado es más permisivo con lo
       vertical: el arrastre natural de esquina es diagonal. */
    let lock = false;
    if (g.corner) {
      const inward = g.corner.side > 0 ? dx < 0 : dx > 0;
      if (Math.hypot(dx, dy) > 18 && inward && Math.abs(dx) > 0.45 * Math.abs(dy)) lock = true;
    } else if (g.center) {
      /* Nacido en el CENTRO (r23): basta cruzar un umbral corto
         con el mismo criterio de cono del pase de esquina
         (|dx| > 0.45·|dy|) para que el pase enganche y siga al
         dedo — en una página alta, ir del centro a una esquina
         es una diagonal con más vertical que horizontal, y el
         criterio viejo (|dx| > 1.35·|dy|) la bloqueaba entera.
         Un arrastre casi vertical sigue sin enganchar nunca, y
         la geometría de esquina mantiene el punto efectivo
         dentro del cono de 45° desde la esquina ancla: el
         volteo vertical sigue prohibido. */
      if (Math.abs(dx) >= 14 && Math.abs(dx) > 0.45 * Math.abs(dy)) lock = true;
    } else if (Math.abs(dx) > 16 && Math.abs(dx) > 1.35 * Math.abs(dy)) lock = true;
    if (lock) {
      g.dir = dx < 0 ? 1 : -1;
      /* Nacido en el centro con diagonal clara (r23): la solapa
         se ancla a la esquina del lado agarrado — arriba o abajo
         según la componente vertical — y dobla con la misma
         geometría diagonal de los pases de esquina. Casi
         horizontal queda como pase de borde (hoja larga), con
         el seguimiento 2D y la diagonal de ~30° de r24. */
      if (g.center && Math.abs(dy) > 0.4 * Math.abs(dx)) {
        g.corner = { side: g.dir > 0 ? 1 : -1, top: dy < 0 };
      }
      if (g.longTimer) { window.clearTimeout(g.longTimer); g.longTimer = 0; }
      epubCloseOverlays();
      epubChromeHideNow();
      /* El pase se monta como volteo (cilindro de borde o doblez
         diagonal de esquina); si los clones no están listos para
         esa dirección, cae al pliegue clásico. */
      g.curl = epubCurlTryBegin(g, x - (g.ox || 0), y - (g.oy || 0));
    }
  }
  if (g.dir) {
    if (g.curl) epubCurlMove(x - (g.ox || 0), y - (g.oy || 0));
    else epubFoldShow(g.dir, (g.dir > 0 ? -dx : dx) * EPUB_TURN_GAIN);
  }
}

function epubSheetEnd(x, y) {
  const g = epubSheetGesture;
  if (!g) return;
  epubSheetGesture = null;
  if (g.longTimer) window.clearTimeout(g.longTimer);
  if (g.longFired) {
    /* El toque sostenido enganchó una selección (r16): al soltar
       se cierra con el texto completo y el menú abre ahora. */
    if (g.selCtx) epubSheetFinishSelect(g);
    return;
  }
  const dx = x - g.x0;
  const dy = y - g.y0;
  const dur = Math.max(1, Date.now() - g.t0);
  if (g.dir) {
    const adv = g.dir > 0 ? -dx : dx;
    /* Velocidad de SALIDA (r18): la de los últimos ~130 ms, no la
       media del gesto — un flick corto y rápido completa aunque
       recorra poco, y un arrastre lento que se detiene antes de
       soltar no hereda velocidad antigua. */
    let velDir = adv / dur;
    const pts = g.pts || [];
    const tEnd = Date.now();
    for (let i = pts.length - 1; i >= 0; i--) {
      if (tEnd - pts[i].t >= 60) {
        const dt = Math.max(1, tEnd - pts[i].t);
        const v = (x - pts[i].x) / dt;
        velDir = g.dir > 0 ? -v : v;
        break;
      }
    }
    /* Velocidad acotada (r30): un flick real no pasa de ~3 px/ms;
       el exceso solo servía para heredar vueltas a gestos que no
       las justifican. */
    velDir = Math.max(-3, Math.min(3, velDir));
    if (g.curl) { epubCurlRelease(adv, dur, velDir); return; }
    const complete = adv >= EPUB_TURN_DX || (adv >= 24 && velDir >= 0.45);
    epubFoldSettle(g.dir, complete);
  } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dur < 600) {
    /* Prioridad (r19): un toque sobre una marca de NOTA abre la
       vista de la nota; tocar fuera de marcas alterna controles
       como siempre. */
    const noteHit = epubNoteHitAt(x, y);
    if (noteHit) epubOpenNoteView(noteHit);
    else {
      /* Un toque sobre un pasaje RESALTADO o SUBRAYADO abre el
         menú de ESE pasaje entero (r21): cambiar color, quitar
         la marca, su nota y traducir el conjunto. */
      const markHit = epubMarkHitAt(x, y);
      if (markHit) {
        epubSel = { text: markHit.entry.text || "", cfi: markHit.entry.cfi || "" };
        epubWsTransOnly = false;
        epubOpenSelMenu();
      }
      else if (epubOverlayOpen()) epubChromeShow();
      else epubTapToggle();
    }
  } else {
    epubFoldCancel();
  }
}

function epubAttachSheet() {
  const el = epubSheetEl();
  if (!el || el.__mgSheetHook) return;
  el.__mgSheetHook = true;
  /* Táctil: la vía del iPhone, en el documento padre. */
  el.addEventListener("touchstart", (e) => {
    if (!epubOpen || epubSheetOff || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    epubSheetStart(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const g = epubSheetGesture;
    if (!g) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    epubSheetMove(t.clientX, t.clientY);
    if (epubSheetGesture && epubSheetGesture.dir && e.cancelable) e.preventDefault();
  }, { passive: false });
  el.addEventListener("touchend", (e) => {
    epubMouseAt = Date.now(); /* el ratón de compatibilidad que siga se ignora */
    const ct = e.changedTouches && e.changedTouches[0];
    if (ct) epubSheetEnd(ct.clientX, ct.clientY);
    else epubSheetCancelGesture();
  });
  el.addEventListener("touchcancel", () => {
    const g = epubSheetGesture;
    epubSheetCancelGesture();
    if (g && g.selCtx) epubSheetFinishSelect(g);
    epubFoldCancel();
    if (epubCurl) epubCurlAnimate(false);
  });
  /* Ratón: el mismo núcleo (escritorio y arnés de pruebas). */
  el.addEventListener("mousedown", (e) => {
    if (!epubOpen || epubSheetOff) return;
    if (Date.now() - epubMouseAt < 700) return; /* ratón sintético tras un toque */
    epubSheetStart(e.clientX, e.clientY);
    const mv = (ev) => epubSheetMove(ev.clientX, ev.clientY);
    const up = (ev) => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
      epubMouseAt = Date.now();
      epubSheetEnd(ev.clientX, ev.clientY);
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
}

/* Gestos dentro del documento del ePub: deslizar dobla la esquina
   y al soltar cambia la página; un toque corto sin selección
   alterna los controles. El desplazamiento vertical no se toca. */
function epubAttachGestures(contents) {
  if (contents.__mgGestHook) return;
  contents.__mgGestHook = true;
  const doc = contents.document;
  doc.addEventListener("touchstart", (e) => {
    /* Con la lámina retirada (modo selección, r15) los toques del
       iframe son SOLO para ajustar la selección nativa: estos
       gestos no deben paginar ni alternar controles. Y con el
       candado de vuelta puesto (r30) tampoco entra gesto nuevo
       por esta vía mientras una vuelta asienta. */
    if (!epubOpen || epubSheetOff || epubCurlBusy || e.touches.length !== 1) { epubGesture = null; return; }
    const t = e.touches[0];
    epubGesture = { x0: t.clientX, y0: t.clientY, px: 0, py: 0, dir: 0, t0: Date.now(), contents };
  }, { passive: true });
  doc.addEventListener("touchmove", (e) => {
    const g = epubGesture;
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    g.px = dx;
    g.py = dy;
    if (!g.dir && Math.abs(dx) > 16 && Math.abs(dx) > 1.35 * Math.abs(dy)) {
      g.dir = dx < 0 ? 1 : -1;
      epubCloseOverlays();
      epubChromeHideNow();
    }
    if (g.dir) {
      if (e.cancelable) e.preventDefault();
      epubFoldShow(g.dir, (g.dir > 0 ? -dx : dx) * EPUB_TURN_GAIN);
    }
  }, { passive: false });
  const end = (e) => {
    const g = epubGesture;
    epubTouchEndAt = Date.now();
    if (!g) return;
    epubGesture = null;
    const ct = e.changedTouches && e.changedTouches[0];
    const dx = ct ? ct.clientX - g.x0 : g.px;
    const dy = ct ? ct.clientY - g.y0 : g.py;
    const dur = Math.max(1, Date.now() - g.t0);
    if (g.dir) {
      const adv = g.dir > 0 ? -dx : dx;
      const complete = adv >= EPUB_TURN_DX || (adv >= 30 && adv / dur >= 0.5);
      epubFoldSettle(g.dir, complete);
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dur < 500) {
      let sel = "";
      try { sel = g.contents.window.getSelection().toString(); } catch { sel = ""; }
      if (!sel.trim()) epubTapToggle();
    }
  };
  doc.addEventListener("touchend", end);
  doc.addEventListener("touchcancel", () => { epubGesture = null; epubFoldCancel(); });
  /* Segunda vía del toque: el click dentro del documento (iOS lo
     entrega aunque el touchend se pierda por el camino). El click
     sintético que sigue a un touchend ya atendido se ignora por
     la marca epubTouchEndAt. */
  doc.addEventListener("click", () => {
    if (!epubOpen) return;
    if (Date.now() - epubTouchEndAt < 500) return;
    let sel = "";
    try { sel = contents.window.getSelection().toString(); } catch { sel = ""; }
    if (sel.trim()) return;
    epubTapToggle();
  });
}

/* ----------------------- volteo cilíndrico (r16) --------------- */

/* El pase de página como en FlipHTML5: la hoja se levanta del
   borde y se enrolla sobre un cilindro invisible. Modelo por
   franjas verticales sobre CLONES del documento vivo:
   - la zona plana es un clon completo recortado (clip-path);
   - el arco son EPUB_STRIPS_N franjas, cada una con su rebanada
     del clon, colocadas por el modelo: tangente en x=a, arco de
     radio R (se aprieta de 96 a 38 px con el progreso) y cola
     plana detrás del rollo mostrando el REVERSO: papel
     blanquecino semitransparente, sin texto — la página
     revelada se trasluce a través de las caras traseras;
   - debajo, el clon de la página destino ya visible.
   El dedo manda sobre el BORDE libre de la hoja: dada la x del
   dedo se resuelve la tangencia «a» por bisección (el borde es
   función monótona de a). Todo son transforms: nada de layout
   durante el gesto. Los clones se preparan al asentar cada
   página (fondo, invisibles); la página destino de otra sección
   se obtiene de una segunda rendition oculta. Si algo no está
   listo, el gesto cae al pliegue de esquina de siempre. */
const EPUB_STRIPS_N = 16;
let epubCurl = null;
let epubCurlBusy = false;
let epubPoolData = null;
let epubPoolToken = 0;
let epubCurlStripEls = null;
let epubCurlRevEls = {};
let epubCurlPaper = EPUB_PAPER.oscuro;
let epubCurlTones = EPUB_CURL_TONES.oscuro;
let epubR2 = null;
let epubR2Host = null;

function epubCurlPoolSchedule() {
  setTimeout(() => { epubCurlPoolBuild().catch(() => {}); }, 90);
}

window.addEventListener("resize", () => { if (epubOpen) { epubCurlLayerSync(); epubCurlPoolSchedule(); } });

async function epubCurlPoolBuild() {
  if (!epubOpen || !epubRendition || epubCurl || epubCurlBusy) return;
  const token = ++epubPoolToken;
  let contents = [];
  try { contents = epubRendition.getContents() || []; } catch { contents = []; }
  const c = contents[0];
  const stage = epubStageEl();
  if (!c || !c.document || !stage) return;
  const frame = c.window && c.window.frameElement;
  if (!frame) return;
  const sRect = stage.getBoundingClientRect();
  const fRect = frame.getBoundingClientRect();
  const step = stage.clientWidth;
  const html = "<!DOCTYPE html>\n" + c.document.documentElement.outerHTML;
  const D = {
    ready: true, W: step, H: stage.clientHeight, step,
    cur: { html, frameW: frame.offsetWidth, frameH: frame.offsetHeight, offX: Math.round(fRect.left - sRect.left) },
    next: null, prev: null,
  };
  let idx = -1, startPage = 1, endPage = 1, endTotal = 1;
  try {
    const loc = epubRendition.currentLocation();
    if (loc && loc.start) { idx = loc.start.index; startPage = loc.start.displayed.page; }
    if (loc && loc.end) { endPage = loc.end.displayed.page; endTotal = loc.end.displayed.total; }
  } catch { /* sin ubicación todavía */ }
  if (endPage < endTotal) D.next = { html, frameW: D.cur.frameW, frameH: D.cur.frameH, offX: D.cur.offX - step };
  if (startPage > 1) D.prev = { html, frameW: D.cur.frameW, frameH: D.cur.frameH, offX: D.cur.offX + step };
  if ((!D.next || !D.prev) && epubBook && idx >= 0) {
    try {
      const r2 = await epubR2Ensure();
      if (r2 && token === epubPoolToken && epubOpen) {
        if (!D.next && idx + 1 < epubBook.spine.length) {
          if (await epubR2Show(epubBook.spine.get(idx + 1).href, false)) {
            const s = epubR2Snapshot();
            if (s && token === epubPoolToken) D.next = s;
          }
        }
        if (!D.prev && idx > 0) {
          if (await epubR2Show(epubBook.spine.get(idx - 1).href, true)) {
            const s = epubR2Snapshot();
            if (s && token === epubPoolToken) D.prev = s;
          }
        }
      }
    } catch { /* cruces de sección no listos: ese gesto usará el pliegue clásico */ }
  }
  if (token !== epubPoolToken || !epubOpen) return;
  epubPoolData = D;
  epubCurlPoolRender(D);
}

function epubCurlPoolRender(D) {
  const paper = EPUB_PAPER[epubThemeName] || EPUB_PAPER.oscuro;
  epubCurlPaper = paper;
  epubCurlTones = EPUB_CURL_TONES[epubThemeName] || EPUB_CURL_TONES.oscuro;
  const themeBg = (EPUB_THEMES[epubThemeName] || EPUB_THEMES.oscuro).bg;
  /* Anverso SÓLIDO (r18): la zona plana y las caras frontales de
     las franjas llevan el fondo OPACO del tema bajo el texto —
     nada de la página de detrás se trasluce a través del anverso.
     (El reverso conserva su papel blanquecino translúcido.) */
  const flatWrap = document.getElementById("epub-curl-flat");
  if (flatWrap) flatWrap.style.background = themeBg;
  const flatF = document.querySelector("#epub-curl-flat iframe");
  if (flatF) {
    flatF.style.width = D.cur.frameW + "px";
    flatF.style.height = D.cur.frameH + "px";
    flatF.style.transform = "translateX(" + D.cur.offX + "px)";
    if (flatF.__mgHtml !== D.cur.html) { flatF.__mgHtml = D.cur.html; flatF.srcdoc = D.cur.html; }
  }
  /* Solapa diagonal (r18): el fantasma espejado es un clon más de
     la página actual (el JS lo refleja con una matriz al doblar);
     el papel translúcido va encima y lo deja apenas insinuado. */
  const flapF = document.querySelector("#epub-curl-flap iframe");
  if (flapF) {
    flapF.style.width = D.cur.frameW + "px";
    flapF.style.height = D.cur.frameH + "px";
    flapF.style.transform = "translateX(" + D.cur.offX + "px)";
    if (flapF.__mgHtml !== D.cur.html) { flapF.__mgHtml = D.cur.html; flapF.srcdoc = D.cur.html; }
  }
  const flapPaper = document.querySelector("#epub-curl-flap .cv-flap-paper");
  if (flapPaper) flapPaper.style.background = paper;
  const revs = document.getElementById("epub-curl-revs");
  if (revs) {
    revs.innerHTML = "";
    epubCurlRevEls = {};
    for (const key of ["next", "prev"]) {
      const T = D[key];
      if (!T) continue;
      const wrap = document.createElement("div");
      wrap.className = "cv-wrap";
      wrap.style.display = "none";
      const f = document.createElement("iframe");
      f.setAttribute("tabindex", "-1");
      f.style.width = T.frameW + "px";
      f.style.height = T.frameH + "px";
      f.style.transform = "translateX(" + T.offX + "px)";
      f.srcdoc = T.html;
      wrap.appendChild(f);
      revs.appendChild(wrap);
      epubCurlRevEls[key] = wrap;
    }
  }
  const holder = document.getElementById("epub-curl-strips");
  if (holder) {
    if (!epubCurlStripEls || epubCurlStripEls.length !== EPUB_STRIPS_N) {
      epubCurlStripEls = epubCurlBuildStrips(holder);
    }
    for (const s of epubCurlStripEls) {
      s.iframe.style.width = D.cur.frameW + "px";
      s.iframe.style.height = D.cur.frameH + "px";
      if (s.iframe.__mgHtml !== D.cur.html) { s.iframe.__mgHtml = D.cur.html; s.iframe.srcdoc = D.cur.html; }
      s.backPaper.style.background = paper;
      s.frontEl.style.background = themeBg;
    }
  }
}

function epubCurlBuildStrips(holder) {
  holder.innerHTML = "";
  const out = [];
  for (let j = 0; j < EPUB_STRIPS_N; j++) {
    const strip = document.createElement("div");
    strip.className = "cv-strip";
    strip.innerHTML =
      '<div class="cv-face cv-front"><div class="cv-clip"><iframe tabindex="-1"></iframe></div><div class="cv-shade"></div><div class="cv-sheen"></div></div>' +
      '<div class="cv-face cv-back"><div class="cv-paper"></div><div class="cv-shade"></div></div>';
    holder.appendChild(strip);
    out.push({
      el: strip,
      frontEl: strip.querySelector(".cv-front"),
      backEl: strip.querySelector(".cv-back"),
      iframe: strip.querySelector(".cv-front iframe"),
      frontShade: strip.querySelector(".cv-front .cv-shade"),
      frontSheen: strip.querySelector(".cv-front .cv-sheen"),
      backPaper: strip.querySelector(".cv-back .cv-paper"),
      backShade: strip.querySelector(".cv-back .cv-shade"),
    });
  }
  return out;
}

/* Segunda rendition, oculta y sin gestos, solo para fotografiar
   (serializar) la primera página de la sección siguiente o la
   última de la anterior cuando el volteo cruza de capítulo. */
async function epubR2Ensure() {
  if (epubR2) return epubR2;
  const stage = epubStageEl();
  if (!stage || !epubBook) return null;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
  host.style.width = stage.clientWidth + "px";
  host.style.height = stage.clientHeight + "px";
  stage.appendChild(host);
  const r2 = epubBook.renderTo(host, { width: "100%", height: "100%", flow: "paginated", spread: "none" });
  try { r2.themes.fontSize(epubFontPct + "%"); } catch { /* sin temas aún */ }
  r2.hooks.content.register((contents) => { epubApplyThemeToDoc(contents); });
  epubR2 = r2;
  epubR2Host = host;
  return r2;
}

async function epubR2Show(href, toLast) {
  const r2 = epubR2;
  if (!r2) return false;
  const job = (async () => {
    await r2.display(href);
    if (toLast) {
      let total = 1;
      try {
        const loc = r2.currentLocation();
        if (loc && loc.end && loc.end.displayed) total = loc.end.displayed.total;
      } catch { total = 1; }
      for (let i = 1; i < total; i++) await r2.next();
    }
    return true;
  })();
  return Promise.race([job, new Promise((r) => setTimeout(() => r(false), 4500))]).catch(() => false);
}

function epubR2Snapshot() {
  const r2 = epubR2;
  if (!r2 || !epubR2Host) return null;
  let contents = [];
  try { contents = r2.getContents() || []; } catch { contents = []; }
  const c = contents[0];
  if (!c || !c.document) return null;
  const frame = c.window && c.window.frameElement;
  if (!frame) return null;
  const hRect = epubR2Host.getBoundingClientRect();
  const fRect = frame.getBoundingClientRect();
  return {
    html: "<!DOCTYPE html>\n" + c.document.documentElement.outerHTML,
    frameW: frame.offsetWidth,
    frameH: frame.offsetHeight,
    offX: Math.round(fRect.left - hRect.left),
  };
}

function epubR2Destroy() {
  if (epubR2) { try { epubR2.destroy(); } catch { /* ya destruida */ } epubR2 = null; }
  if (epubR2Host) { try { epubR2Host.remove(); } catch { /* ya fuera */ } epubR2Host = null; }
}

/* La capa del volteo vive sobre la cáscara, alineada con el
   escenario (r18): el escenario recorta (overflow:hidden) y la
   hoja que se dobla debe poder salirse del rectángulo del libro
   hacia arriba y hacia abajo durante el pase. La cáscara no
   recorta, así que la solapa viaja libre dentro de la pantalla. */
function epubCurlLayerSync() {
  const layer = document.getElementById("epub-curl");
  const shell = document.getElementById("epub-shell");
  const stage = epubStageEl();
  if (!layer || !shell || !stage) return;
  if (layer.parentElement !== shell) shell.appendChild(layer);
  const sr = stage.getBoundingClientRect();
  const hr = shell.getBoundingClientRect();
  layer.style.left = (sr.left - hr.left) + "px";
  layer.style.top = (sr.top - hr.top) + "px";
  layer.style.width = sr.width + "px";
  layer.style.height = sr.height + "px";
}

function epubCurlTryBegin(g, x, y) {
  if (epubCurl || epubCurlBusy) return false;
  const D = epubPoolData;
  if (!D || !D.ready) return false;
  const key = g.dir > 0 ? "next" : "prev";
  if (!D[key] || !epubCurlRevEls[key] || !epubCurlStripEls) return false;
  const layer = document.getElementById("epub-curl");
  if (!layer) return false;
  epubCurlLayerSync();
  const T = EPUB_CURL_TONES[epubThemeName] || EPUB_CURL_TONES.oscuro;
  epubCurlTones = T;
  const themeBg = (EPUB_THEMES[epubThemeName] || EPUB_THEMES.oscuro).bg;
  for (const k of ["next", "prev"]) {
    if (epubCurlRevEls[k]) epubCurlRevEls[k].style.display = k === key ? "" : "none";
  }
  /* Modo: doblez diagonal si el gesto nació en la esquina de ese
     lado; doblez de borde (pliegue vertical) en cualquier otro
     caso. Desde r21 AMBOS pases comparten la misma geometría de
     doblez verdadero (plano + solapa reflejada + banda de tonos):
     el de borde dejó de ser el cilindro de franjas estrecho, que
     viajaba casi solo y empalmaba los textos de las dos páginas
     en la zona del pliegue (foto de Sergio del pase a mitad). */
  const cornerMode = !!(g.corner && ((g.corner.side > 0 && g.dir > 0) || (g.corner.side < 0 && g.dir < 0)));
  const tail = document.getElementById("epub-curl-tail");
  const sha = document.getElementById("epub-curl-sha");
  const shb = document.getElementById("epub-curl-shb");
  const arc = document.getElementById("epub-curl-arc");
  const holder = document.getElementById("epub-curl-strips");
  const flap = document.getElementById("epub-curl-flap");
  const cast = document.getElementById("epub-curl-cast");
  const wash = document.getElementById("epub-curl-wash");
  const flatWrap = document.getElementById("epub-curl-flat");
  if (flatWrap) { flatWrap.style.background = themeBg; flatWrap.style.clipPath = ""; }
  if (epubCurlStripEls) for (const s of epubCurlStripEls) s.frontEl.style.background = themeBg;
  if (wash) wash.style.background = g.dir > 0 ? T.wash : T.washPrev;
  /* La geometría activa es la solapa de doblez (diagonal en
     esquina, vertical en borde): las franjas del cilindro quedan
     fuera (holder oculto) durante TODO el gesto en ambos pases —
     la hoja manda hasta soltar; nada de salto temprano. */
  if (holder) holder.style.visibility = "hidden";
  if (tail) tail.style.display = "none";
  if (sha) sha.style.display = "none";
  if (shb) shb.style.display = "none";
  if (arc) arc.style.display = "none";
  if (cast) {
    cast.style.display = "";
    cast.style.background = "linear-gradient(90deg, " + T.cast + " 0%, rgba(0,0,0,0) 100%)";
  }
  if (flap) {
    flap.hidden = false;
    const band = flap.querySelector(".cv-flap-band");
    if (band) band.style.background = "linear-gradient(90deg, " + T.root + " 0%, " + T.crest + " 30%, " + T.fall + " 65%, rgba(0,0,0,0) 100%)";
    const fp = flap.querySelector(".cv-flap-paper");
    if (fp) fp.style.background = epubCurlPaper;
  }
  const viewer = document.getElementById("epub-viewer");
  if (viewer) viewer.style.visibility = "hidden";
  layer.hidden = false;
  epubCurl = {
    dir: g.dir, mode: cornerMode ? "corner" : "edge",
    fx: x, fy: y, bx: x, by: y, dragGain: EPUB_TURN_GAIN,
    W: D.W, H: D.H, frameOff: D.cur.offX, xi: D.W, raf: 0, anim: false,
    kx: g.dir > 0 ? D.W : 0,
    ky: cornerMode && g.corner ? (g.corner.top ? 0 : D.H) : Math.max(0, Math.min(D.H, y)),
    /* Nacido en el centro (r23): mid lo marca para el umbral de
       soltura por recorrido; x0 es la x local donde nació el
       gesto, para medir el avance desde el nacimiento, no
       desde el borde. */
    mid: !!g.center, x0: (g.x0 || 0) - (g.ox || 0),
  };
  epubCurlBusy = true;
  epubCurlFrame();
  return true;
}

function epubCurlMove(x, y) {
  if (!epubCurl || epubCurl.anim) return;
  /* El punto efectivo conserva la posición exacta del dedo al
     enganchar (bx,by) y desde ahí recorre cada desplazamiento
     posterior, en X y en Y, multiplicado por dragGain. Desde r27
     la ganancia es 1: la punta sigue al dedo 1:1, sin retardo
     temporal — responde en el mismo evento y sigue su
     trayectoria 2D exacta (como en r24/r25). */
  epubCurl.fx = epubCurl.bx + (x - epubCurl.bx) * epubCurl.dragGain;
  epubCurl.fy = epubCurl.by + (y - epubCurl.by) * epubCurl.dragGain;
  epubCurlFrame();
}

function epubCurlFrame() {
  const C = epubCurl;
  if (!C) return;
  if (C.mode === "corner") { epubCurlCornerFrame(); return; }
  epubCurlEdgeFrame();
}

/* Doblez verdadero (r18; unificado en r21): pliegue cuya línea
   es la mediatriz perpendicular entre el punto agarrado K y el
   dedo F — la esquina (o el borde) se refleja sobre esa línea y
   sigue al dedo. La parte plana es el rectángulo menos el lado
   agarrado; la solapa es ese lado reflejado, con su fantasma
   espejado bajo el papel translúcido del reverso, la banda de
   tonos pegada a la línea y la sombra proyectada sobre la página
   revelada. La forma del pliegue se mantiene durante TODO el
   arrastre: la página entera cede detrás de la línea, sin saltar
   a otro modelo. El dedo manda 1:1 mientras está apoyado: nada
   se completa ni regresa solo hasta soltar.
   ESQUINA (r21): el punto efectivo vive dentro de un CONO
   DIAGONAL de ~45° desde la esquina de origen — el desplaza-
   miento vertical nunca supera al horizontal hacia el lado
   contrario — para que la hoja jamás se voltee como libreta
   (pliegue horizontal, de arriba hacia abajo: foto prohibida de
   Sergio). La punta sí puede llegar ~a media altura, pero solo
   como parte del recorrido diagonal profundo (su foto máxima).
   BORDE (r21; 2D en r24): la hoja conserva su longitud de
   página completa durante todo el recorrido — tramo plano
   largo + solapa-reverso larga tras el pliegue — en vez del
   cilindro estrecho que viajaba casi solo empalmando los dos
   textos; desde r24 el punto efectivo sigue al dedo en 2D y
   sigue al dedo en 2D dentro del tope duro de 15° de la
   precisión r30, sin sesgo automático (ver epubCurlEdgeFrame). */
function epubCurlCornerFrame() {
  const C = epubCurl;
  if (!C) return;
  const W = C.W, H = C.H;
  const K = { x: C.kx, y: C.ky };
  const F = {
    x: Math.max(-90, Math.min(W + 90, C.fx)),
    y: Math.max(-90, Math.min(H + 90, C.fy)),
  };
  /* Anti-voltereta (r30): la punta nunca cruza al otro lado de
     su esquina ancla — si el dedo rodea y vuelve más allá de la
     esquina, el reflejo se quedaba del otro lado y la hoja daba
     una voltereta sobre sí misma (reporte de Sergio). */
  if (C.dir > 0) F.x = Math.min(F.x, K.x + 24);
  else F.x = Math.max(F.x, K.x - 24);
  /* Cono diagonal de ~45° (r21): lo vertical queda amarrado a lo
     horizontal; un arrastre con dominante vertical apenas asoma
     la esquina en diagonal y al soltar la página queda como
     estaba (el avance útil se mide desde este punto efectivo). */
  const dxT = C.dir > 0 ? K.x - F.x : F.x - K.x;
  const maxDy = Math.max(0, dxT);
  if (F.y > K.y + maxDy) F.y = K.y + maxDy;
  else if (F.y < K.y - maxDy) F.y = K.y - maxDy;
  epubCurlFoldFrame(K, F);
}

/* Pase de borde: la hoja sigue al dedo EN 2D (r24). K es el
   punto del borde agarrado (a la altura en que nació el gesto)
   y F el punto donde debe caer su reflejo: F.x es la x del
   dedo y F.y su y — si a mitad de un pase horizontal el dedo
   sube o baja, la esquina del lado que voltea se JALA con él
   (la misma matemática de doblez de los pases de esquina: la
   punta cae sobre el punto efectivo) en vez de quedarse en un
   riel horizontal rígido como hasta r23, donde la Y del dedo
   se ignoraba entera y el pase se sentía bloqueado (Sergio,
   sobre la r23: «sigue igual que antes»).
   PRECISIÓN r30 (Sergio, con su captura photo-86 — MANDA sobre
   la diagonal de 30° de r24): en los pases horizontales la
   inclinación de la línea de doblez tiene un TOPE DURO de 15°
   (el de su captura, medido en 14,7°) y los movimientos hacia
   arriba o abajo aparecen SOLO si el dedo se mueve de verdad
   en esas direcciones, 1:1. Por eso:
   - el sesgo automático de r24 DESAPARECE: sin Δy del dedo, la
     esquina se queda a la altura donde nació el pase y el
     pliegue va vertical;
   - el Δy real del dedo queda amarrado al tope: |F.y − K.y| ≤
     recorrido · tan(15°) — el pliegue jamás se inclina más que
     lo de la captura, deambule lo que deambule el dedo;
   - la punta nunca cruza al otro lado del ancla ni sale del
     área extendida: un arrastre en círculo solo mece el doblez
     dentro de esos límites, sin voltereta (reporte de Sergio:
     «cuando hago un movimiento como de círculo con el dedo
     hace como una voltereta de la página; no puede hacer eso»).
   El resto de la página acompaña como siempre: la geometría
   de doblez verdadero no cambia, solo el punto efectivo. */
function epubCurlEdgeFrame() {
  const C = epubCurl;
  if (!C) return;
  const K = { x: C.kx, y: C.ky };
  const F = { x: C.fx, y: C.fy };
  if (C.dir > 0) F.x = Math.min(F.x, K.x + 24);
  else F.x = Math.max(F.x, K.x - 24);
  F.x = Math.max(-90, Math.min(C.W + 90, F.x));
  F.y = Math.max(-90, Math.min(C.H + 90, F.y));
  const run = Math.abs(F.x - K.x);
  const maxDy = run * Math.tan(EPUB_EDGE_TILT_MAX * Math.PI / 180);
  if (F.y > K.y + maxDy) F.y = K.y + maxDy;
  else if (F.y < K.y - maxDy) F.y = K.y - maxDy;
  epubCurlFoldFrame(K, F);
}

function epubCurlFoldFrame(K, F) {
  const C = epubCurl;
  if (!C) return;
  const W = C.W, H = C.H;
  C.xi = C.dir > 0 ? F.x : W - F.x;

  const flat = document.getElementById("epub-curl-flat");
  const flap = document.getElementById("epub-curl-flap");
  const cast = document.getElementById("epub-curl-cast");
  const dx = F.x - K.x, dy = F.y - K.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 6) {
    if (flat) flat.style.clipPath = "";
    if (flap) flap.style.clipPath = "polygon(0px 0px, 0px 0px, 0px 0px)";
    if (cast) cast.style.display = "none";
    return;
  }
  const nx = dx / dist, ny = dy / dist;
  const M = { x: (K.x + F.x) / 2, y: (K.y + F.y) / 2 };
  const sOf = (p) => (p.x - M.x) * nx + (p.y - M.y) * ny;
  const rect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const clipHalf = (poly, keepPos) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const sP = sOf(P), sQ = sOf(Q);
      const inP = keepPos ? sP >= 0 : sP <= 0;
      const inQ = keepPos ? sQ >= 0 : sQ <= 0;
      if (inP) out.push(P);
      if (inP !== inQ) {
        const t = sP / (sP - sQ);
        out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
      }
    }
    return out;
  };
  const polyStr = (poly) => poly.length >= 3
    ? "polygon(" + poly.map((p) => p.x.toFixed(1) + "px " + p.y.toFixed(1) + "px").join(", ") + ")"
    : "polygon(0px 0px, 0px 0px, 0px 0px)";
  if (flat) flat.style.clipPath = polyStr(clipHalf(rect, true));
  /* La solapa NO se recorta al rectángulo: su polígono reflejado
     puede salirse del área del libro (la capa no recorta). */
  const refl = clipHalf(rect, false).map((p) => {
    const s = sOf(p);
    return { x: p.x - 2 * s * nx, y: p.y - 2 * s * ny };
  });
  if (flap) {
    flap.style.clipPath = polyStr(refl);
    const ghost = flap.querySelector(".cv-flap-reflect");
    if (ghost) {
      const mdn = M.x * nx + M.y * ny;
      const ga = 1 - 2 * nx * nx, gb = -2 * nx * ny, gd = 1 - 2 * ny * ny;
      ghost.style.transform = "matrix(" + ga.toFixed(4) + ", " + gb.toFixed(4) + ", " + gb.toFixed(4) + ", " + gd.toFixed(4) + ", " + (2 * mdn * nx).toFixed(1) + ", " + (2 * mdn * ny).toFixed(1) + ")";
    }
    const phi = Math.atan2(ny, nx) * 180 / Math.PI;
    const band = flap.querySelector(".cv-flap-band");
    if (band) band.style.transform = "translate(" + M.x.toFixed(1) + "px, " + M.y.toFixed(1) + "px) rotate(" + phi.toFixed(1) + "deg) translate(0px, -1300px)";
  }
  if (cast) {
    cast.style.display = "";
    const phiC = Math.atan2(ny, nx) * 180 / Math.PI + 180;
    cast.style.transform = "translate(" + M.x.toFixed(1) + "px, " + M.y.toFixed(1) + "px) rotate(" + phiC.toFixed(1) + "deg) translate(0px, -1300px)";
  }
}

function epubCurlRelease(adv, dur, velDir) {
  const C = epubCurl;
  if (!C) return;
  /* Umbral de posición, o flick: velocidad de salida alta con un
     recorrido mínimo — el pase se completa solo con su animación
     aunque el arrastre haya sido corto. */
  const vel = typeof velDir === "number" ? velDir : adv / Math.max(1, dur);
  /* Nacido en el centro (r23): el dedo ya nace a mitad de
     página, así que la posición absoluta (xi) no sirve de
     umbral — un recorrido corto y lento debe volver aunque el
     dedo siga a la izquierda del centro — : manda el RECORRIDO
     desde el nacimiento, o el flick, como en los demás pases. */
  const complete = C.mid
    ? adv >= C.W * 0.36 || (adv >= 24 && vel >= 0.45)
    : C.xi < C.W * 0.5 || (adv >= 24 && vel >= 0.45) || (C.xi < C.W * 0.74 && vel >= 0.5);
  epubCurlAnimate(complete);
}

function epubCurlAnimate(complete) {
  const C = epubCurl;
  if (!C || C.anim) return;
  C.anim = true;
  const fromX = C.fx, fromY = C.fy;
  let toX, toY;
  if (complete) {
    if (C.mode === "edge") {
      /* La hoja de borde barre la página ENTERA (r21): su borde
         libre cruza todo el ancho y sale por el lado contrario,
         como la página larga que es — con la geometría de
         pliegue vertical, quedarse a mitad de pantalla dejaría
         media hoja visible al asentar. */
      toX = C.dir > 0 ? -(C.W + 90) : 2 * C.W + 90;
      toY = fromY;
    } else {
      toX = C.dir > 0 ? -80 : C.W + 80;
      toY = C.mode === "corner" ? C.H / 2 : fromY;
    }
  } else if (C.mode === "corner") {
    toX = C.kx; toY = C.ky;
  } else {
    toX = C.dir > 0 ? C.W + 30 : -30;
    toY = fromY;
  }
  const t0 = performance.now();
  const DUR = EPUB_CURL_RELEASE_MS;
  const stepFn = (t) => {
    if (epubCurl !== C) return;
    const k = Math.min(1, (t - t0) / DUR);
    const e = 1 - Math.pow(1 - k, 3);
    C.fx = fromX + (toX - fromX) * e;
    C.fy = fromY + (toY - fromY) * e;
    epubCurlFrame();
    if (k < 1) C.raf = requestAnimationFrame(stepFn);
    else epubCurlSettle(complete);
  };
  C.raf = requestAnimationFrame(stepFn);
}

function epubCurlSettle(complete) {
  const C = epubCurl;
  epubCurl = null;
  if (!C) return;
  const finish = () => {
    const layer = document.getElementById("epub-curl");
    if (layer) layer.hidden = true;
    const viewer = document.getElementById("epub-viewer");
    if (viewer) viewer.style.visibility = "";
    const flap = document.getElementById("epub-curl-flap");
    if (flap) flap.hidden = true;
    const cast = document.getElementById("epub-curl-cast");
    if (cast) cast.style.display = "none";
    const holder = document.getElementById("epub-curl-strips");
    if (holder) holder.style.visibility = "";
    const flatWrap = document.getElementById("epub-curl-flat");
    if (flatWrap) flatWrap.style.clipPath = "";
    epubCurlBusy = false;
    if (complete) epubCurlPoolSchedule();
  };
  if (!complete || !epubRendition) { finish(); return; }
  let done = false;
  const once = () => { if (!done) { done = true; finish(); } };
  try {
    const pr = C.dir > 0 ? epubRendition.next() : epubRendition.prev();
    if (pr && pr.then) pr.then(() => setTimeout(once, 40), () => setTimeout(once, 40));
    setTimeout(once, 700);
  } catch { once(); }
}

/* ------------------------------------------------- arranque */

/* Apertura a prueba de fallos (r15): cualquier excepción en la
   inicialización normal cae al MODO MÍNIMO — libro desde la
   portada, lámina de gestos y controles, sin posición ni marcas —
   en vez de a una pantalla muerta. Solo si también el mínimo
   falla queda el aviso, que no intercepta toques (la salida de la
   barra sigue viva). */
let epubMinimal = false;

async function initEpubReader() {
  epubOpen = true;
  epubCurlLayerSync();
  const seq = ++epubInitSeq;
  if (!epubCurrent) {
    const loading = document.getElementById("epub-loading");
    if (loading) { loading.hidden = false; loading.textContent = T("No hay ningún libro abierto."); }
    return;
  }
  try {
    epubBytes = await epubFetchCurrent();
  } catch (fatal) {
    if (seq !== epubInitSeq) return;
    const loading = document.getElementById("epub-loading");
    if (loading) { loading.hidden = false; loading.textContent = fatal.message; }
    epubSheetSetOff(false);
    epubChromeShow();
    return;
  }
  if (seq !== epubInitSeq) return;
  try {
    await epubOpenBook(seq, false);
  } catch (err) {
    if (seq !== epubInitSeq) return;
    epubTeardownBook();
    try {
      await epubOpenBook(seq, true);
    } catch (err2) {
      if (seq !== epubInitSeq) return;
      const loading = document.getElementById("epub-loading");
      if (loading) {
        loading.hidden = false;
        loading.textContent = T("No se pudo abrir el libro. Revisa tu conexión y vuelve a intentarlo.");
      }
      epubSheetSetOff(false);
      epubChromeShow();
    }
  }
}

/* Descarga el EPUB del libro abierto desde el servicio de lectura
   (que aplica el modelo de acceso con la sesión). Un error del
   servicio —sin sesión, muestra no disponible— es definitivo y se
   muestra tal cual: no cae al modo mínimo. */
async function epubFetchCurrent() {
  if (!token) throw new Error(T("Inicia sesión para leer este libro."));
  let res;
  try {
    res = await fetch(MAGISTER_API_BASE + "/leer/" + epubCurrent.gid, {
      headers: { Authorization: "Bearer " + token },
    });
  } catch { throw new Error(T("No se pudo descargar el libro. Revisa tu conexión y vuelve a intentarlo.")); }
  if (!res.ok) {
    let msg = "";
    try { const j = await res.json(); msg = (j && j.error) || ""; } catch { /* respuesta sin cuerpo */ }
    throw new Error(msg || T("No se pudo abrir el libro."));
  }
  epubCurrent.acceso = res.headers.get("X-Magister-Acceso") || "completo";
  return res.arrayBuffer();
}

function epubTeardownBook() {
  if (epubRendition) { try { epubRendition.destroy(); } catch { /* ya destruido */ } epubRendition = null; }
  if (epubBook) { try { epubBook.destroy(); } catch { /* ya destruido */ } epubBook = null; }
  const viewer = document.getElementById("epub-viewer");
  if (viewer) viewer.innerHTML = "";
}

async function epubOpenBook(seq, minimal) {
  epubMinimal = !!minimal;
  epubRestoreSettings();
  epubSyncChrome();
  const loading = document.getElementById("epub-loading");
  await epubLoadLibs();
  if (seq !== epubInitSeq || view.name !== "epub") throw new Error("apertura cancelada");
  epubBook = window.ePub(epubBytes);
  epubRendition = epubBook.renderTo("epub-viewer", {
    width: "100%", height: "100%", flow: "paginated", spread: "none",
  });
  epubRendition.themes.fontSize(epubFontPct + "%");
  epubRendition.hooks.content.register((contents) => { epubStyleContents(contents); });
  epubRendition.on("relocated", (loc) => { epubOnRelocated(loc); });
  epubRendition.on("selected", (cfiRange, contents) => {
    let raw = "";
    try { raw = contents.window.getSelection().toString(); } catch { raw = ""; }
    if (raw && raw.trim()) epubOnSelected(raw, cfiRange);
  });
  let startAt;
  if (!minimal) {
    try { startAt = window.localStorage.getItem(epubPosKey()) || undefined; } catch { startAt = undefined; }
    /* Posición con forma imposible (guardada por otra build o
       dañada): se descarta ANTES de pedirla, no tras el fracaso. */
    if (startAt && !epubIsCfi(startAt)) { epubStoreRemove(epubPosKey()); startAt = undefined; }
  }
  try {
    await epubRendition.display(startAt);
  } catch (dispErr) {
    /* Una posición guardada que no se puede resolver (CFI de una
       sesión anterior dañado o incompatible con esta build) no
       debe condenar el lector a la pantalla de error: se descarta
       la posición y el libro se abre desde la portada. */
    if (!startAt) throw dispErr;
    epubStoreRemove(epubPosKey());
    await epubRendition.display();
  }
  if (seq !== epubInitSeq) throw new Error("apertura cancelada");
  if (loading) loading.hidden = true;
  const muestraNote = document.getElementById("epub-muestra-note");
  if (muestraNote) muestraNote.hidden = !(epubCurrent && epubCurrent.acceso === "muestra");
  /* Las marcas se reaplican con su propio blindaje; jamás tumban
     la apertura, y en el modo mínimo ni se intentan. */
  if (!minimal) { try { epubApplyAnnotations(); } catch { /* sin marcas en esta apertura */ } }
  epubAttachSheet();
  epubWsAttach();
  epubAttachStageTap();
  epubSheetWatchStart();
  epubSheetSync();
  epubChromeShow();
  epubCurlPoolSchedule();
  epubBook.loaded.navigation
    .then((nav) => { if (seq === epubInitSeq) epubFillToc(nav && nav.toc ? nav.toc : []); })
    .catch(() => {});
  epubBook.ready
    .then(() => { if (seq === epubInitSeq && epubBook) return epubBook.locations.generate(1200); })
    .then(() => { if (seq === epubInitSeq) epubUpdateProgress(); })
    .catch(() => {});
}

function destroyEpubReader() {
  /* La posición queda guardada POR LIBRO también al salir (la de
     cada página ya la guarda «relocated» al pasar). */
  try {
    const l = epubRendition && epubRendition.location;
    if (l && l.start && l.start.cfi) window.localStorage.setItem(epubPosKey(), l.start.cfi);
  } catch { /* sin almacenamiento */ }
  epubBytes = null;
  epubInitSeq++;
  epubDictSeq++;
  epubOpen = false;
  epubLastPct = -1;
  epubSel = null;
  epubGesture = null;
  epubFold = null;
  if (epubCurl && epubCurl.raf) { try { cancelAnimationFrame(epubCurl.raf); } catch { /* sin rAF */ } }
  epubCurl = null;
  epubCurlBusy = false;
  epubPoolData = null;
  epubPoolToken++;
  epubR2Destroy();
  { const ce = document.getElementById("epub-curl"); if (ce) ce.hidden = true; }
  { const ve = document.getElementById("epub-viewer"); if (ve) ve.style.visibility = ""; }
  epubAnnoApplied.clear();
  epubChromeClearTimer();
  epubSheetWatchStop();
  epubSheetCancelGesture();
  epubSheetOff = false;
  epubMinimal = false;
  { const fe = epubFoldEl(); if (fe) fe.hidden = true; }
  if (epubRendition) { try { epubRendition.destroy(); } catch { /* ya destruido */ } epubRendition = null; }
  if (epubBook) { try { epubBook.destroy(); } catch { /* ya destruido */ } epubBook = null; }
}

function epubOnRelocated(loc) {
  try {
    if (loc && loc.start && loc.start.cfi) {
      window.localStorage.setItem(epubPosKey(), loc.start.cfi);
    }
  } catch { /* sin almacenamiento */ }
  epubUpdateProgress();
  epubCurlPoolSchedule();
}

function epubUpdateProgress() {
  try {
    const fill = document.getElementById("epub-prog-fill");
    const txt = document.getElementById("epub-prog-txt");
    if (!fill || !txt || !epubBook) return;
    let cfi = null;
    try { cfi = window.localStorage.getItem(epubPosKey()); } catch { cfi = null; }
    if (cfi && !epubIsCfi(cfi)) { epubStoreRemove(epubPosKey()); cfi = null; }
    let pct = -1;
    if (cfi && epubBook.locations && typeof epubBook.locations.percentageFromCfi === "function") {
      let p = NaN;
      try { p = epubBook.locations.percentageFromCfi(cfi); } catch { p = NaN; }
      if (typeof p === "number" && isFinite(p) && p >= 0) pct = Math.round(p * 100);
    }
    if (pct >= 0) {
      epubLastPct = pct;
      fill.style.width = pct + "%";
      txt.textContent = pct + " % del libro";
    } else if (epubLastPct >= 0) {
      txt.textContent = epubLastPct + " % del libro";
    } else {
      txt.textContent = T("Calculando el progreso…");
    }
  } catch { /* el progreso es informativo; nunca rompe la lectura */ }
}

function epubFontStep(delta) {
  epubFontPct = Math.min(170, Math.max(80, epubFontPct + delta));
  if (epubRendition) epubRendition.themes.fontSize(epubFontPct + "%");
  epubSaveSettings();
  epubPoke();
  epubCurlPoolSchedule();
}

function epubToggleTheme() {
  epubThemeName = epubThemeName === "claro" ? "oscuro" : "claro";
  epubSaveSettings();
  epubSyncChrome();
  if (epubRendition) {
    try { epubRendition.getContents().forEach((c) => epubStyleContents(c)); } catch { /* la próxima sección ya nacerá con el tema */ }
  }
  epubPoke();
  epubCurlPoolSchedule();
}

/* ------------------------------------------------------ índice */

function epubFillToc(toc) {
  const list = document.getElementById("epub-toc-list");
  if (!list) return;
  if (!toc || !toc.length) {
    list.innerHTML = `<p class="epub-toc-empty">${T("Este libro no trae índice.")}</p>`;
    return;
  }
  const flat = [];
  const walk = (items) => { for (const it of items) { flat.push(it); if (it.subitems && it.subitems.length) walk(it.subitems); } };
  walk(toc);
  list.innerHTML = flat.map((it) =>
    `<button type="button" class="epub-toc-item" data-action="epub-toc-go" data-href="${esc(it.href)}">${esc(String(it.label || "").trim())}</button>`
  ).join("");
}

/* Paneles que caen desde arriba (r19): el índice y el buscador
   comparten presentación — anclados arriba, abren a la MITAD
   del alto del escenario y se ESTIRAN arrastrando el asa del
   borde inferior hasta el 100% (y de vuelta); al soltar por
   debajo del 38% se colapsan y cierran. Tocar fuera (el fondo)
   también cierra. */
function epubTopBackdropSync() {
  const bd = document.getElementById("epub-top-backdrop");
  if (!bd) return;
  const toc = document.getElementById("epub-toc");
  const sea = document.getElementById("epub-search");
  const men = document.getElementById("epub-menu");
  bd.hidden = !((toc && !toc.hidden) || (sea && !sea.hidden) || (men && !men.hidden));
}

function epubTopAttach() {
  const bd = document.getElementById("epub-top-backdrop");
  if (bd && !bd.__mgTopHook) {
    bd.__mgTopHook = true;
    bd.addEventListener("click", () => { epubCloseOverlays(); epubPoke(); });
  }
  document.querySelectorAll("[data-topgrip]").forEach((grip) => {
    if (grip.__mgGripHook) return;
    grip.__mgGripHook = true;
    const panelId = grip.getAttribute("data-topgrip");
    let drag = null;
    const yOf = (e) => (e.touches && e.touches[0]) ? e.touches[0].clientY : (typeof e.clientY === "number" ? e.clientY : 0);
    const start = (e) => {
      const p = document.getElementById(panelId);
      const st = epubStageEl();
      if (!p || !st) return;
      drag = { y0: yOf(e), h0: p.clientHeight, H: st.clientHeight };
    };
    const move = (e) => {
      if (!drag) return;
      const p = document.getElementById(panelId);
      if (!p) return;
      p.style.height = Math.max(60, Math.min(drag.H, drag.h0 + (yOf(e) - drag.y0))) + "px";
      if (e.cancelable) e.preventDefault();
    };
    const end = () => {
      if (!drag) return;
      const p = document.getElementById(panelId);
      const H = drag.H;
      const h = p ? p.clientHeight : 0;
      drag = null;
      if (!p) return;
      if (h < H * 0.38) { p.style.height = ""; epubCloseOverlays(); epubPoke(); return; }
      p.style.height = (h > H * 0.72 ? H : Math.round(H / 2)) + "px";
    };
    grip.addEventListener("touchstart", start, { passive: true });
    grip.addEventListener("touchmove", move, { passive: false });
    grip.addEventListener("touchend", end);
    grip.addEventListener("touchcancel", end);
    grip.addEventListener("mousedown", (e) => {
      start(e);
      const mv = (ev) => move(ev);
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); end(); };
      window.addEventListener("mousemove", mv);
      window.addEventListener("mouseup", up);
    });
  });
  const inp = document.getElementById("epub-search-input");
  if (inp && !inp.__mgSearchHook) {
    inp.__mgSearchHook = true;
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); epubSearchRun(); }
    });
  }
  const br = document.getElementById("epub-bright");
  if (br && !br.__mgBrightHook) {
    br.__mgBrightHook = true;
    br.addEventListener("input", () => epubBrightSet(Number(br.value)));
  }
}

function epubToggleToc() {
  const p = document.getElementById("epub-toc");
  if (!p) return;
  epubTopAttach();
  const show = p.hidden;
  epubCloseOverlays("epub-toc");
  p.hidden = !show;
  if (show) { p.style.height = ""; epubChromeShow(); }
  epubTopBackdropSync();
  epubPoke();
}

/* ------------------------------------- buscador en el libro */

let epubSearchSeq = 0;

/* Normalización para buscar: minúsculas y SIN acentos («arbol»
   encuentra «árbol»). Se aplica igual al texto del libro y a la
   consulta. */
function epubNormText(s) {
  return normalizeText(s || "");
}

function epubTocFlat() {
  const out = [];
  const walk = (list) => {
    for (const it of list || []) {
      out.push({ href: String(it.href || "").split("#")[0], label: it.label || "" });
      if (it.subitems) walk(it.subitems);
    }
  };
  try { walk(epubBook && epubBook.navigation ? epubBook.navigation.toc : []); } catch { /* sin índice */ }
  return out;
}

function epubToggleSearch() {
  const p = document.getElementById("epub-search");
  if (!p) return;
  epubTopAttach();
  const show = p.hidden;
  epubCloseOverlays("epub-search");
  p.hidden = !show;
  if (show) {
    p.style.height = "";
    epubChromeShow();
    const inp = document.getElementById("epub-search-input");
    if (inp) { try { inp.focus({ preventScroll: true }); } catch { try { inp.focus(); } catch { /* sin foco */ } } }
  }
  epubTopBackdropSync();
  epubPoke();
}

function epubSearchClose() {
  epubSearchSeq++;
  epubHide("epub-search");
  epubTopBackdropSync();
  epubPoke();
}

function epubSearchCancel() {
  epubSearchSeq++;
  const st = document.getElementById("epub-search-status");
  if (st) st.textContent = T("Búsqueda cancelada.");
  const btn = document.getElementById("epub-search-cancel");
  if (btn) btn.hidden = true;
}

async function epubSearchRun() {
  const inp = document.getElementById("epub-search-input");
  const status = document.getElementById("epub-search-status");
  const box = document.getElementById("epub-search-results");
  const cancelBtn = document.getElementById("epub-search-cancel");
  if (!inp || !status || !box) return;
  const q = epubNormText((inp.value || "").trim());
  box.innerHTML = "";
  if (!q) { status.textContent = T("Escribe una palabra para buscar."); return; }
  if (!epubBook || !epubBook.spine) { status.textContent = T("El libro aún no está listo."); return; }
  const seq = ++epubSearchSeq;
  if (cancelBtn) cancelBtn.hidden = false;
  const items = epubBook.spine.spineItems || [];
  const tocFlat = epubTocFlat();
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (seq !== epubSearchSeq) return;
    status.textContent = T("Buscando…") + " " + (i + 1) + "/" + items.length + " · " + total + " " + (total === 1 ? T("resultado") : T("resultados"));
    total += await epubSearchSection(items[i], q, tocFlat, box, () => total);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (seq !== epubSearchSeq) return;
  if (cancelBtn) cancelBtn.hidden = true;
  if (!total) {
    status.textContent = T("Sin resultados");
    box.innerHTML = '<p class="epub-search-none">Sin resultados para esta búsqueda.</p>';
  } else {
    status.textContent = total + (total === 1 ? " resultado" : " resultados");
  }
}

/* Busca en UNA sección del spine usando la rendition oculta:
   carga la sección, construye su texto normalizado con mapa a
   posiciones originales, y por cada coincidencia crea el rango
   original, su CFI y un extracto con la palabra marcada. La
   sección queda liberada al cargar la siguiente. */
async function epubSearchSection(item, q, tocFlat, box, countSoFar) {
  const baseCount = countSoFar();
  if (baseCount >= 300) return 0;
  let ok = false;
  try { ok = await epubR2Show(item.href); } catch { ok = false; }
  if (!ok || !epubR2) return 0;
  let contents = null;
  try { contents = (epubR2.getContents() || [])[0]; } catch { contents = null; }
  const doc = contents && contents.document;
  if (!doc || !doc.body) return 0;
  const walker = doc.createTreeWalker(doc.body, 4);
  let norm = "";
  let orig = "";
  const segs = [];
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue || "";
    if (!raw) continue;
    segs.push({ node, start: norm.length, nlen: epubNormText(raw).length, raw, ostart: orig.length });
    norm += epubNormText(raw);
    orig += raw;
  }
  if (!norm) return 0;
  const base = String(item.href || "").split("#")[0];
  const tocHit = tocFlat.find((t) => t.href && (t.href === base || base.endsWith("/" + t.href) || t.href.endsWith("/" + base)));
  const label = tocHit && tocHit.label ? tocHit.label.trim() : T("Sección");
  let found = 0;
  let pos = 0;
  while (found < 50 && baseCount + found < 300) {
    const ix = norm.indexOf(q, pos);
    if (ix < 0) break;
    pos = ix + Math.max(1, q.length);
    const seg = segs.find((s) => ix >= s.start && ix < s.start + s.nlen) || segs[segs.length - 1];
    if (!seg) continue;
    /* Offset normalizado → offset original dentro del nodo:
       contar caracteres que sobreviven a la normalización. */
    const localN = ix - seg.start;
    let origOff = 0;
    let seen = 0;
    while (origOff < seg.raw.length && seen < localN) {
      if (epubNormText(seg.raw[origOff]).length) seen++;
      origOff++;
    }
    let endOff = origOff;
    let seen2 = 0;
    while (endOff < seg.raw.length && seen2 < q.length) {
      if (epubNormText(seg.raw[endOff]).length) seen2++;
      endOff++;
    }
    if (endOff <= origOff) endOff = Math.min(seg.raw.length, origOff + q.length);
    let cfi = "";
    try {
      const range = doc.createRange();
      range.setStart(seg.node, Math.min(origOff, seg.raw.length));
      range.setEnd(seg.node, Math.min(endOff, seg.raw.length));
      cfi = contents.cfiFromRange(range);
    } catch { cfi = ""; }
    if (!cfi) continue;
    const gIx = seg.ostart + origOff;
    const gEnd = seg.ostart + endOff;
    const before = orig.slice(Math.max(0, gIx - 42), gIx).replace(/\s+/g, " ");
    const match = orig.slice(gIx, gEnd);
    const after = orig.slice(gEnd, gEnd + 42).replace(/\s+/g, " ");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "epub-search-item";
    btn.setAttribute("data-action", "epub-search-go-result");
    btn.setAttribute("data-cfi", cfi);
    btn.innerHTML = `<span class="epub-search-ch">${esc(label)}</span><span class="epub-search-ex">…${esc(before)}<mark>${esc(match)}</mark>${esc(after)}…</span>`;
    box.appendChild(btn);
    found++;
  }
  return found;
}

function epubSearchGoResult(cfi) {
  if (!cfi) return;
  epubSearchSeq++;
  epubCloseOverlays();
  epubDisplaySafe(cfi);
}

/* display() con la promesa protegida: un destino que no se puede
   resolver (CFI/href guardado de otra build) no debe dejar una
   promesa rechazada sin atender ni romper el lector. */
function epubDisplaySafe(target) {
  if (!epubRendition || !target) return;
  try {
    const p = epubRendition.display(target);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* destino no resoluble: se ignora */ }
}

function epubGoTo(href) {
  epubSelMarkClear();
  epubCloseOverlays();
  epubDisplaySafe(href);
}

/* ------------------------------------------- selección y menú */

function epubHide(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function epubOnSelected(raw, cfiRange) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  /* 1200 caracteres: cabe un pasaje largo de muchas palabras (r16);
     el tope sigue ahí para no arrastrar selecciones patológicas. */
  if (!text || text.length > 1200) return;
  const key = cfiRange || text;
  const now = Date.now();
  if (key === epubSelGuard.key && now - epubSelGuard.at < 1200) return;
  epubSelGuard = { key, at: now };
  epubSel = { text, cfi: cfiRange || "" };
  epubWsTransOnly = false;
  /* Una sola palabra → la hoja inferior con significado y
     traducción; un pasaje → el menú compacto (r16). */
  if (epubIsSingleWord(text)) epubOpenWordSheet();
  else epubOpenSelMenu();
}

/* ¿La selección es UNA palabra? (sin espacios y de largo sano) */
function epubIsSingleWord(text) {
  return !!text && !/\s/.test(text) && text.length <= 40;
}

function epubOpenSelMenu() {
  if (!epubSel) return;
  epubCloseOverlays("epub-selmenu");
  const m = document.getElementById("epub-selmenu");
  if (!m) return;
  const t = document.getElementById("epub-sel-text");
  if (t) t.textContent = "«" + (epubSel.text.length > 90 ? epubSel.text.slice(0, 90) + "…" : epubSel.text) + "»";
  const hl = document.getElementById("epub-act-highlight");
  if (hl) hl.textContent = epubFindHighlight(epubSel.cfi) ? "Quitar resaltado" : "Resaltar";
  const ul = document.getElementById("epub-act-underline");
  if (ul) ul.textContent = epubFindUnderline(epubSel.cfi) ? "Quitar subrayado" : "Subrayar";
  /* Si el pasaje ya tiene nota, la opción del menú es «Ver
     nota» (r21); si no, «Aplicar nota» como siempre. */
  const nb = document.getElementById("epub-act-note-menu");
  if (nb) {
    const hasNote = !!epubListGet(EPUB_NOTES_KEY).find((n) => n.cfi === epubSel.cfi);
    nb.textContent = hasNote ? "Ver nota" : "Aplicar nota";
    nb.dataset.viewnote = hasNote ? "1" : "";
  }
  m.hidden = false;
  epubPaletteReset();
  epubChromeShow();
}

function epubSelMenuClose() {
  epubHide("epub-selmenu");
  epubSelMarkClear();
  epubPoke();
}

function epubClearIframeSelection() {
  if (!epubRendition) return;
  try {
    epubRendition.getContents().forEach((c) => {
      try { c.window.getSelection().removeAllRanges(); } catch { /* contenido ya cambiado */ }
    });
  } catch { /* sin contenido */ }
}

/* ------------------------------------ tarjeta del significado */

function epubCardOpen(title, statusText, srcLabel) {
  epubCloseOverlays("epub-dict");
  const card = document.getElementById("epub-dict");
  const w = document.getElementById("epub-dict-word");
  const body = document.getElementById("epub-dict-body");
  const src = document.getElementById("epub-dict-src");
  if (!card || !w || !body) return epubDictSeq;
  card.hidden = false;
  w.textContent = title;
  if (src) src.textContent = srcLabel;
  body.innerHTML = statusText ? `<p class="epub-dict-status">${esc(statusText)}</p>` : "";
  epubChromeShow();
  return ++epubDictSeq;
}

function epubCardMsg(title, msg, srcLabel) {
  epubCardOpen(title, "", srcLabel);
  const body = document.getElementById("epub-dict-body");
  if (body) body.innerHTML = `<p class="epub-dict-none">${esc(msg)}</p>`;
}

function epubDictClose() {
  epubHide("epub-dict");
  epubDictSeq++;
  /* La consulta terminó: se retira la marca temporal para que
     la lámina de gestos vuelva (el vigía la repone en cuanto no
     queda tarjeta abierta). */
  epubSelMarkClear();
  epubClearIframeSelection();
  epubPoke();
}

/* El botón de nota del MENÚ de selección (r21): cuando el
   pasaje ya tiene nota, el botón dice «Ver nota» y al tocarlo
   se abre la vista de la nota; en cualquier otro caso — y
   siempre en la hoja de una palabra — es «Aplicar nota» y abre
   el editor de siempre (que ya precarga la nota si la hay). */
function epubActNoteAction(el) {
  if (el && el.id === "epub-act-note-menu" && el.dataset.viewnote === "1" && epubSel && epubSel.cfi) {
    const n = epubListGet(EPUB_NOTES_KEY).find((x) => x.cfi === epubSel.cfi);
    if (n) { epubOpenNoteView(n); return; }
  }
  epubActNote();
}

/* «Traducir» del menú de varias palabras (r21; sustituye a
   «Buscar significado»): traduce el CONJUNTO COMPLETO seleccio-
   nado con el diccionario elegido y recordado del selector —
   las fuentes locales resuelven por su contrato («parcial» /
   «primera_palabra») y Google devuelve la frase entera
   («frase»). El resultado sale en la vista de traducción, con
   el selector de diccionario disponible. El «Traducir» del
   menú de un pasaje ya marcado hace exactamente lo mismo con
   el texto de ese pasaje. */
function epubActTranslate() {
  if (!epubSel) return;
  epubHide("epub-selmenu");
  epubOpenTranslateView();
}

/* Vista de traducción de un pasaje (r21): la hoja en modo
   solo-traducción — sin el cuadro de Significado ni la rejilla
   de acciones — y la traducción se pide al abrir. */
let epubWsTransOnly = false;

function epubOpenTranslateView() {
  if (!epubSel) return;
  epubWsTransOnly = true;
  epubOpenWordSheet();
}

/* -------------------------------------------- resaltados y notas */

/* Lista guardada (resaltados o notas), SANEADA: se queda solo con
   entradas que son objetos con un CFI de forma válida; el texto y
   la nota se fuerzan a cadena. Todo lo demás — JSON roto, entradas
   de builds viejas con otra forma, CFI imposibles de parsear — se
   descarta sin ruido, para que el estado sucio de un navegador que
   viene probando desde builds anteriores nunca rompa el lector. */
/* Las marcas y notas se guardan POR LIBRO: la clave base recibe el
   sufijo del gid abierto, para que cada libro conserve las suyas. */
function epubScopedKey(key) {
  if (key === EPUB_HL_KEY || key === EPUB_UL_KEY || key === EPUB_NOTES_KEY) {
    return key + "-" + (epubCurrent ? epubCurrent.gid : "sinlibro");
  }
  return key;
}

function epubListGet(key) {
  key = epubScopedKey(key);
  let a = null;
  try { a = JSON.parse(window.localStorage.getItem(key) || "[]"); } catch { return []; }
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const it of a) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    if (!epubIsCfi(it.cfi)) continue;
    const clean = { cfi: it.cfi, text: typeof it.text === "string" ? it.text : "" };
    /* Color de la marca (r19): resaltado y subrayado guardan el
       color elegido en la paleta junto a tipo y CFI. */
    if ((key.indexOf(EPUB_HL_KEY) === 0 || key.indexOf(EPUB_UL_KEY) === 0) && typeof it.color === "string" && /^#[0-9a-fA-F]{6}$/.test(it.color)) clean.color = it.color;
    if (key.indexOf(EPUB_NOTES_KEY) === 0) {
      clean.note = typeof it.note === "string" ? it.note : "";
      if (typeof it.ts === "number" && isFinite(it.ts)) clean.ts = it.ts;
    }
    out.push(clean);
  }
  return out;
}

function epubListSet(key, a) {
  key = epubScopedKey(key);
  try { window.localStorage.setItem(key, JSON.stringify(a)); } catch { /* sin almacenamiento */ }
}

function epubFindHighlight(cfi) {
  if (!cfi) return null;
  return epubListGet(EPUB_HL_KEY).find((h) => h.cfi === cfi) || null;
}

/* Tipos de marca del lector (r16): «highlight» (resaltado),
   «underline» (SUBRAYADO nuevo: línea sólida dorada) y «note»
   (la marca de una nota: línea de puntos azul acero). epub.js
   dibuja underline y note con su mismo tipo «underline»; se
   diferencian por la CLASE (el pane vive en el documento padre y
   styles.css recolorea cada clase: sólida contra puntos). */
const EPUB_ANNO_EPUBTYPE = { highlight: "highlight", underline: "underline", note: "underline" };
const EPUB_ANNO_CLASS = { highlight: "magister-hl", underline: "magister-ul", note: "magister-note" };
const EPUB_ANNO_PROPS = {
  highlight: { fill: "#e9b949", "fill-opacity": "0.42" },
  underline: { stroke: "#d3a24a" },
  note: { stroke: "#8fb6d9" },
};

/* Props de dibujo por marca (r19): si la anotación trae color
   de la paleta, manda ese; si no, el de siempre. */
function epubAnnoProps(type, item) {
  if (item && typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color)) {
    if (type === "highlight") return { fill: item.color, "fill-opacity": "0.42" };
    if (type === "underline") return { stroke: item.color };
  }
  return EPUB_ANNO_PROPS[type] || {};
}

function epubAnnoDrawn(cls, cfi) {
  try { return !!document.querySelector("g." + cls + '[data-epubcfi="' + cfi + '"]'); } catch { return true; }
}

function epubAnnoAdd(type, item) {
  if (!epubRendition || !item || !item.cfi) return;
  const key = type + "|" + item.cfi;
  if (epubAnnoApplied.has(key)) return;
  try {
    epubRendition.annotations.add(EPUB_ANNO_EPUBTYPE[type] || "highlight", item.cfi, {}, () => epubOnAnnoTap(item), EPUB_ANNO_CLASS[type] || "magister-hl", epubAnnoProps(type, item));
    epubAnnoApplied.add(key);
    window.__epubAnnoAdds = (window.__epubAnnoAdds || 0) + 1;
  } catch { /* la sección aún no está renderizada: el gestor la aplica al renderizarla */ }
  /* Nota y subrayado comparten el tipo de epub.js: si al dibujar
     uno el gestor hubiera tapado el dibujo del otro en el mismo
     CFI, se reaplica el que siga guardado (una sola corrección). */
  const other = type === "note" ? "underline" : type === "underline" ? "note" : null;
  if (other) {
    const store = other === "note" ? epubListGet(EPUB_NOTES_KEY) : epubListGet(EPUB_UL_KEY);
    const it = store.find((n) => n.cfi === item.cfi);
    if (it && !epubAnnoDrawn(EPUB_ANNO_CLASS[other], item.cfi)) {
      epubAnnoApplied.delete(other + "|" + item.cfi);
      try {
        epubRendition.annotations.add("underline", it.cfi, {}, () => epubOnAnnoTap(it), EPUB_ANNO_CLASS[other], epubAnnoProps(other, it));
        epubAnnoApplied.add(other + "|" + it.cfi);
      } catch { /* queda guardado; se dibujará al re-renderizar la sección */ }
    }
  }
}

function epubAnnoRemove(cfi, type) {
  if (!epubRendition || !cfi) return;
  try { epubRendition.annotations.remove(cfi, EPUB_ANNO_EPUBTYPE[type] || type); } catch { /* no estaba */ }
  epubAnnoApplied.delete(type + "|" + cfi);
  /* Con dos marcas del mismo tipo de epub.js en el mismo CFI
     (nota + subrayado), su remove() a veces deja el dibujo
     huérfano en el pane: el pane vive en este documento, así que
     se retira también el <g> de ESTA clase y CFI a mano. */
  const cls = EPUB_ANNO_CLASS[type];
  if (cls) {
    try { document.querySelectorAll("g." + cls + '[data-epubcfi="' + cfi + '"]').forEach((g) => g.remove()); } catch { /* pane no listo */ }
  }
  /* Si al quitar uno el gestor se llevó también el dibujo del
     otro tipo de línea en el mismo CFI, se reaplica el que siga
     guardado. */
  const other = type === "note" ? "underline" : type === "underline" ? "note" : null;
  if (other) {
    const store = other === "note" ? epubListGet(EPUB_NOTES_KEY) : epubListGet(EPUB_UL_KEY);
    const it = store.find((n) => n.cfi === cfi);
    if (it && !epubAnnoDrawn(EPUB_ANNO_CLASS[other], cfi)) {
      epubAnnoApplied.delete(other + "|" + cfi);
      epubAnnoAdd(other, it);
    }
  }
}

function epubApplyAnnotations() {
  if (!epubRendition) return;
  /* Cada marca se reaplica en su propio try/catch (epubAnnoAdd ya
     protege la llamada a epub.js; esto es el segundo cinturón): un
     CFI guardado que esta build no pueda aplicar se salta y las
     demás marcas y la lectura siguen. Las listas saneadas se
     reguardan, así el almacenamiento se autocura al abrir. */
  const hls = epubListGet(EPUB_HL_KEY);
  const nts = epubListGet(EPUB_NOTES_KEY);
  epubListSet(EPUB_HL_KEY, hls);
  epubListSet(EPUB_NOTES_KEY, nts);
  for (const h of hls) { try { epubAnnoAdd("highlight", h); } catch { /* marca saltada */ } }
  for (const n of nts) { try { epubAnnoAdd("note", n); } catch { /* marca saltada */ } }
  const uls = epubListGet(EPUB_UL_KEY);
  epubListSet(EPUB_UL_KEY, uls);
  for (const u of uls) { try { epubAnnoAdd("underline", u); } catch { /* marca saltada */ } }
}

function epubOnAnnoTap(item) {
  /* Justo tras seleccionar con la lámina, el clic que sigue al
     toque cae sobre el pane de anotaciones (la lámina ya se
     retiró) y dispararía este menú encima de la hoja/menú que la
     selección acaba de abrir — p. ej. al elegir UNA palabra
     dentro de un pasaje ya subrayado. Ese toque fantasma se
     ignora; el toque deliberado sobre una marca, sin selección
     reciente de la lámina, sigue abriendo su menú. */
  if (Date.now() - epubSheetSelectAt < 900) return;
  /* Un toque sobre la marca de una NOTA abre la vista de la
     nota (r19); las demás marcas abren el menú de selección. */
  if (item && typeof item.note === "string") {
    const n = epubListGet(EPUB_NOTES_KEY).find((x) => x.cfi === item.cfi) || item;
    epubOpenNoteView(n);
    return;
  }
  epubSel = { text: item.text || "", cfi: item.cfi || "" };
  epubOpenSelMenu();
}

/* Vista de una nota (r19): tocar la marca de nota la muestra —
   su texto, con Editar y Borrar — sin pasar por selección ni
   menús. Llega por dos caminos: el click que epub.js entrega al
   tocar la marca dibujada (epubOnAnnoTap) y el toque sobre la
   lámina de gestos (epubNoteHitAt), que tiene prioridad sobre
   el toque que alterna los controles. */
let epubNoteViewCfi = "";

function epubOpenNoteView(entry) {
  if (!entry || !entry.cfi) return;
  epubNoteViewCfi = entry.cfi;
  epubCloseOverlays("epub-noteview");
  const v = document.getElementById("epub-noteview");
  if (!v) return;
  const q = document.getElementById("epub-noteview-quote");
  if (q) q.textContent = "«" + (entry.text && entry.text.length > 90 ? entry.text.slice(0, 90) + "…" : (entry.text || "")) + "»";
  const t = document.getElementById("epub-noteview-text");
  if (t) t.textContent = entry.note || "";
  v.hidden = false;
  epubChromeShow();
  epubPoke();
}

function epubNoteViewClose() {
  epubHide("epub-noteview");
  epubPoke();
}

function epubNoteViewEdit() {
  const n = epubListGet(EPUB_NOTES_KEY).find((x) => x.cfi === epubNoteViewCfi);
  epubHide("epub-noteview");
  if (!n) return;
  epubSel = { text: n.text || "", cfi: n.cfi };
  epubActNote();
}

function epubNoteViewDel() {
  const cfi = epubNoteViewCfi;
  const list = epubListGet(EPUB_NOTES_KEY);
  const ix = list.findIndex((x) => x.cfi === cfi);
  if (ix >= 0) {
    list.splice(ix, 1);
    epubListSet(EPUB_NOTES_KEY, list);
    epubAnnoRemove(cfi, "note");
  }
  epubHide("epub-noteview");
  epubPoke();
}

/* ¿Hay una nota cuyo rango contiene el punto (x, y)? Se localiza
   la palabra bajo el dedo (caret) y se comprueba su contención
   en el rango de cada nota de la sección visible. */
function epubNoteHitAt(x, y) {
  const notes = epubListGet(EPUB_NOTES_KEY);
  if (!notes.length || !epubRendition) return null;
  let all = [];
  try { all = epubRendition.getContents() || []; } catch { all = []; }
  for (const contents of all) {
    const doc = contents && contents.document;
    const win = doc && doc.defaultView;
    const frame = win && win.frameElement;
    if (!doc || !win || !frame) continue;
    const rect = frame.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const caret = epubWordRangeAt(doc, x - rect.left, y - rect.top);
    if (!caret) return null;
    for (const n of notes) {
      try {
        const rng = contents.range(n.cfi);
        if (rng && caret.compareBoundaryPoints(Range.START_TO_START, rng) >= 0 && caret.compareBoundaryPoints(Range.END_TO_END, rng) <= 0) return n;
      } catch { /* CFI no resoluble en esta sección */ }
    }
    return null;
  }
  return null;
}

/* ¿Hay una marca de RESALTADO o SUBRAYADO cuyo rango contiene
   el punto (x, y)? Mismo método que epubNoteHitAt (r19): la
   palabra bajo el dedo y su contención en el rango de la marca.
   Devuelve la entrada y su tipo. Las notas se comprueban antes
   que las marcas: si un pasaje tiene marca y nota, al tocarlo
   manda la nota (r21). */
function epubMarkHitAt(x, y) {
  const stores = [["highlight", epubListGet(EPUB_HL_KEY)], ["underline", epubListGet(EPUB_UL_KEY)]];
  if (!stores[0][1].length && !stores[1][1].length) return null;
  if (!epubRendition) return null;
  let all = [];
  try { all = epubRendition.getContents() || []; } catch { all = []; }
  for (const contents of all) {
    const doc = contents && contents.document;
    const win = doc && doc.defaultView;
    const frame = win && win.frameElement;
    if (!doc || !win || !frame) continue;
    const rect = frame.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const caret = epubWordRangeAt(doc, x - rect.left, y - rect.top);
    if (!caret) return null;
    for (const [tipo, list] of stores) {
      for (const m of list) {
        try {
          const rng = contents.range(m.cfi);
          if (rng && caret.compareBoundaryPoints(Range.START_TO_START, rng) >= 0 && caret.compareBoundaryPoints(Range.END_TO_END, rng) <= 0) return { entry: m, tipo };
        } catch { /* CFI no resoluble en esta sección */ }
      }
    }
    return null;
  }
  return null;
}

function epubFindUnderline(cfi) {
  if (!cfi) return null;
  return epubListGet(EPUB_UL_KEY).find((h) => h.cfi === cfi) || null;
}

/* Paleta de colores de marca (r19): al elegir Resaltar o
   Subrayar se ofrecen EXACTAMENTE 10 colores dentro del flujo
   de la hoja/menú; el elegido se aplica, queda guardado con la
   anotación (tipo + CFI + color) y se recuerda como preselección
   para la próxima vez. Si la marca ya existe, el botón la quita
   («Quitar resaltado»/«Quitar subrayado») y una fila de colores
   en el mismo menú/hoja permite cambiarle el color. */
const EPUB_PALETTE = ["#f6c945", "#ffb74d", "#ef5350", "#ec407a", "#ab47bc", "#5c6bc0", "#42a5f5", "#26a69a", "#66bb6a", "#9e9e9e"];
let epubPaletteHost = "menu";

function epubLastColor(tipo) {
  let c = "";
  try { c = window.localStorage.getItem("magister-epub-lastcolor-" + tipo) || ""; } catch { c = ""; }
  return EPUB_PALETTE.includes(c) ? c : EPUB_PALETTE[0];
}

function epubSaveLastColor(tipo, color) {
  try { window.localStorage.setItem("magister-epub-lastcolor-" + tipo, color); } catch { /* sin almacenamiento */ }
}

function epubSwatchesHtml(modo, tipo, selected) {
  return EPUB_PALETTE.map((c) =>
    `<button type="button" class="epub-swatch${c === selected ? " sel" : ""}" data-action="epub-palette-pick" data-modo="${modo}" data-tipo="${tipo}" data-color="${c}" style="background:${c}" aria-label="${T("Color")} ${c}"></button>`
  ).join("");
}

function epubPaletteOpen(tipo) {
  if (!epubSel) return;
  const menuEl = document.getElementById("epub-selmenu");
  const host = menuEl && !menuEl.hidden ? "menu" : "ws";
  epubPaletteHost = host;
  const block = document.getElementById("epub-palette-" + host);
  if (!block) return;
  const title = block.querySelector(".epub-palette-title");
  if (title) title.textContent = tipo === "highlight" ? T("Color del resaltado") : T("Color del subrayado");
  const grid = block.querySelector(".epub-palette-grid");
  if (grid) grid.innerHTML = epubSwatchesHtml("new", tipo, epubLastColor(tipo));
  const actions = document.getElementById("epub-actions-" + host);
  if (actions) actions.style.display = "none";
  const recolor = document.getElementById("epub-recolor-" + host);
  if (recolor) recolor.style.display = "none";
  block.hidden = false;
  epubPoke();
}

function epubPaletteBack() {
  for (const host of ["menu", "ws"]) {
    const block = document.getElementById("epub-palette-" + host);
    if (block) block.hidden = true;
    const actions = document.getElementById("epub-actions-" + host);
    if (actions) actions.style.display = "";
    const recolor = document.getElementById("epub-recolor-" + host);
    if (recolor) recolor.style.display = "";
  }
  epubPoke();
}

/* Al abrir la hoja/menú: paleta cerrada y, si el pasaje ya trae
   marcas, la fila para cambiarles el color. */
function epubPaletteReset() {
  epubPaletteBack();
  for (const host of ["menu", "ws"]) {
    const box = document.getElementById("epub-recolor-" + host);
    if (!box) continue;
    if (!epubSel || !epubSel.cfi) { box.hidden = true; box.innerHTML = ""; continue; }
    const parts = [];
    const hl = epubFindHighlight(epubSel.cfi);
    if (hl) parts.push({ tipo: "highlight", label: T("Cambiar color del resaltado"), color: hl.color || EPUB_PALETTE[0] });
    const ul = epubFindUnderline(epubSel.cfi);
    if (ul) parts.push({ tipo: "underline", label: T("Cambiar color del subrayado"), color: ul.color || EPUB_PALETTE[0] });
    if (!parts.length) { box.hidden = true; box.innerHTML = ""; continue; }
    box.innerHTML = parts.map((p) =>
      `<p class="epub-palette-title">${p.label}</p><div class="epub-palette-grid">${epubSwatchesHtml("re", p.tipo, p.color)}</div>`
    ).join("");
    box.hidden = false;
  }
}

function epubPalettePick(modo, tipo, color) {
  if (!EPUB_PALETTE.includes(color)) return;
  if (modo === "re") {
    if (!epubSel || !epubSel.cfi) return;
    const key = tipo === "highlight" ? EPUB_HL_KEY : EPUB_UL_KEY;
    const list = epubListGet(key);
    const ix = list.findIndex((h) => h.cfi === epubSel.cfi);
    if (ix < 0) return;
    list[ix].color = color;
    epubListSet(key, list);
    epubSaveLastColor(tipo, color);
    epubAnnoRemove(epubSel.cfi, tipo);
    epubAnnoApplied.delete(tipo + "|" + epubSel.cfi);
    epubAnnoAdd(tipo, list[ix]);
    epubHide("epub-selmenu");
    epubHide("epub-wordsheet");
    epubSelMarkClear();
    epubPoke();
    return;
  }
  epubActMarkApply(tipo, color);
}

function epubActMarkApply(tipo, color) {
  if (!epubSel || !epubSel.cfi) return;
  const { text, cfi } = epubSel;
  const key = tipo === "highlight" ? EPUB_HL_KEY : EPUB_UL_KEY;
  const list = epubListGet(key);
  const ix = list.findIndex((h) => h.cfi === cfi);
  const item = { cfi, text, color };
  if (ix >= 0) list[ix] = item; else list.push(item);
  epubListSet(key, list);
  epubSaveLastColor(tipo, color);
  epubSelMarkClear();
  epubAnnoRemove(cfi, tipo);
  epubAnnoApplied.delete(tipo + "|" + cfi);
  epubAnnoAdd(tipo, item);
  epubHide("epub-selmenu");
  epubHide("epub-wordsheet");
  epubClearIframeSelection();
  epubPoke();
}

function epubActMarkRemove(tipo) {
  if (!epubSel || !epubSel.cfi) return;
  const cfi = epubSel.cfi;
  const key = tipo === "highlight" ? EPUB_HL_KEY : EPUB_UL_KEY;
  const list = epubListGet(key);
  const ix = list.findIndex((h) => h.cfi === cfi);
  if (ix >= 0) { list.splice(ix, 1); epubListSet(key, list); }
  epubAnnoRemove(cfi, tipo);
  epubHide("epub-selmenu");
  epubHide("epub-wordsheet");
  epubSelMarkClear();
  epubClearIframeSelection();
  epubPoke();
}

/* «Resaltar» / «Subrayar»: sin marca → paleta de colores; con
   marca → se quita (el botón ya lo anuncia). El color de una
   marca existente se cambia desde su fila en el mismo menú. */
function epubActMark(tipo) {
  if (!epubSel) return;
  if (!epubSel.cfi) {
    epubHide("epub-selmenu");
    epubHide("epub-wordsheet");
    epubCardMsg(tipo === "highlight" ? "Resaltar" : "Subrayar", "No se pudo ubicar esa selección en el libro. Vuelve a seleccionarla e inténtalo otra vez.", "");
    return;
  }
  const exists = tipo === "highlight" ? epubFindHighlight(epubSel.cfi) : epubFindUnderline(epubSel.cfi);
  if (exists) epubActMarkRemove(tipo);
  else epubPaletteOpen(tipo);
}

function epubActUnderline() { epubActMark("underline"); }
function epubActHighlight() { epubActMark("highlight"); }

function epubActNote() {
  if (!epubSel) return;
  if (!epubSel.cfi) {
    epubHide("epub-selmenu");
    epubHide("epub-wordsheet");
    epubCardMsg("Nota", "No se pudo ubicar esa selección en el libro. Vuelve a seleccionarla e inténtalo otra vez.", "");
    return;
  }
  epubHide("epub-selmenu");
  epubHide("epub-wordsheet");
  epubCloseOverlays("epub-noteed");
  const ed = document.getElementById("epub-noteed");
  if (!ed) return;
  const ex = epubListGet(EPUB_NOTES_KEY).find((n) => n.cfi === epubSel.cfi);
  const ta = document.getElementById("epub-note-text");
  if (ta) ta.value = ex ? ex.note : "";
  const q = document.getElementById("epub-note-quote");
  if (q) q.textContent = "«" + (epubSel.text.length > 90 ? epubSel.text.slice(0, 90) + "…" : epubSel.text) + "»";
  ed.hidden = false;
  epubChromeShow();
}

function epubNoteCancel() {
  epubHide("epub-noteed");
  epubSelMarkClear();
  epubPoke();
}

function epubNoteSave() {
  if (!epubSel || !epubSel.cfi) { epubNoteCancel(); return; }
  const ta = document.getElementById("epub-note-text");
  const note = ta ? ta.value.trim() : "";
  const list = epubListGet(EPUB_NOTES_KEY);
  const ix = list.findIndex((n) => n.cfi === epubSel.cfi);
  if (!note) {
    if (ix >= 0) {
      list.splice(ix, 1);
      epubListSet(EPUB_NOTES_KEY, list);
      epubAnnoRemove(epubSel.cfi, "note");
    }
  } else if (ix >= 0) {
    list[ix].note = note;
    list[ix].text = epubSel.text;
    epubListSet(EPUB_NOTES_KEY, list);
  } else {
    const item = { cfi: epubSel.cfi, text: epubSel.text, note, ts: Date.now() };
    list.push(item);
    epubListSet(EPUB_NOTES_KEY, list);
    epubAnnoAdd("note", item);
  }
  epubHide("epub-noteed");
  epubSelMarkClear();
  epubClearIframeSelection();
  epubPoke();
}

/* «Ver notas» del menú de selección (r16): la lista de notas ya
   no cuelga de un botón de la barra, sino del propio menú que
   aparece al seleccionar. Abre el panel de siempre (pasaje, salto
   al pasaje, borrar) cerrando el menú y las demás tarjetas. */
function epubActViewNotes() {
  epubHide("epub-selmenu");
  epubHide("epub-wordsheet");
  epubCloseOverlays("epub-notes");
  const p = document.getElementById("epub-notes");
  if (!p) return;
  epubFillNotes();
  p.hidden = false;
  epubChromeShow();
}


/* --------------------------------- menú de la barra (r25) */

/* Desplegable de la barra del lector: letra, tema, notas de
   ESTE libro y brillo de la lectura. El brillo se aplica como
   filtro sobre el área de lectura (visor + láminas del volteo,
   nunca sobre los paneles) y se recuerda entre sesiones. */
const EPUB_BRIGHT_KEY = "magister-epub-bright-v1";
function epubBrightGet() {
  let v = 100;
  try { v = parseInt(localStorage.getItem(EPUB_BRIGHT_KEY) || "100", 10); } catch { /* sin almacén */ }
  if (!Number.isFinite(v)) v = 100;
  return Math.max(45, Math.min(100, v));
}
function epubApplyBright() {
  const v = epubBrightGet();
  const f = v >= 100 ? "" : `brightness(${v / 100})`;
  for (const id of ["epub-viewer", "epub-curl", "epub-sheet", "epub-fold"]) {
    const el = document.getElementById(id);
    if (el) el.style.filter = f;
  }
  const sl = document.getElementById("epub-bright");
  if (sl && Number(sl.value) !== v) sl.value = String(v);
}
function epubBrightSet(v) {
  try { localStorage.setItem(EPUB_BRIGHT_KEY, String(v)); } catch { /* sin almacén */ }
  epubApplyBright();
}
function epubToggleMenu() {
  const p = document.getElementById("epub-menu");
  if (!p) return;
  epubTopAttach();
  const show = p.hidden;
  epubCloseOverlays("epub-menu");
  p.hidden = !show;
  if (show) { epubApplyBright(); epubChromeShow(); }
  epubTopBackdropSync();
  epubPoke();
}

function epubToggleNotes() {
  const p = document.getElementById("epub-notes");
  if (!p) return;
  const show = p.hidden;
  epubCloseOverlays("epub-notes");
  if (show) {
    epubFillNotes();
    p.hidden = false;
    epubChromeShow();
  } else {
    p.hidden = true;
  }
}

function epubFillNotes() {
  const list = document.getElementById("epub-notes-list");
  if (!list) return;
  const notes = epubListGet(EPUB_NOTES_KEY);
  if (!notes.length) {
    list.innerHTML = `<p class="epub-toc-empty">${T("Sin notas en este libro")}</p><p class="epub-toc-empty">${T("Todavía no tienes notas en este libro. Selecciona un pasaje y elige «Nota» para crear la primera.")}</p>`;
    return;
  }
  list.innerHTML = notes.map((n) =>
    `<div class="epub-note-item">
      <button type="button" class="epub-note-jump" data-action="epub-note-go" data-cfi="${esc(n.cfi)}">«${esc(n.text.length > 80 ? n.text.slice(0, 80) + "…" : n.text)}»</button>
      <p class="epub-note-body">${esc(n.note)}</p>
      <button type="button" class="epub-note-del" data-action="epub-note-del" data-cfi="${esc(n.cfi)}">${T("Borrar nota")}</button>
    </div>`
  ).join("");
}

function epubNoteGo(cfi) {
  epubCloseOverlays();
  epubDisplaySafe(cfi);
}

function epubNoteDel(cfi) {
  const list = epubListGet(EPUB_NOTES_KEY).filter((n) => n.cfi !== cfi);
  epubListSet(EPUB_NOTES_KEY, list);
  epubAnnoRemove(cfi, "note");
  epubFillNotes();
}

/* ------------------------------------- hoja de UNA palabra (r16) */

/* Seleccionar UNA palabra abre esta hoja inferior en vez del
   menú compacto: nace a 1/3 de pantalla, el asa la sube hasta
   verla completa y la baja (o la × la cierra). El primer cuadro
   trae el SIGNIFICADO ya cargado; el segundo, la TRADUCCIÓN bajo
   demanda (selector de diccionarios). Debajo, las acciones de
   siempre. Al
   cerrarse se limpia la selección y la lámina de gestos vuelve,
   como al cerrar el diccionario. */
let epubWsSeq = 0;

function epubOpenWordSheet() {
  if (!epubSel) return;
  epubCloseOverlays("epub-wordsheet");
  const sh = document.getElementById("epub-wordsheet");
  if (!sh) return;
  const stage = epubStageEl();
  const H = stage ? stage.clientHeight : 0;
  sh.classList.remove("dragging");
  sh.style.height = Math.round(H / 3) + "px";
  const w = document.getElementById("epub-ws-word");
  if (w) w.textContent = epubWsTransOnly && epubSel.text.length > 90 ? epubSel.text.slice(0, 90) + "…" : epubSel.text;
  const ul = document.getElementById("epub-ws-act-underline");
  if (ul) ul.textContent = epubFindUnderline(epubSel.cfi) ? "Quitar subrayado" : "Subrayar";
  const hl = document.getElementById("epub-ws-act-highlight");
  if (hl) hl.textContent = epubFindHighlight(epubSel.cfi) ? "Quitar resaltado" : "Resaltar";
  const tb = document.getElementById("epub-ws-trans");
  if (tb) tb.innerHTML = `<p class="epub-dict-hint">${T("Toca «Traducir» para ver esta palabra en el otro idioma.")}</p>`;
  epubDictSelSync();
  const btn = document.getElementById("epub-ws-translate-btn");
  if (btn) { btn.disabled = false; btn.textContent = T("Traducir"); }
  sh.hidden = false;
  epubPaletteReset();
  epubChromeShow();
  /* Modo solo-traducción (r21): se esconden el cuadro de
     Significado, la rejilla de acciones y las filas de color;
     queda el cuadro de Traducción con su selector de diccio-
     nario, y la traducción del pasaje se pide al abrir. En el
     modo normal todo se restaura y carga el significado. */
  const meaningBox = document.getElementById("epub-ws-meaning");
  const meaningWrap = meaningBox ? meaningBox.closest(".epub-ws-box") : null;
  if (meaningWrap) meaningWrap.style.display = epubWsTransOnly ? "none" : "";
  const wsActions = document.getElementById("epub-actions-ws");
  if (wsActions) wsActions.style.display = epubWsTransOnly ? "none" : "";
  for (const pid of ["epub-palette-ws", "epub-recolor-ws"]) {
    const pel = document.getElementById(pid);
    if (pel) pel.style.display = epubWsTransOnly ? "none" : "";
  }
  if (epubWsTransOnly) {
    epubWsSeq++;
    epubWsTranslate();
    return;
  }
  epubWsLoadMeaning();
}

async function epubWsLoadMeaning() {
  const seq = ++epubWsSeq;
  const box = document.getElementById("epub-ws-meaning");
  if (!box) return;
  box.innerHTML = `<p class="epub-dict-status">${T("Buscando la definición…")}</p>`;
  const word = epubSel ? (epubCleanWord(epubSel.text) || epubSel.text) : "";
  const defs = word ? await epubFetchDefs(word) : null;
  if (seq !== epubWsSeq) return;
  if (!defs || !defs.length) {
    box.innerHTML = `<p class="epub-dict-none">${T("Sin definición para esta palabra.")}</p>`;
    return;
  }
  box.innerHTML = epubDefsHtml(defs);
}

function epubWordSheetClose() {
  epubHide("epub-wordsheet");
  epubWsSeq++;
  epubWsTransOnly = false;
  /* Como en los demás flujos: al cerrar se retira NUESTRA marca
     temporal de selección y la lámina de gestos vuelve sola. */
  epubSelMarkClear();
  epubClearIframeSelection();
  epubPoke();
}

/* Arrastre por el asa: la hoja sigue al dedo entre un mínimo y
   el escenario completo; al soltar, se asienta a 1/3 o a
   completa según dónde quedó, o se cierra si bajó demasiado. */
function epubWsAttach() {
  const sh = document.getElementById("epub-wordsheet");
  const hd = document.getElementById("epub-ws-handle");
  if (!sh || !hd || hd.__mgWsHook) return;
  hd.__mgWsHook = true;
  let drag = null;
  const start = (y) => {
    const st = epubStageEl();
    drag = { y0: y, h0: sh.clientHeight, H: st ? st.clientHeight : sh.clientHeight };
    sh.classList.add("dragging");
  };
  const move = (y) => {
    if (!drag) return;
    sh.style.height = Math.max(110, Math.min(drag.H, drag.h0 + (drag.y0 - y))) + "px";
  };
  const end = () => {
    if (!drag) return;
    const H = drag.H;
    const h = sh.clientHeight;
    drag = null;
    sh.classList.remove("dragging");
    if (h < H * 0.24) { epubWordSheetClose(); return; }
    sh.style.height = (h > H * 0.6 ? H : Math.round(H / 3)) + "px";
  };
  hd.addEventListener("touchstart", (e) => { if (e.touches && e.touches.length === 1) start(e.touches[0].clientY); }, { passive: true });
  hd.addEventListener("touchmove", (e) => {
    if (drag && e.touches && e.touches.length === 1) { move(e.touches[0].clientY); if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  hd.addEventListener("touchend", end);
  hd.addEventListener("touchcancel", () => { drag = null; sh.classList.remove("dragging"); });
  hd.addEventListener("mousedown", (e) => {
    start(e.clientY);
    const mv = (ev) => move(ev.clientY);
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); end(); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
}

/* Selector de diccionario de traducción (r19; en r20 MyMemory
   salió del selector y de raíz): las fuentes viven en el VPS —
   GET /magister/traducir/fuentes → los diccionarios locales y
   las fuentes en línea (Google Traductor) que el servicio
   tenga; el selector se construye desde esa respuesta, así que
   las nuevas aparecen solas. La elección se recuerda en
   localStorage y por defecto es google-en (Google Traductor ·
   inglés); si la elección guardada ya no está entre las
   fuentes, se cae a google-en o a la primera disponible. El
   selector muestra nombre y destino («FreeDict
   Español-Inglés», «Wikcionario — traducciones al ca ·
   catalán», «Google Traductor (en línea) · inglés»). */
const EPUB_DICTSEL_KEY = "magister-epub-dictsel-v1";
const EPUB_LANG_NAMES = { es: "español", en: "inglés", ca: "catalán", de: "alemán", fr: "francés", it: "italiano", pt: "portugués" };
let epubDictSources = null;

function epubDictSelGet() {
  try { return window.localStorage.getItem(EPUB_DICTSEL_KEY) || "google-en"; } catch { return "google-en"; }
}

async function epubDictSourcesLoad() {
  if (epubDictSources) return epubDictSources;
  let list = null;
  if (MAGISTER_DICT_ENABLED) {
    try {
      const r = await fetch(MAGISTER_API_BASE + "/traducir/fuentes");
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.fuentes) && j.fuentes.length) list = j.fuentes;
      }
    } catch { /* sin red con el VPS: queda el mínimo de emergencia */ }
  }
  if (!list) list = [{ id: "google-en", nombre: "Google Traductor (en línea)", destino: "en", tipo: "en_linea" }];
  epubDictSources = list;
  return list;
}

async function epubDictSelSync() {
  const sel = document.getElementById("epub-ws-dict");
  if (!sel) return;
  const sources = await epubDictSourcesLoad();
  const wanted = epubDictSelGet();
  sel.innerHTML = sources.map((f) => {
    const lang = EPUB_LANG_NAMES[f.destino] || f.destino || "";
    const nombre = f.nombre || f.id;
    const label = lang && !nombre.toLowerCase().includes(lang) ? nombre + " · " + lang : nombre;
    return `<option value="${esc(f.id)}">${esc(label)}</option>`;
  }).join("");
  sel.value = sources.some((f) => f.id === wanted) ? wanted
    : (sources.some((f) => f.id === "google-en") ? "google-en" : (sources[0] ? sources[0].id : ""));
  if (!sel.__mgDictHook) {
    sel.__mgDictHook = true;
    sel.addEventListener("change", () => {
      try { window.localStorage.setItem(EPUB_DICTSEL_KEY, sel.value); } catch { /* sin almacenamiento */ }
    });
  }
}

/* Traducción bajo demanda con la fuente elegida (r20: MyMemory
   quedó fuera del selector y de raíz — su API ya no se llama
   nunca desde el cliente): TODAS las fuentes pasan por el VPS,
   GET /magister/traducir?texto=…&diccionario=…; los
   diccionarios son locales y las en línea (google-*) las
   resuelve el servidor como proxy. coincidencia «parcial» o
   «primera_palabra» se anota discretamente con su entrada;
   «frase» es la frase completa traducida; «ninguna» muestra
   «Sin traducción en este diccionario». */
async function epubWsTranslate() {
  if (!epubSel) return;
  const box = document.getElementById("epub-ws-trans");
  const btn = document.getElementById("epub-ws-translate-btn");
  if (!box) return;
  const word = epubCleanWord(epubSel.text) || epubSel.text;
  const selEl = document.getElementById("epub-ws-dict");
  const srcId = (selEl && selEl.value) || epubDictSelGet();
  if (btn) { btn.disabled = true; btn.textContent = T("Traduciendo…"); }
  box.innerHTML = `<p class="epub-dict-status">${T("Traduciendo…")}</p>`;
  const seq = epubWsSeq;
  const done = () => { if (btn) { btn.disabled = false; btn.textContent = T("Traducir"); } };
  try {
    /* Al servidor va el texto COMPLETO seleccionado, no solo la
       primera palabra: los diccionarios locales ya resuelven
       «primera_palabra» solos, y las fuentes en línea (google-*)
       traducen la frase entera (coincidencia «frase»). */
    const fullText = (epubSel.text || "").trim() || word;
    const r = await fetch(MAGISTER_API_BASE + "/traducir?texto=" + encodeURIComponent(fullText) + "&diccionario=" + encodeURIComponent(srcId));
    const j = await r.json();
    if (seq !== epubWsSeq) return;
    done();
    if (!j || j.coincidencia === "ninguna" || !j.traduccion) {
      box.innerHTML = `<p class="epub-dict-none">${T("Sin traducción en este diccionario.")}</p><p class="epub-dict-hint">${T("Prueba con otro diccionario del selector.")}</p>`;
      return;
    }
    const others = (j.traducciones || []).filter((t) => t && t !== j.traduccion);
    let html = `<p class="epub-dict-pos">${esc(langNombre("es"))} → ${esc(langNombre(j.destino || ""))}</p><p class="epub-dict-text">${esc(j.traduccion)}</p>`;
    if (others.length) html += `<p class="epub-dict-hint">${T("También:")} ${esc(others.join(", "))}</p>`;
    if (j.coincidencia === "parcial" || j.coincidencia === "primera_palabra") {
      html += `<p class="epub-dict-hint">${T("Traducción por la entrada")} «${esc(j.entrada || word)}».</p>`;
    }
    html += `<p class="epub-dict-src">${T("Traducción")} · ${esc(j.fuente || T("Diccionario local"))}</p>`;
    box.innerHTML = html;
  } catch {
    if (seq !== epubWsSeq) return;
    done();
    box.innerHTML = `<p class="epub-dict-none">${T("No se pudo traducir esta palabra.")}</p><p class="epub-dict-hint">${T("El diccionario local no respondió; inténtalo de nuevo en un momento.")}</p>`;
  }
}

/* -------------------------------------------------- diccionario */

function epubCleanWord(raw) {
  if (!raw) return "";
  const first = raw.trim().split(/\s+/)[0] || "";
  return first
    .replace(/^[«"“”'‘’(\[{¡!¿?.,;:…—-]+/, "")
    .replace(/[»"“”'‘’)\]}¡!¿?.,;:…—-]+$/, "")
    .trim();
}

function epubDictOpen(word) {
  const seq = epubCardOpen(word, T("Buscando la definición…"), T("Diccionario · Wikcionario, el diccionario libre"));
  epubDictLookup(word, seq);
}

/* Diccionario LOCAL primero (r19): el servicio de Magister en
   el VPS guarda el Wikcionario en casa — GET
   /magister/diccionario?palabra=… → {lema, definiciones:
   [{pos, texto}], fuente, variante?}. La «variante» es otro
   lema cazado sin acentos, con sus definiciones: se muestra
   rotulada tras las del lema principal. Solo si lo local viene
   VACÍO se cae a la cadena en vivo de antes. */
async function epubDictLocal(term) {
  if (!MAGISTER_DICT_ENABLED) return null;
  try {
    const r = await fetch(MAGISTER_API_BASE + "/diccionario?palabra=" + encodeURIComponent(term));
    if (!r.ok) return null;
    const j = await r.json();
    if (!j) return null;
    const out = [];
    for (const d of j.definiciones || []) {
      if (d && d.texto) out.push({ pos: d.pos || "", text: d.texto });
    }
    const v = j.variante;
    if (v && Array.isArray(v.definiciones)) {
      for (const d of v.definiciones) {
        if (d && d.texto) out.push({ pos: d.pos || "", text: d.texto, variante: v.lema || "" });
      }
    }
    return out.length ? out : null;
  } catch { return null; }
}

/* Cadena de búsqueda del diccionario: primero el diccionario
   LOCAL del VPS; si viene vacío, Wikcionario en vivo tal cual,
   Wikcionario en minúsculas y, de respaldo, dictionaryapi.dev.
   Devuelve las acepciones o null. La usan la tarjeta y la hoja
   de la palabra. */
async function epubFetchDefs(term) {
  let defs = await epubDictLocal(term);
  if (defs) return defs;
  defs = await epubDictWikt(term);
  if (!defs && term !== term.toLowerCase()) defs = await epubDictWikt(term.toLowerCase());
  if (!defs) defs = await epubDictApiDev(term);
  return defs;
}

function epubDefsHtml(defs) {
  const main = defs.filter((d) => !d.variante).slice(0, 3);
  const vars = defs.filter((d) => d.variante).slice(0, 2);
  let varHeadShown = false;
  return [...main, ...vars].map((d) => {
    let head = "";
    if (d.variante && !varHeadShown) {
      varHeadShown = true;
      head = `<p class="epub-dict-var">${T("También")} «${esc(d.variante)}» ${T("(coincidencia sin acentos):")}</p>`;
    }
    return head + `<div class="epub-dict-def">${d.pos ? `<p class="epub-dict-pos">${esc(d.pos)}</p>` : ""}<p class="epub-dict-text">${esc(d.text)}</p></div>`;
  }).join("");
}

async function epubDictLookup(word, seq) {
  const defs = await epubFetchDefs(word);
  if (seq !== epubDictSeq) return;
  const body = document.getElementById("epub-dict-body");
  if (!body) return;
  if (!defs || !defs.length) {
    body.innerHTML = `<p class="epub-dict-none">${T("Sin definición para esta palabra.")}</p>
      <p class="epub-dict-hint">${T("El diccionario busca la palabra tal como está escrita; prueba con otra palabra del texto.")}</p>`;
    return;
  }
  body.innerHTML = epubDefsHtml(defs);
}

/* Wikcionario (es.wiktionary.org) por la API de MediaWiki: el
   extracto en texto plano trae las acepciones numeradas bajo la
   sección «Español»; se recogen hasta tres, con su categoría
   gramatical, saltando etimologías, sinónimos y ejemplos. */
async function epubDictWikt(word) {
  try {
    const url = "https://es.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=" + encodeURIComponent(word);
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const pages = (j && j.query && j.query.pages) || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined || !page.extract) return null;
    const defs = epubParseWikt(page.extract);
    return defs.length ? defs : null;
  } catch { return null; }
}

function epubParseWikt(extract) {
  const lines = String(extract || "").split("\n");
  let start = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^==\s*Español\s*==\s*$/.test(lines[i])) { start = i + 1; break; }
  }
  for (let i = start; i < lines.length; i++) {
    if (/^==\s*[^=]/.test(lines[i])) { end = i; break; }
  }
  const bodyLines = lines.slice(start, end);
  const ACC = /^(Sinónimo|Sinónimos|Antónimo|Antónimos|Ejemplo|Ejemplos|Ámbito|Uso|Hiperónimo|Hiperónimos|Hipónimo|Hipónimos|Derivado|Derivados|Relacionado|Relacionados|Nota)\b/;
  const POS = /^(Sustantivo|Verbo|Adjetivo|Adverbio|Interjección|Preposición|Conjunción|Pronombre|Artículo|Numeral|Locución|Forma|Participio|Contracción|Prefijo|Sufijo|Posesivo|Expresión|Determinante)/;
  const defs = [];
  let pos = "";
  let i = 0;
  while (i < bodyLines.length && defs.length < 3) {
    const line = bodyLines[i].trim();
    const head = line.match(/^={2,5}\s*(.+?)\s*={2,5}$/);
    if (head) {
      const name = head[1];
      if (/^(Véase también|Traducciones|Información adicional|Referencias|Enlaces externos)/.test(name)) break;
      if (POS.test(name)) pos = name;
      i++;
      continue;
    }
    if (/^\d{1,2}(\s+\S.*)?$/.test(line)) {
      let j = i + 1;
      const parts = [];
      while (j < bodyLines.length) {
        const l = bodyLines[j].trim();
        if (!l) { j++; break; }
        if (/^\d{1,2}(\s+\S.*)?$/.test(l) || /^={2,}/.test(l)) break;
        if (ACC.test(l)) { j++; continue; }
        parts.push(l);
        j++;
        if (parts.join(" ").length > 420) break;
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text) defs.push({ pos, text });
      i = j;
      continue;
    }
    i++;
  }
  return defs;
}

/* Respaldo: Free Dictionary API (dictionaryapi.dev), acepciones en
   español cuando el Wikcionario no trae la palabra. */
async function epubDictApiDev(word) {
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/es/" + encodeURIComponent(word.toLowerCase()));
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    for (const entry of Array.isArray(j) ? j : []) {
      for (const m of entry.meanings || []) {
        for (const d of m.definitions || []) {
          if (d && d.definition) out.push({ pos: m.partOfSpeech || "", text: d.definition });
          if (out.length >= 3) return out;
        }
      }
    }
    return out.length ? out : null;
  } catch { return null; }
}

/* Apertura: MAGISTER enorme en el centro sobre fondo oscuro, con su
   eslogan. Tras la pausa, el nombre VUELA hasta el logotipo del header
   (0,9 s). La imagen del escaparate se pre-pinta bajo la apertura y se
   decodifica con Image.decode(), así que al aterrizar ya está lista y
   entra con las letras en el mismo fundido suave de 1,5 s. Tocar la
   pantalla salta la espera; un vigía de 6 s evita que atrape a nadie. */
function finishSplash() {
  if (!splashActive) return;
  splashActive = false;
  revealed = true;
  try { window.sessionStorage.setItem("magister-splash-v1", "1"); } catch { /* sin sessionStorage */ }
  const splash = document.getElementById("splash");
  if (splash) splash.remove();
  const pre = root.querySelector(".prepaint");
  if (pre) pre.remove();
  render();
  if (mainEl) mainEl.classList.add("page-enter");
  if (navEl) navEl.classList.add("page-enter");
  if (adminWelcomeDeferred) { adminWelcomeDeferred = false; maybeShowAdminWelcome(); }
}

function startSplash() {
  const splash = document.getElementById("splash");
  const title = document.getElementById("splash-title");
  if (!splash || !title) { finishSplash(); return; }
  const timers = [];
  const later = (fn, ms) => timers.push(window.setTimeout(fn, ms));
  const land = () => {
    splash.classList.add("landed");
    title.classList.add("landed");
    revealed = true;
    render();
    if (mainEl) mainEl.classList.add("page-enter");
    if (navEl) navEl.classList.add("page-enter");
    if (adminWelcomeDeferred) { adminWelcomeDeferred = false; maybeShowAdminWelcome(); }
    later(() => { splashActive = false; try { window.sessionStorage.setItem("magister-splash-v1", "1"); } catch {} splash.remove(); const pre = root.querySelector(".prepaint"); if (pre) pre.remove(); }, 1600);
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { later(land, 500); }
  else {
    const HOLD = 1700, FLY = 900;
    later(() => {
      const target = document.getElementById("magister-logo");
      if (target) {
        const from = title.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const scale = to.width / Math.max(from.width, 1);
        title.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})`;
        title.style.transition = `transform ${FLY}ms cubic-bezier(0.22, 0.61, 0.21, 1)`;
        splash.classList.add("flying");
        later(land, FLY + 40);
      } else land();
    }, HOLD);
  }
  // Vigía anti-atrapamiento: pase lo que pase, la apertura se va.
  later(() => { if (splashActive) finishSplash(); }, 6000);
}

/* Precarga activa de la imagen del escaparate. */
(function preloadHero() {
  if (!HERO_IMG) return;
  const img = new Image();
  img.src = HERO_IMG;
  if (typeof img.decode === "function") img.decode().catch(() => {});
})();

buildShell();
render();
if (splashActive) startSplash();
refreshSession();
refreshCatalogState();
