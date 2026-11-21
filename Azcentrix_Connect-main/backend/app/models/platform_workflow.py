from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint

from app.database import Base


class PlatformWorkflowTemplate(Base):
    """An industry-ready pipeline that can be pushed to a tenant (Business → Workflow Templates)."""
    __tablename__ = "platform_workflow_templates"
    id = Column(Integer, primary_key=True)
    key = Column(String(40), nullable=False, unique=True)
    name = Column(String(150), nullable=False, unique=True)
    workflow = Column(String(40), nullable=False, default="tender")    # tenant workflow it replaces
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True, onupdate=datetime.utcnow)


class PlatformWorkflowTemplateStage(Base):
    """One stage of a template, in order; open stages first, then the won / lost outcomes."""
    __tablename__ = "platform_workflow_template_stages"
    # (template_id, position) serves both the uniqueness rule and loading a template's stages in order.
    __table_args__ = (UniqueConstraint("template_id", "position", name="uq_platform_workflow_template_stage"),)
    id = Column(Integer, primary_key=True)
    template_id = Column(Integer, ForeignKey("platform_workflow_templates.id", ondelete="CASCADE"), nullable=False)
    position = Column(Integer, nullable=False)
    name = Column(String(150), nullable=False)
    kind = Column(String(10), nullable=False, default="open")          # open | won | lost
    sla_days = Column(Integer, nullable=False, default=0)
    gate = Column(String(20), nullable=False, default="None")          # None | Approval | Checklist
    owner_role = Column(String(100), nullable=True)
    checklist = Column(JSON, nullable=True)                            # items a Checklist gate requires


class PlatformTenantWorkflow(Base):
    """The template a tenant's workflow was last pushed from; drives the "used by" counts."""
    __tablename__ = "platform_tenant_workflows"
    __table_args__ = (
        UniqueConstraint("tenant_id", "workflow", name="uq_platform_tenant_workflow"),
        Index("ix_platform_tenant_workflows_template", "template_id", "workflow"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    workflow = Column(String(40), nullable=False, default="tender")
    template_id = Column(Integer, ForeignKey("platform_workflow_templates.id", ondelete="RESTRICT"), nullable=False)
    revision = Column(Integer, nullable=False)                         # revision written to the tenant database
    records_mapped = Column(Integer, nullable=False, default=0)
    applied_by = Column(String(255), nullable=True)
    applied_at = Column(DateTime, nullable=False, default=datetime.utcnow)
