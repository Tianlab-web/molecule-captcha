from __future__ import annotations

from typing import Iterable

from rdkit import Chem


def sanitize_mol(mol: Chem.Mol) -> Chem.Mol | None:
    """Return a sanitized copy, or None if RDKit rejects the molecule."""
    try:
        copy = Chem.Mol(mol)
        Chem.SanitizeMol(copy)
        return copy
    except Exception:
        return None


def has_only_simple_rings(mol: Chem.Mol, max_rings: int = 1) -> bool:
    ring_info = mol.GetRingInfo()
    if ring_info.NumRings() > max_rings:
        return False

    # With max_rings <= 1 this already excludes bridged, fused, and spiro systems.
    if max_rings <= 1:
        return True

    atom_ring_counts = {}
    for ring in ring_info.AtomRings():
        for atom_idx in ring:
            atom_ring_counts[atom_idx] = atom_ring_counts.get(atom_idx, 0) + 1
    return all(count <= 1 for count in atom_ring_counts.values())


def canonical_smiles(mol: Chem.Mol, remove_stereo: bool = True) -> str | None:
    clean = sanitize_mol(mol)
    if clean is None:
        return None

    if remove_stereo:
        Chem.RemoveStereochemistry(clean)

    return Chem.MolToSmiles(clean, canonical=True, isomericSmiles=not remove_stereo)


def dedupe_molecules(mols: Iterable[Chem.Mol], max_rings: int = 1) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []

    for mol in mols:
        clean = sanitize_mol(mol)
        if clean is None:
            continue
        if not has_only_simple_rings(clean, max_rings=max_rings):
            continue

        smiles = canonical_smiles(clean, remove_stereo=True)
        if smiles is None or smiles in seen:
            continue

        seen.add(smiles)
        result.append(smiles)

    return sorted(result)
