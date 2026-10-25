# Molecule Generator

[中文版本](README.zh-CN.md)

The generator follows three steps:

1. `skeleton_enum.py`: enumerate carbon skeletons, then filter to acyclic or simple monocyclic structures.
2. `substitute.py`: find `CH2` positions and replace them with `O`, `S`, or `NH`.
3. `validate_dedupe.py`: RDKit sanitization, stereochemistry removal, canonical SMILES deduplication.

Install the generator dependency (the main app requirements already include RDKit):

```bash
pip install rdkit
```

Run from the project root (the directory containing flask_app and molecule_generator):

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --output molecules.smi
```

Acyclic only:

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --no-rings --output molecules.smi
```

The CLI defaults to at most 3 heteroatom substitutions. The Flask application
passes its own limit from flask_app/config.py (currently 2). Output paths are
relative to the current working directory; their parent directory must exist.
See [implementation notes](implementation.md) for the algorithm and limits.
