"""
The socket the Chrome extension talks to.

A stand-in plays the part of the extension: it connects, waits for
"ask_one", and replies the way background.js does. So the
request-and-reply side can be proved without Chrome, which is the
half that is otherwise only ever exercised by hand.

    .venv\\Scripts\\python.exe tests\\test_bridge.py
"""

import asyncio
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import websockets                                        # noqa: E402

from docx_agent import bridge                            # noqa: E402


ASKED = []


def pretend_to_be_chrome(stop):
    """Connects back like the extension, and answers like it too."""

    async def talk():

        for _ in range(40):
            try:
                socket = await websockets.connect(
                    "ws://%s:%d" % (bridge.HOST, bridge.PORT)
                )
                break
            except Exception:                            # noqa: BLE001
                await asyncio.sleep(0.25)
        else:
            return

        async with socket:

            await socket.send(json.dumps({
                "type": "hello", "provider": "chrome-extension"
            }))

            while not stop.is_set():

                try:
                    raw = await asyncio.wait_for(socket.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                except Exception:                        # noqa: BLE001
                    return

                message = json.loads(raw)

                ASKED.append(message)

                kind = message.get("type")
                request_id = message.get("request_id")

                if kind == "ask_one":

                    question = message.get("question", "")

                    if "explode" in question:
                        await socket.send(json.dumps({
                            "type": "answer",
                            "request_id": request_id,
                            "error": "claude is not ready.",
                        }))
                    else:
                        await socket.send(json.dumps({
                            "type": "answer",
                            "request_id": request_id,
                            "answer": "answer to: " + question[:40],
                        }))

    asyncio.new_event_loop().run_until_complete(talk())


def main():

    problems = []

    said = []

    link = bridge.Bridge("chatgpt", said.append)

    stop = threading.Event()

    chrome = threading.Thread(
        target=pretend_to_be_chrome, args=(stop,), daemon=True
    )

    try:

        # The stand-in has to be waiting before the bridge blocks on
        # it: it retries the connection until the socket is up.
        chrome.start()

        link.start(wait_seconds=25)

        deadline = time.time() + 20

        while link._socket is None and time.time() < deadline:
            time.sleep(0.2)

        if link._socket is None:
            print("FAILED: the stand-in never connected")
            return 1

        print("connected")

        # 1. a question and its answer
        answer = link.ask("What is a SWMS?", timeout=20)
        print("  ask  -> %r" % answer)

        if answer != "answer to: What is a SWMS?":
            problems.append("the answer did not come back intact")

        # 2. an error from the browser must surface, not hang
        try:
            link.ask("please explode", timeout=20)
            problems.append("an error from Chrome was swallowed")
        except bridge.BridgeError as error:
            print("  error surfaced -> %s" % error)

        # 3. every request carried its own id, and they differ
        ids = [m.get("request_id") for m in ASKED]

        if len(set(ids)) != len(ids):
            problems.append("request ids were reused: %s" % ids)

        kinds = [m.get("type") for m in ASKED]

        if kinds != ["ask_one", "ask_one"]:
            problems.append("unexpected traffic: %s" % kinds)

    finally:
        stop.set()
        link.close()

    if problems:
        print("\nFAILED:")
        for problem in problems:
            print("  - " + problem)
        return 1

    print("\nthe bridge carries questions and errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
