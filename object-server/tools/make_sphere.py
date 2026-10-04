"""Writes a wireframe sphere (lines only, no surface) as an object file.

    python3 tools/make_sphere.py                                  # objects/sphere.json
    python3 tools/make_sphere.py --rings 7 --meridians 12 --name coarse-sphere --color 1 0.6 0.2

The sphere has radius 1 and is centred on (0, 0, 0); place and size it in scene.json.
Rings of latitude run around it, meridians from pole to pole.
"""

import argparse
import json
import math
from pathlib import Path


def sphere(rings: int, meridians: int) -> tuple[list[float], list[int]]:
    positions: list[float] = []
    indices: list[int] = []

    def vertex(x: float, y: float, z: float) -> int:
        positions.extend(round(v, 4) + 0.0 for v in (x, y, z))  # + 0.0 turns -0.0 into 0.0
        return len(positions) // 3 - 1

    north = vertex(0, 1, 0)
    loops = []
    for i in range(1, rings + 1):
        latitude = math.pi * i / (rings + 1)  # 0 = north pole, pi = south pole
        y, r = math.cos(latitude), math.sin(latitude)
        loops.append([
            vertex(r * math.cos(2 * math.pi * j / meridians), y, r * math.sin(2 * math.pi * j / meridians))
            for j in range(meridians)
        ])
    south = vertex(0, -1, 0)

    for loop in loops:  # each ring: a closed loop of lines
        for j in range(meridians):
            indices += [loop[j], loop[(j + 1) % meridians]]
    for j in range(meridians):  # each meridian: north pole, down through every ring, south pole
        chain = [north] + [loop[j] for loop in loops] + [south]
        for a, b in zip(chain, chain[1:]):
            indices += [a, b]
    return positions, indices


def rows(values: list, per_row: int) -> str:
    """One vertex (or one line) per row, so the file stays readable."""
    return ",\n".join(
        "      " + ", ".join(f"{v:g}" for v in values[i:i + per_row]) for i in range(0, len(values), per_row)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rings", type=int, default=11, help="rings of latitude (default 11)")
    parser.add_argument("--meridians", type=int, default=24, help="meridians (default 24)")
    parser.add_argument("--color", type=float, nargs=3, default=[0.55, 0.8, 1.0], metavar=("R", "G", "B"))
    parser.add_argument("--name", default="sphere", help="file name in objects/, without .json")
    args = parser.parse_args()

    positions, indices = sphere(args.rings, args.meridians)
    count = len(positions) // 3
    text = (
        "{\n"
        f'  "description": "A wireframe sphere (radius 1): {args.rings} rings of latitude and '
        f'{args.meridians} meridians, lines only.",\n'
        '  "mesh": {\n'
        '    "primitive": "lines",\n'
        f'    "positions": [\n{rows(positions, 3)}\n    ],\n'
        f'    "colors": [\n{rows(args.color * count, 3)}\n    ],\n'
        f'    "indices": [\n{rows(indices, 2)}\n    ]\n'
        "  },\n"
        '  "transform": {"translation": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]},\n'
        '  "motion": {"type": "static"}\n'
        "}\n"
    )
    json.loads(text)  # make sure it's valid JSON
    path = Path(__file__).resolve().parent.parent / "objects" / f"{args.name}.json"
    path.write_text(text)
    print(f"wrote {path}: {count} vertices, {len(indices) // 2} lines")


if __name__ == "__main__":
    main()
