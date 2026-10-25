"""Transparent arrow atlas; only the selected tile has visible pixels.

Every candidate gets the same DOM/image treatment. This hides an explicit target
field, but bitmap inspection and fabricated client events remain possible.
"""
import base64
import hashlib
import secrets
from io import BytesIO
from pathlib import Path
from PIL import Image

WIDTH, TILE_HEIGHT = 360, 128
LEFT = ('bonds', 'chain', 'charge-plus', 'charge-minus')
ATOMS = ('H','C','N','O','S','P','F','Cl','Br','I','B','Si','Se','Li','Na','Mg','Fe','Zn')
TARGETS = tuple((key,'left') for key in LEFT) + tuple(('atom:'+key,'right') for key in ATOMS) + tuple(('template-'+str(i),'down') for i in range(8))
HEIGHT = TILE_HEIGHT * len(TARGETS)
# Extended atoms can lie below the toolbar scroll viewport on ordinary laptops.
# Keep their tiles for coordinate validation, but select from always-visible tools.
ELIGIBLE = tuple(range(14)) + tuple(range(22,30))


def make_scene():
    slots=[]
    for i,(label,side) in enumerate(TARGETS):
        x = 4 if side=='left' else 324 if side=='right' else min(8+36*int(label.split('-')[1]),164)
        y = 96 if side=='down' else 48
        slots.append(dict(label=label,side=side,x=x,y=i*TILE_HEIGHT+y,width=32,height=32))
    return dict(width=WIDTH,height=HEIGHT,slots=slots,selected=secrets.choice(ELIGIBLE))


def render(scene, language='en'):
    index=scene['selected'];target=scene['slots'][index]
    variant=target['side'] if target['side']!='down' else 'down-'+target['label'].split('-')[1]
    suffix = '' if language == 'zh' else '-en'
    with Image.open(Path(__file__).with_name('attention_assets')/(variant+suffix+'.png')) as arrow:
        image=Image.new('RGBA',(WIDTH,HEIGHT))
        image.paste(arrow,(0,index*TILE_HEIGHT))
    stream=BytesIO();image.save(stream,format='PNG')
    data=stream.getvalue()
    return dict(image='data:image/png;base64,'+base64.b64encode(data).decode('ascii'),imageSha256=hashlib.sha256(data).hexdigest())
