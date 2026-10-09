"""
Proves the real docx_agent.prompts module answers a genuinely
list-shaped reply as a list, not as one run-on sentence - the fix for
a question whose expected answer shape is not always an essay
paragraph, only sometimes a short list of items.

    .venv\\Scripts\\python.exe tests\\test_prompts.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from docx_agent import prompts


def main():

    problems = []

    numbered_reply = (
        "Sure, here's the answer:\n\n"
        "1. First point about the topic.\n"
        "2. Second point about the topic.\n"
        "3. Third point about the topic."
    )

    cleaned = prompts.clean_answer(numbered_reply)

    if "\n1. First point" not in ("\n" + cleaned):
        problems.append(
            "a numbered list was not kept as separate lines: "
            + repr(cleaned)
        )

    if cleaned.count("\n") < 2:
        problems.append(
            "a 3-item list collapsed onto fewer than 3 lines: "
            + repr(cleaned)
        )

    bulleted_reply = (
        "- Apples\n"
        "- Oranges\n"
        "- Pears"
    )

    cleaned_bullets = prompts.clean_answer(bulleted_reply)

    if cleaned_bullets.count("\n") < 2:
        problems.append(
            "a 3-item bullet list collapsed: " + repr(cleaned_bullets)
        )

    wrapped_prose = (
        "This is a single explanation that a chat model has\n"
        "wrapped across several lines even though it is really\n"
        "just one flowing sentence about the topic."
    )

    cleaned_prose = prompts.clean_answer(wrapped_prose)

    if "\n" in cleaned_prose:
        problems.append(
            "a wrapped prose paragraph was not rejoined into one "
            "line: " + repr(cleaned_prose)
        )

    if "wrapped across several lines" not in cleaned_prose:
        problems.append(
            "wrapped prose lost words when rejoined: "
            + repr(cleaned_prose)
        )

    filler_then_answer = "Certainly, here's the answer:\n\nThe answer is 42."

    cleaned_single = prompts.clean_answer(filler_then_answer)

    if cleaned_single != "The answer is 42.":
        problems.append(
            "chat filler was not stripped from a short answer: "
            + repr(cleaned_single)
        )

    if problems:
        print("FAILED:")
        for problem in problems:
            print("  - " + problem)
        return 1

    print(
        "a list-shaped reply stays a list, and a wrapped prose reply "
        "still becomes one flowing sentence"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
