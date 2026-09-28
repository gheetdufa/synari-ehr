"""Intake, consent and assessment forms: templates, sharing, review and portal completion.

Templates are practice-wide: everyone on the team can see them, and clinicians and practice
managers can change them. Sharing forms and following their status needs access to the client's
profile (schedulers send intake paperwork); answers, scores, flags and PDFs are clinical.
"""

from collections.abc import Sequence

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, DbSession
from synari.models import Client, ClientForm, FormTemplate
from synari.models.enums import ClientFormStatus, Role
from synari.permissions import Capability
from synari.realtime import publish
from synari.schemas.common import Message
from synari.schemas.forms import (
    ClientFormOut,
    ClientFormSummary,
    FormSubmission,
    LibraryFormOut,
    PortalFormOut,
    PortalFormSummary,
    ShareFormsRequest,
    SubmissionProblem,
    TemplateCreate,
    TemplateOut,
    TemplateSummary,
    TemplateUpdate,
)
from synari.services.form_pdf import pdf_filename, render_client_form_pdf
from synari.services.forms import (
    autofill_client,
    clean_answers,
    notify_form_completed,
    record_submission,
    remind_client,
    share_forms,
    signature_problem,
)
from synari.services.forms_library import LIBRARY, new_template
from synari.services.recipients import client_team_recipients

router = APIRouter(tags=["forms"])

_HIDDEN_RESULTS = {"score": None, "score_label": None, "flagged": None}


def _active_template(access: Access, template_id: int) -> FormTemplate:
    template = access.get(FormTemplate, template_id, label="Form template")
    if not template.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Form template not found")
    return template


def _require_template_editor(access: Access) -> None:
    if not (access.staff.is_clinician or access.can(Capability.MANAGE_PRACTICE)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only clinicians and practice managers can change forms"
        )


def _require_form_manager(access: Access, client: Client) -> None:
    """Withdrawing or resending a form is for the client's clinicians and the schedulers."""
    on_care_team = any(member.staff_id == access.staff.id for member in client.care_team)
    if not (on_care_team or access.can(Capability.SCHEDULE_ALL)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the client's clinicians and schedulers can withdraw or resend forms",
        )


def _summaries(
    access: Access, client: Client, forms: Sequence[ClientForm]
) -> list[ClientFormSummary]:
    """Form summaries, without results unless this person may see the client's clinical record."""
    summaries = [ClientFormSummary.model_validate(form) for form in forms]
    if access.can_access_client(client, ClientAccess.CLINICAL):
        return summaries
    return [summary.model_copy(update=_HIDDEN_RESULTS) for summary in summaries]


def _portal_form(db: Session, client: Client, form_id: int, *, lock: bool = False) -> ClientForm:
    form = db.get(ClientForm, form_id, with_for_update=lock)
    if form is None or form.client_id != client.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Form not found")
    return form


def _ensure_portal_access(client: Client) -> None:
    if not client.email:
        raise HTTPException(status.HTTP_409_CONFLICT, "Add an email address for this client first")
    if not client.can_use_portal:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This client doesn't have portal access, so forms can't be sent",
        )


# --- Library and templates -------------------------------------------------------------------


@router.get("/forms/library", response_model=list[LibraryFormOut])
def list_library(_: CurrentAccess) -> list[LibraryFormOut]:
    """Built-in forms that can be added to the practice's templates."""
    return [LibraryFormOut.model_validate(entry) for entry in LIBRARY.values()]


@router.post(
    "/forms/library/{key}", response_model=TemplateOut, status_code=status.HTTP_201_CREATED
)
def add_library_form(
    key: str, access: CurrentAccess, db: DbSession, request: Request
) -> FormTemplate:
    """Add a fresh copy of a built-in form to the practice's templates."""
    _require_template_editor(access)
    entry = LIBRARY.get(key)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No library form with that key")
    template = new_template(access.practice_id, entry)
    db.add(template)
    db.flush()
    audit_staff(
        db,
        request,
        access.staff,
        "form_template.create",
        "form_template",
        template.id,
        {"library_key": key},
    )
    db.commit()
    return template


@router.get("/forms/templates", response_model=list[TemplateSummary])
def list_templates(access: CurrentAccess, db: DbSession) -> list[FormTemplate]:
    """The practice's active form templates."""
    query = select(FormTemplate).where(
        FormTemplate.practice_id == access.practice_id, FormTemplate.is_active
    )
    return list(db.scalars(query.order_by(FormTemplate.kind, FormTemplate.name, FormTemplate.id)))


