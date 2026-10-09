"""
Asking the AI through the Chrome extension, in the browser you are
already signed in to.

Driving claude.ai or chatgpt.com with an automation tool does not
work any more: they see the automation and stop at a sign-in wall,
and a copied Chrome profile arrives logged out because Chrome ties
cookie encryption to the profile it was made for.

The extension has neither problem - it lives inside your ordinary
Chrome, in your ordinary session. So the agent holds a small socket
open on this computer, the extension connects to it, and questions
and answers pass between them. Nothing leaves the machine.
"""

import asyncio
import json
import threading
import time
from typing import Callable, Optional

HOST = "127.0.0.1"
PORT = 8765


class BridgeError(Exception):
    pass


class Bridge:
    """The socket the extension connects back to."""

    def __init__(self, provider: str,
                 report: Optional[Callable[[str], None]] = None):

        self.provider = provider
        self.report = report or (lambda message: None)

        self._loop = None
        self._thread = None
        self._server = None
        self._socket = None

        self._connected = threading.Event()
        self._answers = {}
        self._next_id = 0

    # -- starting and stopping -------------------------------------

    def start(self, wait_seconds: int = 60) -> None:

        import websockets                                # noqa: F401

        self._thread = threading.Thread(
            target=self._serve, daemon=True
        )
        self._thread.start()

        self.report(
            "Waiting for Chrome... open Chrome with the AI Question "
            "Agent extension installed."
        )

        if not self._connected.wait(wait_seconds):
            raise BridgeError(
                "Chrome did not connect. Make sure Chrome is open "
                "with the AI Question Agent extension installed and "
                "showing 'Active' in its popup - if you just "
                "installed or updated it, reload it once at "
                "chrome://extensions first. Then start again."
            )

        self.report("Chrome connected.")

    def _serve(self) -> None:

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        async def run():

            import websockets

            async def handler(socket):

                self._socket = socket
                self._connected.set()

                try:
                    async for raw in socket:
                        self._received(raw)
                except Exception:                       # noqa: BLE001
                    pass
                finally:
                    if self._socket is socket:
                        self._socket = None

            self._server = await websockets.serve(handler, HOST, PORT)

            await asyncio.Future()

        try:
            self._loop.run_until_complete(run())
        except Exception:                               # noqa: BLE001
            pass

    def _received(self, raw) -> None:

        try:
            message = json.loads(raw)
        except Exception:                               # noqa: BLE001
            return

        if message.get("type") == "hello":
            return

        if message.get("type") == "answer":
            self._answers[str(message.get("request_id"))] = message

    def close(self) -> None:
        """
        Shuts the socket down in the loop's own thread. Stopping the
        loop from outside leaves half-finished tasks behind, and
        Python prints a page of warnings about them as it exits -
        alarming, and entirely avoidable.
        """

        loop = self._loop

        if loop is None:
            return

        async def shutdown():

            try:
                if self._socket is not None:
                    await self._socket.close()
            except Exception:                           # noqa: BLE001
                pass

            try:
                if self._server is not None:
                    self._server.close()
                    await self._server.wait_closed()
            except Exception:                           # noqa: BLE001
                pass

        try:
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    shutdown(), loop
                ).result(timeout=5)
        except Exception:                               # noqa: BLE001
            pass

        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:                               # noqa: BLE001
            pass

        if self._thread is not None:
            self._thread.join(timeout=5)

        self._loop = None

    @property
    def connected(self) -> bool:
        return self._socket is not None


    # -- asking ----------------------------------------------------

    def ask(self, question: str, timeout: int = 300) -> str:
        """Sends one question to Chrome and waits for the answer."""

        return self._round_trip(
            {
                "type": "ask_one",
                "provider": self.provider,
                "question": question,
            },
            "answer",
            timeout,
        )

    def _round_trip(self, message: dict, field: str,
                    timeout: int) -> str:

        if self._socket is None:
            raise BridgeError("Chrome is not connected any more.")

        self._next_id += 1

        request_id = str(self._next_id)

        payload = json.dumps(dict(message, request_id=request_id))

        future = asyncio.run_coroutine_threadsafe(
            self._socket.send(payload), self._loop
        )

        future.result(timeout=30)

        until = time.time() + timeout

        while time.time() < until:

            message = self._answers.pop(request_id, None)

            if message is not None:

                if message.get("error"):
                    raise BridgeError(message["error"])

                return message.get(field, "")

            time.sleep(0.4)

        raise BridgeError("Chrome did not answer in time.")


def probe(seconds: int = 12, report=None) -> bool:
    """
    Is Chrome listening? Opens the socket briefly and sees whether
    the extension connects, so a run does not begin by waiting a
    minute for something that was never switched on.
    """

    link = Bridge("claude", report)

    try:
        link.start(wait_seconds=seconds)
        return True
    except Exception:                                   # noqa: BLE001
        return False
    finally:
        link.close()
