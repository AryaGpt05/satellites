"""
Build optimised Earth textures into public/textures from source images.

Sources (download into SRC dir first):
  8k_earth_daymap.jpg, 8k_earth_nightmap.jpg, 8k_earth_clouds.jpg   — Solar System Scope (CC BY 4.0), based on NASA imagery
  earth_bump_roughness_clouds_4096.jpg                              — three.js examples (R=bump, G=land mask, B=clouds)

Tiers (see src/globe/textures.ts upgradePlan):
  1k  first frame, every device
  2k  phones' resting tier (day, night, clouds), Lanczos-downsampled from the 4k maps
  4k  desktops; phones get day-4k only once the camera has arrived at a place
  8k  day map only, capable desktops, after the first results

Usage:
  python3 scripts/build-textures.py <SRC_DIR>      full rebuild from the sources
  python3 scripts/build-textures.py --2k-only      (re)build only the 2k tier from the shipped 4k webp files
"""
import sys, os
from PIL import Image, ImageOps, ImageFilter

Image.MAX_IMAGE_PIXELS = None
out = 'public/textures'
os.makedirs(out, exist_ok=True)

# WebP quality per map and tier. The 2k tier uses the same quality as the 4k map it is cut from.
Q = {
    'day': {'8k': 80, '4k': 84, '2k': 84, '1k': 80},
    'night': {'4k': 84, '2k': 84, '1k': 80},
    'clouds': {'4k': 80, '2k': 80, '1k': 78},
    'data': {'4k': 88, '1k': 85},
}


def save(im, name, q=82):
    p = os.path.join(out, name)
    im.save(p, 'WEBP', quality=q, method=6)
    print(f'{name:28s} {im.size[0]}x{im.size[1]} {os.path.getsize(p)/1e6:.2f} MB')


def build_2k(images):
    """images: map name -> 4096x2048 PIL image (RGB). Writes earth-<map>-2k.webp."""
    for name, im in images.items():
        save(im.resize((2048, 1024), Image.LANCZOS), f'earth-{name}-2k.webp', Q[name]['2k'])


if len(sys.argv) > 1 and sys.argv[1] == '--2k-only':
    build_2k({m: Image.open(os.path.join(out, f'earth-{m}-4k.webp')).convert('RGB') for m in ('day', 'night', 'clouds')})
    sys.exit(0)

src = sys.argv[1] if len(sys.argv) > 1 else 'scratch/tex'

day = Image.open(os.path.join(src, '8k_earth_daymap.jpg')).convert('RGB')
day4 = day.resize((4096, 2048), Image.LANCZOS)
save(day, 'earth-day-8k.webp', Q['day']['8k'])
save(day4, 'earth-day-4k.webp', Q['day']['4k'])
save(day.resize((1024, 512), Image.LANCZOS), 'earth-day-1k.webp', Q['day']['1k'])

night = Image.open(os.path.join(src, '8k_earth_nightmap.jpg')).convert('RGB')
night4 = night.resize((4096, 2048), Image.LANCZOS)
save(night4, 'earth-night-4k.webp', Q['night']['4k'])
save(night.resize((1024, 512), Image.LANCZOS), 'earth-night-1k.webp', Q['night']['1k'])

clouds = Image.open(os.path.join(src, '8k_earth_clouds.jpg')).convert('L')
clouds4 = clouds.resize((4096, 2048), Image.LANCZOS).convert('RGB')
save(clouds4, 'earth-clouds-4k.webp', Q['clouds']['4k'])
save(clouds.resize((1024, 512), Image.LANCZOS).convert('RGB'), 'earth-clouds-1k.webp', Q['clouds']['1k'])

# 2k tier from the 4k images (same downsampling path as --2k-only, so both give identical files).
build_2k({'day': day4, 'night': night4, 'clouds': clouds4})

packed = Image.open(os.path.join(src, 'earth_bump_roughness_clouds_4096.jpg')).convert('RGB')
bump, land, _ = packed.split()
ocean = ImageOps.invert(land).filter(ImageFilter.GaussianBlur(1.2))
data = Image.merge('RGB', (bump, ocean, Image.new('L', bump.size, 0)))
save(data, 'earth-data-4k.webp', Q['data']['4k'])  # R = elevation/bump, G = ocean mask (1 = water)
save(data.resize((1024, 512), Image.LANCZOS), 'earth-data-1k.webp', Q['data']['1k'])
