"""
Crea una tarea en HacknPlan (API REST v0).

- La tarea va al ÚLTIMO tablero creado del proyecto.
- Usa la fecha de inicio y la due date de ese tablero.
- El design element ("Design") es siempre "Gameplay".
- La categoría se pasa con --category (por defecto Programming).

Uso:
    pip install requests
    Rellena el archivo .env (junto a este script) con:
        HACKNPLAN_API_KEY=tu_api_key
        HACKNPLAN_PROJECT_ID=123456
    python hacknplan_create_task.py            -> crea una tarea de ejemplo
    python hacknplan_create_task.py --dry-run  -> muestra lo que enviaría sin crear nada
    python hacknplan_create_task.py --title "Salto doble" --category Programming --description "..."
    python hacknplan_create_task.py --title "Salto doble" --assign SimonMorales20 Cosme
"""

import argparse
import json
import os
import sys
from pathlib import Path

import requests


def load_env(path):
    """Carga variables KEY=VALUE de un .env (sin pisar las que ya existan en el entorno)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


# ---------------------------------------------------------------------------
# Configuración: se lee del .env que está en la misma carpeta que el script
# ---------------------------------------------------------------------------
load_env(Path(__file__).resolve().parent / ".env")

API_KEY = os.getenv("HACKNPLAN_API_KEY", "")
PROJECT_ID = os.getenv("HACKNPLAN_PROJECT_ID", "")
DESIGN_ELEMENT_NAME = "Gameplay"   # Campo "Design" de la tarea (siempre el mismo)
DEFAULT_CATEGORY = "Programming"   # Categoría si no se indica otra con --category

BASE_URL = "https://api.hacknplan.com/v0"
HEADERS = {
    "Authorization": f"ApiKey {API_KEY}",
    "Content-Type": "application/json",
}


def api_get(path):
    r = requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json()
    # Algunos endpoints devuelven lista directa, otros {"items": [...]}
    if isinstance(data, dict) and "items" in data:
        return data["items"]
    return data


def api_post(path, payload):
    r = requests.post(f"{BASE_URL}{path}", headers=HEADERS, json=payload, timeout=30)
    if not r.ok:
        print(f"Error {r.status_code}: {r.text}", file=sys.stderr)
        r.raise_for_status()
    return r.json()


def get_last_board(project_id):
    """Devuelve el tablero creado más recientemente."""
    boards = api_get(f"/projects/{project_id}/boards")
    if not boards:
        raise RuntimeError("El proyecto no tiene tableros.")
    # Ordena por fecha de creación; si no existe, por boardId (es incremental)
    return max(boards, key=lambda b: (b.get("creationDate") or "", b.get("boardId", 0)))


def get_category_id(project_id, name):
    categories = api_get(f"/projects/{project_id}/categories")
    for c in categories:
        if c.get("name", "").strip().lower() == name.lower():
            return c["categoryId"]
    available = ", ".join(c.get("name", "?") for c in categories)
    raise RuntimeError(f"No existe la categoría '{name}'. Disponibles: {available}")


def _flatten(elements):
    """Aplana el árbol de design elements (por si vienen anidados en 'children')."""
    for e in elements:
        yield e
        yield from _flatten(e.get("children") or [])


def get_design_element_id(project_id, name):
    elements = list(_flatten(api_get(f"/projects/{project_id}/designelements")))
    for e in elements:
        if e.get("name", "").strip().lower() == name.lower():
            return e["designElementId"]
    available = ", ".join(e.get("name", "?") for e in elements)
    raise RuntimeError(f"No existe el design element '{name}'. Disponibles: {available}")


def get_importance_level(project_id, name=None):
    """Devuelve (id, nombre) del nivel de importancia; sin nombre, el marcado por defecto."""
    levels = api_get(f"/projects/{project_id}/importancelevels")
    for lvl in levels:
        if (name and lvl.get("name", "").strip().lower() == name.lower()) or \
           (not name and lvl.get("isDefault")):
            return lvl["importanceLevelId"], lvl["name"]
    available = ", ".join(lvl.get("name", "?") for lvl in levels)
    raise RuntimeError(f"No existe la importancia '{name}'. Disponibles: {available}")


def get_user_ids(project_id, names):
    """Convierte usernames o nombres (completos o parciales) en (id, nombre) de usuarios del proyecto."""
    users = [u.get("user", u) for u in api_get(f"/projects/{project_id}/users")]
    found = []
    for query in names:
        q = query.strip().lower()
        exact = [u for u in users if q in (u.get("username", "").lower(), u.get("name", "").lower())]
        partial = [u for u in users
                   if q in u.get("username", "").lower() or q in u.get("name", "").lower()]
        matches = exact or partial
        if len(matches) != 1:
            available = ", ".join(f"{u.get('username')} ({u.get('name')})" for u in users)
            problem = "es ambiguo" if matches else "no existe"
            raise RuntimeError(f"El usuario '{query}' {problem}. Usuarios: {available}")
        found.append((matches[0]["id"], matches[0].get("name") or matches[0].get("username")))
    return found


def create_task(title, category, description="", estimated_cost=0, importance=None,
                assign=None, tag_ids=None, dry_run=False):
    """Crea una tarea en el último tablero, design element Gameplay, con las fechas del tablero."""
    board = get_last_board(PROJECT_ID)
    category_id = get_category_id(PROJECT_ID, category)
    design_element_id = get_design_element_id(PROJECT_ID, DESIGN_ELEMENT_NAME)
    importance_id, importance_name = get_importance_level(PROJECT_ID, importance)

    print(f"Tablero: {board.get('name')} (id {board['boardId']})")
    print(f"  Inicio: {board.get('startDate')}  |  Due: {board.get('dueDate')}")
    print(f"Categoría: {category} (id {category_id})")
    print(f"Design: {DESIGN_ELEMENT_NAME} (id {design_element_id})")
    print(f"Importancia: {importance_name} (id {importance_id})")
    assigned = get_user_ids(PROJECT_ID, assign) if assign else []
    if assigned:
        print("Asignada a: " + ", ".join(f"{name} (id {uid})" for uid, name in assigned))

    payload = {
        "title": title,
        "description": description,
        "isStory": False,
        "categoryId": category_id,
        "designElementId": design_element_id,
        "importanceLevelId": importance_id,
        "estimatedCost": estimated_cost,
        "boardId": board["boardId"],
        "startDate": board.get("startDate"),
        "dueDate": board.get("dueDate"),
    }
    if assigned:
        payload["assignedUserIds"] = [uid for uid, _ in assigned]
    if tag_ids:
        payload["tagIds"] = tag_ids

    # Quita campos vacíos (p.ej. si el tablero no tiene fechas)
    payload = {k: v for k, v in payload.items() if v is not None}

    if dry_run:
        print("\n[DRY RUN] Se enviaría:")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return None

    task = api_post(f"/projects/{PROJECT_ID}/workitems", payload)
    print(f"\nTarea creada: #{task.get('workItemId')} - {task.get('title')}")
    return task


def main():
    parser = argparse.ArgumentParser(description="Crear tarea en HacknPlan")
    parser.add_argument("--title", default="[TEST] Tarea de ejemplo creada por script")
    parser.add_argument("--description",
                        default="Tarea de prueba generada automáticamente vía API REST de HacknPlan.")
    parser.add_argument("--category", default=DEFAULT_CATEGORY,
                        help="Programming, Art, Design, Writing, Marketing, Sound, Ideas, Bug...")
    parser.add_argument("--importance", default=None,
                        help="Urgent, High, Normal, Low (por defecto la del proyecto)")
    parser.add_argument("--cost", type=float, default=0, help="Coste estimado (por defecto 0)")
    parser.add_argument("--assign", nargs="+", metavar="USUARIO",
                        help="Username o nombre de uno o varios usuarios del proyecto")
    parser.add_argument("--dry-run", action="store_true", help="No crea nada, solo muestra el payload")
    args = parser.parse_args()

    if not API_KEY or not PROJECT_ID:
        sys.exit("Falta HACKNPLAN_API_KEY o HACKNPLAN_PROJECT_ID en el archivo .env.")

    create_task(
        title=args.title,
        category=args.category,
        description=args.description,
        estimated_cost=args.cost,
        importance=args.importance,
        assign=args.assign,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
