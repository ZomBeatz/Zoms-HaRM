"""Build the HaRM icon and wordmark SVGs (text outlined from Open Sans, like the Zomello logo)."""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
FONTS = "/usr/share/fonts/TTF/"

THEMES = {
    # name: (server gradient top, bottom, wordmark accent light-bg, accent dark-bg)
    "zombeatz": ("#4fb0ec", "#2580c3", "#2580c3", "#4fb0ec"),
    "coolant": ("#5fe0b9", "#16967a", "#0e9f8c", "#5ff7cf"),
}

# Coolant extra: the headphone cord (like the ZomBeatz mark) ends in an RJ45 network plug.
CORD = '''  <!-- cord from the right ear cup to an RJ45 plug -->
  <path d="M 786 760 C 786 860 700 884 600 884 L 520 884" fill="none" stroke="#0a0c10" stroke-width="30" stroke-linecap="round"/>
  <path d="M 786 760 C 786 860 700 884 600 884 L 520 884" fill="none" stroke="url(#blue)" stroke-width="12" stroke-linecap="round"/>
  <path d="M 470 860 L 516 866 Q 530 868 530 884 Q 530 900 516 902 L 470 908 Z" fill="#0a0c10"/>
  <rect x="356" y="848" width="124" height="72" rx="14" fill="#0a0c10"/>
  <rect x="364" y="856" width="108" height="56" rx="9" fill="#dff7ef" opacity=".92"/>
  <rect x="438" y="872" width="26" height="24" rx="4" fill="#0a0c10" opacity=".22"/>
  <g fill="#e9b949">
    <rect x="372" y="862" width="40" height="5" rx="2.5"/>
    <rect x="372" y="871" width="40" height="5" rx="2.5"/>
    <rect x="372" y="880" width="40" height="5" rx="2.5"/>
    <rect x="372" y="889" width="40" height="5" rx="2.5"/>
    <rect x="372" y="898" width="40" height="5" rx="2.5"/>
  </g>
'''

ICON_BODY = '''  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232833"/>
      <stop offset="1" stop-color="#12151b"/>
    </linearGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{top}"/>
      <stop offset="1" stop-color="{bottom}"/>
    </linearGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="208" fill="url(#bg)"/>
  <!-- headband: orange inner arc over a dark outer arc, like the ZomBeatz mark -->
  <path d="M 214 600 A 298 298 0 0 1 810 600" fill="none" stroke="#0a0c10" stroke-width="64" stroke-linecap="round"/>
  <path d="M 214 600 A 298 298 0 0 1 810 600" fill="none" stroke="#ec6a3f" stroke-width="30" stroke-linecap="round"/>
  <!-- ear cups -->
  <rect x="196" y="500" width="84" height="264" rx="30" fill="#ec6a3f"/>
  <rect x="150" y="522" width="86" height="220" rx="30" fill="#0a0c10"/>
  <rect x="744" y="500" width="84" height="264" rx="30" fill="#ec6a3f"/>
  <rect x="788" y="522" width="86" height="220" rx="30" fill="#0a0c10"/>
  <!-- rack posts -->
  <rect x="318" y="404" width="22" height="378" rx="11" fill="#0a0c10"/>
  <rect x="684" y="404" width="22" height="378" rx="11" fill="#0a0c10"/>
  <!-- three rack-mounted servers -->
  <rect x="330" y="420" width="364" height="98" rx="30" fill="url(#blue)"/>
  <rect x="330" y="543" width="364" height="98" rx="30" fill="url(#blue)" opacity=".85"/>
  <rect x="330" y="666" width="364" height="98" rx="30" fill="url(#blue)" opacity=".7"/>
  <!-- drive bays -->
  <rect x="362" y="458" width="60" height="22" rx="11" fill="#ffffff" opacity=".85"/>
  <rect x="436" y="458" width="60" height="22" rx="11" fill="#ffffff" opacity=".85"/>
  <rect x="362" y="581" width="60" height="22" rx="11" fill="#ffffff" opacity=".85"/>
  <rect x="436" y="581" width="60" height="22" rx="11" fill="#ffffff" opacity=".85"/>
  <rect x="362" y="704" width="60" height="22" rx="11" fill="#ffffff" opacity=".85"/>
  <!-- status lights -->
  <circle cx="646" cy="469" r="14" fill="#ec6a3f"/>
  <circle cx="606" cy="469" r="14" fill="#ffffff" opacity=".85"/>
  <circle cx="646" cy="592" r="14" fill="#ffffff" opacity=".85"/>
  <circle cx="646" cy="715" r="14" fill="#ffffff" opacity=".85"/>
{extra}'''


