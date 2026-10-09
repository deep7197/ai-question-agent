"""
Finding the questions in a workbook, and the space each one leaves
for its answer.

These are the same rules the Chrome extension uses, which were
worked out against real assessment workbooks: headings of every
shape, case studies that introduce their parts, word counts, Yes/No
questions, tables to fill in, and the assessor's marking lines,
which are never written into.
"""

import re
from dataclasses import dataclass, field
from typing import List, Optional

from .document import Block, Grid


"""
The subpart letter is written either in parentheses ("Question 2(a)")
or run straight onto the number ("Question 3a."). Without the
lookahead on the bare form, "Question 3 and 4" would read as subpart
"a" of question 3, cut out of the middle of the word "and".
"""
QUESTION_LINE = re.compile(
    r"^(?:questions?|ques|q)\s*[.:#]?\s*([0-9]+)\s*"
    r"(?:\(\s*([a-z])\s*\)|([a-z])(?![a-z0-9]))?\s*[.:)\-–—]?\s*(.*)$",
    re.I,
)

TASK_LINE = re.compile(
    r"^(?:assessment\s+|written\s+|practical\s+)?"
    r"(task|activity|exercise|scenario|case\s+study)\s*[.:#]?\s*"
    r"([0-9]+|[a-z])(?![a-z0-9])\s*(?:\(\s*([a-z])\s*\))?\s*"
    r"[.:)\-–—]?\s*(.*)$",
    re.I,
)

SECTION_LINE = re.compile(
    r"^(section|assignment|assessment|part|unit|module|chapter|topic)"
    r"\s*[.:#]?\s*(?:([0-9]+|[a-z])(?![a-z0-9]))?\s*"
    r"[.:)\-–—]?\s*(.*)$",
    re.I,
)

SUBPART_LINE = re.compile(r"^\(?\s*([a-z])\s*[).]\s+(.+)$")

ROMAN_LINE = re.compile(r"^\(?\s*([ivx]{2,})\s*[).]\s+(.+)$", re.I)

NUMBERED_LINE = re.compile(r"^([0-9]{1,2})\s*[.)]\s+(.+)$")

WORD_LIMIT = re.compile(
    r"answers?\s+(?:must|should)\s+be\s+(?:between\s+)?(\d+)\s*"
    r"(?:-|–|to)\s*(\d+)\s*words?"
    r"|\(?\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*words\s*\)?",
    re.I,
)

WORD_LIMIT_ONLY = re.compile(
    r"^[\s(]*\d+\s*(?:-|–|to)\s*\d+\s*words?[\s.)]*$", re.I
)

TICK = re.compile(r"[☐□☒☑]")

YES_NO = re.compile(r"^(yes|no)\b", re.I)

"""
A heading only counts as a question in its own right when it
actually asks for something. Workbook front matter - "Unit outcome",
"Assessment conditions", "Section 2: Reasonable adjustments" - is
prose about the assessment rather than part of it, and must never be
answered into.
"""
INSTRUCTION = re.compile(
    r"^(explain|describe|list|outline|identify|discuss|define|state|"
    r"complete|write|provide|give|name|summari[sz]e|analy[sz]e|"
    r"evaluate|recogni[sz]e|choose|select|oversee|demonstrate|"
    r"perform|prepare|develop|review|calculate|research|record|"
    r"report|plan|apply|compare|justify)\b",
    re.I,
)


MARKER_LINES = (
    "satisfactory response",
    "sample answer",
    "sample response",
    "model answer",
    "answer may vary",
    "benchmark answer",
)

MARKER_STARTS = (
    "answers must include",
    "answer must include",
    "a satisfactory response",
    "answer may vary",
    "answers may vary",
    "sample answer",
    "benchmark",
    "marking guide",
    "assessor",
)

NOISE_LINES = (
    "question",
    "answer",
    "answer:",
    "your answer",
    "your answer:",
    "student response",
    "yes",
    "no",
    "satisfactory",
    "not satisfactory",
)


def is_marker(text: str) -> bool:
    lowered = text.strip().lower()
    return lowered in MARKER_LINES or lowered.startswith(MARKER_STARTS)


def is_noise(text: str) -> bool:
    lowered = text.strip().lower()
    return (
        lowered in NOISE_LINES
        or "☐" in text
        or bool(re.match(r"^(yes|no)\s*[☐□]", text, re.I))
    )


