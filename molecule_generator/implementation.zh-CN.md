# 分子生成器实现说明（中文版）

[原版说明](implementation.md)

这个模块是一个基于 RDKit 的小分子 SMILES 生成器。本文所有命令均在项目根目录（包含 flask_app 和 molecule_generator 的目录）执行。
文中的 main.py 等模块名指 molecule_generator 目录内的文件。

独立 CLI 的 --max-hetero 默认为 3；Flask 应用会显式传入 flask_app/config.py 的 AUTO_GENERATOR_MAX_HETERO_ATOMS，当前值为 2。
--output 的相对路径以运行命令的目录为准，父目录需预先存在。生成结果是符合当前枚举与 RDKit 价态规则的候选结构，不表示已经验证稳定性或可合成性。

整体思路是：

```text
命令行参数
  -> 枚举指定重原子数的纯碳骨架
  -> 可选地加入简单单环骨架
  -> 找每个骨架里的 CH2 位点
  -> 把 CH2 枚举替换成 O / S / NH
  -> RDKit 校验合法性
  -> 限制环数量
  -> 去掉立体信息
  -> canonical SMILES 去重
  -> 输出到文件或终端
```

项目的主入口是 `main.py`，它本身主要负责调度流程。真正的生成逻辑分散在三个模块里：

```text
main.py              命令行入口，串联完整生成流程
skeleton_enum.py     生成纯碳骨架，包括无环骨架和简单单环骨架
substitute.py        把骨架中的 CH2 位点替换为 O、S、NH
validate_dedupe.py   RDKit 分子校验、去立体化、canonical SMILES 去重
```

## 1. main.py 主流程

`main.py` 里最核心的函数是：

```python
def generate_library(
    heavy_atoms: int,
    max_hetero_atoms: int,
    allow_single_ring: bool,
) -> list[str]:
```

这个函数负责生成最终的 SMILES 分子库。

它的执行步骤是：

1. 调用 `enumerate_carbon_skeletons` 生成纯碳骨架。
2. 对每一个碳骨架调用 `enumerate_ch2_substitutions`，枚举杂原子替换。
3. 调用 `dedupe_molecules` 对所有候选分子做校验、过滤和去重。

对应代码逻辑如下：

```python
skeletons = enumerate_carbon_skeletons(
    CarbonSkeletonConfig(
        heavy_atoms=heavy_atoms,
        allow_single_ring=allow_single_ring,
    )
)
```

这一步生成指定重原子数的碳骨架。

然后：

```python
candidates = []
for skeleton in skeletons:
    candidates.extend(
        enumerate_ch2_substitutions(
            skeleton,
            max_hetero_atoms=max_hetero_atoms,
        )
    )
```

这一步对每个骨架进行杂原子替换。

最后：

```python
return dedupe_molecules(candidates, max_rings=1 if allow_single_ring else 0)
```

如果允许单环，就保留最多 1 个环的分子；如果不允许环，就只保留无环分子。

## 2. 命令行参数

`main.py` 使用 `argparse` 解析命令行参数：

```python
parser.add_argument("--heavy-atoms", type=int, required=True)
parser.add_argument("--max-hetero", type=int, default=3)
parser.add_argument("--no-rings", action="store_true")
parser.add_argument("--output", type=Path)
```

参数含义如下：

```text
--heavy-atoms   必填，指定重原子总数
--max-hetero    最多允许替换多少个杂原子，默认是 3
--no-rings      禁止生成含环分子，只保留无环结构
--output        输出文件路径，如果不传则打印到终端
```

示例：

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --output molecules.smi
```

这表示生成重原子数为 8、最多 3 个杂原子替换、允许简单单环结构的分子库。

如果只想生成无环分子：

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --no-rings --output molecules.smi
```

## 3. skeleton_enum.py：碳骨架枚举

`skeleton_enum.py` 负责生成纯碳结构，也就是还没有引入 O、S、N 之前的碳骨架。

配置类是：

```python
@dataclass(frozen=True)
class CarbonSkeletonConfig:
    heavy_atoms: int
    allow_single_ring: bool = True
    max_degree: int = 4
```

字段含义：

