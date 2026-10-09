"""
Asking the AI, in a real browser window.

The agent does not use an API key. It opens a browser window, you
sign in to Claude or ChatGPT once, and from then on it types each
question into that window and reads the reply back - the same
account you would use by hand.

The profile lives in the agent's own folder, so signing in is
remembered between runs and nothing touches your everyday browser.
"""

import os
import shutil
import time
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass
class Provider:
    name: str
    url: str
    input_box: str
    reply: str
    streaming: str
    strip: str = ""


CLAUDE = Provider(
    name="Claude",
    url="https://claude.ai/new",
    input_box='div[contenteditable="true"]',
    reply="[data-is-streaming]",
    streaming='[data-is-streaming="true"]',
    strip="Claude responded:",
)

CHATGPT = Provider(
    name="ChatGPT",
    url="https://chatgpt.com/",
    input_box='#prompt-textarea, div[contenteditable="true"]',
    reply='[data-message-author-role="assistant"]',
    streaming='button[data-testid="stop-button"]',
)

GEMINI = Provider(
    name="Gemini",
    url="https://gemini.google.com/app",
    input_box='div[contenteditable="true"], rich-textarea div',
    reply="message-content, model-response",
    streaming=".response-container.is-streaming, .blue-circle",
)

PROVIDERS = {
    "claude": CLAUDE,
    "chatgpt": CHATGPT,
    "gemini": GEMINI,
}


class AskFailed(Exception):
    pass


def chrome_user_data() -> str:
    """Where Chrome keeps its profiles on this computer."""

    for base in (
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("PROGRAMFILES"),
    ):
        if not base:
            continue

        path = os.path.join(base, "Google", "Chrome", "User Data")

        if os.path.isdir(path):
            return path

    return ""


def chrome_is_running() -> bool:

    try:
        import subprocess

        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        output = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq chrome.exe"],
            capture_output=True, text=True, timeout=15,
            startupinfo=startup,
        ).stdout

        return "chrome.exe" in output

    except Exception:                                   # noqa: BLE001
        return False


"""
The parts of a Chrome profile that carry who you are signed in as.
Caches and history are left behind: they are large, they are not
needed, and copying them would only slow the first run down.
"""
SIGNED_IN_FILES = (
    "Cookies",
    "Cookies-journal",
    "Login Data",
    "Login Data For Account",
    "Web Data",
    "Preferences",
    "Secure Preferences",
    "Affiliation Database",
    "Trust Tokens",
)

SIGNED_IN_FOLDERS = (
    "Network",
    "Local Storage",
    "Session Storage",
    "IndexedDB",
    "Local Extension Settings",
    "Sync Data",
)


def borrow_chrome_profile(into: str, report=None) -> str:
    """
    Copies the signed-in parts of your everyday Chrome profile into a
    profile of the agent's own, once.

    Chrome no longer lets a program drive the profile it is running
    itself, and two programs cannot share one profile - so instead of
    asking you to close Chrome, or to sign in all over again, the
    agent takes a copy of what keeps you signed in and works from
    that. Your real Chrome is only read from, never touched.
    """

    say = report or (lambda message: None)

    source_root = chrome_user_data()

    if not source_root:
        raise AskFailed(
            "Chrome does not seem to be installed, so there is no "
            "profile to copy. Untick that box and sign in once in "
            "the agent's own window."
        )

    source = os.path.join(source_root, "Default")

    if not os.path.isdir(source):
        raise AskFailed(
            "Your Chrome profile was not found at %s." % source
        )

    target_root = os.path.join(into, "borrowed")
    target = os.path.join(target_root, "Default")

    done = os.path.join(target_root, ".copied2")

    if os.path.exists(done) and os.path.isdir(target):
        return target_root

    say("Copying your Chrome sign-in, once...")

    os.makedirs(target, exist_ok=True)

    copied = 0

    """
    "Local State" sits beside the profile, not inside it, and holds
    the key the cookies are encrypted with. Copy the cookies without
    it and Chrome makes a fresh key, cannot read them, and you land
    logged out - which is exactly what happened the first time.
    """
    for name in ("Local State", "First Run"):

        beside = os.path.join(source_root, name)

        if os.path.isfile(beside):
            try:
                shutil.copy2(beside, os.path.join(target_root, name))
                copied += 1
            except Exception:                           # noqa: BLE001
                pass

    for name in SIGNED_IN_FILES:

        one = os.path.join(source, name)

        if os.path.isfile(one):
            try:
                shutil.copy2(one, os.path.join(target, name))
                copied += 1
            except Exception:                           # noqa: BLE001
                pass

    for name in SIGNED_IN_FOLDERS:

        folder = os.path.join(source, name)

        if os.path.isdir(folder):
            try:
                shutil.copytree(
                    folder,
                    os.path.join(target, name),
                    dirs_exist_ok=True,
                    ignore_dangling_symlinks=True,
                )
                copied += 1
            except Exception:                           # noqa: BLE001
                pass

    if copied == 0:
        raise AskFailed(
            "Nothing could be copied from your Chrome profile. "
            "Close Chrome and try again, or untick that box and "
            "sign in once in the agent's own window."
        )

    with open(done, "w", encoding="utf-8") as marker:
        marker.write("copied from " + source)

    say("Copied. You should already be signed in.")

    return target_root