@router.post("/forms/templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(
    body: TemplateCreate, access: CurrentAccess, db: DbSession, request: Request
) -> FormTemplate:
    """Create a custom form template."""
    _require_template_editor(access)
    template = FormTemplate(
        practice_id=access.practice_id,
        kind=body.kind,
        name=body.name,
        description=body.description,
        fields=[f.model_dump(mode="json", exclude_none=True) for f in body.fields],
        requires_signature=body.requires_signature,
    )
    db.add(template)
    db.flush()
    audit_staff(db, request, access.staff, "form_template.create", "form_template", template.id)
    db.commit()
    return template


@router.get("/forms/templates/{template_id}", response_model=TemplateOut)
def get_template(template_id: int, access: CurrentAccess) -> FormTemplate:
    """One template with its fields."""
    return _active_template(access, template_id)


@router.patch("/forms/templates/{template_id}", response_model=TemplateOut)
def update_template(
    template_id: int,
    body: TemplateUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> FormTemplate:
    """Edit a template. Forms already shared keep the version the client was sent."""
    _require_template_editor(access)
    template = _active_template(access, template_id)
    if template.read_only:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Built-in assessments can't be edited so their scoring stays valid",
        )
    for name in body.model_fields_set:
        value = getattr(body, name)
        if value is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{name} can't be empty")
        if name == "fields":
            value = [f.model_dump(mode="json", exclude_none=True) for f in value]
        setattr(template, name, value)
    audit_staff(
        db,
        request,
        access.staff,
        "form_template.update",
        "form_template",
        template.id,
        {"fields": sorted(body.model_fields_set)},
    )
    db.commit()
    return template