@dataclass
class Item:
    kind: str
    parent: str
    letter: str
    label: str
    head: str
    body: List[str] = field(default_factory=list)
    blocks: List[Block] = field(default_factory=list)
    word_min: Optional[int] = None
    word_max: Optional[int] = None


@dataclass
class Question:
    number: str
    text: str
    context: str = ""
    answer_type: str = "prose"
    word_min: Optional[int] = None
    word_max: Optional[int] = None
    space: Optional[Block] = None
    space_kind: str = "none"
    after: Optional[Block] = None
    grid: Optional[Grid] = None


def _start(line: str, loose: bool):
    """What this line starts, if anything."""

    match = QUESTION_LINE.match(line)

    if match:
        letter = (match.group(2) or match.group(3) or "").lower()
        return Item(
            kind="question",
            parent=match.group(1),
            letter=letter,
            label=f"{match.group(1)}({letter})" if letter else match.group(1),
            head=(match.group(4) or "").strip(),
        )

    match = TASK_LINE.match(line)

    if match:
        name = re.sub(r"\s+", " ", match.group(1)).capitalize()
        number = str(match.group(2)).upper()
        letter = (match.group(3) or "").lower()
        label = f"{name} {number}"
        return Item(
            kind="section",
            parent=label,
            letter=letter,
            label=f"{label}({letter})" if letter else label,
            head=(match.group(4) or "").strip(),
        )

    match = SECTION_LINE.match(line)

    if match and len(line) <= 90 and not line.rstrip().endswith("?"):
        name = match.group(1).capitalize()
        number = str(match.group(2)).upper() if match.group(2) else ""
        return Item(
            kind="section",
            parent="",
            letter="",
            label=(name + " " + number).strip(),
            head=(match.group(3) or "").strip(),
        )

    if not loose:
        return None

    for pattern in (ROMAN_LINE, SUBPART_LINE):
        match = pattern.match(line)
        if match:
            return Item(
                kind="question",
                parent="",
                letter="",
                label="(" + match.group(1).lower() + ")",
                head=match.group(2).strip(),
            )

    match = NUMBERED_LINE.match(line)

    if match:
        return Item(
            kind="question",
            parent=match.group(1),
            letter="",
            label=match.group(1),
            head=match.group(2).strip(),
        )

    return None


def _has_headings(blocks: List[Block]) -> bool:
    for block in blocks:
        if block.empty:
            continue
        line = block.text.splitlines()[0]
        if QUESTION_LINE.match(line) or TASK_LINE.match(line):
            return True
    return False


def _items(blocks: List[Block]) -> List[Item]:

    loose = not _has_headings(blocks)

    items: List[Item] = []
    current: Optional[Item] = None
    marking = False

    for block in blocks:

        if block.empty:
            if current is not None:
                current.blocks.append(block)
            continue

        """
        In a Word file a whole table cell arrives as one block, and
        an assessment question puts its wording, its word count and
        the assessor's tick boxes in that same cell. So every line
        is read on its own, exactly as it would be if each were its
        own paragraph.
        """
        attached = False

        for line in (part.strip() for part in block.text.splitlines()):

            if not line:
                continue

            started = _start(line, loose)

            if started:
                if current is not None:
                    items.append(current)
                current = started
                current.blocks.append(block)
                attached = True
                marking = False
                continue

            if current is None:
                continue

            if not attached:
                current.blocks.append(block)
                attached = True

            limit = WORD_LIMIT.search(line)

            if limit:
                numbers = [n for n in limit.groups() if n]
                current.word_min = int(numbers[0])
                current.word_max = int(numbers[1])
                if WORD_LIMIT_ONLY.match(line):
                    continue

            if is_marker(line):
                marking = True
                continue

            if marking or is_noise(line):
                continue

            current.body.append(line)

    if current is not None:
        items.append(current)

    return items