class Session:
    """One browser window, signed in, ready to be asked questions."""

    def __init__(self, provider_name: str, profile_dir: str,
                 report: Optional[Callable[[str], None]] = None,
                 use_my_chrome: bool = False):

        self.provider = PROVIDERS[provider_name]
        self.profile_dir = profile_dir
        self.report = report or (lambda message: None)
        self.use_my_chrome = use_my_chrome

        self._playwright = None
        self._context = None
        self.page = None

    # -- opening and closing ---------------------------------------

    def start(self, wait_for_sign_in: int = 600) -> None:

        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()

        self._context = self._launch()

        self.page = (
            self._context.pages[0] if self._context.pages
            else self._context.new_page()
        )

        self.page.set_default_timeout(60_000)

        self.report("Opening %s..." % self.provider.name)

        self.page.goto(self.provider.url, wait_until="domcontentloaded")

        self._wait_for_input(wait_for_sign_in)

    def _launch(self):
        """
        Google's own Chrome build is used when it is installed, since
        these sites are stricter with anything else. The bundled
        browser is the fallback.

        With use_my_chrome it opens a copy of your everyday Chrome
        profile, so you are signed in to everything already, and
        your own Chrome can stay open while it works.
        """

        args = ["--disable-blink-features=AutomationControlled"]

        user_data_dir = self.profile_dir

        if self.use_my_chrome:

            user_data_dir = borrow_chrome_profile(
                self.profile_dir, self.report
            )

            args.append("--profile-directory=Default")

        options = dict(
            user_data_dir=user_data_dir,
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=args,
        )

        try:
            return self._playwright.chromium.launch_persistent_context(
                channel="chrome", **options
            )
        except Exception:

            if self.use_my_chrome:
                raise

            return self._playwright.chromium.launch_persistent_context(
                **options
            )

    def _wait_for_input(self, seconds: int) -> None:
        """Waits for the message box, which appears once signed in."""

        asked = False
        until = time.time() + seconds

        while time.time() < until:

            if self._find_input() is not None:
                self.report("%s is ready." % self.provider.name)
                return

            if not asked:
                self.report(
                    "Sign in to %s in the window that opened - "
                    "waiting..." % self.provider.name
                )
                asked = True

            time.sleep(2)

        raise AskFailed(
            "%s did not become ready. Sign in, then start again."
            % self.provider.name
        )

    def _find_input(self):

        for selector in self.provider.input_box.split(","):

            box = self.page.locator(selector.strip()).last

            try:
                if box.count() and box.is_visible():
                    return box
            except Exception:
                continue

        return None

    def close(self) -> None:

        for shut in (self._context, self._playwright):
            try:
                if shut is not None:
                    shut.close() if hasattr(shut, "close") else shut.stop()
            except Exception:
                pass

        try:
            if self._playwright is not None:
                self._playwright.stop()
        except Exception:
            pass

    # -- asking ----------------------------------------------------

    def ask(self, question: str, timeout: int = 240) -> str:
        """Types a question in, waits for the whole reply, returns it."""

        box = self._find_input()

        if box is None:
            raise AskFailed(
                "The %s message box is not there. Is it still signed in?"
                % self.provider.name
            )

        before = self._replies()

        box.click()

        self.page.keyboard.insert_text(question)

        self.page.wait_for_timeout(300)

        self.page.keyboard.press("Enter")

        return self._wait_for_reply(before, timeout)

    def _replies(self) -> int:

        try:
            return self.page.locator(self.provider.reply).count()
        except Exception:
            return 0

    def _generating(self) -> bool:

        try:
            return self.page.locator(self.provider.streaming).count() > 0
        except Exception:
            return False

    def _wait_for_reply(self, before: int, timeout: int) -> str:
        """
        Done means three things at once: a new reply exists, the site
        has stopped generating, and the text has stopped changing.
        """

        until = time.time() + timeout

        last_text = ""
        last_change = time.time()

        """
        The longest reply seen since the question was sent. A
        streaming answer can briefly look finished - the stop button
        goes, the text pauses - and reading at that moment catches
        only part of it. Keeping the longest means a pause can cost
        a wait, but never a truncated answer.
        """
        best = ""

        while time.time() < until:

            self.page.wait_for_timeout(700)

            if self._replies() <= before:
                continue

            text = self._last_reply()

            if len(text) > len(best):
                best = text

            if text != last_text:
                last_text = text
                last_change = time.time()
                continue

            if self._generating():
                last_change = time.time()
                continue

            if best and time.time() - last_change >= 3.5:
                return best

        if best:
            return best

        raise AskFailed(
            "%s did not answer in time." % self.provider.name
        )

    def _last_reply(self) -> str:

        try:
            text = self.page.locator(self.provider.reply).last.inner_text()
        except Exception:
            return ""

        text = (text or "").strip()

        if self.provider.strip and text.startswith(self.provider.strip):
            text = text[len(self.provider.strip):].strip()

        return text
