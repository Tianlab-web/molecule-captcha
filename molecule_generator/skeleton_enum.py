from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from rdkit import Chem

try:
    from .validate_dedupe import canonical_smiles, has_only_simple_rings, sanitize_mol
except ImportError:
    # 兼容直接运行本文件。
    from validate_dedupe import canonical_smiles, has_only_simple_rings, sanitize_mol


@dataclass(frozen=True)
class CarbonSkeletonConfig:
    heavy_atoms: int
    allow_single_ring: bool = True
    max_degree: int = 4


def _make_carbon_mol(atom_count: int, edges: frozenset[tuple[int, int]]) -> Chem.Mol:
    rw = Chem.RWMol()
    for _ in range(atom_count):
        rw.AddAtom(Chem.Atom("C"))
    for a, b in sorted(edges):
        rw.AddBond(a, b, Chem.BondType.SINGLE)
    return rw.GetMol()


def _edge(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _tree_edges(
    atom_count: int,
    edges: frozenset[tuple[int, int]],
    degrees: tuple[int, ...],
    target_atoms: int,
    max_degree: int,
    seen_partial: set[str],
) -> Iterator[frozenset[tuple[int, int]]]:
    if atom_count == target_atoms:
        yield edges
        return

    new_idx = atom_count
    for parent in range(atom_count):
        if degrees[parent] >= max_degree:
            continue

        next_edges = frozenset((*edges, _edge(parent, new_idx)))
        next_degrees = list(degrees) + [1]
        next_degrees[parent] += 1

        # Deduplicate partial carbon trees early using canonical SMILES.
        partial = _make_carbon_mol(new_idx + 1, next_edges)
        partial_smiles = canonical_smiles(partial)
        if partial_smiles is None or partial_smiles in seen_partial:
            continue
        seen_partial.add(partial_smiles)

        yield from _tree_edges(
            atom_count=new_idx + 1,
            edges=next_edges,
            degrees=tuple(next_degrees),
            target_atoms=target_atoms,
            max_degree=max_degree,
            seen_partial=seen_partial,
        )


def _add_single_ring_edges(
    atom_count: int,
    tree_edges: frozenset[tuple[int, int]],
    max_degree: int,
) -> Iterator[frozenset[tuple[int, int]]]:
    degrees = [0] * atom_count
    existing = set(tree_edges)
    for a, b in tree_edges:
        degrees[a] += 1
        degrees[b] += 1

    for a in range(atom_count):
        if degrees[a] >= max_degree:
            continue
        for b in range(a + 1, atom_count):
            if degrees[b] >= max_degree:
                continue
            if _edge(a, b) in existing:
                continue

            candidate_edges = frozenset((*tree_edges, _edge(a, b)))
            mol = sanitize_mol(_make_carbon_mol(atom_count, candidate_edges))
            if mol is None:
                continue
            if has_only_simple_rings(mol, max_rings=1):
                yield candidate_edges


def enumerate_carbon_skeletons(config: CarbonSkeletonConfig) -> list[str]:
    if config.heavy_atoms < 1:
        raise ValueError("heavy_atoms must be >= 1")

    trees = list(
        _tree_edges(
            atom_count=1,
            edges=frozenset(),
            degrees=(0,),
            target_atoms=config.heavy_atoms,
            max_degree=config.max_degree,
            seen_partial=set(),
        )
    )

    skeleton_smiles: set[str] = set()
    for edges in trees:
        mol = _make_carbon_mol(config.heavy_atoms, edges)
        smiles = canonical_smiles(mol)
        if smiles is not None:
            skeleton_smiles.add(smiles)

        if not config.allow_single_ring or config.heavy_atoms < 3:
            continue

        for ring_edges in _add_single_ring_edges(config.heavy_atoms, edges, config.max_degree):
            ring_mol = _make_carbon_mol(config.heavy_atoms, ring_edges)
            ring_smiles = canonical_smiles(ring_mol)
            if ring_smiles is not None:
                skeleton_smiles.add(ring_smiles)

    return sorted(skeleton_smiles)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Enumerate simple carbon skeletons.")
    parser.add_argument("--heavy-atoms", type=int, required=True)
    parser.add_argument("--no-rings", action="store_true")
    args = parser.parse_args()

    config = CarbonSkeletonConfig(
        heavy_atoms=args.heavy_atoms,
        allow_single_ring=not args.no_rings,
    )
    for smiles in enumerate_carbon_skeletons(config):
        print(smiles)
