"""
Build optimised Earth textures into public/textures from source images.

Sources (download into SRC dir first):
  8k_earth_daymap.jpg, 8k_earth_nightmap.jpg, 8k_earth_clouds.jpg   — Solar System Scope (CC BY 4.0), based on NASA imagery
  earth_bump_roughness_clouds_4096.jpg                              — three.js examples (R=bump, G=land mask, B=clouds)

Usage: python3 scripts/build-textures.py <SRC_DIR>
"""
import sys, os
from PIL import Image, ImageOps, ImageFilter

Image.MAX_IMAGE_PIXELS = None
src = sys.argv[1] if len(sys.argv) > 1 else 'scratch/tex'
out = 'public/textures'
os.makedirs(out, exist_ok=True)

def save(im, name, q=82):
    p = os.path.join(out, name)
    im.save(p, 'WEBP', quality=q, method=6)
    print(f'{name:28s} {im.size[0]}x{im.size[1]} {os.path.getsize(p)/1e6:.2f} MB')

day = Image.open(os.path.join(src, '8k_earth_daymap.jpg')).convert('RGB')
save(day, 'earth-day-8k.webp', 80)
save(day.resize((4096, 2048), Image.LANCZOS), 'earth-day-4k.webp', 84)
save(day.resize((1024, 512), Image.LANCZOS), 'earth-day-1k.webp', 80)

night = Image.open(os.path.join(src, '8k_earth_nightmap.jpg')).convert('RGB')
save(night.resize((4096, 2048), Image.LANCZOS), 'earth-night-4k.webp', 84)
save(night.resize((1024, 512), Image.LANCZOS), 'earth-night-1k.webp', 80)

clouds = Image.open(os.path.join(src, '8k_earth_clouds.jpg')).convert('L')
save(clouds.resize((4096, 2048), Image.LANCZOS).convert('RGB'), 'earth-clouds-4k.webp', 80)
save(clouds.resize((1024, 512), Image.LANCZOS).convert('RGB'), 'earth-clouds-1k.webp', 78)

packed = Image.open(os.path.join(src, 'earth_bump_roughness_clouds_4096.jpg')).convert('RGB')
bump, land, _ = packed.split()
ocean = ImageOps.invert(land).filter(ImageFilter.GaussianBlur(1.2))
data = Image.merge('RGB', (bump, ocean, Image.new('L', bump.size, 0)))
save(data, 'earth-data-4k.webp', 88)  # R = elevation/bump, G = ocean mask (1 = water)
save(data.resize((1024, 512), Image.LANCZOS), 'earth-data-1k.webp', 85)
