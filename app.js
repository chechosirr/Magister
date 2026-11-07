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
let view = { name: "home" };   // home | library | categories | search | account | detail | reader | chat
let viewHistory = [];          // pila de vistas para la flecha de volver del header
let catalogHidden = new Set(); // ids pausados/eliminados en el servicio (no se muestran al público)
let libOnlyFavorites = false;
let authNotice = false;        // aviso de «servicio en activación» tras intentar entrar en modo muestra
let authError = "";
let authBusy = false;
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

function libraryHtml() {
  const shown = libOnlyFavorites ? libraryEntries.filter((e) => e.favorite) : libraryEntries;
  const finishedCount = libraryEntries.filter((e) => e.finished).length;
  let body;
  if (shown.length === 0) {
    body = `<div class="card dashed mt-8" style="margin-top:32px">
      <p class="small dim" style="margin:0">${libOnlyFavorites
        ? "Todavía no marcas ningún favorito. Toca la estrella en un libro de tu estante."
        : "Tu estante está vacío. Busca en las categorías y añade tu primer libro."}</p>
      <button type="button" class="btn-primary pad mt-3" data-action="goto-categories">Explorar</button>
    </div>`;
  } else {
    body = `<div class="grid-books mt-5" style="margin-top:20px">${shown.map((entry) => {
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
  return `<div class="view-pad">
    <h1 class="view-title">Tu biblioteca</h1>
    <p class="small dim mt-1">${libraryEntries.length} ${libraryEntries.length === 1 ? "libro" : "libros"} en tu estante · ${finishedCount} terminados</p>
    <div class="chip-row">
      <button type="button" class="chip${!libOnlyFavorites ? " active" : ""}" data-action="lib-filter" data-f="all">Todos</button>
      <button type="button" class="chip${libOnlyFavorites ? " active" : ""}" data-action="lib-filter" data-f="fav">★ Favoritos</button>
    </div>
    ${body}
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
  const inReader = view.name === "reader";
  const inChat = view.name === "chat";
  headerEl.classList.toggle("hidden", inReader || inChat);
  headerEl.classList.toggle("absolute", view.name === "home" && !inReader);
  headerEl.classList.toggle("sticky", view.name !== "home" && !inReader && !inChat);
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
  if (backBtn) backBtn.hidden = onHome || inReader || inChat;

  const fab = document.getElementById("help-fab");
  // El flotante «Ayuda» SOLO vive en la página de inicio y en el
  // formulario de inicio de sesión (vista de cuenta sin sesión);
  // fuera de Explorar, categorías, fichas, lector, biblioteca y
  // cuenta con sesión (regla de Sergio).
  if (fab) fab.hidden = !(revealed && (view.name === "home" || (view.name === "account" && !token)));

  mainEl.className = view.name === "home" || inChat ? "" : "wrap";
  let html = "";
  if (view.name === "home") html = escaparateHtml();
  else if (view.name === "library") html = token ? libraryHtml() : `<p class="dim" style="padding-top:40px">Inicia sesión para ver tu biblioteca.</p>`;
  else if (view.name === "categories") html = categoriesHtml();
  else if (view.name === "search") html = searchHtml();
  else if (view.name === "detail") html = detailHtml();
  else if (view.name === "reader") html = readerHtml();
  else if (view.name === "account") html = accountHtml();
  else if (view.name === "admin-home") html = adminHomeHtml();
  else if (view.name === "chat") html = chatViewHtml();
  if (view.name !== "home" && view.name !== "chat" && view.name !== "admin-home") {
    html += `<footer class="site-footer"><p>Catálogo en preparación: los libros se servirán desde el servidor propio de Magister. Las portadas se muestran como muestra visual del catálogo mientras se carga el contenido.</p></footer>`;
  }
  mainEl.innerHTML = html;
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
  detailState = "loading"; detailData = null; detailError = "";
  go({ name: "detail", bookId });
  api.getBookDetail(token, bookId).then((d) => {
    detailData = d; detailState = "done"; if (view.name === "detail") render();
  }).catch((e) => {
    detailState = "error"; detailError = errorText(e); if (view.name === "detail") render();
  });
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
      ${!anonNeedsIntro && !chatClosed ? `<button type="button" class="chatview-endbtn" data-action="chat-finalize">Finalizar chat</button>` : ""}
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
      <button type="button" class="btn-primary" data-action="chat-new">Iniciar un chat nuevo</button>
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
      if (r && r.conv) { chatAnonConv = r.conv; chatSave(CHAT_CONV_KEY, chatAnonConv); }
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
  else if (action === "chat-finalize") chatFinalize();
  else if (action === "chat-new") { chatResetForNew(); render(); chatStart(); }
  else if (action === "goto-home") { viewHistory = []; go({ name: "home" }, { replace: true }); }
  else if (action === "goto-library") go({ name: "library" });
  else if (action === "require-auth") go({ name: "account" });
  else if (action === "subscribe") go({ name: "account" });
  else if (action === "read") openChapter(id, Number(el.dataset.ch || 0));
  else if (action === "reader-exit") goBack();
  else if (action === "reader-chapter") {
    const n = Number(el.dataset.ch);
    if (chapterData && n >= 0 && n < chapterData.chapterCount) openChapter(view.bookId, n);
  }
  else if (action === "font-inc") { readerFontSize = Math.min(26, readerFontSize + 1); render(); }
  else if (action === "font-dec") { readerFontSize = Math.max(15, readerFontSize - 1); render(); }
  else if (action === "lib-filter") { libOnlyFavorites = el.dataset.f === "fav"; render(); }
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

/* ------------------------------------------------------------ apertura */

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
