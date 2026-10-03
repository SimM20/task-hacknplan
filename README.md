# HacknPlan Tareas

Crea tareas en el último tablero del proyecto, con Design = Gameplay y las fechas del tablero.
Desde la web también se pueden crear tableros nuevos (propone el siguiente sprint: nombre +1,
empieza cuando vence el último y dura lo mismo); las tareas siguientes van a ese tablero.
Al crear un tablero, opcionalmente mueve las tareas sin terminar (etapa distinta de Completed)
del tablero anterior al nuevo, con las fechas del nuevo. Las completadas se quedan donde estaban.

| Archivo | Para qué |
|---|---|
| `docs/index.html` | **Web** (va en GitHub Pages). No contiene secretos. |
| `worker/worker.js` | **Cloudflare Worker**: guarda la API key y habla con HacknPlan. |
| `hacknplan_gui.pyw` | Ventana de escritorio (doble clic). Usa el `.env`. |
| `hacknplan_create_task.py` | Línea de comandos. Usa el `.env` (`pip install -r requirements.txt`). |

```
Navegador (GitHub Pages) ──contraseña──▶ Cloudflare Worker ──API key──▶ HacknPlan
```

La API key **solo** vive en el Worker (como secreto). El `.env` es solo para usar los
scripts en tu PC y nunca se sube (está en `.gitignore`).

## 1. Cloudflare Worker (una vez)

1. Crea una cuenta gratis en https://dash.cloudflare.com
2. **Workers & Pages → Create → Create Worker** → nombre: `hacknplan-tareas` → Deploy.
3. **Edit code** → borra todo, pega el contenido de `worker/worker.js` → **Deploy**.
4. **Settings → Variables and Secrets → Add**, tipo **Secret**, las tres:
   - `HACKNPLAN_API_KEY`
   - `HACKNPLAN_PROJECT_ID`
   - `APP_PASSWORD` (la contraseña para entrar a la web; que sea larga)
5. Copia la URL del Worker, tipo `https://hacknplan-tareas.tu-usuario.workers.dev`.

## 2. GitHub Pages

1. En `docs/index.html` cambia `WORKER_URL` por la URL del paso anterior.
2. Sube esta carpeta a un repo de GitHub (público: Pages gratis no funciona con privados;
   no pasa nada porque el repo no tiene secretos).
3. En el repo: **Settings → Pages → Source: Deploy from a branch → Branch: `main`, carpeta `/docs`** → Save.
4. En un minuto queda en `https://tu-usuario.github.io/nombre-del-repo/`.

Opcional: en el Worker añade la variable (no secreta) `ALLOWED_ORIGIN = https://tu-usuario.github.io`
para que solo tu página pueda llamarlo.

## Cambiar algo después

- Lógica (Design "Gameplay", categoría por defecto...): edita `worker/worker.js` y vuelve a pegarlo en Cloudflare.
- Aspecto de la página: edita `docs/index.html` y haz push; GitHub Pages se actualiza solo.
