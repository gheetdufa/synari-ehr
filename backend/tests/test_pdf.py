import pytest

from synari.services.pdf import BaseDocument, pdf_text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("José Núñez", "José Núñez"),
        ("“Quoted” — dash…", "“Quoted” — dash…"),
        ("Dvořák", "Dvorák"),
        ("Łódź", "?ódz"),
        ("中 🙂", "? ?"),
        ("tab\there\r\nnew line", "tab    here\nnew line"),
        ("bell\x07 removed", "bell removed"),
    ],
)
def test_pdf_text_folds_to_cp1252(raw: str, expected: str) -> None:
    assert pdf_text(raw) == expected


def test_base_document_renders_unicode_safely() -> None:
    document = BaseDocument("Note – “test”", footer_text="Confidential")
    document.section_title("Subjective")
    document.write_block("Client said “things are better” — 你好 🙂")
    assert document.output_bytes().startswith(b"%PDF")
