"""
AI Question Agent - the window.

Pick a Word workbook, pick which AI to use, press Start. Each
question is asked in turn and each answer is written into the space
the document leaves for it. The answers go into a copy, so the file
you picked is never changed.

Every rounded shape here is hand-drawn on a Canvas: tkinter's own
widgets are always square-cornered, and a canvas rounded rectangle
plus a soft offset shadow is the difference between a window that
looks like a stock dialog box and one that looks designed.
"""

import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import filedialog, font as tkfont

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from docx_agent import run as runner                 # noqa: E402


APP_NAME = "AI Question Agent"

# -- palette -----------------------------------------------------------
#
# One accent runs through the badges, the selected state of every
# toggle, and the primary button, so the eye has a single thread to
# follow through the window.

BG_APP = "#f2f1fb"
BG_CARD = "#ffffff"

INK = "#1e1b3a"
MUTED = "#716d94"
FAINT = "#b7b3d6"

ACCENT = "#6d28d9"
ACCENT_2 = "#4f46e5"
ACCENT_DARK = "#5b21b6"
ACCENT_SOFT = "#f1edfd"

GOOD = "#059669"
GOOD_BG = "#d1fae5"
BAD = "#dc2626"
BAD_BG = "#fee2e2"
NEUTRAL = "#efedf9"
NEUTRAL_HOVER = "#e3dff7"

REQUIRED_BG = "#fff1e6"
REQUIRED_FG = "#c2410c"

SHADOW = "#d9d6ee"


def profile_dir() -> str:

    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")

    path = os.path.join(base, APP_NAME, "browser-profile")

    os.makedirs(path, exist_ok=True)

    return path


# -- drawing helpers -----------------------------------------------------

def _round_points(x1, y1, x2, y2, r):

    r = min(r, (x2 - x1) / 2, (y2 - y1) / 2)

    return [
        x1 + r, y1,
        x2 - r, y1,
        x2, y1,
        x2, y1 + r,
        x2, y2 - r,
        x2, y2,
        x2 - r, y2,
        x1 + r, y2,
        x1, y2,
        x1, y2 - r,
        x1, y1 + r,
        x1, y1,
    ]


def round_rect(canvas, x1, y1, x2, y2, radius, **kwargs):

    return canvas.create_polygon(
        _round_points(x1, y1, x2, y2, radius),
        smooth=True, **kwargs
    )


class RoundedPanel:
    """
    A card: a soft shadow behind a rounded white rectangle, with an
    ordinary Frame laid on top to hold real widgets. The canvas
    tracks the frame's own requested height, so normal pack/grid
    layout inside it still works exactly as it would in a plain
    Frame.
    """

    def __init__(self, parent, bg_page=BG_APP, fill=BG_CARD,
                 radius=16, shadow=True, border=None):

        self.fill = fill
        self.radius = radius
        self.shadow = shadow
        self.border = border

        self.canvas = tk.Canvas(
            parent, bg=bg_page, highlightthickness=0, bd=0,
        )

        self.body = tk.Frame(self.canvas, bg=fill)

        self._window = self.canvas.create_window(
            (6, 4), window=self.body, anchor="nw"
        )

        self.body.bind("<Configure>", self._on_body_resize)
        self.canvas.bind("<Configure>", self._on_canvas_resize)

    def _on_body_resize(self, _event=None):

        width = self.body.winfo_reqwidth()
        height = self.body.winfo_reqheight()

        self.canvas.configure(height=height + 10)

        self._redraw(width, height)

    def _on_canvas_resize(self, event):

        inner_width = max(event.width - 12, 1)

        self.canvas.itemconfigure(self._window, width=inner_width)

        self.body.update_idletasks()

        self._redraw(inner_width, self.body.winfo_reqheight())

    def _redraw(self, width, height):

        self.canvas.delete("shape")

        x2 = width + 6
        y2 = height + 4

        if self.shadow:

            round_rect(
                self.canvas, 4, 6, x2 + 2, y2 + 6, self.radius,
                fill=SHADOW, outline="", tags="shape",
            )

        round_rect(
            self.canvas, 2, 2, x2, y2, self.radius,
            fill=self.fill,
            outline=self.border or "", width=1,
            tags="shape",
        )

        self.canvas.tag_lower("shape")
        self.canvas.tag_raise(self._window)

        self.canvas.configure(height=y2 + 6)

    def pack(self, **kwargs):
        self.canvas.pack(**kwargs)


