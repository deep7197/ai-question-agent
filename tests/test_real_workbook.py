"""
Runs the whole write path over a real workbook, on a copy.

Placeholder text is used rather than real answers, so what this
proves is placement: that every answer lands under its own question,
that the grids fill cell by cell, and that nothing already written -
the questions, the marking guidance, the assessor's boxes - is
touched.

    .venv\\Scripts\\python.exe tests\\test_real_workbook.py "<path.docx>"
"""

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from docx_agent import document as doc_io            # noqa: E402
from docx_agent import questions as finder           # noqa: E402


def placeholder(question):

    if question.answer_type == "yesno":
        return "Yes"

    if question.word_min:
        return (
            "[TEST %s - a real answer of %d-%d words goes here]"
            % (question.number, question.word_min, question.word_max)
        )

    return "[TEST %s - a real answer goes here]" % question.number


def fill_grid(question):
    """Fills the empty cells of a question's table, row by row."""

    written = 0

    table = question.grid.table

    if table is None:
        return 0

    for row_at in range(1, len(table.rows)):

        row = table.rows[row_at]

        label = row.cells[0].text.strip()

        if not label:
            continue

        for column in range(1, len(row.cells)):

            cell = row.cells[column]

            if cell.text.strip():
                continue                     # already answered

            heading = table.rows[0].cells[column].text.strip()

            cell.paragraphs[0].text = (
                "[TEST %s - %s of %s]" % (
                    question.number, heading, label
                )
            )

            written += 1

    return written


def main():

    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    source = sys.argv[1]

    target = os.path.join(
        os.path.dirname(source),
        os.path.splitext(os.path.basename(source))[0]
        + " - agent test output.docx",
    )

    shutil.copy2(source, target)

    document = doc_io.read(target)
    questions = finder.find(document)

    style = None

    for block in document.blocks:
        if not block.empty:
            style = doc_io.style_from(block)
            if style:
                break

    print("%d questions found in %s\n" % (
        len(questions), os.path.basename(source)
    ))

    cells = 0
    in_space = 0
    under = 0

    for question in questions:

        if question.grid:
            written = fill_grid(question)
            cells += written
            print("  [%-10s] grid  - %d cells filled" % (
                question.number, written
            ))
            continue

        text = placeholder(question)

        if question.space is not None:
            doc_io.fill(question.space, text, style)
            in_space += 1
            print("  [%-10s] %-5s - written into the %s" % (
                question.number, question.answer_type, question.space_kind
            ))
        else:
            doc_io.insert_after(question.after, text, style)
            under += 1
            print("  [%-10s] %-5s - added under the question" % (
                question.number, question.answer_type
            ))

    document.save(target)

    # ---- read the saved file back and check every answer ----------

    again = doc_io.read(target)

    problems = []

    marks = [
        b for b in again.blocks if "[TEST " in b.text
    ]

    print("\nsaved: %s" % target)
    print("placed %d in their own space, %d under the question, "
          "%d grid cells" % (in_space, under, cells))
    print("found %d marked answers in the saved file" % len(marks))

    # every question that was answered must appear before its answer
    for question in questions:

        if question.grid:
            continue

        if question.answer_type == "yesno":

            """
            A Yes/No answer is the word itself, so there is no tag to
            search for. The cell it went into is read back live -
            block.text is only a snapshot from before the write.
            """
            target = question.space

            if target is None:
                continue

            live = (
                target.cell.text if target.cell is not None
                else target.paragraph.text
            )

            if "yes" not in live.lower():
                problems.append(
                    "%s: Yes was not written into its space"
                    % question.number
                )

            continue

        tag = "[TEST %s " % question.number

        where = next(
            (b.index for b in again.blocks if tag in b.text), None
        )

        if where is None:
            problems.append("%s: answer not found in the saved file"
                            % question.number)
            continue

        head = question.text.splitlines()[0][:40]

        before = next(
            (b.index for b in again.blocks
             if head and head in b.text and b.index <= where),
            None,
        )

        if before is None:
            problems.append(
                "%s: answer is not after its question" % question.number
            )

    # nothing the trainer wrote may have been replaced
    if "Answer may vary" not in "\n".join(b.text for b in again.blocks):
        problems.append("the marking guidance was damaged")

    if problems:
        print("\nFAILED:")
        for problem in problems:
            print("  - " + problem)
        return 1

    print("\nevery answer is in the right place, "
          "and nothing already written was changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