# Coolant (the hidden easter-egg theme): the servers become glass coolant reservoirs with a
# wavy liquid line and bubbles, the band glows mint-to-cyan, and the cord ends in an RJ45 plug.
def _wave(x0, x1, y, amp=9, step=46):
    d, x, up = f"M {x0} {y}", x0, True
    while x < x1:
        nx = min(x + step, x1)
        d += f" Q {(x + nx) / 2} {y - amp if up else y + amp} {nx} {y}"
        x, up = nx, not up
    return d


def _bubble(cx, cy, r, op, top, animated, dur, delay):
    if not animated:
        return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" opacity="{op}"/>'
    # Rises from the bottom of the reservoir to the waterline, fading out as it surfaces.
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" opacity="0">'
            f'<animate attributeName="cy" values="{cy + 22};{top}" dur="{dur}s" begin="{delay}s" repeatCount="indefinite"/>'
            f'<animate attributeName="opacity" values="0;{op};{op};0" keyTimes="0;.2;.8;1" dur="{dur}s" begin="{delay}s" repeatCount="indefinite"/>'
            f'</circle>')


def coolant_body(animated=False):
    units = []
    for i, (y, level) in enumerate(((420, 452), (543, 571), (666, 702))):
        # The wave is drawn one wavelength (92) wider on each side so it can roll sideways seamlessly.
        x0, x1 = (330 - 92, 694 + 92) if animated else (330, 694)
        roll = (f'<animateTransform attributeName="transform" type="translate" values="0 0;92 0" '
                f'dur="{3.2 + i * 0.7}s" repeatCount="indefinite"/>') if animated else ""
        bubbles = "\n    ".join(_bubble(*b, level + 6, animated, d, dl) for b, d, dl in (
            ((560 + i * 22, y + 70, 7, .55), 2.6, i * 0.5),
            ((604 - i * 18, y + 58, 4.5, .45), 2.1, 0.9 + i * 0.3),
            ((520 + i * 30, y + 82, 3.5, .4), 3.0, 1.6 + i * 0.2)))
        units.append(f"""  <clipPath id="u{i}"><rect x="330" y="{y}" width="364" height="98" rx="30"/></clipPath>
  <rect x="330" y="{y}" width="364" height="98" rx="30" fill="#0f2f2c" stroke="#5ff7cf" stroke-opacity=".55" stroke-width="5"/>
  <g clip-path="url(#u{i})">
    <path d="{_wave(x0, x1, level)} L {x1} {y + 98} L {x0} {y + 98} Z" fill="url(#liquid)">{roll}</path>
    {bubbles}
  </g>""")
    return f"""  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#123532"/>
      <stop offset="1" stop-color="#071413"/>
    </linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5ff7cf"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <linearGradient id="liquid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5ff7cf"/>
      <stop offset="1" stop-color="#0e9f8c"/>
    </linearGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#5ff7cf"/>
    </linearGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="208" fill="url(#bg)"/>
  <!-- headband glowing like coolant tubing -->
  <path d="M 214 600 A 298 298 0 0 1 810 600" fill="none" stroke="#04100e" stroke-width="64" stroke-linecap="round"/>
  <path d="M 214 600 A 298 298 0 0 1 810 600" fill="none" stroke="url(#band)" stroke-width="30" stroke-linecap="round"/>
  <rect x="196" y="500" width="84" height="264" rx="30" fill="#5ff7cf"/>
  <rect x="150" y="522" width="86" height="220" rx="30" fill="#04100e"/>
  <rect x="744" y="500" width="84" height="264" rx="30" fill="#22d3ee"/>
  <rect x="788" y="522" width="86" height="220" rx="30" fill="#04100e"/>
  <!-- rack posts -->
  <rect x="318" y="404" width="22" height="378" rx="11" fill="#04100e"/>
  <rect x="684" y="404" width="22" height="378" rx="11" fill="#04100e"/>
  <!-- three servers, each a coolant reservoir -->
{chr(10).join(units)}
  <!-- drive bays and status lights -->
  <g fill="#ffffff" opacity=".88">
    <rect x="362" y="446" width="60" height="22" rx="11"/><rect x="436" y="446" width="60" height="22" rx="11"/>
    <rect x="362" y="569" width="60" height="22" rx="11"/><rect x="436" y="569" width="60" height="22" rx="11"/>
    <rect x="362" y="692" width="60" height="22" rx="11"/>
  </g>
  <circle cx="646" cy="457" r="14" fill="#22d3ee"/>
  <circle cx="646" cy="457" r="24" fill="#22d3ee" opacity=".25">{'<animate attributeName="r" values="18;32;18" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".45;.05;.45" dur="2.4s" repeatCount="indefinite"/>' if animated else ''}</circle>
  <circle cx="646" cy="580" r="14" fill="#ffffff" opacity=".85"/>
  <circle cx="646" cy="703" r="14" fill="#ffffff" opacity=".85"/>
{CORD}"""


