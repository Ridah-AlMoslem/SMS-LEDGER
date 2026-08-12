"""SMS ledger parsing core.

Pure stdlib. No third-party dependencies, no I/O, no database access — this
package turns message text into ledger entries and nothing else. Persistence
and transport live in the FastAPI service that imports it.

Pipeline order: ingest → dedup → classify → match → extract → date → resolve
→ post → link.
"""

from .pipeline import Pipeline

__all__ = ["Pipeline"]
