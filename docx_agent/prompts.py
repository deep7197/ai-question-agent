"""
Turning a question from the workbook into something worth asking,
and turning the reply into something worth writing down.

A chat model answers conversationally by default - markdown, bullet
points, "Certainly! Here's..." - none of which belongs in a written
assessment. So the prompt asks for prose, and the reply is cleaned
before it goes anywhere near the document.
"""

import re


FILLER = re.compile(
    r"^(certainly|sure|of course|absolutely|great question|"
    r"here(?:'s| is| are)\b|i hope this helps|hope that helps|"
    r"let me know if|would you like me to|feel free to ask)",
    re.I,
)

STYLE = (
    "Read the question and answer in whatever shape it actually "
    "calls for - a short phrase or one sentence for a direct "
    "factual question, a list only if the question itself asks you "
    "to list, name or identify more than one thing, a full "
    "explanatory answer for one that asks you to explain, describe, "
    "discuss, compare or evaluate. Whichever it is, write it in "
    "plain text, Australian English - no headings, no bold text, no "
    "markdown. Do not restate the question, and do not add any "
    "opening or closing remarks - give the answer only."
)

LIST_LINE = re.compile(r"^(?:[-*•]|\d+[.)])\s+")


def for_question(question) -> str:
    """The prompt for one written question."""

    parts = []

    if question.context:
        parts.append("Background:\n" + question.context)

    heading = (
        "Question " + question.number
        if re.match(r"^[0-9(]", str(question.number))
        else str(question.number)
    )

    parts.append(heading + ". " + question.text)

    if question.answer_type == "yesno":
        parts.append(
            "Answer with one word only - either Yes or No. Do not "
            "explain and do not add anything else."
        )
        return "\n\n".join(parts)

    if question.word_min and question.word_max:
        parts.append(
            "Answer in %d-%d words. Stay inside that range."
            % (question.word_min, question.word_max)
        )

    parts.append(STYLE)

    return "\n\n".join(parts)


def for_grid(question, rows) -> str:
    """The prompt for a batch of rows of a table question."""

    headers = question.grid.headers

    parts = []

    if question.context:
        parts.append("Background:\n" + question.context)

    parts.append("Question " + str(question.number) + ". " + question.text)

    parts.append(
        "Answer for each item below, covering every column: "
        + ", ".join(headers) + "."
    )

    parts.append(
        "Reply with one line per item and nothing else, in exactly "
        "this format:\nitem | "
        + " | ".join(head + ": your answer" for head in headers)
    )

    parts.append("Items:\n" + "\n".join(rows))

    limit = (
        "Keep each column to %d-%d words." % (
            question.word_min, question.word_max
        )
        if question.word_min else
        "Keep each column to one or two plain sentences."
    )

    parts.append(
        limit + " Australian English, no markdown, no bullet points, "
        "and do not add any other lines."
    )

    return "\n\n".join(parts)


def row_key(text: str) -> str:
    """"1. Cements" and "Cements" name the same row."""

    return re.sub(
        r"[^a-z0-9]", "",
        re.sub(r"^[\s(]*[0-9]+[.)]?\s*", "", str(text or "").lower()),
    )


def parse_grid(reply: str, rows, headers) -> dict:
    """
    Splits "1. Cements | Properties: ... | Applications: ..." back
    into cells. Anything that cannot be matched to a row is dropped,
    so a stray line never lands in the wrong place.
    """

    wanted = {row_key(row): row for row in rows}

    found = {}

    for line in (reply or "").splitlines():

        clean = re.sub(r"^\s*[-*•]\s*", "", line).strip()

        if "|" not in clean:
            continue

        parts = [part.strip() for part in clean.split("|")]

        key = row_key(parts[0])

        if key not in wanted or key in found:
            continue

        cells = []

        for at, head in enumerate(headers):

            raw = parts[at + 1] if at + 1 < len(parts) else ""

            cells.append(clean_answer(
                re.sub(
                    r"^\s*" + re.escape(head) + r"\s*[:\-]\s*", "", raw,
                    flags=re.I,
                )
            ))

        if any(cells):
            found[key] = cells

    return found


def as_yes_no(text: str) -> str:

    match = re.search(r"\b(yes|no)\b", text or "", re.I)

    if not match:
        return ""

    return "Yes" if match.group(1).lower() == "yes" else "No"


def clean_answer(text: str) -> str:
    """Strips the chat out of a chat reply."""

    if not text:
        return ""

    out = text

    out = re.sub(r"```[a-z]*\n?", "", out, flags=re.I)
    out = out.replace("`", "")

    out = re.sub(r"\*\*(.+?)\*\*", r"\1", out)
    out = re.sub(r"__(.+?)__", r"\1", out)
    out = re.sub(r"(^|\s)\*(\S[^*]*?)\*(?=\s|$)", r"\1\2", out)
    out = re.sub(r"^#{1,6}\s*", "", out, flags=re.M)
    out = re.sub(r"^\s*([-*_]\s*){3,}$", "", out, flags=re.M)

    paragraphs = []

    for part in re.split(r"\n\s*\n+", out):

        lines = [line.strip() for line in part.splitlines()]
        lines = [line for line in lines if line and not FILLER.match(line)]

        if not lines:
            continue

        """
        A question that asks to list, name or identify several
        things is genuinely answered as a list - joining its lines
        into one run-on sentence, which is right for a wrapped
        paragraph, would instead ruin it. So a paragraph that is
        mostly list lines keeps its line breaks and its markers;
        anything else is still joined into flowing prose.
        """
        marked = sum(1 for line in lines if LIST_LINE.match(line))

        if marked >= 2 and marked >= len(lines) - 1:
            paragraphs.append("\n".join(lines))
            continue

        stripped = [
            re.sub(r"^\d+[.)]\s+", "", re.sub(r"^[-*•]\s+", "", line))
            for line in lines
        ]

        joined = re.sub(r"[ \t]{2,}", " ", " ".join(stripped)).strip()

        if joined:
            paragraphs.append(joined)

    return "\n\n".join(paragraphs).strip()


def word_count(text: str) -> int:
    return len([word for word in re.split(r"\s+", text or "") if word])
