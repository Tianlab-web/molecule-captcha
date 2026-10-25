from __future__ import annotations

import math
import random
from dataclasses import dataclass
from io import BytesIO
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from rdkit import Chem
from rdkit.Chem import AllChem
from rdkit.Chem.Draw import rdMolDraw2D

import config


@dataclass(frozen=True)
class RenderedImage:
    data: bytes
    mimetype: str
    extension: str


def _molecule(smiles: str) -> Chem.Mol:
    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        raise ValueError("Invalid SMILES")
    return molecule


def _draw_png(smiles: str) -> Image.Image:
    drawer = rdMolDraw2D.MolDraw2DCairo(config.IMAGE_WIDTH, config.IMAGE_HEIGHT)
    options = drawer.drawOptions()
    options.bondLineWidth = 2.2
    options.clearBackground = True
    options.padding = 0.075
    rdMolDraw2D.PrepareAndDrawMolecule(drawer, _molecule(smiles))
    drawer.FinishDrawing()
    return Image.open(BytesIO(drawer.GetDrawingText())).convert("RGB")


def _wave_distort(image: Image.Image, seed: int) -> Image.Image:
    rng = random.Random(seed)
    source = np.asarray(image.convert("RGB"), dtype=np.uint8)
    height, width = source.shape[:2]
    yy, xx = np.indices((height, width), dtype=np.float32)
    wavelength = max(float(config.WAVE_LENGTH), 1.0)
    source_x = np.rint(
        xx + config.WAVE_AMPLITUDE * np.sin(math.tau * yy / wavelength + rng.uniform(0, math.tau))
    ).astype(np.int32)
    source_y = np.rint(
        yy + config.WAVE_AMPLITUDE * np.sin(math.tau * xx / wavelength + rng.uniform(0, math.tau))
    ).astype(np.int32)
    source_x = np.clip(source_x, 0, width - 1)
    source_y = np.clip(source_y, 0, height - 1)
    distorted = source[source_y, source_x].astype(np.int16)
    if config.PIXEL_NOISE > 0:
        generator = np.random.default_rng(seed)
        jitter = generator.integers(
            -config.PIXEL_NOISE,
            config.PIXEL_NOISE + 1,
            size=(height, width, 1),
            dtype=np.int16,
        )
        distorted = np.clip(distorted + jitter, 0, 255)
    result = Image.fromarray(distorted.astype(np.uint8), "RGB")
    if config.BLUR_RADIUS > 0:
        result = result.filter(ImageFilter.GaussianBlur(config.BLUR_RADIUS))
    return result


def _add_png_noise(image: Image.Image, seed: int) -> Image.Image:
    rng = random.Random(seed)
    overlay = Image.new("RGBA", image.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    width, height = image.size
    line_alpha = max(0, min(255, round(config.NOISE_OPACITY * 255)))
    for _ in range(config.NOISE_SHAPE_COUNT):
        color = rng.choice((0, 35, 70, 100))
        draw.line(
            [
                (rng.randint(-width // 8, width + width // 8), rng.randint(0, height)),
                (rng.randint(-width // 8, width + width // 8), rng.randint(0, height)),
            ],
            fill=(color, color, color, line_alpha),
            width=rng.randint(1, 4),
        )
    triangle_alpha = max(0, min(255, round(config.TRIANGLE_OPACITY * 255)))
    for _ in range(config.TRIANGLE_COUNT):
        side = rng.uniform(24.0, 72.0)
        radius = side / math.sqrt(3)
        cx = rng.uniform(radius, width - radius)
        cy = rng.uniform(radius, height - radius)
        angle = rng.uniform(0, math.tau)
        points = [
            (
                cx + radius * math.cos(angle + index * math.tau / 3),
                cy + radius * math.sin(angle + index * math.tau / 3),
            )
            for index in range(3)
        ]
        color = rng.choice((0, 43, 74, 102))
        draw.line(points + [points[0]], fill=(color, color, color, triangle_alpha), width=3, joint="curve")
    base = image.convert("RGBA")
    base.alpha_composite(overlay)
    return base.convert("RGB")


def _render_distorted_png(smiles: str, seed: int) -> RenderedImage:
    image = _add_png_noise(_wave_distort(_draw_png(smiles), seed), seed)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return RenderedImage(buffer.getvalue(), "image/png", "png")


def _svg_noise(seed: int) -> str:
    rng = random.Random(seed)
    width, height = config.IMAGE_WIDTH, config.IMAGE_HEIGHT
    shapes: list[str] = []
    for _ in range(config.NOISE_SHAPE_COUNT):
        color = rng.choice(["#000000", "#2b2b2b", "#4a4a4a", "#666666"])
        if rng.choice([True, False]):
            x, y = rng.uniform(0, width), rng.uniform(0, height)
            bar_width = rng.uniform(width * 0.12, width * 0.35)
            bar_height = rng.uniform(3, 9)
            angle = rng.uniform(0, 180)
            shapes.append(
                f'<rect x="{x:.2f}" y="{y:.2f}" width="{bar_width:.2f}" height="{bar_height:.2f}" '
                f'fill="{color}" opacity="{config.NOISE_OPACITY:.2f}" '
                f'transform="rotate({angle:.2f} {x:.2f} {y:.2f})" />'
            )
        else:
            cx, cy = rng.uniform(0, width), rng.uniform(0, height)
            size, angle = rng.uniform(12, 38), rng.uniform(0, 360)
            points = [
                (
                    cx + size * 0.78 * math.cos(-math.pi / 2 + index * math.tau / 5),
                    cy + size * 0.78 * math.sin(-math.pi / 2 + index * math.tau / 5),
                )
                for index in range(5)
            ]
            point_text = " ".join(f"{px:.2f},{py:.2f}" for px, py in points)
            shapes.append(
                f'<polygon points="{escape(point_text)}" fill="none" stroke="{color}" '
                f'stroke-width="{rng.uniform(1.5, 4.0):.2f}" opacity="{config.NOISE_OPACITY:.2f}" '
                f'transform="rotate({angle:.2f} {cx:.2f} {cy:.2f})" />'
            )
    return "\n".join(shapes)


def _render_plain_svg(smiles: str, seed: int) -> RenderedImage:
    molecule = _molecule(smiles)
    AllChem.Compute2DCoords(molecule)
    drawer = rdMolDraw2D.MolDraw2DSVG(config.IMAGE_WIDTH, config.IMAGE_HEIGHT)
    options = drawer.drawOptions()
    options.clearBackground = False
    options.padding = 0.075
    drawer.DrawMolecule(molecule)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText()
    if "</svg>" not in svg:
        raise ValueError("RDKit returned invalid SVG")
    svg = svg.replace("</svg>", f'<g id="image-noise">{_svg_noise(seed)}</g></svg>', 1)
    return RenderedImage(svg.encode("utf-8"), "image/svg+xml", "svg")


def render_test_image(smiles: str, seed: int) -> RenderedImage:
    """按照 config.USE_DISTORTED_IMAGE 选择唯一的图片渲染路径。"""
    if config.USE_DISTORTED_IMAGE:
        return _render_distorted_png(smiles, seed)
    return _render_plain_svg(smiles, seed)
