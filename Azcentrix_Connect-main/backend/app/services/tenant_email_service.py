import logging
import smtplib
import ssl
from email.message import EmailMessage

logger = logging.getLogger(__name__)

REQUIRED_TENANT_SMTP_FIELDS = (
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_password",
)


class TenantEmailConfigurationError(ValueError):
    pass


class TenantEmailDeliveryError(RuntimeError):
    pass


def get_missing_tenant_smtp_fields(tenant) -> list[str]:
    missing: list[str] = []
    for field in REQUIRED_TENANT_SMTP_FIELDS:
        value = getattr(tenant, field, None)
        if value is None:
            missing.append(field)
            continue
        if isinstance(value, str) and not value.strip():
            missing.append(field)
    return missing


def validate_tenant_smtp_config(tenant) -> None:
    missing = get_missing_tenant_smtp_fields(tenant)
    if not missing:
        return

    logger.warning(
        "Tenant %s missing SMTP fields for password reset email: %s",
        getattr(tenant, "slug", "unknown"),
        ", ".join(missing),
    )
    raise TenantEmailConfigurationError(
        "Forgot password email is not configured for this company. Please contact your administrator."
    )


def _meter_email(tenant) -> None:
    """Count the sent e-mail for platform usage monitoring (never raises)."""
    from app.services.platform_usage import record_email

    record_email(getattr(tenant, "slug", None))


def send_tenant_email(
    tenant,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    *,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    reply_to: str | None = None,
    attachments: list[tuple[str, bytes, str]] | None = None,
) -> None:
    """Send one e-mail through the tenant SMTP server.

    Optional (Inbox): cc / bcc address lists, a Reply-To address and attachments as
    (file name, bytes, MIME type) tuples. Existing callers are unaffected.
    """
    validate_tenant_smtp_config(tenant)

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = (getattr(tenant, "from_email", None) or tenant.smtp_user or "").strip()
    message["To"] = to_email
    if cc:
        message["Cc"] = ", ".join(cc)
    if reply_to:
        message["Reply-To"] = reply_to
    message.set_content(text_body)
    if html_body:
        message.add_alternative(html_body, subtype="html")
    for file_name, data, mime in attachments or []:
        maintype, _, subtype = (mime or "application/octet-stream").partition("/")
        message.add_attachment(data, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=file_name)
    # Bcc recipients get the message without appearing in its headers.
    envelope_to = [a.strip() for a in [*str(to_email or "").split(","), *(cc or []), *(bcc or [])] if a and a.strip()]

    ssl_context = ssl.create_default_context()

    try:
        if getattr(tenant, "smtp_use_ssl", False):
            with smtplib.SMTP_SSL(
                tenant.smtp_host,
                int(tenant.smtp_port),
                context=ssl_context,
                timeout=30,
            ) as server:
                server.login(tenant.smtp_user, tenant.smtp_password)
                server.send_message(message, to_addrs=envelope_to)
            _meter_email(tenant)
            return

        with smtplib.SMTP(tenant.smtp_host, int(tenant.smtp_port), timeout=30) as server:
            server.ehlo()
            if getattr(tenant, "smtp_use_tls", False):
                server.starttls(context=ssl_context)
                server.ehlo()
            server.login(tenant.smtp_user, tenant.smtp_password)
            server.send_message(message, to_addrs=envelope_to)
        _meter_email(tenant)
    except Exception as exc:
        logger.exception(
            "Tenant SMTP send failed for tenant=%s recipient=%s",
            getattr(tenant, "slug", "unknown"),
            to_email,
        )
        raise TenantEmailDeliveryError("Unable to send tenant email") from exc
