/**
 * Cloudflare Worker: intermediario entre la página (GitHub Pages) y la API de HacknPlan.
 *
 * Secretos (Cloudflare → Worker → Settings → Variables and Secrets):
 *   HACKNPLAN_API_KEY, HACKNPLAN_PROJECT_ID, APP_PASSWORD
 * Variable opcional:
 *   ALLOWED_ORIGIN  p.ej. https://tuusuario.github.io  (si no se define, acepta cualquier origen)
 *
 * Endpoints (todos piden la cabecera X-App-Password):
 *   GET  /meta   -> tablero actual, categorías, importancias, usuarios, milestones y propuesta de tablero
 *   POST /tasks  -> crea la tarea en el último tablero, Design = Gameplay, fechas del tablero
 *   POST /boards -> crea un tablero nuevo (pasa a ser el "último tablero" para las tareas)
 *   POST /move   -> mueve una tanda de tareas sin terminar de un tablero a otro (la página repite
 *                   hasta que no queden; el plan gratis de Cloudflare limita las llamadas por petición)
 */

const API = "https://api.hacknplan.com/v0";
const DESIGN_ELEMENT_NAME = "Gameplay"; // Campo "Design" de la tarea (siempre el mismo)
const DEFAULT_CATEGORY = "Programming"; // Categoría si no se indica otra

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    try {
      if (!env.HACKNPLAN_API_KEY || !env.HACKNPLAN_PROJECT_ID || !env.APP_PASSWORD) {
        return json({ error: "Faltan secretos en el Worker (API key, project id o APP_PASSWORD)." }, 500);
      }
      if (!(await samePassword(request.headers.get("X-App-Password") || "", env.APP_PASSWORD))) {
        return json({ error: "Contraseña incorrecta" }, 401);
      }

      const hp = hacknplan(env);
      const { pathname } = new URL(request.url);
      if (pathname === "/meta" && request.method === "GET") return json(await getMeta(hp));
      if (pathname === "/tasks" && request.method === "POST") {
        return json(await createTask(hp, await request.json().catch(() => ({}))));
      }
      if (pathname === "/boards" && request.method === "POST") {
        return json(await createBoard(hp, await request.json().catch(() => ({}))));
      }
      if (pathname === "/move" && request.method === "POST") {
        return json(await moveUnfinished(hp, await request.json().catch(() => ({}))));
      }
      return json({ error: "No encontrado" }, 404);
    } catch (err) {
      return json({ error: err.message }, err.status || 500);
    }
  },
};