class RoundedButton:
    """
    A pill-shaped button, drawn on its own small canvas. tkinter's
    real Button is always a rectangle with square corners; this is
    the shape that actually reads as a button in a modern interface.
    """

    def __init__(self, parent, text, command, font, primary=False,
                 danger=False, bg_page=BG_CARD, width=None, small=False):

        self.command = command
        self.text = text
        self.font = font
        self.primary = primary
        self.state = "normal"
        self.small = small

        if danger:
            self.fill = NEUTRAL
            self.fg = BAD
            self.hover_fill = BAD_BG
        else:
            self.fill = ACCENT if primary else NEUTRAL
            self.fg = "white" if primary else INK
            self.hover_fill = ACCENT_DARK if primary else NEUTRAL_HOVER

        self.disabled_fill = "#e3e1f0"
        self.disabled_fg = "#a8a4c8"

        pad_x = 14 if small else 20
        pad_y = 8 if small else 12

        text_w = font.measure(text)

        self.w = width or (text_w + pad_x * 2)
        self.h = font.metrics("linespace") + pad_y * 2

        self.canvas = tk.Canvas(
            parent, width=self.w, height=self.h, bg=bg_page,
            highlightthickness=0, bd=0, cursor="hand2",
        )

        self._shape = round_rect(
            self.canvas, 1, 1, self.w - 1, self.h - 1, self.h / 2,
            fill=self.fill, outline="",
        )
        self._label = self.canvas.create_text(
            self.w / 2, self.h / 2, text=text, fill=self.fg,
            font=font,
        )

        self.canvas.tag_bind(self._shape, "<Enter>", self._enter)
        self.canvas.tag_bind(self._label, "<Enter>", self._enter)
        self.canvas.tag_bind(self._shape, "<Leave>", self._leave)
        self.canvas.tag_bind(self._label, "<Leave>", self._leave)
        self.canvas.tag_bind(self._shape, "<Button-1>", self._click)
        self.canvas.tag_bind(self._label, "<Button-1>", self._click)

    def _enter(self, _event):

        if self.state == "disabled":
            return

        self.canvas.itemconfigure(self._shape, fill=self.hover_fill)

    def _leave(self, _event):

        if self.state == "disabled":
            return

        self.canvas.itemconfigure(self._shape, fill=self.fill)

    def _click(self, _event):

        if self.state == "disabled":
            return

        if self.command:
            self.command()

    def configure(self, state=None):

        if state is None:
            return

        self.state = state

        if state == "disabled":

            self.canvas.configure(cursor="arrow")
            self.canvas.itemconfigure(self._shape, fill=self.disabled_fill)
            self.canvas.itemconfigure(self._label, fill=self.disabled_fg)

        else:

            self.canvas.configure(cursor="hand2")
            self.canvas.itemconfigure(self._shape, fill=self.fill)
            self.canvas.itemconfigure(self._label, fill=self.fg)

    def pack(self, **kwargs):
        self.canvas.pack(**kwargs)


