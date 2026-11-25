"""Cap Godot's canvas backing buffer for the Android browser build."""

import argparse
from hashlib import sha256
from pathlib import Path


ENGINE_RATIO = "return GodotDisplayScreen.hidpi?window.devicePixelRatio||1:1"
ANDROID_RATIO = (
    "return GodotDisplayScreen.hidpi?"
    "moneyTrailCanvasScale(window.devicePixelRatio||1):1"
)

DISPLAY_PROFILE = """const moneyTrailCanvasScale = (() => {
  const isAndroid = navigator.userAgentData?.platform === "Android"
    || /Android/i.test(navigator.userAgent);
  if (!isAndroid) return ratio => ratio;

  return ratio => {
    const viewportPixels = Math.max(1, window.innerWidth * window.innerHeight);
    return Math.min(ratio, 1.25, Math.sqrt(650000 / viewportPixels));
  };
})();
"""


def replace_once(content, old, new, filename):
    if new in content:
        return content
    if content.count(old) != 1:
        raise ValueError(f"{filename} did not match the expected Godot web export")
    return content.replace(old, new, 1)


def apply(site):
    version = sha256(DISPLAY_PROFILE.encode()).hexdigest()[:12]
    files = {
        site / "game/index.js": (
            ENGINE_RATIO, ANDROID_RATIO
        ),
        site / "game/index.html": (
            'src="index.js"', f'src="index.js?canvas={version}"'
        ),
        site / "site.js": (
            'game.src = "game/";', f'game.src = "game/?canvas={version}";'
        ),
        site / "index.html": (
            'src="site.js"', f'src="site.js?canvas={version}"'
        ),
    }
    changes = {}
    for path, (old, new) in files.items():
        changes[path] = replace_once(path.read_text(encoding="utf-8"), old, new, path)
    engine = site / "game/index.js"
    if not changes[engine].startswith(DISPLAY_PROFILE):
        changes[engine] = DISPLAY_PROFILE + changes[engine]
    for path, content in changes.items():
        path.write_text(content, encoding="utf-8")
    print(f"Applied Android canvas profile {version}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path, help="Root of the extracted website")
    apply(parser.parse_args().site)
