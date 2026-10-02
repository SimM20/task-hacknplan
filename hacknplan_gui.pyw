"""
Interfaz gráfica para crear tareas en HacknPlan.

Doble clic en este archivo para abrirlo (o: python hacknplan_gui.pyw).
Usa la misma configuración (.env) y lógica que hacknplan_create_task.py.
"""

import queue
import threading
import tkinter as tk
from datetime import datetime
from tkinter import ttk

import requests

import hacknplan_create_task as hp

# Colores parecidos a HacknPlan (tema oscuro)
BG = "#2b2b2b"
PANEL = "#363636"
FIELD = "#1e1e1e"
FG = "#e6e6e6"
MUTED = "#9a9a9a"
ACCENT = "#3d8fd1"
OK = "#5cb85c"
ERR = "#e9262b"


def fmt_date(value):
    try:
        return datetime.fromisoformat(value).strftime("%d/%m/%Y")
    except (TypeError, ValueError):
        return value or "-"


def error_text(exc):
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return f"Error {exc.response.status_code}: {exc.response.text}"
    return str(exc)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("HacknPlan - Nueva tarea")
        self.configure(bg=BG)
        self.minsize(560, 600)
        self.results = queue.Queue()
        self.user_vars = {}

        self._setup_style()
        self._build()
        self._run_in_background(self._load_project_data, self._on_loaded)
        self.after(100, self._poll)

    # ------------------------------------------------------------------ UI
    def _setup_style(self):
        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(".", background=BG, foreground=FG, fieldbackground=FIELD, font=("Segoe UI", 10))
        s.configure("TLabel", background=BG, foreground=FG)
        s.configure("Muted.TLabel", foreground=MUTED)
        s.configure("Field.TLabel", font=("Segoe UI", 10, "bold"))
        s.configure("Header.TFrame", background=PANEL)
        s.configure("Header.TLabel", background=PANEL, foreground=FG, font=("Segoe UI", 14, "bold"))
        s.configure("HeaderInfo.TLabel", background=PANEL, foreground=MUTED)
        s.configure("TEntry", foreground=FG, insertcolor=FG, bordercolor="#555", padding=6)
        s.configure("TSpinbox", foreground=FG, arrowcolor=FG, bordercolor="#555", padding=4)
        s.configure("TCombobox", foreground=FG, arrowcolor=FG, background=PANEL, bordercolor="#555", padding=4)
        s.map("TCombobox", fieldbackground=[("readonly", FIELD)], foreground=[("readonly", FG)])
        s.configure("TCheckbutton", background=BG, foreground=FG)
        s.map("TCheckbutton", background=[("active", BG)], indicatorcolor=[("selected", ACCENT)])
        s.configure("Accent.TButton", background=ACCENT, foreground="white",
                    font=("Segoe UI", 10, "bold"), padding=(16, 8), borderwidth=0)
        s.map("Accent.TButton", background=[("disabled", "#555"), ("active", "#2f78b3")])
        s.configure("TButton", background=PANEL, foreground=FG, padding=(12, 8), borderwidth=0)
        s.map("TButton", background=[("active", "#444")])
        # Lista desplegable de los combobox
        self.option_add("*TCombobox*Listbox.background", FIELD)
        self.option_add("*TCombobox*Listbox.foreground", FG)
        self.option_add("*TCombobox*Listbox.selectBackground", ACCENT)

    def _build(self):
        header = ttk.Frame(self, style="Header.TFrame", padding=(16, 12))
        header.pack(fill="x")
        ttk.Label(header, text="Nueva tarea", style="Header.TLabel").pack(anchor="w")
        self.board_label = ttk.Label(header, text="Cargando datos del proyecto...", style="HeaderInfo.TLabel")
        self.board_label.pack(anchor="w", pady=(2, 0))

        form = ttk.Frame(self, padding=16)
        form.pack(fill="both", expand=True)
        form.columnconfigure(1, weight=1)

        def label(row, text):
            ttk.Label(form, text=text, style="Field.TLabel").grid(
                row=row, column=0, sticky="ne", padx=(0, 12), pady=6)

        label(0, "Título")
        self.title_var = tk.StringVar()
        self.title_entry = ttk.Entry(form, textvariable=self.title_var)
        self.title_entry.grid(row=0, column=1, sticky="ew", pady=6)

        label(1, "Descripción")
        self.desc = tk.Text(form, height=6, wrap="word", bg=FIELD, fg=FG, insertbackground=FG,
                            relief="flat", highlightthickness=1, highlightbackground="#555",
                            highlightcolor=ACCENT, font=("Segoe UI", 10), padx=6, pady=6)
        self.desc.grid(row=1, column=1, sticky="nsew", pady=6)
        form.rowconfigure(1, weight=1)

        label(2, "Categoría")
        self.category_var = tk.StringVar()
        self.category_cb = ttk.Combobox(form, textvariable=self.category_var, state="readonly")
        self.category_cb.grid(row=2, column=1, sticky="ew", pady=6)

        label(3, "Importancia")
        self.importance_var = tk.StringVar()
        self.importance_cb = ttk.Combobox(form, textvariable=self.importance_var, state="readonly")
        self.importance_cb.grid(row=3, column=1, sticky="ew", pady=6)

        label(4, "Coste estimado")
        self.cost_var = tk.StringVar(value="0")
        ttk.Spinbox(form, from_=0, to=999, increment=1, textvariable=self.cost_var, width=8).grid(
            row=4, column=1, sticky="w", pady=6)

        label(5, "Asignar a")
        self.users_frame = ttk.Frame(form)
        self.users_frame.grid(row=5, column=1, sticky="ew", pady=6)
        ttk.Label(self.users_frame, text="Cargando...", style="Muted.TLabel").grid(row=0, column=0, sticky="w")

        bottom = ttk.Frame(self, padding=(16, 0, 16, 16))
        bottom.pack(fill="x")
        self.status = ttk.Label(bottom, text="", style="Muted.TLabel", wraplength=520, justify="left")
        self.status.pack(side="left", fill="x", expand=True)
        self.create_btn = ttk.Button(bottom, text="Crear tarea", style="Accent.TButton",
                                     command=self._create, state="disabled")
        self.create_btn.pack(side="right")
        ttk.Button(bottom, text="Limpiar", command=self._clear).pack(side="right", padx=(0, 8))

        self.bind("<Control-Return>", lambda e: self._create())
        self.title_entry.focus_set()

    # ------------------------------------------------------- hilos / datos
    def _run_in_background(self, work, on_done):
        def runner():
            try:
                self.results.put((on_done, work(), None))
            except Exception as exc:  # noqa: BLE001 - se muestra en la UI
                self.results.put((on_done, None, exc))
        threading.Thread(target=runner, daemon=True).start()

    def _poll(self):
        try:
            while True:
                on_done, result, exc = self.results.get_nowait()
                on_done(result, exc)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def _load_project_data(self):
        pid = hp.PROJECT_ID
        if not hp.API_KEY or not pid:
            raise RuntimeError("Falta HACKNPLAN_API_KEY o HACKNPLAN_PROJECT_ID en el archivo .env.")
        hp.get_design_element_id(pid, hp.DESIGN_ELEMENT_NAME)  # valida que exista "Gameplay"
        return {
            "board": hp.get_last_board(pid),
            "categories": [c["name"] for c in hp.api_get(f"/projects/{pid}/categories")],
            "importance": hp.api_get(f"/projects/{pid}/importancelevels"),
            "users": [u.get("user", u) for u in hp.api_get(f"/projects/{pid}/users")],
        }

    def _on_loaded(self, data, exc):
        if exc:
            self.board_label.configure(text="No se pudieron cargar los datos")
            self._set_status(error_text(exc), ERR)
            return

        b = data["board"]
        self.board_label.configure(
            text=f"Tablero: {b.get('name')}  ·  {fmt_date(b.get('startDate'))} → "
                 f"{fmt_date(b.get('dueDate'))}  ·  Design: {hp.DESIGN_ELEMENT_NAME}")

        cats = data["categories"]
        self.category_cb.configure(values=cats)
        self.category_var.set(hp.DEFAULT_CATEGORY if hp.DEFAULT_CATEGORY in cats else cats[0])

        levels = data["importance"]
        self.importance_cb.configure(values=[lvl["name"] for lvl in levels])
        default = next((lvl["name"] for lvl in levels if lvl.get("isDefault")), levels[0]["name"])
        self.importance_var.set(default)

        for w in self.users_frame.winfo_children():
            w.destroy()
        for i, u in enumerate(data["users"]):
            var = tk.BooleanVar()
            self.user_vars[u["username"]] = var
            ttk.Checkbutton(self.users_frame, text=u.get("name") or u["username"], variable=var).grid(
                row=i // 2, column=i % 2, sticky="w", padx=(0, 16), pady=2)

        self.create_btn.configure(state="normal")
        self._set_status("Listo. Ctrl+Enter para crear la tarea.", MUTED)

    # ------------------------------------------------------------ acciones
    def _create(self):
        if str(self.create_btn["state"]) == "disabled":
            return
        title = self.title_var.get().strip()
        if not title:
            self._set_status("El título es obligatorio.", ERR)
            self.title_entry.focus_set()
            return
        try:
            cost = float(self.cost_var.get().replace(",", ".") or 0)
        except ValueError:
            self._set_status("El coste estimado tiene que ser un número.", ERR)
            return

        kwargs = dict(
            title=title,
            category=self.category_var.get(),
            description=self.desc.get("1.0", "end").strip(),
            estimated_cost=cost,
            importance=self.importance_var.get(),
            assign=[name for name, var in self.user_vars.items() if var.get()],
        )
        self.create_btn.configure(state="disabled")
        self._set_status("Creando tarea...", MUTED)
        self._run_in_background(lambda: hp.create_task(**kwargs), self._on_created)

    def _on_created(self, task, exc):
        self.create_btn.configure(state="normal")
        if exc:
            self._set_status(error_text(exc), ERR)
            return
        self._set_status(f"✔ Tarea creada: #{task.get('workItemId')} - {task.get('title')}", OK)
        self.title_var.set("")
        self.desc.delete("1.0", "end")
        self.title_entry.focus_set()

    def _clear(self):
        self.title_var.set("")
        self.desc.delete("1.0", "end")
        self.cost_var.set("0")
        for var in self.user_vars.values():
            var.set(False)
        self._set_status("", MUTED)
        self.title_entry.focus_set()

    def _set_status(self, text, color):
        self.status.configure(text=text, foreground=color)


if __name__ == "__main__":
    App().mainloop()