```text
heavy_atoms         碳原子数量，也就是骨架大小
allow_single_ring   是否允许生成简单单环结构
max_degree          单个碳原子最大连接数，默认是 4
```

核心入口是：

```python
def enumerate_carbon_skeletons(config: CarbonSkeletonConfig) -> list[str]:
```

它主要做两件事：

1. 先生成所有无环碳骨架。
2. 如果允许单环，再尝试在无环骨架上额外加一条边，形成简单单环。

### 3.1 生成无环碳骨架

无环骨架由 `_tree_edges` 递归生成。

这里的“树”是图论里的树结构，表示没有环的连接图。对于分子来说，可以理解成链状或支链状的纯碳结构。

递归过程从 1 个碳开始：

```python
atom_count=1
edges=frozenset()
degrees=(0,)
```

然后每次新增一个碳原子，并尝试把它连接到已有碳原子上：

```python
new_idx = atom_count
for parent in range(atom_count):
```

如果某个已有碳原子的连接数已经达到 `max_degree`，就不能继续连接：

```python
if degrees[parent] >= max_degree:
    continue
```

为了避免重复骨架，代码会把当前部分结构转成 canonical SMILES：

```python
partial_smiles = canonical_smiles(partial)
```

如果这个中间结构已经见过，就跳过：

```python
if partial_smiles is None or partial_smiles in seen_partial:
    continue
```

这一步非常重要，因为同一个分子图可能因为原子编号不同而被重复生成。canonical SMILES 可以把等价结构统一成同一个字符串。

### 3.2 生成简单单环骨架

如果 `allow_single_ring=True`，并且重原子数不少于 3，代码会尝试在已有无环骨架上额外加一条边：

```python
for ring_edges in _add_single_ring_edges(...):
```

加一条额外边后，树结构就可能变成一个环。

`_add_single_ring_edges` 会检查：

1. 两个原子是否都还没有超过最大连接数。
2. 这条边是否已经存在。
3. RDKit 是否能接受这个分子。
4. 是否最多只有一个简单环。

关键过滤代码是：

```python
if has_only_simple_rings(mol, max_rings=1):
    yield candidate_edges
```

所以这里不会保留复杂多环结构。

## 4. substitute.py：CH2 杂原子替换

`substitute.py` 负责把碳骨架中的部分 `CH2` 位置替换成杂原子。

允许替换的杂原子定义为：

```python
HETERO_ATOMS = {
    "O": 8,
    "S": 16,
    "NH": 7,
}
```

也就是说，程序会尝试把部分碳换成氧、硫或氮。

核心入口是：

```python
def enumerate_ch2_substitutions(
    skeleton_smiles: str,
    max_hetero_atoms: int = 3,
    allowed_replacements: tuple[str, ...] = ("O", "S", "NH"),
) -> Iterator[Chem.Mol]:
```

### 4.1 找到可替换的 CH2 位点

函数 `find_ch2_positions` 会扫描分子中的所有原子，只保留满足下面条件的碳原子：

```text
原子是碳
连接度 degree == 2
总氢数 == 2
不是芳香原子
```

对应代码是：

```python
if atom.GetAtomicNum() != 6:
    continue
if atom.GetDegree() != 2:
    continue
if atom.GetTotalNumHs() != 2:
    continue
if atom.GetIsAromatic():
    continue
```

所以它替换的是典型的 `-CH2-` 位点，不会随意替换所有碳。

### 4.2 枚举替换组合

程序会先保留原始碳骨架：

```python
yield clean
```

然后根据 `max_hetero_atoms` 决定最多替换几个位置：

```python
max_count = min(max_hetero_atoms, len(positions))
```

接着从 1 个替换位点开始枚举，直到最大替换数量：

```python
for count in range(1, max_count + 1):
```

对于每个替换数量，先枚举位置组合：

```python
for chosen_positions in combinations(positions, count):
```

再枚举每个位置具体替换成 O、S 还是 NH：

```python
for labels in product(allowed_replacements, repeat=count):
```

举例来说，如果有 3 个可替换的 `CH2` 位点，最多替换 2 个，那么会枚举：