class Segmented:
    """
    A pill-shaped segmented control - the rounded-button equivalent
    of a row of radio buttons, sitting on a slightly recessed track
    so the selected option reads as "raised" above it.
    """

    def __init__(self, parent, variable, options, font, bg=BG_CARD):

        self.variable = variable
        self.font = font
        self.bg = bg
        self.pill_h = font.metrics("linespace") + 18

        widths = [font.measure(label) + 32 for _, label in options]

        total_w = sum(widths) + 6 * (len(options) + 1)

        self.canvas = tk.Canvas(
            parent, width=total_w, height=self.pill_h + 6, bg=bg,
            highlightthickness=0, bd=0,
        )

        round_rect(
            self.canvas, 0, 0, total_w, self.pill_h + 6,
            (self.pill_h + 6) / 2, fill=NEUTRAL, outline="",
        )

        self.shapes = {}
        self.labels = {}

        x = 3

        for (value, label), width in zip(options, widths):

            shape = round_rect(
                self.canvas, x, 3, x + width, 3 + self.pill_h,
                self.pill_h / 2, fill=NEUTRAL, outline="",
            )
            text = self.canvas.create_text(
                x + width / 2, 3 + self.pill_h / 2, text=label,
                font=font, fill=INK,
            )

            for item in (shape, text):

                self.canvas.tag_bind(
                    item, "<Button-1>",
                    lambda _e, v=value: self.select(v),
                )
                self.canvas.tag_bind(item, "<Enter>", lambda _e: self.canvas.configure(cursor="hand2"))

            self.shapes[value] = shape
            self.labels[value] = text

            x += width + 6

        self._paint()

    def select(self, value):

        if getattr(self, "_disabled", False):
            return

        self.variable.set(value)
        self._paint()

    def _paint(self):

        current = self.variable.get()

        for value, shape in self.shapes.items():

            selected = value == current

            self.canvas.itemconfigure(
                shape, fill=ACCENT if selected else NEUTRAL,
            )
            self.canvas.itemconfigure(
                self.labels[value],
                fill="white" if selected else INK,
            )

    def pack(self, **kwargs):
        self.canvas.pack(**kwargs)

    def configure(self, state="normal"):

        self._disabled = state == "disabled"

        self.canvas.configure(cursor="arrow" if self._disabled else "")


