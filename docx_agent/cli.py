"""
Command line for the Word-file agent.

    python -m docx_agent.cli check  "workbook.docx"
    python -m docx_agent.cli run    "workbook.docx" --ai claude
    python -m docx_agent.cli smoke  --ai claude

"check" reads the workbook and reports what it found, without
opening a browser and without writing anything.

"run" answers it. The answers go into a copy, "<name> - answered.docx",
so the original is never written to.

"smoke" just proves the browser side works: it asks one throwaway
question and prints the reply.
"""

import argparse
import os
import sys

from . import ask, run as runner


def profile_dir() -> str:
    """Where the signed-in browser profile is kept."""

    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")

    path = os.path.join(base, "AI Question Agent", "browser-profile")

    os.makedirs(path, exist_ok=True)

    return path


def do_check(args) -> int:

    found = runner.Run(
        args.file, args.ai, profile_dir(), report=print
    ).preview()

    print("%d question(s) in %s\n" % (
        len(found), os.path.basename(args.file)
    ))

    for question in found:

        detail = question.space_kind

        if question.grid:
            detail = "table %dx%d" % (
                len(question.grid.rows), len(question.grid.headers)
            )

        words = (
            "%d-%d words" % (question.word_min, question.word_max)
            if question.word_min else ""
        )

        print("  [%-10s] %-6s %-12s %s" % (
            question.number, question.answer_type, detail, words
        ))
        print("       " + question.text.replace("\n", " | ")[:90])

    return 0


def do_run(args) -> int:

    outcome = runner.Run(
        args.file, args.ai, profile_dir(), report=print,
        use_my_chrome=args.my_chrome,
        through_chrome=args.through_chrome,
        limit=args.limit,
    ).go()

    print("\n" + "-" * 58)
    print("answered %d of %d" % (
        outcome.answered, len(outcome.results)
    ))

    for result in outcome.failed:
        print("  not answered: %s - %s" % (result.number, result.error))

    print("saved: %s" % outcome.output_path)

    return 0 if not outcome.failed else 1


def do_smoke(args) -> int:

    session = ask.Session(
        args.ai, profile_dir(), report=print,
        use_my_chrome=getattr(args, "my_chrome", False),
    )

    try:
        session.start()
        reply = session.ask(
            "Reply with the single word: ready", timeout=120
        )
        print("\nreply: %r" % reply[:200])
        return 0 if reply.strip() else 1

    finally:
        session.close()


def main(argv=None) -> int:

    parser = argparse.ArgumentParser(
        prog="docx_agent",
        description="Answers the questions in a Word workbook.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="read it, report, write nothing")
    check.add_argument("file")
    check.add_argument("--ai", default="claude")
    check.set_defaults(func=do_check)

    go = sub.add_parser("run", help="answer it")
    go.add_argument("file")
    go.add_argument(
        "--ai", default="claude", choices=sorted(ask.PROVIDERS)
    )
    go.add_argument(
        "--my-chrome", action="store_true",
        help="open a copy of your Chrome profile",
    )
    go.add_argument(
        "--through-chrome", action="store_true",
        help="ask in the Chrome you already use, via the extension",
    )
    go.add_argument(
        "--limit", type=int, default=0,
        help="answer only the first N questions, as a trial",
    )
    go.set_defaults(func=do_run)

    smoke = sub.add_parser("smoke", help="check the browser side works")
    smoke.add_argument(
        "--ai", default="claude", choices=sorted(ask.PROVIDERS)
    )
    smoke.add_argument(
        "--my-chrome", action="store_true",
        help="use your own Chrome profile - close Chrome first",
    )
    smoke.set_defaults(func=do_smoke)

    args = parser.parse_args(argv)

    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
