"""Plain-text + HTML email rendering.

Emails never contain clinical content. They say *that* something happened and link back
to the app, where the reader must be signed in.
"""

from dataclasses import dataclass
from html import escape


@dataclass(frozen=True)
class EmailContent:
    subject: str
    text: str
    html: str


def render_email(
    *,
    subject: str,
    heading: str,
    paragraphs: list[str],
    sender_name: str,
    button_label: str | None = None,
    button_url: str | None = None,
) -> EmailContent:
    """Render a simple branded email with an optional call-to-action button."""
    text_parts = [heading, "", *paragraphs]
    if button_label and button_url:
        text_parts += ["", f"{button_label}: {button_url}"]
    text_parts += ["", f"— {sender_name}", "", "This is an automated message. Please don't reply."]

    html_paragraphs = "".join(
        f'<p style="margin:0 0 16px;line-height:1.5">{escape(p)}</p>' for p in paragraphs
    )
    button_html = ""
    if button_label and button_url:
        button_html = (
            f'<p style="margin:24px 0"><a href="{escape(button_url, quote=True)}" '
            'style="background:#0e7490;color:#fff;padding:12px 20px;border-radius:8px;'
            f'text-decoration:none;font-weight:600;display:inline-block">{escape(button_label)}</a></p>'
        )
    html = (
        '<!doctype html><html><body style="margin:0;background:#f4f7f8;'
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2a30\">"
        '<div style="max-width:560px;margin:0 auto;padding:32px 24px">'
        '<div style="background:#fff;border-radius:12px;padding:32px">'
        f'<h1 style="font-size:20px;margin:0 0 20px">{escape(heading)}</h1>'
        f"{html_paragraphs}{button_html}"
        f'<p style="margin:24px 0 0;color:#5b6b73">— {escape(sender_name)}</p>'
        "</div>"
        '<p style="font-size:12px;color:#7a8a92;text-align:center;margin-top:16px">'
        "This is an automated message. Please don't reply.</p>"
        "</div></body></html>"
    )
    return EmailContent(subject=subject, text="\n".join(text_parts), html=html)
