"""Precompute and persist trend statistics for all datasets and indices.

Run independently:
  python backend/scripts/precompute_trends.py
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str((ROOT / "backend").resolve()))

from app.datasets_store import (  # noqa: E402
    list_datasets,
    fetch_meta,
    precompute_trend_stats,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Precompute trend stats for all features")
    parser.add_argument("--level", help="Optional single dataset key")
    parser.add_argument("--index", help="Optional single index name")
    args = parser.parse_args()

    datasets = [d["key"] for d in list_datasets()]
    if args.level:
        datasets = [args.level]

    if not datasets:
        raise SystemExit("No datasets found. Run import first.")

    total_pairs = 0
    total_rows = 0
    for ds in datasets:
        meta = fetch_meta(ds)
        indices = list(meta.get("indices") or [])
        if args.index:
            indices = [args.index]

        for idx in indices:
            count = precompute_trend_stats(dataset_key=ds, index=idx)
            total_pairs += 1
            total_rows += count
            print(f"[{ds}] {idx}: {count:,} feature trends precomputed")

    print(f"Done. pairs={total_pairs}, total_feature_trends={total_rows:,}")


if __name__ == "__main__":
    main()