def _grid(item: Item, tables) -> Optional[Grid]:
    """A header row, then a row per thing with empty cells beside it."""

    by_table = {}

    for block in item.blocks:
        if block.table_at >= 0:
            by_table.setdefault(block.table_at, []).append(block)

    for table_at, cells in by_table.items():

        header = sorted(
            [c for c in cells if c.row == 0], key=lambda c: c.column
        )

        if len(header) < 2 or any(
            c.empty or len(c.text) > 60 for c in header
        ):
            continue

        rows: List[str] = []
        columns = 0

        for number in sorted({c.row for c in cells if c.row > 0}):

            row = sorted(
                [c for c in cells if c.row == number],
                key=lambda c: c.column,
            )

            if len(row) < 2 or row[0].empty:
                continue

            rest = row[1:]

            if not rest or not all(c.empty for c in rest):
                continue

            rows.append(row[0].text.strip())
            columns = max(columns, len(rest))

        if len(rows) >= 2:
            return Grid(
                table_at=table_at,
                headers=[c.text.strip() for c in header[1:]],
                rows=rows,
                columns=columns,
                table=tables[table_at] if table_at < len(tables) else None,
            )

    return None


def _answer_type(item: Item) -> str:
    """Yes/No when the question itself offers them, prose otherwise."""

    marking = False

    for block in item.blocks:

        if block.empty:
            continue

        for line in (part.strip() for part in block.text.splitlines()):

            if not line:
                continue

            if is_marker(line):
                marking = True
                continue

            if marking:
                continue

            if TICK.search(line) or YES_NO.match(line):
                return "yesno"

    return "prose"


def _space(item: Item):
    """
    The space this question leaves for its answer: an empty cell
    first, because a box is unmistakable, otherwise an empty line -
    but never one that sits past the marking guidance, which belongs
    to the assessor.
    """

    box = None
    blank_line = None
    past_marking = False

    for block in item.blocks:

        if not block.empty:
            for part in (
                text.strip() for text in block.text.splitlines()
            ):
                if part and is_marker(part):
                    past_marking = True
            continue

        if block.in_table and box is None:
            box = block

        if (
            not block.in_table
            and blank_line is None
            and not past_marking
        ):
            blank_line = block

    if box is not None:
        return box, "box"

    if blank_line is not None:
        return blank_line, "line"

    return None, "none"


def find(document) -> List[Question]:
    """Every question in the document, in order, ready to be answered."""

    items = _items(document.blocks)

    has_parts = {
        item.parent for item in items if item.letter and item.parent
    }

    section_has_content = {}
    last_section = -1

    for at, item in enumerate(items):
        if item.kind == "section":
            last_section = at
            section_has_content[at] = False
        elif last_section >= 0:
            section_has_content[last_section] = True

    case_study = {}

    for item in items:
        if (
            item.kind == "question"
            and not item.letter
            and item.parent in has_parts
        ):
            case_study[item.parent] = "\n".join(
                part for part in [item.head, *item.body] if part
            )

    questions: List[Question] = []
    used = {}
    section_context = ""

    for at, item in enumerate(items):

        grid = _grid(item, document.tables)

        text = "\n".join(
            part for part in [item.head, *item.body] if part
        ).strip()

        if grid:
            inside = {
                block.text.strip()
                for block in item.blocks
                if block.table_at == grid.table_at and not block.empty
            }
            text = "\n".join(
                part for part in [item.head, *item.body]
                if part and part not in inside
            ).strip()

        space, space_kind = _space(item)

        if item.kind == "section":

            """
            A task or activity is only answered in its own right
            when the document gives it a box. Workbooks introduce
            their activities in a list first - "Activity 3: Oversee
            the on-site delivery of materials" with the timing
            beside it - and a blank line there is spacing, not an
            answer space.
            """
            answerable = (
                not section_has_content.get(at, False)
                and space_kind == "box"
                and len(text) >= 15
                and ("?" in text or INSTRUCTION.match(text.strip()))
            )

            if not answerable:
                section_context = " ".join(
                    part for part in [item.label, text] if part
                ).strip()
                continue

        if (
            item.kind == "question"
            and not item.letter
            and item.parent in has_parts
        ):
            continue

        if not text:
            continue

        label = item.label

        if label in used:
            used[label] += 1
            label = f"{label}#{used[label]}"
        else:
            used[label] = 1

        """
        Only the case study this question's own parent set. The
        heading above it is no use as background - in a workbook
        that is the submission instructions, "staple the loose
        sheets together", which the AI would earnestly try to take
        into account.
        """
        context = case_study.get(item.parent, "")

        questions.append(Question(
            number=label,
            text=text,
            context=context,
            answer_type="grid" if grid else _answer_type(item),
            word_min=item.word_min,
            word_max=item.word_max,
            space=space,
            space_kind="table" if grid else space_kind,
            after=item.blocks[0] if item.blocks else None,
            grid=grid,
        ))

    return questions