def icon_body(theme):
    if theme == "coolant":
        return coolant_body()
    top, bottom = THEMES[theme][:2]
    return ICON_BODY.format(top=top, bottom=bottom, extra="")


def text_path(text, font_file, size, x, baseline, tracking=0.0):
    f = TTFont(FONTS + font_file)
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    scale = size / f["head"].unitsPerEm
    pen = SVGPathPen(gs)
    cx = x
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, cx, baseline)))
        cx += hmtx[g][0] * scale + tracking * size
    return pen.getCommands(), cx - tracking * size


def logo(theme, dark):
    acc_light, acc_dark = THEMES[theme][2:]
    ink, blue, sub = ("#ffffff", acc_dark, "#9aa3b5") if dark else ("#14171f", acc_light, "#5b6375")
    zom, x1 = text_path("Zom's", "OpenSans-ExtraBold.ttf", 170, 345, 205)
    harm, x2 = text_path("HaRM", "OpenSans-ExtraBold.ttf", 170, x1 + 44, 205)
    tag, x3 = text_path("HARDWARE & RACK MANAGER", "OpenSans-Bold.ttf", 34, 349, 262, tracking=0.16)
    w = round(max(x2, x3) + 35)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} 300" width="{w}" height="300">
  <g transform="scale(0.29297)">
{icon_body(theme)}  </g>
  <path d="{zom}" fill="{ink}"/>
  <path d="{harm}" fill="{blue}"/>
  <path d="{tag}" fill="{sub}"/>
</svg>
'''


# Animated Coolant icon for the app's sidebar (SVG <animate>, which works inside <img> and strict CSP).
open(f"{OUT}/harm-coolant-icon-animated.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n{coolant_body(animated=True)}</svg>\n')

for theme in THEMES:
    pre = "harm" if theme == "zombeatz" else f"harm-{theme}"
    open(f"{OUT}/{pre}-icon.svg", "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n{icon_body(theme)}</svg>\n')
    open(f"{OUT}/{pre}-logo.svg", "w").write(logo(theme, False))
    open(f"{OUT}/{pre}-logo-dark.svg", "w").write(logo(theme, True))