class App:

    def __init__(self):

        self.messages = queue.Queue()
        self.worker = None
        self.stopping = False
        self.output = ""

        self.window = tk.Tk()
        self.window.title(APP_NAME)
        self.window.configure(bg=BG_APP)
        self.window.minsize(740, 560)
        self.window.geometry("800x760")

        try:
            self.window.iconbitmap(self._bundled("app.ico"))
        except Exception:                               # noqa: BLE001
            pass

        self._build()
        self._poll()

    @staticmethod
    def _bundled(name):
        base = getattr(
            sys, "_MEIPASS",
            os.path.dirname(os.path.abspath(__file__)),
        )
        return os.path.join(base, name)

    # -- small building blocks ---------------------------------------

    def _card(self, parent, number=None, title=None, chip=None):

        panel = RoundedPanel(parent, bg_page=BG_APP)
        panel.pack(fill="x", pady=(0, 14))

        inner = tk.Frame(panel.body, bg=BG_CARD, padx=20, pady=16)
        inner.pack(fill="both", expand=True)

        if number is not None:

            head = tk.Frame(inner, bg=BG_CARD)
            head.pack(fill="x", pady=(0, 12))

            self._badge(head, number).pack(side="left")

            tk.Label(
                head, text=title, font=self.label_font, bg=BG_CARD,
                fg=INK, anchor="w",
            ).pack(side="left", padx=(10, 0))

            if chip:

                chip_canvas = tk.Canvas(
                    head, height=20, bg=BG_CARD, highlightthickness=0,
                )
                width = self.chip_font.measure(chip) + 20
                chip_canvas.configure(width=width)
                round_rect(
                    chip_canvas, 0, 0, width, 20, 10,
                    fill=REQUIRED_BG, outline="",
                )
                chip_canvas.create_text(
                    width / 2, 10, text=chip, font=self.chip_font,
                    fill=REQUIRED_FG,
                )
                chip_canvas.pack(side="left", padx=(10, 0))

        return inner

    def _badge(self, parent, number):

        size = 26

        canvas = tk.Canvas(
            parent, width=size, height=size, bg=BG_CARD,
            highlightthickness=0,
        )

        canvas.create_oval(
            1, 1, size - 1, size - 1, fill=ACCENT_2, outline=""
        )
        canvas.create_text(
            size / 2, size / 2 + 1, text=str(number),
            fill="white", font=self.badge_font,
        )

        return canvas

    def _entry(self, parent, variable):

        panel = RoundedPanel(parent, bg_page=BG_CARD, fill="white",
                              radius=10, shadow=False, border=FAINT)
        panel.pack(fill="x", pady=(0, 4))

        entry = tk.Entry(
            panel.body, textvariable=variable, font=self.body_font,
            relief="flat", bd=0, bg="white", fg=INK,
            insertbackground=INK,
        )
        entry.pack(fill="x", ipady=9, padx=14, pady=1)

        return entry

    def _helper(self, parent, text, pady=(0, 0)):

        tk.Label(
            parent, text=text, font=self.small_font, bg=BG_CARD,
            fg=MUTED, anchor="w", wraplength=660, justify="left",
        ).pack(fill="x", pady=pady)

    def _bind_wheel(self, widget, handler):

        widget.bind("<MouseWheel>", handler)

        for child in widget.winfo_children():
            self._bind_wheel(child, handler)

    def _button(self, parent, text, command, primary=False,
                danger=False, bg_page=BG_APP):

        return RoundedButton(
            parent, text, command, self.button_font_bold if primary
            else self.button_font, primary=primary, danger=danger,
            bg_page=bg_page,
        )

    # -- the window ----------------------------------------------------

    def _build(self):

        self.title_font = tkfont.Font(family="Segoe UI", size=18, weight="bold")
        self.subtitle_font = tkfont.Font(family="Segoe UI", size=10)
        self.label_font = tkfont.Font(family="Segoe UI", size=11, weight="bold")
        self.body_font = tkfont.Font(family="Segoe UI", size=10)
        self.small_font = tkfont.Font(family="Segoe UI", size=9)
        self.chip_font = tkfont.Font(family="Segoe UI", size=8, weight="bold")
        self.badge_font = tkfont.Font(family="Segoe UI", size=10, weight="bold")
        self.button_font = tkfont.Font(family="Segoe UI", size=10)
        self.button_font_bold = tkfont.Font(family="Segoe UI", size=10, weight="bold")
        self.log_font = tkfont.Font(family="Consolas", size=9)

        # --- header: a soft diagonal gradient -----------------------

        header = tk.Canvas(self.window, height=92, highlightthickness=0, bd=0)
        header.pack(fill="x")

        self._paint_gradient(header, ACCENT, ACCENT_2)
        header.bind(
            "<Configure>",
            lambda e: self._paint_gradient(header, ACCENT, ACCENT_2, e.width),
        )

        header.create_text(
            26, 32, text=APP_NAME, font=self.title_font, fill="white",
            anchor="w",
        )
        header.create_text(
            26, 62,
            text=("Answers the questions in a Word workbook and writes "
                  "each answer into the space under its own question."),
            font=self.subtitle_font, fill="#e6e1fb", anchor="w",
        )

        # --- the window's two zones -----------------------------------
        #
        # The setup cards can add up to more than a small screen's
        # height, so they live in a scrolling area; the controls that
        # matter throughout a run - Start, Stop, status, the log -
        # sit in a footer that is always on screen no matter the size.

        body_outer = tk.Frame(self.window, bg=BG_APP)
        body_outer.pack(fill="both", expand=True)

        footer = tk.Frame(body_outer, bg=BG_APP, padx=24, pady=12)
        footer.pack(side="bottom", fill="x")

        scroll_area = tk.Frame(body_outer, bg=BG_APP)
        scroll_area.pack(side="top", fill="both", expand=True)

        canvas = tk.Canvas(scroll_area, bg=BG_APP, highlightthickness=0)
        scrollbar = tk.Scrollbar(
            scroll_area, orient="vertical", command=canvas.yview,
        )
        canvas.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)

        frame = tk.Frame(canvas, bg=BG_APP, padx=24, pady=14)

        window_id = canvas.create_window((0, 0), window=frame, anchor="nw")

        frame.bind(
            "<Configure>",
            lambda _e: canvas.configure(scrollregion=canvas.bbox("all")),
        )
        canvas.bind(
            "<Configure>",
            lambda e: canvas.itemconfigure(window_id, width=e.width),
        )

        def on_wheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        # --- 1. the file --------------------------------------------

        card1 = self._card(frame, 1, "Your workbook")

        row = tk.Frame(card1, bg=BG_CARD)
        row.pack(fill="x")

        self.file_var = tk.StringVar(value="")

        entry_panel = RoundedPanel(row, bg_page=BG_CARD, fill="white",
                                    radius=10, shadow=False, border=FAINT)
        entry_panel.pack(side="left", fill="x", expand=True)

        self.file_box = tk.Entry(
            entry_panel.body, textvariable=self.file_var,
            font=self.body_font, relief="flat", bd=0, bg="white",
            fg=INK, insertbackground=INK,
        )
        self.file_box.pack(fill="x", ipady=9, padx=14, pady=1)

        tk.Frame(row, width=10, bg=BG_CARD).pack(side="left")

        self._button(
            row, "Choose .docx", self.choose_file, bg_page=BG_CARD,
        ).pack(side="left")

        # --- 2. the AI ------------------------------------------------

        card2 = self._card(frame, 2, "Which AI to use")

        self.ai_var = tk.StringVar(value="chatgpt")

        Segmented(
            card2, self.ai_var,
            [("chatgpt", "ChatGPT"), ("claude", "Claude"),
             ("gemini", "Gemini")],
            self.body_font,
        ).pack(anchor="w", pady=(0, 12))

        tk.Frame(card2, bg="#efedf9", height=1).pack(fill="x", pady=(0, 12))

        tk.Label(
            card2, text="How the agent reaches it", font=self.body_font,
            bg=BG_CARD, fg=INK, anchor="w",
        ).pack(fill="x", pady=(0, 8))

        self.how = tk.StringVar(value="extension")

        self.how_toggle = Segmented(
            card2, self.how,
            [("extension", "My Chrome, already signed in"),
             ("own", "A browser of its own")],
            self.body_font,
        )
        self.how_toggle.pack(anchor="w", pady=(0, 10))

        self._helper(
            card2,
            "My Chrome: the extension does the asking in the browser "
            "you already have open - just have it installed and "
            "running. A browser of its own: signs in once and "
            "remembers you after that.",
        )

        self._bind_wheel(frame, on_wheel)
        canvas.bind("<MouseWheel>", on_wheel)

        # --- buttons --------------------------------------------------

        buttons = tk.Frame(footer, bg=BG_APP)
        buttons.pack(fill="x", pady=(2, 12))

        self.start_button = self._button(
            buttons, "▶  Start", self.start, primary=True
        )
        self.start_button.pack(side="left")

        tk.Frame(buttons, width=10, bg=BG_APP).pack(side="left")

        self.check_button = self._button(
            buttons, "Check the document first", self.check
        )
        self.check_button.pack(side="left")

        tk.Frame(buttons, width=10, bg=BG_APP).pack(side="left")

        self.link_button = self._button(
            buttons, "Test Chrome link", self.test_link
        )
        self.link_button.pack(side="left")

        tk.Frame(buttons, width=10, bg=BG_APP).pack(side="left")

        self.stop_button = self._button(buttons, "Stop", self.stop)
        self.stop_button.pack(side="left")
        self.stop_button.configure(state="disabled")

        tk.Frame(buttons, width=10, bg=BG_APP).pack(side="left")

        self.reset_button = self._button(
            buttons, "Reset", self.reset, danger=True
        )
        self.reset_button.pack(side="left")

        self.open_button = self._button(
            buttons, "Open the answered file", self.open_output
        )
        self.open_button.pack(side="right")
        self.open_button.configure(state="disabled")

        # --- status pill ------------------------------------------------

        self.status_panel = RoundedPanel(
            footer, bg_page=BG_APP, fill=NEUTRAL, radius=20, shadow=False,
        )

        status_inner = tk.Frame(self.status_panel.body, bg=NEUTRAL, padx=14, pady=10)
        status_inner.pack(fill="x")

        self.status_dot = tk.Canvas(
            status_inner, width=10, height=10, bg=NEUTRAL,
            highlightthickness=0,
        )
        self.status_dot.pack(side="left", pady=1)
        self._dot_id = self.status_dot.create_oval(
            1, 1, 9, 9, fill=FAINT, outline="",
        )

        self.status_label = tk.Label(
            status_inner, text="", font=self.label_font, bg=NEUTRAL,
            fg=INK, anchor="w", wraplength=640, justify="left",
        )
        self.status_label.pack(side="left", padx=(8, 0))

        self._status_tint = NEUTRAL

        # --- the log ------------------------------------------------

        tk.Label(
            footer, text="Progress", font=self.label_font, bg=BG_APP,
            fg=INK, anchor="w",
        ).pack(fill="x", pady=(6, 6))

        log_panel = RoundedPanel(
            footer, bg_page=BG_APP, fill="#faf9ff", radius=14,
            shadow=False, border="#e5e2f5",
        )
        log_panel.pack(fill="both", expand=True)

        log_row = tk.Frame(log_panel.body, bg="#faf9ff")
        log_row.pack(fill="both", expand=True, padx=4, pady=4)

        self.log = tk.Text(
            log_row, font=self.log_font, bg="#faf9ff", fg=INK,
            relief="flat", bd=0, wrap="word", height=7, padx=10,
            pady=8,
        )
        self.log.pack(side="left", fill="both", expand=True)

        bar = tk.Scrollbar(log_row, command=self.log.yview)
        bar.pack(side="right", fill="y")

        self.log.configure(yscrollcommand=bar.set, state="disabled")

    @staticmethod
    def _paint_gradient(canvas, start, end, width=None):

        canvas.delete("gradient")

        width = width or canvas.winfo_width() or 800
        height = int(canvas["height"])

        r1, g1, b1 = canvas.winfo_rgb(start)
        r2, g2, b2 = canvas.winfo_rgb(end)

        steps = max(width, 1)

        for i in range(steps):

            t = i / steps

            r = int(r1 + (r2 - r1) * t) >> 8
            g = int(g1 + (g2 - g1) * t) >> 8
            b = int(b1 + (b2 - b1) * t) >> 8

            colour = "#%02x%02x%02x" % (r, g, b)

            canvas.create_line(
                i, 0, i, height, fill=colour, tags="gradient",
            )

        canvas.tag_lower("gradient")

    # -- talking to the window -------------------------------------

    def say(self, text):
        self.messages.put(("log", text))

    def _poll(self):

        while True:
            try:
                kind, value = self.messages.get_nowait()
            except queue.Empty:
                break

            if kind == "log":
                self._write(value)
            elif kind == "status":
                self._set_status(value[0], value[1])
            elif kind == "done":
                self._finished(value)

        self.window.after(120, self._poll)

    def _write(self, text):

        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_status(self, text, colour):

        tint = {GOOD: GOOD_BG, BAD: BAD_BG}.get(colour, NEUTRAL)

        self.status_panel.fill = tint
        self.status_panel._redraw(
            self.status_panel.body.winfo_reqwidth(),
            self.status_panel.body.winfo_reqheight(),
        )

        for widget in (self.status_panel.body, self.status_dot,
                       self.status_label):
            widget.configure(bg=tint)

        for child in self.status_panel.body.winfo_children():
            child.configure(bg=tint)

        self.status_dot.itemconfigure(self._dot_id, fill=colour)
        self.status_label.configure(text=text, fg=colour)

    def _busy(self, busy):

        state = "disabled" if busy else "normal"

        self.start_button.configure(state=state)
        self.check_button.configure(state=state)
        self.link_button.configure(state=state)
        self.how_toggle.configure(state=state)
        self.reset_button.configure(state=state)
        self.stop_button.configure(state="normal" if busy else "disabled")

    # -- what the buttons do ---------------------------------------

    def choose_file(self):

        chosen = filedialog.askopenfilename(
            title="Choose your workbook",
            filetypes=[("Word documents", "*.docx"), ("All files", "*.*")],
        )

        if chosen:
            self.file_var.set(chosen)

    def _file(self):

        path = self.file_var.get().strip().strip('"')

        if not path:
            self.messages.put((
                "status", ("Choose your workbook first.", BAD)
            ))
            return None

        if not os.path.exists(path):
            self.messages.put((
                "status", ("That file does not exist.", BAD)
            ))
            return None

        return path

    def check(self):

        path = self._file()

        if not path:
            return

        self._busy(True)

        def work():

            try:

                found = runner.Run(
                    path, self.ai_var.get(), profile_dir(), self.say
                ).preview()

                self.say("Found %d question(s):\n" % len(found))

                spaces = 0

                for question in found:

                    where = {
                        "box": "into the box under it",
                        "line": "on the blank line under it",
                        "table": "into its table",
                        "none": "directly under the question",
                    }.get(question.space_kind, question.space_kind)

                    if question.space_kind != "none":
                        spaces += 1

                    wants = question.answer_type
                    if question.grid:
                        wants = "table %dx%d" % (
                            len(question.grid.rows),
                            len(question.grid.headers),
                        )
                    elif question.word_min:
                        wants = "%d-%d words" % (
                            question.word_min, question.word_max
                        )

                    self.say("  %-10s %-16s %s" % (
                        question.number, wants, where
                    ))

                self.messages.put((
                    "status",
                    ("%d question(s). %d have a space of their own; "
                     "the rest go directly under the question."
                     % (len(found), spaces), GOOD),
                ))

            except Exception as error:                  # noqa: BLE001
                self.messages.put(("status", (str(error), BAD)))

            finally:
                self.messages.put(("done", None))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def test_link(self):
        """
        Is the extension there and switched on? Worth knowing before
        a run, rather than a minute into one.
        """

        self._busy(True)

        self.messages.put((
            "status", ("Waiting for Chrome...", MUTED)
        ))

        def work():

            from docx_agent import bridge

            self.say("Checking whether Chrome is listening...")

            if bridge.probe(12, self.say):

                self.messages.put((
                    "status",
                    ("Chrome is connected - ready to run.", GOOD),
                ))

            else:

                self.messages.put((
                    "status",
                    ("Chrome is not connected. Make sure the AI "
                     "Question Agent extension is installed and "
                     "showing 'Active' in its popup, then try again.",
                     BAD),
                ))

            self.messages.put(("done", None))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def start(self):

        path = self._file()

        if not path:
            return

        self.stopping = False
        self._busy(True)
        self.open_button.configure(state="disabled")

        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

        self.messages.put(("status", ("Working...", MUTED)))

        def work():

            try:

                outcome = runner.Run(
                    path,
                    self.ai_var.get(),
                    profile_dir(),
                    self.say,
                    lambda: self.stopping,
                    through_chrome=self.how.get() == "extension",
                ).go()

                self.output = outcome.output_path

                summary = "Answered %d of %d." % (
                    outcome.answered, len(outcome.results)
                )

                if outcome.stopped:
                    summary = "Stopped. " + summary

                if outcome.failed:
                    summary += "  Not answered: " + ", ".join(
                        result.number for result in outcome.failed
                    )

                self.say("\n" + summary)
                self.say("Saved: " + outcome.output_path)

                self.messages.put((
                    "status",
                    (summary, BAD if outcome.failed else GOOD),
                ))

            except Exception as error:                  # noqa: BLE001
                self.say("\nStopped: " + str(error))
                self.messages.put(("status", (str(error), BAD)))

            finally:
                self.messages.put(("done", None))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def stop(self):

        self.stopping = True
        self.say("Stopping after this question...")

    def reset(self):
        """
        Clears the last run - its log, its status, the answered file
        it points at - so Start begins fresh. The workbook and the AI
        are left alone: those are settings, not part of a run, the
        same distinction the browser
        extension's own Reset makes.
        """

        self.stopping = True

        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

        self.output = ""

        self.open_button.configure(state="disabled")

        self._busy(False)

        self._set_status("Cleared. Press Start for a fresh run.", MUTED)

    def open_output(self):

        if self.output and os.path.exists(self.output):
            os.startfile(self.output)              # noqa: S606

    def _finished(self, _value):

        self._busy(False)

        if self.output and os.path.exists(self.output):
            self.open_button.configure(state="normal")

    def go(self):
        self.window.mainloop()


def main():
    App().go()


if __name__ == "__main__":
    main()
