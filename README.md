# Molecular Drawing Behavior Test

[中文版本](README.zh-CN.md)

A Flask application combining molecular image challenges, manual drawing in
Ketcher, RDKit structure verification and server-side behavior checks.

## Demo video

[Watch the usage example (MP4)](使用示例.mp4). The video is included in this repository.

## Run locally

From the project root:

~~~bash
pip install -r flask_app/requirements.txt
python flask_app/app.py
~~~

Open http://127.0.0.1:5019/. English is the default; the upper-right language
button switches to Chinese. ?lang=zh opens Chinese directly.

Choose a library or automatically generated molecule, study the image, then start
detection and reproduce it in the editor on the right. Structure correctness and
drawing behavior are evaluated separately. Results and two PNG report exports
are available after completion.

## Layout

~~~text
flask_app/
  app.py, wsgi.py              Development and production entry points
  config.py                   Rendering, timing, protocol and rate-limit settings
  attention_check.py          One-use timed click protocol
  attention_image.py          Language-aware attention atlas rendering
  attention_assets/           Chinese and English PNG arrow tiles
  security_*.py               Evidence validation, scoring and replay index
  rendering/                  Molecular PNG/SVG rendering
  static/                     Page, editor extensions and behavior monitor
  data/smiles_pool.json        Challenge molecule library
  data/reports/               Private runtime audit data (created on demand)
molecule_generator/           Enumeration, substitutions, validation and CLI
ketcher/                      Required editor build and compressed assets
docs/                         Project architecture
~~~


## Configuration

Edit flask_app/config.py and restart the service.

- USE_DISTORTED_IMAGE=True: distorted PNG; False: undistorted SVG with noise.
- PORT: local listening port, default 5019.
- AUTO_GENERATOR_*: heavy atom counts (default 8, 9, 10), heteroatom and ring limits.
  First-use enumeration is cached; larger structures take longer to enumerate.
- ATOM_SURPRISE_*: element interference starts at 40%, increases by 10 percentage points after each eligible operation without a trigger, and caps at 100%. Each trigger immediately resets the probability to 40%, with no cooldown.
- DRAWING_*: server-measured drawing time limits.

Report times use Asia/Shanghai (+08:00). Existing reports are not rewritten.

See [architecture](docs/architecture.md) for the project design and [molecule generator](molecule_generator/README.md) for enumeration details.
