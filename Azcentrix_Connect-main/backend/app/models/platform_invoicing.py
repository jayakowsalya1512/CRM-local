"""Invoices & dunning (Business → Invoices & dunning): payments, credit notes, reminders, dunning steps, gateway webhooks,
payment plans and the module's settings. Invoices and their lines stay in platform_invoices / platform_invoice_lines
(app.services.platform_billing)."""

from datetime import datetime

from sqlalchemy import JSON, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint

from app.database import Base


class PlatformPayment(Base):
    """Money received against an invoice. (gateway, reference) is unique, so a webhook delivered twice or a payment
    typed in twice is recorded once."""
    __tablename__ = "platform_payments"
    __table_args__ = (
        UniqueConstraint("gateway", "reference", name="uq_platform_payment_reference"),
        Index("ix_platform_payments_invoice", "invoice_id"),
        Index("ix_platform_payments_tenant", "tenant_id", "paid_on"),
        Index("ix_platform_payments_paid_on", "paid_on"),
    )
    id = Column(Integer, primary_key=True)
    invoice_id = Column(Integer, ForeignKey("platform_invoices.id", ondelete="RESTRICT"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    gateway = Column(String(20), nullable=False)                      # razorpay | stripe | bank | upi | manual | wallet
    reference = Column(String(120), nullable=False)                   # gateway payment id, UTR or cheque number
    amount = Column(Numeric(14, 2), nullable=False)
    currency = Column(String(3), nullable=False, default="INR")
    paid_on = Column(Date, nullable=False)
    evidence = Column(String(500), nullable=True)                     # manual payments: what proves it (statement line, receipt)
    source = Column(String(20), nullable=False)                       # manual | webhook
    recorded_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformCreditNote(Base):
    """A credit against one issued invoice. The invoice and its payments are never edited; the invoice's credited
    amount (and so its balance) moves with the notes issued against it."""
    __tablename__ = "platform_credit_notes"
    __table_args__ = (
        Index("ix_platform_credit_notes_invoice", "invoice_id"),
        Index("ix_platform_credit_notes_tenant", "tenant_id", "issued_at"),
        Index("ix_platform_credit_notes_issued", "issued_at"),
    )
    id = Column(Integer, primary_key=True)
    number = Column(String(40), nullable=False, unique=True)
    invoice_id = Column(Integer, ForeignKey("platform_invoices.id", ondelete="RESTRICT"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    amount = Column(Numeric(14, 2), nullable=False)                   # incl. GST
    tax_amount = Column(Numeric(14, 2), nullable=False, default=0)    # GST portion, at the invoice's rate
    reason = Column(String(300), nullable=False)
    status = Column(String(10), nullable=False, default="Issued")
    issued_by = Column(String(200), nullable=True)
    issued_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformInvoiceReminder(Base):
    """Every reminder attempt and what happened to it. Dunning reminders carry a dedupe key, so a step is never sent twice."""
    __tablename__ = "platform_invoice_reminders"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_platform_invoice_reminder_dedupe"),
        Index("ix_platform_invoice_reminders_invoice", "invoice_id", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    invoice_id = Column(Integer, ForeignKey("platform_invoices.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, nullable=False)
    kind = Column(String(10), nullable=False)                         # manual | dunning
    step_day = Column(Integer, nullable=True)
    channel = Column(String(10), nullable=False, default="email")
    recipient = Column(String(200), nullable=True)
    status = Column(String(10), nullable=False)                       # sent | failed
    detail = Column(String(300), nullable=True)
    dedupe_key = Column(String(80), nullable=True)
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformDunningEvent(Base):
    """One dunning step for one invoice (unique), with each of its actions' outcome – the retry log lives here too."""
    __tablename__ = "platform_dunning_events"
    __table_args__ = (
        UniqueConstraint("invoice_id", "step", name="uq_platform_dunning_step"),
        Index("ix_platform_dunning_events_tenant", "tenant_id", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    invoice_id = Column(Integer, ForeignKey("platform_invoices.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, nullable=False)
    step = Column(String(12), nullable=False)                         # d0 | d3 | d7 | d14 | readonly | suspend
    day = Column(Integer, nullable=False)
    status = Column(String(12), nullable=False)                       # done | skipped | superseded | paused
    retry = Column(String(12), nullable=True)                         # attempted | skipped | None (no retry in this step)
    actions = Column(JSON, nullable=True)                             # [{action, status, detail}]
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformGatewayEvent(Base):
    """Received payment-gateway webhooks; (gateway, event_id) is unique so a redelivered event is processed once."""
    __tablename__ = "platform_gateway_events"
    __table_args__ = (UniqueConstraint("gateway", "event_id", name="uq_platform_gateway_event"), Index("ix_platform_gateway_events_received", "received_at"))
    id = Column(Integer, primary_key=True)
    gateway = Column(String(20), nullable=False)
    event_id = Column(String(120), nullable=False)
    event_type = Column(String(80), nullable=True)
    status = Column(String(12), nullable=False)                       # processed | ignored | failed
    detail = Column(String(300), nullable=True)
    invoice_id = Column(Integer, nullable=True)
    received_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformPaymentPlan(Base):
    """An approved arrangement to pay overdue invoices later; while active (and the policy says so) dunning pauses."""
    __tablename__ = "platform_payment_plans"
    __table_args__ = (Index("ix_platform_payment_plans_tenant", "tenant_id", "status", "until"),)
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    until = Column(Date, nullable=False)
    note = Column(String(300), nullable=False)
    status = Column(String(10), nullable=False, default="approved")   # approved | ended
    approved_by = Column(String(200), nullable=True)
    approved_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    ended_by = Column(String(200), nullable=True)
    ended_at = Column(DateTime, nullable=True)


class PlatformBillingSetting(Base):
    """Settings of this module (dunning schedule and policy, GST, e-invoicing, gateways). Gateway secrets are never stored here."""
    __tablename__ = "platform_billing_settings"
    key = Column(String(40), primary_key=True)
    value = Column(JSON, nullable=False)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=True)