// ---------------------------------------------------------------- utilidades

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN) : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Compara contraseñas en tiempo constante (vía hash). */
async function samePassword(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function hacknplan(env) {
  const pid = env.HACKNPLAN_PROJECT_ID;
  const call = async (method, path, body) => {
    const res = await fetch(`${API}/projects/${pid}${path}`, {
      method,
      headers: { Authorization: `ApiKey ${env.HACKNPLAN_API_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw fail(`HacknPlan respondió ${res.status}: ${text}`, 502);
    const data = text ? JSON.parse(text) : null;
    // Algunos endpoints devuelven lista directa, otros {"items": [...]}
    return data && !Array.isArray(data) && Array.isArray(data.items) ? data.items : data;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
  };
}

const norm = (s) => (s || "").trim().toLowerCase();

function flatten(elements) {
  return elements.flatMap((e) => [e, ...flatten(e.children || [])]);
}

async function getLastBoard(hp) {
  const boards = await hp.get("/boards");
  if (!boards || !boards.length) throw fail("El proyecto no tiene tableros.");
  // El creado más recientemente; si no hay fecha de creación, el de boardId más alto
  return boards.reduce((best, b) => {
    const key = (x) => [x.creationDate || "", x.boardId || 0];
    const [bd, bi] = key(b), [cd, ci] = key(best);
    return bd > cd || (bd === cd && bi > ci) ? b : best;
  });
}

async function getDesignElementId(hp) {
  const elements = flatten((await hp.get("/designelements")) || []);
  const found = elements.find((e) => norm(e.name) === norm(DESIGN_ELEMENT_NAME));
  if (!found) {
    throw fail(`No existe el design element '${DESIGN_ELEMENT_NAME}'. Disponibles: ` +
               elements.map((e) => e.name).join(", "));
  }
  return found.designElementId;
}

// Fechas: la API usa "YYYY-MM-DDTHH:MM:SS"; la página trabaja con "YYYY-MM-DD".
const DAY_MS = 86400000;
const datePart = (iso) => (iso || "").slice(0, 10);
const timePart = (iso, fallback = "00:00:00") => (iso && iso.length > 11 ? iso.slice(11, 19) : fallback);
const toMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, days) => new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !Number.isNaN(toMs(s));

/** Propone el siguiente tablero: nombre +1, empieza cuando vence el último y dura lo mismo. */
function suggestNextBoard(last) {
  const m = (last.name || "").match(/^(.*?)(\d+)(\D*)$/);
  const name = m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : "";
  const start = datePart(last.dueDate) || new Date().toISOString().slice(0, 10);
  const days = last.startDate && last.dueDate
    ? Math.max(1, Math.round((toMs(datePart(last.dueDate)) - toMs(datePart(last.startDate))) / DAY_MS))
    : 14;
  return { name, startDate: start, dueDate: addDays(start, days), milestoneId: last.milestoneId ?? null };
}

const PAGE_SIZE = 100;  // máximo que acepta HacknPlan
const MOVE_BATCH = 35;  // tareas por petición a /move (deja margen al límite de ~50 llamadas del plan gratis)

/** Tareas del tablero cuya etapa no está cerrada (Planned, In progress, Testing...). */
async function listUnfinished(hp, boardId) {
  const items = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await hp.get(`/workitems?boardId=${boardId}&offset=${offset}&limit=${PAGE_SIZE}`);
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return items.filter((i) => (i.stage && i.stage.status) !== "closed");
}

// ---------------------------------------------------------------- endpoints

async function getMeta(hp) {
  const [board, categories, levels, users, milestones] = await Promise.all([
    getLastBoard(hp),
    hp.get("/categories"),
    hp.get("/importancelevels"),
    hp.get("/users"),
    hp.get("/milestones"),
    getDesignElementId(hp), // solo valida que exista "Gameplay"
  ]);
  const unfinished = await listUnfinished(hp, board.boardId);
  return {
    board: { boardId: board.boardId, name: board.name, startDate: board.startDate, dueDate: board.dueDate,
             unfinished: unfinished.length },
    nextBoard: suggestNextBoard(board),
    designElement: DESIGN_ELEMENT_NAME,
    categories: categories.map((c) => c.name),
    defaultCategory: DEFAULT_CATEGORY,
    importance: levels.map((l) => ({ name: l.name, isDefault: !!l.isDefault })),
    users: users.map((u) => u.user || u).map((u) => ({ username: u.username, name: u.name || u.username })),
    milestones: (milestones || []).map((m) => ({ milestoneId: m.milestoneId, name: m.name })),
  };
}

async function createBoard(hp, data) {
  const name = (data.name || "").trim();
  if (!name) throw fail("El nombre del tablero es obligatorio.");
  if (!isDate(data.startDate) || !isDate(data.dueDate)) throw fail("Las fechas no son válidas.");
  if (data.dueDate < data.startDate) throw fail("La due date no puede ser anterior a la fecha de inicio.");

  const [last, allBoards] = await Promise.all([getLastBoard(hp), hp.get("/boards?includeClosed=true")]);
  if (allBoards.some((b) => norm(b.name) === norm(name))) throw fail(`Ya existe un tablero llamado '${name}'.`);

  // Misma hora que los tableros existentes, para que HacknPlan muestre los mismos días
  const payload = {
    name,
    description: (data.description || "").trim(),
    startDate: `${data.startDate}T${timePart(last.startDate)}`,
    dueDate: `${data.dueDate}T${timePart(last.dueDate)}`,
  };
  if (data.milestoneId) payload.milestoneId = Number(data.milestoneId);

  const board = await hp.post("/boards", payload);
  return {
    boardId: board.boardId, name: board.name, startDate: board.startDate, dueDate: board.dueDate,
    previous: { boardId: last.boardId, name: last.name },  // de aquí salen las tareas a mover
  };
}

async function moveUnfinished(hp, data) {
  const from = Number(data.fromBoardId), to = Number(data.toBoardId);
  if (!from || !to || from === to) throw fail("Tableros de origen/destino no válidos.");

  const [target, unfinished] = await Promise.all([hp.get(`/boards/${to}`), listUnfinished(hp, from)]);
  const batch = unfinished.slice(0, MOVE_BATCH);
  const failed = [];
  // De a 5 en paralelo para no saturar la API
  for (let i = 0; i < batch.length; i += 5) {
    await Promise.all(batch.slice(i, i + 5).map((item) =>
      hp.patch(`/workitems/${item.workItemId}`, {
        boardId: to,
        startDate: target.startDate,
        dueDate: target.dueDate,
      }).catch((err) => failed.push(`#${item.workItemId} ${item.title}: ${err.message}`))));
  }
  return { moved: batch.length - failed.length, remaining: unfinished.length - batch.length, failed };
}

async function createTask(hp, data) {
  const title = (data.title || "").trim();
  if (!title) throw fail("El título es obligatorio.");
  const cost = Number(data.cost || 0);
  if (!Number.isFinite(cost) || cost < 0) throw fail("El coste estimado tiene que ser un número.");

  const [board, designElementId, categories, levels, users] = await Promise.all([
    getLastBoard(hp),
    getDesignElementId(hp),
    hp.get("/categories"),
    hp.get("/importancelevels"),
    hp.get("/users"),
  ]);

  const categoryName = data.category || DEFAULT_CATEGORY;
  const category = categories.find((c) => norm(c.name) === norm(categoryName));
  if (!category) throw fail(`No existe la categoría '${categoryName}'.`);

  const level = data.importance
    ? levels.find((l) => norm(l.name) === norm(data.importance))
    : levels.find((l) => l.isDefault);
  if (!level) throw fail(`No existe la importancia '${data.importance}'.`);

  const projectUsers = users.map((u) => u.user || u);
  const assignedUserIds = (data.assign || []).map((username) => {
    const u = projectUsers.find((x) => norm(x.username) === norm(username));
    if (!u) throw fail(`El usuario '${username}' no está en el proyecto.`);
    return u.id;
  });

  const payload = {
    title,
    description: (data.description || "").trim(),
    isStory: false,
    categoryId: category.categoryId,
    designElementId,
    importanceLevelId: level.importanceLevelId,
    estimatedCost: cost,
    boardId: board.boardId,
    startDate: board.startDate,
    dueDate: board.dueDate,
  };
  if (assignedUserIds.length) payload.assignedUserIds = assignedUserIds;
  for (const k of Object.keys(payload)) if (payload[k] == null) delete payload[k];

  const task = await hp.post("/workitems", payload);
  return { workItemId: task.workItemId, title: task.title, board: board.name };
}
