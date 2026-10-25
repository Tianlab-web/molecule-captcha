# 分子生成器

[English](README.md)

生成器分为三个步骤：

1. skeleton_enum.py：枚举碳骨架，保留无环或简单单环结构。
2. substitute.py：查找 CH2 位点，并将其替换为 O、S 或 NH。
3. validate_dedupe.py：执行 RDKit 合法性校验、去除立体化学信息，并按规范 SMILES 去重。

## 安装依赖

单独使用生成器时需要 RDKit；主应用的 requirements.txt 已包含此依赖。

~~~bash
pip install rdkit
~~~

## 使用方法

以下命令均在项目根目录执行，即包含 flask_app 和 molecule_generator 的目录。

生成允许无环和简单单环的分子库：

~~~bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --output molecules.smi
~~~

仅生成无环分子：

~~~bash
python molecule_generator/main.py --heavy-atoms 8 --max-hetero 3 --no-rings --output molecules.smi
~~~

命令行默认最多替换 3 个杂原子；Flask 应用会显式传入 flask_app/config.py 中的上限，当前为 2。

输出文件的相对路径以当前工作目录为准，父目录需要预先存在。

算法和生成范围见[中文实现说明](implementation.zh-CN.md)。
