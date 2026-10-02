/**
 * Cloudflare Worker: intermediario entre la página (GitHub Pages) y la API de HacknPlan.
 *
 * Secretos (Cloudflare → Worker → Settings → Variables and Secrets):
 *   HACKNPLAN_API_KEY, HACKNPLAN_PROJECT_ID, APP_PASSWORD
 * Variable opcional:
 *   ALLOWED_ORIGIN  p.ej. https://tuusuario.github.io  (si no se define, acepta cualquier origen)
 *
 * Endpoints (todos piden la cabecera X-App-Password):
 *   GET  /meta   -> tablero actual, categorías, importancias y usuarios
 *   POST /tasks  -> crea la tarea en el último tablero, Design = Gameplay, fechas del tablero
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
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
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

// ---------------------------------------------------------------- endpoints

async function getMeta(hp) {
  const [board, categories, levels, users] = await Promise.all([
    getLastBoard(hp),
    hp.get("/categories"),
    hp.get("/importancelevels"),
    hp.get("/users"),
    getDesignElementId(hp), // solo valida que exista "Gameplay"
  ]);
  return {
    board: { boardId: board.boardId, name: board.name, startDate: board.startDate, dueDate: board.dueDate },
    designElement: DESIGN_ELEMENT_NAME,
    categories: categories.map((c) => c.name),
    defaultCategory: DEFAULT_CATEGORY,
    importance: levels.map((l) => ({ name: l.name, isDefault: !!l.isDefault })),
    users: users.map((u) => u.user || u).map((u) => ({ username: u.username, name: u.name || u.username })),
  };
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
