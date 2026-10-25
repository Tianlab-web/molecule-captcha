# 分子结构绘图行为测试

[English](README.md)

本项目是一个 Flask 应用，将分子图片验证码、Ketcher 手工绘图、RDKit 结构校验和服务端行为检测整合在一起。

## 使用示例视频

[观看使用示例（MP4）](使用示例.mp4)。说明视频已随源码一并提供。

## 本地运行

在项目根目录执行：

~~~bash
pip install -r flask_app/requirements.txt
python flask_app/app.py
~~~

浏览器打开 http://127.0.0.1:5019/。页面默认使用英文，可通过右上角按钮切换为中文；在地址后添加 ?lang=zh 可直接进入中文模式。

选择分子库案例或自动生成分子案例，观察目标图片后开始检测，并在右侧编辑器中手工复现结构。系统分别判断结构正确性与绘图行为。检测完成后可查看结果，并导出汇总判定图、操作时间线图两张 PNG 图片。

## 目录结构

~~~text
flask_app/
  app.py, wsgi.py              本地开发入口和生产部署入口
  config.py                   渲染、计时、协议和限流配置
  attention_check.py          一次性限时点击验证协议
  attention_image.py          按语言生成限时点击提示图集
  attention_assets/           中英文 PNG 箭头图片
  security_*.py               证据校验、行为评分和防重放索引
  rendering/                  分子 PNG / SVG 图片渲染
  static/                     页面、编辑器扩展和行为监测脚本
  data/smiles_pool.json        验证码分子题库
  data/reports/               私有运行审计数据，按需自动创建
molecule_generator/           骨架枚举、杂原子替换、校验和命令行工具
ketcher/                      必需的编辑器构建文件及预压缩资源
docs/                         项目架构说明
~~~


## 配置

修改 flask_app/config.py 后需重启服务。

- USE_DISTORTED_IMAGE=True：生成扭曲 PNG；False：生成叠加干扰的非扭曲 SVG。
- PORT：本地监听端口，默认为 5019。
- AUTO_GENERATOR_*：重原子数候选值（默认 8、9、10）、杂原子替换数量和环结构限制。首次枚举结果会缓存，结构越大通常耗时越长。
- ATOM_SURPRISE_*：元素干扰初始概率为 40%，每次有效操作未触发则增加 10 个百分点，最高 100%；触发后立即恢复 40%，无冷却。
- DRAWING_*：由服务端计时的绘制时间限制。

报告时间使用北京时间 Asia/Shanghai（+08:00），不会自动改写已有报告。

项目结构和运行原理见[中文架构说明](docs/architecture.zh-CN.md)，分子枚举工具见[中文生成器说明](molecule_generator/README.zh-CN.md)。
