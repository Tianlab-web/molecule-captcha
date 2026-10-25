from __future__ import annotations

import argparse
from pathlib import Path

try:
    from .skeleton_enum import CarbonSkeletonConfig, enumerate_carbon_skeletons
    from .substitute import enumerate_ch2_substitutions
    from .validate_dedupe import dedupe_molecules
except ImportError:
    # 兼容直接运行 ``python main.py`` 的命令行用法。
    from skeleton_enum import CarbonSkeletonConfig, enumerate_carbon_skeletons
    from substitute import enumerate_ch2_substitutions
    from validate_dedupe import dedupe_molecules


def generate_library(
    heavy_atoms: int,
    max_hetero_atoms: int,
    allow_single_ring: bool,
) -> list[str]:
    skeletons = enumerate_carbon_skeletons(
        CarbonSkeletonConfig(
            heavy_atoms=heavy_atoms,
            allow_single_ring=allow_single_ring,
        )
    )

    candidates = []
    for skeleton in skeletons:
        candidates.extend(
            enumerate_ch2_substitutions(
                skeleton,
                max_hetero_atoms=max_hetero_atoms,
            )
        )

    return dedupe_molecules(candidates, max_rings=1 if allow_single_ring else 0)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate non-stereochemical small-molecule SMILES from carbon skeletons."
    )
    parser.add_argument("--heavy-atoms", type=int, required=True)
    parser.add_argument("--max-hetero", type=int, default=3)
    parser.add_argument("--no-rings", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    smiles = generate_library(
        heavy_atoms=args.heavy_atoms,
        max_hetero_atoms=args.max_hetero,
        allow_single_ring=not args.no_rings,
    )

    text = "\n".join(smiles)
    if text:
        text += "\n"

    if args.output:
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
