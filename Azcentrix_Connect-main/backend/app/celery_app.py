"""Celery application for offloading slow, non-critical work (email/push sends)
off the request thread. Broker/result-backend reuse the existing Redis instance."""

from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "azcentrix",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Kolkata",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_default_retry_delay=30,
)

celery_app.autodiscover_tasks(["app"])


from celery.signals import after_setup_logger, worker_process_init  # noqa: E402


@after_setup_logger.connect
def _platform_logs(**_):
    """Logs explorer: Celery worker logs also go to platform_log_entries (service 'jobs' unless the task names one)."""
    from app.services import platform_logs

    platform_logs.install("celery")


@worker_process_init.connect
def _platform_logs_child(**_):
    from app.services import platform_logs

    platform_logs.start_writer()  # a forked pool process inherits the handler but not the writer thread


# Jobs & queues: throughput / failure counters, dead-letter parking, message age and paused queues.
from celery.signals import before_task_publish, task_failure, task_retry, task_success, worker_ready  # noqa: E402
from app.services import platform_jobs as _jobs  # noqa: E402

before_task_publish.connect(_jobs.on_publish, weak=False)
task_success.connect(_jobs.on_success, weak=False)
task_failure.connect(_jobs.on_failure, weak=False)
task_retry.connect(_jobs.on_retry, weak=False)
worker_ready.connect(_jobs.on_worker_ready, weak=False)
