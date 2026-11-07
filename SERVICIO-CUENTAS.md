# Magister — servicio de cuentas y libros (diseño para el VPS)

La página pública de Magister es estática (GitHub Pages). Todo lo que
necesita servidor —cuentas, biblioteca personal, avance de lectura y los
textos de los libros— vivirá en el VPS de Sergio (puente), siguiendo el
mismo patrón que Rager: un servicio propio detras de
`https://puente.ragerservices.net/magister`.

La página ya trae la capa de API completa en `app.js`
(`MAGISTER_API_BASE = "https://puente.ragerservices.net/magister"`).
Mientras el servicio no exista, la página funciona en **modo muestra**:
catálogo y diseño completos y navegables, y el panel de «Mi cuenta»
muestra el formulario con el aviso de que el servicio se está activando.
Para activar: implementar el servicio con este contrato y poner
`MAGISTER_API_ENABLED = true` en `app.js`.

## Contrato de API (lo que la página espera)

Autenticación con token de sesión en `Authorization: Bearer <token>`.

| Método y ruta | Cuerpo / respuesta |
| --- | --- |
| `POST /auth/login` | `{email, password}` → `{token, user}` |
| `GET /auth/me` | → `{user}` (o `{user: null}` si el token no vale) |
| `POST /auth/logout` | → `{ok: true}` |
| `GET /library` | → `{entries: [{entryId, book, favorite, currentChapter, finished, lastReadAt}]}` |
| `POST /library/add` | `{bookId}` |
| `POST /library/remove` | `{bookId}` |
| `POST /library/favorite` | `{bookId, favorite}` |
| `GET /books/:id` | → `{book, hasContent, chapters: [{index, title}], previewChapters, subscribed, inLibrary, favorite, currentChapter, finished}` |
| `GET /books/:id/chapters/:n` | → `{title, chapterTitle, body, chapterIndex, chapterCount, previewChapters, subscribed, locked, contentPending}` |

`user` = `{id, name, email, subscribed}`. El catálogo (portadas, títulos,
autores, categorías) es estático y va en la propia página (`data.js`); el
servicio solo necesita conocer los libros por su `id` (1–51, los de
`data.js`) para la biblioteca personal, el avance y los textos.

## Modelo de acceso (lo hace cumplir el servidor, no la página)

- Sin cuenta no se abre ningún libro: detalle y capítulos exigen sesión.
- Con cuenta sin suscripción: solo la muestra corta (primer capítulo,
  `previewChapters = 1`); los demás capítulos se devuelven `locked`.
- Con suscripción (`user.subscribed`): el libro completo.
- Los textos se guardan por libro en el servidor (capítulos
  `{title, body}`); mientras un libro no tenga texto cargado, la ficha
  muestra «Contenido en preparación».

## SEPARACIÓN DE CUENTAS MAGISTER ↔ RAGER (orden de Sergio, 2026-11-06)

«Las cuentas no se pueden cruzar: usar las de Rager en Magister y
viceversa.» Aunque ambos servicios vivan en el mismo VPS, son dos
mundos aparte:

1. **Almacén propio y separado.** Magister guarda sus cuentas en su
   propio almacén (p. ej. `/var/lib/magister/accounts.json` con su clave
   `/var/lib/magister/accounts.key`, permisos 600), servido por su
   propio proceso. **Nunca** se reutiliza el almacén de Rager
   (`/var/lib/rager-bridge/accounts.json`) ni su clave: ni lecturas, ni
   escrituras, ni «por si acaso».
2. **Tokens con ámbito propio.** Los tokens de sesión de Magister se
   emiten con prefijo de ámbito `mgst_` y se firman/verifican SOLO con
   la clave de Magister y contra su propio almacén. Un token de Rager
   presentado en Magister se rechaza siempre (ámbito y firma ajenos), y
   un token de Magister no autentica en Rager. Cada servicio acepta
   únicamente tokens emitidos por él mismo.
3. **Sin inicio de sesión cruzado.** No hay SSO ni federación entre
   Rager y Magister: el login de Magister consulta solo su almacén. Que
   una persona use el mismo correo y la misma contraseña en ambos crea
   dos cuentas independientes, sin relación entre ellas.
4. **En el navegador.** La página de Magister guarda su token solo en
   `localStorage` bajo la clave `magister-token` y jamás lee tokens ni
   sesiones de Rager (que vive en otro dominio y con sus propias
   claves).

## Pendiente (lado VPS)

- [ ] Crear el servicio (proceso propio, p. ej. `magister-bridge`) con
      su almacén y clave separados, detras de la ruta `/magister` en
      Caddy.
- [ ] Alta de cuentas: las crea el dueño (como en Rager); la página no
      ofrece «Crear cuenta» a propósito.
- [ ] Carga de textos de los libros desde el servidor propio de libros.
- [ ] Poner `MAGISTER_API_ENABLED = true` en `app.js` y republicar.
