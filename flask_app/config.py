"""项目运行配置。

这里只放普通使用者最常调整的参数。修改后需要重启 Flask 服务才会生效。
布尔值只能写 ``True`` 或 ``False``，首字母必须大写，不要加引号。
"""

# Flask 服务监听端口。
# 启动后访问地址为 http://127.0.0.1:5019/
PORT = 5019

# 是否生成“扭曲”分子图片，这是控制图片模式的总开关。
#
# True：
#   输出 PNG。分子键线会经过波形扭曲，并叠加轻微像素噪声、随机线条和空心三角形。
#   这种模式更难被普通图像识别程序直接读取。
#
# False：
#   输出 SVG。分子保持 RDKit 计算出的原始二维结构，不改变原子与化学键的位置；
#   只叠加低透明度的线条和五边形干扰，实现在 rendering/image_renderer.py。
#
# 如果只是想查看清晰的原始结构，请改成 False。
USE_DISTORTED_IMAGE = True

# 测试图片尺寸。当前网页卡片采用横向比例，建议保持 12:7 左右。
IMAGE_WIDTH = 720
IMAGE_HEIGHT = 420

# 一次测试会话的有效时间，单位为秒。30 * 60 表示 30 分钟。
SESSION_TTL_SECONDS = 30 * 60

# 原子干扰：初始 40%，每次有效操作未触发则增加 10 个百分点，最高 100%。
# 每次触发后立即回到 40%，无冷却；0 表示禁用额外的首次强制触发规则。
ATOM_SURPRISE_INITIAL_PROBABILITY = 0.40
ATOM_SURPRISE_INCREMENT = 0.10
ATOM_SURPRISE_FIRST_FORCE_AT = 0
ATOM_SURPRISE_REPEAT_PROBABILITY = 0.40
ATOM_SURPRISE_MAX_PROBABILITY = 1.0
ATOM_SURPRISE_COOLDOWN_STEPS = 0

# 绘制时间由服务端计时，页面不显示时限。8 个重原子 30 秒，每个增减 5 秒。
# 极小分子的计算时限最低为 0 秒；用时 <= 10 秒完成按机器人处理。
DRAWING_REFERENCE_HEAVY_ATOMS = 8
DRAWING_REFERENCE_SECONDS = 30
DRAWING_SECONDS_PER_ATOM = 5
DRAWING_MIN_SECONDS = 10

# “自动生成分子案例”的重原子数量候选值。
# 系统每次出题会从这些数值中随机选择一个，再调用 molecule_generator。
# 首次生成耗时取决于机器性能、重原子数和替换参数，结果会留在内存缓存中；
# 9、10 个重原子的枚举数量较多，服务重启后的首次出题可能较慢。
AUTO_GENERATOR_HEAVY_ATOMS = (8, 9, 10)

# 自动生成分子中最多允许用 O、S、NH 替换多少个 CH2 位点。
AUTO_GENERATOR_MAX_HETERO_ATOMS = 2

# True：允许无环结构和简单单环结构；False：只生成无环结构。
AUTO_GENERATOR_ALLOW_SINGLE_RING = True

# 干扰图形数量和透明度。透明度范围是 0.0 到 1.0。
# 数值越大，干扰越明显；修改这些值不会改变分子结构本身。
NOISE_SHAPE_COUNT = 14
NOISE_OPACITY = 0.10

# 扭曲模式专用参数。无扭曲 SVG 模式不会使用这些值。
WAVE_AMPLITUDE = 18.0       # 波形位移幅度，越大弯曲越明显
WAVE_LENGTH = 300.0         # 波长，越小则弯曲变化越密集
PIXEL_NOISE = 6             # 像素明暗扰动强度，0 表示关闭
BLUR_RADIUS = 0.35          # 高斯模糊半径，0 表示关闭
TRIANGLE_COUNT = 8          # 空心三角形数量
TRIANGLE_OPACITY = 0.16     # 空心三角形透明度


# 安全协议 v3：需同步更新前后端。客户端材料仅证明内部一致，不证明真人。
CHECKPOINT_INTERVAL_MS = 1500
CHECKPOINT_MAX_GAP_SECONDS = 30
MAX_CHECKPOINTS = 1500
MAX_ACTIVE_CHALLENGES = 256
MAX_ACTIVE_SESSIONS = 128
CHALLENGES_PER_MINUTE = 20
SESSIONS_PER_MINUTE = 20

# 只有受信任反向代理且服务端口不直通公网时设为 1；本地默认不信任转发头。
import os as _os
TRUST_PROXY_HEADERS = _os.environ.get("MOLECULE_CAPTCHA_TRUST_PROXY", "0") == "1"
