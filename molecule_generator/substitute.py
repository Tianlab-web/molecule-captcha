from __future__ import annotations

from itertools import combinations, product
from typing import Iterator

from rdkit import Chem

try:
    from .validate_dedupe import sanitize_mol
except ImportError:
    # 兼容直接运行本文件。
    from validate_dedupe import sanitize_mol


HETERO_ATOMS = {
    "O": 8,
    "S": 16,
    "NH": 7,
}


def find_ch2_positions(mol: Chem.Mol) -> list[int]:
    clean = sanitize_mol(mol)
    if clean is None:
        return []

    positions: list[int] = []
    for atom in clean.GetAtoms():
        if atom.GetAtomicNum() != 6:
            continue
        if atom.GetDegree() != 2:
            continue
        if atom.GetTotalNumHs() != 2:
            continue
        if atom.GetIsAromatic():
            continue
        positions.append(atom.GetIdx())
    return positions


def replace_atoms(mol: Chem.Mol, replacements: dict[int, str]) -> Chem.Mol | None:
    rw = Chem.RWMol(mol)
    for atom_idx, label in replacements.items():
        atom = rw.GetAtomWithIdx(atom_idx)
        atom.SetAtomicNum(HETERO_ATOMS[label])
        atom.SetFormalCharge(0)
        atom.SetNoImplicit(False)
        atom.SetNumExplicitHs(0)

    return sanitize_mol(rw.GetMol())


def enumerate_ch2_substitutions(
    skeleton_smiles: str,
    max_hetero_atoms: int = 3,
    allowed_replacements: tuple[str, ...] = ("O", "S", "NH"),
) -> Iterator[Chem.Mol]:
    mol = Chem.MolFromSmiles(skeleton_smiles)
    if mol is None:
        return

    positions = find_ch2_positions(mol)

    # Keep the original carbon skeleton too.
    clean = sanitize_mol(mol)
    if clean is not None:
        yield clean

    max_count = min(max_hetero_atoms, len(positions))
    for count in range(1, max_count + 1):
        for chosen_positions in combinations(positions, count):
            for labels in product(allowed_replacements, repeat=count):
                replacements = dict(zip(chosen_positions, labels))
                candidate = replace_atoms(mol, replacements)
                if candidate is not None:
                    yield candidate


if __name__ == "__main__":
    import argparse

    from validate_dedupe import dedupe_molecules

    parser = argparse.ArgumentParser(description="Replace CH2 positions by O, S, or NH.")
    parser.add_argument("skeleton_smiles")
    parser.add_argument("--max-hetero", type=int, default=3)
    args = parser.parse_args()

    mols = enumerate_ch2_substitutions(args.skeleton_smiles, max_hetero_atoms=args.max_hetero)
    for smiles in dedupe_molecules(mols, max_rings=1):
        print(smiles)