```text
替换第 1 个
替换第 2 个
替换第 3 个
替换第 1、2 个
替换第 1、3 个
替换第 2、3 个
```

每个位置又分别可以是 `O`、`S` 或 `NH`。

### 4.3 真正替换原子

替换动作发生在 `replace_atoms` 中：

```python
atom.SetAtomicNum(HETERO_ATOMS[label])
atom.SetFormalCharge(0)
atom.SetNoImplicit(False)
atom.SetNumExplicitHs(0)
```

这里本质上是把某个碳原子的原子序号改成目标杂原子的原子序号。

例如：

```text
O   -> 原子序号 8
S   -> 原子序号 16
NH  -> 原子序号 7
```

替换后会调用：

```python
sanitize_mol(rw.GetMol())
```

让 RDKit 判断这个分子是否合法。如果价态等规则不合理，就会返回 `None`，这个候选结构会被丢弃。

## 5. validate_dedupe.py：校验、过滤和去重

`validate_dedupe.py` 是整个项目里的质量控制模块。

### 5.1 sanitize_mol

```python
def sanitize_mol(mol: Chem.Mol) -> Chem.Mol | None:
```

这个函数会复制一份分子，然后调用：

```python
Chem.SanitizeMol(copy)
```

如果 RDKit 接受这个分子，就返回清理后的分子；如果 RDKit 报错，就返回 `None`。

它的作用是过滤掉价态错误、不合法或 RDKit 无法解释的结构。

### 5.2 has_only_simple_rings

```python
def has_only_simple_rings(mol: Chem.Mol, max_rings: int = 1) -> bool:
```

这个函数检查分子中的环数量。

如果环数量超过 `max_rings`，直接返回 `False`：

```python
if ring_info.NumRings() > max_rings:
    return False
```

当 `max_rings <= 1` 时，只要不超过一个环就接受。

因此：

```text
max_rings=0  只允许无环分子
max_rings=1  允许无环或简单单环分子
```

### 5.3 canonical_smiles

```python
def canonical_smiles(mol: Chem.Mol, remove_stereo: bool = True) -> str | None:
```

这个函数先对分子做 sanitize，然后默认移除立体化学信息：

```python
Chem.RemoveStereochemistry(clean)
```

最后转成 canonical SMILES：

```python
Chem.MolToSmiles(clean, canonical=True, isomericSmiles=not remove_stereo)
```

所以这个项目生成的是非立体化学的小分子结构库。两个只有手性或构型不同、但连接关系相同的结构，最终会被视为同一个。

### 5.4 dedupe_molecules

```python
def dedupe_molecules(mols: Iterable[Chem.Mol], max_rings: int = 1) -> list[str]:
```

这个函数负责最终收口：

1. 对每个候选分子做 RDKit sanitize。
2. 检查环数量是否符合要求。
3. 转成 canonical SMILES。
4. 用 `seen` 集合去重。
5. 返回排序后的 SMILES 列表。

核心逻辑是：

```python
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
```

## 6. 一个完整例子

假设运行：

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --output molecules.smi
```

程序会执行：

```text
1. 生成所有 8 个碳的无环骨架
2. 如果允许环，继续生成 8 个碳的简单单环骨架
3. 对每个骨架找 CH2 位点
4. 在这些 CH2 位点上枚举最多 3 个 O/S/NH 替换
5. 用 RDKit 过滤非法结构
6. 过滤掉超过 1 个环的结构
7. 移除立体化学信息
8. 转成 canonical SMILES 去重
9. 写入 molecules.smi
```

如果运行：

```bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --no-rings --output molecules.smi
```

区别是：

```text
1. 碳骨架阶段不生成单环结构
2. 最后 dedupe 时 max_rings=0
3. 最终只保留无环分子
```

## 7. 总结

这个程序本质上是一个“碳骨架枚举 + CH2 杂原子替换”的小分子库生成工具。

它的生成边界比较明确：

```text
只从纯碳骨架开始
只替换 CH2 位点
只替换成 O、S、NH
默认最多允许 3 个杂原子
默认允许无环和简单单环
最终输出非立体化学 canonical SMILES
```

因此，它适合生成一批结构相对简单、规则清晰、可被 RDKit 校验的小分子候选库。