@router.delete("/forms/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(
    template_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Retire a template. Forms already shared with clients are unaffected."""
    _require_template_editor(access)
    template = _active_template(access, template_id)
    template.is_active = False
    audit_staff(db, request, access.staff, "form_template.delete", "form_template", template.id)
    db.commit()


# --- Forms shared with a client --------------------------------------------------------------


@router.post(
    "/clients/{client_id}/forms",
    response_model=list[ClientFormSummary],
    status_code=status.HTTP_201_CREATED,
)
def share_with_client(
    client_id: int,
    body: ShareFormsRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> list[ClientFormSummary]:
    """Send forms to a client's portal and email them one link to complete them."""
    client = access.client(client_id, ClientAccess.PROFILE)
    _ensure_portal_access(client)
    templates = [_active_template(access, t) for t in dict.fromkeys(body.template_ids)]
    forms = share_forms(db, access.staff, client, templates, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "client_form.share",
        "client",
        client.id,
        {"client_form_ids": [form.id for form in forms]},
        client_id=client.id,
    )
    db.commit()
    return _summaries(access, client, forms)


@router.get("/clients/{client_id}/forms", response_model=list[ClientFormSummary])
def list_client_forms(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[ClientFormSummary]:
    """Every form shared with the client, newest first, with status (and results if clinical)."""
    client = access.client(client_id, ClientAccess.PROFILE)
    forms = db.scalars(
        select(ClientForm)
        .where(ClientForm.client_id == client.id)
        .order_by(ClientForm.sent_at.desc(), ClientForm.id.desc())
    ).all()
    audit_staff(
        db, request, access.staff, "client_form.list", "client", client.id, client_id=client.id
    )
    db.commit()
    return _summaries(access, client, forms)


@router.get("/client-forms/{form_id}", response_model=ClientFormOut)
def get_client_form(
    form_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ClientForm:
    """A shared form with the client's answers, score and signature details."""
    form = access.client_record(ClientForm, form_id, ClientAccess.CLINICAL, label="Form")
    audit_staff(
        db,
        request,
        access.staff,
        "client_form.view",
        "client_form",
        form.id,
        client_id=form.client_id,
    )
    db.commit()
    return form


@router.delete("/client-forms/{form_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_client_form(
    form_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Withdraw a form the client hasn't completed yet."""
    form = access.client_record(ClientForm, form_id, ClientAccess.PROFILE, label="Form")
    _require_form_manager(access, access.client(form.client_id))
    if form.status != ClientFormStatus.PENDING:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Completed forms are part of the client's record"
        )
    client_id = form.client_id
    db.delete(form)
    publish(db, [(Role.CLIENT, client_id)], "client_form.revoked", {"client_form_id": form_id})
    audit_staff(
        db,
        request,
        access.staff,
        "client_form.revoke",
        "client_form",
        form_id,
        client_id=client_id,
    )
    db.commit()


@router.post("/client-forms/{form_id}/remind", response_model=Message)
def remind_about_form(
    form_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Message:
    """Email the client a reminder to complete their pending forms."""
    form = access.client_record(ClientForm, form_id, ClientAccess.PROFILE, label="Form")
    client = access.client(form.client_id)
    _require_form_manager(access, client)
    if form.status != ClientFormStatus.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "This form is already completed")
    _ensure_portal_access(client)
    remind_client(db, client, [form], utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "client_form.remind",
        "client_form",
        form.id,
        client_id=client.id,
    )
    db.commit()
    return Message(detail=f"Reminder sent to {client.email}")


@router.get("/client-forms/{form_id}/pdf")
def download_client_form_pdf(
    form_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    """Download a completed form as a PDF with answers, score and signature record."""
    form = access.client_record(ClientForm, form_id, ClientAccess.CLINICAL, label="Form")
    if form.status != ClientFormStatus.COMPLETED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This form hasn't been completed yet")
    content = render_client_form_pdf(form, access.client(form.client_id, ClientAccess.CLINICAL))
    audit_staff(
        db,
        request,
        access.staff,
        "client_form.download_pdf",
        "client_form",
        form.id,
        client_id=form.client_id,
    )
    db.commit()
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{pdf_filename(form)}"'},
    )


# --- Client portal ---------------------------------------------------------------------------


@router.get("/portal/forms", response_model=list[PortalFormSummary])
def portal_list_forms(client: CurrentClient, db: DbSession) -> list[ClientForm]:
    """The signed-in client's forms: ones still to complete first, then completed ones."""
    pending_first = case((ClientForm.status == ClientFormStatus.PENDING, 0), else_=1)
    forms = db.scalars(
        select(ClientForm)
        .where(ClientForm.client_id == client.id)
        .order_by(pending_first, ClientForm.sent_at.desc(), ClientForm.id.desc())
    ).all()
    return list(forms)


@router.get("/portal/forms/{form_id}", response_model=PortalFormOut)
def portal_get_form(
    form_id: int, client: CurrentClient, db: DbSession, request: Request
) -> ClientForm:
    """One form to fill in (or review once submitted). The first open marks it viewed."""
    form = _portal_form(db, client, form_id)
    if form.viewed_at is None:
        form.viewed_at = utcnow()
        publish(
            db,
            client_team_recipients(db, client, ClientAccess.PROFILE),
            "client_form.viewed",
            {"client_form_id": form.id, "client_id": client.id},
        )
    audit_client(db, request, client, "client_form.view", "client_form", form.id)
    db.commit()
    return form


@router.post("/portal/forms/{form_id}/submit", response_model=PortalFormOut)
def portal_submit_form(
    form_id: int,
    body: FormSubmission,
    client: CurrentClient,
    db: DbSession,
    request: Request,
) -> ClientForm:
    """Submit answers (and an e-signature when required). Forms can be submitted once.

    Invalid answers return 422 with detail {"message", "errors": {field_id: message},
    "signature": message or null}.
    """
    form = _portal_form(db, client, form_id, lock=True)
    if form.status != ClientFormStatus.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "This form has already been submitted")
    answers, errors = clean_answers(form.fields, body.answers)
    signature_error = signature_problem(form, body.signature_name, body.signature_agreed)
    if errors or signature_error:
        problem = SubmissionProblem(
            message="Some answers need attention", errors=errors, signature=signature_error
        )
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, problem.model_dump())
    record_submission(
        form,
        answers,
        signature_name=body.signature_name,
        signer_ip=request.client.host if request.client else "",
        signer_user_agent=request.headers.get("user-agent", ""),
        now=utcnow(),
    )
    filled = autofill_client(client, form.fields, answers)
    notify_form_completed(db, form, client)
    audit_client(
        db,
        request,
        client,
        "client_form.submit",
        "client_form",
        form.id,
        {"flagged": form.flagged, "autofilled": filled},
    )
    db.commit()
    return form
