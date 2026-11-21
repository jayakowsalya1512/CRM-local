"""Release version of the code this process is running.

The deployment service writes the release version to backend/VERSION when it installs a release; the file is read once
at import, so the value describes the code that was loaded, not whatever is on disk later. Without the file (a
development checkout or a server deployed by hand) the version falls back to APP_VERSION.
"""

from app.core.config import BASE_DIR, settings


def _version_file() -> str:
    try:
        return (BASE_DIR / "VERSION").read_text(encoding="utf-8").strip()[:40]
    except OSError:
        return ""


_FILE_VERSION = _version_file()
RUNNING_VERSION = _FILE_VERSION or settings.APP_VERSION
VERSION_SOURCE = "VERSION file" if _FILE_VERSION else "APP_VERSION setting"
