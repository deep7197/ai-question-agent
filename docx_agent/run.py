"""
The run itself: read the workbook, answer every question, write each
answer where it belongs, save.

The file is saved after every answer, so a run that is stopped or
interrupted keeps everything it has done so far. The original is
never written to - the answers go into a copy beside it.
"""

import os
import shutil
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from . import ask, bridge, document as doc_io, prompts, questions as finder


GRID_BATCH = 5


@dataclass
class Result:
    number: str
    placed: str = ""          # "box", "line", "under", "table", ""
    words: int = 0
    cells: int = 0
    error: str = ""


@dataclass
class Outcome:
    output_path: str = ""
    results: List[Result] = field(default_factory=list)
    stopped: bool = False

    @property
    def answered(self) -> int:
        return len([r for r in self.results if not r.error])

    @property
    def failed(self) -> List[Result]:
        return [r for r in self.results if r.error]


def output_path_for(source: str) -> str:

    folder = os.path.dirname(source)
    name = os.path.splitext(os.path.basename(source))[0]

    return os.path.join(folder, name + " - answered.docx")


class Run:

    def __init__(
        self,
        source: str,
        provider: str,
        profile_dir: str,
        report: Optional[Callable[[str], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
        use_my_chrome: bool = False,
        through_chrome: bool = False,
        limit: int = 0,
    ):
        self.source = source
        self.provider = provider
        self.profile_dir = profile_dir
        self.report = report or (lambda message: None)
        self.should_stop = should_stop or (lambda: False)
        self.use_my_chrome = use_my_chrome

        """
        through_chrome asks the questions in the Chrome you already
        use, through the extension, instead of opening a browser of
        the agent's own - which is the only way to reach an account
        you are already signed in to.
        """
        self.through_chrome = through_chrome

        """
        A trial run: answer only the first few questions, to see the
        whole chain work before committing to a long run.
        """
        self.limit = max(0, int(limit or 0))

    # ---------------------------------------------------------------

    def preview(self) -> List[finder.Question]:
        """What the agent makes of the workbook, without writing."""

        return finder.find(doc_io.read(self.source))

    def go(self) -> Outcome:

        outcome = Outcome()

        target = output_path_for(self.source)

        shutil.copy2(self.source, target)

        outcome.output_path = target

        document = doc_io.read(target)

        found = finder.find(document)

        if self.limit:
            found = found[:self.limit]

        style = None

        for block in document.blocks:
            if not block.empty:
                style = doc_io.style_from(block)
                if style:
                    break

        self.report(
            "Found %d question%s in %s."
            % (len(found), "" if len(found) == 1 else "s",
               os.path.basename(self.source))
        )

        session = (
            bridge.Bridge(self.provider, self.report)
            if self.through_chrome else
            ask.Session(
                self.provider, self.profile_dir, self.report,
                use_my_chrome=self.use_my_chrome,
            )
        )

        try:
            session.start()
        except Exception:
            session.close()
            raise

        try:

            for at, question in enumerate(found, start=1):

                if self.should_stop():
                    outcome.stopped = True
                    break

                self.report(
                    "[%d/%d] Question %s..."
                    % (at, len(found), question.number)
                )

                result = Result(number=str(question.number))

                try:

                    if question.grid:
                        result.cells = self._do_grid(
                            session, question, style
                        )
                        result.placed = "table"
                    else:
                        result.words, result.placed = self._do_question(
                            session, question, style
                        )

                except Exception as error:               # noqa: BLE001
                    result.error = str(error)
                    self.report("      ! " + result.error)

                outcome.results.append(result)

                # Saved as we go, so nothing is lost if this stops.
                document.save(target)

                if not result.error:
                    self.report(
                        "      written %s"
                        % {
                            "box": "into the box under the question",
                            "line": "on the blank line under the question",
                            "under": "directly under the question",
                            "table": "into the table, %d cells"
                                     % result.cells,
                        }.get(result.placed, result.placed)
                    )

        finally:
            session.close()
            document.save(target)

        return outcome

    # ---------------------------------------------------------------

    def _do_question(self, session, question, style):

        reply = session.ask(prompts.for_question(question))

        answer = prompts.clean_answer(reply)

        if question.answer_type == "yesno":
            answer = prompts.as_yes_no(answer) or answer

        if not answer:
            raise RuntimeError("the AI sent nothing back")

        if question.space is not None:
            doc_io.fill(question.space, answer, style)
            placed = question.space_kind
        else:
            doc_io.insert_after(question.after, answer, style)
            placed = "under"

        return prompts.word_count(answer), placed

    def _do_grid(self, session, question, style):

        rows = question.grid.rows
        headers = question.grid.headers

        answers = {}

        for start in range(0, len(rows), GRID_BATCH):

            if self.should_stop():
                break

            batch = rows[start:start + GRID_BATCH]

            self.report(
                "      rows %d-%d of %d..."
                % (start + 1, start + len(batch), len(rows))
            )

            try:
                reply = session.ask(prompts.for_grid(question, batch))
                answers.update(
                    prompts.parse_grid(reply, batch, headers)
                )
            except Exception as error:                   # noqa: BLE001
                self.report("      ! " + str(error))

        missed = [row for row in rows if prompts.row_key(row) not in answers]

        if missed and not self.should_stop():

            self.report("      %d row(s) again..." % len(missed))

            for start in range(0, len(missed), GRID_BATCH):

                batch = missed[start:start + GRID_BATCH]

                try:
                    reply = session.ask(prompts.for_grid(question, batch))
                    answers.update(
                        prompts.parse_grid(reply, batch, headers)
                    )
                except Exception:                        # noqa: BLE001
                    pass

        if not answers:
            raise RuntimeError("the AI did not fill in the table")

        return self._write_grid(question, answers, style)

    @staticmethod
    def _write_grid(question, answers, style):
        """Writes each row's cells, leaving anything already there."""

        table = question.grid.table

        if table is None:
            return 0

        written = 0

        for row_at in range(1, len(table.rows)):

            row = table.rows[row_at]

            cells = answers.get(prompts.row_key(row.cells[0].text))

            if not cells:
                continue

            for column in range(1, len(row.cells)):

                if column - 1 >= len(cells):
                    break

                cell = row.cells[column]

                if cell.text.strip() or not cells[column - 1]:
                    continue

                cell.paragraphs[0].text = ""

                run = cell.paragraphs[0].add_run(cells[column - 1])

                if style:
                    run.font.name = style.get("name")
                    if style.get("size"):
                        run.font.size = style["size"]

                written += 1

        return written
